const crypto = require('crypto');

const API = 'https://graph.threads.net/v1.0';

function base64UrlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64');
}

// Meta의 deauthorize/data-deletion 콜백이 보내는 signed_request
// ("<서명>.<base64url JSON payload>")를 검증하고 디코드한다. 서명 확인 없이 payload를
// 믿으면 누구든 아무 user_id나 넣어 요청을 위조해 남의 채널을 지울 수 있으므로 필수.
function parseSignedRequest(env, signedRequest) {
  const [encodedSig, encodedPayload] = String(signedRequest || '').split('.');
  if (!encodedSig || !encodedPayload) throw new Error('signed_request 형식이 올바르지 않습니다.');

  const sig = base64UrlDecode(encodedSig);
  const expectedSig = crypto.createHmac('sha256', env.APP_SECRET).update(encodedPayload).digest();
  if (sig.length !== expectedSig.length || !crypto.timingSafeEqual(sig, expectedSig)) {
    throw new Error('signed_request 서명이 유효하지 않습니다.');
  }

  const payload = JSON.parse(base64UrlDecode(encodedPayload).toString('utf8'));
  if (payload.algorithm !== 'HMAC-SHA256') throw new Error(`지원하지 않는 서명 알고리즘: ${payload.algorithm}`);
  return payload;
}

