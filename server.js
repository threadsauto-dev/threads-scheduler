const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const { loadEnv } = require('./env');
const threads = require('./threads');
const views = require('./views');
const { pool, migrate } = require('./db');
const publisher = require('./publisher');
const storage = require('./storage');
const slots = require('./slots');

const env = loadEnv();
const app = express();
// Render 등 리버스 프록시 뒤에서 돈다 — 이게 없으면 req.ip가 프록시 IP로 고정돼 로그인
// 시도 제한이 사실상 전체 방문자를 하나로 묶어버리고, req.protocol도 부정확해져서
// 아래 관리자 쿠키의 secure 플래그가 실제로는 https인데도 꺼질 수 있다.
app.set('trust proxy', 1);
app.use(cookieParser(env.COOKIE_SECRET));
app.use(express.urlencoded({ extended: false }));

// 비밀번호 하나로 이 인스턴스에 연결된 모든 채널 + 쿠팡 수익 콘텐츠 전체가 열리므로,
// 무차별 대입을 막기 위해 IP별로 실패 횟수를 센다. 인스턴스 하나짜리 소규모 앱이라
// 메모리 저장으로 충분 — 여러 인스턴스로 스케일하게 되면 공유 저장소로 옮겨야 한다.
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
const loginAttempts = new Map(); // ip -> { count, firstAttemptAt, lockedUntil }

function checkLoginLockout(ip) {
  const entry = loginAttempts.get(ip);
  if (entry && entry.lockedUntil && entry.lockedUntil > Date.now()) {
    return entry.lockedUntil - Date.now();
  }
  return 0;
}

function recordFailedLogin(ip) {
  const now = Date.now();
  let entry = loginAttempts.get(ip);
  // 이전 실패가 락아웃 기간의 2배보다 오래됐으면 다시 새로 센다 — Map이 무한정 안 쌓이게.
  if (!entry || now - entry.firstAttemptAt > LOGIN_LOCKOUT_MS * 2) {
    entry = { count: 0, firstAttemptAt: now, lockedUntil: 0 };
  }
  entry.count += 1;
  if (entry.count >= LOGIN_MAX_ATTEMPTS) entry.lockedUntil = now + LOGIN_LOCKOUT_MS;
  loginAttempts.set(ip, entry);
}

