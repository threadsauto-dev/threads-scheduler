// toLocaleString('ko-KR')만으로는 서버 실행 환경의 시간대(Render는 UTC)를 그대로 쓰고 한국어 표기만 입혀서 실제 KST와 어긋난다 — timeZone을 명시해야 한다.
const formatKst = (date) => new Date(date).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

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

const upcomingList = (posts) => {
  if (posts.length === 0) return '';
  return `
  <h3 style="margin-top:32px;">다가오는 예약 발행</h3>
  <table>
    <tr><th>채널</th><th>예정 시각</th><th>본문</th></tr>
    ${posts
      .map(
        (p) => `<tr>
      <td>@${p.username}</td>
      <td>${formatKst(p.scheduled_at)}</td>
      <td>${(p.text || '').slice(0, 30)}</td>
    </tr>`
      )
      .join('')}
  </table>`;
};

const composeForm = (channels, message, upcomingPending = []) => layout('글쓰기', `
  ${nav()}
  <h1>글쓰기</h1>
  ${message ? `<p style="background:#f0f9f0;padding:12px;border-radius:8px;">${message}</p>` : ''}
  ${
    channels.length === 0
      ? `<p>먼저 <a href="/channels/connect">채널을 연결</a>해주세요.</p>`
      : `<form method="post" action="/compose" enctype="multipart/form-data">
    <label>채널</label>
    <select name="channelId" required>
      ${channels.map((c) => `<option value="${c.id}">@${c.username}</option>`).join('')}
    </select>
    <label>본문</label>
    <textarea name="text" rows="5" required placeholder="게시할 내용을 입력하세요"></textarea>

    <label>미디어 (이미지/영상, 최대 20개, 선택)</label>
    <div id="mediaDropZone" style="border:2px dashed #ccc; border-radius:8px; padding:20px; text-align:center; margin-bottom:8px; cursor:pointer; color:#777; font-size:14px;">
      클릭해서 파일 선택, 끌어다 놓기, 또는 이미지 붙여넣기(Ctrl+V)
    </div>
    <input type="file" id="mediaFileInput" name="mediaFiles" accept="image/*,video/*" multiple style="display:none" />
    <div id="mediaPreviewList" style="display:flex; flex-wrap:wrap; gap:10px; margin-bottom:16px;"></div>
    <script>
      (function () {
        var dt = new DataTransfer();
        var zone = document.getElementById('mediaDropZone');
        var input = document.getElementById('mediaFileInput');
        var preview = document.getElementById('mediaPreviewList');

        function render() {
          preview.innerHTML = '';
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
            var name = document.createElement('div');
            name.style.cssText = 'font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
            name.textContent = file.name;
            item.appendChild(name);
            var removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.textContent = '✕';
            removeBtn.style.cssText = 'position:absolute; top:-6px; right:-6px; width:20px; height:20px; border-radius:50%; border:none; background:#000; color:#fff; cursor:pointer; padding:0; font-size:11px; line-height:1;';
            removeBtn.onclick = function () {
              var newDt = new DataTransfer();
              Array.from(dt.files).forEach(function (f, i) { if (i !== idx) newDt.items.add(f); });
              dt = newDt;
              input.files = dt.files;
              render();
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
    <input type="text" name="replyText" placeholder="게시 후 자동으로 달릴 댓글" />

    <label>발행 날짜</label>
    <input type="date" name="scheduledDate" id="scheduledDate" required />

    <label>발행 시각 (24시간제)</label>
    <div style="display:flex; align-items:center; gap:6px; margin-bottom:16px;">
      <select name="scheduledHour" id="scheduledHour" required style="width:auto; margin:0;">
        ${Array.from({ length: 24 }, (_, h) => `<option value="${String(h).padStart(2, '0')}">${String(h).padStart(2, '0')}</option>`).join('')}
      </select>
      시
      <select name="scheduledMinute" id="scheduledMinute" required style="width:auto; margin:0;">
        ${Array.from({ length: 60 }, (_, m) => `<option value="${String(m).padStart(2, '0')}">${String(m).padStart(2, '0')}</option>`).join('')}
      </select>
      분
    </div>
    <script>
      (function () {
        var now = new Date();
        var dateEl = document.getElementById('scheduledDate');
        var y = now.getFullYear(), m = String(now.getMonth() + 1).padStart(2, '0'), d = String(now.getDate()).padStart(2, '0');
        dateEl.min = y + '-' + m + '-' + d;
        dateEl.value = y + '-' + m + '-' + d;
        document.getElementById('scheduledHour').value = String(now.getHours()).padStart(2, '0');
        document.getElementById('scheduledMinute').value = String(now.getMinutes()).padStart(2, '0');
      })();
    </script>

    <button type="submit">게시 / 예약</button>
  </form>`
  }
  ${upcomingList(upcomingPending)}
`);

const postsHistory = (posts) => layout('발행 내역', `
  ${nav()}
  <h1>발행 내역</h1>
  <table>
    <tr><th>채널</th><th>본문</th><th>예정 시각</th><th>상태</th></tr>
    ${
      posts
        .map(
          (p) => `<tr>
        <td>@${p.username}</td>
        <td>${(p.text || '').slice(0, 30)}</td>
        <td>${formatKst(p.scheduled_at)}</td>
        <td><span class="badge badge-${p.status}">${p.status}</span></td>
      </tr>`
        )
        .join('') || '<tr><td colspan="4">기록이 없습니다.</td></tr>'
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
