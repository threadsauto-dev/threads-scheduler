const layout = (title, body) => `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; line-height: 1.6; }
  a.button { display: inline-block; background: #000; color: #fff; padding: 12px 24px; border-radius: 999px; text-decoration: none; font-weight: 600; }
  textarea, input { width: 100%; box-sizing: border-box; padding: 10px; margin: 6px 0 16px; border: 1px solid #ddd; border-radius: 8px; font-size: 15px; }
  label { font-weight: 600; font-size: 14px; color: #555; }
  button { background: #000; color: #fff; padding: 12px 24px; border: none; border-radius: 999px; font-weight: 600; font-size: 15px; cursor: pointer; }
  footer { margin-top: 40px; font-size: 13px; color: #888; }
  footer a { color: #888; }
</style>
</head>
<body>
${body}
<footer><a href="/privacy">개인정보처리방침</a> · <a href="/terms">이용약관</a></footer>
</body>
</html>`;

const landing = () => layout('threads-scheduler', `
  <h1>threads-scheduler</h1>
  <p>Threads 계정을 연결하면, 지금 또는 원하는 시각에 대신 글을 게시해드립니다.</p>
  <a class="button" href="/auth/login">Threads로 로그인</a>
`);

const dashboard = (username, result) => layout('대시보드', `
  <h1>@${username}</h1>
  <p><a href="/auth/logout">로그아웃</a></p>
  ${result ? `<p style="background:#f0f9f0;padding:12px;border-radius:8px;">${result}</p>` : ''}
  <form method="post" action="/dashboard/publish">
    <label>본문</label>
    <textarea name="text" rows="5" required placeholder="게시할 내용을 입력하세요"></textarea>
    <label>이미지 URL (선택)</label>
    <input type="url" name="imageUrl" placeholder="https://..." />
    <label>영상 URL (선택)</label>
    <input type="url" name="videoUrl" placeholder="https://..." />
    <label>댓글 (선택)</label>
    <input type="text" name="replyText" placeholder="게시 후 자동으로 달릴 댓글" />
    <label>몇 분 후 게시할까요? (0이면 즉시)</label>
    <input type="number" name="delayMinutes" value="0" min="0" max="60" />
    <button type="submit">게시</button>
  </form>
`);

const scheduled = (minutes) => layout('예약 완료', `
  <h1>예약되었습니다</h1>
  <p>${minutes}분 후 자동으로 게시됩니다.</p>
  <a class="button" href="/dashboard">돌아가기</a>
`);

const published = (username, postId, replyId) => layout('게시 완료', `
  <h1>게시 완료</h1>
  <p><a href="https://www.threads.net/@${username}/post/${postId}" target="_blank">게시물 보기</a></p>
  ${replyId ? '<p>댓글도 함께 게시되었습니다.</p>' : ''}
  <a class="button" href="/dashboard">돌아가기</a>
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
  <p>threads-scheduler는 회원님의 Threads 계정에, 회원님이 작성하고 지정한 시점에 게시물(텍스트/이미지/영상)을 대신 게시해주는 도구입니다.</p>
  <h3>회원님의 책임</h3>
  <p>게시하는 콘텐츠에 대한 모든 책임은 회원님 본인에게 있으며, Threads 및 Meta의 커뮤니티 가이드라인을 준수해야 합니다.</p>
  <h3>연결 해제</h3>
  <p>언제든 대시보드에서 로그아웃하거나 Threads 계정 설정에서 이 앱과의 연결을 해제할 수 있습니다.</p>
  <h3>문의</h3>
  <p>${CONTACT_EMAIL}</p>
`);

const deleteStatus = (id) => layout('삭제 요청 처리 완료', `
  <h1>삭제 요청이 처리되었습니다</h1>
  <p>요청 번호: ${id || '-'}</p>
`);

module.exports = { landing, dashboard, scheduled, published, errorPage, privacy, terms, deleteStatus };
