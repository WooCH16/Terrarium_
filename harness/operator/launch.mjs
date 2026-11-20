// 오퍼레이터 세션 실행기: 모드 문서, 세션 설정, 자식 claude 실행, 하달 이름 공간 정리.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync, lstatSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn as nodeSpawn, execFileSync } from 'node:child_process';
import { win32, dirname, resolve } from 'node:path';
import { ConfigError } from './config.mjs';
import { handoffNames } from './handoff.mjs';
import { launcher } from './model-exec.mjs';

const fwd = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
const MODES = ['work', 'research', 'reflect'];
const HANDOFF = /^h[1-9]\d*$/;
const TOOLS = {
  work: 'Bash Write Edit Read Glob Grep',
  research: 'Bash Write Read Glob Grep',
  reflect: 'Bash Write Read Glob Grep',
};

const SESSION_MODES = [...MODES, 'worker'];
function checkMode(mode) {
  if (!SESSION_MODES.includes(mode)) throw new Error(`알 수 없는 모드입니다: ${JSON.stringify(String(mode)).slice(0, 40)}`);
}
function checkHandoff(handoff) {
  if (typeof handoff !== 'string' || !HANDOFF.test(handoff)) throw new Error(`하달 이름이 올바르지 않습니다: ${JSON.stringify(String(handoff)).slice(0, 40)}`);
}

// pid가 아직 살아 있는지 본다(ESRCH면 죽음, EPERM이면 살아 있음). 죽은 pid는 다른 프로세스가 재사용할 수 있어 session.json의 pids에서 걸러낸다.
function defaultAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}
export function pruneDeadPids(pids, alive = defaultAlive) {
  return pids.filter((pid) => alive(pid));
}

// 중단 표시(stop-operator가 kill 전에 쓴다). 있으면 드라이버는 재시작·정리·보류 표시를 하지 않는다.
export const isStopped = (run, handoff) => existsSync(`${fwd(run)}/handoffs/${handoff}/stopped.json`);

