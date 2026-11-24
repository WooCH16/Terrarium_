// run-7 결함: 하달이 Bash 도구의 10분 제한에 끊겼다. 분리 실행과 이어서 기다리기.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { main as waitMain } from '../operator/wait-operator.mjs';
import { decide } from '../policy.mjs';
import { startAndWait, writeBg, askHandlers } from '../operator/background.mjs';

const fwd = (p) => p.split(String.fromCharCode(92)).join('/');
const made = [];
after(() => { for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 무시 */ } } });
const bg = pathToFileURL(fileURLToPath(new URL('../operator/background.mjs', import.meta.url))).href;

// 가짜 스크립트: FAKE_SLEEP_MS 동안 자고 줄 하나와 종료 코드 1을 낸다(run-operator의 진입점과 같은 모양).
const FAKE = `
import { fileURLToPath } from 'node:url';
const { cliEntry } = await import(${JSON.stringify(bg)});
const main = async (argv, env, deps = {}) => {
  const write = deps.write ?? ((l) => console.log(l));
  await new Promise((r) => setTimeout(r, Number(env.FAKE_SLEEP_MS)));
  write('#7 | 막힘 | https://x/7 args=' + argv.join(' '));
  return 1;
};
process.exitCode = await cliEntry({ main, entry: fileURLToPath(import.meta.url), record: process.env.FAKE_RECORD || false, detachable: process.env.FAKE_DETACHABLE === '1' });
`;

function setup() {
  const run = fwd(mkdtempSync(`${fwd(tmpdir())}/bg-`));
  made.push(run);
  writeFileSync(`${run}/harness.json`, JSON.stringify({ harnessDir: 'C:/h' }));
  mkdirSync(`${run}/handoffs`, { recursive: true });
  const fake = `${run}/fake-entry.mjs`;
  writeFileSync(fake, FAKE);
  const exec = (env) => spawnSync(process.execPath, [fake, '--issues', '7'], { cwd: run, encoding: 'utf8', env: { ...process.env, HARNESS_RUN_DIR: run, HARNESS_FOREGROUND: '', ...env } });
  return { run, exec };
}

test('run-7: 기다리는 시간 안에 끝나면 원래 출력 줄과 종료 코드를 그대로 낸다', () => {
  const s = setup();
  const r = s.exec({ FAKE_SLEEP_MS: '10', HARNESS_BG_WAIT_MS: '20000' });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stdout.trim(), '#7 | 막힘 | https://x/7 args=--issues 7');
});

test('run-7: 안 끝나면 대기 번호와 종료 코드 8, wait-operator로 이어서 기다려 결과를 받는다', async () => {
  const s = setup();
  const r = s.exec({ FAKE_SLEEP_MS: '2500', HARNESS_BG_WAIT_MS: '100' });
  assert.equal(r.status, 8, r.stderr);
  const m = /^진행 중: 대기 번호 ([0-9a-f]{12}) \| 이어서 기다리기: node C:\/h\/operator\/wait-operator\.mjs --wait \1$/.exec(r.stdout.trim());
  assert.ok(m, r.stdout);
  const out = [];
  const early = await waitMain(['--wait', m[1]], { HARNESS_RUN_DIR: s.run }, { write: (l) => out.push(l), waitMs: 50, pollMs: 20 });
  assert.equal(early, 8);
  out.length = 0;
  const code = await waitMain(['--wait', m[1]], { HARNESS_RUN_DIR: s.run }, { write: (l) => out.push(l), waitMs: 20000, pollMs: 50 });
  assert.equal(code, 1);
  assert.deepEqual(out, ['#7 | 막힘 | https://x/7 args=--issues 7']);
});

test('run-18 h7: 코디네이터가 띄운 실행만 last-wait.json에 대기 번호를 남긴다(워커 실행은 남기지 않는다)', () => {
  const w = setup();
  const r1 = w.exec({ FAKE_SLEEP_MS: '2500', HARNESS_BG_WAIT_MS: '100' });
  assert.equal(r1.status, 8, r1.stderr);
  assert.equal(existsSync(`${w.run}/handoffs/last-wait.json`), false);
  const c = setup();
  const r2 = c.exec({ FAKE_SLEEP_MS: '2500', HARNESS_BG_WAIT_MS: '100', FAKE_RECORD: 'last-wait' });
  assert.equal(r2.status, 8, r2.stderr);
  const token = /대기 번호 ([0-9a-f]{12})/.exec(r2.stdout)[1];
  const last = JSON.parse(readFileSync(`${c.run}/handoffs/last-wait.json`, 'utf8'));
  assert.equal(last.token, token);
  assert.equal(last.script, 'fake-entry.mjs');
  assert.deepEqual(last.args, ['--issues', '7']);
});

