import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main as research } from '../operator/run-research.mjs';
import { main as stop } from '../operator/stop-operator.mjs';
import { main as work } from '../operator/run-operator.mjs';
import { defaultKill } from '../operator/stop-operator.mjs';
import { execFileSync } from 'node:child_process';
import { sessionCwd, launchSession } from '../operator/launch.mjs';
import { EventEmitter } from 'node:events';

const here = dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/');
const realHarness = dirname(here).replace(/\\/g, '/');
const made = [];
after(() => {
  for (const d of made) {
    for (const h of ['h1', 'h2', 'h3']) rmSync(sessionCwd(d, h), { recursive: true, force: true });
    try { rmSync(d, { recursive: true, force: true }); } catch { /* 잠긴 파일은 무시 */ }
  }
});

// 실행 폴더 + 임시 하네스 폴더(모드 문서, 설정 파일)
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'rs-')).replace(/\\/g, '/');
  made.push(root);
  const run = `${root}/run`;
  const harnessDir = `${root}/harness`;
  mkdirSync(`${run}/handoffs`, { recursive: true });
  mkdirSync(`${harnessDir}/operator`, { recursive: true });
  copyFileSync(`${realHarness}/operator/operator.config.json`, `${harnessDir}/operator/operator.config.json`);
  writeFileSync(`${harnessDir}/operator/AGENT.md`, '# AGENT.md\n');
  for (const m of ['research', 'work']) {
    mkdirSync(`${harnessDir}/operator/skills/operator-${m}`, { recursive: true });
    writeFileSync(`${harnessDir}/operator/skills/operator-${m}/SKILL.md`, `# ${m}.md\n`);
  }
  writeFileSync(`${run}/harness.json`, JSON.stringify({ harnessDir, designatedRepo: 'o/r', issuesClone: `${root}/issues`, targetProject: `${root}/memo`, worktrees: `${run}/worktrees` }));
  return { root, run, harnessDir, env: { HARNESS_RUN_DIR: run } };
}
const collect = () => { const lines = []; return { lines, write: (l) => lines.push(l) }; };
const gh = (state = '진행중', url = 'https://example.test/issues/9') => ({
  calls: [],
  async fetchIssue() { return { state, url }; },
  async setState(n, s) { this.calls.push([n, s]); },
});
const session = (run, h, body) => {
  mkdirSync(`${run}/handoffs/${h}`, { recursive: true });
  writeFileSync(`${run}/handoffs/${h}/session.json`, typeof body === 'string' ? body : JSON.stringify(body));
};

test('run-research: h1이 진행 중이어도 막히지 않고 h2로 시작, 출력은 한 줄', async () => {
  const s = setup();
  session(s.run, 'h1', { pid: 111, mode: 'work' });
  const out = collect();
  const launched = [];
  const code = await research(['--issue', '9'], s.env, {
    ...gh(), write: out.write,
    launchSession: async (o) => { launched.push(o); return { code: 0, timedOut: false }; },
  });
  assert.equal(code, 0);
  assert.equal(launched.length, 1);
  assert.equal(launched[0].handoff, 'h2');
  assert.equal(launched[0].mode, 'research');
  assert.equal(launched[0].issue, 9);
  assert.deepEqual(out.lines, ['#9 | 진행중 | https://example.test/issues/9']);
});

test('run-research: 실제 launchSession 설정에 --role operator-research, HARNESS_REQUIRE_ROLE=1', async () => {
  const s = setup();
  session(s.run, 'h1', { pid: 111 });
  const fake = `${s.root}/fake-claude.mjs`;
  writeFileSync(fake, 'for await (const c of process.stdin);\nprocess.exit(0);\n');
  const before = process.env.HARNESS_CLAUDE_BIN;
  process.env.HARNESS_CLAUDE_BIN = fake;
  try {
    const out = collect();
    const code = await research(['--issue', '9'], s.env, { ...gh(), write: out.write, timeoutMs: 20000 });
    assert.equal(code, 0);
  } finally {
    if (before === undefined) delete process.env.HARNESS_CLAUDE_BIN; else process.env.HARNESS_CLAUDE_BIN = before;
  }
  const settings = JSON.parse(readFileSync(`${s.run}/handoffs/h2/settings-research.json`, 'utf8'));
  const cmd = settings.hooks.PreToolUse[0].hooks[0].command;
  for (const flag of ['--role operator-research', '--handoff h2', '--issue 9']) {
    assert.equal(cmd.split(flag).length - 1, 1, flag);
  }
  assert.equal(settings.env.HARNESS_REQUIRE_ROLE, '1');
  assert.equal(JSON.parse(readFileSync(`${s.run}/handoffs/h2/session.json`, 'utf8')).mode, 'research');
});

