const threads = require('./threads');
const { pool } = require('./db');

const MAX_RETRIES = 3;

// 예전엔 "구조화된 JSON 에러 = Threads가 내용을 명확히 거부한 것 = 재시도 금지"라는
// 화이트리스트 방식이었다. 그런데 code 24(Media Not Found)나 error_message:"UNKNOWN"처럼
// 겉보기엔 "명확한 거부"로 보이지만 실제로는 Threads 쪽 일시적 처리 문제인 경우가 반복
// 발견됐다(2026-08-16/17) — 알게 될 때마다 코드/서브코드 하나씩 예외를 추가하는 방식으론
// 앞으로 아직 못 본 새 에러가 나올 때마다 똑같은 일을 반복하게 된다.
// 그래서 블랙리스트 방식으로 뒤집는다: 이 함수는 발행(threads_publish) 이전 단계
// (컨테이너 준비)에서만 쓰이므로 재시도해도 중복 게시 위험이 전혀 없다 — 채널(계정) 전체가
// 막혀서 재시도해도 절대 성공할 수 없다고 "확실히" 아는 경우(channelLevelErrorReason)만
// 예외로 즉시 실패 처리하고, 그 외에는 원인이 뭐든 일단 재시도해볼 가치가 있다고 본다.
// MAX_RETRIES로 3번(또는 댓글은 COMMENT_BACKOFF_MINUTES로 4번)까지만 도니 진짜 영구적인
// 콘텐츠 거부라도 몇 분 늦게 확정될 뿐, 무한 재시도로 새지 않는다.
function isRetryableError(err) {
  return !channelLevelErrorReason(err);
}

// Meta 에러 code 10 = 권한 부족(스코프 누락), code 190 = 액세스 토큰 무효화(재로그인/비밀번호
// 변경 등으로 토큰이 죽음), code 200 = 계정 자체가 API 접근을 차단당함(제재·보안 checkpoint —
// 2026-08-15에 실제로 겪은 사고, project_threads-meta-account-checkpoint-incident 참고).
// 셋 다 이 게시물 하나만의 문제가 아니라 채널(계정) 전체가 막혔다는 신호라 재시도해도 절대
// 성공하지 않는다 — 어떤 조치가 필요한지(재연결 vs Meta 콘솔에서 계정 상태 확인) 바로 알 수
// 있게 코드별로 원인을 구분해 남긴다. (OAuth 스코프 누락으로 댓글이 조용히 계속 실패했던 사고를
// 겪고 2026-08-14에 code 10 감지를 추가했고, 2026-08-16에 190/200까지 넓혔다.)
function channelLevelErrorReason(err) {
  const msg = err.message || '';
  if (/"code":\s*10\b/.test(msg)) return '권한 부족(스코프 누락) — 채널 재연결 필요';
  if (/"code":\s*190\b/.test(msg)) return '액세스 토큰 무효화 — 채널 재연결 필요';
  if (/"code":\s*200\b/.test(msg)) return 'Meta가 API 접근 차단 — 계정 제재/보안 확인 여부를 Meta에서 직접 확인 필요';
  return null;
}

