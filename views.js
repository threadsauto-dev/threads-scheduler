// toLocaleString('ko-KR')만으로는 서버 실행 환경의 시간대(Render는 UTC)를 그대로 쓰고 한국어 표기만 입혀서 실제 KST와 어긋난다 — timeZone을 명시해야 한다.
const formatKst = (date) => new Date(date).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

// /compose의 완료 메시지는 새로고침 시 폼 재제출(중복 예약)을 막으려고 리다이렉트의
// 쿼리스트링(req.query.msg)으로 전달한다 — URL을 통해 온 값이라 그대로 꽂으면 안 되고 escape 필요.
const escapeHtml = (str) =>
  String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 상태값(DB 컬럼 그대로)을 발행 내역 화면에 보여줄 한글 라벨로.
const STATUS_LABELS = {
  pending: '예약',
  processing: 'processing',
  published: '발행',
  failed: 'failed',
  canceled: 'canceled',
};

// 댓글(쿠팡 링크) 상태 — 본문 상태(status)와 별개로 관리된다.
const COMMENT_LABELS = {
  pending: '대기중',
  processing: '처리중',
  posted: '댓글 완료',
  needs_review: '확인 필요',
};

// 예약 수정 폼에 날짜/시/분 select를 KST 기준으로 미리 채우기 위한 분해.
function kstDateInputParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(date));
  const get = (type) => parts.find((p) => p.type === type).value;
  const hour = get('hour') === '24' ? '00' : get('hour'); // 일부 환경의 자정 시간 표기(24) 보정
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour, minute: get('minute') };
}

const layout = (title, body) => `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; line-height: 1.6; }
  a.button { display: inline-block; background: #000; color: #fff; padding: 12px 24px; border-radius: 999px; text-decoration: none; font-weight: 600; }
  textarea, input, select { width: 100%; box-sizing: border-box; padding: 10px; margin: 6px 0 16px; border: 1px solid #ddd; border-radius: 8px; font-size: 15px; }
  label { font-weight: 600; font-size: 14px; color: #555; }
  button { background: #000; color: #fff; padding: 12px 24px; border: none; border-radius: 999px; font-weight: 600; font-size: 15px; cursor: pointer; }
  nav { margin-bottom: 24px; font-size: 14px; }
  nav a { margin-right: 16px; color: #555; text-decoration: none; }
  nav a:hover { text-decoration: underline; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0; }
  th, td { text-align: left; padding: 8px; border-bottom: 1px solid #eee; font-size: 14px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; text-align: center; white-space: nowrap; }
  .badge-pending { background: #fff3cd; color: #92400e; font-weight: 700; }
  .badge-published { background: #d1fae5; color: #047857; font-weight: 700; }
  .badge-failed { background: #f8d7da; }
  .badge-canceled { background: #e2e3e5; color: #555; }
  .badge-comment-pending { background: #fff3cd; }
  .badge-comment-processing { background: #fff3cd; }
  .badge-comment-posted { background: #d4edda; }
  .badge-comment-needs_review { background: #f8d7da; }
  .badge-comment-none { background: #e2e3e5; color: #6b7280; }
  .cancel-btn { background: #fff; color: #c00; border: 1px solid #f1b0b0; padding: 4px 10px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; }
  .report-grid { display: flex; flex-wrap: wrap; gap: 20px; margin: 20px 0; }
  .report-card { flex: 1 1 300px; border: 1px solid #eee; border-radius: 14px; padding: 20px; box-shadow: 0 1px 4px rgba(0,0,0,0.05); }
  .report-card h3 { margin: 0 0 12px; font-size: 15px; }
  .stat-label { font-size: 12px; color: #888; margin-bottom: 2px; }
  .stat-value { font-size: 30px; font-weight: 700; line-height: 1.2; }
  .stat-value.blue { color: #2563eb; }
  .stat-value.green { color: #16a34a; }
  .stat-value.orange { color: #d97706; }
  .stat-sub { font-size: 12px; color: #999; margin-top: 2px; }
  .stat-row { display: flex; gap: 28px; margin-top: 18px; padding-top: 16px; border-top: 1px solid #f0f0f0; }
  .hour-grid { display: grid; grid-template-columns: repeat(12, 1fr); gap: 4px; margin-top: 18px; }
  .hour-cell { text-align: center; border-radius: 6px; padding: 5px 0 4px; background: #f6f6f6; }
  .hour-cell .h { font-size: 9px; color: #aaa; }
  .hour-cell .n { font-weight: 700; font-size: 13px; color: #ccc; }
  .hour-cell.published { background: #e7f7ec; }
  .hour-cell.published .n { color: #16a34a; }
  .hour-cell.pending { background: #fff4e5; }
  .hour-cell.pending .n { color: #d97706; }
  .hour-cell.failed { background: #fde8e8; }
  .hour-cell.failed .n { color: #dc2626; }
  .cal-toggle { padding: 5px 10px; border-radius: 6px; border: 1px solid #ccc; font-size: 13px; font-family: inherit; background: #fff; color: #1a1a1a; cursor: pointer; margin: 0; }
  .cal-popup { display: none; position: absolute; z-index: 10; top: calc(100% + 4px); left: 0; background: #fff; border: 1px solid #ddd; border-radius: 10px; box-shadow: 0 4px 16px rgba(0,0,0,0.1); padding: 12px; width: 240px; }
  .cal-popup.open { display: block; }
  .cal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; font-size: 13px; font-weight: 600; }
  .cal-header button { background: none; border: none; color: #555; font-size: 14px; padding: 2px 6px; cursor: pointer; }
  .cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
  .cal-dow { text-align: center; font-size: 10px; color: #aaa; padding-bottom: 4px; }
  .cal-day { position: relative; text-align: center; font-size: 12px; padding: 6px 0; border-radius: 6px; cursor: pointer; background: none; color: #1a1a1a; border: none; font-family: inherit; }
  .cal-day:hover { background: #f2f2f2; }
  .cal-day.empty { cursor: default; }
  .cal-day.empty:hover { background: none; }
  .cal-day.selected { background: #000; color: #fff; }
  .cal-day .dot { position: absolute; bottom: 2px; left: 50%; transform: translateX(-50%); width: 4px; height: 4px; border-radius: 50%; background: #dc2626; }
  .cal-day.selected .dot { background: #fff; }
  .note-box textarea { min-height: 50px; margin: 6px 0; }
  .note-box .note-actions { display: flex; align-items: center; gap: 10px; }
  .note-box button { padding: 8px 18px; font-size: 13px; }
  .note-saved { font-size: 12px; color: #16a34a; }
  footer { margin-top: 40px; font-size: 13px; color: #888; }
  footer a { color: #888; }
</style>
</head>
<body>
${body}
<footer><a href="/privacy">개인정보처리방침</a> · <a href="/terms">이용약관</a></footer>
</body>
</html>`;