test('run-research: 세션 실패는 보류로 표시하고 종료 코드 1, 시작 실패는 2(재시도 없음)', async () => {
  const s = setup();
  const g = gh('보류');
  const out = collect();
  const code = await research(['--issue', '9'], s.env, { ...g, write: out.write, launchSession: async () => ({ code: 1, timedOut: false }) });
  assert.equal(code, 1);
  assert.deepEqual(g.calls, [[9, '보류']]);
  assert.equal(out.lines.length, 1);

  const s2 = setup();
  let n = 0;
  const out2 = collect();
  const code2 = await research(['--issue', '9'], s2.env, { ...gh(), write: out2.write, launchSession: async () => { n++; return { code: -1, timedOut: false, spawnError: 'ENOENT' }; } });
  assert.equal(code2, 2);
  assert.equal(n, 1);
  assert.equal(out2.lines.length, 1);
  assert.match(out2.lines[0], /^오류: /);
});

test('run-research: 잘못된 인자는 종료 코드 2, 세션을 띄우지 않는다', async () => {
  const bad = [
    [], ['--issue'], ['--issue', '0'], ['--issue', '-1'], ['--issue', '1.5'], ['--issue', '9007199254740993'],
    ['--issue', '1e3'], ['--issue', ' 9'], ['--issue', '9', '--issue', '9'], ['--issue', '9', '--handoff', 'h1'], ['--issues', '9'], ['9'],
  ];
  for (const argv of bad) {
    const s = setup();
    const out = collect();
    let launched = 0;
    const code = await research(argv, s.env, { ...gh(), write: out.write, launchSession: async () => { launched++; return { code: 0 }; } });
    assert.equal(code, 2, JSON.stringify(argv));
    assert.equal(launched, 0);
    assert.equal(out.lines.length, 1);
    assert.ok(!/[\r\n]/.test(out.lines[0]));
  }
});

test('run-research: harness.json이 없으면 2', async () => {
  const s = setup();
  rmSync(`${s.run}/harness.json`);
  const out = collect();
  assert.equal(await research(['--issue', '9'], s.env, { ...gh(), write: out.write, launchSession: async () => ({ code: 0 }) }), 2);
});

test('stop-operator: h1의 pid에만 kill, h1 이름 공간만 정리, 종료 코드 3, h2는 그대로', async () => {
  const s = setup();
  session(s.run, 'h1', { pid: 111, pids: [222, 333], mode: 'work' });
  session(s.run, 'h2', { pid: 444 });
  const killed = [];
  const cleaned = [];
  const out = collect();
  const code = await stop(['--handoff', 'h1'], s.env, {
    write: out.write, probe: () => true,
    kill: (pid) => { killed.push(pid); },
    cleanupHandoff: (o) => { cleaned.push(o); },
  });
  assert.equal(code, 3);
  assert.deepEqual([...killed].sort(), [111, 222, 333]);
  assert.equal(cleaned.length, 1);
  assert.equal(cleaned[0].handoff, 'h1');
  assert.equal(cleaned[0].run, s.run);
  assert.equal(cleaned[0].memo, `${s.root}/memo`);
  assert.ok(existsSync(`${s.run}/handoffs/h2/session.json`));
  assert.equal(out.lines.length, 0);
});

