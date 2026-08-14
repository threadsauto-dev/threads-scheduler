const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const { loadEnv } = require('./env');
const threads = require('./threads');
const views = require('./views');
const { pool, migrate } = require('./db');
const publisher = require('./publisher');
const storage = require('./storage');

const env = loadEnv();
const app = express();
app.use(cookieParser(env.COOKIE_SECRET));
app.use(express.urlencoded({ extended: false }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

// datetime-local 입력값("YYYY-MM-DDTHH:mm")은 시간대 정보가 없다 — 이 앱은 한국 사용자 전용이므로 KST(+09:00)로 해석한다.
function parseKstDatetimeLocal(value) {
  return new Date(`${value}:00+09:00`);
}

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

// 연결 해제: 행을 지우면(ON DELETE CASCADE) 발행 내역까지 같이 사라지므로, 대신
// access_token만 비워서(개인정보처리방침이 약속한 "즉시 폐기") 더 이상 이 앱이 그 계정을
// 대신해 게시할 수 없게 만든다. 아직 안 나간 예약은 채널이 없어졌으니 취소 처리한다.
app.post('/channels/:id/disconnect', requireAdmin, async (req, res) => {
  await pool.query(
    `UPDATE channels SET access_token = '', token_expires_at = now(), disconnected_at = now() WHERE id = $1`,
    [req.params.id]
  );
  await pool.query(
    `UPDATE scheduled_posts SET status = 'canceled', terminal_at = now() WHERE channel_id = $1 AND status = 'pending'`,
    [req.params.id]
  );
  res.redirect('/channels');
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
    // 예전에 연결 해제했던 계정을 다시 연결하는 경우도 있으니 disconnected_at을 같이 지운다.
    await pool.query(
      `INSERT INTO channels (threads_user_id, username, access_token, token_expires_at)
       VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval)
       ON CONFLICT (threads_user_id) DO UPDATE
         SET username = $2, access_token = $3, token_expires_at = now() + ($4 || ' seconds')::interval, disconnected_at = NULL`,
      [threadsUserId, username, accessToken, expiresIn]
    );
    res.redirect('/channels');
  } catch (e) {
    res.status(500).send(views.errorPage(e.message));
  }
});

async function getUpcomingPending() {
  const { rows } = await pool.query(
    `SELECT sp.*, c.username FROM scheduled_posts sp
     JOIN channels c ON c.id = sp.channel_id
     WHERE sp.status = 'pending'
     ORDER BY sp.scheduled_at ASC LIMIT 20`
  );
  return rows;
}

function rememberLastChannel(res, req, channelId) {
  res.cookie('lastChannelId', String(channelId), {
    httpOnly: true,
    signed: true,
    secure: req.protocol === 'https',
    sameSite: 'lax',
    maxAge: 90 * 24 * 3600 * 1000,
  });
}

app.get('/compose', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM channels WHERE disconnected_at IS NULL ORDER BY created_at DESC'
  );
  res.send(
    views.composeForm(rows, req.query.msg || null, await getUpcomingPending(), req.signedCookies.lastChannelId)
  );
});

