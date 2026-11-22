// 앱 논리 시험(Electron 없이). node --test app/test/
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { coordinatorArgs, coordinatorEnv, CoordinatorTerminal, TOOLS } from '../lib/terminal.mjs';
import { KeyStore } from '../lib/keys.mjs';
import { readStatus } from '../lib/status.mjs';
import { towerView, SLOTS } from '../lib/tower.mjs';
import { install, checkInstallInput } from '../lib/install.mjs';

const fwd = (p) => p.split(String.fromCharCode(92)).join('/');
const made = [];
after(() => { for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 무시 */ } } });
const tmp = () => { const d = fwd(mkdtempSync(`${fwd(tmpdir())}/app-`)); made.push(d); return d; };

test('코디네이터 터미널 인자는 README 실행 절과 같은 설정이고 대화형이다(-p 없음, 결정 8-18)', () => {
  const id = 'fbd9aa0e-63c2-4f0a-81ab-99620753943e';
  assert.deepEqual(coordinatorArgs({ sessionId: id }), ['--setting-sources', 'project,local', '--allowedTools', TOOLS, '--session-id', id]);
  assert.deepEqual(coordinatorArgs({ resume: id }).slice(-2), ['--resume', id]);
  assert.ok(!coordinatorArgs({ sessionId: id }).includes('-p'));
  assert.throws(() => coordinatorArgs({ resume: '--dangerously' }));
  assert.throws(() => coordinatorArgs({ sessionId: 'abc' }));
});

test('터미널: 처음엔 앱이 정한 세션 id로 띄우고, 끝난 뒤에는 그 id로 이어 연다(--continue를 쓰지 않는다)', () => {
  const spawned = [];
  let exit;
  const fakePty = (bin, args, opts) => {
    const p = { pid: 4242, written: [], sizes: [], write: (d) => p.written.push(d), resize: (c, r) => p.sizes.push([c, r]), kill: () => { p.killed = true; }, onData: () => {}, onExit: (fn) => { exit = fn; } };
    spawned.push({ bin, args, opts, p });
    return p;
  };
  const exits = [];
  const t = new CoordinatorTerminal({ run: 'C:/run', bin: 'claude.exe', preArgs: ['x.js'], env: { A: '1' }, ptySpawn: fakePty, onData: () => {}, onExit: (e) => exits.push(e) });
  const id = t.start();
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(spawned[0].bin, 'claude.exe');
  assert.deepEqual(spawned[0].args.slice(0, 1), ['x.js']);
  assert.deepEqual(spawned[0].args.slice(-2), ['--session-id', id]);
  assert.ok(!spawned[0].args.includes('--continue'));
  assert.equal(spawned[0].opts.cwd, 'C:/run');
  assert.deepEqual(spawned[0].opts.env, { A: '1' });
  assert.equal(t.start(), id, '이미 떠 있으면 다시 띄우지 않는다');
  assert.equal(spawned.length, 1);
  t.write('안녕\r');
  t.resize(120, 30);
  t.resize(3, 2);
  assert.deepEqual(spawned[0].p.written, ['안녕\r']);
  assert.deepEqual(spawned[0].p.sizes, [[120, 30]], '말이 안 되는 크기는 무시한다');
  exit({ exitCode: 0 });
  assert.deepEqual(exits, [{ code: 0, sessionId: id }]);
  t.start();
  assert.deepEqual(spawned[1].args.slice(-2), ['--resume', id]);
  const killed = [];
  t.stop((pid) => killed.push(pid));
  assert.deepEqual(killed, [4242], '프로세스 트리째 끝낸다');
  assert.ok(spawned[1].p.killed);
  exit({ exitCode: 1 });
  assert.equal(exits.length, 1, '앱이 닫은 터미널의 종료는 알리지 않는다');
});

