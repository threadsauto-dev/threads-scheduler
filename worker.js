// Render Cron Job이 주기적으로(예: 1분마다) 실행하는 스크립트. 발행 시각이 지난 예약 게시물을 찾아 실제로 발행하고, 만료 임박 토큰을 갱신한다.
const { pool, migrate } = require('./db');
const publisher = require('./publisher');
const threads = require('./threads');
const storage = require('./storage');
const { loadEnv } = require('./env');

const env = loadEnv();

// R2에 올린 원본 미디어는 Threads가 발행 시점에 이미 가져가 자체 저장하므로, 게시물
// 상태가 확정(terminal_at)된 지 이만큼 지나면 우리 쪽 원본은 지워도 안전하다 — 그동안은
// 사용자가 실패한 글을 고쳐서 재예약하는 등 다시 참조할 여지를 남겨둔다.
const MEDIA_CLEANUP_GRACE_DAYS = 5;

async function cleanupOldMedia() {
  const { rows } = await pool.query(
    `SELECT id, media FROM scheduled_posts
     WHERE media_cleaned_at IS NULL AND media <> '[]'::jsonb
       AND status IN ('published', 'failed', 'canceled')
       AND terminal_at IS NOT NULL AND terminal_at <= now() - ($1 || ' days')::interval
     LIMIT 50`,
    [MEDIA_CLEANUP_GRACE_DAYS]
  );
  if (rows.length === 0) return;

  for (const post of rows) {
    try {
      for (const item of post.media || []) {
        await storage.deleteFile(env, item.url);
      }
      await pool.query(`UPDATE scheduled_posts SET media_cleaned_at = now() WHERE id = $1`, [post.id]);
      console.log(`[미디어 정리 완료] post #${post.id} (${(post.media || []).length}개)`);
    } catch (e) {
      console.error(`[미디어 정리 실패] post #${post.id}: ${e.message}`);
    }
  }
}

// 만료 10일 이내로 남은 채널의 토큰을 미리 갱신 — 사용자가 신경 안 써도 60일마다 자동으로 이어진다.
async function refreshExpiringTokens() {
  const { rows: expiring } = await pool.query(
    `SELECT * FROM channels WHERE disconnected_at IS NULL AND token_expires_at < now() + interval '10 days'`
  );
  for (const channel of expiring) {
    try {
      const { accessToken, expiresIn } = await threads.refreshToken(channel.access_token);
      await pool.query(
        `UPDATE channels SET access_token = $1, token_expires_at = now() + ($2 || ' seconds')::interval WHERE id = $3`,
        [accessToken, expiresIn, channel.id]
      );
      console.log(`[토큰 갱신 완료] @${channel.username}`);
    } catch (e) {
      console.error(`[토큰 갱신 실패] @${channel.username}: ${e.message}`);
    }
  }
}

async function run() {
  await migrate();
  await refreshExpiringTokens();

  // 'pending' 중 발행 시각이 지난 것만 골라 'processing'으로 원자적으로 바꾸면서 가져온다 (동시 실행 대비).
  const { rows: duePosts } = await pool.query(`
    UPDATE scheduled_posts SET status = 'processing'
    WHERE id IN (
      SELECT id FROM scheduled_posts
      WHERE status = 'pending' AND scheduled_at <= now()
      ORDER BY scheduled_at
      LIMIT 20
    )
    RETURNING *
  `);

  if (duePosts.length === 0) {
    console.log('발행할 예약 게시물 없음');
  } else {
    for (const post of duePosts) {
      const { rows: channelRows } = await pool.query('SELECT * FROM channels WHERE id = $1', [post.channel_id]);
      const channel = channelRows[0];
      if (!channel || channel.disconnected_at) {
        await pool.query(
          `UPDATE scheduled_posts SET status = 'failed', error_message = $1, terminal_at = now() WHERE id = $2`,
          [channel ? '채널 연결이 해제됨' : '채널을 찾을 수 없음', post.id]
        );
        continue;
      }
      try {
        const { postId } = await publisher.publishOne(post, channel);
        console.log(`[발행 완료] @${channel.username} post #${post.id} -> ${postId}`);
      } catch (e) {
        console.error(`[발행 실패] @${channel.username} post #${post.id}: ${e.message}`);
      }
    }
  }

  // 댓글(쿠팡 링크)은 본문과 별도 스케줄로 처리한다 — comment_due_at이 지난 것만 골라온다.
  const { rows: dueComments } = await pool.query(`
    UPDATE scheduled_posts SET comment_status = 'processing'
    WHERE id IN (
      SELECT id FROM scheduled_posts
      WHERE comment_status = 'pending' AND comment_due_at <= now()
      ORDER BY comment_due_at
      LIMIT 20
    )
    RETURNING *
  `);

  if (dueComments.length === 0) {
    console.log('처리할 댓글 없음');
  } else {
    for (const post of dueComments) {
      const { rows: channelRows } = await pool.query('SELECT * FROM channels WHERE id = $1', [post.channel_id]);
      const channel = channelRows[0];
      if (!channel || channel.disconnected_at) {
        await pool.query(
          `UPDATE scheduled_posts SET comment_status = 'needs_review', comment_error_message = $1 WHERE id = $2`,
          [channel ? '채널 연결이 해제됨' : '채널을 찾을 수 없음', post.id]
        );
        continue;
      }
      await publisher.publishCommentOne(post, channel);
      console.log(`[댓글 처리] @${channel.username} post #${post.id}`);
    }
  }

  await cleanupOldMedia();
}

// 이 실행이 성공했는지/언제였는지를 남긴다 — 화면(발행 내역)에서 크론이 죽었는지
// 확인할 수 있는 유일한 근거라, run() 자체가 실패한 경우(DB 접속 실패 등만 예외)도 기록한다.
async function recordHeartbeat(error) {
  try {
    await pool.query(`UPDATE worker_heartbeats SET last_run_at = now(), last_error = $1 WHERE id = 1`, [
      error ? error.message : null,
    ]);
  } catch (e) {
    console.error('하트비트 기록 실패:', e.message);
  }
}

(async () => {
  let failed = false;
  try {
    await run();
    await recordHeartbeat(null);
  } catch (e) {
    failed = true;
    console.error('worker 실행 실패:', e.message);
    await recordHeartbeat(e);
  }
  await pool.end();
  if (failed) process.exit(1);
})();
