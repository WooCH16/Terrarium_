'use strict';
const WIN_W = 720, WIN_H = 460; // 코디네이터 창 기본 크기(터미널이 들어간다)
/**
 * 관제탑 화면 로직. 마크업은 index.html(<script type="text/x-template" id="screen">)에 있고 runtime.js가 그린다.
 * 세션 창은 메인 프로세스가 하네스 기록(guard.log, advice-log.jsonl, handoffs/)을 읽어 보내는 이벤트로만 생긴다
 * (app/lib/flow.mjs, 이벤트 모양은 docs/app-screen.md). 하달하지 않은 팀의 오퍼레이터나 하달에 없는 워커는 그리지 않는다.
 * 코디네이터 창 몸통은 진짜 Claude Code 터미널이다(terminal.js). 지시는 그 터미널에 직접 친다.
 */
class Component extends DCLogic {
  constructor(props) {
    super(props);
    this.canvas = null;
    this.mouse = { x: -9999, y: -9999, tx: -9999, ty: -9999, on: 0, ton: 0 };
    this.setCanvas = (el) => {
      if (el === this.canvas) return;
      this.detach();
      this.canvas = el;
      if (el) this.attach();
    };
    this.state = { dx: 0, dy: 0, w: WIN_W, h: WIN_H, dragging: false, panning: false, camTick: 0 };
    this.cam = { x: 0, y: 0, z: 1 };
    this.pan = null;
    this.camTarget = null;
    this.termEl = null;
    this.termState = 'idle';
    // 코디네이터 창 몸통에 진짜 터미널을 붙인다(한 번만).
    this.setTermHost = (el) => {
      if (!el || this.termEl) return;
      this.termEl = el;
      window.TerrariumTerminal.attach(el, { onState: (st) => { this.termState = st; this.refresh(); } })
        .catch((e) => { el.textContent = '터미널을 띄우지 못했습니다: ' + e.message; });
    };
    this.timers = [];
    this.task = '';
    this.logs = [];
    this.coordSt = 'READY';
    this.jevUntil = { adv: 0, ops: 0 };
    this.links = { adv: 0, ops: 0, work: 0 };
    // Sessions are created from orchestrator events (see onEvent); nothing is hard-coded.
    this.defs = [];
    this.ns = {};
    this.runId = null;
    this.backend = window.terrarium;
    this.co = { user: '', sub: '', product: '', version: '', model: '' };
    this.usage = { available: false, meters: [], note: '' };
    this.account = { name: '', email: '', repo: '', run: '', preflight: '' };
    this.refresh = () => this.setState({ tick: (this.state.tick || 0) + 1 });
    this.log = (t, c) => { this.logs = this.logs.concat([{ t, c: c || '#a8a59c' }]).slice(-6); };
    // 워커 모델은 하네스가 정한다(Jev 라우팅). 화면은 보여 주기만 한다.
    this.models = [
      { k: 'claude', name: 'Claude', bg: '#c4623f' },
      { k: 'gemini', name: 'Gemini', bg: '#1d63d8' },
      { k: 'muse', name: 'Muse', bg: '#a8346f' },
      { k: 'codex', name: 'Codex', bg: '#3b3fd8' }
    ];
    this.modelKey = (d) => d.model || 'claude';
    this.modelInfo = (key) => this.models.find((m) => m.k === key) || { k: key, name: key, bg: '#4a4844' };
    this.opPanel = {};
    this.lastTap = null;
    this.nodeTap = {};
    this.tap = (id, e) => {
      const now = Date.now();
      const lt = this.lastTap;
      if (lt && lt.id === id && now - lt.t < 380 && Math.abs(e.clientX - lt.x) < 6 && Math.abs(e.clientY - lt.y) < 6) {
        this.lastTap = null;
        if ((this.defs.find((d) => d.id === id) || {}).role === 'op') { this.opPanel[id] = !this.opPanel[id]; this.refresh(); }
        return;
      }
      this.lastTap = { id, t: now, x: e.clientX, y: e.clientY };
    };
    this.off = {};
    this.sz = {};
    this.nodeGrab = {};
    this.nodeRs = {};
    this.initNode = (d) => {
      if (this.nodeGrab[d.id]) return;
      this.off[d.id] = { x: 0, y: 0 };
      const rsBegin = (mode) => (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
        const p = this.layout(this.state).pos[d.id];
        const o = this.off[d.id];
        this.drag = { mode: 'nres', dir: mode, id: d.id, sx: e.clientX, sy: e.clientY, ox0: o.x, oy0: o.y, w0: p.w, h0: p.h };
        this.setState({ nodeDrag: d.id });
      };
      this.nodeRs[d.id] = {};
      ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].forEach((m) => { this.nodeRs[d.id][m] = rsBegin(m); });
      this.nodeTap[d.id] = (e) => { if (e.button === undefined || e.button === 0) this.tap(d.id, e); };
      this.nodeGrab[d.id] = (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        this.tap(d.id, e);
        e.preventDefault();
        e.stopPropagation();
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
        const o = this.off[d.id];
        this.drag = { mode: 'node', id: d.id, sx: e.clientX, sy: e.clientY, ox0: o.x, oy0: o.y };
        this.setState({ dragging: false, nodeDrag: d.id });
      };
    };
    this.drag = null;
    const begin = (mode) => (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
      const s = this.state;
      this.drag = { mode, sx: e.clientX, sy: e.clientY, dx0: s.dx, dy0: s.dy, w0: s.w, h0: s.h };
      this.setState({ dragging: mode === 'move' });
    };
    this.grabBar = begin('move');
    this.state.lpX = 12; this.state.lpY = 12; this.state.lpW = 184;
    const panelBegin = (mode) => (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
      const s = this.state;
      this.drag = { mode, sx: e.clientX, sy: e.clientY, x0: s.lpX, y0: s.lpY, w0: s.lpW };
      this.setState({ panelDrag: mode === 'panel' });
    };
    this.panelGrab = panelBegin('panel');
    this.state.rpR = 12; this.state.rpY = 12; this.state.rpW = 172;
    const rpBegin = (mode) => (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
      const s = this.state;
      this.drag = { mode, sx: e.clientX, sy: e.clientY, r0: s.rpR, y0: s.rpY, w0: s.rpW };
      this.setState({ rpDrag: mode === 'rp' });
    };
    this.rpGrab = rpBegin('rp');
    this.rpRs = rpBegin('rpw');
    this.panelRs = panelBegin('panelw');
    // 실행 폴더(하네스가 설치된 폴더). 탭은 열어 둔 실행 폴더들이고, 고른 탭의 폴더에서 코디네이터가 돈다.
    // 탭 목록은 이 컴퓨터에만 기억한다(없어도 지금 실행 폴더 하나로 시작한다).
    this.state.folder = '';
    this.state.ws = [];
    this.state.activeWs = 0;
    this.state.pop = null;
    this.state.folderNote = '';
    this.wsSeq = 0;
    this.folderList = [];
    const store = { get: (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} } };
    const nameOf = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || p;
    this.saveTabs = () => store.set('terrarium.tabs', JSON.stringify(this.state.ws.map((w) => w.path)));
    this.tabFor = (path) => {
      const ws = this.state.ws;
      const have = ws.find((w) => w.path === path);
      if (have) return { ws, id: have.id };
      this.wsSeq += 1;
      return { ws: ws.concat([{ id: this.wsSeq, name: nameOf(path), path }]), id: this.wsSeq };
    };
    // 실행 폴더로 바꾼다: 메인 프로세스가 코디네이터를 닫고 그 폴더에서 다시 띄운다.
    this.pickFolder = (f) => {
      if (!f || !f.path) return;
      const go = () => {
        const t = this.tabFor(f.path);
        this.setState({ folder: f.path, ws: t.ws, activeWs: t.id, pop: null, folderNote: '' }, this.saveTabs);
      };
      if (f.path === this.state.folder) { go(); return; }
      this.backend.folders.select(f.path).then((r) => { if (r && r.ok) go(); else this.setState({ folderNote: '이 폴더로 바꾸지 못했습니다.' }); });
    };
    this.browseFolder = () => {
      this.backend.folders.pick().then((r) => {
        if (!r) return;
        if (r.install) { this.setState({ pop: null, folderNote: '' }); return; } // 설치 탭으로 넘어갔다
        if (!r.ok || !r.folder) return;
        if (!this.folderList.some((x) => x.path === r.folder.path)) this.folderList = this.folderList.concat([r.folder]);
        const t = this.tabFor(r.folder.path);
        this.setState({ folder: r.folder.path, ws: t.ws, activeWs: t.id, pop: null, folderNote: '' }, this.saveTabs);
      });
    };
    this.addWs = () => this.setState({ pop: 'folder' });
    this.selectWs = (id) => { const w = this.state.ws.find((x) => x.id === id); if (w) this.pickFolder(w); };
    this.closeWs = (id) => {
      const ws = this.state.ws;
      if (ws.length <= 1) return;
      const rest = ws.filter((w) => w.id !== id);
      if (this.state.activeWs === id) { this.setState({ ws: rest }, () => { this.saveTabs(); this.pickFolder(rest[0]); }); return; }
      this.setState({ ws: rest }, this.saveTabs);
    };
    const togglePop = (k) => () => this.setState({ pop: this.state.pop === k ? null : k });
    this.toggleFolder = togglePop('folder');
    this.toggleSettings = togglePop('settings');
    this.toggleProfile = togglePop('profile');
    this.closePop = () => this.setState({ pop: null });
    // 설정 화면(계정 키·사전 점검, 실행 폴더 설치, 진행 기록)은 본창 위에 겹쳐 뜬다.
    const settings = (tab) => () => { this.setState({ pop: null }); this.backend.terminal.openSettings(tab); };
    this.openSettings = settings('accounts');
    this.openAccounts = settings('accounts');
    this.openProgress = settings('progress');
    this.goHome = () => {
      this.camTarget = null;
      this.cam = { x: 0, y: 0, z: 1 };
      this.setState({ dx: 0, dy: 0, w: WIN_W, h: WIN_H, pop: null });
      if (this.defs.length) this.fitTree();
    };
    this.rs = { n: begin('n'), s: begin('s'), e: begin('e'), w: begin('w'), ne: begin('ne'), nw: begin('nw'), se: begin('se'), sw: begin('sw') };
    this.dragMove = (e) => {
      const d = this.drag; if (!d) return;
      if (e.buttons === 0) { this.dragEnd(e); return; }
      this.onMove && this.onMove(e);
      if (d.mode === 'panel') {
        this.setState({ lpX: Math.max(0, d.x0 + e.clientX - d.sx), lpY: Math.max(0, d.y0 + e.clientY - d.sy) });
        return;
      }
      if (d.mode === 'rp') {
        this.setState({ rpR: Math.max(0, d.r0 - (e.clientX - d.sx)), rpY: Math.max(0, d.y0 + e.clientY - d.sy) });
        return;
      }
      if (d.mode === 'rpw') {
        this.setState({ rpW: Math.max(120, Math.min(900, d.w0 - (e.clientX - d.sx))) });
        return;
      }
      if (d.mode === 'panelw') {
        this.setState({ lpW: Math.max(120, Math.min(900, d.w0 + e.clientX - d.sx)) });
        return;
      }
      const z = this.cam.z || 1;
      const mx = (e.clientX - d.sx) / z, my = (e.clientY - d.sy) / z;
      if (d.mode === 'node') { this.off[d.id] = { x: d.ox0 + mx, y: d.oy0 + my }; this.refresh(); return; }
      if (d.mode === 'nres') {
        const cl = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
        let w = d.w0, h = d.h0, ox = d.ox0, oy = d.oy0;
        if (d.dir.indexOf('e') >= 0) { w = cl(d.w0 + mx, 180, 1200); ox = d.ox0 + (w - d.w0) / 2; }
        if (d.dir.indexOf('w') >= 0) { w = cl(d.w0 - mx, 180, 1200); ox = d.ox0 - (w - d.w0) / 2; }
        if (d.dir.indexOf('s') >= 0) { h = cl(d.h0 + my, 110, 900); oy = d.oy0 + (h - d.h0) / 2; }
        if (d.dir.indexOf('n') >= 0) { h = cl(d.h0 - my, 110, 900); oy = d.oy0 - (h - d.h0) / 2; }
        this.sz[d.id] = { w, h };
        this.off[d.id] = { x: ox, y: oy };
        this.refresh();
        return;
      }
      if (d.mode === 'move') { this.setState({ dx: d.dx0 + mx, dy: d.dy0 + my }); return; }
      const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
      let { w0: w, h0: h, dx0: dx, dy0: dy } = d;
      if (d.mode.indexOf('e') >= 0) { w = clamp(d.w0 + mx, 360, 1600); dx = d.dx0 + (w - d.w0) / 2; }
      if (d.mode.indexOf('w') >= 0) { w = clamp(d.w0 - mx, 360, 1600); dx = d.dx0 - (w - d.w0) / 2; }
      if (d.mode.indexOf('s') >= 0) { h = clamp(d.h0 + my, 280, 1200); dy = d.dy0 + (h - d.h0) / 2; }
      if (d.mode.indexOf('n') >= 0) { h = clamp(d.h0 - my, 280, 1200); dy = d.dy0 - (h - d.h0) / 2; }
      this.setState({ w, h, dx, dy });
    };
    this.dragEnd = (e) => {
      if (!this.drag) return;
      try { if (e && e.currentTarget && e.currentTarget.releasePointerCapture) e.currentTarget.releasePointerCapture(e.pointerId); } catch (_) {}
      this.drag = null;
      this.setState({ dragging: false, nodeDrag: null, panelDrag: false, rpDrag: false });
    };
  }
  /** Register a session (invisible until spawned). */
  addDef(info) {
    if (!info || !info.id || this.defs.some((d) => d.id === info.id)) return false;
    const roleMap = { advisor: 'adv', operator: 'op', worker: 'wk' };
    let role = roleMap[info.role] || 'op';
    const parent = info.parentId ? this.defs.find((d) => d.id === info.parentId) : null;
    if (role === 'wk' && !(parent && parent.role === 'op')) role = 'op'; // workers need an operator parent
    const d = {
      id: info.id, role, label: info.label || info.id, op: role === 'wk' ? parent.id : null,
      parent: role === 'wk' ? parent.label : (info.handoff ? 'Coordinator · ' + info.handoff : 'Coordinator'),
      model: info.model || null, task: info.task || ''
    };
    this.defs.push(d);
    this.ns[d.id] = { on: false, st: '', out: '' };
    this.initNode(d);
    return true;
  }
  /** 일이 끝난 세션을 뺀다(session.removed). 흐리게 사라진 뒤 자리를 다시 잡는다. 그 아래 워커도 같이 뺀다. */
  removeDef(id) {
    const ids = this.defs.filter((d) => d.id === id || d.op === id).map((d) => d.id);
    if (!ids.length) return;
    ids.forEach((k) => { if (this.ns[k]) this.ns[k].on = false; this.opPanel[k] = false; });
    this.timers.push(setTimeout(() => {
      this.defs = this.defs.filter((d) => !ids.includes(d.id));
      ids.forEach((k) => { delete this.ns[k]; delete this.off[k]; delete this.sz[k]; delete this.nodeGrab[k]; delete this.nodeRs[k]; delete this.nodeTap[k]; });
      const has = (r) => (this.defs.some((d) => d.role === r) ? 1 : 0);
      this.links = { adv: has('adv'), ops: has('op'), work: has('wk') };
      this.fitTree();
      this.refresh();
    }, 400));
  }
  /** Reduce one orchestrator event (types: src/shared/contract.js) into UI state. */
  onEvent(ev) {
    if (!ev || !ev.type) return;
    const tones = { user: '#e8e6e1', info: '#a8a59c', advisor: '#a78bfa', operator: '#6cb6ff', worker: '#5fd0b5', success: '#5fd0b5', error: '#f07a73' };
    if (ev.type === 'run.started') {
      this.timers.forEach(clearTimeout);
      this.timers = [];
      this.runId = ev.runId;
      this.task = ev.text || '';
      this.defs = [];
      this.ns = {};
      this.off = {};
      this.sz = {};
      this.nodeGrab = {};
      this.nodeRs = {};
      this.nodeTap = {};
      this.opPanel = {};
      this.links = { adv: 0, ops: 0, work: 0 };
      this.jevUntil = { adv: 0, ops: 0 };
      this.logs = [];
    } else if (ev.runId && this.runId && ev.runId !== this.runId) {
      return; // stale event from an earlier run
    } else if (ev.type === 'run.plan') {
      (ev.sessions || []).forEach((info) => this.addDef(info));
      this.fitTree();
    } else if (ev.type === 'coordinator.status') {
      this.coordSt = ev.status;
    } else if (ev.type === 'coordinator.log') {
      this.log(ev.text, tones[ev.tone] || tones.info);
      // 새 지시는 화면을 비우지 않는다(세션은 그대로). 코디네이터의 지금 할 일만 바꾼다.
      if (ev.tone === 'user' && /^❯ /.test(ev.text || '')) this.task = ev.text.slice(2);
    } else if (ev.type === 'session.spawned') {
      const added = this.addDef(ev.session);
      const d = this.defs.find((x) => x.id === (ev.session || {}).id);
      if (!d) return;
      if (ev.session.model) d.model = ev.session.model;
      if (ev.session.task) d.task = ev.session.task;
      this.ns[d.id] = { on: true, st: 'SPAWNING', out: '' };
      this.links[{ adv: 'adv', op: 'ops', wk: 'work' }[d.role]] = 1;
      if (added) this.fitTree(); // not announced in run.plan: make room for it
    } else if (ev.type === 'session.status') {
      const d = this.defs.find((x) => x.id === ev.id);
      if (!d) return;
      this.ns[d.id] = { on: true, st: ev.status, out: '' };
    } else if (ev.type === 'session.removed') {
      this.removeDef(ev.id);
    } else if (ev.type === 'jev.active') {
      // Jev 판정 동안 불빛을 켠다. ms가 있으면 그만큼, 없으면 꺼짐 이벤트가 올 때까지(최대 2분). 꺼질 때는 2.5초 여운.
      const k = ev.side === 'adv' ? 'adv' : 'ops';
      const now = Date.now();
      this.jevUntil[k] = ev.on ? now + (ev.ms || 120000) : Math.min(this.jevUntil[k], now + 2500);
      const wait = this.jevUntil[k] - now + 50;
      if (wait > 0) this.timers.push(setTimeout(() => this.refresh(), wait));
    } else if (ev.type === 'session.output') {
      const n = this.ns[ev.id];
      if (n) n.out = ev.text || '';
    } else if (ev.type === 'run.finished') {
      if (ev.ok === false && ev.error && ev.error !== 'stopped') {
        this.coordSt = 'ERROR';
        this.log('✗ ' + ev.error, tones.error);
      }
    }
    this.refresh();
  }
  layout(s) {
    const dx = s.dx, dy = s.dy, w = s.w, h = s.h;
    const R = dx + w / 2, B = dy + h / 2;
    const AW = 300, AH = 190, OW = 300, OH = 190, WW = 190, WH = 150;
    const f = (v) => Math.round(v);
    const off = this.off || {};
    const o = (id) => off[id] || { x: 0, y: 0 };
    const szs = this.sz || {};
    const W = (id, dw) => (szs[id] ? szs[id].w : dw);
    const H = (id, dh) => (szs[id] ? szs[id].h : dh);
    const defs = this.defs || [];
    const advs = defs.filter((d) => d.role === 'adv');
    const ops = defs.filter((d) => d.role === 'op');
    const wks = defs.filter((d) => d.role === 'wk');
    // Slots are centred on the coordinator: advisors stack on the right, operators sit in a row
    // below, each operator's workers sit in a row under it.
    const ax = R + 380, oy = B + 220, wy = oy + OH / 2 + 145;
    const centred = (i, n, gap) => (i - (n - 1) / 2) * gap;
    const pos = {};
    const opX = {};
    advs.forEach((d, i) => { const k = d.id; pos[k] = { x: ax + o(k).x, y: dy + centred(i, advs.length, 240) + o(k).y, w: W(k, AW), h: H(k, AH) }; });
    // 오퍼레이터 칸 너비는 그 아래 워커 줄이 들어갈 만큼(워커가 많은 팀끼리 겹치지 않게).
    const opSpan = ops.map((d) => Math.max(640, wks.filter((x) => x.op === d.id).length * 205 + 60));
    let opCur = dx - opSpan.reduce((a, b) => a + b, 0) / 2;
    ops.forEach((d, i) => { const k = d.id; opX[k] = opCur + opSpan[i] / 2; opCur += opSpan[i]; pos[k] = { x: opX[k] + o(k).x, y: oy + o(k).y, w: W(k, OW), h: H(k, OH) }; });
    ops.forEach((op) => {
      const mine = wks.filter((d) => d.op === op.id);
      const po = o(op.id);
      mine.forEach((d, i) => {
        const k = d.id;
        pos[k] = { x: opX[op.id] + po.x + centred(i, mine.length, 205) + o(k).x, y: wy + po.y + o(k).y, w: W(k, WW), h: H(k, WH) };
      });
    });
    const elbow = (x1, y1, x2, y2) => { const my = (y1 + y2) / 2; return 'M' + f(x1) + ' ' + f(y1) + ' V' + f(my) + ' H' + f(x2) + ' V' + f(y2) + ' '; };
    const jA = { x: R + 80, y: dy }, jO = { x: dx, y: B + 62 };
    const tAdv = 'M' + f(jA.x) + ' ' + f(jA.y) + ' H' + f(R) + ' ';
    const tOps = 'M' + f(jO.x) + ' ' + f(jO.y) + ' V' + f(B) + ' ';
    let pAdv = 'M' + f(R) + ' ' + f(dy) + ' H' + f(jA.x) + ' ';
    advs.forEach((d) => {
      const p = pos[d.id], ex = p.x - p.w / 2, mx = (jA.x + ex) / 2;
      pAdv += 'M' + f(jA.x) + ' ' + f(jA.y) + ' C' + f(mx) + ' ' + f(jA.y) + ' ' + f(mx) + ' ' + f(p.y) + ' ' + f(ex) + ' ' + f(p.y) + ' ';
    });
    let pOps = 'M' + f(dx) + ' ' + f(B) + ' V' + f(jO.y) + ' ';
    ops.forEach((d) => { const p = pos[d.id]; pOps += elbow(jO.x, jO.y, p.x, p.y - p.h / 2); });
    let pWork = '';
    wks.forEach((d) => {
      const pp = pos[d.op], p = pos[d.id];
      pWork += elbow(pp.x, pp.y + pp.h / 2, p.x, p.y - p.h / 2);
    });
    const all = Object.keys(pos).map((k) => pos[k]);
    const minX = Math.min(dx - w / 2, ...all.map((p) => p.x - p.w / 2));
    const maxX = Math.max(R, ...all.map((p) => p.x + p.w / 2));
    const minY = Math.min(dy - h / 2, ...all.map((p) => p.y - p.h / 2)) - 34;
    const maxY = Math.max(B, ...all.map((p) => p.y + p.h / 2));
    const lab = (d) => ({ x: pos[d.id].x - pos[d.id].w / 2, y: pos[d.id].y - pos[d.id].h / 2 - 26 });
    const labels = [{ t: 'COORDINATOR', x: dx - w / 2, y: dy - h / 2 - 26, c: '#d97757', k: 'co' }];
    if (advs.length) labels.push(Object.assign({ t: 'ADVISORS', c: '#a78bfa', k: 'adv' }, lab(advs[0])));
    if (ops.length) labels.push(Object.assign({ t: 'OPERATORS', c: '#6cb6ff', k: 'ops' }, lab(ops[0])));
    if (wks.length) labels.push(Object.assign({ t: 'WORKERS', c: '#5fd0b5', k: 'work' }, lab(wks[0])));
    return { pAdv, pOps, pWork, tAdv, tOps, jA, jO, pos, labels, box: { minX, maxX, minY, maxY } };
  }
  fitTree() {
    if (!this.w || !this.h) return;
    const b = this.layout(this.state).box;
    const bw = b.maxX - b.minX, bh = b.maxY - b.minY;
    const z = Math.max(0.4, Math.min(1, Math.min((this.w - 80) / bw, (this.h - 120) / bh)));
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    this.camTarget = { x: -cx * z, y: -cy * z, z };
  }
  opt() {
    const p = this.props;
    return { color: p.rippleColor ?? '#ffffff', pulse: p.pulseRadius ?? 150, trail: p.trailSize ?? 34 };
  }
  rgb(hex) {
    const h = String(hex).replace('#', '');
    const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const n = parseInt(f.slice(0, 6), 16) || 0xffffff;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  attach() {
    const c = this.canvas;
    this.ctx = c.getContext('2d');
    this.resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const r = c.getBoundingClientRect();
      this.w = r.width; this.h = r.height;
      c.width = Math.max(1, Math.round(r.width * dpr));
      c.height = Math.max(1, Math.round(r.height * dpr));
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    this.onMove = (e) => {
      const r = c.getBoundingClientRect();
      this.mouse.tx = e.clientX - r.left;
      this.mouse.ty = e.clientY - r.top;
      if (this.mouse.on === 0) { this.mouse.x = this.mouse.tx; this.mouse.y = this.mouse.ty; }
      this.mouse.ton = 1;
      if (e.type === 'pointermove') {
        const now = performance.now();
        const x = this.mouse.tx, y = this.mouse.ty;
        const lp = this.lastPt;
        this.vel = this.vel || { x: 0, y: 0 };
        if (lp) {
          const dt = Math.max(8, now - lp.t);
          const vx = (x - lp.x) / dt, vy = (y - lp.y) / dt;
          this.vel.x += (vx - this.vel.x) * 0.35;
          this.vel.y += (vy - this.vel.y) * 0.35;
        }
        if (!lp || Math.hypot(x - lp.x, y - lp.y) > 3) {
          this.trail = (this.trail || []).concat([{ x, y, t: now, vx: this.vel.x, vy: this.vel.y }]).slice(-90);
          this.lastPt = { x, y, t: now };
        }
      }
    };
    this.onLeave = () => { this.mouse.ton = 0; };
    this.host = c.parentElement || c;
    this.host.addEventListener('pointermove', this.onMove);
    this.host.addEventListener('pointerdown', this.onMove);
    this.host.addEventListener('pointerleave', this.onLeave);
    const bump = () => this.setState({ camTick: (this.state.camTick || 0) + 1 });
    const pulseAt = (clientX, clientY) => {
      const r = c.getBoundingClientRect();
      this.waves = (this.waves || []).concat([{ kind: 'pulse', x: clientX - r.left, y: clientY - r.top, t0: performance.now(), life: 1900, rot: Math.random() * 6.28 }]).slice(-70);
    };
    // Background: any button drags the whole view. A left press that does not move is a click (ripple).
    this.onBgDown = (e) => {
      if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
      e.preventDefault();
      if (this.state.pop) this.setState({ pop: null });
      this.camTarget = null;
      this.pan = { sx: e.clientX, sy: e.clientY, x0: this.cam.x, y0: this.cam.y, left: e.button === 0, moved: e.button !== 0 };
      try { c.setPointerCapture(e.pointerId); } catch (_) {}
      if (this.pan.moved) this.setState({ panning: true });
    };
    this.onBgMove = (e) => {
      const p = this.pan; if (!p) return;
      if (e.buttons === 0) { this.onBgUp(e); return; }
      if (!p.moved) {
        if (Math.hypot(e.clientX - p.sx, e.clientY - p.sy) < 4) return;
        p.moved = true;
        this.setState({ panning: true });
      }
      this.cam.x = p.x0 + (e.clientX - p.sx);
      this.cam.y = p.y0 + (e.clientY - p.sy);
      bump();
    };
    this.onBgUp = (e) => {
      const p = this.pan;
      if (!p) return;
      this.pan = null;
      try { if (e && e.pointerId !== undefined && c.hasPointerCapture && c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId); } catch (_) {}
      if (p.left && !p.moved && e && e.type === 'pointerup') pulseAt(p.sx, p.sy);
      this.setState({ panning: false });
    };
    this.onWheel = (e) => {
      e.preventDefault();
      this.camTarget = null;
      const r = c.getBoundingClientRect();
      const px = e.clientX - r.left - r.width / 2;
      const py = e.clientY - r.top - r.height / 2;
      const z0 = this.cam.z;
      const unit = e.deltaMode === 1 ? 16 : 1;
      const z1 = Math.max(0.4, Math.min(4, z0 * Math.exp(-e.deltaY * unit * 0.0015)));
      const wx = (px - this.cam.x) / z0, wy = (py - this.cam.y) / z0;
      this.cam.x = px - wx * z1;
      this.cam.y = py - wy * z1;
      this.cam.z = z1;
      bump();
    };
    this.onDbl = () => { this.camTarget = null; this.cam = { x: 0, y: 0, z: 1 }; bump(); };
    c.addEventListener('pointerdown', this.onBgDown);
    c.addEventListener('pointermove', this.onBgMove);
    c.addEventListener('pointerup', this.onBgUp);
    c.addEventListener('pointercancel', this.onBgUp);
    c.addEventListener('lostpointercapture', this.onBgUp);
    this.onWinUp = (e) => { if (this.pan) this.onBgUp(e); if (this.drag) this.dragEnd(e); };
    window.addEventListener('pointerup', this.onWinUp);
    window.addEventListener('blur', this.onWinUp);
    c.addEventListener('wheel', this.onWheel, { passive: false });
    c.addEventListener('dblclick', this.onDbl);
    this.onCtx = (ev) => ev.preventDefault();
    c.addEventListener('contextmenu', this.onCtx);
    this.ro = new ResizeObserver(this.resize);
    this.ro.observe(c);
    this.resize();
    const loop = () => { this.draw(); this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
  }
  detach() {
    if (!this.canvas) return;
    cancelAnimationFrame(this.raf);
    if (this.ro) this.ro.disconnect();
    const host = this.host || this.canvas;
    host.removeEventListener('pointermove', this.onMove);
    host.removeEventListener('pointerdown', this.onMove);
    host.removeEventListener('pointerleave', this.onLeave);
    const c = this.canvas;
    c.removeEventListener('pointerdown', this.onBgDown);
    c.removeEventListener('pointermove', this.onBgMove);
    c.removeEventListener('pointerup', this.onBgUp);
    c.removeEventListener('pointercancel', this.onBgUp);
    c.removeEventListener('lostpointercapture', this.onBgUp);
    window.removeEventListener('pointerup', this.onWinUp);
    window.removeEventListener('blur', this.onWinUp);
    c.removeEventListener('wheel', this.onWheel);
    c.removeEventListener('dblclick', this.onDbl);
    c.removeEventListener('contextmenu', this.onCtx);
  }
  componentDidMount() {
    this.clockTimer = setInterval(() => this.setState({ now: Date.now() }), 5000);
    const be = this.backend;
    this.unsubscribe = be.orchestrator.onEvent((ev) => this.onEvent(ev));
    // 읽기 전용 상태(스모크 시험 app/main.js와 개발자 도구용).
    window.__terrariumDebug = () => ({
      coordSt: this.coordSt,
      sessions: this.defs.map((d) => ({ id: d.id, role: d.role, parent: d.op, label: d.label, model: d.model, on: !!(this.ns[d.id] || {}).on, st: (this.ns[d.id] || {}).st })),
      logs: this.logs.map((l) => l.t),
      cam: Object.assign({}, this.cam),
      win: { dx: this.state.dx, dy: this.state.dy, w: this.state.w, h: this.state.h },
      pop: this.state.pop, ws: this.state.ws.length, folder: this.state.folder,
      opPanels: Object.keys(this.opPanel).filter((k) => this.opPanel[k]),
      dragging: !!this.drag, panning: !!this.pan, term: this.termState,
      jev: { adv: Date.now() < this.jevUntil.adv, ops: Date.now() < this.jevUntil.ops }
    });
    // 사용량·계정·코디네이터 정보는 메인 프로세스가 실제로 읽은 것만 준다. 30초마다 다시 읽는다.
    const pull = () => {
      be.app.info().then((v) => { this.co = v; this.refresh(); });
      be.usage.get().then((v) => { this.usage = v; this.refresh(); });
      be.account.get().then((v) => { this.account = v; this.refresh(); });
    };
    pull();
    this.pullTimer = setInterval(pull, 30000);
    be.folders.list().then((r) => {
      if (!r) return;
      this.folderList = r.folders || [];
      let saved = [];
      try { saved = JSON.parse(localStorage.getItem('terrarium.tabs') || '[]'); } catch (_) { saved = []; }
      const known = new Set(this.folderList.map((f) => f.path));
      const paths = saved.filter((p) => known.has(p));
      if (r.current && !paths.includes(r.current)) paths.unshift(r.current);
      const ws = paths.map((p) => { this.wsSeq += 1; return { id: this.wsSeq, name: String(p).split(/[\\/]/).filter(Boolean).pop() || p, path: p }; });
      const active = ws.find((w) => w.path === r.current);
      this.setState({ ws, activeWs: active ? active.id : 0, folder: r.current || '', folderNote: r.current ? '' : '실행 폴더가 없습니다. 설정의 설치 탭에서 설치하거나 [다른 폴더 열기…]로 고르세요.' });
    });
  }
  componentWillUnmount() { if (this.unsubscribe) this.unsubscribe(); clearInterval(this.clockTimer); clearInterval(this.pullTimer); this.timers.forEach(clearTimeout); this.timers = []; this.detach(); this.canvas = null; }
  draw() {
    const ctx = this.ctx; if (!ctx) return;
    const o = this.opt();
    const m = this.mouse;
    m.x += (m.tx - m.x) * 0.18;
    m.y += (m.ty - m.y) * 0.18;
    m.on += (m.ton - m.on) * 0.08;
    const ct = this.camTarget;
    if (ct) {
      const cm = this.cam;
      cm.x += (ct.x - cm.x) * 0.1; cm.y += (ct.y - cm.y) * 0.1; cm.z += (ct.z - cm.z) * 0.1;
      if (Math.abs(ct.x - cm.x) < 0.5 && Math.abs(ct.y - cm.y) < 0.5 && Math.abs(ct.z - cm.z) < 0.002) {
        cm.x = ct.x; cm.y = ct.y; cm.z = ct.z; this.camTarget = null;
      }
      this.refresh();
    }
    // 그릴 것(파동, 마우스 자국, 움직임 고리)이 없으면 캔버스를 한 번 비운 뒤로는 매 프레임 다시 그리지 않는다.
    // 고리는 속도가 0.036을 넘어야, 자국은 점이 둘 이상이어야 보이므로 이 조건 밖에서는 그려지는 것이 없다.
    const v0 = this.vel;
    if (!(this.waves && this.waves.length) && !(this.trail && this.trail.length > 1) && !(v0 && Math.hypot(v0.x, v0.y) > 0.02)) {
      if (this.drawn) { ctx.clearRect(0, 0, this.w, this.h); this.drawn = false; }
      return;
    }
    this.drawn = true;
    ctx.clearRect(0, 0, this.w, this.h);
    const now = performance.now();
    const [r, g, b] = this.rgb(o.color);
    const col = (al) => 'rgba(' + r + ',' + g + ',' + b + ',' + Math.max(0, Math.min(1, al)).toFixed(3) + ')';
    const TAU = Math.PI * 2;
    const ring = (cx, cy, rad, a0, span, wob, ph) => {
      const n = Math.max(24, Math.round(rad * 0.6));
      ctx.beginPath();
      for (let k = 0; k <= n; k++) {
        const th = a0 + span * (k / n);
        const rr = rad * (1 + wob * Math.sin(5 * th + ph) + wob * 0.6 * Math.sin(3 * th - ph * 1.3));
        const x = cx + Math.cos(th) * rr, y = cy + Math.sin(th) * rr;
        if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };
    this.waves = (this.waves || []).filter((wv) => now - wv.t0 < wv.life);
    const vel = this.vel || { x: 0, y: 0 };
    vel.x *= 0.93; vel.y *= 0.93;
    const WL = 1100;
    this.trail = (this.trail || []).filter((q) => now - q.t < WL);
    const tr = this.trail;
    if (tr.length > 1) {
      const side = (sd, scale, amp) => {
        let prev = null;
        for (let i = tr.length - 1; i >= 0; i--) {
          const q = tr[i], age = now - q.t;
          const sp = Math.hypot(q.vx, q.vy);
          if (sp < 0.02) { prev = null; continue; }
          const nx = -q.vy / sp, ny = q.vx / sp;
          const spread = (12 + age * 0.075 * Math.min(1.6, sp)) * scale;
          const wob = Math.sin(age * 0.014 + sd * 1.7 + i * 0.35) * 2.2 * (age / WL);
          const back = age * 0.012;
          const pt = { x: q.x + nx * sd * (spread + wob) - (q.vx / sp) * back, y: q.y + ny * sd * (spread + wob) - (q.vy / sp) * back, a: Math.pow(1 - age / WL, 1.6) * Math.min(1, sp / 0.7) * amp };
          if (prev) {
            ctx.lineWidth = 1.2 * (0.4 + pt.a);
            ctx.strokeStyle = col(Math.min(prev.a, pt.a));
            ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(pt.x, pt.y); ctx.stroke();
          }
          prev = pt;
        }
      };
      side(-1, 1, 0.6); side(1, 1, 0.6);
      side(-1, 0.55, 0.28); side(1, 0.55, 0.28);
    }
    const spd = Math.hypot(vel.x, vel.y);
    const fv = Math.min(1, spd / 0.9);
    if (fv > 0.04 && m.on > 0.1) {
      const ang = Math.atan2(vel.y, vel.x);
      for (let k = 0; k < 3; k++) {
        const rad = 11 + k * 6 + fv * 8;
        const span = Math.PI * (0.42 - k * 0.05);
        ctx.lineWidth = 1.6 - k * 0.4;
        ctx.strokeStyle = col(fv * (0.8 - k * 0.24));
        const cx = m.tx - Math.cos(ang) * (4 + k * 7), cy = m.ty - Math.sin(ang) * (4 + k * 7);
        ring(cx, cy, rad, ang - span, span * 2, 0.035 * fv, now / 140 + k);
      }
    }
    for (const wv of this.waves) {
      const p = (now - wv.t0) / wv.life;
      const ph = (now - wv.t0) / 180;
      if (wv.kind === 'trail') {
        const e = 1 - Math.pow(1 - p, 2);
        ctx.lineWidth = 1;
        ctx.strokeStyle = col(0.5 * (1 - p) * wv.k);
        ring(wv.x, wv.y, 3 + e * o.trail * wv.k, 0, TAU, 0.04, ph);
      } else {
        const R = o.pulse, rings = 5;
        if (p < 0.22) {
          const sp = p / 0.22;
          ctx.fillStyle = col(0.35 * (1 - sp));
          ctx.beginPath(); ctx.arc(wv.x, wv.y, 4 + sp * 14, 0, TAU); ctx.fill();
        }
        for (let i = 0; i < rings; i++) {
          const lp = (p - i * 0.09) / 0.72;
          if (lp <= 0 || lp >= 1) continue;
          const e = 1 - Math.pow(1 - lp, 2.4);
          const rad = 5 + e * R * (1 - i * 0.11);
          const fade = Math.pow(1 - lp, 1.3) * (0.9 - i * 0.14);
          const wob = (0.045 - i * 0.006) * (1 - lp * 0.7);
          const phs = ph * 0.6 + wv.rot + i * 0.9;
          ctx.lineWidth = Math.max(0.6, (8 - i) * (1 - lp) * 0.9);
          ctx.strokeStyle = col(fade * 0.1);
          ring(wv.x, wv.y, Math.max(2, rad - 5 - i), 0, TAU, wob, phs);
          ctx.lineWidth = Math.max(0.5, (2.4 - i * 0.3) * (1 - lp * 0.8));
          ctx.strokeStyle = col(fade);
          ring(wv.x, wv.y, rad, 0, TAU, wob, phs);
        }
      }
    }
  }
  renderVals() {
    const s = this.state;
    const geo = this.layout(s);
    const roleColor = { adv: '#a78bfa', op: '#6cb6ff', wk: '#5fd0b5' };
    const roleBorder = { adv: 'rgba(167,139,250,0.5)', op: 'rgba(108,182,255,0.5)', wk: 'rgba(95,208,181,0.5)' };
    const stColor = { SPAWNING: '#8a877f', REVIEWING: '#f4d58d', WORKING: '#f4d58d', DONE: '#5fd0b5', ERROR: '#f07a73' };
    const act = { SPAWNING: '세션 시작 중…', REVIEWING: '계획 검토 중…', WORKING: '작업 중…', DONE: '✓ 완료 · 상위 세션에 보고', ERROR: '✗ 오류' };
    const task = this.task;
    const nodes = this.defs.map((d) => {
      const n = this.ns[d.id] || {};
      const p = geo.pos[d.id];
      const msg = d.task || task;
      const activity = n.out || act[n.st] || '';
      return {
        label: d.label, parent: d.role === 'wk' ? d.parent + ' · ' + this.modelInfo(this.modelKey(d)).name : d.parent, msg, activity,
        tap: this.nodeTap[d.id],
        x: Math.round(p.x), y: Math.round(p.y), w: p.w, h: p.h,
        op: n.on ? 1 : 0, sc: n.on ? 1 : 0.92, pe: n.on ? 'auto' : 'none',
        cur: s.nodeDrag === d.id ? 'grabbing' : 'grab', z: s.nodeDrag === d.id ? 5 : 1,
        grab: this.nodeGrab[d.id], rs: this.nodeRs[d.id], move: this.dragMove, end: this.dragEnd,
        color: roleColor[d.role], border: roleBorder[d.role],
        status: n.st || 'IDLE', stColor: stColor[n.st] || '#8a877f'
      };
    });
    const pillOf = (st) => ({
      WORKING: ['running', '#f0835f', 'rgba(217,119,87,0.16)'],
      REVIEWING: ['running', '#f0835f', 'rgba(217,119,87,0.16)'],
      SPAWNING: ['starting', '#f4d58d', 'rgba(244,213,141,0.12)'],
      DONE: ['done', '#5fd0b5', 'rgba(95,208,181,0.14)']
    }[st] || ['idle', '#8a877f', 'rgba(138,135,127,0.14)']);
    const mFlags = (key) => {
      const md = this.modelInfo(key);
      return { model: md.name, bg: md.bg, isCodex: md.k === 'codex', isGemini: md.k === 'gemini', isMuse: md.k === 'muse', isClaude: md.k === 'claude' };
    };
    const opPanels = this.defs.filter((d) => d.role === 'op' && this.opPanel[d.id] && (this.ns[d.id] || {}).on).map((opDef) => {
      const id = opDef.id;
      const pp = geo.pos[id];
      const ws = this.defs.filter((d) => d.role === 'wk' && d.op === id && (this.ns[d.id] || {}).on);
      let running = 0;
      const rows = ws.map((d) => {
        const st = (this.ns[d.id] || {}).st || '';
        const pl = st === 'ERROR' ? ['error', '#f07a73', 'rgba(240,122,115,0.14)'] : pillOf(st);
        if (pl[0] === 'running') running++;
        return Object.assign(mFlags(this.modelKey(d)), {
          sub: d.label + ' · ' + (d.task || ''),
          status: pl[0], pillC: pl[1], pillBg: pl[2]
        });
      });
      return {
        title: opDef.label.toUpperCase(),
        count: running + '/' + ws.length + ' running',
        x: Math.round(pp.x), y: Math.round(pp.y + pp.h / 2 + 10), w: Math.max(300, Math.round(pp.w)),
        rows,
        note: ws.length ? '모델은 하네스 라우팅(Jev)이 이슈마다 정합니다.' : '이 하달은 워커를 부르지 않았습니다.',
        close: () => { this.opPanel[id] = false; this.refresh(); }
      };
    });
    const groupLabels = geo.labels.map((l) => ({
      t: l.t, x: Math.round(l.x), y: Math.round(l.y), c: l.c,
      op: l.k === 'co' ? (task ? 1 : 0) : (this.links[l.k] ? 1 : 0)
    }));
    const jevNow = Date.now();
    const jev = (role, j, rgb, hex, rot) => {
      const on = jevNow < (this.jevUntil || {})[role];
      const shown = this.links[role] || on ? 1 : 0; // 세션이 사라진 뒤의 판정(리뷰어)도 보인다
      return {
        x: Math.round(j.x), y: Math.round(j.y), rot,
        op: shown ? (on ? 1 : 0.5) : 0, sc: on ? 1.12 : 1,
        bc: on ? hex : '#3a3935', c: on ? hex : '#6b6964',
        glow: on ? '0 0 0 4px rgba(' + rgb + ',0.16), 0 0 22px rgba(' + rgb + ',0.6)' : 'none',
        trunk: on ? 1 : 0, label: on ? 'active' : 'idle'
      };
    };
    const jevA = jev('adv', geo.jA, '167,139,250', '#a78bfa', 180);
    const jevO = jev('ops', geo.jO, '108,182,255', '#6cb6ff', -90);
    const coordColor = this.termState !== 'running' ? '#6b6964' : ({ READY: '#8a877f', THINKING: '#f4d58d', DELEGATING: '#f4d58d', DONE: '#5fd0b5', ERROR: '#f07a73' }[this.coordSt] || '#8a877f');
    const coordBusy = this.coordSt === 'THINKING' || this.coordSt === 'DELEGATING';
    const live = (coordBusy ? 1 : 0) + this.defs.filter((d) => { const n = this.ns[d.id]; return n && n.on && (n.st === 'SPAWNING' || n.st === 'REVIEWING' || n.st === 'WORKING'); }).length;
    const clock = new Date(s.now || Date.now()).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase().replace(' ', '');
    return {
      liveCount: live, liveDot: live > 0 ? '#5fd0b5' : '#6b6964', clock, jevA, jevO, opPanels,
      wsTabs: (s.ws || []).map((w) => {
        const on = w.id === s.activeWs;
        return {
          name: w.name, pressed: on ? 'true' : 'false',
          bg: on ? 'rgba(217,119,87,0.14)' : 'transparent', bc: on ? 'rgba(217,119,87,0.55)' : '#2e2d2a',
          c: on ? '#f3ebe6' : '#a8a59c', xc: on ? '#f07a73' : '#6b6964',
          select: () => this.selectWs(w.id), close: () => this.closeWs(w.id)
        };
      }),
      wsCount: (s.ws || []).length,
      addWs: this.addWs,
      folder: s.folder ? ((this.folderList.find((f) => f.path === s.folder) || { name: String(s.folder).split(/[\\/]/).filter(Boolean).pop() || s.folder }).name) : '실행 폴더 없음',
      folderPath: s.folder || '실행 폴더 없음',
      folderNote: s.folderNote || '실행 폴더 = 하네스가 설치된 폴더(harness.json). 일반 프로젝트를 고르면 설치할지 묻습니다.',
      folders: this.folderList.map((f) => ({
        name: f.name, path: f.path, current: f.path === s.folder,
        bg: f.path === s.folder ? 'rgba(217,119,87,0.12)' : 'transparent',
        pick: () => this.pickFolder(f)
      })),
      browseFolder: this.browseFolder,
      co: this.co, account: this.account,
      usageRows: this.usage.meters || [],
      usageTop: (() => {
        const m = (this.usage.meters || [])[0];
        const len = 2 * Math.PI * 9;
        if (!m) return { pct: '–', resetText: '사용량 모름', title: this.usage.note || '사용량을 아직 읽지 못했습니다', dash: '0 ' + len.toFixed(1) };
        const on = Math.max(0, Math.min(100, m.pct)) / 100 * len;
        return { pct: m.pct, resetText: m.resetText, title: m.label + ' ' + m.pct + '% · ' + m.resetText, dash: on.toFixed(1) + ' ' + (len - on).toFixed(1) };
      })(),
      usageNote: this.usage.note || '',
      accountNote: this.account.note || '',
      openSettings: this.openSettings, openAccounts: this.openAccounts, openProgress: this.openProgress, goHome: this.goHome,
      pop: { folder: s.pop === 'folder', settings: s.pop === 'settings', profile: s.pop === 'profile' },
      popL: Math.round(s.lpX + s.lpW + 8), popR: Math.round(s.rpR + s.rpW + 8),
      toggleFolder: this.toggleFolder, toggleSettings: this.toggleSettings, toggleProfile: this.toggleProfile, closePop: this.closePop,
      lpX: Math.round(s.lpX), lpY: Math.round(s.lpY), lpW: Math.round(s.lpW),
      rpR: Math.round(s.rpR), rpY: Math.round(s.rpY), rpW: Math.round(s.rpW),
      rpGrab: this.rpGrab, rpRs: this.rpRs, rpCursor: s.rpDrag ? 'grabbing' : 'grab',
      panelGrab: this.panelGrab, panelRs: this.panelRs, panelCursor: s.panelDrag ? 'grabbing' : 'grab',
      geo, nodes, groupLabels, logs: this.logs, linkOp: this.links,
      coordSt: this.termState === 'running' ? this.coordSt : (this.termState === 'ended' ? 'ENDED' : 'OFFLINE'), coordColor,
      // 터미널은 화면 배율을 되돌려 1배로 그린다(글자 선명, 마우스 선택 위치 맞음).
      setTermHost: this.setTermHost,
      termPct: (this.cam.z * 100).toFixed(3), termInv: (1 / this.cam.z).toFixed(5),
      lastLog: this.logs.length ? this.logs[this.logs.length - 1] : { t: '지시를 코디네이터 터미널에 치세요. 하달된 만큼만 아래에 Operator·Worker가 뜹니다.', c: '#8a877f' },
      setCanvas: this.setCanvas, background: this.props.background ?? '#0e0d0b',
      winDx: Math.round(s.dx), winDy: Math.round(s.dy), winW: Math.round(s.w), winH: Math.round(s.h),
      barCursor: s.dragging ? 'grabbing' : 'grab',
      bgCursor: s.panning ? 'grabbing' : 'default',
      stageTransform: 'translate(' + this.cam.x.toFixed(1) + 'px, ' + this.cam.y.toFixed(1) + 'px) scale(' + this.cam.z.toFixed(4) + ')',
      zoomPct: Math.round(this.cam.z * 100),
      grabBar: this.grabBar, rs: this.rs, dragMove: this.dragMove, dragEnd: this.dragEnd
    };
  }
}

DC.mount(Component, document.getElementById('screen'), document.getElementById('root'), {});
