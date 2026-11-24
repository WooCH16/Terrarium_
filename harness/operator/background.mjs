// 오래 걸리는 스크립트(run-operator, run-research)를 분리된 프로세스로 띄우고, 정해진 시간까지만 기다린다.
// 코디네이터의 Bash 호출은 Claude Code가 10분에서 끊는다(2026-11-19 run-7에서 하달이 [killed]로 끊김). 하달은 2시간까지 걸린다.
// - 부모: 자식을 띄우고 waitMs(기본 9분) 동안 결과 파일을 본다. 끝났으면 자식의 출력 줄과 종료 코드를 그대로 낸다.
//   안 끝났으면 `진행 중: 대기 번호 <번호> | 이어서 기다리기: node <하네스>/operator/wait-operator.mjs --wait <번호>` 한 줄과 종료 코드 8.
// - 자식: 원래 main()을 돌리고 출력 줄과 종료 코드를 <실행 폴더>/handoffs/bg/<번호>.json에 쓴다(코디네이터 훅이 쓰기를 막는 폴더).
// - wait-operator.mjs --wait <번호>: 같은 결과 파일을 다시 waitMs 동안 본다.
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';

export const WAITING = 8;
export const TOKEN = /^[0-9a-f]{12}$/;
const DEFAULT_WAIT_MS = 9 * 60 * 1000;
const MAX_LIFE_MS = 8 * 60 * 60 * 1000;
const fwd = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
const fileOf = (run, token) => `${fwd(run)}/handoffs/bg/${token}.json`;

export function waitMsOf(env) {
  const v = Number(env.HARNESS_BG_WAIT_MS);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_WAIT_MS;
}

