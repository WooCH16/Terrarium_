// 데스크톱 앱에서만: ORCHESTRA 칸에 진짜 Claude Code 코디네이터 터미널을 띄운다(소유자 결정 8-18).
// 브라우저로 열면 window.terrarium이 없어 아무것도 하지 않는다(목 대화가 그대로 돈다).
(function () {
  const T = window.terrarium && window.terrarium.terminal;
  if (!T) return;
  const $ = (id) => document.getElementById(id);
  const chat = document.querySelector('#view-main .chat');
  const box = $('term');
  $('messages').hidden = true;
  $('chat-form').hidden = true;
  box.hidden = false;
  chat.classList.add('has-term');
  const sub = chat.querySelector('.sub');
  if (sub) sub.textContent = '코디네이터 · Claude Code';
  const online = chat.querySelector('.online');

  function load(tag, attrs) {
    return new Promise((ok, fail) => {
      const el = document.createElement(tag);
      Object.assign(el, attrs);
      el.onload = ok;
      el.onerror = () => fail(new Error((attrs.src || attrs.href) + ' 를 읽지 못했습니다'));
      document.head.appendChild(el);
    });
  }

  // 상태: idle(아직 안 띄움 또는 막힘) · running · ended
  let state = 'idle';
  let term = null;
  let fit = null;
  const GREEN = '\x1b[32m';
  const AMBER = '\x1b[33m';
  const OFF = '\x1b[0m';
  function setOnline(on) {
    if (!online) return;
    online.classList.toggle('off', !on);
    online.lastChild.textContent = on ? 'ONLINE' : 'OFFLINE';
  }

  async function start(opts) {
    if (state === 'running') return;
    state = 'starting';
    const r = await T.start(Object.assign({ cols: term.cols, rows: term.rows }, opts || {}));
    if (r.ok) {
      state = 'running';
      setOnline(true);
      if (r.resumed) term.write(GREEN + '[이전 대화를 이어서 엽니다]' + OFF + '\r\n');
      return;
    }
    state = 'idle';
    setOnline(false);
    term.write('\r\n' + AMBER + r.error + OFF + '\r\n' + GREEN + 'Enter: 다시 시도 · S: 설정 열기' + OFF + '\r\n');
  }

  async function init() {
    await Promise.all([
      load('link', { rel: 'stylesheet', href: T.base + '/xterm/css/xterm.css' }),
      load('script', { src: T.base + '/xterm/lib/xterm.js' }),
    ]);
    await load('script', { src: T.base + '/addon-fit/lib/addon-fit.js' });
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    term = new window.Terminal({
      fontFamily: "'JetBrains Mono', Consolas, 'Noto Sans KR', monospace",
      fontSize: 12,
      lineHeight: 1.1,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
      theme: { background: '#000c03', foreground: '#B8FFC8', cursor: '#00FF41', selectionBackground: '#0E5A22', green: '#00FF41', brightGreen: '#4FB36A' },
    });
    fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(box);
    fit.fit();
    // Ctrl+C: 고른 글이 있으면 복사, 없으면 코디네이터에 끊기 신호로 보낸다.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.ctrlKey && e.key === 'c' && term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection());
        term.clearSelection();
        return false;
      }
      return true;
    });
    term.onData((d) => {
      if (state === 'running') { T.input(d); return; }
      if (state === 'starting') return;
      if (d === '\r') start();
      else if (state === 'ended' && (d === 'n' || d === 'N')) start({ fresh: true });
      else if (d === 's' || d === 'S') T.openSettings('accounts');
    });
    term.onResize(({ cols, rows }) => T.resize(cols, rows));
    T.onData((d) => term.write(d));
    T.onExit(({ code }) => {
      state = 'ended';
      setOnline(false);
      term.write('\r\n' + GREEN + '[코디네이터가 끝났습니다' + (code ? ' · 종료 코드 ' + code : '') + '] Enter: 이어서 다시 시작 · N: 새 대화 · S: 설정' + OFF + '\r\n');
    });
    // 실행 폴더를 바꾸면(stopped) 앱이 터미널을 닫았으니 새로 띄운다. 사전 점검 통과면 아직 안 떴을 때만 띄운다.
    T.onRetry((p) => {
      if (p && p.stopped) state = 'idle';
      if (state === 'running' || state === 'starting') return;
      term.reset();
      start();
    });
    new ResizeObserver(() => fit.fit()).observe(box);
    term.focus();
    start();
  }

  init().catch((e) => {
    box.textContent = '터미널을 띄우지 못했습니다: ' + e.message;
    setOnline(false);
  });
})();