test('stop-operator: 없는 하달 번호는 2, kill과 정리를 하지 않는다', async () => {
  const s = setup();
  session(s.run, 'h1', { pid: 111 });
  let k = 0;
  const out = collect();
  const code = await stop(['--handoff', 'h5'], s.env, { write: out.write, kill: () => { k++; }, cleanupHandoff: () => { k++; } });
  assert.equal(code, 2);
  assert.equal(k, 0);
});

test('stop-operator: --handoff 검증과 중복, 알 수 없는 인자', async () => {
  const bad = [
    [], ['--handoff'], ['--handoff', 'h0'], ['--handoff', 'h01'], ['--handoff', 'H1'], ['--handoff', '1'], ['--handoff', 'h1/../h2'],
    ['--handoff', '../h1'], ['--handoff', 'h1\\x'], ['--handoff', 'h1 '], ['--handoff', 'h1', '--handoff', 'h1'], ['--handoff', 'h1', '--force', 'x'], ['--issue', '9'],
  ];
  for (const argv of bad) {
    const s = setup();
    session(s.run, 'h1', { pid: 111 });
    let k = 0;
    const out = collect();
    const code = await stop(argv, s.env, { write: out.write, kill: () => { k++; }, cleanupHandoff: () => { k++; } });
    assert.equal(code, 2, JSON.stringify(argv));
    assert.equal(k, 0);
    assert.equal(out.lines.length, 1);
  }
});

test('stop-operator: session.json이 없거나 깨졌거나 pid가 올바르지 않으면 2, 정리하지 않는다', async () => {
  const cases = [
    null,
    '{not json',
    '[]',
    'null',
    '{}',
    JSON.stringify({ pid: null }),
    JSON.stringify({ pid: 0 }),
    JSON.stringify({ pid: -5 }),
    JSON.stringify({ pid: '123' }),
    JSON.stringify({ pid: 1.5 }),
    JSON.stringify({ pid: 111, pids: [222, 'x'] }),
    JSON.stringify({ pids: 'nope' }),
  ];
  for (const body of cases) {
    const s = setup();
    if (body === null) mkdirSync(`${s.run}/handoffs/h1`, { recursive: true }); else session(s.run, 'h1', body);
    let k = 0;
    const out = collect();
    const code = await stop(['--handoff', 'h1'], s.env, { write: out.write, kill: () => { k++; }, cleanupHandoff: () => { k++; } });
    assert.equal(code, 2, String(body));
    assert.equal(k, 0, String(body));
    assert.equal(out.lines.length, 1);
    assert.ok(!/[\r\n]/.test(out.lines[0]));
  }
});

test('stop-operator: kill 실패는 보고하고 2, 나머지 pid는 계속 시도하며 정리는 하지 않는다', async () => {
  const s = setup();
  session(s.run, 'h1', { pid: 111, pids: [222, 333] });
  const tried = [];
  let c = 0;
  const out = collect();
  const code = await stop(['--handoff', 'h1'], s.env, {
    write: out.write, probe: () => true,
    kill: (pid) => { tried.push(pid); if (pid === 222) throw new Error('EPERM\n거부'); },
    cleanupHandoff: () => { c++; },
  });
  assert.equal(code, 2);
  assert.deepEqual([...tried].sort(), [111, 222, 333]);
  assert.equal(c, 0);
  assert.equal(out.lines.length, 1);
  assert.match(out.lines[0], /222/);
  assert.ok(!/[\r\n]/.test(out.lines[0]));
});

test('stop-operator: 정리 실패는 삼키지 않고 2', async () => {
  const s = setup();
  session(s.run, 'h1', { pid: 111 });
  const out = collect();
  const code = await stop(['--handoff', 'h1'], s.env, {
    write: out.write,
    kill: () => {},
    cleanupHandoff: () => { throw new Error('정리 실패: 폴더가 남아 있습니다.'); },
  });
  assert.equal(code, 2);
  assert.match(out.lines[0], /정리 실패/);
});

test('stop-operator: 실제 정리가 실패해도(대상이 git 저장소가 아님) h2 작업 폴더는 그대로', async () => {
  const s = setup();
  session(s.run, 'h1', { pid: 111 });
  session(s.run, 'h2', { pid: 444 });
  mkdirSync(`${s.run}/worktrees/h2/issue-1`, { recursive: true });
  const out = collect();
  const code = await stop(['--handoff', 'h1'], s.env, { write: out.write, kill: () => {} });
  assert.equal(code, 2);
  assert.ok(existsSync(`${s.run}/worktrees/h2/issue-1`));
});