// SKILL.md 머리의 frontmatter를 뗀다. 없으면 그대로 돌려준다.
export function stripFrontmatter(text) {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n(?:\r?\n)?/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

export function loadModeDocs(mode, harnessDir) {
  if (!MODES.includes(mode)) throw new ConfigError(`알 수 없는 모드입니다: ${JSON.stringify(String(mode)).slice(0, 40)}`);
  const parts = [];
  // 공통 규칙(AGENT.md) 뒤에 모드 절차 스킬을 붙인다. 스킬의 frontmatter(--- … ---)는 세션 지침에 넣지 않는다.
  for (const name of ['AGENT.md', `skills/operator-${mode}/SKILL.md`]) {
    const file = `${fwd(harnessDir)}/operator/${name}`;
    try {
      parts.push(stripFrontmatter(readFileSync(file, 'utf8')));
    } catch (e) {
      throw new ConfigError(`모드 문서를 읽을 수 없습니다: ${file} (${e.code ?? e.message})`);
    }
  }
  return parts.join('\n\n');
}

// 하네스 세션에 섞이면 안 되는 CLAUDE.md(이슈 #22): 사용자 전역 ~/.claude/CLAUDE.md·rules와, 세션 폴더의 상위 폴더마다 있는 CLAUDE.md.
// Claude Code 설정 claudeMdExcludes(절대 경로나 glob, 모든 설정 범위에서 합쳐짐)로 넘긴다. 세션 폴더 자신의 CLAUDE.md는 남는다.
export function claudeMdExcludes(dir, home = homedir()) {
  const trim = (p) => fwd(p).replace(/\/+$/, '');
  const h = trim(home);
  const out = [`${h}/.claude/CLAUDE.md`, `${h}/.claude/rules/**`];
  for (let cur = resolve(dir), up = dirname(cur); up !== cur; cur = up, up = dirname(cur)) {
    out.push(`${trim(up)}/CLAUDE.md`, `${trim(up)}/CLAUDE.local.md`);
  }
  return [...new Set(out)];
}

export function sessionSettings({ mode, handoff, run, harnessDir, issue, worktree }) {
  checkMode(mode);
  checkHandoff(handoff);
  const worker = mode === 'worker';
  if (worker) {
    if (!/^([a-zA-Z]:\/|\/)/.test(fwd(worktree ?? ''))) throw new ConfigError('워커의 워크트리는 절대 경로여야 합니다');
    if (issue == null) throw new Error('워커 설정에는 이슈 번호가 필요합니다');
  } else if (worktree !== undefined) {
    throw new ConfigError('워크트리 인자는 워커 설정에만 쓸 수 있습니다');
  }
  // 훅 명령은 셸이 해석하므로 큰따옴표 안에서도 풀리는 문자(", `, $, %, \, 제어 문자)가 든 경로는 거부한다.
  for (const p of worker ? [run, harnessDir, worktree] : [run, harnessDir]) {
    if (/["`$%]|[\p{Cc}\p{Zl}\p{Zp}]/u.test(fwd(p))) throw new ConfigError(`훅 명령에 쓸 수 없는 문자가 경로에 있습니다: ${JSON.stringify(String(p)).slice(0, 80)}`);
  }
  let command = `node "${fwd(harnessDir)}/guard.mjs" --config "${fwd(run)}/harness.json" --role ${worker ? 'worker' : `operator-${mode}`} --handoff ${handoff}`;
  if (issue != null) {
    if (!Number.isSafeInteger(issue) || !/^[1-9]\d{0,8}$/.test(String(issue))) throw new Error('이슈 번호는 9자리 이하의 양의 정수여야 합니다');
    command += ` --issue ${issue}`;
  }
  if (worker) command += ` --worktree "${fwd(worktree)}"`;
  const who = worker ? 'worker' : 'operator';
  return {
    hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command }] }] },
    claudeMdExcludes: claudeMdExcludes(worker ? worktree : sessionCwd(run, handoff)),
    env: {
      HARNESS_REQUIRE_ROLE: '1',
      // 세션 cwd는 실행 폴더 밖이라 스크립트(run-worker, merge-adapter-* 등)가 실행 폴더를 이 값으로만 찾는다.
      ...(worker ? {} : { HARNESS_RUN_DIR: fwd(run) }),
      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1',
      GIT_AUTHOR_NAME: `terrarium-${who}`,
      GIT_AUTHOR_EMAIL: `${who}@localhost`,
      GIT_COMMITTER_NAME: `terrarium-${who}`,
      GIT_COMMITTER_EMAIL: `${who}@localhost`,
    },
  };
}

// 실행 폴더 밖: 코디네이터의 <run>/CLAUDE.md, <run>/.claude/가 상위 폴더로 읽히지 않게 한다.
export function sessionCwd(run, handoff) {
  checkHandoff(handoff);
  const id = createHash('sha1').update(fwd(run).toLowerCase()).digest('hex').slice(0, 8);
  return `${fwd(tmpdir())}/terrarium-sessions/${id}-${handoff}`;
}

