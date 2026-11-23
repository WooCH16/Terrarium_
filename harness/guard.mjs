// PreToolUse 훅 진입점. 허용 → exit 0, 거부 → stderr 사유 + exit 2.
// 어떤 오류든 막는 쪽으로 끝낸다(fail closed).
import { readFileSync, appendFileSync, writeFileSync, existsSync, realpathSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { decide } from './policy.mjs';

const CACHE_MS = 10 * 60 * 1000;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function makeVisibility(config, stub) {
  return (repo) => {
    if (config.visibilityOverride) return config.visibilityOverride;
    if (stub) return stub;
    const cacheFile = join(config.runDir, '.visibility-cache.json');
    try {
      const c = JSON.parse(readFileSync(cacheFile, 'utf8'));
      if (c.repo === repo && Date.now() - c.at < CACHE_MS) return c.visibility;
    } catch {}
    // 시간 제한을 넘기면 던져서 판정이 거부(닫힌 쪽)가 된다. HARNESS_GH_BIN·HARNESS_GH_TIMEOUT_MS는 시험용이다.
    const custom = process.env.HARNESS_GH_BIN;
    const script = custom && /\.(mjs|js)$/i.test(custom);
    const ghArgs = ['repo', 'view', repo, '--json', 'visibility', '-q', '.visibility'];
    const timeout = Number(process.env.HARNESS_GH_TIMEOUT_MS) > 0 ? Number(process.env.HARNESS_GH_TIMEOUT_MS) : 30000;
    const out = execFileSync(custom ? (script ? process.execPath : custom) : 'gh', script ? [custom, ...ghArgs] : ghArgs, { encoding: 'utf8', timeout, killSignal: 'SIGKILL', windowsHide: true }).trim();
    writeFileSync(cacheFile, JSON.stringify({ repo, visibility: out, at: Date.now() }));
    return out;
  };
}

// 아직 없는 파일이면 가장 깊은 기존 상위 폴더를 실제 경로로 풀고 나머지를 붙인다(링크·정션 우회 방지).
function realpath(p) {
  let cur = resolve(String(p));
  const rest = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return String(p);
    rest.unshift(basename(cur));
    cur = parent;
  }
  return join(realpathSync.native(cur), ...rest);
}

function fail(reason) {
  process.stderr.write(`[하네스 가드] 거부: ${reason}\n`);
  process.exit(2);
}

const ROLES = new Set(['operator-work', 'operator-research', 'operator-reflect', 'worker']);
const ROLE_ARGS = ['--role', '--handoff', '--issue', '--worktree', '--base-handoff'];

