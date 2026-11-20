import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const guard = join(dirname(fileURLToPath(import.meta.url)), '..', 'guard.mjs');

const madeRuns = [];
after(() => { for (const d of madeRuns) rmSync(d, { recursive: true, force: true }); });

function setup() {
  const run = mkdtempSync(join(tmpdir(), 'guard-'));
  madeRuns.push(run);
  const config = {
    designatedRepo: 'owner/harness-issues',
    issuesClone: join(run, 'issues'),
    targetProject: join(run, 'memo'),
    harnessDir: dirname(guard),
    runDir: run,
  };
  const configPath = join(run, 'harness.json');
  writeFileSync(configPath, JSON.stringify(config));
  return { run, config, configPath };
}

const invoke = (args, stdin) =>
  spawnSync(process.execPath, [guard, ...args], { input: stdin, encoding: 'utf8' });

test('exit 2 on malformed stdin', () => {
  const { configPath } = setup();
  assert.equal(invoke(['--config', configPath, '--visibility-stub', 'PRIVATE'], '{not json').status, 2);
});

test('exit 2 when config missing', () => {
  const r = invoke(['--config', join(tmpdir(), 'nope-harness.json')], JSON.stringify({ tool_name: 'Read', tool_input: {} }));
  assert.equal(r.status, 2);
});

test('exit 0 for allowed read', () => {
  const { configPath, config } = setup();
  const r = invoke(['--config', configPath, '--visibility-stub', 'PRIVATE'],
    JSON.stringify({ tool_name: 'Read', tool_input: { file_path: join(config.targetProject, 'cli.mjs') } }));
  assert.equal(r.status, 0, r.stderr);
});

test('exit 2 with reason for denied write', () => {
  const { configPath, run } = setup();
  const r = invoke(['--config', configPath, '--visibility-stub', 'PRIVATE'],
    JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(run, 'outside.txt'), content: 'x' } }));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /지정 저장소 클론 밖에는 쓰지 않는다/);
});

test('writes guard.log line', () => {
  const { configPath, run } = setup();
  invoke(['--config', configPath, '--visibility-stub', 'PRIVATE'],
    JSON.stringify({ tool_name: 'PowerShell', tool_input: { command: 'ls' } }));
  const line = JSON.parse(readFileSync(join(run, 'guard.log'), 'utf8').trim().split('\n').pop());
  assert.equal(line.tool_name, 'PowerShell');
  assert.equal(line.allow, false);
  assert.equal(line.agent_type, null);
});

test('visibilityOverride in config forces public', () => {
  const { configPath, config } = setup();
  writeFileSync(configPath, JSON.stringify({ ...config, visibilityOverride: 'PUBLIC' }));
  const r = invoke(['--config', configPath],
    JSON.stringify({ tool_name: 'Bash', tool_input: { command: `gh issue create --repo ${config.designatedRepo} --title t --body b` } }));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /공개 저장소/);
});

// ---- 역할·하달 인자 (Task 6) ----
const V = ['--visibility-stub', 'PRIVATE'];
const readLines = (p) => readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('--role operator-work --handoff h1: denied call exits 2 and logs one line in logs/h1/guard.log', () => {
  const { configPath, run } = setup();
  const r = invoke(['--config', configPath, ...V, '--role', 'operator-work', '--handoff', 'h1'],
    JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(run, 'outside.txt'), content: 'x' } }));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /통합 폴더/);
  const lines = readLines(join(run, 'logs', 'h1', 'guard.log'));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].allow, false);
  assert.equal(lines[0].tool_name, 'Write');
  assert.equal(existsSync(join(run, 'guard.log')), false, 'default log is not used when --handoff is given');
});