export function killTree(pid) {
  execFileSync(win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', timeout: 5000 });
}

export function launchSession(opts, deps = {}) {
  const { mode, handoff, run, harnessDir, issue, issues, prompt, timeoutMs } = opts;
  const spawn = deps.spawn ?? nodeSpawn;
  const settings = sessionSettings({ mode, handoff, run, harnessDir, issue });
  const dir = `${fwd(run)}/handoffs/${handoff}`;
  const settingsFile = `${dir}/settings-${mode}.json`;
  const cwd = sessionCwd(run, handoff);
  mkdirSync(dir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2));

  // HARNESS_CLAUDE_BIN이 없으면 PATH에서 찾는다. Windows의 npm 셔틀(claude.cmd)은 셸 없이 실행할 수 없어 안의 실제 대상으로 푼다(model-exec launcher).
  const configured = process.env.HARNESS_CLAUDE_BIN;
  const script = Boolean(configured) && /\.(mjs|js)$/i.test(configured);
  const found = configured ? null : launcher('claude');
  const bin = configured ? (script ? process.execPath : configured) : (found?.bin ?? 'claude');
  const args = [
    ...(script ? [configured] : (found?.args ?? [])),
    '-p', '--settings', settingsFile, '--setting-sources', 'user',
    '--allowedTools', TOOLS[mode], '--no-session-persistence',
  ];

  return new Promise((resolve) => {
    let done = false;
    let timedOut = false;
    let timer;
    let started = false;
    const sessionJson = `${dir}/session.json`;
    const finish = (code, spawnError) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (started) {
        try {
          const cur = JSON.parse(readFileSync(sessionJson, 'utf8'));
          // 쓰기 직전에 다시 읽은 값(cur)에 endedAt과 걸러낸 pids만 얹는다(그사이 워커가 적은 산 pid는 남는다).
          const next = { ...cur, endedAt: new Date().toISOString() };
          if (Array.isArray(cur.pids)) next.pids = pruneDeadPids(cur.pids, deps.probe);
          writeFileSync(sessionJson, JSON.stringify(next, null, 2));
        } catch { /* 기록 실패는 결과를 바꾸지 않는다 */ }
      }
      // 성공한 세션의 세션 폴더는 지우고, 실패·시간 초과·시작 실패는 진단용으로 남긴다(다음 시작이 같은 폴더를 다시 쓴다).
      if (spawnError === undefined && code === 0 && !timedOut) { try { rmSync(cwd, { recursive: true, force: true }); } catch { /* 지우지 못해도 결과를 바꾸지 않는다 */ } }
      resolve(spawnError === undefined ? { code, timedOut } : { code: -1, timedOut: false, spawnError });
    };
    let child;
    try {
      child = spawn(bin, args, { cwd, env: { ...process.env, ...settings.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      finish(-1, e.message);
      return;
    }
    const session = { pid: child.pid ?? null, startedAt: new Date().toISOString(), mode, driverPid: process.pid };
    started = true;
    if (issues?.length) session.issues = issues;
    else if (issue != null) session.issues = [issue];
    writeFileSync(sessionJson, JSON.stringify(session, null, 2));

    // 윈도우의 child.kill()은 손자 프로세스를 못 죽이므로 프로세스 트리를 먼저 끝낸다.
    const killChild = () => {
      if (process.platform === 'win32' && child.pid) {
        try { (deps.killTree ?? killTree)(child.pid); } catch { /* 이미 끝남 */ }
      }
      try { child.kill(); } catch { /* 이미 끝남 */ }
    };
    child.stdout?.resume();
    child.stderr?.resume();
    // pid가 없으면 띄우지 못한 것(spawnError). pid가 있으면 띄운 뒤의 오류(예: 종료 실패)이므로 close나 시간 초과가 마무리한다.
    child.on('error', (e) => { if (child.pid === undefined) finish(-1, e.message); });
    child.on('close', (code, signal) => finish(code ?? (signal ? 1 : -1)));
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    // stop-operator가 방금 중단 표시를 썼다면(재시작 틈) 새 pid가 session.json에 적힌 지금 스스로 종료한다.
    if (isStopped(run, handoff)) killChild();
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killChild();
        // close가 오지 않는 경우를 대비해 잠시 뒤 강제로 마무리한다.
        setTimeout(() => finish(1), 2000).unref();
      }, timeoutMs);
    }
  });
}

const defaultGit = (memo, args) => execFileSync('git', ['-C', memo, ...args], { stdio: 'pipe', encoding: 'utf8' });
const norm = (p) => String(p).split('\\').join('/').replace(/\/+$/, '').toLowerCase();

