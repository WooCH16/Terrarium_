// 관제탑 화면(app/tower)의 세션 흐름: 실행 폴더의 하네스 기록을 읽어 화면 이벤트로 바꾼다. 읽기만 한다.
// 화면은 이 이벤트로만 세션을 그린다(이벤트 모양은 docs/app-screen.md). 아무 CLI도 띄우지 않는다.
//
// 무엇을 세션으로 보나(실제로 호출된 것만, 미리 자리를 잡지 않는다):
//   어드바이저 = 코디네이터의 Agent 호출 한 줄(guard.log, agent_type 없음, tool_name Agent).
//                코디네이터는 advisor만 하위 에이전트로 부를 수 있다(policy.mjs). 그 뒤 agent_type advisor 줄이 그 일이다.
//                코디네이터가 Agent 아닌 도구를 다시 쓰면 그 전에 부른 어드바이저는 끝난 것이다(하위 에이전트가 돌아왔다).
//   오퍼레이터 = 하달 한 번(handoffs/h<N>, dispatch.json의 팀). 팀이 없는 옛 하달도 하달이면 보인다.
//   워커       = workers.jsonl의 start 한 줄(이슈 하나). 모델을 못 골라 end만 남은 이슈는 워커가 아니다.
// 그래서 하달하지 않은 팀의 오퍼레이터, 하달에 없는 이슈의 워커는 화면에 나오지 않는다.
// 일이 끝난 세션은 잠깐(lingerMs) ✓를 보인 뒤 사라진다(session.removed): 어드바이저는 조언이 Jev를 통과하면,
// 워커는 이슈가 끝나면, 오퍼레이터는 하달이 끝나고 그 워커가 다 사라지면. 오류로 끝난 세션은 남긴다. 다시 부르면 새로 뜬다.
// Jev 불빛(jev.active): 어드바이저 쪽은 조언 판정(run-reviewer --advice → advice-log), 오퍼레이터 쪽은 리뷰어 판정
// (코디네이터의 run-reviewer --issue, 다음 도구 사용까지)과 워커 모델 라우팅(workers.jsonl start, 잠깐).
//
// 한 번의 "실행"(화면의 run): 사용자가 코디네이터에 한 줄을 보냈을 때 도는 세션이 없으면 새로 시작한다(화면을 비운다).
// 사용자가 치지 않았는데 새 세션이 생기면(앱을 늦게 켰거나 코디네이터가 이어서 일함) 그때 시작한다.
// 기준점: 앱을 켤 때와 새 실행을 시작할 때, 그때까지 끝난 기록은 다시 그리지 않는다. 도는 하달은 이어서 그린다.
import { existsSync, readFileSync } from 'node:fs';
import { readHandoffs, pidAlive } from './status.mjs';

export const TEAM_NAMES = { dev: '개발', design: '디자인', tester: '테스터', plan: '기획', sec: '보안' };
const QUIET_MS = 20000; // 코디네이터가 이만큼 도구를 쓰지 않고 세션도 다 끝났으면 실행을 끝난 것으로 본다
const LINGER_MS = 5000; // 끝난 세션이 ✓를 보이고 사라지기까지

// 오퍼레이터 창 이름: 맡은 팀. 팀이 없는 하달은 조사·작업으로 부른다.
export function operatorLabel(team, research = false) {
  if (team) return `${TEAM_NAMES[team] ?? team} Operator`;
  return research ? '조사 Operator' : 'Operator';
}

const readLines = (file) => {
  if (!existsSync(file)) return [];
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const l of text.split(/\r?\n/)) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { out.push(null); } // 깨진 줄도 자리는 센다(줄 번호가 기준점이다)
  }
  return out;
};

// 실행 폴더의 지금 기록. alive는 시험에서 바꾼다.
export function readFlowSnapshot(run, { alive = pidAlive } = {}) {
  return {
    guard: readLines(`${run}/guard.log`),
    advice: readLines(`${run}/advice-log.jsonl`),
    handoffs: existsSync(`${run}/handoffs`) ? readHandoffs(run, alive) : [],
  };
}

const base = (p) => String(p ?? '').replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const num = (name) => Number(String(name).slice(1));

