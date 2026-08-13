// Render Cron Job이 주기적으로(예: 1분마다) 실행하는 스크립트. 발행 시각이 지난 예약 게시물을 찾아 실제로 발행한다.
const { pool, migrate } = require('./db');
const publisher = require('./publisher');

async function run() {
  await migrate();

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
    return;
  }

  for (const post of duePosts) {
    const { rows: channelRows } = await pool.query('SELECT * FROM channels WHERE id = $1', [post.channel_id]);
    const channel = channelRows[0];
    if (!channel) {
      await pool.query(`UPDATE scheduled_posts SET status = 'failed', error_message = '채널을 찾을 수 없음' WHERE id = $1`, [
        post.id,
      ]);
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

run()
  .then(() => pool.end())
  .catch((e) => {
    console.error('worker 실행 실패:', e.message);
    process.exit(1);
  });