// --role/--handoff/--issue/--worktree/--base-handoff를 검사해 config에 합칠 값을 만든다. 잘못되면 { error }.
// --base-handoff는 시작 지점 하달(결정 8-31): 작업 모드 오퍼레이터가 그 하달의 이슈 브랜치를 run-worker --base로 넘길 수 있다.
// 인자가 주어지면 설정 파일 안의 role·handoff·issue·worktree는 쓰지 않는다(인자만 믿는다). 인자가 없을 때만 설정 파일 그대로다.
function roleOverrides() {
  const argv = process.argv.slice(2);
  // 철자가 비슷한 인자(--role=x, --ROLE, -role)는 조용히 무시되어 코디네이터가 되므로 닫힌 실패로 거부한다.
  const lookalike = argv.find((t) => /^-{1,2}(role|handoff|issue|worktree|base)/i.test(t) && !ROLE_ARGS.includes(t));
  if (lookalike !== undefined) return { error: `알 수 없는 역할 인자 모양(${lookalike}). --role <값>처럼 정확한 플래그와 별도 값으로만 준다` };
  const dup = ROLE_ARGS.find((n) => argv.filter((t) => t === n).length > 1);
  if (dup) return { error: `${dup} 인자가 두 번 이상 있다` };
  const given = ROLE_ARGS.filter((n) => argv.includes(n));
  if (given.length === 0) {
    if (process.env.HARNESS_REQUIRE_ROLE === '1') return { error: 'HARNESS_REQUIRE_ROLE=1인 세션에 --role 인자가 없어 코디네이터로 열 수 없다' };
    return {};
  }
  const [role, handoff, issue, worktree, baseHandoff] = ROLE_ARGS.map(arg);
  if (!process.argv.includes('--role') || role === undefined) return { error: '--role 없이 --handoff·--issue·--worktree만 줄 수 없고, --role에는 값이 필요하다' };
  if (!ROLES.has(role)) return { error: `알 수 없는 --role 값(${role})` };
  if (handoff === undefined || !/^h[1-9]\d*$/.test(handoff)) return { error: '--handoff가 없거나 h<번호> 모양이 아니다' };
  if (process.argv.includes('--issue') && !(issue !== undefined && /^[1-9]\d{0,8}$/.test(issue))) return { error: '--issue는 양의 정수여야 한다' };
  if (role === 'operator-research' && issue === undefined) return { error: 'operator-research에는 --issue(조사 이슈 번호)가 필요하다' };
  if (process.argv.includes('--worktree') && !(worktree !== undefined && /^([a-zA-Z]:[\\/]|\/)/.test(worktree) && !/^[\\/]{2}/.test(worktree))) return { error: '--worktree는 절대 경로여야 한다' };
  if (role === 'worker' && worktree === undefined) return { error: 'worker에는 --worktree(절대 경로)가 필요하다' };
  if (process.argv.includes('--base-handoff') && !(role === 'operator-work' && baseHandoff !== undefined && /^h[1-9]\d*$/.test(baseHandoff) && baseHandoff !== handoff)) {
    return { error: '--base-handoff는 operator-work에만, 자기 하달이 아닌 h<번호>로 준다' };
  }
  const o = { role, handoff };
  if (baseHandoff !== undefined) o.baseHandoff = baseHandoff;
  if (issue !== undefined) o.issue = Number(issue);
  if (worktree !== undefined) o.worktree = worktree;
  return { o };
}

function writeLog(file, input, result) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify({
      time: new Date().toISOString(),
      agent_type: input.agent_type ?? null,
      tool_name: input.tool_name,
      allow: result.allow,
      reason: result.reason,
      // Agent(어드바이저 호출)는 명령·파일이 없어 설명을 남긴다. 앱의 관제탑이 어드바이저 칸에 보인다(app/lib/flow.mjs).
      summary: String(input.tool_input?.command ?? input.tool_input?.file_path ?? input.tool_input?.description ?? '').slice(0, 200),
    }) + '\n');
  } catch {
    // 의도적으로 삼킨다: 로그를 못 써도 판정은 그대로 따른다(로그 실패가 허용·거부를 바꾸지 않는다).
  }
}

// 설정 파일을 읽은 뒤의 가드 오류(입력 JSON이 깨짐 등)도 막고 실행 폴더의 guard.log에 한 줄 남긴다(이슈 #5).
// 설정 파일조차 못 읽으면 남길 곳을 모르므로 막기만 한다.
let errorLog = null;
try {
  const fileConfig = JSON.parse(readFileSync(arg('--config'), 'utf8'));
  if (typeof fileConfig?.runDir === 'string' && fileConfig.runDir) errorLog = join(fileConfig.runDir, 'guard.log');
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const { role: _r, handoff: _h, issue: _i, worktree: _w, baseHandoff: _b, ...base } = fileConfig;
  const ov = roleOverrides();
  const defaultLog = join(fileConfig.runDir, 'guard.log');
  if (ov.error) {
    writeLog(defaultLog, input, { allow: false, reason: ov.error });
    fail(ov.error);
  }
  // 인자가 없으면 설정 파일 그대로(기존 코디네이터 동작), 있으면 인자로만 역할을 정한다.
  const config = ov.o ? { ...base, ...ov.o } : fileConfig;
  const deps = { visibility: makeVisibility(config, arg('--visibility-stub')), readFile: (p) => readFileSync(p, 'utf8'), realpath };
  let result;
  try {
    result = decide(input, config, deps);
  } catch (e) {
    result = { allow: false, reason: `판정 중 오류: ${e.message}` };
  }
  writeLog(ov.o ? join(config.runDir, 'logs', config.handoff, 'guard.log') : defaultLog, input, result);
  if (!result.allow) fail(result.reason);
  process.exit(0);
} catch (e) {
  const reason = `가드 오류로 막음: ${e.message}`;
  if (errorLog) writeLog(errorLog, { tool_name: null }, { allow: false, reason });
  fail(reason);
}
