// 하달 중단: node stop-operator.mjs --handoff h<N>
// 중단 표시(stopped.json)를 먼저 쓰고, session.json이 적은 pid를 종료하고, 그 하달의 이름 공간만 정리한다.
// 성공하면 아무것도 출력하지 않고 종료 코드 3(중단). 실패는 오류 한 줄과 종료 코드 2.
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadOperatorConfig, ConfigError } from './config.mjs';
import { handoffNames } from './handoff.mjs';
import { exitCode } from './report.mjs';
import { cleanupHandoff, pruneDeadPids } from './launch.mjs';

const fwd = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
const ONE_LINE = (text) => String(text).replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
const MAX_PIDS = 64;
const ALLOWED_IMAGE = /^(node|claude)(\.exe)?$/i;
const run1 = (file, args) => execFileSync(file, args, { stdio: 'pipe', encoding: 'utf8', timeout: 10000 });

class UsageError extends Error {}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== '--handoff') throw new UsageError('사용법: --handoff h<N> (다른 인자와 중복은 허용하지 않습니다)');
  if (!/^h[1-9]\d{0,8}$/.test(argv[1])) throw new UsageError('--handoff는 h<번호> 모양이어야 합니다(예: h1).');
  return { handoff: argv[1] };
}

// pid 하나를 프로세스 트리째 종료한다. 이미 없는 프로세스는 성공으로 본다.
// 윈도우에서는 pid 재사용을 줄이려고 tasklist로 이미지 이름(node/claude)을 먼저 확인하고, 다르면 종료를 거부한다.
export function defaultKill(pid, { platform = process.platform, exec = run1 } = {}) {
  if (platform === 'win32') {
    const sys = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    const imageOf = () => /^"([^"]*)"/.exec(String(exec(win32.join(sys, 'tasklist.exe'), ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])).trim())?.[1];
    const image = imageOf();
    if (image === undefined) return; // 해당 pid의 프로세스 없음(이미 끝남)
    if (!ALLOWED_IMAGE.test(image)) throw new Error(`pid ${pid}의 이미지가 ${ONE_LINE(image).slice(0, 40)}입니다(node/claude가 아니라 종료를 거부함)`);
    try {
      exec(win32.join(sys, 'taskkill.exe'), ['/T', '/F', '/PID', String(pid)]);
    } catch (e) {
      if (e.status === 128) return; // 해당 프로세스 없음
      // 앞서 죽인 트리에 들어 있어 끝나는 중이면 taskkill이 1로 끝난다(run-18 h11). 그 pid가 이제 없으면 성공이다.
      if (imageOf() === undefined) return;
      throw e;
    }
    return;
  }
  try { process.kill(pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
}

function readSession(file) {
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new Error(`session.json을 읽을 수 없습니다(${e.code ?? '형식 오류'}): ${file}`); }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('session.json 형식이 올바르지 않습니다.');
  // 중단된 세션은 종료할 것이 없다. endedAt은 오퍼레이터 자신의 pid에만 적용되고, 워커가 적은 pids는 여전히 종료한다(시작 실패로 pid가 null이어도 된다).
  if (data.stoppedAt) return { data, pids: [] };
  const list = [];
  if (data.pid !== undefined && !data.endedAt) list.push(data.pid);
  if (data.pids !== undefined) {
    if (!Array.isArray(data.pids)) throw new Error('session.json의 pids가 배열이 아닙니다.');
    list.push(...data.pids);
  }
  if (list.length === 0) {
    if (data.endedAt) return { data, pids: [] };
    throw new Error('session.json에 종료할 pid가 없습니다.');
  }
  if (list.length > MAX_PIDS) throw new Error(`session.json의 pid가 ${MAX_PIDS}개를 넘습니다.`);
  for (const p of list) {
    if (!Number.isSafeInteger(p) || p <= 1 || p === process.pid || p === process.ppid) throw new Error(`session.json의 pid가 올바르지 않습니다: ${JSON.stringify(p)?.slice(0, 20)}`);
  }
  return { data, pids: [...new Set(list)], own: data.endedAt ? null : data.pid };
}