test('--role operator-work --handoff h1: allowed call exits 0 and is logged under the handoff', () => {
  const { configPath, run, config } = setup();
  const r = invoke(['--config', configPath, ...V, '--role', 'operator-work', '--handoff', 'h1'],
    JSON.stringify({ tool_name: 'Read', tool_input: { file_path: join(config.targetProject, 'a.mjs') } }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readLines(join(run, 'logs', 'h1', 'guard.log'))[0].allow, true);
});

test('each handoff gets its own log folder', () => {
  const { configPath, run } = setup();
  for (const h of ['h1', 'h2']) {
    invoke(['--config', configPath, ...V, '--role', 'operator-reflect', '--handoff', h],
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }));
  }
  assert.equal(readLines(join(run, 'logs', 'h1', 'guard.log')).length, 1);
  assert.equal(readLines(join(run, 'logs', 'h2', 'guard.log')).length, 1);
});

test('--role operator-research --issue 7 merges the issue number as a number', () => {
  const { configPath, config } = setup();
  const view = (n) => invoke(['--config', configPath, ...V, '--role', 'operator-research', '--handoff', 'h3', '--issue', '7'],
    JSON.stringify({ tool_name: 'Bash', tool_input: { command: `gh issue view ${n} --repo ${config.designatedRepo}` } }));
  assert.equal(view(7).status, 0);
  const r = view(8);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /조사 이슈/);
});

test('--role worker --worktree merges the worktree', () => {
  const { configPath, run } = setup();
  const wt = join(run, 'worktrees', 'h1', 'issue-7');
  const call = (file) => invoke(['--config', configPath, ...V, '--role', 'worker', '--handoff', 'h1', '--worktree', wt],
    JSON.stringify({ tool_name: 'Write', tool_input: { file_path: file, content: 'x' } }));
  assert.equal(call(join(wt, 'a.txt')).status, 0);
  assert.equal(call(join(run, 'outside.txt')).status, 2);
});

test('Write to logs/ and handoffs/ is denied through the guard', () => {
  const { configPath, run } = setup();
  for (const f of [join(run, 'logs', 'h1', 'guard.log'), join(run, 'handoffs', 'h1', 'session.json')]) {
    const r = invoke(['--config', configPath, ...V],
      JSON.stringify({ tool_name: 'Write', tool_input: { file_path: f, content: 'x' } }));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /하네스 설정·제어 파일/);
  }
});

test('invalid role/handoff/issue/worktree combinations are refused and logged in the default guard.log', () => {
  const cases = [
    [['--role', 'admin', '--handoff', 'h1'], /알 수 없는 --role/],
    [['--role', 'operator-work'], /--handoff/],
    [['--role', 'operator-work', '--handoff', 'h0'], /--handoff/],
    [['--role', 'operator-work', '--handoff', 'H1'], /--handoff/],
    [['--role', 'operator-reflect'], /--handoff/],
    [['--role', 'operator-research', '--handoff', 'h1'], /--issue/],
    [['--role', 'operator-research', '--handoff', 'h1', '--issue', '0'], /--issue/],
    [['--role', 'operator-research', '--handoff', 'h1', '--issue', 'x'], /--issue/],
    [['--role', 'worker', '--handoff', 'h1'], /--worktree/],
    [['--role', 'worker', '--handoff', 'h1', '--worktree', 'relative/dir'], /--worktree/],
    [['--role'], /--role/],
    [['--handoff', 'h1'], /--role/],
    [['--issue', '7'], /--role/],
  ];
  for (const [args, re] of cases) {
    const { configPath, run } = setup();
    const r = invoke(['--config', configPath, ...V, ...args],
      JSON.stringify({ tool_name: 'Read', tool_input: { file_path: join(run, 'a') } }));
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, re, args.join(' '));
    const lines = readLines(join(run, 'guard.log'));
    assert.equal(lines.length, 1, args.join(' '));
    assert.equal(lines[0].allow, false);
    assert.equal(existsSync(join(run, 'logs')), false, 'no handoff log folder for refused args');
  }
});

test('a role or handoff inside the config file cannot stand in for missing args', () => {
  const { configPath, config, run } = setup();
  writeFileSync(configPath, JSON.stringify({ ...config, role: 'operator-work', handoff: 'h9' }));
  const r = invoke(['--config', configPath, ...V, '--role', 'operator-reflect', '--handoff', 'h1'],
    JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(config.issuesClone, '.drafts', 'a.md'), content: 'x' } }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(run, 'logs', 'h1', 'guard.log')), true);
  assert.equal(existsSync(join(run, 'logs', 'h9')), false);
});