const nav = () => `<nav>
  <a href="/channels">채널</a>
  <a href="/compose">글쓰기</a>
  <a href="/posts">발행 내역</a>
  <a href="/report">리포트</a>
  <a href="/logout">로그아웃</a>
</nav>`;

const landing = () => layout('threads-scheduler', `
  <h1>threads-scheduler</h1>
  <p>여러 Threads 채널을 연결하고, 지금 또는 원하는 시각에 대신 글을 게시합니다.</p>
  <a class="button" href="/login">관리자 로그인</a>
`);

const adminLogin = (error) => layout('관리자 로그인', `
  <h1>관리자 로그인</h1>
  ${error ? `<p style="color:#c00;">${error}</p>` : ''}
  <form method="post" action="/login">
    <label>비밀번호</label>
    <input type="password" name="password" required />
    <button type="submit">로그인</button>
  </form>
`);

// 채널 하나의 "하루 목표 개수" 설정 UI. 실제 발행 시각은 더 이상 여기서 직접 정하지 않고
// slots.js가 매번 그날그날 무작위로(피크시간 회피/우선순위 + 전체 채널 간 최소 간격을
// 지키며) 정한다 — 그래서 여기는 몇 개씩 만들지만 정하면 된다.
const channelTargetBox = (c) => {
  if (c.disconnected_at) return '';
  const summary = c.todaySummary || { 정보성: { total: 0, remaining: 0 }, 광고용: { total: 0, remaining: 0 } };
  const target = c.target || { ad_count: 0, info_count: 0 };
  return `
  <div style="border:1px solid #eee; border-radius:10px; padding:14px 16px; margin:-8px 0 20px;">
    <div style="font-size:13px; color:#888; margin-bottom:10px;">
      오늘 정보성 ${summary.정보성.remaining}/${summary.정보성.total}개 남음 · 광고용 ${summary.광고용.remaining}/${summary.광고용.total}개 남음
    </div>
    <form method="post" action="/channels/${c.id}/targets" style="display:flex; gap:12px; align-items:center; flex-wrap:wrap; margin:0;">
      <label style="font-weight:400; font-size:13px; color:#555; display:flex; align-items:center; gap:6px;">
        하루 광고성
        <input type="number" name="adCount" min="0" value="${target.ad_count}" style="width:60px; margin:0;" />
        개
      </label>
      <label style="font-weight:400; font-size:13px; color:#555; display:flex; align-items:center; gap:6px;">
        하루 정보성
        <input type="number" name="infoCount" min="0" value="${target.info_count}" style="width:60px; margin:0;" />
        개
      </label>
      <button type="submit" style="padding:8px 14px; font-size:13px;">저장</button>
    </form>
    <p style="font-size:12px; color:#999; margin:8px 0 0;">발행 시각은 매일 자동으로 무작위 배정됩니다(정보성은 08-10/12-14/17-22시 회피, 광고성은 그 시간대 우선 · 채널 간 최소 간격 유지). 예정된 시각은 발행 내역에서 확인하세요.</p>
  </div>`;
};

