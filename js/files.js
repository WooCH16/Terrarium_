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

  async function setRoot(r) {
    root = r || '';
    listings.clear();
    open.clear();
    open.add('');
    for (const m of marks.values()) clearTimeout(m.timer);
    marks.clear();
    const label = $('files-root');
    label.textContent = root ? root.split('/').filter(Boolean).pop() : '(폴더 없음)';
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
  F.onRoot(({ root: r }) => { if (r !== root) setRoot(r); });
  $('files-pick').addEventListener('click', async () => { const r = await F.pick(); if (r.root !== root) setRoot(r.root); });
  F.root().then((r) => setRoot(r.root));
})();