// 길이가 다른 문자열을 그냥 ===로 비교하면 몇 번째 글자에서 다른지에 따라 비교가
// 끝나는 시점이 미묘하게 달라져(타이밍 공격) 이론적으로 정답을 한 글자씩 유추당할 수
// 있다. 두 값을 고정 길이 해시로 바꿔서 비교하면 이 시간차가 사라진다.
function safeCompare(a, b) {
  const hashA = crypto.createHash('sha256').update(String(a)).digest();
  const hashB = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

// Threads는 영상을 1GB(권장 500MB 이하)까지 허용하는데 기존 30MB는 실제 영상엔 너무
// 빡빡했다. 다만 multer가 파일을 서버 메모리에 통째로 올렸다가 R2로 보내는 방식이라
// (memoryStorage), 1GB 근처까지 올리면 여러 개를 한꺼번에 첨부할 때 메모리 부족으로
// 서버가 죽을 수 있다 — Threads 한도와 이 서버의 메모리 여유 사이에서 절충한 값.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

// datetime-local 입력값("YYYY-MM-DDTHH:mm")은 시간대 정보가 없다 — 이 앱은 한국 사용자 전용이므로 KST(+09:00)로 해석한다.
function parseKstDatetimeLocal(value) {
  return new Date(`${value}:00+09:00`);
}

function requireAdmin(req, res, next) {
  if (req.signedCookies.admin === '1') return next();
  res.redirect('/login');
}

// 확장 프로그램처럼 쿠키 세션이 없는 프로그램 호출용 인증 — 대시보드 로그인과 같은
// ADMIN_PASSWORD를 헤더로 보내게 한다(별도 API 키를 새로 발급/관리할 필요 없게).
// /login과 같은 비밀번호를 쓰므로, 무차별 대입 방지도 같은 걸 그대로 적용한다.
function requireAdminApi(req, res, next) {
  const remainingLockMs = checkLoginLockout(req.ip);
  if (remainingLockMs > 0) {
    return res.status(429).json({ error: `시도가 너무 많습니다. ${Math.ceil(remainingLockMs / 60000)}분 후 다시 시도해주세요.` });
  }
  const password = req.get('X-Admin-Password') || '';
  if (password && safeCompare(password, env.ADMIN_PASSWORD)) {
    loginAttempts.delete(req.ip);
    return next();
  }
  recordFailedLogin(req.ip);
  res.status(401).json({ error: '인증 실패 — X-Admin-Password 헤더를 확인해주세요.' });
}

app.get('/', (req, res) => res.send(views.landing()));

app.get('/login', (req, res) => res.send(views.adminLogin()));

app.post('/login', (req, res) => {
  const remainingLockMs = checkLoginLockout(req.ip);
  if (remainingLockMs > 0) {
    const minutes = Math.ceil(remainingLockMs / 60000);
    return res.status(429).send(views.adminLogin(`로그인 시도가 너무 많습니다. ${minutes}분 후 다시 시도해주세요.`));
  }

  if (safeCompare(req.body.password || '', env.ADMIN_PASSWORD)) {
    loginAttempts.delete(req.ip);
    res.cookie('admin', '1', {
      httpOnly: true,
      signed: true,
      secure: req.protocol === 'https',
      sameSite: 'lax',
      maxAge: 30 * 24 * 3600 * 1000,
    });
    return res.redirect('/channels');
  }
  recordFailedLogin(req.ip);
  res.status(401).send(views.adminLogin('비밀번호가 틀렸습니다.'));
});

app.get('/logout', (req, res) => {
  res.clearCookie('admin');
  res.redirect('/');
});

app.get('/channels', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM channels ORDER BY created_at DESC');
  const { rows: targetRows } = await pool.query(
    'SELECT * FROM channel_daily_targets WHERE channel_id = ANY($1)',
    [rows.map((c) => c.id)]
  );
  const targetsByChannel = new Map(targetRows.map((t) => [t.channel_id, t]));
  const summaries = await Promise.all(
    rows.map((c) => (c.disconnected_at ? null : slots.getTodaySlotSummary(pool, c.id)))
  );
  const channelsWithTargets = rows.map((c, i) => ({
    ...c,
    target: targetsByChannel.get(c.id) || { ad_count: 0, info_count: 0 },
    todaySummary: summaries[i],
  }));
  res.send(views.channelsList(channelsWithTargets));
});

app.get('/channels/connect', requireAdmin, (req, res) => {
  res.redirect(threads.buildAuthorizeUrl(env));
});

// 채널마다 "하루 목표 개수"만 설정한다 — 실제 시각은 slots.js가 매번 그날그날 무작위로 정한다.
app.post('/channels/:id/targets', requireAdmin, async (req, res) => {
  const adCount = Math.max(0, parseInt(req.body.adCount, 10) || 0);
  const infoCount = Math.max(0, parseInt(req.body.infoCount, 10) || 0);
  await pool.query(
    `INSERT INTO channel_daily_targets (channel_id, ad_count, info_count) VALUES ($1, $2, $3)
     ON CONFLICT (channel_id) DO UPDATE SET ad_count = $2, info_count = $3`,
    [req.params.id, adCount, infoCount]
  );
  res.redirect('/channels');
});

// 글쓰기 화면에서 "다음 빈 슬롯 채우기"가 부르는 조회 전용 엔드포인트.
app.get('/channels/:id/next-slot', requireAdmin, async (req, res) => {
  const tag = req.query.tag;
  if (!['정보성', '광고용'].includes(tag)) return res.status(400).json({ error: '태그가 올바르지 않습니다.' });
  const next = await slots.getNextAvailableSlot(pool, req.params.id, tag);
  if (!next) return res.status(404).json({ error: '이 채널에 등록된 빈 슬롯을 찾지 못했습니다. 설정을 확인해주세요.' });
  res.json(next);
});

