// 관제탑 세션 흐름(app/lib/flow.mjs) 시험. 기록은 하네스의 기록 함수(writeDispatch, logWorker)로 쓴다: 기록 모양이 바뀌면 여기서 걸린다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { FlowTracker, readFlowSnapshot } from '../lib/flow.mjs';
import { writeDispatch } from '../../harness/operator/run-operator.mjs';
import { logWorker } from '../../harness/operator/run-worker.mjs';

const fwd = (p) => p.split(String.fromCharCode(92)).join('/');
const made = [];
after(() => { for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 무시 */ } } });
function makeRun() {
  const run = fwd(mkdtempSync(`${fwd(tmpdir())}/flow-`));
  made.push(run);
  mkdirSync(`${run}/handoffs`, { recursive: true });
  writeFileSync(`${run}/harness.json`, JSON.stringify({ designatedRepo: 'o/r' }));
  return run;
}
const iso = (t) => new Date(t).toISOString();
const T0 = Date.parse('2026-11-24T01:00:00Z');
function harnessOf(run, clock) {
  const at = () => new Date(clock.t);
  return {
    guard: (row) => appendFileSync(`${run}/guard.log`, `${JSON.stringify({ time: iso(clock.t), agent_type: null, allow: true, reason: '허용', summary: '', ...row })}\n`),
    advice: (v) => appendFileSync(`${run}/advice-log.jsonl`, `${JSON.stringify({ time: iso(clock.t), adviceId: 'a1', verdict: v })}\n`),
    dispatch: (h, data) => { mkdirSync(`${run}/handoffs/${h}`, { recursive: true }); writeDispatch(run, h, { mode: 'work', excluded: [], base: null, startedAt: iso(clock.t), endedAt: null, sessionOk: null, rows: null, ...data }); },
    session: (h, data) => { mkdirSync(`${run}/handoffs/${h}`, { recursive: true }); writeFileSync(`${run}/handoffs/${h}/session.json`, JSON.stringify({ mode: 'work', pids: [], startedAt: iso(clock.t), ...data })); },
    worker: (h, entry) => logWorker(run, h, entry, at),
  };
}
function tracker(run, clock, alive) {
  const events = [];
  const f = new FlowTracker({ emit: (e) => events.push(e), now: () => clock.t, quietMs: 5000 });
  const tick = () => f.update(readFlowSnapshot(run, { alive }));
  return { f, events, tick };
}
const spawned = (events) => events.filter((e) => e.type === 'session.spawned').map((e) => e.session);
const lastStatus = (events, id) => events.filter((e) => e.type === 'session.status' && e.id === id).at(-1)?.status;

