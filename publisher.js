const threads = require('./threads');
const { pool } = require('./db');

const MAX_RETRIES = 3;

// threads.js의 call()은 Threads가 준 구조화된 에러 JSON을 성공적으로 파싱했을 때만
// "[path] {...}" 형태로 던진다 — 즉 Threads가 내용 자체를 명확히 거부한 경우라 재시도해도
// 똑같이 실패한다. 그 외(JSON 파싱 실패, fetch 자체 실패 등)는 네트워크 순간 끊김 같은
// 일시적 문제일 가능성이 높아 재시도해볼 가치가 있다.
function isRetryableError(err) {
  return !/^\[.+\] \{/.test(err.message || '');
}

// scheduled_posts 한 건을 실제로 발행하고 상태를 갱신한다. server.js(즉시 발행)와 worker.js(예약 발행) 둘 다 이 함수를 공유한다.
async function publishOne(post, channel) {
  try {
    const { postId, replyId } = await threads.publishPost(channel.threads_user_id, channel.access_token, {
      text: post.text,
      media: post.media || [],
      replyText: post.reply_text,
    });
    await pool.query(`UPDATE scheduled_posts SET status = 'published', published_post_id = $1 WHERE id = $2`, [
      postId,
      post.id,
    ]);
    return { postId, replyId };
  } catch (e) {
    const retryCount = (post.retry_count || 0) + 1;
    const willRetry = isRetryableError(e) && retryCount <= MAX_RETRIES;
    // 재시도할 거면 'pending'으로 되돌려서 다음 크론 사이클(1분 뒤)에 다시 집어가게 한다.
    await pool.query(
      `UPDATE scheduled_posts SET status = $1, retry_count = $2, error_message = $3 WHERE id = $4`,
      [willRetry ? 'pending' : 'failed', retryCount, e.message, post.id]
    );
    throw e;
  }
}

module.exports = { publishOne };