test('터미널: 이어 열 대화가 없으면(신뢰 확인에서 끝낸 첫 실행) 새 세션 id로 바로 다시 띄운다', () => {
  const old = 'fbd9aa0e-63c2-4f0a-81ab-99620753943e';
  const fresh = '11111111-2222-4333-8444-555555555555';
  const runs = [];
  const sessions = [];
  const exits = [];
  const t = new CoordinatorTerminal({
    run: 'C:/run', bin: 'c', env: {}, resume: old, newId: () => fresh,
    ptySpawn: (b, a) => { const p = { args: a, onData: (fn) => { p.data = fn; }, onExit: (fn) => { p.exit = fn; } }; runs.push(p); return p; },
    onData() {}, onExit: (e) => exits.push(e), onSession: (id) => sessions.push(id),
  });
  t.start();
  assert.deepEqual(runs[0].args.slice(-2), ['--resume', old]);
  runs[0].data(`No conversation found with session ID: ${old}\r\n`);
  runs[0].exit({ exitCode: 1 });
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[1].args.slice(-2), ['--session-id', fresh]);
  assert.deepEqual(sessions, [old, fresh], '새 id를 앱에 알린다');
  assert.deepEqual(exits, [], '자동으로 다시 띄운 것은 종료로 알리지 않는다');
});

test('터미널 환경: 앱을 띄운 Claude Code 세션의 표지는 지우고 사용자 설정과 키는 둔다', () => {
  const env = coordinatorEnv({ CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CODE_GIT_BASH_PATH: 'C:/git/bash.exe', TYPESAFE_API_KEY: 'k', PATH: 'p' });
  assert.deepEqual(env, { CLAUDE_CODE_GIT_BASH_PATH: 'C:/git/bash.exe', TYPESAFE_API_KEY: 'k', PATH: 'p' });
});

test('터미널: 저장된 세션 id가 이상하면 버리고 새로 띄운다', () => {
  const args = [];
  const t = new CoordinatorTerminal({ run: 'C:/run', bin: 'c', env: {}, resume: 'not-a-uuid', ptySpawn: (b, a) => { args.push(a); return { onData() {}, onExit() {} }; }, onData() {}, onExit() {} });
  t.start();
  assert.equal(args[0].at(-2), '--session-id');
});

test('키 보관: 이름은 정해진 둘만, 값은 암호화해 쓰고, 상태에는 있음/없음만 보인다', () => {
  const dir = tmp();
  const safe = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`enc:${s}`), decryptString: (b) => String(b).replace(/^enc:/, '') };
  const k = new KeyStore({ file: `${dir}/keys.json`, safe });
  assert.deepEqual(k.status(), { TYPESAFE_API_KEY: false, GEMINI_API_KEY: false });
  k.set('TYPESAFE_API_KEY', ' secret-1 ');
  assert.ok(!readFileSync(`${dir}/keys.json`, 'utf8').includes('secret-1'), '파일에 평문이 없다');
  assert.deepEqual(k.status(), { TYPESAFE_API_KEY: true, GEMINI_API_KEY: false });
  assert.deepEqual(k.env(), { TYPESAFE_API_KEY: 'secret-1' });
  assert.throws(() => k.set('PATH', 'x'), /보관할 수 없는/);
  assert.throws(() => k.set('GEMINI_API_KEY', 'a\nb'), /모양/);
  k.set('TYPESAFE_API_KEY', '');
  assert.deepEqual(k.env(), {});
  assert.throws(() => new KeyStore({ file: `${dir}/k2.json`, safe: { ...safe, isEncryptionAvailable: () => false } }).set('GEMINI_API_KEY', 'x'), /암호화/);
});