test('흐름: 하달한 팀의 오퍼레이터와 하달 이슈의 워커만 뜬다(어드바이저 1, 개발 하달 워커 2, 테스터 하달 워커 0)', () => {
  const run = makeRun();
  const clock = { t: T0 };
  const H = harnessOf(run, clock);
  const alivePids = new Set([42]);
  const { f, events, tick } = tracker(run, clock, (p) => alivePids.has(p));
  f.reset(readFlowSnapshot(run));
  f.userLine('정렬 기능 만들어줘');
  assert.equal(events[0].type, 'run.started');
  assert.equal(events[0].text, '정렬 기능 만들어줘');

  H.guard({ tool_name: 'Agent', summary: '작업 나누기 조언' });
  tick();
  H.guard({ agent_type: 'advisor', tool_name: 'Bash', summary: 'node h/operator/run-reviewer.mjs --advice r/reviewer-inbox/a.md --advice-id a1' });
  tick();
  assert.equal(lastStatus(events, 'adv-1'), 'REVIEWING', 'Jev 조언 판정을 받는 동안');
  H.advice('허용');
  H.guard({ tool_name: 'Bash', summary: 'node h/operator/run-operator.mjs --issues 11,12' });
  // 하달 직후: live는 아직 null(run-operator가 이슈를 거르는 중). 창의 할 일에는 요청된 이슈가 보여야 한다
  H.dispatch('h1', { team: 'dev', requested: [11, 12], live: null });
  tick();
  assert.match(spawned(events).find((x) => x.id === 'op-h1').task, /#11, #12/);
  H.dispatch('h1', { team: 'dev', requested: [11, 12], live: [11, 12] });
  H.session('h1', { pid: 42, issues: [11, 12] });
  tick();
  assert.equal(lastStatus(events, 'adv-1'), 'DONE', '코디네이터가 다른 도구를 쓰면 어드바이저는 돌아온 것');
  assert.equal(lastStatus(events, 'op-h1'), 'WORKING');
  H.worker('h1', { event: 'start', issue: 11, model: 'claude' });
  H.worker('h1', { event: 'start', issue: 12, model: 'gemini' });
  tick();
  assert.equal(f.status, 'DELEGATING');
  H.worker('h1', { event: 'end', issue: 11, status: '완료', attempts: 1, model: 'claude' });
  H.worker('h1', { event: 'end', issue: 12, status: '막힘', attempts: 3, model: 'gemini' });
  H.session('h1', { pid: 42, issues: [11, 12], endedAt: iso(clock.t) });
  H.dispatch('h1', { team: 'dev', requested: [11, 12], live: [11, 12], endedAt: iso(clock.t), sessionOk: true });
  H.dispatch('h2', { team: 'tester', requested: [13], live: [], excluded: [{ issue: 13, reason: '대기' }], endedAt: iso(clock.t) });
  tick();
  const s = spawned(events);
  assert.deepEqual(s.map((x) => [x.id, x.role, x.parentId]), [
    ['adv-1', 'advisor', null],
    ['op-h1', 'operator', null],
    ['wk-h1-11', 'worker', 'op-h1'],
    ['wk-h1-12', 'worker', 'op-h1'],
    ['op-h2', 'operator', null],
  ]);
  assert.equal(s[1].label, '개발 Operator', '오퍼레이터 이름은 맡은 팀');
  assert.equal(s[4].label, '테스터 Operator');
  assert.equal(s[1].handoff, 'h1');
  assert.deepEqual([s[2].model, s[3].model], ['claude', 'gemini'], '모델은 하네스 기록 그대로');
  assert.deepEqual(['wk-h1-11', 'wk-h1-12', 'op-h1', 'op-h2'].map((id) => lastStatus(events, id)), ['DONE', 'ERROR', 'DONE', 'DONE']);
  assert.match(events.filter((e) => e.type === 'session.output' && e.id === 'op-h2').at(-1).text, /워커 없이/);
  // 코디네이터가 잠잠해지면 실행이 끝난다(한 번만 알린다)
  clock.t += 6000;
  tick(); tick();
  assert.equal(f.status, 'DONE');
  assert.equal(events.filter((e) => e.type === 'run.finished').length, 1);
  // 끝난 세션은 잠시 뒤 사라진다. 오류 워커(#12)와 그 오퍼레이터(h1)는 남는다.
  const removed = events.filter((e) => e.type === 'session.removed').map((e) => e.id).sort();
  assert.deepEqual(removed, ['adv-1', 'op-h2', 'wk-h1-11']);
  // Jev 불빛: 조언 판정 동안 어드바이저 쪽, 워커 라우팅 때 오퍼레이터 쪽
  const jev = events.filter((e) => e.type === 'jev.active').map((e) => `${e.side}:${e.on}${e.ms ? `:${e.ms}` : ''}`);
  assert.deepEqual(jev.slice(0, 2), ['adv:true', 'adv:false']);
  assert.ok(jev.includes('ops:true:2500'), jev.join(' '));
  assert.ok(events.every((e) => e.runId === events[0].runId), '한 실행의 이벤트는 같은 runId');
});

test('흐름: 앱을 켜기 전에 끝난 하달은 다시 그리지 않고, 도는 하달은 이어서 그린다', () => {
  const run = makeRun();
  const clock = { t: T0 };
  const H = harnessOf(run, clock);
  H.dispatch('h1', { team: 'dev', requested: [1], live: [1], endedAt: iso(T0) });
  H.session('h1', { pid: 7, issues: [1], endedAt: iso(T0) });
  H.worker('h1', { event: 'start', issue: 1, model: 'claude' });
  H.dispatch('h2', { team: 'sec', requested: [2], live: [2] });
  H.session('h2', { pid: 8, issues: [2] });
  H.guard({ tool_name: 'Agent' });
  const { f, events, tick } = tracker(run, clock, (p) => p === 8);
  f.reset(readFlowSnapshot(run, { alive: (p) => p === 8 }));
  tick();
  assert.deepEqual(spawned(events).map((x) => x.id), ['op-h2'], '끝난 h1과 앞서 끝난 어드바이저는 없다');
  assert.equal(events[0].type, 'run.started', '사용자가 치지 않아도 새 세션이 생기면 실행을 연다');
});

test('흐름: 하위 세션 없이 답한 차례는 세션 0, 잠잠해지면 READY. 새로 친 줄은 화면을 비우지 않는다', () => {
  const run = makeRun();
  const clock = { t: T0 };
  const H = harnessOf(run, clock);
  const { f, events, tick } = tracker(run, clock, (p) => p === 5);
  f.reset(readFlowSnapshot(run));
  f.userLine('지금 상태 알려줘');
  H.guard({ tool_name: 'Read', summary: 'harness.json' });
  tick();
  assert.equal(f.status, 'THINKING');
  clock.t += 6000;
  tick();
  assert.equal(f.status, 'READY');
  assert.equal(spawned(events).length, 0);
  // 하달이 도는 중에 사용자가 답을 치면 같은 실행으로 이어 간다
  f.userLine('하달해줘');
  H.dispatch('h1', { team: 'plan', requested: [3], live: [3] });
  H.session('h1', { pid: 5, issues: [3] });
  tick();
  const runs = events.filter((e) => e.type === 'run.started').length;
  f.userLine('응 계속');
  tick();
  assert.equal(runs, 1, '대기 상태에서 친 새 지시도 새 실행을 열지 않는다(화면을 비우지 않음)');
  assert.equal(events.filter((e) => e.type === 'run.started').length, runs, '도는 하달이 있을 때도 마찬가지');
  assert.ok(events.some((e) => e.type === 'coordinator.log' && e.text === '❯ 응 계속'));
});

test('흐름: 멈춘 하달·끊긴 하달은 오류, 같은 차례에 병렬로 부른 어드바이저는 둘 다 돌다가 함께 끝난다', () => {
  const run = makeRun();
  const clock = { t: T0 };
  const H = harnessOf(run, clock);
  const { f, events, tick } = tracker(run, clock, () => false);
  f.reset(readFlowSnapshot(run));
  f.userLine('두 갈래 조언 받아줘');
  H.guard({ tool_name: 'Agent', summary: 'A' });
  H.guard({ tool_name: 'Agent', summary: 'B' });
  H.guard({ agent_type: 'advisor', tool_name: 'Read', summary: 'x/a.md' });
  tick();
  assert.deepEqual(['adv-1', 'adv-2'].map((id) => lastStatus(events, id)), ['WORKING', 'WORKING']);
  H.guard({ tool_name: 'Read', summary: 'y' });
  H.dispatch('h1', { team: 'dev', requested: [1], live: [1] });
  H.session('h1', { pid: 99, issues: [1] }); // 프로세스가 없다: 끊김
  mkdirSync(`${run}/handoffs/h2`, { recursive: true });
  H.dispatch('h2', { team: 'tester', requested: [2], live: [2] });
  H.session('h2', { pid: 98, issues: [2], endedAt: iso(T0), stoppedAt: iso(T0) });
  writeFileSync(`${run}/handoffs/h2/stopped.json`, '{}');
  tick();
  assert.deepEqual(['adv-1', 'adv-2', 'op-h1', 'op-h2'].map((id) => lastStatus(events, id)), ['DONE', 'DONE', 'ERROR', 'ERROR']);
  // 다시 읽은 화면에는 지금 세션과 상태를 그대로 다시 보낸다
  const before = events.length;
  f.replay();
  const again = events.slice(before);
  assert.equal(again[0].type, 'run.started');
  assert.deepEqual(spawned(again).map((x) => x.id), ['adv-1', 'adv-2', 'op-h1', 'op-h2']);
});

test('흐름: 조언이 Jev를 통과하면 어드바이저는 사라지고, 다시 부르면 새로 뜬다. 리뷰어 판정 동안 오퍼레이터 쪽 Jev가 켜진다', () => {
  const run = makeRun();
  const clock = { t: T0 };
  const H = harnessOf(run, clock);
  const { f, events, tick } = tracker(run, clock, () => false);
  f.reset(readFlowSnapshot(run));
  f.userLine('조언 받고 리뷰해줘');
  H.guard({ tool_name: 'Agent', summary: '첫 조언' });
  H.guard({ agent_type: 'advisor', tool_name: 'Bash', summary: 'node h/operator/run-reviewer.mjs --advice a.md --advice-id a1' });
  tick();
  assert.equal(lastStatus(events, 'adv-1'), 'REVIEWING');
  H.advice('허용');
  tick();
  assert.equal(lastStatus(events, 'adv-1'), 'DONE', '조언이 통과하면 끝');
  clock.t += 4000;
  tick();
  assert.ok(!events.some((e) => e.type === 'session.removed'), '잠깐은 ✓를 보인다');
  clock.t += 2000;
  tick();
  assert.deepEqual(events.filter((e) => e.type === 'session.removed').map((e) => e.id), ['adv-1']);
  H.guard({ tool_name: 'Agent', summary: '두 번째 조언' });
  tick();
  assert.deepEqual(spawned(events).map((x) => x.id), ['adv-1', 'adv-2'], '다시 부르면 새 어드바이저가 뜬다');
  H.guard({ tool_name: 'Bash', summary: 'node h/operator/run-reviewer.mjs --issue 7' });
  tick();
  const jev = () => events.filter((e) => e.type === 'jev.active' && e.side === 'ops').map((e) => e.on);
  assert.deepEqual(jev(), [true], '리뷰어 판정 중');
  H.guard({ tool_name: 'Bash', summary: 'git status' });
  tick();
  assert.deepEqual(jev(), [true, false], '코디네이터가 다음 도구를 쓰면 판정은 끝');
});

test('흐름: 새 지시가 와도 남은 세션은 그대로 있고, 새 세션만 더해진다(오류 창 유지, 어드바이저 번호 이어 감)', () => {
  const run = makeRun();
  const clock = { t: T0 };
  const H = harnessOf(run, clock);
  const { f, events, tick } = tracker(run, clock, () => false);
  f.reset(readFlowSnapshot(run));
  f.userLine('첫 지시');
  H.guard({ tool_name: 'Agent', summary: '조언' });
  H.guard({ tool_name: 'Bash', summary: 'node h/operator/run-operator.mjs --issues 1' });
  H.dispatch('h1', { team: 'dev', requested: [1], live: [1], endedAt: iso(clock.t), sessionOk: true });
  H.worker('h1', { event: 'start', issue: 1, model: 'claude' });
  H.worker('h1', { event: 'end', issue: 1, status: '막힘', attempts: 3, model: 'claude' });
  tick();
  clock.t += 6000;
  tick();
  assert.equal(f.status, 'DONE');
  const removedBefore = events.filter((e) => e.type === 'session.removed').map((e) => e.id);
  assert.deepEqual(removedBefore, ['adv-1'], '오류 워커와 그 오퍼레이터는 남는다');
  const n = events.length;
  f.userLine('두 번째 지시');
  H.guard({ tool_name: 'Agent', summary: '두 번째 조언' });
  tick();
  const after = events.slice(n);
  assert.ok(!after.some((e) => e.type === 'run.started' || e.type === 'session.removed'), '화면을 비우지도, 남은 창을 빼지도 않는다');
  assert.deepEqual(spawned(after).map((x) => x.id), ['adv-2'], '새 세션만 더한다');
  assert.equal(f.status, 'DELEGATING');
  assert.ok(f.sessions.has('op-h1') && f.sessions.has('wk-h1-1'), '앞 차례의 오류 창은 그대로');
  // 이번 차례의 끝 판정은 이번 차례 세션만 센다
  H.guard({ tool_name: 'Read', summary: 'x' });
  tick();
  clock.t += 6000;
  tick();
  const finals = events.slice(n).filter((e) => e.type === 'coordinator.log').map((e) => e.text);
  assert.ok(finals.includes('✓ 모든 하위 세션 완료'), finals.join(' | '));
});
