const threads = require('./threads');
const { pool } = require('./db');

// scheduled_posts 한 건을 실제로 발행하고 상태를 갱신한다. server.js(즉시 발행)와 worker.js(예약 발행) 둘 다 이 함수를 공유한다.
async function publishOne(post, channel) {
  try {
    const { postId, replyId } = await threads.publishPost(channel.threads_user_id, channel.access_token, {
      text: post.text,
      imageUrl: post.image_url,
      videoUrl: post.video_url,
      replyText: post.reply_text,
    });
    await pool.query(`UPDATE scheduled_posts SET status = 'published', published_post_id = $1 WHERE id = $2`, [
      postId,
      post.id,
    ]);
    return { postId, replyId };
  } catch (e) {
    await pool.query(`UPDATE scheduled_posts SET status = 'failed', error_message = $1 WHERE id = $2`, [
      e.message,
      post.id,
    ]);
    throw e;
  }
}

module.exports = { publishOne };