test('진행 표시: 이슈 상태 라벨, 하달, 조언 판정, 훅 거부를 읽기만 한다', async () => {
  const run = tmp();
  writeFileSync(`${run}/harness.json`, JSON.stringify({ designatedRepo: 'o/r', projectName: 'memo' }));
  mkdirSync(`${run}/handoffs/h1`, { recursive: true });
  mkdirSync(`${run}/handoffs/h2`, { recursive: true });
  writeFileSync(`${run}/handoffs/h1/session.json`, JSON.stringify({ mode: 'work', issues: [3], pids: [] }));
  writeFileSync(`${run}/handoffs/h2/session.json`, JSON.stringify({ mode: 'work', issues: [4], pids: [9] }));
  writeFileSync(`${run}/handoffs/h1/stopped.json`, '{}');
  writeFileSync(`${run}/advice-log.jsonl`, `${JSON.stringify({ time: 't', adviceId: 'adv-1', verdict: '거부', sha256: 'a'.repeat(64), attempt: 1 })}\n${JSON.stringify({ time: 't2', adviceId: 'adv-1', verdict: '허용', sha256: 'b'.repeat(64), attempt: 2 })}\n`);
  writeFileSync(`${run}/guard.log`, `${JSON.stringify({ time: 't', agent_type: null, tool_name: 'Write', allow: false, reason: '대상 프로젝트' })}\n${JSON.stringify({ time: 't', agent_type: null, tool_name: 'Bash', allow: true })}\nbroken\n`);
  const calls = [];
  const gh = (args) => { calls.push(args); return JSON.stringify([{ number: 4, title: '정렬', state: 'OPEN', labels: [{ name: 'enhancement' }, { name: '리뷰대기' }], url: 'https://github.com/o/r/issues/4' }, { number: 3, title: 'x', state: 'CLOSED', labels: [], url: 'u' }]); };
  const s = await readStatus(run, gh, { alive: (p) => p === 9 });
  assert.deepEqual(calls[0].slice(0, 2), ['issue', 'list'], '이슈는 list로만 읽는다');
  assert.deepEqual(s.issues.map((i) => [i.number, i.label, i.open]), [[4, '리뷰대기', true], [3, '라벨 없음', false]]);
  assert.deepEqual(s.handoffs.map((h) => [h.name, h.running, h.stopped]), [['h2', true, false], ['h1', false, true]]);
  assert.deepEqual(s.advice.map((a) => a.verdict), ['허용', '거부']);
  assert.equal(s.guard.total, 2);
  assert.equal(s.guard.denied[0].tool, 'Write');
  const bad = await readStatus(run, () => { throw new Error('gh 로그인 필요'); });
  assert.match(bad.issuesError, /gh 로그인 필요/);
});

test('설치: 비공개가 아닌 저장소는 setup을 부르지 않고 막는다. 비공개면 --project와 함께 setup.mjs를 부른다', async () => {
  const calls = [];
  const exec = (vis) => (bin, args) => { calls.push([bin, ...args]); return bin === 'gh' ? { status: 0, stdout: `${vis}\n` } : { status: 0, stdout: '실행 폴더를 만들었습니다' }; };
  const pub = await install({ harnessDir: 'C:/h', runsDir: 'C:/d/runs', repo: 'o/r', runName: 'p1', exec: exec('PUBLIC') });
  assert.equal(pub.ok, false);
  assert.match(pub.error, /비공개가 아닙니다/);
  assert.equal(calls.filter((c) => c[0] === 'node').length, 0);
  const ok = await install({ harnessDir: 'C:/h', runsDir: 'C:/d/runs', repo: 'o/r', runName: 'p1', project: 'C:/src/app', exec: exec('PRIVATE') });
  assert.equal(ok.ok, true);
  assert.equal(ok.run, 'C:/d/runs/p1');
  assert.deepEqual(calls.at(-1), ['node', 'C:/h/setup.mjs', '--run', 'C:/d/runs/p1', '--repo', 'o/r', '--project', 'C:/src/app']);
  assert.match(checkInstallInput({ repo: 'o/r', runName: '../x' }), /실행 폴더 이름/);
  assert.match(checkInstallInput({ repo: 'nope', runName: 'a' }), /소유자/);
});