export async function main(argv, env = process.env, deps = {}) {
  const write = deps.write ?? ((line) => console.log(line));
  const fail = (reason) => { write(`오류: ${ONE_LINE(reason)}`); return 2; };
  try {
    const { handoff } = parseArgs(argv);
    const run = fwd(env.HARNESS_RUN_DIR || process.cwd());
    const configFile = `${run}/harness.json`;
    if (!existsSync(configFile)) return fail(`실행 폴더에 harness.json이 없습니다: ${run}`);
    const config = JSON.parse(readFileSync(configFile, 'utf8'));
    loadOperatorConfig(`${fwd(config.harnessDir)}/operator/operator.config.json`);
    if (!existsSync(`${run}/handoffs/${handoff}`)) return fail(`하달 ${handoff} 폴더가 없습니다.`);
    const { sessionFile } = handoffNames(handoff, null, run);

    // 1. 아무것도 읽거나 종료하기 전에 중단 표시를 먼저 쓴다. 드라이버(run-operator, run-research, launchSession)는
    //    자기 쪽을 쓴 뒤 이 표시를 읽고, stop은 표시를 쓴 뒤 session.json을 읽으므로 어느 한쪽은 반드시 상대를 본다.
    const stoppedAt = new Date().toISOString();
    const markerFile = `${run}/handoffs/${handoff}/stopped.json`;
    const created = !existsSync(markerFile);
    writeFileSync(markerFile, JSON.stringify({ stoppedAt }, null, 2));
    deps.afterMarker?.();
    // 첫 kill 전에 실패하면(session.json 오류 등) 이번 호출이 만든 표시는 지워 재개를 막지 않는다.
    let first;
    try { first = readSession(sessionFile); } catch (e) { if (created) rmSync(markerFile, { force: true }); throw e; }

    // 2. 이미 끝났거나 이미 중단된 세션의 pid는 다른 프로세스가 쓰고 있을 수 있으므로 종료하지 않는다.
    //    종료하는 동안 재시작이 새 pid를 적었을 수 있으니, 새 pid가 더 나오지 않을 때까지 다시 읽는다.
    const kill = deps.kill ?? defaultKill;
    const killed = new Set();
    let didKill = false;
    for (let round = 0; round < 5; round++) {
      const { data, pids, own } = round === 0 ? first : readSession(sessionFile);
      // pids(워커)는 죽었을 수 있고 죽은 pid는 재사용될 수 있으므로 종료 직전에 다시 확인한다. 오퍼레이터 자신의 pid는 그대로 둔다.
      const alive = new Set(pruneDeadPids(pids.filter((p) => p !== own), deps.probe));
      const todo = pids.filter((p) => !killed.has(p) && (p === own || alive.has(p)));
      if (data.stoppedAt || todo.length === 0) break;
      const failed = [];
      for (const pid of todo) {
        killed.add(pid);
        try { await kill(pid); } catch (e) { failed.push(`${pid}(${ONE_LINE(e?.message ?? e).slice(0, 80)})`); }
      }
      if (failed.length) return fail(`프로세스를 종료하지 못했습니다: ${failed.join(', ')}. 이름 공간은 정리하지 않았습니다.`);
      didKill = true;
    }
    // 가장 새 session.json에 stoppedAt만 더한다(그사이 적힌 새 pid를 지우지 않는다).
    if (didKill) writeFileSync(sessionFile, JSON.stringify({ ...readSession(sessionFile).data, stoppedAt }, null, 2));

    (deps.cleanupHandoff ?? cleanupHandoff)({ handoff, run, memo: fwd(config.targetProject) });
    return exitCode([], { stopped: true });
  } catch (e) {
    if (e instanceof UsageError) return fail(`인자 오류: ${e.message}`);
    if (e instanceof ConfigError) return fail(`설정 오류: ${e.message}`);
    return fail(e?.message ?? String(e));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
