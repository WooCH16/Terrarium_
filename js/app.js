(function () {
  const TEAMS = ['dev', 'design', 'tester', 'plan', 'sec'];
  const NAMES = {dev: '개발팀', design: '디자인', tester: '테스터', plan: '기획', sec: '보안팀'};
  const STATE_LABEL = {work: '작업중', pause: '일시정지', idle: '대기중'};
  const ICONS = {
    dev: '<path d="M8 7 L3 12 L8 17"/><path d="M16 7 L21 12 L16 17"/><path d="M14 4 L10 20"/>',
    design: '<path d="M4 20 L5 15 L16 4 L20 8 L9 19 Z"/><path d="M14 6 L18 10"/>',
    tester: '<circle cx="10" cy="10" r="6"/><path d="M15 15 L21 21"/><path d="M7.5 10 L9.5 12 L13 8"/>',
    plan: '<rect x="6" y="4" width="12" height="16" rx="1.5"/><path d="M9 9 L15 9"/><path d="M9 13 L15 13"/><path d="M9 17 L13 17"/>',
    sec: '<path d="M12 3 L19 6 V12 C19 16.5 16 19.5 12 21 C8 19.5 5 16.5 5 12 V6 Z"/><path d="M9 12 L11 14 L15 10"/>'
  };
  // 사무실 좌표는 240x200 픽셀 아트 기준(화면에서는 3배)
  const OFFICE = {
    desks: [6, 33, 60, 87, 114],
    beds: [[123, 126], [161, 126], [199, 126], [123, 162], [161, 162]],
    idle: {dev: ['stand', 166, 62], design: ['stand', 190, 52], tester: ['sit', 34, 133], plan: ['sit', 62, 133], sec: ['stand', 92, 146]},
    sprite: {work: [18, 18], stand: [18, 23], sit: [18, 19], sleep: [18, 13]}
  };

  const state = {mode: 'matrix', view: 'main', teamId: null, ops: [], op: null, sum: null, msgs: null};
  // 카드 이름: 데이터에 이름이 있으면 그것, 없으면 팀 이름(앱의 실제 상태는 이름을 넣지 않아 늘 팀 이름이다, 결정 8-29)
  const nameOf = (id) => { const o = state.ops.find((x) => x.id === id); return (o && o.name) || NAMES[id]; };
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));

  // 내용이 바뀐 구역만 다시 그려서 애니메이션이 폴링마다 끊기지 않게 한다
  const lastHTML = new Map();
  function setHTML(id, html) {
    if (lastHTML.get(id) === html) return;
    lastHTML.set(id, html);
    $(id).innerHTML = html;
  }

  const statusHTML = (s) => s === 'pause'
    ? '<span class="status" data-state="pause"><i></i><i></i>일시정지</span>'
    : '<span class="status" data-state="' + s + '">' + (s === 'work' ? '● 작업중' : '○ 대기중') + '</span>';
  const iconHTML = (id, size) => '<svg class="icon" aria-hidden="true" width="' + size + '" height="' + size + '" viewBox="0 0 24 24">' + ICONS[id] + '</svg>';
  const statHTML = (k, v) => '<div class="stat"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>';
  const barHTML = (pct) => '<span class="bar"><span style="width: ' + pct + '%"></span></span>';
  function lineHTML(cls, markerId, style, w, h, d, label) {
    return '<svg class="line ' + cls + '" role="img" aria-label="' + label + '" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" style="' + style + '">' +
      '<defs><marker id="' + markerId + '" orient="auto" markerWidth="5" markerHeight="5" refX="2" refY="2" overflow="visible"><path d="M0 0 L4 2 L0 4 Z"/></marker></defs>' +
      '<path d="' + d + '" marker-end="url(#' + markerId + ')"/></svg>';
  }

  function renderMain() {
    setHTML('arrows', state.ops.map((o, i) => {
      const w = o.state === 'work';
      return '<span data-team="' + o.id + '">' + lineHTML('arrow ' + (w ? 'flow' : 'still'), 'arrow-' + i, 'left: ' + (240 + i * 138) + 'px', 8, 35, 'M 4 0 L 4 31',
        'Orchestra에서 ' + nameOf(o.id) + ', ' + (w ? '호출됨' : '호출 없음')) + '</span>';
    }).join(''));
    setHTML('cards', state.ops.map((o, i) =>
      '<button type="button" class="card" data-team="' + o.id + '" data-state="' + o.state + '" style="left: ' + (184 + i * 138) + 'px">' +
      '<span class="label">' + nameOf(o.id) + '</span>' + iconHTML(o.id, 36) + statusHTML(o.state) + '</button>').join(''));
    setHTML('messages', (state.msgs || []).slice(-4).map((m) => {
      const u = m.from === 'user';
      return '<div class="msg' + (u ? ' user' : '') + '"><span class="who">' + (u ? 'USER ›' : 'ORCHESTRA ›') + '</span><span class="body">' + esc(m.text) + '</span></div>';
    }).join(''));
  }

  function renderTeam() {
    const id = state.teamId || 'dev';
    const op = (state.op && state.op.id === id) ? state.op : {id: id, state: 'idle', working: 0, avg: 0, workers: [], log: []};
    const n = op.workers.length;
    const cw = 140, gap = 16, sx = Math.round((720 - (n * cw + Math.max(0, n - 1) * gap)) / 2), ocx = 360;
    $('team-panel').dataset.team = id;
    $('team-title').textContent = nameOf(id);
    setHTML('team-stats', statHTML('호출한 워커', n + '명') + statHTML('작업중', op.working + '명') + statHTML('평균 진행률', op.avg + '%'));
    setHTML('team-op', '<div class="op-box" data-state="' + op.state + '"><div class="label">OPERATOR · ' + nameOf(id) + '</div>' + iconHTML(id, 34) + '<div>' + statusHTML(op.state) + '</div></div>');
    setHTML('team-lines', op.workers.map((w, i) => {
      const wcx = sx + i * (cw + gap) + cw / 2;
      const lx = Math.min(ocx, wcx) - 4, lw = Math.abs(wcx - ocx) + 8, x0 = ocx - lx, x1 = wcx - lx;
      const on = w.state === 'work';
      return lineHTML('wline ' + (on ? 'flow' : 'still'), id + '-wline-' + i, 'left: ' + lx + 'px; width: ' + lw + 'px', lw, 56,
        'M ' + x0 + ' 0 L ' + x0 + ' 24 L ' + x1 + ' 24 L ' + x1 + ' 52',
        nameOf(id) + ' 오퍼레이터에서 워커 ' + (i + 1) + ', ' + (on ? '호출됨' : '호출 없음'));
    }).join(''));
    setHTML('team-workers', op.workers.map((w, i) =>
      '<div class="worker" data-state="' + w.state + '" style="left: ' + (sx + i * (cw + gap)) + 'px">' +
      '<div class="top"><span class="tag">WORKER ' + (i + 1) + '</span><span class="name">' + esc(w.name) + '</span></div>' +
      '<div>' + statusHTML(w.state) + '</div>' +
      '<div class="prog">' + barHTML(w.progress) + '<span>' + w.progress + '%</span></div></div>').join(''));
    setHTML('team-logs', (op.log || []).slice(-3).map((t) => '<span>' + esc(t) + '</span>').join(''));
  }

  function renderTotal() {
    const ops = state.ops;
    const sum = state.sum || {operators: ops.length, workers: 0, working: 0, avg: 0};
    setHTML('total-stats', statHTML('전체 팀', sum.operators + '개') + statHTML('호출 워커 합계', sum.workers + '명') + statHTML('작업중 워커', sum.working + '명') + statHTML('전체 평균 진행률', sum.avg + '%'));
    setHTML('total-rows', ops.map((o) =>
      '<button type="button" class="row grid-cols" data-team="' + o.id + '" data-state="' + o.state + '">' +
      '<span class="name">' + nameOf(o.id) + '</span><span>' + statusHTML(o.state) + '</span>' +
      '<span>' + o.workerCount + '명</span><span>' + o.working + '명</span>' +
      '<span class="prog">' + barHTML(o.avg) + '<span class="pct">' + o.avg + '%</span></span></button>').join(''));
    setHTML('total-dist', [['● 작업중', 'work'], ['○ 대기중', 'idle'], ['Ⅱ 일시정지', 'pause']].map((d) =>
      '<div' + (d[1] === 'pause' ? ' class="dashed"' : '') + '><span>' + d[0] + '</span><span class="v">' + ops.filter((o) => o.state === d[1]).length + '팀</span></div>').join(''));
  }

  const chars = {};
  function renderOffice() {
    const px = (x) => x * 3;
    const screens = [], zs = [], tags = [];
    state.ops.forEach((o, i) => {
      let pose, x, y, tx, ty;
      if (o.state === 'work') {
        const dx = OFFICE.desks[i];
        pose = 'work'; x = dx + 6; y = 56; tx = dx + 14; ty = 77;
        screens.push('<div class="scr" aria-hidden="true" data-team="' + o.id + '" style="left: ' + px(dx + 8) + 'px"></div>');
      } else if (o.state === 'pause') {
        const b = OFFICE.beds[i];
        pose = 'sleep'; x = b[0] + 1; y = b[1] + 6; tx = b[0] + 25; ty = b[1] + 6;
        [0, 1].forEach((k) => zs.push('<span class="zz" aria-hidden="true" style="left: ' + px(b[0] + 12 + k * 3) + 'px; top: ' + px(b[1] + 1 - k * 3) + 'px; font-size: ' + (12 + k * 4) + 'px; animation-delay: ' + (k * 1.3 + i * 0.2) + 's">Z</span>'));
      } else {
        const s = OFFICE.idle[o.id];
        pose = s[0]; x = s[1]; y = s[2]; tx = x + 8; ty = pose === 'sit' ? 186 : y + 23;
      }
      // 캐릭터 요소는 재사용해야 방 사이를 걸어서 이동한다(left/top 트랜지션)
      let el = chars[o.id];
      if (!el) {
        el = chars[o.id] = document.createElement('img');
        el.alt = '';
        el.style.animationDelay = (i * 0.17) + 's';
        $('office-chars').appendChild(el);
      }
      if (el.dataset.pose !== pose) {
        const size = OFFICE.sprite[pose];
        el.dataset.pose = pose;
        el.className = 'chr c-' + pose;
        el.src = 'assets/sprites/' + o.id + '-' + pose + '.png';
        el.style.width = px(size[0]) + 'px';
        el.style.height = px(size[1]) + 'px';
      }
      el.style.left = px(x - 1) + 'px';
      el.style.top = px(y - 1) + 'px';
      tags.push('<button type="button" class="tag-btn" data-team="' + o.id + '" data-state="' + o.state + '" style="left: ' + px(tx) + 'px; top: ' + px(ty) + 'px">' + nameOf(o.id) + '<br>' + STATE_LABEL[o.state] + '</button>');
    });
    setHTML('office-screens', screens.join(''));
    setHTML('office-zs', zs.join(''));
    setHTML('office-tags', tags.join(''));
  }

  function render() {
    const office = state.mode === 'office';
    $('view-main').hidden = office || state.view !== 'main';
    $('view-team').hidden = office || state.view !== 'team';
    $('view-total').hidden = office || state.view !== 'total';
    $('view-office').hidden = !office;
    $('work-count').textContent = '작업중 ' + state.ops.filter((o) => o.state === 'work').length;
    document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode)));
    document.querySelectorAll('.item').forEach((b) => {
      const on = !office && (b.dataset.team ? (state.view === 'team' && (state.teamId || 'dev') === b.dataset.team) : state.view === b.dataset.view);
      if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
    });
    document.querySelectorAll('.item[data-team]').forEach((b) => { b.textContent = nameOf(b.dataset.team); });
    renderMain();
    renderTeam();
    renderTotal();
    renderOffice();
  }

  const api = ControlApi.request;
  ControlApi.setLogger((line) => document.querySelectorAll('.api-log').forEach((el) => { el.textContent = line; }));

  function refresh() {
    api('GET', '/operators').then((r) => {
      state.ops = r.data;
      render();
      if (state.view === 'team' && state.teamId) api('GET', '/operators/' + state.teamId).then((r2) => { state.op = r2.data; render(); });
      if (state.view === 'total') api('GET', '/summary').then((r3) => { state.sum = r3.data; render(); });
    });
    if (!state.msgs) api('GET', '/messages').then((r) => { state.msgs = r.data; render(); });
  }

  function go(mode, view, teamId) {
    state.mode = mode;
    state.view = view;
    state.teamId = teamId || null;
    if (view === 'team') state.op = ControlApi.peekOperator(teamId);
    render();
    refresh();
  }

  $('stage').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.mode) go(b.dataset.mode, state.view, state.teamId);
    else if (b.dataset.team) go('matrix', 'team', b.dataset.team);
    else if (b.dataset.view) go('matrix', b.dataset.view);
  });

  $('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('orch-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    api('POST', '/orchestra/messages', {text: text}).then((r) => {
      state.msgs = r.data.messages;
      state.ops = r.data.operators;
      render();
    });
  });

  // 880x600 무대를 창 크기에 맞춘다. 데스크톱 앱은 창의 확대 배율로 맞추므로 건너뛴다(터미널 칸 계산이 CSS zoom에서 어긋난다).
  function fit() {
    if (window.terrarium) return;
    $('stage').style.zoom = Math.min(2, window.innerWidth / 880, window.innerHeight / 600);
  }
  window.addEventListener('resize', fit);
  fit();

  render();
  refresh();
  setInterval(refresh, 4000);
})();
