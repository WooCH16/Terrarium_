// 오퍼레이터 대역: run-operator, run-research, run-reflect, stop-operator의 출력·종료 코드 계약만 지킨다.
// 세션도 워커도 띄우지 않고 GitHub에도 쓰지 않는다. 댓글은 파일로만 남긴다(코디네이터 시험용).
//
// 사용법: node operator-stub.mjs <run-operator|run-research|run-reflect|stop-operator> <실제 스크립트와 같은 인자>
//   run-operator --issues <n,n,...> [--base h<N>] [--handoff h<N>]
//   run-research --issue <n>
//   run-reflect  --handoff h<N>
//   stop-operator --handoff h<N>
// 시나리오 파일: 환경 변수 HARNESS_STUB_SCENARIO가 가리키는 JSON.
//   {
//     "exitCode": 0|1|2|3,         // 없으면 보고 줄의 상태에서 정한다(막힘·보류·거부목록이 있으면 1)
//     "default": "report",          // 이슈별 방식의 기본값
//     "issues": { "7": "unmet" },   // 이슈별 방식: report | no-report | unmet | not-found | blocked
//     "commit": "<40자리 소문자 16진수>", // 보고서의 커밋 해시. 없으면 harness.json의 targetProject HEAD
//     "outDir": "<댓글을 쓸 폴더>"    // 없으면 <실행 폴더>/stub-comments
//   }
// 표시: 보고 줄의 URL 호스트가 operator-stub.invalid이고, 댓글 첫 줄이 "[대역] ..."이다.
//   실제 결과 보고서의 첫 줄은 `## 결과 보고서`인데, 대역은 그 앞에 대역 표시 줄을 둔다(실제 보고서로 오인되지 않게).
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { formatLine, exitCode, STATES } from '../operator/report.mjs';

export const STUB_HOST = 'operator-stub.invalid';
export const STUB_MARK = '[대역] 오퍼레이터 대역이 쓴 것이다. 실제 오퍼레이터 세션의 결과가 아니다.';
export const MODES = ['report', 'no-report', 'unmet', 'not-found', 'blocked'];
const COMMANDS = ['run-operator', 'run-research', 'run-reflect', 'stop-operator'];
const fwd = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');

class StubError extends Error {}

const ALLOWED = { 'run-operator': ['--issues', '--handoff', '--base'], 'run-research': ['--issue'], 'run-reflect': ['--handoff'], 'stop-operator': ['--handoff'] };
const REQUIRED = { 'run-operator': ['--issues'], 'run-research': ['--issue'], 'run-reflect': ['--handoff'], 'stop-operator': ['--handoff'] };

function parseArgs(command, argv) {
  const usage = (m) => { throw new StubError(`인자 오류: ${m}`); };
  const pairs = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (flag in pairs) usage(`${flag}가 두 번 이상 있습니다`);
    if (argv[i + 1] === undefined) usage(`${flag}에 값이 필요합니다`);
    pairs[flag] = argv[i + 1];
  }
  for (const f of Object.keys(pairs)) if (!ALLOWED[command].includes(f)) usage(`알 수 없는 인자입니다: ${f}`);
  for (const f of REQUIRED[command]) if (!(f in pairs)) usage(`${f}가 필요합니다`);
  if ('--handoff' in pairs && !/^h[1-9]\d{0,8}$/.test(pairs['--handoff'])) usage('--handoff는 h<번호> 모양이어야 합니다');
  if ('--issue' in pairs && !/^[1-9]\d{0,8}$/.test(pairs['--issue'])) usage('--issue는 양의 정수여야 합니다');
  if ('--base' in pairs && !/^h[1-9]\d{0,8}$/.test(pairs['--base'])) usage('--base는 h<번호> 모양이어야 합니다');
  if ('--base' in pairs && '--handoff' in pairs) usage('--base는 새 하달에만 쓸 수 있습니다');
  let issues = [];
  if ('--issues' in pairs) {
    if (!/^[1-9]\d{0,8}(,[1-9]\d{0,8})*$/.test(pairs['--issues'])) usage('--issues는 쉼표로 나눈 양의 정수여야 합니다');
    issues = pairs['--issues'].split(',').map(Number);
  }
  if ('--issue' in pairs) issues = [Number(pairs['--issue'])];
  return { issues, handoff: pairs['--handoff'] };
}

function loadScenario(env) {
  const file = env.HARNESS_STUB_SCENARIO;
  if (!file) return {};
  let s;
  try { s = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new StubError(`시나리오 파일을 읽을 수 없습니다: ${e.message}`); }
  if (s === null || typeof s !== 'object' || Array.isArray(s)) throw new StubError('시나리오의 최상위는 객체여야 합니다');
  if (s.exitCode !== undefined && ![0, 1, 2, 3].includes(s.exitCode)) throw new StubError('exitCode는 0, 1, 2, 3 중 하나여야 합니다');
  for (const m of [s.default, ...Object.values(s.issues ?? {})]) {
    if (m !== undefined && !MODES.includes(m)) throw new StubError(`알 수 없는 방식입니다: ${m} (가능: ${MODES.join(', ')})`);
  }
  return s;
}

