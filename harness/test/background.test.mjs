// run-7 결함: 하달이 Bash 도구의 10분 제한에 끊겼다. 분리 실행과 이어서 기다리기.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { main as waitMain } from '../operator/wait-operator.mjs';
import { decide } from '../policy.mjs';

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
process.exitCode = await cliEntry({ main, entry: fileURLToPath(import.meta.url) });
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