// ---- Fix round 1 ----
const marker = (run, h) => `${run}/handoffs/${h}/stopped.json`;

test('stop-operator: kill 전에 중단 표시(stopped.json)를 쓰고, 없는 하달에는 쓰지 않는다', async () => {
  const s = setup();
  session(s.run, 'h1', { pid: 111 });
  const seen = [];
  const out = collect();
  const code = await stop(['--handoff', 'h1'], s.env, {
    write: out.write, cleanupHandoff: () => {},
    kill: () => { seen.push(existsSync(marker(s.run, 'h1'))); },
  });
  assert.equal(code, 3);
  assert.deepEqual(seen, [true]);
  assert.equal(out.lines.length, 0);
  assert.ok(JSON.parse(readFileSync(marker(s.run, 'h1'), 'utf8')).stoppedAt);
  assert.ok(JSON.parse(readFileSync(`${s.run}/handoffs/h1/session.json`, 'utf8')).stoppedAt);

  const s2 = setup();
  await stop(['--handoff', 'h5'], s2.env, { write: () => {}, kill: () => {}, cleanupHandoff: () => {} });
  assert.ok(!existsSync(marker(s2.run, 'h5')));
  assert.ok(!existsSync(`${s2.run}/handoffs/h5`));
});

test('stop-operator: 이미 끝났거나(endedAt) 이미 중단된(stoppedAt) 세션은 kill하지 않고 정리만, 종료 코드 3', async () => {
  for (const extra of [{ endedAt: '2026-01-01T00:00:00Z' }, { stoppedAt: '2026-01-01T00:00:00Z' }]) {
    const s = setup();
    session(s.run, 'h1', { pid: 1002, ...extra });
    let k = 0, c = 0;
    const code = await stop(['--handoff', 'h1'], s.env, { write: () => {}, kill: () => { k++; }, cleanupHandoff: () => { c++; } });
    assert.equal(code, 3);
    assert.equal(k, 0);
    assert.equal(c, 1);
  }
  // 연속 두 번 중단해도 두 번째는 kill하지 않는다.
  const s = setup();
  session(s.run, 'h1', { pid: 1002 });
  let k = 0;
  const deps = { write: () => {}, kill: () => { k++; }, cleanupHandoff: () => {} };
  assert.equal(await stop(['--handoff', 'h1'], s.env, deps), 3);
  assert.equal(await stop(['--handoff', 'h1'], s.env, deps), 3);
  assert.equal(k, 1);
});

test('stop-operator: pid 1, 자기 pid, 부모 pid는 거부, pid는 64개까지', async () => {
  for (const pid of [1, process.pid, process.ppid]) {
    const s = setup();
    session(s.run, 'h1', { pid });
    let k = 0;
    const code = await stop(['--handoff', 'h1'], s.env, { write: () => {}, kill: () => { k++; }, cleanupHandoff: () => { k++; } });
    assert.equal(code, 2, String(pid));
    assert.equal(k, 0);
  }
  const s = setup();
  session(s.run, 'h1', { pids: Array.from({ length: 65 }, (_, i) => 100000 + i) });
  let k = 0;
  assert.equal(await stop(['--handoff', 'h1'], s.env, { write: () => {}, kill: () => { k++; }, cleanupHandoff: () => { k++; } }), 2);
  assert.equal(k, 0);
});

test('defaultKill(win32): 트리째 죽이는 중이라 taskkill이 실패해도 그 pid가 이미 없으면 성공으로 본다(run-18 h11)', () => {
  // 오퍼레이터를 /T로 먼저 죽이면 같은 트리의 워커도 끝나는 중이고, 바로 이어 부른 taskkill은 1로 끝날 수 있다.
  const seq = (lists) => { let i = 0; return (file) => { if (/tasklist/i.test(file)) return lists[Math.min(i++, lists.length - 1)]; const e = new Error('Command failed: taskkill'); e.status = 1; throw e; }; };
  const node = '"node.exe","45808","Console","1","30,000 K"';
  const none = 'INFO: No tasks are running which match the specified criteria.';
  defaultKill(45808, { platform: 'win32', exec: seq([node, none]) });
  assert.throws(() => defaultKill(45808, { platform: 'win32', exec: seq([node, node]) }), /taskkill/);
});