app.get('/compose/:id/edit', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM scheduled_posts WHERE id = $1 AND status = 'pending'`, [
    req.params.id,
  ]);
  const editingPost = rows[0];
  if (!editingPost) {
    return res.status(404).send(views.errorPage('수정할 예약을 찾을 수 없습니다. 이미 발행되었거나 취소되었을 수 있어요.'));
  }
  const { rows: channels } = await pool.query(
    'SELECT * FROM channels WHERE disconnected_at IS NULL ORDER BY created_at DESC'
  );
  res.send(views.composeForm(channels, null, await getUpcomingPending(), editingPost.channel_id, editingPost));
});

app.post(
  '/compose',
  requireAdmin,
  upload.fields([{ name: 'mediaFiles', maxCount: 20 }]),
  async (req, res) => {
    const { channelId, text, replyText, scheduledDate, scheduledHour, scheduledMinute, editId } = req.body;

    const { rows: channelRows } = await pool.query(
      'SELECT * FROM channels WHERE id = $1 AND disconnected_at IS NULL',
      [channelId]
    );
    const channel = channelRows[0];
    if (!channel) return res.status(400).send(views.errorPage('채널을 찾을 수 없거나 연결이 해제된 채널입니다.'));

    const scheduledAt = parseKstDatetimeLocal(`${scheduledDate}T${scheduledHour}:${scheduledMinute}`);
    if (isNaN(scheduledAt.getTime())) return res.status(400).send(views.errorPage('발행 시각이 올바르지 않습니다.'));
    if (scheduledAt.getTime() < Date.now() - 5000) {
      return res.status(400).send(views.errorPage('과거 시각에는 예약할 수 없습니다.'));
    }

    let existingMedia = [];
    if (req.body.existingMedia) {
      try {
        existingMedia = JSON.parse(req.body.existingMedia);
      } catch {
        existingMedia = [];
      }
    }

    const files = req.files?.mediaFiles || [];
    if (existingMedia.length + files.length > 20) {
      return res.status(400).send(views.errorPage('이미지+영상은 합쳐서 최대 20개까지만 첨부할 수 있습니다.'));
    }

    let newMedia;
    try {
      newMedia = await Promise.all(
        files.map(async (file) => ({
          type: file.mimetype.startsWith('video/') ? 'video' : 'image',
          url: await storage.uploadFile(env, file.buffer, file.mimetype),
        }))
      );
    } catch (e) {
      return res.status(500).send(views.errorPage(`미디어 업로드 실패: ${e.message}`));
    }
    const media = [...existingMedia, ...newMedia];

    let post;
    if (editId) {
      // 발행 시각이 지나 크론이 이미 집어간(processing/published) 예약은 수정 못 하게 status='pending'을 같이 확인.
      const { rows: updated } = await pool.query(
        `UPDATE scheduled_posts SET channel_id = $1, text = $2, media = $3, reply_text = $4, scheduled_at = $5, retry_count = 0
         WHERE id = $6 AND status = 'pending' RETURNING *`,
        [channel.id, text, JSON.stringify(media), replyText || null, scheduledAt, editId]
      );
      post = updated[0];
      if (!post) {
        return res
          .status(400)
          .send(views.errorPage('이미 처리되어 수정할 수 없는 예약입니다. 발행 내역에서 확인해주세요.'));
      }
    } else {
      const { rows: inserted } = await pool.query(
        `INSERT INTO scheduled_posts (channel_id, text, media, reply_text, scheduled_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [channel.id, text, JSON.stringify(media), replyText || null, scheduledAt]
      );
      post = inserted[0];
    }

    const isImmediate = scheduledAt.getTime() <= Date.now() + 5000;
    rememberLastChannel(res, req, channel.id);

    // 완료 메시지는 직접 렌더하지 않고 리다이렉트(PRG 패턴)로 넘긴다 — 그냥 렌더하면
    // 느린 응답 중 새로고침/뒤로가기 시 브라우저가 폼을 다시 제출해 같은 예약이
    // 중복으로 생길 수 있다(실제로 이 문제로 같은 예약이 두 번 잡히는 걸 확인함).
    if (isImmediate) {
      try {
        const { postId } = await publisher.publishOne(post, channel);
        return res.redirect(
          `/compose?msg=${encodeURIComponent(`게시 완료: https://www.threads.net/@${channel.username}/post/${postId}`)}`
        );
      } catch (e) {
        return res.status(500).send(views.errorPage(e.message));
      }
    }

    res.redirect(
      `/compose?msg=${encodeURIComponent(`${views.formatKst(scheduledAt)}에 ${editId ? '수정' : ''}예약되었습니다.`)}`
    );
  }
);

app.post('/posts/:id/cancel', requireAdmin, async (req, res) => {
  await pool.query(
    `UPDATE scheduled_posts SET status = 'canceled', terminal_at = now() WHERE id = $1 AND status = 'pending'`,
    [req.params.id]
  );
  res.redirect(req.body.redirectTo === '/posts' ? '/posts' : '/compose');
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

// 라우트 안에서 안 잡힌 예외(멀티터 업로드 용량 초과 등 포함)가 여기로 떨어진다.
// 이게 없으면 Express 기본 에러 페이지가 스택 트레이스를 그대로 보여줄 수 있어서
// 내부 파일 경로 같은 정보가 사용자에게 노출된다.
app.use((err, req, res, next) => {
  console.error('처리되지 않은 요청 오류:', err);
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).send(views.errorPage('파일 하나의 용량이 너무 큽니다 (최대 30MB).'));
  }
  res.status(500).send(views.errorPage('예상치 못한 오류가 발생했습니다. 문제가 계속되면 문의해주세요.'));
});

const port = env.PORT || 5000;
migrate()
  .then(() => app.listen(port, () => console.log(`threads-scheduler listening on :${port}`)))
  .catch((e) => {
    console.error('DB 마이그레이션 실패:', e.message);
    process.exit(1);
  });
