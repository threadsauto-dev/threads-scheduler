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

// scheduled_posts 한 건의 "본문"을 실제로 발행하고 상태를 갱신한다.
// server.js(즉시 발행)와 worker.js(예약 발행) 둘 다 이 함수를 공유한다.
// 댓글(쿠팡 링크)은 여기서 같이 처리하지 않는다 — publishCommentOne()이 별도 스케줄로 처리한다.
async function publishOne(post, channel) {
  try {
    const postId = await threads.publishPost(channel.threads_user_id, channel.access_token, {
      text: post.text,
      media: post.media || [],
    });
    if (post.reply_text) {
      // 댓글이 있는 게시물이면, 본문 발행 성공과 동시에 "5분 뒤부터 댓글 시도"를 예약해둔다.
      await pool.query(
        `UPDATE scheduled_posts SET status = 'published', published_post_id = $1, error_message = NULL,
         comment_status = 'pending', comment_due_at = now() + interval '5 minutes', comment_retry_count = 0
         WHERE id = $2`,
        [postId, post.id]
      );
    } else {
      await pool.query(
        `UPDATE scheduled_posts SET status = 'published', published_post_id = $1, error_message = NULL WHERE id = $2`,
        [postId, post.id]
      );
    }
    return { postId };
  } catch (e) {
    const retryCount = (post.retry_count || 0) + 1;

    if (e.isPublishCall) {
      // 본문을 실제로 게시하는 호출 자체가 실패 — 응답을 못 받았어도 요청은 이미
      // 서버에 반영됐을 수 있다. 자동 재시도하면 중복 게시로 이어질 수 있으므로
      // 무조건 즉시 'failed'로 남기고, 사람이 Threads에서 직접 확인하게 한다.
      await pool.query(
        `UPDATE scheduled_posts SET status = 'failed', retry_count = $1, error_message = $2 WHERE id = $3`,
        [retryCount, `[Threads에서 실제 게시 여부 직접 확인 필요] ${e.message}`, post.id]
      );
    } else {
      // 아직 라이브로 올라가기 전 단계(컨테이너 준비)에서 실패 — 중복 위험이 없어 안전하게 재시도 가능.
      // 재시도할 거면 'pending'으로 되돌려서 다음 크론 사이클(1분 뒤)에 다시 집어가게 한다.
      const willRetry = isRetryableError(e) && retryCount <= MAX_RETRIES;
      await pool.query(
        `UPDATE scheduled_posts SET status = $1, retry_count = $2, error_message = $3 WHERE id = $4`,
        [willRetry ? 'pending' : 'failed', retryCount, e.message, post.id]
      );
    }
    throw e;
  }
}

// 댓글은 중복돼도 채널 정지 같은 큰 사고로 이어지지 않으므로(본문과 달리) 본문보다 훨씬
// 끈질기게 재시도한다 — 5분, 15분, 30분, 1시간 간격으로 총 4번. 그래도 계속 애매하게
// 실패하면 더 기다려봐야 소용없을 가능성이 높다고 보고 'needs_review'로 넘겨 사람이 보게 한다.
const COMMENT_BACKOFF_MINUTES = [5, 15, 30, 60];

// scheduled_posts 한 건의 "댓글"(쿠팡 링크)을 시도한다. worker.js가 comment_due_at이
// 지난 건들을 골라 이 함수를 호출한다.
async function publishCommentOne(post, channel) {
  try {
    // 재시도 전에 먼저 이미 달려 있는지 확인한다 — 직전 시도가 응답만 유실됐을 뿐
    // 실제로는 성공했을 수 있어서, 이 확인 없이 바로 재시도하면 댓글이 중복될 수 있다.
    const already = await threads.hasOwnReply(post.published_post_id, channel.access_token, post.reply_text);
    if (already) {
      await pool.query(
        `UPDATE scheduled_posts SET comment_status = 'posted', comment_error_message = NULL WHERE id = $1`,
        [post.id]
      );
      return;
    }

    const replyId = await threads.publishReply(
      channel.threads_user_id,
      channel.access_token,
      post.published_post_id,
      post.reply_text
    );
    await pool.query(
      `UPDATE scheduled_posts SET comment_status = 'posted', comment_id = $1, comment_error_message = NULL WHERE id = $2`,
      [replyId, post.id]
    );
  } catch (e) {
    const retryCount = (post.comment_retry_count || 0) + 1;
    if (isRetryableError(e) && retryCount <= COMMENT_BACKOFF_MINUTES.length) {
      // 원인이 애매한 실패(네트워크 순간 끊김, 전파 지연 등) — 다음 확인 전에 이미
      // 성공해 있을 수도 있으니 위의 hasOwnReply 확인이 다음 시도 때 다시 걸러준다.
      const delayMin = COMMENT_BACKOFF_MINUTES[retryCount - 1];
      await pool.query(
        `UPDATE scheduled_posts SET comment_status = 'pending',
         comment_due_at = now() + ($1 || ' minutes')::interval, comment_retry_count = $2, comment_error_message = $3
         WHERE id = $4`,
        [delayMin, retryCount, e.message, post.id]
      );
    } else {
      // Threads가 내용 자체를 명확히 거부했거나(재시도로 해결 안 됨), 애매한 실패였지만
      // 5분→15분→30분→1시간 재시도를 다 썼는데도 계속 실패한 경우 — 사람이 Threads API
      // 오류 원문을 보고 직접 판단(링크 수정, 수동 댓글 등)해야 한다.
      await pool.query(
        `UPDATE scheduled_posts SET comment_status = 'needs_review', comment_retry_count = $1, comment_error_message = $2 WHERE id = $3`,
        [retryCount, e.message, post.id]
      );
    }
  }
}

module.exports = { publishOne, publishCommentOne };
