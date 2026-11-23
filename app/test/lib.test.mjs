// 앱 논리 시험(Electron 없이). node --test app/test/
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { coordinatorArgs, coordinatorEnv, CoordinatorTerminal, TOOLS } from '../lib/terminal.mjs';
import { KeyStore } from '../lib/keys.mjs';
import { readStatus } from '../lib/status.mjs';
import { install, checkInstallInput, githubRepoFromUrl, originRepo } from '../lib/install.mjs';

const fwd = (p) => p.split(String.fromCharCode(92)).join('/');
const made = [];
after(() => { for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 무시 */ } } });
const tmp = () => { const d = fwd(mkdtempSync(`${fwd(tmpdir())}/app-`)); made.push(d); return d; };

test('코디네이터 터미널 인자는 README 실행 절과 같은 설정이고 대화형이다(-p 없음, 결정 8-18)', () => {
  const id = 'fbd9aa0e-63c2-4f0a-81ab-99620753943e';
  assert.deepEqual(coordinatorArgs({ sessionId: id }), ['--setting-sources', 'project,local', '--allowedTools', TOOLS, '--session-id', id]);
  assert.deepEqual(coordinatorArgs({ resume: id }).slice(-2), ['--resume', id]);
  // 앱이 더하는 statusline 설정 파일(관제탑의 사용량·모델 칸). 실행 폴더 설정 출처(project,local)는 그대로다.
  assert.deepEqual(coordinatorArgs({ sessionId: id, settingsFile: 'C:/d/coordinator-settings.json' }), ['--setting-sources', 'project,local', '--allowedTools', TOOLS, '--settings', 'C:/d/coordinator-settings.json', '--session-id', id]);
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

// 하달 기록(dispatch.json)·워커 기록(workers.jsonl)을 가짜로 둔다.
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

// 예전 관제탑 카드(towerView)는 새 관제탑 화면(app/tower)으로 바뀌며 지웠다. 하달·워커 기록 읽기(status.mjs)는 설정 창 진행 기록과 새 화면의 흐름(flow.mjs)이 같이 쓴다.
test('하달 기록 읽기: 팀 없는 옛 하달도 읽고(팀 없음, 워커 모름), 모델을 못 골라 end만 있는 이슈와 깨진 줄은 워커로 세지 않는다', async () => {
  const run = towerRun();
  for (let n = 1; n <= 2; n++) handoff(run, n, { legacy: true, session: ended([n]) });
  handoff(run, 3, { team: 'design', session: ended([1, 2, 3]), dispatch: { live: [1, 2, 3] }, workers: [start(1), end(1), '{깨진 줄', start(2), end(2, 3, '막힘'), { event: 'end', issue: 3, status: '막힘', attempts: 0, model: null }] });
  const s = await readStatus(run, noGh);
  assert.equal(s.handoffs.length, 3);
  assert.deepEqual(s.handoffs.filter((h) => h.name !== 'h3').map((h) => [h.team, h.workers]), [[null, null], [null, null]], '옛 하달은 팀 없음, 워커 모름(0이 아님)');
  const h3 = s.handoffs.find((h) => h.name === 'h3');
  assert.deepEqual(h3.workers.map((w) => [w.issue, w.done, w.status, w.attempts]), [[1, true, '완료', 1], [2, true, '막힘', 3]]);
});

test('하달: 끝난 시각이 없어도 적힌 프로세스가 다 죽었으면 도는 중이 아니라 orphaned. 드라이버만 살아 있어도 도는 중', async () => {
  const run = towerRun();
  handoff(run, 1, { team: 'dev', session: { mode: 'work', issues: [1], pid: 111, driverPid: 222 }, dispatch: { endedAt: null, sessionOk: null } });
  const dead = await readStatus(run, noGh, { alive: () => false });
  assert.deepEqual([dead.handoffs[0].running, dead.handoffs[0].orphaned], [false, true]);
  const live = await readStatus(run, noGh, { alive: (p) => p === 222 });
  assert.deepEqual([live.handoffs[0].running, live.handoffs[0].orphaned], [true, false]);
  const few = await readStatus(run, () => { throw new Error('gh 로그인 필요'); }, { alive: () => false });
  assert.match(few.issuesError, /gh 로그인 필요/);
});

test('설치(결정 8-32): 대상 프로젝트 origin이 GitHub면 대상 저장소로 넘기고, 동의했을 때만 --add-workflows(아니면 --no-workflows)', async () => {
  assert.equal(githubRepoFromUrl('https://github.com/owner/app.git\n'), 'owner/app');
  assert.equal(githubRepoFromUrl('git@github.com:owner/app.git'), 'owner/app');
  assert.equal(githubRepoFromUrl('https://github.com/owner/app'), 'owner/app');
  assert.equal(githubRepoFromUrl('https://gitlab.com/owner/app.git'), null);
  assert.equal(githubRepoFromUrl('C:/src/app'), null);
  assert.equal(await originRepo('C:/src/app', () => ({ status: 0, stdout: 'https://github.com/owner/app.git\n' })), 'owner/app');
  assert.equal(await originRepo('C:/src/app', () => ({ status: 2, stdout: '' })), null);
  assert.equal(await originRepo(undefined, () => { throw new Error('부르지 않는다'); }), null);
  const calls = [];
  const exec = (bin, args) => { calls.push([bin, ...args]); return bin === 'gh' ? { status: 0, stdout: 'PRIVATE\n' } : { status: 0, stdout: 'ok' }; };
  const base = { harnessDir: 'C:/h', runsDir: 'C:/d/runs', repo: 'o/r', runName: 'p1', project: 'C:/src/app', exec };
  assert.equal((await install({ ...base, targetRepo: 'owner/app' })).ok, true);
  assert.deepEqual(calls.at(-1).slice(-3), ['--target-repo', 'owner/app', '--no-workflows'], '기본은 넣지 않음');
  assert.equal((await install({ ...base, targetRepo: 'owner/app', addWorkflows: true })).ok, true);
  assert.deepEqual(calls.at(-1).slice(-3), ['--target-repo', 'owner/app', '--add-workflows']);
  assert.equal((await install({ ...base, targetRepo: 'bad name' })).ok, false);
  await install(base);
  assert.ok(!calls.at(-1).includes('--target-repo'), '대상 저장소가 없으면 로컬 흐름');
});
