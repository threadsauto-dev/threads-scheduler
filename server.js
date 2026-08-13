const express = require('express');
const cookieParser = require('cookie-parser');
const { loadEnv } = require('./env');
const threads = require('./threads');
const views = require('./views');
const { pool, migrate } = require('./db');
const publisher = require('./publisher');

const env = loadEnv();
const app = express();
app.use(cookieParser(env.COOKIE_SECRET));
app.use(express.urlencoded({ extended: false }));

function requireAdmin(req, res, next) {
  if (req.signedCookies.admin === '1') return next();
  res.redirect('/login');
}

app.get('/', (req, res) => res.send(views.landing()));

app.get('/login', (req, res) => res.send(views.adminLogin()));

app.post('/login', (req, res) => {
  if (req.body.password === env.ADMIN_PASSWORD) {
    res.cookie('admin', '1', {
      httpOnly: true,
      signed: true,
      secure: req.protocol === 'https',
      sameSite: 'lax',
      maxAge: 30 * 24 * 3600 * 1000,
    });
    return res.redirect('/channels');
  }
  res.status(401).send(views.adminLogin('비밀번호가 틀렸습니다.'));
});

app.get('/logout', (req, res) => {
  res.clearCookie('admin');
  res.redirect('/');
});

app.get('/channels', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM channels ORDER BY created_at DESC');
  res.send(views.channelsList(rows));
});

app.get('/channels/connect', requireAdmin, (req, res) => {
  res.redirect(threads.buildAuthorizeUrl(env));
});

// 같은 code로 요청이 중복 도착해도(느린 콜드 스타트 때 브라우저가 재시도하는 경우 등) Meta에 두 번 교환 요청을 보내지 않도록 캐싱.
const codeExchangeCache = new Map(); // code -> Promise<loginResult>

app.get('/auth/callback', async (req, res) => {
  const { code, error_description } = req.query;
  if (error_description) return res.status(400).send(views.errorPage(String(error_description)));
  if (!code) return res.status(400).send(views.errorPage('code가 없습니다.'));
  try {
    let loginPromise = codeExchangeCache.get(code);
    if (!loginPromise) {
      loginPromise = threads.loginWithCode(env, code);
      codeExchangeCache.set(code, loginPromise);
      loginPromise.catch(() => codeExchangeCache.delete(code));
    }
    const { accessToken, threadsUserId, username, expiresIn } = await loginPromise;
    await pool.query(
      `INSERT INTO channels (threads_user_id, username, access_token, token_expires_at)
       VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval)
       ON CONFLICT (threads_user_id) DO UPDATE
         SET username = $2, access_token = $3, token_expires_at = now() + ($4 || ' seconds')::interval`,
      [threadsUserId, username, accessToken, expiresIn]
    );
    res.redirect('/channels');
  } catch (e) {
    res.status(500).send(views.errorPage(e.message));
  }
});

app.get('/compose', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM channels ORDER BY created_at DESC');
  res.send(views.composeForm(rows));
});

app.post('/compose', requireAdmin, async (req, res) => {
  const { channelId, text, imageUrl, videoUrl, replyText, delayMinutes } = req.body;
  const delay = Math.max(0, parseInt(delayMinutes, 10) || 0);

  const { rows: channelRows } = await pool.query('SELECT * FROM channels WHERE id = $1', [channelId]);
  const channel = channelRows[0];
  if (!channel) return res.status(400).send(views.errorPage('채널을 찾을 수 없습니다.'));

  const scheduledAt = new Date(Date.now() + delay * 60000);
  const { rows: inserted } = await pool.query(
    `INSERT INTO scheduled_posts (channel_id, text, image_url, video_url, reply_text, scheduled_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [channel.id, text, imageUrl || null, videoUrl || null, replyText || null, scheduledAt]
  );
  const post = inserted[0];

  const { rows: channels } = await pool.query('SELECT * FROM channels ORDER BY created_at DESC');

  if (delay === 0) {
    try {
      const { postId } = await publisher.publishOne(post, channel);
      return res.send(
        views.composeForm(channels, `게시 완료: https://www.threads.net/@${channel.username}/post/${postId}`)
      );
    } catch (e) {
      return res.status(500).send(views.errorPage(e.message));
    }
  }

  res.send(views.composeForm(channels, `${delay}분 후(${scheduledAt.toLocaleString('ko-KR')}) 예약되었습니다.`));
});

app.get('/posts', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT sp.*, c.username FROM scheduled_posts sp
     JOIN channels c ON c.id = sp.channel_id
     ORDER BY sp.scheduled_at DESC LIMIT 100`
  );
  res.send(views.postsHistory(rows));
});

app.get('/privacy', (req, res) => res.send(views.privacy()));
app.get('/terms', (req, res) => res.send(views.terms()));

// Meta가 사용자의 앱 연결 해제/삭제 요청 시 호출하는 콜백.
app.post('/auth/deauthorize', (req, res) => res.sendStatus(200));

app.post('/auth/delete', (req, res) => {
  const confirmationCode = `del_${Date.now()}`;
  res.json({
    url: `${req.protocol}://${req.get('host')}/auth/delete/status?id=${confirmationCode}`,
    confirmation_code: confirmationCode,
  });
});

app.get('/auth/delete/status', (req, res) => {
  res.send(views.deleteStatus(req.query.id));
});

const port = env.PORT || 5000;
migrate()
  .then(() => app.listen(port, () => console.log(`threads-scheduler listening on :${port}`)))
  .catch((e) => {
    console.error('DB 마이그레이션 실패:', e.message);
    process.exit(1);
  });
