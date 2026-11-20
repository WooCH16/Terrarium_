// 종단 시험 결과를 하네스 보고와 무관하게 확인한다(T11 끝나는 조건, 이슈 #14).
// node e2e/verify.mjs --run <dir> --since <ISO 시각> [--test-cmd "<대상 프로젝트 시험 명령>"] [--example memo]
//   일반 검사(이슈·보고서·판정·대조 순서, 리뷰어 타입, 이슈 브랜치, main 깨끗함, 기록 문서, 훅 기록)는 대상 프로젝트와 상관없이 돈다.
//   --test-cmd: 반영 뒤 대상 프로젝트 main에서 돌릴 시험 명령(셸로 실행). 없으면 이 검사를 건너뛴다(--example memo는 node --test).
//   --example memo: 시험용 메모 프로그램(fixtures/memo)의 정렬 기능 검사를 더한다(T11).
// HARNESS_GH_BIN은 시험용이다(gh 대신 쓸 실행 파일 또는 .mjs 스크립트).
// 지금 설계 기준: 하달마다 이슈 브랜치 h<N>/issue-<n>, 리뷰어는 별도 실행(ADR 0004), 반영은 사용자 결정 뒤 run-reflect(ADR 0003).
// 대상 프로젝트 main의 검사(시험 통과, 정렬 동작)는 반영 뒤에만 의미가 있다.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { normPath, isInside } from '../policy.mjs';