test('--detach yes(워커 동시 실행): 기다리지 않고 바로 대기 번호(8)를 내고, 자식에게는 --detach를 넘기지 않으며, wait-operator로 결과를 받는다', async () => {
  const s = setup();
  const started = Date.now();
  const spawnArgs = (extra) => spawnSync(process.execPath, [`${s.run}/fake-entry.mjs`, '--issues', '7', ...extra], { cwd: s.run, encoding: 'utf8', env: { ...process.env, HARNESS_RUN_DIR: s.run, HARNESS_FOREGROUND: '', FAKE_SLEEP_MS: '2500', HARNESS_BG_WAIT_MS: '20000', FAKE_DETACHABLE: '1' } });
  const r = spawnArgs(['--detach', 'yes']);
  assert.equal(r.status, 8, r.stderr);
  assert.ok(Date.now() - started < 2000, `기다리지 않는다(${Date.now() - started}ms)`);
  const token = /대기 번호 ([0-9a-f]{12})/.exec(r.stdout)[1];
  const out = [];
  const code = await waitMain(['--wait', token], { HARNESS_RUN_DIR: s.run }, { write: (l) => out.push(l), waitMs: 20000, pollMs: 50 });
  assert.equal(code, 1);
  assert.deepEqual(out, ['#7 | 막힘 | https://x/7 args=--issues 7'], '--detach는 자식에게 가지 않는다');
  // detachable이 아닌 스크립트(run-operator 등)에서는 알 수 없는 인자 그대로 main에 간다
  const plain = spawnSync(process.execPath, [`${s.run}/fake-entry.mjs`, '--issues', '7', '--detach', 'yes'], { cwd: s.run, encoding: 'utf8', env: { ...process.env, HARNESS_RUN_DIR: s.run, HARNESS_FOREGROUND: '1', FAKE_SLEEP_MS: '10' } });
  assert.match(plain.stdout, /args=--issues 7 --detach yes/);
});

test('CI 흔들림: 발사 프로세스가 자식 pid를 먼저 써도 부모가 끝난 발사 pid로 덮어 "죽음"(2)으로 보지 않는다', async () => {
  const s = setup();
  const DEAD = 99999999; // 없는 pid: 이미 끝난 발사 프로세스
  // 가짜 spawn: 발사 프로세스가 부모보다 먼저 자식(살아 있는 이 프로세스) pid를 써 버린 순서를 만든다.
  const spawn = (_bin, args) => { writeBg(s.run, args[2], { done: false, pid: process.pid, startedAt: new Date().toISOString() }); return { pid: DEAD, on() {}, unref() {} }; };
  const out = [];
  const code = await startAndWait({ run: s.run, harnessDir: 'C:/h', entry: 'x.mjs', args: [], env: { HARNESS_BG_WAIT_MS: '100' }, write: (l) => out.push(l), spawn });
  assert.equal(code, 8, out.join('\n'));
});

test('run-7: wait-operator는 모르는 번호·잘못된 인자를 2로 거부한다', async () => {
  const s = setup();
  const out = [];
  assert.equal(await waitMain(['--wait', 'abcdefabcdef'], { HARNESS_RUN_DIR: s.run }, { write: (l) => out.push(l) }), 2);
  assert.equal(await waitMain(['--wait', '../x'], { HARNESS_RUN_DIR: s.run }, { write: (l) => out.push(l) }), 2);
  assert.equal(await waitMain([], { HARNESS_RUN_DIR: s.run }, { write: (l) => out.push(l) }), 2);
});

