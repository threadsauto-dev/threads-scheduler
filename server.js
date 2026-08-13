const express = require('express');
const cookieParser = require('cookie-parser');
const { loadEnv } = require('./env');
const threads = require('./threads');
const views = require('./views');

const env = loadEnv();
const app = express();
app.use(cookieParser(env.COOKIE_SECRET));
app.use(express.urlencoded({ extended: false }));

function getSession(req) {
  const raw = req.signedCookies.session;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function requireSession(req, res, next) {
  const session = getSession(req);
  if (!session) return res.redirect('/');
  req.session = session;
  next();
}

app.get('/', (req, res) => {
  if (getSession(req)) return res.redirect('/dashboard');
  res.send(views.landing());
});

app.get('/auth/login', (req, res) => {
  res.redirect(threads.buildAuthorizeUrl(env));
});

app.get('/auth/callback', async (req, res) => {
  const { code, error_description } = req.query;
  if (error_description) return res.status(400).send(views.errorPage(String(error_description)));
  try {
    const { accessToken, threadsUserId, username, expiresIn } = await threads.loginWithCode(env, code);
    res.cookie('session', JSON.stringify({ accessToken, threadsUserId, username }), {
      httpOnly: true,
      signed: true,
      secure: req.protocol === 'https',
      sameSite: 'lax',
      maxAge: expiresIn * 1000,
    });
    res.redirect('/dashboard');
  } catch (e) {
    res.status(500).send(views.errorPage(e.message));
  }
});

app.get('/auth/logout', (req, res) => {
  res.clearCookie('session');
  res.redirect('/');
});

app.get('/dashboard', requireSession, (req, res) => {
  res.send(views.dashboard(req.session.username));
});

app.post('/dashboard/publish', requireSession, async (req, res) => {
  const { text, imageUrl, videoUrl, replyText, delayMinutes } = req.body;
  const { accessToken, threadsUserId, username } = req.session;
  const delay = Math.max(0, parseInt(delayMinutes, 10) || 0);
  const params = {
    text,
    imageUrl: imageUrl || null,
    videoUrl: videoUrl || null,
    replyText: replyText || null,
  };

  try {
    if (delay === 0) {
      const { postId, replyId } = await threads.publishPost(threadsUserId, accessToken, params);
      return res.send(views.published(username, postId, replyId));
    }

    // 예약: 먼저 컨테이너를 만들어 미디어 처리를 끝내두고, 실제 발행 호출만 지연시킨다.
    const creationId = await threads.buildMainCreationId(threadsUserId, accessToken, params);
    res.send(views.scheduled(delay));
    setTimeout(async () => {
      try {
        const postId = await threads.publishContainer(threadsUserId, accessToken, creationId);
        if (params.replyText) {
          await threads.publishReply(threadsUserId, accessToken, postId, params.replyText);
        }
        console.log(`[예약 발행 완료] @${username} -> ${postId}`);
      } catch (e) {
        console.error(`[예약 발행 실패] @${username}:`, e.message);
      }
    }, delay * 60000);
  } catch (e) {
    res.status(500).send(views.errorPage(e.message));
  }
});

app.get('/privacy', (req, res) => res.send(views.privacy()));
app.get('/terms', (req, res) => res.send(views.terms()));

const port = env.PORT || 5000;
app.listen(port, () => console.log(`threads-scheduler demo listening on :${port}`));