async function call(path, params, method = 'GET') {
  const url = new URL(`${API}${path}`);
  if (method === 'GET') for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    ...(method === 'POST' ? { body: new URLSearchParams(params) } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // 빈 응답, 게이트웨이 타임아웃 HTML 등 — 요청이 서버에 실제로 반영됐는지 알 수 없는
    // 애매한 상태다. "Unexpected end of JSON input" 같은 정체불명 에러 대신 원인을 남긴다.
    throw new Error(`[${path}] 응답을 해석할 수 없음 (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`[${path}] ${JSON.stringify(json)}`);
  return json;
}

// --- OAuth ---

function buildAuthorizeUrl(env) {
  const url = new URL('https://threads.net/oauth/authorize');
  url.searchParams.set('client_id', env.APP_ID);
  url.searchParams.set('redirect_uri', env.REDIRECT_URI);
  // threads_read_replies: hasOwnReply()가 재시도 전 기존 댓글 목록을 확인하는 데 필요.
  // threads_manage_replies: 댓글(답글) 발행/관리에 필요 — content_publish만으론 부족했다
  // (실제로 star_jakeun 채널에서 "Application does not have permission" 에러로 확인됨).
  // threads_manage_insights: 게시물 조회수(getPostViews)를 가져오는 데 필요.
  url.searchParams.set(
    'scope',
    'threads_basic,threads_content_publish,threads_read_replies,threads_manage_replies,threads_manage_insights'
  );
  url.searchParams.set('response_type', 'code');
  return url.toString();
}

async function exchangeCode(env, code) {
  const body = new URLSearchParams({
    client_id: env.APP_ID,
    client_secret: env.APP_SECRET,
    grant_type: 'authorization_code',
    redirect_uri: env.REDIRECT_URI,
    code,
  });
  const res = await fetch('https://graph.threads.net/oauth/access_token', { method: 'POST', body });
  const json = await res.json();
  if (!res.ok) throw new Error(`[단기 토큰 교환 실패] ${JSON.stringify(json)}`);
  return json; // { access_token, user_id }
}

async function exchangeLongLived(env, shortToken) {
  const url = new URL('https://graph.threads.net/access_token');
  url.searchParams.set('grant_type', 'th_exchange_token');
  url.searchParams.set('client_secret', env.APP_SECRET);
  url.searchParams.set('access_token', shortToken);
  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok) throw new Error(`[장기 토큰 교환 실패] ${JSON.stringify(json)}`);
  return json; // { access_token, token_type, expires_in }
}

async function fetchProfile(accessToken) {
  return call('/me', { fields: 'id,username', access_token: accessToken });
}

// 만료 전에 장기 토큰을 60일 더 연장한다. 발급된 지 24시간 이상 지난, 아직 만료되지 않은 토큰만 갱신 가능.
async function refreshToken(accessToken) {
  const url = new URL('https://graph.threads.net/refresh_access_token');
  url.searchParams.set('grant_type', 'th_refresh_token');
  url.searchParams.set('access_token', accessToken);
  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok) throw new Error(`[토큰 갱신 실패] ${JSON.stringify(json)}`);
  return { accessToken: json.access_token, expiresIn: json.expires_in };
}

async function loginWithCode(env, code) {
  const short = await exchangeCode(env, code);
  const long = await exchangeLongLived(env, short.access_token);
  const profile = await fetchProfile(long.access_token);
  return {
    accessToken: long.access_token,
    expiresIn: long.expires_in,
    threadsUserId: profile.id,
    username: profile.username,
  };
}

// --- Publishing ---

async function waitUntilFinished(creationId, accessToken) {
  for (let i = 0; i < 20; i++) {
    const status = await call(`/${creationId}`, { fields: 'status,error_message', access_token: accessToken });
    if (status.status === 'FINISHED') return;
    if (status.status === 'ERROR') throw new Error(`[미디어 처리 실패] ${JSON.stringify(status)}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error('미디어 처리 대기 시간 초과 (100초)');
}

async function createContainer(userId, accessToken, params) {
  const container = await call(`/${userId}/threads`, { ...params, access_token: accessToken }, 'POST');
  await waitUntilFinished(container.id, accessToken);
  return container.id;
}

// code 24 / subcode 4279009 ("Media Not Found" — "The media with id ... cannot be found.")는
// 방금 status=FINISHED로 확인한 컨테이너를 바로 이어서 publish할 때 Threads 쪽 전파 지연으로
// 가끔 발생하는 것으로 보인다(2026-08-15~16 사이 서로 다른 채널·본문/댓글 양쪽에서 여러 번
// 재현됨). 다른 publish 실패와 달리 이건 "응답 유실로 애매한" 경우가 아니라 Threads가 "이
// 컨테이너를 못 찾았다"고 명확히 답한 것 — 즉 이 시도는 확실히 발행되지 않았다는 뜻이라
// 중복 게시 위험 없이 안전하게 재시도할 수 있다.
function isTransientMediaNotFoundError(err) {
  const msg = err.message || '';
  return /"code":\s*24\b/.test(msg) && /"error_subcode":\s*4279009\b/.test(msg);
}

async function publishContainer(userId, accessToken, creationId) {
  const MAX_ATTEMPTS = 3;
  const RETRY_DELAY_MS = 4000;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const published = await call(
        `/${userId}/threads_publish`,
        { creation_id: creationId, access_token: accessToken },
        'POST'
      );
      return published.id;
    } catch (e) {
      if (isTransientMediaNotFoundError(e) && attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      // 실제로 콘텐츠를 라이브로 올리는 호출이다. 응답을 못 받아도 요청은 이미 Threads
      // 서버에 반영됐을 수 있어, 이 표시가 있으면 호출부는 절대 자동 재시도하면 안 된다.
      e.isPublishCall = true;
      throw e;
    }
  }
}

// media: [{ type: 'image'|'video', url }, ...] — 순서대로 캐러셀에 들어감. 0개면 텍스트만, 1개면 단일 이미지/영상, 2개 이상이면 캐러셀(최대 20개, Threads API 제한).
async function buildMainCreationId(userId, accessToken, { text, media = [] }) {
  if (media.length > 20) throw new Error('한 게시물에는 이미지+영상을 합쳐 최대 20개까지만 넣을 수 있습니다.');

  if (media.length === 0) {
    return createContainer(userId, accessToken, { media_type: 'TEXT', text });
  }

  if (media.length === 1) {
    const item = media[0];
    const urlField = item.type === 'video' ? 'video_url' : 'image_url';
    return createContainer(userId, accessToken, {
      media_type: item.type === 'video' ? 'VIDEO' : 'IMAGE',
      [urlField]: item.url,
      text,
    });
  }

  // 자식 컨테이너를 순차로 만들면(특히 영상이 여러 개일 때) 처리 대기가 누적되어
  // 먼저 만든 항목이 마지막 캐러셀 조립 전에 만료("Invalid Carousel Children")될 수 있다.
  // 병렬로 만들어 전체 대기 시간을 줄인다. Promise.all은 media 순서를 그대로 보존한다.
  const itemIds = await Promise.all(
    media.map((item) => {
      const urlField = item.type === 'video' ? 'video_url' : 'image_url';
      return createContainer(userId, accessToken, {
        media_type: item.type === 'video' ? 'VIDEO' : 'IMAGE',
        [urlField]: item.url,
        is_carousel_item: 'true',
      });
    })
  );
  return createContainer(userId, accessToken, {
    media_type: 'CAROUSEL',
    children: itemIds.join(','),
    text,
  });
}

async function publishReply(userId, accessToken, postId, replyText) {
  const replyContainerId = await createContainer(userId, accessToken, {
    media_type: 'TEXT',
    text: replyText,
    reply_to_id: postId,
  });
  return publishContainer(userId, accessToken, replyContainerId);
}

// 본문만 발행한다. 댓글(쿠팡 링크)은 publisher.js가 별도 스케줄(발행 후 5분 뒤부터)로
// publishReply()를 호출해 처리한다 — 같은 호출 안에서 이어서 시도하지 않는 이유는
// 발행 직후 바로 그 postId를 reply_to_id로 참조하면 Threads 백엔드 전파가 아직 안 끝나
// 원인불명 에러로 실패하는 경우가 있다고 알려져 있어서다(영상이 있으면 더 그런 경향).
async function publishPost(userId, accessToken, { text, media }) {
  const creationId = await buildMainCreationId(userId, accessToken, { text, media });
  return publishContainer(userId, accessToken, creationId);
}

// 해당 게시물에 우리 계정이 단 답글 중 text가 정확히 일치하는 게 이미 있는지 확인한다.
// 댓글 발행 응답이 유실됐을 때(=isPublishCall 에러) 재시도 전에 먼저 이걸로 확인해서,
// 실제로는 이미 달려 있는데 또 하나 더 달아버리는 중복을 막는다.
async function hasOwnReply(postId, accessToken, replyText) {
  const json = await call(`/${postId}/replies`, { fields: 'text,is_reply_owned_by_me', access_token: accessToken });
  return (json.data || []).some((r) => r.is_reply_owned_by_me && r.text === replyText);
}

// 게시물 하나의 누적 조회수. 응답 형태: { data: [{ name: 'views', values: [{ value: N }] }] }
// (Meta 공식 문서로 확인한 형식 — total_value 객체가 아니라 values 배열이다).
async function getPostViews(postId, accessToken) {
  const json = await call(`/${postId}/insights`, { metric: 'views', access_token: accessToken });
  const entry = (json.data || []).find((d) => d.name === 'views');
  const value = entry && entry.values && entry.values[0] && entry.values[0].value;
  return typeof value === 'number' ? value : null;
}

module.exports = {
  buildAuthorizeUrl,
  loginWithCode,
  refreshToken,
  buildMainCreationId,
  publishContainer,
  publishReply,
  publishPost,
  hasOwnReply,
  parseSignedRequest,
  getPostViews,
};
