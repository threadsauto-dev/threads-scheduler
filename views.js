// toLocaleString('ko-KR')만으로는 서버 실행 환경의 시간대(Render는 UTC)를 그대로 쓰고 한국어 표기만 입혀서 실제 KST와 어긋난다 — timeZone을 명시해야 한다.
const formatKst = (date) => new Date(date).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

// /compose의 완료 메시지는 새로고침 시 폼 재제출(중복 예약)을 막으려고 리다이렉트의
// 쿼리스트링(req.query.msg)으로 전달한다 — URL을 통해 온 값이라 그대로 꽂으면 안 되고 escape 필요.
const escapeHtml = (str) =>
  String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; }
  .badge-pending { background: #fff3cd; }
  .badge-published { background: #d4edda; }
  .badge-failed { background: #f8d7da; }
  .badge-canceled { background: #e2e3e5; color: #555; }
  .cancel-btn { background: #fff; color: #c00; border: 1px solid #f1b0b0; padding: 4px 10px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; }
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

const channelsList = (channels) => layout('채널', `
  ${nav()}
  <h1>연결된 채널</h1>
  <table>
    <tr><th>계정</th><th>연결일</th></tr>
    ${channels
      .map((c) => `<tr><td>@${c.username}</td><td>${formatKst(c.created_at)}</td></tr>`)
      .join('') || '<tr><td colspan="2">연결된 채널이 없습니다.</td></tr>'}
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
    <select name="channelId" required>
      ${channels
        .map(
          (c) =>
            `<option value="${c.id}" ${String(c.id) === String(selectedChannelId) ? 'selected' : ''}>@${c.username}</option>`
        )
        .join('')}
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
          console.log('[mediaDrop] drop 발생, types=', Array.from(e.dataTransfer.types), 'files.length=', e.dataTransfer.files.length);
          Array.from(e.dataTransfer.files).forEach(function (f) {
            console.log('[mediaDrop] 파일 받음', f.name, f.type, f.size);
            dt.items.add(f);
          });
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

const postsHistory = (posts) => layout('발행 내역', `
  ${nav()}
  <h1>발행 내역</h1>
  <table>
    <tr><th>채널</th><th>본문</th><th>예정 시각</th><th>상태</th><th>관리</th></tr>
    ${
      posts
        .map(
          (p) => `<tr>
        <td>@${p.username}</td>
        <td>${(p.text || '').slice(0, 30)}</td>
        <td>${formatKst(p.scheduled_at)}</td>
        <td><span class="badge badge-${p.status}">${p.status}</span></td>
        <td>${p.status === 'pending' ? pendingActions(p, '/posts') : ''}</td>
      </tr>`
        )
        .join('') || '<tr><td colspan="5">기록이 없습니다.</td></tr>'
    }
  </table>
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
  errorPage,
  privacy,
  terms,
  deleteStatus,
};