// 링크(심볼릭 링크·junction)이거나 실제 경로가 기대한 글자 그대로의 경로와 다르면 거부한다. 없는 경로는 false.
export function assertPlain(p, expectedReal, what) {
  let st;
  try { st = lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  if (st.isSymbolicLink()) throw new Error(`정리를 거부합니다: ${what}이(가) 링크입니다(${p}). 아무것도 지우지 않았습니다.`);
  if (norm(realpathSync.native(p)) !== norm(expectedReal)) throw new Error(`정리를 거부합니다: ${what}의 실제 경로가 다릅니다(${p}). 아무것도 지우지 않았습니다.`);
  return true;
}

// 이 하달의 이슈 브랜치(<h>/*)나 통합 브랜치가 하나라도 있으면 true. 있으면 cleanupHandoff가 지울 작업이 있다.
export function handoffHasWork({ handoff, memo }, deps = {}) {
  checkHandoff(handoff);
  const git = deps.git ?? defaultGit;
  const out = git(memo, ['for-each-ref', '--format=%(refname:lstrip=2)', `refs/heads/${handoff}/`, `refs/heads/integration/${handoff}`]);
  return out.split('\n').map((s) => s.trim()).some((b) => b === `integration/${handoff}` || b.startsWith(`${handoff}/`));
}

// 해당 하달의 worktrees/<h>/, integration/<h>, <h>/* 브랜치만 지운다. 결과를 다시 확인하고 남은 것이 있으면 던진다.
// 주의: --handoff로 이어받은 하달에서 첫 시도가 실패하면 그 하달의 이전 작업 폴더·브랜치도 함께 지워진다(이름 공간 단위 정리).
export function cleanupHandoff({ handoff, run, memo }, deps = {}) {
  checkHandoff(handoff);
  const git = deps.git ?? defaultGit;
  const names = handoffNames(handoff, null, run);
  const root = names.integrationFolder.replace(/\/integration$/, '');
  const own = (b) => b === names.integrationBranch || b.startsWith(`${handoff}/`);
  const listOwn = () => {
    try {
      const out = git(memo, ['for-each-ref', '--format=%(refname:lstrip=2)', `refs/heads/${handoff}/`, `refs/heads/${names.integrationBranch}`]);
      return out.split('\n').map((s) => s.trim()).filter((b) => b && own(b));
    } catch (e) {
      throw new Error(`정리 실패: 대상 프로젝트가 git 저장소가 아니거나 브랜치를 읽을 수 없습니다(${memo}): ${String(e.message).split('\n')[0]}`);
    }
  };

  // 1. 아무것도 지우기 전에 링크 검사와 브랜치 조회를 끝낸다.
  // 부모(worktrees)를 믿지 않고 글자 그대로의 경로와 비교한다: realpath(run)/worktrees/<h>여야 한다.
  let runReal = null;
  try { runReal = realpathSync.native(run); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const wt = root.slice(0, root.lastIndexOf('/'));
  const wtExists = runReal !== null && assertPlain(wt, `${runReal}/worktrees`, 'worktrees');
  const exists = wtExists && assertPlain(root, `${runReal}/worktrees/${handoff}`, `worktrees/${handoff}`);
  const folders = [];
  if (exists) {
    const rootReal = realpathSync.native(root);
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const folder = `${root}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`정리를 거부합니다: ${folder}이(가) 링크입니다. 아무것도 지우지 않았습니다.`);
      if (!entry.isDirectory()) continue;
      assertPlain(folder, `${rootReal}/${entry.name}`, folder);
      folders.push(folder);
    }
  }
  const branches = listOwn();

  // 2. 지운다.
  for (const folder of folders) {
    try { git(memo, ['worktree', 'remove', '--force', folder]); } catch { /* 아래에서 폴더를 직접 지운다 */ }
    try { rmSync(folder, { recursive: true, force: true }); } catch (e) { throw new Error(`정리 실패: 폴더를 지우지 못했습니다(${folder}): ${e.code ?? e.message}`); }
  }
  if (exists) {
    try { rmSync(root, { recursive: true, force: true }); } catch (e) { throw new Error(`정리 실패: 폴더를 지우지 못했습니다(${root}): ${e.code ?? e.message}`); }
  }
  try { git(memo, ['worktree', 'prune']); } catch { /* 아래 확인에서 걸린다 */ }
  for (const branch of branches) {
    try { git(memo, ['branch', '-D', branch]); } catch { /* 아래 확인에서 걸린다 */ }
  }
  try { git(memo, ['worktree', 'prune']); } catch { /* 위와 같다 */ }

  // 3. 확인한다.
  let left = null;
  try { lstatSync(root); left = root; } catch { /* 없음 */ }
  if (left) throw new Error(`정리 실패: 폴더가 남아 있습니다(${left}).`);
  const remaining = listOwn();
  if (remaining.length) throw new Error(`정리 실패: 브랜치가 남아 있습니다(${remaining.join(', ')}).`);
}
