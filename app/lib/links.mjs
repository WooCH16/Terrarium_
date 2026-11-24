// 코디네이터 터미널의 링크(Claude Code가 OSC 8로 내보내는 주소)를 기본 브라우저로 열어도 되는지 본다.
// xterm.js의 기본 처리기는 영어 confirm 창을 띄운 뒤 빈 창을 열고 주소를 넣는데, 앱은 앱 안 창 열기를 막아서
// [확인]을 눌러도 아무것도 열리지 않았다(2026-11-24). 앱은 이 검사를 통과한 주소만 shell.openExternal로 넘긴다.
// 열 수 있는 것: http·https, 계정 정보 없음, 2048자 이하. 로컬 개발 서버(127.0.0.1, localhost)도 된다.
export function safeLink(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048 || raw !== raw.trim()) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  return u.href;
}