// 확장 프로그램이 준비한 게시물 하나를 넘기면, 연결된 모든 채널을 통틀어 가장 먼저 비는
// 슬롯(그 태그 기준)에 자동 배정해서 예약한다 — 어느 채널로 갈지는 이 서버가 정하고,
// 확장 프로그램은 이 호출을 준비된 개수만큼 순서대로(동시에 X) 반복하기만 하면 된다.
app.post('/api/schedule', requireAdminApi, upload.fields([{ name: 'mediaFiles', maxCount: 20 }]), async (req, res) => {
  const { text, replyText, tag, startDate } = req.body;
  if (!['정보성', '광고용'].includes(tag)) return res.status(400).json({ error: '태그(정보성/광고용)가 올바르지 않습니다.' });
  if (!text || !text.trim()) return res.status(400).json({ error: '본문이 비어있습니다.' });
  if (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    return res.status(400).json({ error: 'startDate 형식이 올바르지 않습니다 (YYYY-MM-DD).' });
  }

  const assignment = await slots.getNextAvailableSlotAnyChannel(pool, tag, startDate || undefined);
  if (!assignment) {
    return res
      .status(409)
      .json({ error: `이 태그(${tag})로 배정할 빈 슬롯이 없습니다 — 채널 슬롯 설정 또는 오늘 준비 개수를 확인해주세요.` });
  }

  const { rows: channelRows } = await pool.query('SELECT * FROM channels WHERE id = $1', [assignment.channelId]);
  const channel = channelRows[0];

  const files = req.files?.mediaFiles || [];
  if (files.length > 20) return res.status(400).json({ error: '미디어는 최대 20개까지만 첨부할 수 있습니다.' });
  let media;
  try {
    media = await Promise.all(
      files.map(async (file) => ({
        type: file.mimetype.startsWith('video/') ? 'video' : 'image',
        url: await storage.uploadFile(env, file.buffer, file.mimetype),
      }))
    );
  } catch (e) {
    return res.status(500).json({ error: `미디어 업로드 실패: ${e.message}` });
  }

  const scheduledAt = parseKstDatetimeLocal(`${assignment.dateStr}T${assignment.hour}:${assignment.minute}`);
  const { rows: inserted } = await pool.query(
    `INSERT INTO scheduled_posts (channel_id, text, media, reply_text, scheduled_at, tag)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [channel.id, text, JSON.stringify(media), replyText || null, scheduledAt, tag]
  );

  res.json({
    postId: inserted[0].id,
    channelUsername: channel.username,
    scheduledAt: scheduledAt.toISOString(),
    dateStr: assignment.dateStr,
    hour: assignment.hour,
    minute: assignment.minute,
  });
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
    // reconnect_reason도 같이 지운다 — 재연결은 곧 새 스코프 동의를 다시 받는 것이므로,
    // 예전에 권한 부족으로 남았던 경고는 더 이상 유효하지 않다.
    await pool.query(
      `INSERT INTO channels (threads_user_id, username, access_token, token_expires_at)
       VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval)
       ON CONFLICT (threads_user_id) DO UPDATE
         SET username = $2, access_token = $3, token_expires_at = now() + ($4 || ' seconds')::interval,
             disconnected_at = NULL, reconnect_reason = NULL`,
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
    const { channelId, text, replyText, scheduledDate, scheduledHour, scheduledMinute, editId, tag } = req.body;
    const normalizedTag = ['정보성', '광고용'].includes(tag) ? tag : null;

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
        `UPDATE scheduled_posts SET channel_id = $1, text = $2, media = $3, reply_text = $4, scheduled_at = $5, tag = $6, retry_count = 0
         WHERE id = $7 AND status = 'pending' RETURNING *`,
        [channel.id, text, JSON.stringify(media), replyText || null, scheduledAt, normalizedTag, editId]
      );
      post = updated[0];
      if (!post) {
        return res
          .status(400)
          .send(views.errorPage('이미 처리되어 수정할 수 없는 예약입니다. 발행 내역에서 확인해주세요.'));
      }
    } else {
      const { rows: inserted } = await pool.query(
        `INSERT INTO scheduled_posts (channel_id, text, media, reply_text, scheduled_at, tag)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [channel.id, text, JSON.stringify(media), replyText || null, scheduledAt, normalizedTag]
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
  // 채널 필터: ?channel=<id>가 있으면 그 채널 것만 본다 — 녹화/시연처럼 특정 채널
  // 하나만 짚어서 보여줘야 할 때, 4개 채널이 뒤섞인 목록에서 매번 찾을 필요 없게.
  const channelFilter = /^\d+$/.test(req.query.channel || '') ? Number(req.query.channel) : null;
  const { rows } = await pool.query(
    `SELECT sp.*, c.username FROM scheduled_posts sp
     JOIN channels c ON c.id = sp.channel_id
     WHERE $1::int IS NULL OR sp.channel_id = $1
     ORDER BY sp.scheduled_at DESC LIMIT 100`,
    [channelFilter]
  );
  const { rows: heartbeatRows } = await pool.query(
    'SELECT last_run_at, last_error FROM worker_heartbeats WHERE id = 1'
  );
  const { rows: channelRows } = await pool.query(
    `SELECT id, username FROM channels WHERE disconnected_at IS NULL ORDER BY created_at`
  );
  res.send(views.postsHistory(rows, heartbeatRows[0], channelRows, channelFilter));
});