test('설치(결정 8-28): 저장소가 없으면 동의(createRepo) 없이는 setup을 부르지 않고 missing을 알린다. 동의하면 --create-repo를 넘긴다. 다른 실패는 동의가 있어도 막는다', async () => {
  const calls = [];
  const exec = (view) => (bin, args) => { calls.push([bin, ...args]); return bin === 'gh' ? view : { status: 0, stdout: '실행 폴더 준비 완료' }; };
  const missingView = { status: 1, stdout: '', stderr: "GraphQL: Could not resolve to a Repository with the name 'o/r'. (repository)\n" };
  const base = { harnessDir: 'C:/h', runsDir: 'C:/d/runs', repo: 'o/r', runName: 'p1' };
  const ask = await install({ ...base, exec: exec(missingView) });
  assert.equal(ask.ok, false);
  assert.equal(ask.missing, true);
  assert.match(ask.error, /없습니다/);
  assert.equal(calls.filter((c) => c[0] === 'node').length, 0, '동의 전에는 setup을 부르지 않는다');
  const yes = await install({ ...base, createRepo: true, exec: exec(missingView) });
  assert.equal(yes.ok, true);
  assert.deepEqual(calls.at(-1), ['node', 'C:/h/setup.mjs', '--run', 'C:/d/runs/p1', '--repo', 'o/r', '--create-repo']);
  calls.length = 0;
  const auth = await install({ ...base, createRepo: true, exec: exec({ status: 1, stdout: '', stderr: 'gh auth login 필요\n' }) });
  assert.equal(auth.ok, false);
  assert.ok(!auth.missing);
  assert.equal(calls.filter((c) => c[0] === 'node').length, 0, '찾을 수 없다는 답이 아니면 만들지 않는다');
  // 이미 비공개로 있으면 동의가 있어도 --create-repo를 넘기지 않는다
  const exists = await install({ ...base, createRepo: true, exec: exec({ status: 0, stdout: 'PRIVATE\n' }) });
  assert.equal(exists.ok, true);
  assert.ok(!calls.at(-1).includes('--create-repo'));
});

// 관제탑(결정 8-29, ADR 0012): 카드 다섯 = 역할 오퍼레이터. 하달 기록(dispatch.json)·워커 기록(workers.jsonl)을 가짜로 둔다.
function towerRun() {
  const run = tmp();
  writeFileSync(`${run}/harness.json`, JSON.stringify({ designatedRepo: 'o/r' }));
  mkdirSync(`${run}/handoffs`, { recursive: true });
  return run;
}
// h<N>: 팀, 세션(없으면 세션을 안 띄운 하달), 하달 기록, 워커 기록 줄.
function handoff(run, n, { team, mode = 'work', session, dispatch = {}, workers, stopped = false, legacy = false } = {}) {
  const d = `${run}/handoffs/h${n}`;
  mkdirSync(d, { recursive: true });
  if (session) writeFileSync(`${d}/session.json`, JSON.stringify(session));
  if (!legacy) writeFileSync(`${d}/dispatch.json`, JSON.stringify({ team: team ?? null, mode, requested: [n], live: [n], excluded: [], base: null, startedAt: '2026-11-20T01:00:00Z', endedAt: '2026-11-20T01:30:00Z', sessionOk: true, ...dispatch }));
  if (workers) writeFileSync(`${d}/workers.jsonl`, workers.map((w) => (typeof w === 'string' ? w : JSON.stringify(w))).join('\n') + '\n');
  if (stopped) writeFileSync(`${d}/stopped.json`, '{}');
}
const ended = (issues) => ({ mode: 'work', issues, pids: [], startedAt: '2026-11-20T01:00:00Z', endedAt: '2026-11-20T01:30:00Z' });
const start = (issue, model = 'claude') => ({ event: 'start', issue, requestedModel: model, model, base: 'main' });
const end = (issue, attempts = 1, status = '완료', model = 'claude') => ({ event: 'end', issue, status, attempts, model, actualModel: model });
const noGh = () => '[]';

test('관제탑: 하달이 없어도 카드 다섯(dev·design·tester·plan·sec), 모두 대기중이고 빈 자리가 없다. 이름은 넣지 않는다', async () => {
  const run = towerRun();
  const v = towerView(await readStatus(run, noGh));
  assert.deepEqual(v.operators.map((o) => o.id), ['dev', 'design', 'tester', 'plan', 'sec']);
  assert.deepEqual(SLOTS, ['dev', 'design', 'tester', 'plan', 'sec']);
  assert.deepEqual(v.operators.map((o) => o.state), Array(5).fill('idle'));
  assert.ok(v.operators.every((o) => !('name' in o)), '카드 이름은 화면(NAMES)이 정한다');
  assert.ok(!JSON.stringify(v).includes('빈 자리'));
  assert.deepEqual(v.operators[0].log, ['아직 호출된 적 없음']);
  for (const x of [towerView(null), towerView(null, '권한 없음')]) {
    assert.deepEqual(x.operators.map((o) => [o.id, o.state]), SLOTS.map((s) => [s, 'idle']));
    assert.ok(!JSON.stringify(x).includes('빈 자리'));
  }
  assert.match(towerView(null, '권한 없음').operators[2].log[0], /상태를 못 읽음: 권한 없음/);
  assert.match(towerView(null).note, /실행 폴더를 고르세요/);
});