// /channels 화면에 눈에 띄게 남긴다 — /posts 한 줄에 에러 메시지가 묻혀서 뒤늦게
// 발견되지 않도록, 어떤 채널이 왜 막혔는지 채널 목록 자체에서 바로 보이게 한다.
async function flagChannelForReconnect(channelId, reason) {
  await pool.query(`UPDATE channels SET reconnect_reason = $1 WHERE id = $2`, [reason, channelId]);
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
      // 레시피 글(reply2_text 있음)은 "조리법"도 같이 5분 뒤로 예약해두지만, worker.js가
      // comment2는 comment_status='posted'(재료+링크 댓글이 실제로 달린 뒤)일 때만 집어가게
      // 걸어놔서 두 답글이 항상 순서대로(재료+링크 → 조리법) 달리게 한다.
      await pool.query(
        `UPDATE scheduled_posts SET status = 'published', published_post_id = $1, error_message = NULL,
         terminal_at = now(), comment_status = 'pending', comment_due_at = now() + interval '5 minutes',
         comment_retry_count = 0,
         comment2_status = CASE WHEN reply2_text IS NOT NULL THEN 'pending' ELSE comment2_status END,
         comment2_due_at = CASE WHEN reply2_text IS NOT NULL THEN now() + interval '5 minutes' ELSE comment2_due_at END,
         comment2_retry_count = 0
         WHERE id = $2`,
        [postId, post.id]
      );
    } else {
      await pool.query(
        `UPDATE scheduled_posts SET status = 'published', published_post_id = $1, error_message = NULL, terminal_at = now()
         WHERE id = $2`,
        [postId, post.id]
      );
    }
    return { postId };
  } catch (e) {
    const retryCount = (post.retry_count || 0) + 1;
    const channelReason = channelLevelErrorReason(e);
    if (channelReason) await flagChannelForReconnect(channel.id, `${channelReason}: ${e.message}`);
    // 채널 레벨 문제면 이 글만의 문제가 아니라는 걸 /posts 목록에서도 바로 알 수 있게 접두어를 남긴다.
    const prefix = channelReason ? `[⚠ 채널 문제로 보임 — ${channelReason}] ` : '';

    if (e.isPublishCall) {
      // 본문을 실제로 게시하는 호출 자체가 실패 — 응답을 못 받았어도 요청은 이미
      // 서버에 반영됐을 수 있다. 자동 재시도하면 중복 게시로 이어질 수 있으므로
      // 무조건 즉시 'failed'로 남기고, 사람이 Threads에서 직접 확인하게 한다.
      await pool.query(
        `UPDATE scheduled_posts SET status = 'failed', retry_count = $1, error_message = $2, terminal_at = now() WHERE id = $3`,
        [retryCount, `${prefix}[Threads에서 실제 게시 여부 직접 확인 필요] ${e.message}`, post.id]
      );
    } else {
      // 아직 라이브로 올라가기 전 단계(컨테이너 준비)에서 실패 — 중복 위험이 없어 안전하게 재시도 가능.
      // 재시도할 거면 'pending'으로 되돌려서 다음 크론 사이클(1분 뒤)에 다시 집어가게 한다.
      const willRetry = isRetryableError(e) && retryCount <= MAX_RETRIES;
      await pool.query(
        `UPDATE scheduled_posts SET status = $1, retry_count = $2, error_message = $3,
         terminal_at = CASE WHEN $1 = 'failed' THEN now() ELSE terminal_at END
         WHERE id = $4`,
        [willRetry ? 'pending' : 'failed', retryCount, `${prefix}${e.message}`, post.id]
      );
    }
    throw e;
  }
}

// 댓글은 중복돼도 채널 정지 같은 큰 사고로 이어지지 않으므로(본문과 달리) 본문보다 훨씬
// 끈질기게 재시도한다 — 5분, 15분, 30분, 1시간 간격으로 총 4번. 그래도 계속 애매하게
// 실패하면 더 기다려봐야 소용없을 가능성이 높다고 보고 'needs_review'로 넘겨 사람이 보게 한다.
const COMMENT_BACKOFF_MINUTES = [5, 15, 30, 60];