app.get('/report', requireAdmin, async (req, res) => {
  // ?date=2026-08-16 처럼 과거(혹은 미래) 날짜를 골라볼 수 있게 — 없거나 형식이 이상하면
  // 오늘(KST)로 대체한다. "오늘"도 JS Date로 계산하면 로컬 타임존이 끼어들 수 있어(직접
  // 겪은 문제) 전부 Postgres 쪽에서 문자열로 계산해 받는다.
  const dateParam = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
  const {
    rows: [{ resolved_date: reportDate, prev_date: prevDate, next_date: nextDate }],
  } = await pool.query(
    `SELECT
      COALESCE($1::date, (now() AT TIME ZONE 'Asia/Seoul')::date)::text AS resolved_date,
      (COALESCE($1::date, (now() AT TIME ZONE 'Asia/Seoul')::date) - 1)::text AS prev_date,
      (COALESCE($1::date, (now() AT TIME ZONE 'Asia/Seoul')::date) + 1)::text AS next_date`,
    [dateParam]
  );

  // 시간(KST) × 상태별로 묶어서 가져온 뒤 채널별로 합산한다 — 하루 24시간 × 채널 몇 개 ×
  // 상태 몇 가지라 행 수가 적어서 집계는 JS에서 하는 게 SQL보다 이해하기 쉽다.
  const { rows } = await pool.query(
    `
    SELECT c.id AS channel_id, c.username,
      EXTRACT(HOUR FROM (sp.scheduled_at AT TIME ZONE 'Asia/Seoul'))::int AS hour,
      sp.status,
      count(*)::int AS cnt,
      COALESCE(sum(sp.views), 0)::int AS views_sum,
      count(*) FILTER (WHERE sp.views IS NOT NULL)::int AS views_confirmed_cnt
    FROM scheduled_posts sp
    JOIN channels c ON c.id = sp.channel_id
    WHERE (sp.scheduled_at AT TIME ZONE 'Asia/Seoul')::date = $1::date
      AND c.disconnected_at IS NULL
    GROUP BY c.id, c.username, hour, sp.status
    ORDER BY c.id, hour
  `,
    [reportDate]
  );

  const channelsById = new Map();
  for (const row of rows) {
    let ch = channelsById.get(row.channel_id);
    if (!ch) {
      ch = {
        username: row.username,
        publishedCount: 0,
        pendingCount: 0,
        totalViews: 0,
        viewsConfirmed: 0,
        hours: Array.from({ length: 24 }, () => ({ count: 0, hasPending: false, hasPublished: false, hasFailed: false })),
      };
      channelsById.set(row.channel_id, ch);
    }
    const hourCell = ch.hours[row.hour];
    hourCell.count += row.cnt;
    if (row.status === 'pending' || row.status === 'processing') {
      hourCell.hasPending = true;
      ch.pendingCount += row.cnt;
    } else if (row.status === 'published') {
      hourCell.hasPublished = true;
      ch.publishedCount += row.cnt;
      ch.totalViews += row.views_sum;
      ch.viewsConfirmed += row.views_confirmed_cnt;
    } else {
      hourCell.hasFailed = true;
    }
  }
  // 연결된 채널이지만 오늘 게시물이 하나도 없는 곳도 빈 카드로 보여준다.
  const { rows: allChannels } = await pool.query(
    'SELECT id, username FROM channels WHERE disconnected_at IS NULL ORDER BY created_at'
  );

  // 카드에 "완료+예정"뿐 아니라 그 채널의 하루 목표(광고성/정보성)도 같이 보여줘서,
  // "예정 개수만 보고 목표에 못 미친다"고 오해하는 일을 줄인다.
  const { rows: targetRows } = await pool.query(
    'SELECT channel_id, ad_count, info_count FROM channel_daily_targets WHERE channel_id = ANY($1)',
    [allChannels.map((c) => c.id)]
  );
  const targetsByChannel = new Map(targetRows.map((t) => [t.channel_id, t]));

  // 최근 10일(어제까지, 오늘 제외) 채널별 일별 조회수 추이. 오늘은 아직 48시간 갱신
  // 창 안이라 계속 오르는 중이라 그래프에 넣으면 매번 끝이 뚝 떨어진 것처럼 보여서 뺀다.
  // generate_series로 날짜를 먼저 다 만들어두고 LEFT JOIN해서, 글이 없던 날도 0으로
  // 채워진 채 10개가 항상 나오게 한다(SQL에서 빈 날짜를 채우는 게 JS 날짜 계산보다
  // 타임존 실수 여지가 적다). scheduled_at(예약 시각)이 아니라 terminal_at(실제 발행
  // 확정 시각) 기준으로 묶는다 — 재시도로 밀린 글이 엉뚱한 날짜에 잡히지 않게.
  const TREND_DAYS = 10;
  const { rows: trendRows } = await pool.query(
    `
    WITH days AS (
      SELECT generate_series(
        (now() AT TIME ZONE 'Asia/Seoul')::date - $1::int,
        (now() AT TIME ZONE 'Asia/Seoul')::date - 1,
        interval '1 day'
      )::date AS day
    ),
    daily AS (
      SELECT sp.channel_id,
        (sp.terminal_at AT TIME ZONE 'Asia/Seoul')::date AS day,
        COALESCE(sum(sp.views), 0)::int AS views_sum
      FROM scheduled_posts sp
      WHERE sp.status = 'published'
      GROUP BY sp.channel_id, day
    )
    SELECT c.id AS channel_id, days.day::text AS day, COALESCE(daily.views_sum, 0)::int AS views_sum
    FROM channels c
    CROSS JOIN days
    LEFT JOIN daily ON daily.channel_id = c.id AND daily.day = days.day
    WHERE c.disconnected_at IS NULL
    ORDER BY c.id, days.day
  `,
    [TREND_DAYS]
  );
  const trendByChannel = new Map();
  for (const row of trendRows) {
    if (!trendByChannel.has(row.channel_id)) trendByChannel.set(row.channel_id, []);
    trendByChannel.get(row.channel_id).push({ date: row.day, views: row.views_sum });
  }

  const channels = allChannels.map((c) => ({
    username: c.username,
    trend: trendByChannel.get(c.id) || [],
    target: targetsByChannel.get(c.id) || { ad_count: 0, info_count: 0 },
    ...(channelsById.get(c.id) || {
      publishedCount: 0,
      pendingCount: 0,
      totalViews: 0,
      viewsConfirmed: 0,
      hours: Array.from({ length: 24 }, () => ({ count: 0, hasPending: false, hasPublished: false, hasFailed: false })),
    }),
  }));

  // 선택된 날짜의 메모 본문 + 달력에 점 찍을 "메모 있는 날짜" 전체 목록. 메모 개수가
  // 이 개인 용도 수준에서는 많지 않을 거라 기간 제한 없이 전부 가져온다.
  const [{ rows: noteRows }, { rows: noteDateRows }] = await Promise.all([
    pool.query('SELECT note FROM report_notes WHERE report_date = $1', [reportDate]),
    pool.query('SELECT report_date::text AS d FROM report_notes ORDER BY report_date'),
  ]);

  res.send(
    views.reportDashboard(channels, {
      reportDate,
      prevDate,
      nextDate,
      note: noteRows[0] ? noteRows[0].note : '',
      noteDates: noteDateRows.map((r) => r.d),
    })
  );
});