const channelsList = (channels) => layout('채널', `
  ${nav()}
  <h1>연결된 채널</h1>
  <div style="background:#f6f6f6; border-radius:10px; padding:12px 16px; margin:0 0 20px; font-size:13px; color:#555; line-height:1.7;">
    참고로 하루 목표 개수를 너무 높게 잡으면 채널 간 최소 간격 때문에 그날 안에 다 못 들어가고 <b>다음 날로 자동으로 넘어갑니다</b> — 채널당 하루 합계 대략적인 상한(광고성:정보성 = 3:1 비율 기준 직접 측정한 값, 실제 운영 상황에 따라 다를 수 있음):
    <br />1개 채널 운영 시 — 채널당 하루 합계 약 28개(광고성 21 + 정보성 7) 이하
    <br />5개 채널 운영 시 — 채널당 하루 합계 약 14개(광고성 11 + 정보성 3) 이하
    <br />10개 채널 운영 시 — 채널당 하루 합계 약 8개(광고성 6 + 정보성 2) 이하
  </div>
  <table>
    <tr><th>계정</th><th>연결일</th><th>상태</th><th>관리</th></tr>
    ${
      channels
        .map(
          (c) => `<tr>
      <td>@${c.username}</td>
      <td>${formatKst(c.created_at)}</td>
      <td>${
        c.disconnected_at
          ? `<span class="badge badge-canceled">연결 해제됨</span>`
          : `<span class="badge badge-published">연결됨</span>`
      }</td>
      <td>${
        c.disconnected_at
          ? ''
          : `<form method="post" action="/channels/${c.id}/disconnect" style="margin:0;" onsubmit="return confirm('@${c.username} 연결을 해제할까요? 이 계정에 예정된 게시물은 모두 취소됩니다.');">
               <button type="submit" class="cancel-btn">연결 해제</button>
             </form>`
      }</td>
    </tr>
    ${
      c.reconnect_reason
        ? `<tr><td colspan="4" style="font-size:13px; color:#c00; padding-top:0;">⚠ ${escapeHtml(c.reconnect_reason)}</td></tr>`
        : ''
    }
    <tr><td colspan="4" style="padding-top:0;">${channelTargetBox(c)}</td></tr>`
        )
        .join('') || '<tr><td colspan="4">연결된 채널이 없습니다.</td></tr>'
    }
  </table>
  <a class="button" href="/channels/connect">+ 새 채널 연결</a>
`);

const cancelForm = (postId, redirectTo) => `
  <form method="post" action="/posts/${postId}/cancel" style="margin:0; display:inline-block;" onsubmit="return confirm('이 예약을 취소할까요?');">
    <input type="hidden" name="redirectTo" value="${redirectTo}" />
    <button type="submit" class="cancel-btn">취소</button>
  </form>`;

const editLink = (postId) =>
  `<a href="/compose/${postId}/edit" style="margin-right:8px; font-size:13px; color:#06c; font-weight:600;">수정</a>`;

const pendingActions = (post, redirectTo) => `${editLink(post.id)}${cancelForm(post.id, redirectTo)}`;

const upcomingList = (posts) => {
  if (posts.length === 0) return '';
  return `
  <h3 style="margin-top:32px;">다가오는 예약 발행</h3>
  <table>
    <tr><th>채널</th><th>예정 시각</th><th>본문</th><th>관리</th></tr>
    ${posts
      .map(
        (p) => `<tr>
      <td>@${p.username}</td>
      <td>${formatKst(p.scheduled_at)}</td>
      <td>${(p.text || '').slice(0, 30)}</td>
      <td>${pendingActions(p, '/compose')}</td>
    </tr>`
      )
      .join('')}
  </table>`;
};