// scheduled_posts 한 건의 답글 "한 슬롯"을 시도한다. 정보성/광고용 글은 슬롯이 하나뿐(재료+
// 쿠팡링크 자리를 그대로 씀)이고, 레시피 글은 이 함수가 슬롯 1(재료+링크)과 슬롯 2(조리법)
// 두 번 호출된다 — 컬럼 이름만 다를 뿐 재시도/needs_review 로직은 완전히 동일해서 하나로
// 합쳐두고, publishCommentOne/publishComment2One이 각자의 컬럼명을 넘겨 얇게 감싼다.
async function publishReplySlotOne(post, channel, slot) {
  const text = post[slot.textField];
  const media = post[slot.mediaField] || [];
  try {
    // 재시도 전에 먼저 이미 달려 있는지 확인한다 — 직전 시도가 응답만 유실됐을 뿐
    // 실제로는 성공했을 수 있어서, 이 확인 없이 바로 재시도하면 댓글이 중복될 수 있다.
    const already = await threads.hasOwnReply(post.published_post_id, channel.access_token, text);
    if (already) {
      await pool.query(
        `UPDATE scheduled_posts SET ${slot.statusCol} = 'posted', ${slot.errorCol} = NULL WHERE id = $1`,
        [post.id]
      );
      return;
    }

    const replyId = await threads.publishReply(
      channel.threads_user_id,
      channel.access_token,
      post.published_post_id,
      text,
      media
    );
    await pool.query(
      `UPDATE scheduled_posts SET ${slot.statusCol} = 'posted', ${slot.idCol} = $1, ${slot.errorCol} = NULL WHERE id = $2`,
      [replyId, post.id]
    );
  } catch (e) {
    const channelReason = channelLevelErrorReason(e);
    if (channelReason) await flagChannelForReconnect(channel.id, `${channelReason}: ${e.message}`);
    const prefix = channelReason ? `[⚠ 채널 문제로 보임 — ${channelReason}] ` : '';
    const retryCount = (post[slot.retryCountField] || 0) + 1;
    if (isRetryableError(e) && retryCount <= COMMENT_BACKOFF_MINUTES.length) {
      // 원인이 애매한 실패(네트워크 순간 끊김, 전파 지연 등) — 다음 확인 전에 이미
      // 성공해 있을 수도 있으니 위의 hasOwnReply 확인이 다음 시도 때 다시 걸러준다.
      const delayMin = COMMENT_BACKOFF_MINUTES[retryCount - 1];
      await pool.query(
        `UPDATE scheduled_posts SET ${slot.statusCol} = 'pending',
         ${slot.dueAtCol} = now() + ($1 || ' minutes')::interval, ${slot.retryCountCol} = $2, ${slot.errorCol} = $3
         WHERE id = $4`,
        [delayMin, retryCount, `${prefix}${e.message}`, post.id]
      );
    } else {
      // Threads가 내용 자체를 명확히 거부했거나(재시도로 해결 안 됨), 애매한 실패였지만
      // 5분→15분→30분→1시간 재시도를 다 썼는데도 계속 실패한 경우 — 사람이 Threads API
      // 오류 원문을 보고 직접 판단(링크 수정, 수동 댓글 등)해야 한다.
      await pool.query(
        `UPDATE scheduled_posts SET ${slot.statusCol} = 'needs_review', ${slot.retryCountCol} = $1, ${slot.errorCol} = $2 WHERE id = $3`,
        [retryCount, `${prefix}${e.message}`, post.id]
      );
      // 슬롯 1(재료+링크)이 영구 실패하면 슬롯 2(조리법)는 comment_status='posted'를
      // 영영 못 보고 조용히 무한 대기하게 된다 — 같이 needs_review로 넘겨서 묻히지 않게 한다.
      if (slot === COMMENT_SLOT_1 && post.reply2_text && post.comment2_status === 'pending') {
        await pool.query(
          `UPDATE scheduled_posts SET comment2_status = 'needs_review',
           comment2_error_message = '재료+링크 답글이 실패해서 순서상 조리법도 달 수 없었어요' WHERE id = $1`,
          [post.id]
        );
      }
    }
  }
}

const COMMENT_SLOT_1 = {
  textField: 'reply_text',
  mediaField: 'reply_media',
  statusCol: 'comment_status',
  dueAtCol: 'comment_due_at',
  retryCountField: 'comment_retry_count',
  retryCountCol: 'comment_retry_count',
  errorCol: 'comment_error_message',
  idCol: 'comment_id',
};
const COMMENT_SLOT_2 = {
  textField: 'reply2_text',
  mediaField: 'reply2_media',
  statusCol: 'comment2_status',
  dueAtCol: 'comment2_due_at',
  retryCountField: 'comment2_retry_count',
  retryCountCol: 'comment2_retry_count',
  errorCol: 'comment2_error_message',
  idCol: 'comment2_id',
};

// scheduled_posts 한 건의 "댓글"(정보성/광고용은 유일한 댓글, 레시피는 "재료+쿠팡링크")을
// 시도한다. worker.js가 comment_due_at이 지난 건들을 골라 이 함수를 호출한다.
async function publishCommentOne(post, channel) {
  return publishReplySlotOne(post, channel, COMMENT_SLOT_1);
}

// 레시피 글의 "조리법" 답글(재료+링크 다음 순서) — worker.js가 comment2_due_at이 지났고
// comment_status가 이미 'posted'인(=슬롯 1이 먼저 성공한) 건들만 골라 호출한다.
async function publishComment2One(post, channel) {
  return publishReplySlotOne(post, channel, COMMENT_SLOT_2);
}

module.exports = { publishOne, publishCommentOne, publishComment2One, channelLevelErrorReason, flagChannelForReconnect };