app.post('/report/note', requireAdmin, async (req, res) => {
  const dateParam = /^\d{4}-\d{2}-\d{2}$/.test(req.body.date || '') ? req.body.date : null;
  if (!dateParam) return res.redirect('/report');
  const note = (req.body.note || '').trim();
  if (note) {
    await pool.query(
      `INSERT INTO report_notes (report_date, note, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (report_date) DO UPDATE SET note = $2, updated_at = now()`,
      [dateParam, note]
    );
  } else {
    // 빈 값으로 저장하면 "메모 없음" 상태와 구분이 안 되니, 지웠을 땐 행 자체를 삭제해서
    // 달력의 점 표시에서도 바로 빠지게 한다.
    await pool.query('DELETE FROM report_notes WHERE report_date = $1', [dateParam]);
  }
  res.redirect(`/report?date=${dateParam}`);
});

app.get('/privacy', (req, res) => res.send(views.privacy()));
app.get('/terms', (req, res) => res.send(views.terms()));

// Meta가 사용자가 Threads 계정 설정에서 이 앱의 권한을 해제했을 때 호출하는 콜백.
// (우리 자체 "/channels/:id/disconnect"와 성격이 다름 — 이건 상대가 Meta 쪽에서 직접
// 끊은 경우라, 우리 쪽에도 반영해서 access_token으로 계속 호출을 시도하지 않게 한다.)
// user_id가 실제로 우리 channels.threads_user_id와 정확히 같은 값인지는 Meta 문서에서
// 명시적으로 확인하지 못해 100% 확신은 없다 — 실패해도 절대 죽지 않고 로그만 남긴다.
app.post('/auth/deauthorize', async (req, res) => {
  try {
    const payload = threads.parseSignedRequest(env, req.body.signed_request);
    const { rowCount } = await pool.query(
      `UPDATE channels SET access_token = '', token_expires_at = now(), disconnected_at = now()
       WHERE threads_user_id = $1 AND disconnected_at IS NULL`,
      [payload.user_id]
    );
    await pool.query(
      `UPDATE scheduled_posts SET status = 'canceled', terminal_at = now()
       WHERE status = 'pending' AND channel_id IN (SELECT id FROM channels WHERE threads_user_id = $1)`,
      [payload.user_id]
    );
    console.log(`[Meta 연결 해제 알림] user_id=${payload.user_id} 매칭된 채널 ${rowCount}개`);
  } catch (e) {
    console.error('[Meta 연결 해제 알림] 처리 실패:', e.message);
  }
  res.sendStatus(200);
});

// Meta의 데이터 삭제 요청 콜백 — 단순 연결 해제와 달리 "이 사람에 대해 저장한 모든 것을
// 지워달라"는 요청이므로, 토큰만 비우는 게 아니라 채널 행 자체를 지운다
// (ON DELETE CASCADE로 그 채널의 예약/발행 내역도 함께 삭제됨).
app.post('/auth/delete', async (req, res) => {
  let matchedUserId = null;
  try {
    const payload = threads.parseSignedRequest(env, req.body.signed_request);
    matchedUserId = payload.user_id;
    const { rowCount } = await pool.query(`DELETE FROM channels WHERE threads_user_id = $1`, [payload.user_id]);
    console.log(`[Meta 데이터 삭제 요청] user_id=${matchedUserId} 채널 ${rowCount}개 삭제`);
  } catch (e) {
    console.error('[Meta 데이터 삭제 요청] 처리 실패:', e.message);
  }
  const confirmationCode = `del_${matchedUserId || 'unknown'}_${Date.now()}`;
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
    return res.status(400).send(views.errorPage('파일 하나의 용량이 너무 큽니다 (최대 100MB).'));
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
