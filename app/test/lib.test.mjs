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
  const s = await readStatus(run, gh);
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

test('관제탑: 최근 하달이 카드 자리에, 맡은 이슈가 워커로, 라벨이 단계로 들어간다', async () => {
  const run = tmp();
  writeFileSync(`${run}/harness.json`, JSON.stringify({ designatedRepo: 'o/r' }));
  for (let n = 1; n <= 6; n++) mkdirSync(`${run}/handoffs/h${n}`, { recursive: true });
  for (let n = 1; n <= 5; n++) writeFileSync(`${run}/handoffs/h${n}/session.json`, JSON.stringify({ mode: 'work', issues: [n], pids: [], startedAt: '2026-11-20T01:00:00Z', endedAt: '2026-11-20T01:30:00Z' }));
  writeFileSync(`${run}/handoffs/h6/session.json`, JSON.stringify({ mode: 'work', issues: [6, 7], pid: 5, pids: [] }));
  writeFileSync(`${run}/handoffs/h5/stopped.json`, '{}');
  const gh = () => JSON.stringify([{ number: 6, title: '정렬', state: 'OPEN', labels: [{ name: '리뷰대기' }], url: 'u' }, { number: 7, title: 'x', state: 'OPEN', labels: [{ name: '막힘' }], url: 'u' }, { number: 2, title: 'y', state: 'CLOSED', labels: [{ name: '반영됨' }], url: 'u' }]);
  const v = towerView(await readStatus(run, gh));
  assert.deepEqual(v.operators.map((o) => o.id), SLOTS, '자리 다섯 개는 그대로');
  assert.deepEqual(v.operators.map((o) => o.name), ['하달 h2', '하달 h3', '하달 h4', '하달 h5', '하달 h6'], '최근 다섯 개, 오래된 것이 왼쪽');
  assert.deepEqual(v.operators.map((o) => o.state), ['idle', 'idle', 'idle', 'pause', 'work'], '끝남=대기, 멈춤=일시정지, 오퍼레이터 pid가 있고 끝나지 않음=작업중');
  assert.deepEqual(v.operators[4].workers.map((w) => [w.id, w.state, w.progress]), [['#6', 'work', 60], ['#7', 'pause', 30]]);
  assert.deepEqual(v.operators[0].workers.map((w) => [w.state, w.progress]), [['idle', 100]], '반영됨은 끝까지');
  assert.match(v.operators[3].log.at(-1), /멈춤/);
  const few = towerView(await readStatus(run, () => { throw new Error('gh 로그인 필요'); }));
  assert.match(few.operators[0].log.at(-1), /이슈를 못 읽음/);
  assert.deepEqual(towerView(null).operators.map((o) => o.name), Array(5).fill('빈 자리'));
  assert.match(towerView(null, '권한 없음').note, /권한 없음/);
});