const composeForm = (channels, message, upcomingPending = [], selectedChannelId, editingPost = null) => layout('글쓰기', `
  ${nav()}
  <h1>글쓰기</h1>
  ${message ? `<p style="background:#f0f9f0;padding:12px;border-radius:8px;">${escapeHtml(message)}</p>` : ''}
  ${
    editingPost
      ? `<p style="background:#eef4ff;padding:12px;border-radius:8px;">예약 #${editingPost.id} 수정 중입니다. <a href="/compose">새 글 작성으로 돌아가기</a></p>`
      : ''
  }
  ${
    channels.length === 0
      ? `<p>먼저 <a href="/channels/connect">채널을 연결</a>해주세요.</p>`
      : `<form method="post" action="/compose" enctype="multipart/form-data">
    ${editingPost ? `<input type="hidden" name="editId" value="${editingPost.id}" />` : ''}
    <label>채널</label>
    <select name="channelId" id="channelSelect" required>
      ${channels
        .map(
          (c) =>
            `<option value="${c.id}" ${String(c.id) === String(selectedChannelId) ? 'selected' : ''}>@${c.username}</option>`
        )
        .join('')}
    </select>
    <label>태그</label>
    <select name="tag" id="tagSelect">
      <option value="">(선택 안 함)</option>
      <option value="정보성" ${editingPost?.tag === '정보성' ? 'selected' : ''}>정보성</option>
      <option value="광고용" ${editingPost?.tag === '광고용' ? 'selected' : ''}>광고용</option>
    </select>
    <label>본문</label>
    <textarea name="text" id="composeText" rows="5" required placeholder="게시할 내용을 입력하세요">${editingPost ? escapeHtml(editingPost.text || '') : ''}</textarea>

    ${
      editingPost && (editingPost.media || []).length > 0
        ? `<label>기존 미디어 (순서 변경/삭제 가능)</label>
    <div id="existingMediaList" style="display:flex; flex-wrap:wrap; gap:10px; margin-bottom:8px;"></div>
    <input type="hidden" name="existingMedia" id="existingMediaField" value="" />`
        : ''
    }

    <label>${editingPost ? '새 이미지/영상 추가 (선택)' : '미디어 (이미지/영상, 최대 20개, 선택)'}</label>
    <div id="mediaDropZone" style="border:2px dashed #ccc; border-radius:8px; padding:20px; text-align:center; margin-bottom:8px; cursor:pointer; color:#777; font-size:14px;">
      클릭해서 파일 선택, 끌어다 놓기, 또는 이미지 붙여넣기(Ctrl+V)
    </div>
    <input type="file" id="mediaFileInput" name="mediaFiles" accept="image/*,video/*" multiple style="display:none" />
    <div id="mediaPreviewList" style="display:flex; flex-wrap:wrap; gap:10px; margin-bottom:16px;"></div>
    ${
      editingPost && (editingPost.media || []).length > 0
        ? `<script>
      (function () {
        var existingMedia = ${JSON.stringify(editingPost.media || []).replace(/</g, '\\u003c')};
        var list = document.getElementById('existingMediaList');
        var field = document.getElementById('existingMediaField');

        function swapExisting(i, j) {
          var tmp = existingMedia[i];
          existingMedia[i] = existingMedia[j];
          existingMedia[j] = tmp;
          renderExisting();
        }

        function renderExisting() {
          list.innerHTML = '';
          field.value = JSON.stringify(existingMedia);
          var total = existingMedia.length;
          existingMedia.forEach(function (item, idx) {
            var box = document.createElement('div');
            box.style.cssText = 'position:relative; width:80px;';
            if (item.type === 'video') {
              var v = document.createElement('div');
              v.style.cssText = 'width:80px; height:80px; background:#f0f0f0; border-radius:6px; display:flex; align-items:center; justify-content:center; font-size:24px;';
              v.textContent = '🎬';
              box.appendChild(v);
            } else {
              var img = document.createElement('img');
              img.src = item.url;
              img.style.cssText = 'width:80px; height:80px; object-fit:cover; border-radius:6px; display:block;';
              box.appendChild(img);
            }
            var badge = document.createElement('span');
            badge.style.cssText = 'position:absolute; top:2px; left:4px; color:#fff; font-size:11px; font-weight:600; text-shadow:0 0 3px #000;';
            badge.textContent = String(idx + 1);
            box.appendChild(badge);
            var controls = document.createElement('div');
            controls.style.cssText = 'display:flex; gap:2px; margin-top:2px;';
            var upBtn = document.createElement('button');
            upBtn.type = 'button';
            upBtn.textContent = '↑';
            upBtn.disabled = idx === 0;
            upBtn.style.cssText = 'flex:1; font-size:11px; padding:2px 0; border:1px solid #ddd; border-radius:4px; background:#fff; color:#333; cursor:pointer; opacity:' + (idx === 0 ? '0.3' : '1') + ';';
            upBtn.onclick = function () { swapExisting(idx, idx - 1); };
            var downBtn = document.createElement('button');
            downBtn.type = 'button';
            downBtn.textContent = '↓';
            downBtn.disabled = idx === total - 1;
            downBtn.style.cssText = 'flex:1; font-size:11px; padding:2px 0; border:1px solid #ddd; border-radius:4px; background:#fff; color:#333; cursor:pointer; opacity:' + (idx === total - 1 ? '0.3' : '1') + ';';
            downBtn.onclick = function () { swapExisting(idx, idx + 1); };
            controls.appendChild(upBtn);
            controls.appendChild(downBtn);
            box.appendChild(controls);
            var removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.textContent = '✕';
            removeBtn.style.cssText = 'position:absolute; top:-6px; right:-6px; width:20px; height:20px; border-radius:50%; border:none; background:#000; color:#fff; cursor:pointer; padding:0; font-size:11px; line-height:1;';
            removeBtn.onclick = function () {
              existingMedia = existingMedia.filter(function (_, i) { return i !== idx; });
              renderExisting();
            };
            box.appendChild(removeBtn);
            list.appendChild(box);
          });
        }

        renderExisting();
      })();
    </script>`
        : ''
    }
    <script>
      (function () {
        var dt = new DataTransfer();
        var zone = document.getElementById('mediaDropZone');
        var input = document.getElementById('mediaFileInput');
        var preview = document.getElementById('mediaPreviewList');

        function replaceFiles(files) {
          var newDt = new DataTransfer();
          files.forEach(function (f) { newDt.items.add(f); });
          dt = newDt;
          input.files = dt.files;
          render();
        }

        function swap(i, j) {
          var files = Array.from(dt.files);
          var tmp = files[i];
          files[i] = files[j];
          files[j] = tmp;
          replaceFiles(files);
        }

        function render() {
          preview.innerHTML = '';
          var total = dt.files.length;
          Array.from(dt.files).forEach(function (file, idx) {
            var item = document.createElement('div');
            item.style.cssText = 'position:relative; width:80px;';
            if (file.type.indexOf('image/') === 0) {
              var img = document.createElement('img');
              img.src = URL.createObjectURL(file);
              img.style.cssText = 'width:80px; height:80px; object-fit:cover; border-radius:6px; display:block;';
              item.appendChild(img);
            } else {
              var box = document.createElement('div');
              box.style.cssText = 'width:80px; height:80px; background:#f0f0f0; border-radius:6px; display:flex; align-items:center; justify-content:center; font-size:24px;';
              box.textContent = '🎬';
              item.appendChild(box);
            }
            var indexBadge = document.createElement('span');
            indexBadge.style.cssText = 'position:absolute; top:2px; left:4px; color:#fff; font-size:11px; font-weight:600; text-shadow:0 0 3px #000;';
            indexBadge.textContent = String(idx + 1);
            item.appendChild(indexBadge);
            var name = document.createElement('div');
            name.style.cssText = 'font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
            name.textContent = file.name;
            item.appendChild(name);
            var controls = document.createElement('div');
            controls.style.cssText = 'display:flex; gap:2px; margin-top:2px;';
            var upBtn = document.createElement('button');
            upBtn.type = 'button';
            upBtn.textContent = '↑';
            upBtn.disabled = idx === 0;
            upBtn.style.cssText = 'flex:1; font-size:11px; padding:2px 0; border:1px solid #ddd; border-radius:4px; background:#fff; color:#333; cursor:pointer; opacity:' + (idx === 0 ? '0.3' : '1') + ';';
            upBtn.onclick = function () { swap(idx, idx - 1); };
            var downBtn = document.createElement('button');
            downBtn.type = 'button';
            downBtn.textContent = '↓';
            downBtn.disabled = idx === total - 1;
            downBtn.style.cssText = 'flex:1; font-size:11px; padding:2px 0; border:1px solid #ddd; border-radius:4px; background:#fff; color:#333; cursor:pointer; opacity:' + (idx === total - 1 ? '0.3' : '1') + ';';
            downBtn.onclick = function () { swap(idx, idx + 1); };
            controls.appendChild(upBtn);
            controls.appendChild(downBtn);
            item.appendChild(controls);
            var removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.textContent = '✕';
            removeBtn.style.cssText = 'position:absolute; top:-6px; right:-6px; width:20px; height:20px; border-radius:50%; border:none; background:#000; color:#fff; cursor:pointer; padding:0; font-size:11px; line-height:1;';
            removeBtn.onclick = function () {
              replaceFiles(Array.from(dt.files).filter(function (f, i) { return i !== idx; }));
            };
            item.appendChild(removeBtn);
            preview.appendChild(item);
          });
        }

        zone.addEventListener('click', function () { input.click(); });

        input.addEventListener('change', function () {
          Array.from(input.files).forEach(function (f) { dt.items.add(f); });
          input.files = dt.files;
          render();
        });

        zone.addEventListener('dragover', function (e) { e.preventDefault(); zone.style.borderColor = '#000'; });
        zone.addEventListener('dragleave', function () { zone.style.borderColor = '#ccc'; });
        zone.addEventListener('drop', function (e) {
          e.preventDefault();
          zone.style.borderColor = '#ccc';
          Array.from(e.dataTransfer.files).forEach(function (f) { dt.items.add(f); });
          input.files = dt.files;
          render();
        });

        document.addEventListener('paste', function (e) {
          var items = e.clipboardData && e.clipboardData.items;
          if (!items) return;
          var added = false;
          Array.from(items).forEach(function (it) {
            if (it.type.indexOf('image/') === 0) {
              var file = it.getAsFile();
              if (file) {
                dt.items.add(new File([file], 'pasted-' + Date.now() + '.png', { type: file.type }));
                added = true;
              }
            }
          });
          if (added) { input.files = dt.files; render(); }
        });
      })();
    </script>

    <label>댓글 (선택)</label>
    <textarea name="replyText" id="composeReplyText" rows="6" placeholder="게시 후 자동으로 달릴 댓글">${editingPost ? escapeHtml(editingPost.reply_text || '') : ''}</textarea>

    <label>발행 날짜</label>
    <input type="date" name="scheduledDate" id="scheduledDate" required ${editingPost ? `value="${kstDateInputParts(editingPost.scheduled_at).date}"` : ''} />

    <label>발행 시각 (24시간제)</label>
    <div style="display:flex; align-items:center; gap:6px; margin-bottom:16px;">
      <select name="scheduledHour" id="scheduledHour" required style="width:auto; margin:0;">
        ${Array.from({ length: 24 }, (_, h) => {
          const v = String(h).padStart(2, '0');
          const sel = editingPost && kstDateInputParts(editingPost.scheduled_at).hour === v ? 'selected' : '';
          return `<option value="${v}" ${sel}>${v}</option>`;
        }).join('')}
      </select>
      시
      <select name="scheduledMinute" id="scheduledMinute" required style="width:auto; margin:0;">
        ${Array.from({ length: 60 }, (_, m) => {
          const v = String(m).padStart(2, '0');
          const sel = editingPost && kstDateInputParts(editingPost.scheduled_at).minute === v ? 'selected' : '';
          return `<option value="${v}" ${sel}>${v}</option>`;
        }).join('')}
      </select>
      분
    </div>
    <button type="button" id="nextSlotBtn" style="background:#fff; color:#000; border:1px solid #ccc; padding:8px 16px; font-size:13px; margin-bottom:16px;">📅 다음 빈 슬롯 채우기</button>
    <span id="nextSlotStatus" style="font-size:13px; color:#888; margin-left:8px;"></span>
    <script>
      (function () {
        var btn = document.getElementById('nextSlotBtn');
        var status = document.getElementById('nextSlotStatus');
        btn.addEventListener('click', function () {
          var channelId = document.getElementById('channelSelect').value;
          var tag = document.getElementById('tagSelect').value;
          if (!tag) {
            status.textContent = '태그(정보성/광고용)를 먼저 골라주세요.';
            return;
          }
          status.textContent = '조회 중...';
          fetch('/channels/' + channelId + '/next-slot?tag=' + encodeURIComponent(tag))
            .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
            .then(function (res) {
              if (!res.ok) {
                status.textContent = res.data.error || '빈 슬롯을 찾지 못했습니다.';
                return;
              }
              document.getElementById('scheduledDate').value = res.data.dateStr;
              document.getElementById('scheduledHour').value = res.data.hour;
              document.getElementById('scheduledMinute').value = res.data.minute;
              status.textContent = res.data.dateStr + ' ' + res.data.hour + ':' + res.data.minute + '(으)로 채웠어요.';
            })
            .catch(function () { status.textContent = '조회 실패 — 네트워크를 확인해주세요.'; });
        });
      })();
    </script>
    ${
      editingPost
        ? ''
        : `<script>
      (function () {
        var now = new Date();
        var dateEl = document.getElementById('scheduledDate');
        var y = now.getFullYear(), m = String(now.getMonth() + 1).padStart(2, '0'), d = String(now.getDate()).padStart(2, '0');
        dateEl.min = y + '-' + m + '-' + d;
        dateEl.value = y + '-' + m + '-' + d;
        document.getElementById('scheduledHour').value = String(now.getHours()).padStart(2, '0');
        document.getElementById('scheduledMinute').value = String(now.getMinutes()).padStart(2, '0');
      })();
    </script>`
    }

    <button type="submit">${editingPost ? '수정 저장' : '게시 / 예약'}</button>
  </form>`
  }
  ${upcomingList(upcomingPending)}
