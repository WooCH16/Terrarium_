'use strict';
// 코디네이터 창 안의 진짜 Claude Code 터미널(소유자 결정 8-18). app.js가 창 몸통 요소를 넘기면 xterm을 붙인다.
// 화면 전체는 확대·축소(transform: scale)되지만, 터미널 요소는 그 배율을 되돌려(app.js의 termInv) 늘 1배로 그린다.
// 그래서 글자가 흐려지지 않고 마우스 선택 위치도 맞는다. 배율이 바뀌면 칸 수가 바뀌고(fit) 코디네이터에 크기를 알린다.
(function () {
  const T = window.terrarium && window.terrarium.terminal;
  const GREEN = '\x1b[32m';
  const AMBER = '\x1b[33m';
  const OFF = '\x1b[0m';

  function load(tag, attrs) {
    return new Promise((ok, fail) => {
      const el = document.createElement(tag);
      Object.assign(el, attrs);
      el.onload = ok;
      el.onerror = () => fail(new Error((attrs.src || attrs.href) + ' 를 읽지 못했습니다'));
      document.head.appendChild(el);
    });
  }

  // hooks.onState('idle' | 'running' | 'ended')
  async function attach(box, hooks) {
    if (!T) { box.textContent = '앱에서만 코디네이터 터미널이 뜹니다.'; return null; }
    let state = 'idle';
    const setState = (s) => { state = s; hooks.onState && hooks.onState(s); };
    await Promise.all([
      load('link', { rel: 'stylesheet', href: T.base + '/xterm/css/xterm.css' }),
      load('script', { src: T.base + '/xterm/lib/xterm.js' }),
    ]);
    await load('script', { src: T.base + '/addon-fit/lib/addon-fit.js' });
    // WebGL: 블록 문자(로고)를 화소로 그려 칸 사이 틈이 없다. 못 쓰면 DOM 렌더러로 돈다.
    await load('script', { src: T.base + '/addon-webgl/lib/addon-webgl.js' }).catch(() => {});
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    const term = new window.Terminal({
      fontFamily: "'JetBrains Mono', Consolas, 'Noto Sans KR', monospace",
      fontSize: 12,
      lineHeight: 1.1,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
      theme: { background: '#0e0d0b', foreground: '#e8e6e1', cursor: '#d97757', selectionBackground: '#5a3a2c' },
    });
    const fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(box);
    if (window.WebglAddon) {
      try {
        const gl = new window.WebglAddon.WebglAddon();
        gl.onContextLoss(() => gl.dispose());
        term.loadAddon(gl);
      } catch { /* DOM 렌더러 */ }
    }
    const refit = () => { try { fit.fit(); } catch { /* 숨겨진 동안 */ } };
    refit();

    async function start(opts) {
      if (state === 'running' || state === 'starting') return;
      state = 'starting';
      const r = await T.start(Object.assign({ cols: term.cols, rows: term.rows }, opts || {}));
      if (r.ok) {
        setState('running');
        if (r.resumed) term.write(GREEN + '[이전 대화를 이어서 엽니다]' + OFF + '\r\n');
        return;
      }
      setState('idle');
      term.write('\r\n' + AMBER + r.error + OFF + '\r\n' + GREEN + 'Enter: 다시 시도 · S: 설정 열기' + OFF + '\r\n');
    }

    // Ctrl+C: 고른 글이 있으면 복사, 없으면 코디네이터에 끊기 신호.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.ctrlKey && e.key === 'c' && term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection());
        term.clearSelection();
        return false;
      }
      return true;
    });
    // 입력은 그대로 코디네이터에 간다(보낸 줄을 화면 기록에 남기는 일은 메인 프로세스가 한다).
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
      setState('ended');
      term.write('\r\n' + GREEN + '[코디네이터가 끝났습니다' + (code ? ' · 종료 코드 ' + code : '') + '] Enter: 이어서 다시 시작 · N: 새 대화 · S: 설정' + OFF + '\r\n');
    });
    T.onRetry((p) => {
      if (p && p.stopped) state = 'idle';
      if (state === 'running' || state === 'starting') return;
      term.reset();
      start();
    });
    // 창 크기·화면 배율이 바뀌면 칸 수를 다시 맞춘다. 확대 애니메이션 동안 여러 번 바뀌므로 잠깐 모았다가 맞춘다.
    let fitTimer = null;
    new ResizeObserver(() => { clearTimeout(fitTimer); fitTimer = setTimeout(refit, 120); }).observe(box);
    term.focus();
    start();
    return { term, focus: () => term.focus() };
  }

  window.TerrariumTerminal = { attach };
})();
