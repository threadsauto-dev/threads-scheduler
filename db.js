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
}

module.exports = { pool, migrate };