`);

// 워커(Render Cron)가 죽었을 때 화면에서 알 수 있는 유일한 단서 — 정상이면 1분마다
// worker.js가 이 값을 갱신하므로, 너무 오래됐으면 크론이 멈췄다는 뜻이다.
const WORKER_STALE_MINUTES = 5;
const workerStatusBanner = (heartbeat) => {
  if (!heartbeat || !heartbeat.last_run_at) {
    return `<p style="background:#fff3cd;padding:10px 12px;border-radius:8px;font-size:13px;">⚠ 발행 엔진이 아직 한 번도 실행된 기록이 없습니다. 크론 작업 설정을 확인해주세요.</p>`;
  }
  const minutesAgo = Math.max(0, Math.round((Date.now() - new Date(heartbeat.last_run_at).getTime()) / 60000));
  const stale = minutesAgo > WORKER_STALE_MINUTES;
  const timeText = minutesAgo === 0 ? '방금 전' : `${minutesAgo}분 전`;
  return `<p style="background:${stale ? '#f8d7da' : '#eef4ff'};padding:10px 12px;border-radius:8px;font-size:13px;">
    ${stale ? '⚠' : '✓'} 발행 엔진 마지막 실행: ${timeText}${
    stale ? ' — 평소엔 1분마다 실행돼야 하는데 너무 오래됐습니다. 크론 작업이 멈췄을 수 있어요.' : ''
  }${heartbeat.last_error ? `<br/><span style="color:#c00;">최근 오류: ${escapeHtml(heartbeat.last_error)}</span>` : ''}
  </p>`;
};

const formatNumber = (n) => (n === null || n === undefined ? '-' : n.toLocaleString('ko-KR'));

const postsHistory = (posts, heartbeat) => layout('발행 내역', `
  ${nav()}
  <h1>발행 내역</h1>
  ${workerStatusBanner(heartbeat)}
  <table>
    <tr><th>채널</th><th>본문</th><th>예정 시각</th><th>상태</th><th>조회수</th><th>댓글</th><th>관리</th></tr>
    ${
      posts
        .map((p) => {
          const commentCell = !p.reply_text
            ? `<span class="badge badge-comment-none">댓글 없음</span>`
            : `<span class="badge badge-comment-${p.comment_status || 'pending'}" ${
                p.comment_error_message ? `title="${escapeHtml(p.comment_error_message)}"` : ''
              }>${COMMENT_LABELS[p.comment_status] || '-'}</span>`;
          const viewsCell = p.status !== 'published' ? '-' : `<strong>${formatNumber(p.views)}</strong>`;
          return `<tr>
        <td>@${p.username}</td>
        <td>${(p.text || '').slice(0, 30)}</td>
        <td>${formatKst(p.scheduled_at)}</td>
        <td><span class="badge badge-${p.status}" ${p.error_message ? `title="${escapeHtml(p.error_message)}"` : ''}>${STATUS_LABELS[p.status] || p.status}</span></td>
        <td>${viewsCell}</td>
        <td>${commentCell}</td>
        <td>${p.status === 'pending' ? pendingActions(p, '/posts') : ''}</td>
      </tr>
      ${p.error_message ? `<tr><td colspan="7" style="font-size:12px; color:#c00; padding-top:0;">${escapeHtml(p.error_message)}</td></tr>` : ''}`;
        })
        .join('') || '<tr><td colspan="7">기록이 없습니다.</td></tr>'
    }
  </table>