test('관제탑: dev 하달이 도는 중이면 dev만 작업중이고 워커 상자는 도는 하달의 것이다(한 팀에 하달 둘: 끝남, 도는 중)', async () => {
  const run = towerRun();
  handoff(run, 1, { team: 'dev', session: ended([1]), workers: [start(1), end(1)] });
  handoff(run, 2, { team: 'dev', session: { mode: 'work', issues: [2, 3], pid: 5, pids: [], startedAt: '2026-11-20T02:00:00Z' }, dispatch: { live: [2, 3], endedAt: null, sessionOk: null }, workers: [start(2), start(3, 'gemini'), end(3, 2, '완료', 'gemini')] });
  const gh = () => JSON.stringify([{ number: 2, title: '정렬', state: 'OPEN', labels: [{ name: '진행중' }], url: 'u' }, { number: 3, title: 'x', state: 'OPEN', labels: [{ name: '리뷰대기' }], url: 'u' }]);
  const v = towerView(await readStatus(run, gh, { alive: (p) => p === 5 }));
  assert.deepEqual(v.operators.map((o) => o.state), ['work', 'idle', 'idle', 'idle', 'idle']);
  const dev = v.operators[0];
  assert.deepEqual(dev.workers.map((w) => [w.id, w.name, w.state, w.progress]), [['#2', '#2 claude', 'work', 30], ['#3', '#3 gemini 2회', 'idle', 60]]);
  assert.equal(dev.log.length, 3, '상세 창은 마지막 세 줄만 그린다');
  assert.equal(dev.log[0], '누적 · 호출 2회 · 작업 없이 0회 · 워커 3명');
  assert.match(dev.log[1], /^h2 \d\d:\d\d~ · 이슈 #2, #3 · 워커 2명$/);
  assert.equal(dev.log[2], '지금 · 도는 중');
});

test('관제탑: tester의 가장 최근 하달이 멈춤이면 일시정지, 그 뒤에 끝난 하달이 하나 더 있으면 대기중', async () => {
  const run = towerRun();
  handoff(run, 1, { team: 'tester', session: { ...ended([1]), stoppedAt: '2026-11-20T01:10:00Z' }, stopped: true, workers: [start(1)] });
  let v = towerView(await readStatus(run, noGh));
  assert.equal(v.operators[2].state, 'pause');
  assert.match(v.operators[2].log.at(-1), /멈춤\(stop-operator\)/);
  assert.equal(v.operators[2].log[0], '누적 · 호출 1회 · 작업 없이 0회 · 워커 1명', '멈춘 하달은 작업 없이로 세지 않는다');
  handoff(run, 2, { team: 'tester', session: ended([2]), workers: [start(2), end(2)] });
  v = towerView(await readStatus(run, noGh));
  assert.equal(v.operators[2].state, 'idle');
  assert.match(v.operators[2].log.at(-1), / · 끝남$/);
});

test('관제탑: 팀 없는 옛 하달 여섯 개만 있으면 다섯 장 모두 대기중이고 "옛 하달 6개" 줄이 있다(설정 창 진행 기록에는 그대로)', async () => {
  const run = towerRun();
  for (let n = 1; n <= 6; n++) handoff(run, n, { legacy: true, session: ended([n]) });
  const s = await readStatus(run, noGh);
  assert.equal(s.handoffs.length, 6, '설정 창의 진행 기록은 옛 하달도 모두 읽는다');
  assert.deepEqual(s.handoffs.map((h) => [h.team, h.workers]), Array(6).fill([null, null]), '옛 하달은 팀 없음, 워커 모름(0이 아님)');
  const v = towerView(s);
  assert.deepEqual(v.operators.map((o) => o.state), Array(5).fill('idle'));
  for (const o of v.operators) assert.deepEqual(o.log, ['팀 없는 옛 하달 6개는 설정 창 진행 기록에', '아직 호출된 적 없음']);
});

test('관제탑: 워커 둘을 부른 하달은 워커 상자 둘과 "워커 2명". 모델을 못 골라 end만 있는 이슈와 깨진 줄은 워커로 세지 않는다', async () => {
  const run = towerRun();
  handoff(run, 1, { team: 'design', session: ended([1, 2, 3]), dispatch: { live: [1, 2, 3] }, workers: [start(1), end(1), '{깨진 줄', start(2), end(2, 3, '막힘'), { event: 'end', issue: 3, status: '막힘', attempts: 0, model: null }] });
  const o = towerView(await readStatus(run, noGh)).operators[1];
  assert.deepEqual(o.workers.map((w) => [w.name, w.state]), [['#1 claude 1회', 'idle'], ['#2 claude 3회', 'pause']]);
  assert.match(o.log[1], /워커 2명$/);
  assert.equal(o.log[0], '누적 · 호출 1회 · 작업 없이 0회 · 워커 2명');
});

test('관제탑: 모두 대기로 빠진 하달은 워커 상자 0, "작업 없이 호출됨", 누적의 "작업 없이 1회". 세션은 떴지만 워커가 없으면 사유가 다르다', async () => {
  const run = towerRun();
  handoff(run, 1, { team: 'plan', dispatch: { requested: [14], live: [], excluded: [{ issue: 14, reason: '대기' }] } });
  let o = towerView(await readStatus(run, noGh)).operators[3];
  assert.deepEqual(o.workers, []);
  assert.equal(o.state, 'idle');
  assert.equal(o.log[0], '누적 · 호출 1회 · 작업 없이 1회 · 워커 0명');
  assert.equal(o.log.at(-1), '작업 없이 호출됨 · #14 대기');
  handoff(run, 2, { team: 'plan', session: ended([15]), dispatch: { live: [15], sessionOk: false } });
  o = towerView(await readStatus(run, noGh)).operators[3];
  assert.equal(o.log[0], '누적 · 호출 2회 · 작업 없이 2회 · 워커 0명');
  assert.equal(o.log.at(-1), '작업 없이 호출됨 · 세션 실패');
});

test('관제탑: 조사 하달은 그 팀 카드에 들어가지만 "작업 없이"로 세지 않는다', async () => {
  const run = towerRun();
  handoff(run, 1, { team: 'sec', mode: 'research', session: { mode: 'research', issues: [4], pid: 9, pids: [], startedAt: '2026-11-20T01:00:00Z' }, dispatch: { endedAt: null } });
  let o = towerView(await readStatus(run, noGh, { alive: (p) => p === 9 })).operators[4];
  assert.equal(o.state, 'work', '조사 하달이 도는 동안 그 팀 카드가 작업중');
  handoff(run, 2, { team: 'sec', mode: 'research', session: { ...ended([5]), mode: 'research' } });
  o = towerView(await readStatus(run, noGh, { alive: () => false })).operators[4];
  assert.match(o.log[0], /작업 없이 0회/);
  assert.match(o.log.at(-1), / · 끝남$/);
});

test('하달: 끝난 시각이 없어도 적힌 프로세스가 다 죽었으면 도는 중이 아니라 orphaned(관제탑은 일시정지와 정리 안내)', async () => {
  const run = towerRun();
  handoff(run, 1, { team: 'dev', session: { mode: 'work', issues: [1], pid: 111, driverPid: 222 }, dispatch: { endedAt: null, sessionOk: null } });
  const dead = await readStatus(run, noGh, { alive: () => false });
  assert.deepEqual([dead.handoffs[0].running, dead.handoffs[0].orphaned], [false, true]);
  const card = towerView(dead).operators[0];
  assert.equal(card.state, 'pause');
  assert.match(card.log.at(-1), /stop-operator로 정리/);
  const live = await readStatus(run, noGh, { alive: (p) => p === 222 });
  assert.deepEqual([live.handoffs[0].running, live.handoffs[0].orphaned], [true, false], '드라이버만 살아 있어도 도는 중');
  const few = towerView(await readStatus(run, () => { throw new Error('gh 로그인 필요'); }, { alive: () => false }));
  assert.match(few.operators[0].log.at(-1), /이슈를 못 읽음/);
});
