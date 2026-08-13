const API = 'https://graph.threads.net/v1.0';

async function call(path, params, method = 'GET') {
  const url = new URL(`${API}${path}`);
  if (method === 'GET') for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    ...(method === 'POST' ? { body: new URLSearchParams(params) } : {}),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`[${path}] ${JSON.stringify(json)}`);
  return json;
}

// --- OAuth ---

function buildAuthorizeUrl(env) {
  const url = new URL('https://threads.net/oauth/authorize');
  url.searchParams.set('client_id', env.APP_ID);
  url.searchParams.set('redirect_uri', env.REDIRECT_URI);
  url.searchParams.set('scope', 'threads_basic,threads_content_publish');
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

async function publishContainer(userId, accessToken, creationId) {
  const published = await call(
    `/${userId}/threads_publish`,
    { creation_id: creationId, access_token: accessToken },
    'POST'
  );
  return published.id;
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

  const itemIds = [];
  for (const item of media) {
    const urlField = item.type === 'video' ? 'video_url' : 'image_url';
    const itemId = await createContainer(userId, accessToken, {
      media_type: item.type === 'video' ? 'VIDEO' : 'IMAGE',
      [urlField]: item.url,
      is_carousel_item: 'true',
    });
    itemIds.push(itemId);
  }
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

async function publishPost(userId, accessToken, { text, media, replyText }) {
  const creationId = await buildMainCreationId(userId, accessToken, { text, media });
  const postId = await publishContainer(userId, accessToken, creationId);
  const replyId = replyText ? await publishReply(userId, accessToken, postId, replyText) : null;
  return { postId, replyId };
}

module.exports = {
  buildAuthorizeUrl,
  loginWithCode,
  refreshToken,
  buildMainCreationId,
  publishContainer,
  publishReply,
  publishPost,
};