const arg = (n) => { const i = process.argv.indexOf(n); return i === -1 ? undefined : process.argv[i + 1]; };
const run = arg('--run');
const since = new Date(arg('--since'));
const example = arg('--example');
// 시나리오 모드(T12): node e2e/verify.mjs --scenario <N> --dry  또는  --scenario <N> --run <dir> --since <ISO> [--example memo]
if (process.argv.includes('--scenario')) process.exit(await scenarioMain());
async function scenarioMain() {
  const { scenarioFile, parseScenario, evaluate, readJsonLines } = await import('./scenario.mjs');
  const n = arg('--scenario');
  if (!/^\d{1,2}$/.test(n ?? '')) { console.error('usage: node e2e/verify.mjs --scenario <1~12> (--dry | --run <dir> --since <ISO 시각>) [--example memo]'); return 2; }
  const sc = parseScenario(readFileSync(scenarioFile(Number(n)), 'utf8'));
  if (process.argv.includes('--dry')) {
    console.log(sc.title);
    for (const c of sc.checks) console.log(`${c.kind}  ${c.name}  — ${c.kind === '자동' ? c.exprs.join(', ') : c.product}`);
    return 0;
  }
  if (!run || Number.isNaN(since.getTime())) { console.error('시나리오 검사에는 --run과 --since가 필요합니다(검사 항목만 보려면 --dry).'); return 2; }
  const cfg = JSON.parse(readFileSync(`${run}/harness.json`, 'utf8'));
  const issues = JSON.parse(gh(['issue', 'list', '--repo', cfg.designatedRepo, '--state', 'all', '--limit', '100', '--json', 'number,body,labels,createdAt']))
    .filter((i) => new Date(i.createdAt) >= since);
  const self = process.argv[1];
  const ctx = {
    issues,
    guard: readJsonLines(`${run}/guard.log`, since),
    advice: readJsonLines(`${run}/advice-log.jsonl`, since),
    general: () => spawnSync(process.execPath, [self, '--run', run, '--since', since.toISOString(), ...(example ? ['--example', example] : []), ...(arg('--test-cmd') ? ['--test-cmd', arg('--test-cmd')] : [])], { stdio: 'inherit' }).status === 0,
  };
  let failed = 0;
  console.log(sc.title);
  for (const c of sc.checks) {
    if (c.kind === '직접') { console.log(`직접  ${c.name}  — ${c.product}`); continue; }
    for (const e of c.exprs) {
      const r = evaluate(e, ctx);
      if (!r.pass) failed++;
      console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${c.name} [${e}]  — ${r.detail}`);
    }
  }
  console.log(failed ? `\n자동 검사 ${failed}개 실패` : '\n자동 검사 모두 통과(직접 확인 줄은 사람이 본다)');
  return failed ? 1 : 0;
}
if (!run || Number.isNaN(since.getTime()) || (example !== undefined && example !== 'memo') || (process.argv.includes('--test-cmd') && !arg('--test-cmd'))) {
  console.error('usage: node e2e/verify.mjs --run <dir> --since <ISO 시각> [--test-cmd "<명령>"] [--example memo]');
  process.exit(2);
}
const testCmd = arg('--test-cmd') ?? (example === 'memo' ? 'node --test' : undefined);
const config = JSON.parse(readFileSync(`${run}/harness.json`, 'utf8'));
const projectName = config.projectName ?? 'memo';
const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass: Boolean(pass), detail });
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
const MODELS = ['claude', 'gemini', 'muse'];

function gh(args) {
  const custom = process.env.HARNESS_GH_BIN;
  const script = custom && /.(mjs|js)$/i.test(custom);
  return execFileSync(custom ? (script ? process.execPath : custom) : 'gh', script ? [custom, ...args] : args, { encoding: 'utf8' });
}
const issues = JSON.parse(gh(['issue', 'list', '--repo', config.designatedRepo, '--state', 'all',
  '--limit', '100', '--json', 'number,title,body,state,createdAt,comments']))
  .filter((i) => new Date(i.createdAt) >= since)
  .sort((a, b) => a.number - b.number);

const project = config.targetProject;
const branches = git(project, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n').filter(Boolean);

// 보고서의 `실제 워커 모델:` 줄, 없으면 본문의 `워커 모델:` 줄(run-reviewer workerTypeOf와 같은 순서).
const typeIn = (text, label) => {
  const m = new RegExp(`^[-*\\s]*${label}:\\s*\`?(${MODELS.join('|')})\`?\\s*$`, 'm').exec(text ?? '');
  return m ? m[1] : null;
};

check('이슈가 2개 이상 등록됨', issues.length >= 2, `${issues.length}개: ${issues.map((i) => '#' + i.number).join(', ')}`);
for (const i of issues) {
  const bodies = i.comments.map((c) => c.body.trimStart());
  check(`#${i.number} 본문에 완료 기준 표(기준 / 확인 방법)`, /\|\s*기준\s*\|\s*확인 방법\s*\|/.test(i.body));
  check(`#${i.number} 본문에 근거(지시 원문)`, /지시 원문/.test(i.body));
  const reportAt = bodies.findLastIndex((b) => b.startsWith('## 결과 보고서'));
  const report = bodies[reportAt];
  check(`#${i.number} 결과 보고서 댓글(4칸)`, report && ['기준별 충족 여부', '근거 위치', '변경 요약', '남은 문제'].every((k) => report.includes(k)));
  const verdictAt = bodies.findIndex((b, k) => k > reportAt && b.startsWith('## 리뷰어 판정: 허용'));
  const verdict = bodies[verdictAt];
  check(`#${i.number} 보고서 뒤에 리뷰어 허용 댓글(모델 이름 포함)`, reportAt >= 0 && verdictAt > reportAt && /리뷰어 모델:\s*\S+/.test(verdict));
  const checkAt = bodies.findIndex((b, k) => k > verdictAt && b.startsWith('## 코디네이터 대조 결과'));
  check(`#${i.number} 판정 뒤에 코디네이터 대조 결과 댓글`, verdictAt >= 0 && checkAt > verdictAt);
  const worker = typeIn(report, '실제 워커 모델') ?? typeIn(i.body, '워커 모델');
  // 리뷰어는 Jev(이슈 #44, ADR 0008). 그 전 실행 기록(LLM 리뷰어)도 읽을 수 있게 세 모델 값도 받는다.
  const reviewer = /리뷰어 모델:\s*(jev|claude|gemini|muse)\b/.exec(verdict ?? '')?.[1] ?? null;
  check(`#${i.number} 리뷰어 타입이 워커 타입과 다름`, worker && reviewer && worker !== reviewer, `워커 ${worker ?? '?'} / 리뷰어 ${reviewer ?? '?'}`);
  check(`#${i.number} 이슈 닫힘`, i.state === 'CLOSED', i.state);
  const own = branches.filter((b) => new RegExp(`^h\\d+/issue-${i.number}$`).test(b));
  check(`#${i.number} 하달 이슈 브랜치(h<N>/issue-${i.number})`, own.length > 0, own.join(', ') || '없음');
}

const branch = git(project, 'branch', '--show-current');
const dirty = git(project, 'status', '--porcelain');
check('대상 프로젝트 본 줄기가 main이고 깨끗함', branch === 'main' && dirty === '', `branch=${branch} dirty=${dirty || '없음'}`);
if (testCmd) {
  const t = spawnSync(testCmd, { cwd: project, encoding: 'utf8', shell: true });
  const summary = (t.stdout.match(/ℹ (tests|pass|fail) \d+/g) || []).join(', ');
  check(`(반영 뒤) 대상 프로젝트 main에서 시험 통과(${testCmd})`, t.status === 0, summary || `종료 코드 ${t.status}`);
} else {
  check('(참고) 대상 프로젝트 시험', true, '--test-cmd가 없어 건너뜀');
}

// 메모 예제 검사(--example memo): T11의 정렬 기능.
if (example === 'memo') {
const memo = project;
const testDir = `${memo}/test`;
const testText = !existsSync(testDir) ? '' : readdirSync(testDir).map((f) => readFileSync(`${memo}/test/${f}`, 'utf8')).join('\n');
check('(반영 뒤) main에 정렬 테스트가 있음(--sort created / title)', /--sort/.test(testText) && /created/.test(testText) && /title/.test(testText));
const memoFile = `${run}/verify-memos-${Date.now()}.json`;
const memoCli = (...a) => spawnSync(process.execPath, ['cli.mjs', ...a], { cwd: memo, encoding: 'utf8', env: { ...process.env, MEMO_FILE: memoFile } });
memoCli('add', '나비', 'x');
memoCli('add', '가지', 'y');
const titles = (r) => r.stdout.trim().split('\n').map((l) => l.split('\t')[1]).join(',');
const byTitle = memoCli('list', '--sort', 'title');
const byCreated = memoCli('list', '--sort', 'created');
const plain = memoCli('list');
check('(반영 뒤) cli --sort title 은 가나다순', byTitle.status === 0 && titles(byTitle) === '가지,나비', titles(byTitle) || byTitle.stderr.trim());
check('(반영 뒤) cli --sort created 와 옵션 없음은 추가한 순서', titles(byCreated) === '나비,가지' && titles(plain) === '나비,가지', `${titles(byCreated)} / ${titles(plain)}`);
}

// records/<프로젝트 이름>.md: 시작일 이후의 "전달 예정"과 "최종 보고" 줄, 그리고 푸시됨(업스트림보다 앞선 커밋 없음).
const clone = config.issuesClone;
const day = since.toISOString().slice(0, 10);
const recordsPath = `${clone}/records/${projectName}.md`;
const records = existsSync(recordsPath) ? readFileSync(recordsPath, 'utf8').split(/\r?\n/) : [];
const lines = records.filter((l) => (/^- (\d{4}-\d{2}-\d{2})/.exec(l)?.[1] ?? '') >= day);
check(`records/${projectName}.md에 "전달 예정" 줄`, lines.some((l) => l.includes('전달 예정')));
check(`records/${projectName}.md에 "최종 보고" 줄`, lines.some((l) => l.includes('최종 보고')));
let ahead = '?';
try { ahead = git(clone, 'rev-list', '--count', '@{u}..HEAD'); } catch { /* 업스트림 없음 */ }
const cloneDirty = git(clone, 'status', '--porcelain');
check('기록 문서가 커밋·푸시됨', ahead === '0' && cloneDirty === '', `앞선 커밋 ${ahead}, 변경 ${cloneDirty || '없음'}`);

const log = existsSync(`${run}/guard.log`) ? readFileSync(`${run}/guard.log`, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const recent = log.filter((l) => new Date(l.time) >= since);
const leaked = recent.filter((l) => l.agent_type === null && l.allow && ['Write', 'Edit', 'Bash'].includes(l.tool_name)
  && (isInside(l.summary, project) || normPath(l.summary).includes(normPath(project))));
check('코디네이터가 대상 프로젝트를 쓰거나 실행한 기록 없음', leaked.length === 0, leaked.map((l) => l.summary).join(' | '));
const deniedWrites = recent.filter((l) => !l.allow && ['Write', 'Edit'].includes(l.tool_name));
check('guard.log에 거부된 쓰기가 없음', deniedWrites.length === 0, deniedWrites.map((l) => `${l.agent_type ?? 'coordinator'}/${l.tool_name}`).join(', '));
const denied = recent.filter((l) => !l.allow);
check('(참고) 이번 실행 중 훅 거부 건수', true, `${denied.length}건${denied.length ? ': ' + denied.map((l) => `${l.agent_type ?? 'coordinator'}/${l.tool_name}`).join(', ') : ''}`);

for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