// ---- 엄격한 인자 파싱 (fix round 1) ----
const envWith = (extra = {}) => { const e = { ...process.env, ...extra }; if (extra.HARNESS_REQUIRE_ROLE === undefined) delete e.HARNESS_REQUIRE_ROLE; return e; };
const invokeEnv = (args, stdin, env) => spawnSync(process.execPath, [guard, ...args], { input: stdin, encoding: 'utf8', env });
const createIssue = (config) => JSON.stringify({ tool_name: 'Bash', tool_input: { command: `gh issue create --repo ${config.designatedRepo} --title t --body b` } });

test('look-alike role arguments are refused, never run as the coordinator', () => {
  const cases = [
    ['--role=operator-research', '--handoff=h1', '--issue=7'], ['--role=operator-work'], ['--ROLE', 'operator-work'], ['-role', 'operator-work'],
    ['--ROLE', 'worker'], ['--Role', 'operator-reflect', '--handoff', 'h1'], ['--handoff=h1'], ['--Issue', '7'], ['--worktree=/x'], ['-handoff', 'h1'],
    ['--roles', 'x'], ['--role-x'],
  ];
  for (const args of cases) {
    const { configPath, config, run } = setup();
    const r = invoke(['--config', configPath, ...V, ...args], createIssue(config));
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /알 수 없는 역할 인자 모양/, args.join(' '));
    assert.equal(readLines(join(run, 'guard.log')).length, 1, args.join(' '));
  }
});

test('repeated role arguments are refused', () => {
  const cases = [
    ['--role', 'operator-work', '--handoff', 'h1', '--role', 'worker'], ['--role', 'operator-work', '--handoff', 'h1', '--handoff', 'h2'],
    ['--role', 'operator-research', '--handoff', 'h1', '--issue', '7', '--issue', '8'],
    ['--role', 'worker', '--handoff', 'h1', '--worktree', '/a', '--worktree', '/b'],
  ];
  for (const args of cases) {
    const { configPath, config, run } = setup();
    const r = invoke(['--config', configPath, ...V, ...args], createIssue(config));
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /두 번 이상/, args.join(' '));
    assert.equal(readLines(join(run, 'guard.log')).length, 1);
  }
});

test('HARNESS_REQUIRE_ROLE=1 without --role is refused; with a role or unset it works', () => {
  const { configPath, config, run } = setup();
  const read = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: join(config.targetProject, 'a.mjs') } });
  const r = invokeEnv(['--config', configPath, ...V], read, envWith({ HARNESS_REQUIRE_ROLE: '1' }));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /HARNESS_REQUIRE_ROLE/);
  assert.equal(readLines(join(run, 'guard.log')).length, 1);
  const ok1 = invokeEnv(['--config', configPath, ...V, '--role', 'operator-work', '--handoff', 'h1'], read, envWith({ HARNESS_REQUIRE_ROLE: '1' }));
  assert.equal(ok1.status, 0, ok1.stderr);
  const ok2 = invokeEnv(['--config', configPath, ...V], read, envWith());
  assert.equal(ok2.status, 0, ok2.stderr);
  const ok3 = invokeEnv(['--config', configPath, ...V], read, envWith({ HARNESS_REQUIRE_ROLE: '0' }));
  assert.equal(ok3.status, 0, ok3.stderr);
});

test('oversized --issue and UNC --worktree are refused', () => {
  for (const args of [['--role', 'operator-research', '--handoff', 'h1', '--issue', '99999999999999999999'],
    ['--role', 'operator-research', '--handoff', 'h1', '--issue', '1234567890'],
    ['--role', 'worker', '--handoff', 'h1', '--worktree', '//server/share/x'], ['--role', 'worker', '--handoff', 'h1', '--worktree', String.raw`\\server\share\x`]]) {
    const { configPath, run } = setup();
    const r = invoke(['--config', configPath, ...V, ...args], JSON.stringify({ tool_name: 'Read', tool_input: { file_path: join(run, 'a') } }));
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /--issue|--worktree/);
  }
});