export function writeBg(run, token, data) {
  const f = fileOf(run, token);
  mkdirSync(`${fwd(run)}/handoffs/bg`, { recursive: true });
  // 임시 파일은 프로세스마다 따로: 발사 프로세스와 자식이 거의 같은 순간에 쓰면 같은 .tmp를 서로 덮고 한쪽 rename이 실패했다.
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  // Windows에서는 기다리는 쪽이 파일을 읽는 순간 교체가 EPERM·EBUSY로 실패할 수 있다: 잠깐 쉬고 다시 한다.
  for (let i = 0; ; i++) {
    try { renameSync(tmp, f); return; } catch (e) {
      if (i >= 50 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

// record: 하달(run-operator)은 last-wait.json, 조사(run-research)는 last-wait-research.json. 조사는 하달 중에도 띄우므로 파일을 나눈다.
export const lastWaitFile = (run, record = 'last-wait') => `${fwd(run)}/handoffs/${record}.json`;

export function writeLastWait(run, record, data) {
  const f = lastWaitFile(run, record);
  mkdirSync(`${fwd(run)}/handoffs`, { recursive: true });
  writeFileSync(`${f}.tmp`, JSON.stringify(data));
  renameSync(`${f}.tmp`, f);
}

export function readBg(run, token) {
  const f = fileOf(run, token);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 결과를 waitMs 동안 기다린다. 끝났으면 { done: true, lines, code }, 자식이 결과 없이 죽었으면 { dead: true }, 아니면 { done: false }.
// launcherPid: 파일에 아직 pid가 없을 때(발사 프로세스가 자식 pid를 쓰기 전) 대신 볼 발사 프로세스의 pid.
export async function waitFor(run, token, { waitMs, pollMs = 1000, now = () => Date.now(), launcherPid = null } = {}) {
  const until = now() + waitMs;
  for (;;) {
    const d = readBg(run, token);
    if (d?.done) return { done: true, lines: d.lines ?? [], errLines: d.errLines ?? [], code: d.code };
    // 전체 기한: 세션 제한(2시간) + 워커 시도를 넘겨도 끝나지 않으면 죽은 것으로 본다(pid 재사용 대비).
    if (d?.startedAt && Date.now() - new Date(d.startedAt).getTime() > MAX_LIFE_MS) return { dead: true };
    const pid = d?.pid ?? launcherPid;
    if (pid && !alive(pid)) {
      // 결과를 쓰고 죽는 틈이거나, 발사 프로세스가 자식 pid를 막 쓰고 끝난 틈일 수 있다: 잠깐 뒤 한 번 더 읽는다.
      await sleep(500);
      const again = readBg(run, token);
      if (again?.done) return { done: true, lines: again.lines ?? [], errLines: again.errLines ?? [], code: again.code };
      if (again?.pid && again.pid !== pid && alive(again.pid)) continue;
      return { dead: true };
    }
    if (now() >= until) return { done: false };
    await sleep(pollMs);
  }
}

export function report(r, { token, harnessDir, write, writeErr = (l) => console.error(l) }) {
  if (r.done) { for (const l of r.lines) write(l); for (const l of r.errLines ?? []) writeErr(l); return r.code; }
  if (r.dead) { write(`오류: 분리 실행(대기 번호 ${token})이 결과 없이 끝났습니다. 실행 폴더의 logs/와 handoffs/를 확인하세요.`); return 2; }
  write(`진행 중: 대기 번호 ${token} | 이어서 기다리기: node ${fwd(harnessDir)}/operator/wait-operator.mjs --wait ${token}`);
  return WAITING;
}

// 부모 쪽: entry를 --bg-token과 함께 분리 실행하고 기다린다.
export async function startAndWait({ run, harnessDir, entry, args, env = process.env, write = (l) => console.log(l), spawn = nodeSpawn, record = false }) {
  const token = randomBytes(6).toString('hex');
  // Windows에서 detached가 아니면 Node(libuv)가 자식을 작업 객체에 넣어 부모가 끝날 때 같이 죽인다(run-8에서 재현). 그래서 detached로 띄운다.
  // 그런데 detached 프로세스는 콘솔이 없어, 그 아래에서 부르는 git이 가끔 콘솔 닫힘(0xC000013A)으로 죽는다.
  // 그래서 detached 자식(--bg-token)은 숨은 콘솔을 가진 손자(--bg-run)를 하나 띄워 기다리기만 하고, 일은 손자가 한다.
  // 바로 detached 자식을 띄우지 않고, 띄우기만 하고 곧 끝나는 발사 프로세스(--bg-launch)를 거친다.
  // 코디네이터가 Esc로 턴을 끊으면 Claude Code가 이 부모의 프로세스 트리를 통째로 끝낸다. detached여도 부모가 살아 있으면
  // 트리에 걸려 하달이 같이 죽었다(run-18 h5, 2026-11-20). 발사 프로세스가 먼저 끝나면 detached 자식은 부모 없는 프로세스가 되어 트리 밖에 있다.
  // 첫 기록은 발사 전에 쓴다(pid 없음). 발사 뒤에 쓰면, 발사 프로세스가 이미 자식 pid를 써 둔 것을 끝난 발사 pid로 덮어
  // 기다리는 쪽이 "결과 없이 죽음"(2)으로 볼 수 있었다(CI에서 흔들림, 2026-11-24). 발사 pid는 메모리로만 넘겨,
  // 자식이 자기 기록을 쓰기 전에 죽어도 기다리는 쪽이 알아챈다(fable 조언 2).
  const startedAt = new Date().toISOString();
  writeBg(run, token, { done: false, pid: null, startedAt });
  const launcher = spawn(process.execPath, [entry, '--bg-launch', token, ...args], { cwd: process.cwd(), env, detached: true, stdio: 'ignore', windowsHide: true });
  launcher.on?.('error', () => {});
  // 코디네이터가 띄운 하달·조사만 대기 번호를 고정 파일에 남긴다(record). 오퍼레이터가 부르는 run-worker도 같은 bg 폴더에 쓰므로,
  // "가장 최근 bg 파일"로 찾으면 워커의 번호를 잡는다(run-18 h7, 2026-11-20). Esc 뒤 코디네이터는 이 파일 하나만 읽는다.
  if (record) writeLastWait(run, record, { token, script: basename(entry), args, startedAt });
  launcher.unref?.();
  return report(await waitFor(run, token, { waitMs: waitMsOf(env), launcherPid: launcher.pid ?? null }), { token, harnessDir, write });
}

// 발사 프로세스: detached 자식을 띄우고, 기다리는 쪽이 볼 pid를 자식 것으로 바꿔 쓴 뒤 바로 끝난다.
export function runLauncher({ run, token, entry, argv, env, spawn = nodeSpawn }) {
  const child = spawn(process.execPath, [entry, '--bg-token', token, ...argv], { cwd: process.cwd(), env, detached: true, stdio: 'ignore', windowsHide: true });
  child.on?.('error', () => {});
  writeBg(run, token, { done: false, pid: child.pid ?? null, startedAt: new Date().toISOString() });
  child.unref?.();
  return 0;
}

// detached 자식: 손자를 띄우고 끝을 기다린다. 손자가 결과를 못 쓰고 끝나면 대신 오류 결과를 쓴다.
export async function runDetached({ run, token, entry, argv, env, spawn = nodeSpawn }) {
  writeBg(run, token, { done: false, pid: process.pid, startedAt: new Date().toISOString() });
  const code = await new Promise((done) => {
    const g = spawn(process.execPath, [entry, '--bg-run', token, ...argv], { cwd: process.cwd(), env, stdio: 'ignore', windowsHide: true });
    g.on('error', () => done(null));
    g.on('close', (c) => done(c));
  });
  if (!readBg(run, token)?.done) writeBg(run, token, { done: true, pid: process.pid, lines: [], errLines: [`오류: 분리 실행이 결과 없이 끝났습니다(종료 코드 ${code}).`], code: 2, endedAt: new Date().toISOString() });
  return code ?? 2;
}

// 손자 쪽: main을 돌리고 결과를 쓴다. 기다리는 쪽은 detached 자식의 pid로 생사를 본다.
export async function runChild({ run, token, main, argv, env }) {
  const lines = [];
  const errLines = [];
  let code;
  try { code = await main(argv, env, { write: (l) => lines.push(l), writeErr: (l) => errLines.push(l) }); } catch (e) { errLines.push(`오류: ${String(e?.message ?? e).slice(0, 300)}`); code = 2; }
  writeBg(run, token, { done: true, pid: readBg(run, token)?.pid ?? process.pid, lines, errLines, code, endedAt: new Date().toISOString() });
  return code;
}

// run-operator·run-research의 명령줄 진입점. --bg-token이 있으면 자식, HARNESS_FOREGROUND=1이면 예전처럼 그 자리에서 돈다.
export async function cliEntry({ main, entry, argv = process.argv.slice(2), env = process.env, record = false }) {
  const run = fwd(env.HARNESS_RUN_DIR || process.cwd());
  for (const flag of ['--bg-launch', '--bg-token', '--bg-run']) {
    const t = argv.indexOf(flag);
    if (t === -1) continue;
    const token = argv[t + 1];
    if (!TOKEN.test(token ?? '')) { console.log('오류: 대기 번호 모양이 올바르지 않습니다.'); return 2; }
    const rest = argv.filter((_, i) => i !== t && i !== t + 1);
    if (flag === '--bg-launch') return runLauncher({ run, token, entry, argv: rest, env });
    return flag === '--bg-token' ? runDetached({ run, token, entry, argv: rest, env }) : runChild({ run, token, main, argv: rest, env });
  }
  if (env.HARNESS_FOREGROUND === '1') return main(argv, env);
  // 실행 폴더가 아니면(harness.json 없음) 분리하지 않는다: main이 바로 오류를 낸다.
  let harnessDir;
  try { harnessDir = fwd(JSON.parse(readFileSync(`${run}/harness.json`, 'utf8')).harnessDir); } catch { return main(argv, env); }
  return startAndWait({ run, harnessDir, entry, args: argv, env, record });
}