function commitHash(scenario, runConfig) {
  let hash = scenario.commit;
  if (hash === undefined && runConfig?.targetProject) {
    try { hash = execFileSync('git', ['-C', runConfig.targetProject, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* 아래에서 오류로 */ }
  }
  if (!/^[0-9a-f]{40}$/.test(hash ?? '')) throw new StubError('커밋 해시가 없습니다. 시나리오의 commit(40자리 소문자 16진수)을 주거나 실행 폴더 harness.json의 targetProject가 git 저장소여야 합니다');
  return hash;
}

export function workReport({ issue, handoff, hash, unmet }) {
  return [
    STUB_MARK,
    '## 결과 보고서',
    `커밋 해시: ${hash}`,
    '',
    '### 기준별 충족 여부',
    '| 기준 | 충족 | 근거 위치 |',
    '|---|---|---|',
    `| (대역) 이슈 #${issue}의 기준 1 | 충족 | 대역이 정한 값: test/example.test.mjs |`,
    `| (대역) 이슈 #${issue}의 기준 2 | ${unmet ? '미충족' : '충족'} | 대역이 정한 값: src/example.mjs:1 |`,
    '',
    '### 변경 요약',
    `(대역) ${handoff}/issue-${issue}에서 바꾼 것은 없다. 대역이 만든 문장이다.`,
    '',
    '### 사실 칸',
    '- 모델: claude → claude',
    '- 시도 횟수: 1, 막힘 사유: 없음',
    '- 사후 검사 자료: 변경 파일 목록 없음(대역), 하달 시작과 지금의 main 해시 같음(대역), 오퍼레이터 편집 없음',
    '',
    '### 남은 문제',
    unmet ? '(대역) 기준 2가 미충족이다.' : '없음',
    '',
  ].join('\n');
}

export function researchResult({ issue, hash, notFound }) {
  return [
    STUB_MARK,
    '## 조사 결과',
    '',
    '### 답(요약)',
    `(대역) 이슈 #${issue}의 질문에 대한 대역의 답이다.`,
    '',
    '### 근거 위치',
    '- src/example.mjs:1-3 (대역이 정한 값)',
    '',
    '### 못 찾은 것',
    notFound ? '- (대역) 설정 파일의 기본값 위치를 찾지 못했다.' : '없음',
    '',
    `기준 커밋: ${hash}`,
    '',
  ].join('\n');
}

export async function main(command, argv, env = process.env, deps = {}) {
  const write = deps.write ?? ((line) => console.log(line));
  const writeErr = deps.writeErr ?? ((line) => console.error(line));
  // 실제 스크립트처럼 run-reflect만 오류를 stderr로, 나머지는 stdout 한 줄로 낸다.
  const fail = (reason) => { (command === 'run-reflect' ? writeErr : write)(`오류: [대역] ${String(reason).replace(/\s+/g, ' ').slice(0, 300)}`); return 2; };
  try {
    if (!COMMANDS.includes(command)) throw new StubError(`알 수 없는 명령입니다: ${command}. 가능: ${COMMANDS.join(', ')}`);
    const { issues, handoff } = parseArgs(command, argv);
    const scenario = loadScenario(env);
    if (scenario.exitCode === 2) return fail('시험 설정(exitCode 2)으로 낸 실패');
    if (scenario.exitCode === 3 || command === 'stop-operator') return 3;

    const run = fwd(env.HARNESS_RUN_DIR || process.cwd());
    const configFile = `${run}/harness.json`;
    const runConfig = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : {};
    const repo = runConfig.designatedRepo ?? 'owner/stub-issues';
    const outDir = scenario.outDir ? fwd(scenario.outDir) : `${run}/stub-comments`;
    const isResearch = command === 'run-research';
    const rows = [];
    let seq = 0;
    for (const n of command === 'run-reflect' ? Object.keys(scenario.issues ?? {}).map(Number) : issues) {
      const mode = scenario.issues?.[n] ?? scenario.default ?? 'report';
      const issueUrl = `https://${STUB_HOST}/${repo}/issues/${n}`;
      if (command === 'run-reflect') { rows.push({ number: n, state: '반영됨', url: issueUrl }); continue; }
      if (mode === 'blocked') { rows.push({ number: n, state: '막힘', url: issueUrl }); continue; }
      if (mode === 'no-report') { rows.push({ number: n, state: '진행중', url: issueUrl }); continue; }
      if (mode === 'not-found' && !isResearch) throw new StubError('not-found는 run-research에서만 쓸 수 있습니다');
      const hash = commitHash(scenario, runConfig);
      const body = isResearch
        ? researchResult({ issue: n, hash, notFound: mode === 'not-found' })
        : workReport({ issue: n, handoff: handoff ?? 'h1', hash, unmet: mode === 'unmet' });
      seq += 1;
      mkdirSync(outDir, { recursive: true });
      writeFileSync(`${outDir}/${isResearch ? 'answer' : 'result'}-${n}.md`, body);
      rows.push({ number: n, state: '리뷰대기', url: `${issueUrl}#issuecomment-${1000 + seq}` });
    }
    for (const r of rows) if (!STATES.includes(r.state)) throw new StubError(`상태가 올바르지 않습니다: ${r.state}`);
    const code = scenario.exitCode ?? exitCode(rows);
    for (const r of rows) write(formatLine(r));
    return code;
  } catch (e) {
    return fail(e instanceof StubError ? e.message : (e?.message ?? String(e)));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv[2], process.argv.slice(3));
}
