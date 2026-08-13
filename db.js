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
}

module.exports = { pool, migrate };