test('run-7: 코디네이터는 wait-operator.mjs --wait <12자리>만 실행할 수 있다', () => {
  const config = { harnessDir: 'C:/h', runDir: 'C:/run', issuesClone: 'C:/run/issues', targetProject: 'C:/run/memo', designatedRepo: 'o/r' };
  const bash = (command) => decide({ tool_name: 'Bash', tool_input: { command }, cwd: 'C:/run/issues' }, config, { visibility: () => 'PRIVATE', readFile: () => { throw new Error('x'); } });
  assert.equal(bash('node C:/h/operator/wait-operator.mjs --wait 0123456789ab').allow, true);
  for (const c of ['node C:/h/operator/wait-operator.mjs --wait 0123', 'node C:/h/operator/wait-operator.mjs', 'node C:/h/operator/wait-operator.mjs --wait 0123456789ab --x y']) assert.equal(bash(c).allow, false, c);
});

// ---------- 살아 있는 질문(결정 8-39): 워커가 오퍼레이터의 답을 기다리면 기다리는 쪽이 바로 알린다(종료 코드 5) ----------
test('질문 중: 대기 기록에 답을 기다리는 질문이 있으면 wait-operator가 바로 5와 질문·답 파일·이어서 기다리기를 낸다', async () => {
  const s = setup();
  const token = '0123456789ab';
  const asking = { id: '1-1', kind: '질문', issue: 7, question: 'worktrees/h1/issue-7/.harness/asking.md', answer: `${s.run}/issues/.drafts/answer-7-h1-q1-1.md` };
  writeBg(s.run, token, { done: false, pid: process.pid, startedAt: new Date().toISOString(), asking });
  const out = [];
  const t0 = Date.now();
  const code = await waitMain(['--wait', token], { HARNESS_RUN_DIR: s.run, HARNESS_BG_WAIT_MS: '20000' }, { write: (l) => out.push(l), pollMs: 50 });
  assert.equal(code, 5, out.join('\n'));
  assert.ok(Date.now() - t0 < 5000, '기다리지 않고 바로');
  assert.equal(out.length, 1);
  assert.match(out[0], /^질문 중: 이슈 #7 /);
  assert.ok(out[0].includes(`${s.run}/worktrees/h1/issue-7/.harness/asking.md`), out[0]);
  assert.ok(out[0].includes(asking.answer), out[0]);
  assert.ok(out[0].includes(`wait-operator.mjs --wait ${token}`), out[0]);
});

test('질문 중: 답 파일을 이미 썼으면 다시 5를 내지 않고 계속 기다린다', async () => {
  const s = setup();
  const token = '0123456789ac';
  mkdirSync(`${s.run}/issues/.drafts`, { recursive: true });
  const answer = `${s.run}/issues/.drafts/answer-7-h1-q1-1.md`;
  writeFileSync(answer, '파랑');
  writeBg(s.run, token, { done: false, pid: process.pid, startedAt: new Date().toISOString(), asking: { id: '1-1', kind: '질문', issue: 7, question: 'q', answer } });
  const out = [];
  assert.equal(await waitMain(['--wait', token], { HARNESS_RUN_DIR: s.run, HARNESS_BG_WAIT_MS: '300' }, { write: (l) => out.push(l), pollMs: 50 }), 8, out.join('\n'));
});

test('질문 알림: onAsk는 pid·startedAt을 남긴 채 질문을 더하고, onAnswered는 질문만 지운다(끝난 기록은 건드리지 않는다)', () => {
  const s = setup();
  const token = '0123456789ad';
  writeBg(s.run, token, { done: false, pid: 4242, startedAt: '2026-11-24T00:00:00.000Z' });
  const h = askHandlers(s.run, token);
  h.onAsk({ id: '1-1', kind: '질문', issue: 7, question: 'q', answer: 'a' });
  let d = JSON.parse(readFileSync(`${s.run}/handoffs/bg/${token}.json`, 'utf8'));
  assert.equal(d.pid, 4242);
  assert.equal(d.startedAt, '2026-11-24T00:00:00.000Z');
  assert.equal(d.asking.issue, 7);
  h.onAnswered();
  d = JSON.parse(readFileSync(`${s.run}/handoffs/bg/${token}.json`, 'utf8'));
  assert.equal(d.asking, undefined);
  assert.equal(d.pid, 4242);
  writeBg(s.run, token, { done: true, pid: 4242, lines: ['x'], code: 0 });
  h.onAsk({ id: '1-2', kind: '질문', issue: 7, question: 'q', answer: 'a' });
  assert.equal(JSON.parse(readFileSync(`${s.run}/handoffs/bg/${token}.json`, 'utf8')).asking, undefined, '끝난 기록에는 질문을 더하지 않는다');
});