`);

// 그 시간에 예정/발행/실패가 섞여 있으면 "아직 안 나간 게 있다"(예정)를 가장 먼저 보여준다
// — 지나간 시간대라도 실패가 섞였으면 그다음으로, 전부 성공했을 때만 완료로 표시.
function hourCellClass(hour) {
  if (hour.hasPending) return 'pending';
  if (hour.hasFailed) return 'failed';
  if (hour.hasPublished) return 'published';
  return '';
}

// 최근 N일 채널별 조회수를 작은 꺾은선 그래프로 그린다. 축 눈금이나 값 라벨 없이
// 흐름만 보여주는 용도라, 날짜는 첫날/마지막날만 표기해 복잡해지지 않게 한다.
function trendSparkline(trend) {
  if (!trend || trend.length === 0) return '';
  const width = 260;
  const height = 40;
  const padX = 4;
  const max = Math.max(1, ...trend.map((t) => t.views));
  const stepX = trend.length > 1 ? (width - padX * 2) / (trend.length - 1) : 0;
  const points = trend
    .map((t, i) => {
      const x = padX + stepX * i;
      const y = height - 4 - (t.views / max) * (height - 10);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  // date는 'YYYY-MM-DD' 문자열 그대로 받는다 — Date 객체로 파싱하면 pg 드라이버가
  // 서버 로컬 타임존을 끼워 넣어 날짜가 하루 밀려 보이는 문제가 실제로 있었다(직접 확인함).
  const fmtDate = (dateStr) => {
    const [, m, d] = dateStr.split('-');
    return `${Number(m)}/${Number(d)}`;
  };
  return `
    <div class="stat-label" style="margin-top:14px;">최근 ${trend.length}일 조회수 추이</div>
    <svg viewBox="0 0 ${width} ${height + 14}" width="100%" height="${height + 14}" style="display:block;">
      <polyline fill="none" stroke="#2563eb" stroke-width="2" points="${points}" />
      <text x="${padX}" y="${height + 12}" font-size="10" fill="#999">${fmtDate(trend[0].date)}</text>
      <text x="${width - padX}" y="${height + 12}" font-size="10" fill="#999" text-anchor="end">${fmtDate(trend[trend.length - 1].date)}</text>
    </svg>`;
}

const reportDashboard = (channels, { reportDate, prevDate, nextDate, note = '', noteDates = [] } = {}) => layout('리포트', `
  ${nav()}
  <h1>리포트</h1>
  <div style="display:flex; align-items:center; gap:8px; margin:8px 0 4px; position:relative;">
    <a href="/report?date=${prevDate}" style="text-decoration:none; font-size:16px; color:#555; padding:2px 6px;">◀</a>
    <button type="button" class="cal-toggle" id="calToggle">${reportDate}</button>
    <a href="/report?date=${nextDate}" style="text-decoration:none; font-size:16px; color:#555; padding:2px 6px;">▶</a>
    <div class="cal-popup" id="calPopup">
      <div class="cal-header">
        <button type="button" id="calPrev">◀</button>
        <span id="calMonthLabel"></span>
        <button type="button" id="calNext">▶</button>
      </div>
      <div class="cal-grid" id="calGrid"></div>
    </div>
  </div>
  <p style="color:#888; font-size:13px; margin-top:0;">조회수는 발행 후 48시간 동안 20분마다 갱신됩니다.</p>
  <form method="post" action="/report/note" class="note-box" style="border:1px solid #eee; border-radius:12px; padding:14px 16px; margin-bottom:20px;">
    <input type="hidden" name="date" value="${reportDate}" />
    <label>이 날짜 특이사항</label>
    <textarea name="note" placeholder="예: 8/20부터 1채널만 하루 24개로 늘려서 테스트 시작">${escapeHtml(note)}</textarea>
    <div class="note-actions">
      <button type="submit">저장</button>
      ${note ? '<span class="note-saved">저장된 메모 있음</span>' : ''}
    </div>
  </form>
  <div class="report-grid">
    ${
      channels
        .map(
          (ch) => `<div class="report-card">
        <h3>@${ch.username}</h3>
        <div class="stat-label">올린 글 조회수</div>
        <div class="stat-value blue">${formatNumber(ch.totalViews)}</div>
        <div class="stat-sub">${ch.publishedCount}개 글 합계 · ${ch.viewsConfirmed}/${ch.publishedCount}개 확인됨</div>
        <div class="stat-row">
          <div>
            <div class="stat-label">발행 완료</div>
            <div class="stat-value green">${ch.publishedCount}</div>
          </div>
          <div>
            <div class="stat-label">발행 예정</div>
            <div class="stat-value orange">${ch.pendingCount}</div>
          </div>
        </div>
        <div class="stat-sub" style="margin-top:8px;">
          이 날 총 ${ch.publishedCount + ch.pendingCount}개 (목표: 광고성 ${ch.target.ad_count}개 + 정보성 ${ch.target.info_count}개 = ${ch.target.ad_count + ch.target.info_count}개)
        </div>
        <div class="hour-grid">
          ${ch.hours
            .map(
              (h, hour) => `<div class="hour-cell ${hourCellClass(h)}">
              <div class="h">${String(hour).padStart(2, '0')}</div>
              <div class="n">${h.count || '-'}</div>
            </div>`
            )
            .join('')}
        </div>
        ${trendSparkline(ch.trend)}
      </div>`
        )
        .join('') || '<p>연결된 채널이 없습니다.</p>'
    }
  </div>
  <script>
    (function () {
      var noteDates = ${JSON.stringify(noteDates)};
      var selected = ${JSON.stringify(reportDate)};
      var noteDateSet = {};
      for (var i = 0; i < noteDates.length; i++) noteDateSet[noteDates[i]] = true;

      var selParts = selected.split('-').map(Number);
      var viewYear = selParts[0], viewMonth = selParts[1] - 1; // 0-indexed month, 달력에서 보고 있는 월(선택된 날짜와 별개로 이전/다음 이동 가능)

      var toggle = document.getElementById('calToggle');
      var popup = document.getElementById('calPopup');
      var grid = document.getElementById('calGrid');
      var monthLabel = document.getElementById('calMonthLabel');
      var DOW = ['일', '월', '화', '수', '목', '금', '토'];

      function pad(n) { return n < 10 ? '0' + n : '' + n; }

      function render() {
        monthLabel.textContent = viewYear + '년 ' + (viewMonth + 1) + '월';
        var html = DOW.map(function (d) { return '<div class="cal-dow">' + d + '</div>'; }).join('');
        var firstDow = new Date(viewYear, viewMonth, 1).getDay();
        var daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
        for (var i = 0; i < firstDow; i++) html += '<button type="button" class="cal-day empty" disabled></button>';
        for (var d = 1; d <= daysInMonth; d++) {
          var dateStr = viewYear + '-' + pad(viewMonth + 1) + '-' + pad(d);
          var cls = 'cal-day' + (dateStr === selected ? ' selected' : '');
          var dot = noteDateSet[dateStr] ? '<span class="dot"></span>' : '';
          html += '<button type="button" class="' + cls + '" data-date="' + dateStr + '">' + d + dot + '</button>';
        }
        grid.innerHTML = html;
        var dayBtns = grid.querySelectorAll('.cal-day:not(.empty)');
        for (var j = 0; j < dayBtns.length; j++) {
          dayBtns[j].addEventListener('click', function () {
            location.href = '/report?date=' + this.getAttribute('data-date');
          });
        }
      }

      toggle.addEventListener('click', function (e) {
        e.stopPropagation();
        popup.classList.toggle('open');
      });
      document.getElementById('calPrev').addEventListener('click', function () {
        viewMonth--;
        if (viewMonth < 0) { viewMonth = 11; viewYear--; }
        render();
      });
      document.getElementById('calNext').addEventListener('click', function () {
        viewMonth++;
        if (viewMonth > 11) { viewMonth = 0; viewYear++; }
        render();
      });
      document.addEventListener('click', function (e) {
        if (!popup.contains(e.target) && e.target !== toggle) popup.classList.remove('open');
      });

      render();
    })();
  </script>