// 어드바이저 한 줄(도구 사용)을 짧은 활동 문장으로.
function advisorActivity(row) {
  const s = String(row.summary ?? '');
  if (row.tool_name === 'Bash' && /run-reviewer\.mjs/.test(s) && /--advice/.test(s)) return 'Jev 조언 판정 받는 중…';
  if (row.tool_name === 'Write' || row.tool_name === 'Edit') return `제안문 쓰는 중 · ${cut(base(s), 40)}`;
  if (row.tool_name === 'Read') return `읽는 중 · ${cut(base(s), 40)}`;
  if (row.tool_name === 'Glob' || row.tool_name === 'Grep') return '찾는 중…';
  return `${row.tool_name} 사용`;
}

// 코디네이터 한 줄 중 화면 기록에 남길 것(하네스 스크립트 실행).
function coordinatorNote(row) {
  const s = String(row.summary ?? '');
  const m = (re) => s.match(re);
  let x;
  if ((x = m(/run-reviewer\.mjs\s+--issue\s+(\d+)/))) return { text: `→ Jev 리뷰어 판정 · 이슈 #${x[1]}`, tone: 'info' };
  if ((x = m(/run-operator\.mjs\s+--issues\s+([\d,]+)/))) return { text: `→ 오퍼레이터 하달 · 이슈 ${x[1].split(',').map((n) => `#${n}`).join(', ')}`, tone: 'operator' };
  if (/run-research\.mjs/.test(s)) return { text: '→ 오퍼레이터 조사 하달', tone: 'operator' };
  if (/run-train\.mjs|merge-adapter/.test(s)) return { text: '→ 합치기(머지 트레인)', tone: 'info' };
  if (/gh issue create|create-issue/.test(s)) return { text: '→ 이슈 만들기', tone: 'info' };
  return null;
}

function workerStatus(w) {
  if (!w.done) return 'WORKING';
  return w.status === '완료' ? 'DONE' : 'ERROR';
}
function operatorStatus(h) {
  if (h.running) return 'WORKING';
  if (h.stopped || h.orphaned) return 'ERROR';
  if (h.endedAt || h.dispatch?.endedAt) return h.dispatch?.sessionOk === false ? 'ERROR' : 'DONE';
  return 'SPAWNING';
}

export class FlowTracker {
  // emit(event): 화면에 이벤트 하나를 보낸다. now: 시험에서 바꾼다.
  constructor({ emit, now = () => Date.now(), quietMs = QUIET_MS, lingerMs = LINGER_MS }) {
    this.emit = emit;
    this.now = now;
    this.quietMs = quietMs;
    this.lingerMs = lingerMs;
    this.seq = 0;
    this.runId = null;
    this.mark = null; // 기준점 { guard, advice, done: Set<하달 이름> }
    this.sessions = new Map(); // id → { role, status, out, parentId, doneAt }
    this.gone = new Set(); // 끝나서 사라진 세션 id(같은 기록으로 다시 띄우지 않는다)
    this.spawned = 0; // 이번 실행에서 띄운 세션 수(사라진 것 포함)
    this.jev = { adv: false, ops: false };
    this.infos = new Map(); // id → 화면에 보낸 세션 정보(다시 보낼 때 쓴다)
    this.advisors = []; // 이번 실행의 어드바이저 id(호출 순서)
    this.pendingAdvisors = []; // 아직 끝나지 않은 어드바이저 id
    this.advisorSeenSinceSpawn = false;
    this.lastCoordinatorAt = 0;
    this.status = 'READY';
    this.finished = false;
    this.snapshot = null;
  }

  // 실행 폴더를 (다시) 고를 때: 지금까지 끝난 기록을 기준점으로 삼고 화면을 비운다.
  reset(snapshot) {
    this.snapshot = snapshot;
    this.mark = this.markOf(snapshot, { keepRunning: true });
    this.runId = null;
    this.clearRun();
    this.setStatus('READY');
  }

  markOf(snapshot, { keepRunning }) {
    const done = new Set(snapshot.handoffs.filter((h) => !(keepRunning && h.running)).map((h) => h.name));
    return { guard: snapshot.guard.length, advice: snapshot.advice.length, done };
  }

  clearRun() {
    this.sessions = new Map();
    this.infos = new Map();
    this.gone = new Set();
    this.spawned = 0;
    this.jev = { adv: false, ops: false };
    this.advisors = [];
    this.pendingAdvisors = [];
    this.advisorSeenSinceSpawn = false;
    this.finished = false;
  }

  send(type, payload = {}) { this.emit({ type, runId: this.runId, ...payload }); }
  // Jev 불빛. ms가 있으면 그만큼만 켰다가 저절로 꺼진다(화면이 끈다).
  jevOn(side, ms) {
    this.ensureRun();
    if (ms) { this.send('jev.active', { side, on: true, ms }); return; }
    if (this.jev[side]) return;
    this.jev[side] = true;
    this.send('jev.active', { side, on: true });
  }
  jevOff(side) {
    if (!this.jev[side]) return;
    this.jev[side] = false;
    this.send('jev.active', { side, on: false });
  }
  log(text, tone = 'info') { this.send('coordinator.log', { text, tone }); }
  setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    if (this.runId) this.send('coordinator.status', { status: s });
  }

  active() { return [...this.sessions.values()].some((s) => s.status === 'SPAWNING' || s.status === 'WORKING' || s.status === 'REVIEWING'); }

  startRun(text) {
    this.runId = `run-${++this.seq}`;
    this.text = text;
    this.clearRun();
    this.status = 'READY';
    this.send('run.started', { text });
    if (text) this.log(`❯ ${text}`, 'user');
    this.setStatus('THINKING');
  }

  // 사용자가 코디네이터에 한 줄을 보냈다. 도는 세션이 있으면 같은 실행으로 이어 간다(화면을 비우지 않는다).
  userLine(text) {
    const t = cut(String(text ?? '').trim(), 120);
    if (!t) return;
    if (this.runId && this.active()) { this.log(`❯ ${t}`, 'user'); this.setStatus(this.status === 'DONE' ? 'THINKING' : this.status); return; }
    if (this.snapshot) this.mark = this.markOf(this.snapshot, { keepRunning: true });
    this.startRun(t);
    this.lastCoordinatorAt = this.now();
  }

  ensureRun() { if (!this.runId) this.startRun(''); }

  spawn(session, status, out) {
    this.ensureRun();
    this.sessions.set(session.id, { role: session.role, status: 'SPAWNING', out: '', parentId: session.parentId ?? null, doneAt: 0 });
    this.infos.set(session.id, session);
    this.spawned += 1;
    this.send('session.spawned', { session });
    if (status && status !== 'SPAWNING') this.setSession(session.id, status);
    if (out) this.output(session.id, out);
  }
  setSession(id, status) {
    const s = this.sessions.get(id);
    if (!s || s.status === status) return;
    s.status = status;
    s.out = '';
    s.doneAt = status === 'DONE' ? this.now() : 0;
    // 세션이 끝난 때부터 잠잠함을 센다: 하달 동안 코디네이터는 run-operator를 기다리느라 도구를 쓰지 않는다.
    if (status === 'DONE' || status === 'ERROR') this.lastCoordinatorAt = Math.max(this.lastCoordinatorAt, this.now());
    this.send('session.status', { id, status });
  }
  output(id, text) {
    const s = this.sessions.get(id);
    if (!s || s.out === text) return;
    s.out = text;
    this.send('session.output', { id, text });
  }

  // 새 기록을 읽을 때마다 부른다.
  update(snapshot) {
    this.snapshot = snapshot;
    if (!this.mark) { this.reset(snapshot); return; }
    // 기록 파일이 줄었으면(지우거나 새로 만듦) 처음부터 센다.
    if (snapshot.guard.length < this.mark.guard) this.mark.guard = 0;
    if (snapshot.advice.length < this.mark.advice) this.mark.advice = 0;

    // ---- guard.log: 코디네이터·어드바이저의 도구 사용 ----
    const rows = snapshot.guard.slice(this.mark.guard);
    this.mark.guard = snapshot.guard.length;
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const t = Date.parse(row.time) || this.now();
      if (row.agent_type === 'advisor') {
        this.advisorSeenSinceSpawn = true;
        const reviewing = /Jev 조언 판정/.test(advisorActivity(row));
        if (reviewing) this.jevOn('adv');
        for (const id of this.pendingAdvisors) {
          this.setSession(id, reviewing ? 'REVIEWING' : 'WORKING');
          this.output(id, advisorActivity(row));
        }
        continue;
      }
      if (row.agent_type) continue; // 다른 하위 에이전트(없어야 한다)
      this.lastCoordinatorAt = Math.max(this.lastCoordinatorAt, t);
      this.jevOff('ops'); // 리뷰어 판정은 코디네이터가 다음 도구를 쓸 때 끝나 있다
      if (row.tool_name === 'Agent' || row.tool_name === 'Task') {
        // 같은 차례에 여러 번 부르면(병렬) 앞의 어드바이저는 아직 돈다. 그 사이 어드바이저 일이 있었으면 앞의 것은 끝났다.
        if (this.advisorSeenSinceSpawn) this.finishAdvisors();
        if (row.allow === false) continue;
        const k = this.advisors.length + 1;
        const id = `adv-${k}`;
        const what = String(row.summary ?? '').trim();
        this.spawn({ id, role: 'advisor', parentId: null, label: `Advisor ${k}`, model: 'claude', task: what ? cut(what, 90) : '조언·제안문 작성' });
        if (k === 1 || !this.pendingAdvisors.length) this.log(`→ Advisor 호출${what ? ` · ${cut(what, 50)}` : ''}`, 'advisor');
        this.advisors.push(id);
        this.pendingAdvisors.push(id);
        this.advisorSeenSinceSpawn = false;
        continue;
      }
      if (this.pendingAdvisors.length) this.finishAdvisors();
      const note = row.allow === false ? null : coordinatorNote(row);
      if (note) { this.ensureRun(); this.log(note.text, note.tone); }
      if (row.allow !== false && /run-reviewer\.mjs\s+--issue/.test(String(row.summary ?? ''))) this.jevOn('ops');
    }

    // ---- advice-log.jsonl: Jev의 조언 판정 ----
    const verdicts = snapshot.advice.slice(this.mark.advice);
    this.mark.advice = snapshot.advice.length;
    for (const v of verdicts) {
      if (!v || typeof v !== 'object') continue;
      this.ensureRun();
      const ok = v.verdict === '허용';
      this.jevOn('adv');
      this.log(`${ok ? '←' : '✗'} Jev 조언 판정: ${v.verdict ?? '?'} · ${cut(String(v.adviceId ?? ''), 30)}`, ok ? 'advisor' : 'error');
      this.jevOff('adv');
      const id = this.pendingAdvisors[this.pendingAdvisors.length - 1] ?? this.advisors[this.advisors.length - 1];
      if (id && this.sessions.has(id)) {
        this.output(id, `Jev 판정: ${v.verdict ?? '?'}`);
        // 조언이 통과하면 그 어드바이저는 할 일이 없다: 끝내고(잠시 뒤 사라짐) 기다리는 목록에서 뺀다.
        if (ok) { this.setSession(id, 'DONE'); this.output(id, '✓ 조언 통과 · 코디네이터에 넘김'); this.pendingAdvisors = this.pendingAdvisors.filter((x) => x !== id); }
      }
    }

    // ---- handoffs: 오퍼레이터와 워커 ----
    const hs = snapshot.handoffs.filter((h) => !this.mark.done.has(h.name)).sort((a, b) => num(a.name) - num(b.name));
    for (const h of hs) {
      const opId = `op-${h.name}`;
      if (this.gone.has(opId)) continue; // 끝나서 사라진 하달
      const team = h.team ?? h.dispatch?.team ?? null;
      const research = (h.mode ?? h.dispatch?.mode) === 'research';
      // 하달 직후에는 dispatch.json의 live가 아직 null이다(이슈를 거르는 중). 그때는 요청된 이슈를 보인다(run-18 h26에서 "이슈 없음"으로 뜸).
      const issues = h.dispatch?.live ?? (h.dispatch?.requested?.length ? h.dispatch.requested : h.issues) ?? [];
      const out = (h.dispatch?.excluded ?? []).map((x) => `#${x.issue} 빠짐(${x.reason})`);
      const list = [...issues.map((n) => `#${n}`), ...out].join(', ') || '없음';
      if (!this.sessions.has(opId)) {
        const label = operatorLabel(team, research);
        this.spawn({ id: opId, role: 'operator', parentId: null, label, team, handoff: h.name, model: 'claude', task: `${h.name} ${research ? '조사' : '작업'} 하달 · 이슈 ${list}` });
        this.log(`→ ${label} · ${h.name} 하달 · 이슈 ${list}`, 'operator');
      }
      const workers = h.workers ?? [];
      for (const w of workers) {
        const wid = `wk-${h.name}-${w.issue}`;
        if (this.gone.has(wid)) continue;
        if (!this.sessions.has(wid)) {
          this.jevOn('ops', 2500); // 워커 모델은 Jev 라우팅이 골랐다
          this.spawn({ id: wid, role: 'worker', parentId: opId, label: `Worker #${w.issue}`, model: w.model ?? 'claude', task: `이슈 #${w.issue}` }, 'WORKING');
          this.log(`→ Worker #${w.issue} 호출 · ${w.model ?? '모델 모름'}`, 'worker');
        }
        const ws = workerStatus(w);
        const before = this.sessions.get(wid).status;
        this.setSession(wid, ws);
        if (ws !== before && ws !== 'WORKING') this.log(`${ws === 'DONE' ? '←' : '✗'} Worker #${w.issue} ${w.status ?? ''}${w.attempts ? ` · ${w.attempts}회` : ''}`, ws === 'DONE' ? 'worker' : 'error');
      }
      const os = operatorStatus(h);
      const before = this.sessions.get(opId).status;
      this.setSession(opId, os);
      const n = workers.length;
      const doneN = workers.filter((w) => w.done).length;
      if (os === 'WORKING') this.output(opId, n ? `→ Worker ${n}명 호출 · ${doneN}명 끝남` : '이슈를 살피는 중…');
      else if (os === 'DONE') this.output(opId, n ? `✓ 완료 · Worker ${n}명 결과 보고` : '✓ 완료 · 워커 없이 끝남');
      else if (os === 'ERROR') this.output(opId, h.stopped ? '✗ 멈춤(stop-operator)' : h.orphaned ? '✗ 끊김(프로세스 없음)' : '✗ 세션 실패');
      if (os !== before && (os === 'DONE' || os === 'ERROR')) this.log(`${os === 'DONE' ? '←' : '✗'} ${h.name} 하달 끝 · 워커 ${n}명`, os === 'DONE' ? 'operator' : 'error');
    }

    this.sweep();

    // ---- 코디네이터 상태 ----
    if (!this.runId) return;
    if (this.active()) { this.finished = false; this.setStatus('DELEGATING'); return; }
    const quiet = this.now() - this.lastCoordinatorAt > this.quietMs;
    if (this.spawned === 0) {
      // 하위 세션 없이 끝난 차례(질문에 답하기 등): 코디네이터가 잠잠해지면 대기로 돌아간다.
      this.setStatus(quiet ? 'READY' : 'THINKING');
    } else if (quiet) {
      this.setStatus('DONE');
      if (!this.finished) {
        this.finished = true;
        const errors = [...this.sessions.values()].filter((s) => s.status === 'ERROR').length;
        this.log(errors ? `✗ 하위 세션 ${errors}개가 오류로 끝남` : '✓ 모든 하위 세션 완료', errors ? 'error' : 'success');
        this.jevOff('adv');
        this.jevOff('ops');
        this.send('run.finished', { ok: true });
      }
    } else {
      this.setStatus('THINKING'); // 하위 세션은 끝났고 코디네이터가 아직 일한다(판정·합치기·보고)
    }
  }

  // 끝나고 lingerMs가 지난 세션을 화면에서 뺀다. 오퍼레이터는 그 워커가 다 사라진 뒤에(오류 워커가 있으면 남는다).
  sweep() {
    const now = this.now();
    const ripe = (s) => s.status === 'DONE' && now - s.doneAt >= this.lingerMs;
    const remove = (id) => { this.sessions.delete(id); this.infos.delete(id); this.gone.add(id); this.send('session.removed', { id }); };
    for (const [id, s] of [...this.sessions]) if (s.role !== 'operator' && ripe(s)) remove(id);
    for (const [id, s] of [...this.sessions]) {
      if (s.role !== 'operator' || !ripe(s)) continue;
      if ([...this.sessions.values()].some((c) => c.parentId === id)) continue;
      remove(id);
    }
  }

  finishAdvisors() {
    for (const id of this.pendingAdvisors) this.setSession(id, 'DONE');
    if (this.pendingAdvisors.length) this.log(`← Advisor ${this.pendingAdvisors.length}개 끝 · 코디네이터가 이어 감`, 'advisor');
    this.pendingAdvisors = [];
    this.advisorSeenSinceSpawn = false;
  }

  // 화면을 새로 읽었을 때(창을 다시 읽음): 지금 실행의 세션과 상태를 그대로 다시 보낸다.
  replay() {
    if (!this.runId) return;
    const send = (type, payload) => this.emit({ type, runId: this.runId, ...payload });
    send('run.started', { text: this.text ?? '' });
    send('coordinator.status', { status: this.status });
    for (const [id, s] of this.sessions) {
      send('session.spawned', { session: this.infos.get(id) });
      if (s.status !== 'SPAWNING') send('session.status', { id, status: s.status });
      if (s.out) send('session.output', { id, text: s.out });
    }
    for (const side of ['adv', 'ops']) if (this.jev[side]) send('jev.active', { side, on: true });
  }
}