test('M9: gh 공개 여부 조회가 시간 초과되면 닫힌 쪽(거부)으로 끝난다', () => {
  const { configPath, config, run } = setup();
  const hang = join(run, 'fake-gh.mjs');
  writeFileSync(hang, 'setTimeout(() => {}, 60000);\n');
  const t0 = Date.now();
  const r = invokeEnv(['--config', configPath], createIssue(config), envWith({ HARNESS_GH_BIN: hang, HARNESS_GH_TIMEOUT_MS: '500' }));
  assert.equal(r.status, 2, r.stderr);
  assert.ok(Date.now() - t0 < 20000);
  assert.match(r.stderr, /판정 중 오류/);
});

// ---------- T2: 판정마다 guard.log에 한 줄, 내부 오류는 막는다 ----------
test('T2: 허용·거부·내부 오류 판정이 각각 guard.log에 정확히 한 줄을 남기고 오류는 막는다', (t) => {
  const { configPath, config, run } = setup();
  const log = () => readFileSync(join(run, 'guard.log'), 'utf8').split('\n').filter(Boolean);
  const stubVisible = ['--visibility-stub', 'PRIVATE'];

  // 허용: 읽기
  const allow = spawnSync(process.execPath, [guard, '--config', configPath, ...stubVisible], { input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: join(config.targetProject, 'cli.mjs') } }), encoding: 'utf8' });
  assert.equal(allow.status, 0, allow.stderr);
  assert.equal(log().length, 1);

  // 거부: 클론 밖 쓰기
  const deny = spawnSync(process.execPath, [guard, '--config', configPath, ...stubVisible], { input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(run, 'outside.txt'), content: 'x' } }), encoding: 'utf8' });
  assert.equal(deny.status, 2);
  assert.equal(log().length, 2);

  // 내부 오류: 공개 여부 조회가 멈춰 판정 중 오류가 난다(막힌다)
  const hang = join(run, 'fake-gh.mjs');
  writeFileSync(hang, 'setTimeout(() => {}, 60000);\n');
  const err = invokeEnv(['--config', configPath], createIssue(config), envWith({ HARNESS_GH_BIN: hang, HARNESS_GH_TIMEOUT_MS: '500' }));
  assert.equal(err.status, 2, err.stderr);
  assert.match(err.stderr, /판정 중 오류/);

  const lines = log();
  assert.equal(lines.length, 3, '판정마다 정확히 한 줄');
  const [a, d, e] = lines.map((l) => JSON.parse(l));
  assert.deepEqual([a.allow, d.allow, e.allow], [true, false, false]);
  assert.match(e.reason, /^판정 중 오류/);
  for (const rec of [a, d, e]) {
    assert.deepEqual(Object.keys(rec).sort(), ['agent_type', 'allow', 'reason', 'summary', 'time', 'tool_name']);
    assert.ok(!Number.isNaN(Date.parse(rec.time)));
  }
  assert.equal(a.tool_name, 'Read');
  assert.equal(d.tool_name, 'Write');
  assert.equal(e.tool_name, 'Bash');
  t.diagnostic(`guard.log 예시 3줄 (허용, 거부, 오류)\n${lines.join('\n')}`);
});

test('T2: 설정 파일이나 입력을 읽을 수 없는 오류는 막고, 오류 메시지를 stderr에 남긴다', () => {
  const { configPath } = setup();
  const badInput = invoke(['--config', configPath, '--visibility-stub', 'PRIVATE'], '{not json');
  assert.equal(badInput.status, 2);
  assert.match(badInput.stderr, /가드 오류로 막음/);
  const noConfig = invoke(['--config', join(tmpdir(), 'nope-harness.json')], JSON.stringify({ tool_name: 'Read', tool_input: {} }));
  assert.equal(noConfig.status, 2);
  assert.match(noConfig.stderr, /가드 오류로 막음/);
  // 설정 인자가 아예 없어도 막는다
  assert.equal(invoke([], JSON.stringify({ tool_name: 'Read', tool_input: {} })).status, 2);
});
