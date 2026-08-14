const { Pool } = require('pg');
const { loadEnv } = require('./env');

const env = loadEnv();
const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
});

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS channels (
      id SERIAL PRIMARY KEY,
      threads_user_id TEXT UNIQUE NOT NULL,
      username TEXT NOT NULL,
      access_token TEXT NOT NULL,
      token_expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scheduled_posts (
      id SERIAL PRIMARY KEY,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      image_url TEXT,
      video_url TEXT,
      reply_text TEXT,
      scheduled_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      published_post_id TEXT,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_scheduled_posts_due ON scheduled_posts (status, scheduled_at);`);
  // 여러 이미지/영상을 순서대로 담기 위한 배열 컬럼. 옛 image_url/video_url 컬럼은 과거 기록 보존용으로 남겨두고 새 글부터는 안 씀.
  await pool.query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS media JSONB NOT NULL DEFAULT '[]'::jsonb;`);
  // 네트워크 순간 끊김처럼 일시적으로 보이는 발행 실패를 몇 번 자동 재시도하기 위한 카운터.
  await pool.query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;`);
  // 댓글(쿠팡 링크)은 본문과 별도로 스케줄된다 — 본문 발행 후 comment_due_at이 지나면
  // worker.js가 집어가 시도하고, 실패하면 comment_retry_count를 늘리며 다음 시도 시각을 뒤로 미룬다.
  // reply_text가 없는 글이나 아직 본문이 발행 전인 글은 comment_status가 NULL이다.
  await pool.query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS comment_status TEXT;`);
  await pool.query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS comment_due_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS comment_retry_count INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS comment_error_message TEXT;`);
  await pool.query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS comment_id TEXT;`);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_scheduled_posts_comment_due ON scheduled_posts (comment_status, comment_due_at);`
  );
  // 연결 해제된 채널 표시. 행 자체는 지우지 않는다 — 지우면(CASCADE) 발행 내역까지 같이
  // 사라지므로, 대신 access_token만 비우고(개인정보처리방침이 약속한 "즉시 폐기") 이후
  // 새 글쓰기/자동 재시도 대상에서만 제외한다.
  await pool.query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS disconnected_at TIMESTAMPTZ;`);
  // terminal_at: status가 published/failed/canceled로 "확정"된 시각 (재시도로 되돌아갈 일이
  // 없어진 시점). scheduled_at은 취소된 미래 예약처럼 확정 시점과 어긋날 수 있어 따로 둔다.
  // R2에 올린 원본 미디어는 Threads가 발행 시점에 이미 가져가 자체 저장하므로, 확정된 지
  // 며칠 지난 뒤엔 안전하게 지울 수 있다 — media_cleaned_at은 그 정리가 끝났는지 표시.
  await pool.query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS terminal_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS media_cleaned_at TIMESTAMPTZ;`);
  // terminal_at이 이 컬럼 추가 이전에 이미 확정된 과거 행에는 채워져 있지 않아 정리 대상에
  // 영영 안 잡힌다 — scheduled_at을 확정 시점의 근사값으로 한 번만 채워준다(이미 채워진
  // 행은 건드리지 않으므로 매 마이그레이션마다 실행해도 안전).
  await pool.query(
    `UPDATE scheduled_posts SET terminal_at = scheduled_at
     WHERE status IN ('published', 'failed', 'canceled') AND terminal_at IS NULL;`
  );
  // 단일 행짜리 상태 테이블 — worker.js가 매 실행(정상이면 1분마다)마다 이 행을 갱신해서,
  // 크론이 조용히 멈췄을 때 화면에서 알 수 있게 한다(그 전까진 아무 표시도 없었음).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS worker_heartbeats (
      id INTEGER PRIMARY KEY,
      last_run_at TIMESTAMPTZ,
      last_error TEXT,
      CHECK (id = 1)
    );
  `);
  await pool.query(`INSERT INTO worker_heartbeats (id) VALUES (1) ON CONFLICT (id) DO NOTHING;`);
  // Threads가 "권한 없음"(code 10 등)으로 거부하면 그 게시물 하나만의 문제가 아니라 그
  // 채널의 토큰에 특정 스코프가 아예 없다는 신호다 — /posts의 게시물 하나에 묻혀서
  // 나중에야 발견되는 일이 없도록, 이 경우엔 채널 자체에 눈에 띄는 경고를 남긴다.
  // (재발 방지: OAuth 스코프 누락 때문에 star_jakeun 채널 댓글이 조용히 계속 실패했던
  // 사고를 겪고 2026-08-14에 추가.)
  await pool.query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS reconnect_reason TEXT;`);
}

module.exports = { pool, migrate };