test('defaultKill(win32): tasklist 이미지 이름이 node/claude일 때만 taskkill, 다르면 거부, 없으면 통과', () => {
  const calls = [];
  const mk = (stdout) => (file, args) => { calls.push([file, args]); return file.toLowerCase().includes('tasklist') ? stdout : ''; };
  defaultKill(4242, { platform: 'win32', exec: mk('"node.exe","4242","Console","1","30,000 K"\r\n') });
  assert.ok(calls.some(([f]) => /taskkill/i.test(f)));
  assert.deepEqual(calls[0][1], ['/FI', 'PID eq 4242', '/FO', 'CSV', '/NH']);

  calls.length = 0;
  assert.throws(() => defaultKill(4242, { platform: 'win32', exec: mk('"chrome.exe","4242","Console","1","30,000 K"\r\n') }), /chrome\.exe/);
  assert.ok(!calls.some(([f]) => /taskkill/i.test(f)));

  calls.length = 0;
  defaultKill(4242, { platform: 'win32', exec: mk('INFO: No tasks are running which match the specified criteria.\r\n') });
  assert.ok(!calls.some(([f]) => /taskkill/i.test(f)));
  defaultKill(4242, { platform: 'win32', exec: mk('"claude.exe","4242","Console","1","30,000 K"\r\n') });
  assert.ok(calls.some(([f]) => /taskkill/i.test(f)));
});

test('stop-operator: 이미지 불일치로 kill이 거부되면 2, 정리하지 않는다', async () => {
  const s = setup();
  session(s.run, 'h1', { pid: 4242 });
  let c = 0;
  const out = collect();
  const code = await stop(['--handoff', 'h1'], s.env, {
    write: out.write, cleanupHandoff: () => { c++; },
    kill: () => { throw new Error('pid 4242의 이미지가 chrome.exe입니다'); },
  });
  assert.equal(code, 2);
  assert.equal(c, 0);
  assert.match(out.lines[0], /4242/);
});

