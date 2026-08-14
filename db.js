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
}

module.exports = { pool, migrate };
