// 데스크톱 앱에서만: 관제탑 오른쪽 빈 공간에 고른 폴더의 내용을 보인다(읽기 전용).
// 파일이 바뀌는 동안은 주황(수정 중), 바뀜이 멈추면 초록(수정 완료). 초록은 코디네이터에 다음 지시가 들어갈 때까지 남는다.
// 폴더는 안쪽에 수정 중인 파일이 있으면 주황, 없고 완료된 파일이 있으면 초록이다.
// 브라우저로 열면 window.terrarium이 없어 아무것도 하지 않는다. 바깥에서 온 이름은 textContent로만 넣는다.
(function () {
  const F = window.terrarium && window.terrarium.files;
  if (!F) return;
  const $ = (id) => document.getElementById(id);
  const panel = $('files');
  const tree = $('files-tree');
  const QUIET_MS = 2500; // 이만큼 바뀜이 없으면 "수정 완료"로 본다
  let root = '';
  const listings = new Map(); // 상대 경로('' = 맨 위) → 목록
  const open = new Set(['']);
  const marks = new Map(); // 상대 경로 → { s: 'editing' | 'done', timer }

  panel.hidden = false;

  // ---- 폭 바꾸기(왼쪽 가장자리를 끌기, 또는 손잡이에 초점을 두고 ←/→)와 접기·열기 ----
  // 넓히면 가운데 화면이 그만큼 줄어든다(css body.app). 폭과 열림은 이 컴퓨터에 기억한다(없어도 기본값으로 돈다).
  const resizer = $('files-resizer');
  const MIN_W = 160, MAIN_MIN = 520, SIDE_W = 160, DEFAULT_W = 196;
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* 기억 못 해도 된다 */ } } };
  const maxW = () => Math.max(MIN_W, window.innerWidth - SIDE_W - MAIN_MIN - 6);
  let width = Number(store.get('terrarium.filesW')) || DEFAULT_W;
  function applyWidth(w, save) {
    width = Math.round(Math.min(maxW(), Math.max(MIN_W, w)));
    document.body.style.setProperty('--files-w', width + 'px');
    resizer.setAttribute('aria-valuenow', String(width));
    if (save) store.set('terrarium.filesW', String(width));
  }
  resizer.hidden = false;
  applyWidth(width, false);
  window.addEventListener('resize', () => applyWidth(width, false));
  resizer.addEventListener('pointerdown', (e) => {
    const startX = e.clientX, startW = width;
    resizer.setPointerCapture(e.pointerId);
    document.body.classList.add('files-resizing');
    const move = (ev) => applyWidth(startW - (ev.clientX - startX), false);
    const up = () => {
      resizer.removeEventListener('pointermove', move);
      resizer.removeEventListener('pointerup', up);
      resizer.removeEventListener('pointercancel', up);
      document.body.classList.remove('files-resizing');
      applyWidth(width, true);
    };
    resizer.addEventListener('pointermove', move);
    resizer.addEventListener('pointerup', up);
    resizer.addEventListener('pointercancel', up);
  });
  resizer.addEventListener('dblclick', () => applyWidth(DEFAULT_W, true)); // 두 번 누르면 기본 폭
  resizer.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { applyWidth(width + 16, true); e.preventDefault(); }
    if (e.key === 'ArrowRight') { applyWidth(width - 16, true); e.preventDefault(); }
  });

  // 패널 단추: 코디네이터 칸 머리줄 오른쪽(ONLINE 옆)에 둔다.
  const panelBtn = document.createElement('button');
  panelBtn.type = 'button';
  panelBtn.className = 'panel-toggle';
  const head = document.querySelector('#view-main .chat-head');
  if (head) head.append(panelBtn);
  function setOpen(isOpen, save) {
    document.body.classList.toggle('files-closed', !isOpen);
    panelBtn.setAttribute('aria-pressed', String(isOpen));
    panelBtn.title = isOpen ? '파일 패널 접기' : '파일 패널 열기';
    panelBtn.setAttribute('aria-label', panelBtn.title);
    if (save) store.set('terrarium.filesOpen', isOpen ? '1' : '0');
  }
  setOpen(store.get('terrarium.filesOpen') !== '0', false);
  panelBtn.addEventListener('click', () => setOpen(document.body.classList.contains('files-closed'), true));

  const parentOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
  const join = (dir, name) => (dir ? dir + '/' + name : name);

  function statusOf(rel, dir) {
    if (!dir) return marks.get(rel)?.s ?? '';
    const pre = rel ? rel + '/' : '';
    let done = false;
    for (const [p, m] of marks) {
      if (rel && p !== rel && !p.startsWith(pre)) continue;
      if (m.s === 'editing') return 'editing';
      done = true;
    }
    return done ? 'done' : '';
  }

  function render() {
    tree.replaceChildren();
    if (!root) { const e = document.createElement('div'); e.className = 'files-empty'; e.textContent = '폴더를 고르세요.'; tree.append(e); return; }
    const walk = (dir, depth) => {
      const list = listings.get(dir);
      if (!list) return;
      if (list.error) { const e = document.createElement('div'); e.className = 'files-empty'; e.textContent = list.error; tree.append(e); return; }
      for (const ent of list) {
        const rel = join(dir, ent.name);
        const row = document.createElement('div');
        row.className = 'f-row ' + statusOf(rel, ent.dir);
        row.style.paddingLeft = 8 + depth * 14 + 'px';
        row.setAttribute('role', 'treeitem');
        row.title = rel;
        const caret = document.createElement('span');
        caret.className = 'f-caret';
        caret.textContent = ent.dir ? (open.has(rel) ? '▾' : '▸') : '';
        const name = document.createElement('span');
        name.className = 'f-name' + (ent.dir ? ' f-dir' : '');
        name.textContent = ent.name;
        row.append(caret, name);
        if (ent.dir) {
          row.setAttribute('aria-expanded', String(open.has(rel)));
          row.addEventListener('click', () => toggle(rel));
        }
        tree.append(row);
        if (ent.dir && open.has(rel)) walk(rel, depth + 1);
      }
    };
    walk('', 0);
  }

  async function load(rel) {
    const r = await F.list(rel);
    listings.set(rel, r.ok ? r.entries : { error: r.error });
  }
  async function toggle(rel) {
    if (open.has(rel)) open.delete(rel);
    else { open.add(rel); if (!listings.has(rel)) await load(rel); }
    render();
  }

  async function setRoot(r, kind) {
    root = r || '';
    listings.clear();
    open.clear();
    open.add('');
    for (const m of marks.values()) clearTimeout(m.timer);
    marks.clear();
    const label = $('files-root');
    label.replaceChildren(document.createTextNode(root ? root.split('/').filter(Boolean).pop() : '(폴더 없음 — [폴더…]로 고르세요)'));
    if (root) { const k = document.createElement('span'); k.className = 'files-kind'; k.textContent = kind === 'view' ? '보기만' : '실행 폴더'; label.append(k); }
    label.title = root;
    if (root) await load('');
    render();
  }

  // 바뀐 파일: 주황으로, 잠잠해지면 초록으로. 열려 있는 폴더의 목록도 다시 읽는다(새 파일·지운 파일).
  let reloadTimer = null;
  const toReload = new Set();
  F.onChanges(({ root: r, paths }) => {
    if (r !== root) return;
    for (const p of paths) {
      const old = marks.get(p);
      if (old) clearTimeout(old.timer);
      const m = { s: 'editing', timer: setTimeout(() => { m.s = 'done'; render(); }, QUIET_MS) };
      marks.set(p, m);
      let d = parentOf(p);
      while (d && !listings.has(d)) d = parentOf(d);
      toReload.add(d);
    }
    render();
    if (!reloadTimer) reloadTimer = setTimeout(async () => {
      reloadTimer = null;
      const dirs = [...toReload];
      toReload.clear();
      await Promise.all(dirs.map(load));
      render();
    }, 400);
  });
  // 다음 지시가 들어갔다: 완료(초록) 표시만 지운다. 아직 수정 중인 것은 그대로 둔다.
  F.onReset(() => {
    for (const [p, m] of marks) if (m.s === 'done') marks.delete(p);
    render();
  });
  F.onRoot(({ root: r, kind }) => { if (r !== root) setRoot(r, kind); });
  $('files-pick').addEventListener('click', async () => { const r = await F.pick(); if (r.root !== root) setRoot(r.root, r.kind); });
  F.root().then((r) => setRoot(r.root, r.kind));
})();