test('stop-operator: 실제 정리가 h1 브랜치와 작업 폴더를 지우고 h2는 남긴다', async () => {
  const s = setup();
  const memo = `${s.root}/memo`;
  const git = (...a) => execFileSync('git', ['-C', memo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'pipe', encoding: 'utf8' });
  mkdirSync(memo, { recursive: true });
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  for (const h of ['h1', 'h2']) {
    session(s.run, h, { pid: h === 'h1' ? 111 : 444 });
    git('worktree', 'add', '-q', '-b', `integration/${h}`, `${s.run}/worktrees/${h}/integration`);
    git('worktree', 'add', '-q', '-b', `${h}/issue-1`, `${s.run}/worktrees/${h}/issue-1`);
  }
  const out = collect();
  const code = await stop(['--handoff', 'h1'], s.env, { write: out.write, kill: () => {} });
  assert.equal(code, 3, out.lines.join('|'));
  assert.ok(!existsSync(`${s.run}/worktrees/h1`));
  assert.ok(existsSync(`${s.run}/worktrees/h2/issue-1`));
  const branches = git('for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean);
  assert.ok(branches.includes('h2/issue-1') && branches.includes('integration/h2'));
  assert.ok(!branches.some((b) => b.includes('h1')));
});

test('run-operator: 중단 표시가 있으면 재시작하지 않고 정리와 보류 표시 없이 종료 코드 3', async () => {
  const s = setup();
  const g = gh();
  let launches = 0, cleans = 0;
  const out = collect();
  const code = await work(['--issues', '7'], s.env, {
    ...g, write: out.write,
    cleanupHandoff: () => { cleans++; },
    launchSession: async (o) => {
      launches++;
      writeFileSync(marker(o.run, o.handoff), JSON.stringify({ stoppedAt: new Date().toISOString() }));
      return { code: 1, timedOut: false };
    },
  });
  assert.equal(code, 3);
  assert.equal(launches, 1);
  assert.equal(cleans, 0);
  assert.deepEqual(g.calls, []);
  assert.equal(out.lines.length, 0);

  // 이미 중단된 하달을 --handoff로 이어받으려 하면 시작하지 않는다.
  const s2 = setup();
  mkdirSync(`${s2.run}/handoffs/h1`, { recursive: true });
  writeFileSync(marker(s2.run, 'h1'), JSON.stringify({ stoppedAt: 'x' }));
  let n = 0;
  // stop-operator가 이름 공간을 이미 지웠다고 보고 I3 확인(handoffHasWork)은 실제 git 대신 대역으로 둔다(이 시험의 memo는 git 저장소가 아니다).
  const code2 = await work(['--issues', '7', '--handoff', 'h1'], s2.env, { ...gh(), write: () => {}, cleanupHandoff: () => {}, handoffHasWork: () => false, launchSession: async () => { n++; return { code: 0 }; } });
  assert.equal(code2, 3);
  assert.equal(n, 0);
});

test('run-research: 세션 중 중단 표시가 생기면 보류 표시 없이 종료 코드 3', async () => {
  const s = setup();
  const g = gh();
  const out = collect();
  const code = await research(['--issue', '9'], s.env, {
    ...g, write: out.write,
    launchSession: async (o) => { writeFileSync(marker(o.run, o.handoff), '{}'); return { code: 1, timedOut: false }; },
  });
  assert.equal(code, 3);
  assert.deepEqual(g.calls, []);
  assert.equal(out.lines.length, 0);
});

test('launchSession: session.json에 driverPid, 끝나면 endedAt', async () => {
  const s = setup();
  const fake = `${s.root}/fake-claude2.mjs`;
  writeFileSync(fake, 'for await (const c of process.stdin);\nprocess.exit(0);\n');
  const before = process.env.HARNESS_CLAUDE_BIN;
  process.env.HARNESS_CLAUDE_BIN = fake;
  try {
    assert.equal(await research(['--issue', '9'], s.env, { ...gh(), write: () => {}, timeoutMs: 20000 }), 0);
  } finally {
    if (before === undefined) delete process.env.HARNESS_CLAUDE_BIN; else process.env.HARNESS_CLAUDE_BIN = before;
  }
  const j = JSON.parse(readFileSync(`${s.run}/handoffs/h1/session.json`, 'utf8'));
  assert.equal(j.driverPid, process.pid);
  assert.ok(!Number.isNaN(Date.parse(j.endedAt)));
});

// ---- Fix round 2 ----
test('run-operator: 정리 중에 중단 표시가 생기면(재시작 틈) 두 번째 세션을 띄우지 않는다', async () => {
  const s = setup();
  const g = gh();
  let launches = 0;
  const code = await work(['--issues', '7'], s.env, {
    ...g, write: () => {},
    cleanupHandoff: (o) => { writeFileSync(marker(o.run, o.handoff), '{}'); },
    launchSession: async () => { launches++; return { code: 1, timedOut: false }; },
  });
  assert.equal(code, 3);
  assert.equal(launches, 1);
  assert.deepEqual(g.calls, []);
});

test('run-operator: 마지막 시도 중에 생긴 중단 표시도 보류 표시 없이 종료 코드 3', async () => {
  const s = setup();
  const g = gh();
  let launches = 0, cleans = 0;
  const out = collect();
  const code = await work(['--issues', '7'], s.env, {
    ...g, write: out.write,
    cleanupHandoff: () => { cleans++; },
    launchSession: async (o) => {
      launches++;
      if (launches === 2) writeFileSync(marker(o.run, o.handoff), '{}');
      return { code: 1, timedOut: false };
    },
  });
  assert.equal(code, 3);
  assert.equal(launches, 2);
  assert.equal(cleans, 1);
  assert.deepEqual(g.calls, []);
  assert.equal(out.lines.length, 0);
});

test('launchSession: session.json을 쓴 직후 중단 표시가 있으면 자기 자식을 종료한다', { timeout: 5000 }, async () => {
  const s = setup();
  mkdirSync(`${s.run}/handoffs/h1`, { recursive: true });
  writeFileSync(marker(s.run, 'h1'), '{}');
  const child = new EventEmitter();
  let killed = 0;
  Object.assign(child, {
    pid: 987654, stdout: null, stderr: null,
    stdin: Object.assign(new EventEmitter(), { end() {} }),
    kill() { killed++; setImmediate(() => child.emit('close', null, 'SIGTERM')); },
  });
  const r = await launchSession(
    { mode: 'research', handoff: 'h1', run: s.run, harnessDir: s.harnessDir, issue: 9, prompt: 'x', timeoutMs: 0 },
    { spawn: () => child, killTree: () => {} },
  );
  assert.equal(killed, 1);
  assert.notEqual(r.code, 0);
  assert.equal(JSON.parse(readFileSync(`${s.run}/handoffs/h1/session.json`, 'utf8')).pid, 987654);
});

test('stop-operator: 종료 도중 session.json에 새 pid가 생기면(재시작) 지우지 않고 그 pid도 종료한다', async () => {
  const s = setup();
  session(s.run, 'h1', { pid: 1111, startedAt: 'a' });
  const killed = [];
  const code = await stop(['--handoff', 'h1'], s.env, {
    write: () => {}, cleanupHandoff: () => {},
    kill: (pid) => {
      killed.push(pid);
      if (pid === 1111) writeFileSync(`${s.run}/handoffs/h1/session.json`, JSON.stringify({ pid: 2222, startedAt: 'b' }));
    },
  });
  assert.equal(code, 3);
  assert.deepEqual(killed, [1111, 2222]);
  const j = JSON.parse(readFileSync(`${s.run}/handoffs/h1/session.json`, 'utf8'));
  assert.equal(j.pid, 2222);
  assert.ok(j.stoppedAt);
});

// ---- Fix round 3 ----
test('stop-operator: pid 검증 등으로 kill 전에 실패하면(종료 코드 2) 이번 호출이 만든 중단 표시는 지운다', async () => {
  const bodies = [null, '{broken', JSON.stringify({ pid: null }), JSON.stringify({ pid: 'x' }), JSON.stringify({ pids: Array.from({ length: 65 }, (_, i) => 100000 + i) })];
  for (const body of bodies) {
    const s = setup();
    if (body === null) mkdirSync(`${s.run}/handoffs/h1`, { recursive: true }); else session(s.run, 'h1', body);
    const code = await stop(['--handoff', 'h1'], s.env, { write: () => {}, kill: () => {}, cleanupHandoff: () => {} });
    assert.equal(code, 2, String(body));
    assert.ok(!existsSync(marker(s.run, 'h1')), String(body));
  }
});

test('stop-operator: 이전에 있던 중단 표시는 실패해도 지우지 않는다', async () => {
  const s = setup();
  session(s.run, 'h1', '{broken');
  writeFileSync(marker(s.run, 'h1'), '{"stoppedAt":"old"}');
  assert.equal(await stop(['--handoff', 'h1'], s.env, { write: () => {}, kill: () => {}, cleanupHandoff: () => {} }), 2);
  assert.ok(existsSync(marker(s.run, 'h1')));
});

test('stop-operator: 시작 실패로 끝난 세션(pid null + endedAt)은 kill 없이 정리하고 종료 코드 3', async () => {
  const s = setup();
  session(s.run, 'h1', { pid: null, endedAt: '2026-01-01T00:00:00Z' });
  let k = 0, c = 0;
  const code = await stop(['--handoff', 'h1'], s.env, { write: () => {}, kill: () => { k++; }, cleanupHandoff: () => { c++; } });
  assert.equal(code, 3);
  assert.equal(k, 0);
  assert.equal(c, 1);
  assert.ok(existsSync(marker(s.run, 'h1')));
});

test('stop-operator: 중단 표시는 session.json을 읽기 전에 쓴다(훅으로 순서 확인)', async () => {
  const s = setup();
  session(s.run, 'h1', { pid: 1111 });
  const killed = [];
  let markerAtHook = null;
  const code = await stop(['--handoff', 'h1'], s.env, {
    write: () => {}, cleanupHandoff: () => {}, kill: (p) => { killed.push(p); },
    afterMarker: () => {
      markerAtHook = existsSync(marker(s.run, 'h1'));
      writeFileSync(`${s.run}/handoffs/h1/session.json`, JSON.stringify({ pid: 2222 }));
    },
  });
  assert.equal(code, 3);
  assert.equal(markerAtHook, true);
  assert.deepEqual(killed, [2222]);
});
test('stop 보강: pid 64개는 허용, 이미지 nodemon.exe는 거부, tasklist는 System32 전체 경로', () => {
  const calls = [];
  const exec = (file, args) => { calls.push(file); return file.toLowerCase().includes('tasklist') ? '"nodemon.exe","5","Console","1","1 K"' : ''; };
  assert.throws(() => defaultKill(5, { platform: 'win32', exec }), /nodemon/);
  assert.match(calls[0], /System32[\\/]tasklist\.exe$/i);
});

test('stop-operator: pid 64개는 통과', async () => {
  const s = setup();
  session(s.run, 'h1', { pids: Array.from({ length: 64 }, (_, i) => 100000 + i) });
  let k = 0;
  assert.equal(await stop(['--handoff', 'h1'], s.env, { write: () => {}, probe: () => true, kill: () => { k++; }, cleanupHandoff: () => {} }), 3);
  assert.equal(k, 64);
});

test('stop-operator: 오퍼레이터가 끝났어도(endedAt) pids의 살아 있는 워커 pid는 kill한다', async () => {
  const s = setup();
  session(s.run, 'h1', { pid: 1002, endedAt: '2026-01-01T00:00:00Z', pids: [3003, 3004] });
  const killed = [];
  const code = await stop(['--handoff', 'h1'], s.env, { write: () => {}, probe: () => true, kill: (p) => { killed.push(p); }, cleanupHandoff: () => {} });
  assert.equal(code, 3);
  assert.deepEqual(killed, [3003, 3004]);
  const s2 = setup();
  session(s2.run, 'h1', { pid: null, endedAt: '2026-01-01T00:00:00Z', pids: [1] });
  assert.equal(await stop(['--handoff', 'h1'], s2.env, { write: () => {}, kill: () => {}, cleanupHandoff: () => {} }), 2);
  const s3 = setup();
  session(s3.run, 'h1', { pid: 1002, stoppedAt: '2026-01-01T00:00:00Z', pids: [3003] });
  let k = 0;
  assert.equal(await stop(['--handoff', 'h1'], s3.env, { write: () => {}, kill: () => { k++; }, cleanupHandoff: () => {} }), 3);
  assert.equal(k, 0);
});

test('stop-operator: pids의 죽은 pid는 다시 확인해 kill하지 않는다(오퍼레이터 pid는 그대로)', async () => {
  const s = setup();
  session(s.run, 'h1', { pid: 1002, pids: [3003, 3004] });
  const killed = [];
  const code = await stop(['--handoff', 'h1'], s.env, { write: () => {}, probe: (p) => p === 3004, kill: (p) => { killed.push(p); }, cleanupHandoff: () => {} });
  assert.equal(code, 3);
  assert.deepEqual(killed, [1002, 3004]);
});

test('run-research: 라벨 없는 조사 이슈도 보고하고(라벨 없음), 세션 전에 라벨을 보장한다', async () => {
  const s = setup();
  const out = collect();
  const order = [];
  const g = gh('라벨 없음');
  g.ensureLabels = async () => { order.push('labels'); };
  const code = await research(['--issue', '9'], s.env, { ...g, write: out.write, launchSession: async () => { order.push('launch'); return { code: 0, timedOut: false }; } });
  assert.equal(code, 0);
  assert.deepEqual(order, ['labels', 'launch']);
  assert.deepEqual(out.lines, ['#9 | 라벨 없음 | https://example.test/issues/9']);
});