`);

const errorPage = (message) => layout('오류', `
  <h1>문제가 발생했습니다</h1>
  <pre style="white-space:pre-wrap;background:#fff0f0;padding:12px;border-radius:8px;">${message}</pre>
  <a class="button" href="/">처음으로</a>
`);

const CONTACT_EMAIL = 'youkukjo@gmail.com';

const privacy = () => layout('개인정보처리방침', `
  <h1>개인정보처리방침</h1>
  <p>최종 수정일: 2026-08-13</p>
  <h3>수집하는 정보</h3>
  <p>회원님이 "Threads로 로그인"을 통해 직접 동의한 정보만 수집합니다: Threads 프로필(사용자 이름, 계정 ID), 그리고 회원님을 대신해 게시하기 위한 액세스 토큰.</p>
  <h3>사용 목적</h3>
  <p>회원님이 요청한 시점(즉시 또는 예약된 시각)에 회원님을 대신하여 Threads에 게시물을 작성하는 용도로만 사용합니다. 그 외의 목적(광고, 제3자 제공 등)으로는 사용하지 않습니다.</p>
  <h3>보관 기간</h3>
  <p>계정 연결을 해제하면 저장된 정보는 즉시 폐기됩니다. 삭제를 원하시면 아래 문의처로 연락해 주세요.</p>
  <h3>문의</h3>
  <p>${CONTACT_EMAIL}</p>
`);

const terms = () => layout('이용약관', `
  <h1>이용약관</h1>
  <p>최종 수정일: 2026-08-13</p>
  <h3>서비스 설명</h3>
  <p>threads-scheduler는 연결된 Threads 계정에, 지정한 시점에 게시물(텍스트/이미지/영상)을 대신 게시해주는 도구입니다.</p>
  <h3>책임</h3>
  <p>게시하는 콘텐츠에 대한 모든 책임은 이용자 본인에게 있으며, Threads 및 Meta의 커뮤니티 가이드라인을 준수해야 합니다.</p>
  <h3>연결 해제</h3>
  <p>언제든 Threads 계정 설정에서 이 앱과의 연결을 해제할 수 있습니다.</p>
  <h3>문의</h3>
  <p>${CONTACT_EMAIL}</p>
`);

const deleteStatus = (id) => layout('삭제 요청 처리 완료', `
  <h1>삭제 요청이 처리되었습니다</h1>
  <p>요청 번호: ${id || '-'}</p>
`);

module.exports = {
  formatKst,
  landing,
  adminLogin,
  channelsList,
  composeForm,
  postsHistory,
  reportDashboard,
  errorPage,
  privacy,
  terms,
  deleteStatus,
};
