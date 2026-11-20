// 실행 폴더를 만든다: node setup.mjs --run <dir> --repo <owner/name> [--project <git 폴더>] [--no-clone | --refresh] [--advisor-stub]
//   --project: 대상 프로젝트로 쓸 로컬 git 저장소(main 브랜치 필요). 실행 폴더에 복제하고 원래 저장소와의 연결(origin)은 끊는다.
//              없으면 시험용 메모 프로그램(fixtures/memo)을 쓴다
//   --no-clone: 지정 저장소에 접속하지 않고 빈 저장소로 클론 자리를 만든다(시험용)
//   --refresh: 규칙(CLAUDE.md)·에이전트·설정만 다시 쓴다. 클론, 대상 프로젝트, 로그, 기록은 건드리지 않는다
//   --advisor-stub: advisor 자리에 어드바이저 대역(stubs/advisor-stub.md)을 설치한다(시험용)
// 지정 저장소가 PRIVATE가 아니면(--no-clone, --refresh 제외) 아무것도 쓰지 않고 종료 코드 2로 끝난다.
// HARNESS_GH_BIN은 시험용이다(gh 대신 쓸 실행 파일 또는 .mjs 스크립트).
import { mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ENSURED_LABELS } from './operator/report.mjs';
import { claudeMdExcludes } from './operator/launch.mjs';

const fwd = (p) => resolve(p).replace(/\\/g, '/');
const harnessDir = fwd(dirname(fileURLToPath(import.meta.url)));
const GIT_ID = ['-c', 'user.name=terrarium-harness', '-c', 'user.email=harness@localhost'];
const PLACEHOLDER = /\{\{[A-Z_]+\}\}/;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { stdio: 'pipe', encoding: 'utf8' });
const stop = (message, code = 2) => { console.error(message); process.exit(code); };

// gh 호출. HARNESS_GH_BIN이 .mjs/.js이면 node로 실행한다.
function gh(args, options = {}) {
  const custom = process.env.HARNESS_GH_BIN;
  const script = custom && /\.(mjs|js)$/i.test(custom);
  return execFileSync(custom ? (script ? process.execPath : custom) : 'gh', script ? [custom, ...args] : args, { encoding: 'utf8', stdio: 'pipe', timeout: 60000, windowsHide: true, ...options });
}

const runArg = arg('--run');
const repo = arg('--repo');
const noClone = process.argv.includes('--no-clone');
const refresh = process.argv.includes('--refresh'); // 역할 파일(CLAUDE.md, agents, settings)만 다시 쓴다
const advisorStub = process.argv.includes('--advisor-stub');
const projectArg = arg('--project');
if (!runArg || !repo || (process.argv.includes('--project') && !projectArg)) {
  console.error('usage: node setup.mjs --run <dir> --repo <owner/name> [--project <git 폴더>] [--no-clone | --refresh] [--advisor-stub]');
  process.exit(1);
}
const run = fwd(runArg);
if (!refresh && existsSync(run) && readdirSync(run).length > 0) {
  console.error(`실행 폴더가 비어 있지 않다: ${run}`);
  process.exit(1);
}

// 대상 프로젝트: --refresh는 기존 harness.json의 값을 쓴다. 이름은 실행 폴더 안의 폴더 이름과 기록 문서 이름이 된다.
const RESERVED = new Set(['issues', 'worktrees', 'logs', 'handoffs', 'reviewer-inbox', '.claude', 'records']);
let project = { name: 'memo', source: null };
if (refresh && existsSync(`${run}/harness.json`)) {
  const old = JSON.parse(readFileSync(`${run}/harness.json`, 'utf8'));
  if (typeof old.projectName === 'string') project = { name: old.projectName, source: null };
}
if (projectArg && refresh) stop('--project는 처음 설치할 때만 쓴다. --refresh는 기존 대상 프로젝트를 그대로 둔다.', 1);
if (projectArg) {
  const source = fwd(projectArg);
  const name = basename(source);
  if (!existsSync(source)) stop(`대상 프로젝트 폴더가 없다: ${source}`, 1);
  try { git(source, 'rev-parse', '--verify', '-q', 'refs/heads/main'); } catch { stop(`대상 프로젝트가 git 저장소가 아니거나 main 브랜치가 없다: ${source}`, 1); }
  if (!/^[A-Za-z0-9._-]+$/.test(name) || /^\.+$/.test(name) || RESERVED.has(name)) stop(`대상 프로젝트 폴더 이름 ${JSON.stringify(name)}은 쓸 수 없다(영문·숫자·.-_만, 예약어 ${[...RESERVED].join(', ')} 제외)`, 1);
  project = { name, source };
}

// 1. 아무것도 쓰기 전에 지정 저장소가 비공개인지 확인한다. 확인하지 못해도 막는다(닫힌 쪽).
if (!noClone && !refresh) {
  let visibility;
  try {
    visibility = gh(['repo', 'view', repo, '--json', 'visibility', '-q', '.visibility']).trim();
  } catch (e) {
    stop(`지정 저장소의 공개 여부를 확인하지 못해 아무것도 쓰지 않고 멈춘다: ${String(e.message).split('\n')[0]}`);
  }
  if (visibility !== 'PRIVATE') stop(`지정 저장소 ${repo}가 PRIVATE가 아니다(${JSON.stringify(visibility)}). 아무것도 쓰지 않고 멈춘다. 비공개 저장소를 지정하라.`);
}

const config = {
  designatedRepo: repo,
  issuesClone: `${run}/issues`,
  targetProject: `${run}/${project.name}`,
  projectName: project.name,
  worktrees: `${run}/worktrees`,
  operatorConfig: `${harnessDir}/operator/operator.config.json`,
  harnessDir,
  runDir: run,
};
const fill = (text) => text
  .replaceAll('{{REPO}}', config.designatedRepo)
  .replaceAll('{{ISSUES}}', config.issuesClone)
  .replaceAll('{{MEMO}}', config.targetProject)
  .replaceAll('{{PROJECT}}', config.projectName)
  .replaceAll('{{WORKTREES}}', config.worktrees)
  .replaceAll('{{HARNESS}}', config.harnessDir)
  .replaceAll('{{RUN}}', run);

// 2. 쓸 규칙·에이전트·설정을 먼저 만들고, 자리표시자가 남았으면 쓰기 전에 멈춘다.
const roleFiles = new Map();
roleFiles.set('CLAUDE.md', fill(readFileSync(`${harnessDir}/coordinator.md`, 'utf8')));
roleFiles.set('.claude/agents/advisor.md', fill(readFileSync(advisorStub ? `${harnessDir}/stubs/advisor-stub.md` : `${harnessDir}/agents/advisor.md`, 'utf8')));
roleFiles.set('.claude/settings.json', JSON.stringify({
  permissions: { allow: ['Bash', 'Write', 'Edit', 'Read', 'Glob', 'Grep', 'Agent', 'TodoWrite'] },
  hooks: {
    PreToolUse: [{
      matcher: '*',
      hooks: [{ type: 'command', command: `node "${harnessDir}/guard.mjs" --config "${run}/harness.json"` }],
    }],
  },
  // 사용자 전역 CLAUDE.md와 실행 폴더 상위의 CLAUDE.md가 코디네이터 규칙에 섞이지 않게 한다(이슈 #22)
  claudeMdExcludes: claudeMdExcludes(run),
  env: { CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '2' },
}, null, 2));
roleFiles.set('harness.json', JSON.stringify(config, null, 2));
for (const [name, text] of roleFiles) {
  if (PLACEHOLDER.test(text)) stop(`${name}에 채우지 못한 자리표시자가 남아 있어 아무것도 쓰지 않고 멈춘다: ${text.match(PLACEHOLDER)[0]}`);
}

mkdirSync(`${run}/.claude/agents`, { recursive: true });
mkdirSync(config.worktrees, { recursive: true });
mkdirSync(`${run}/logs`, { recursive: true });
mkdirSync(`${run}/handoffs`, { recursive: true });
mkdirSync(`${run}/reviewer-inbox`, { recursive: true }); // 리뷰어 전용 폴더(ADR 0006): 어드바이저가 제안문을 쓰고 run-reviewer --advice가 읽는다
for (const [name, text] of roleFiles) writeFileSync(`${run}/${name}`, text);

const NEXT = `cd "${run}" && claude --setting-sources project,local --allowedTools "Bash Write Edit Read Glob Grep Agent TodoWrite Skill"`;
if (refresh) {
  console.log(`역할 파일 갱신 완료: ${run}`);
  console.log(`다시 쓴 파일: ${[...roleFiles.keys()].join(', ')}`);
  console.log(`다음 실행 명령: ${NEXT}`);
  process.exit(0);
}

// 대상 프로젝트 저장소: 지정한 저장소의 복제본(원래 저장소에는 쓰지 않는다) 또는 시험용 메모 프로그램
if (project.source) {
  execFileSync('git', ['clone', '-q', project.source, config.targetProject], { stdio: 'pipe' });
  git(config.targetProject, 'checkout', '-q', 'main');
  git(config.targetProject, 'remote', 'remove', 'origin');
  git(config.targetProject, 'config', 'user.name', 'terrarium-harness');
  git(config.targetProject, 'config', 'user.email', 'harness@localhost');
} else {
  cpSync(`${harnessDir}/fixtures/memo`, config.targetProject, { recursive: true });
  writeFileSync(`${config.targetProject}/.gitignore`, 'memos.json\nnode_modules/\n');
  git(config.targetProject, 'init', '-q', '-b', 'main');
  git(config.targetProject, 'config', 'user.name', 'terrarium-harness');
  git(config.targetProject, 'config', 'user.email', 'harness@localhost');
  git(config.targetProject, 'add', '-A');
  git(config.targetProject, 'commit', '-q', '-m', 'memo: 초기 버전 (정렬 없음)');
}

// 지정 저장소 클론
if (noClone) {
  mkdirSync(config.issuesClone, { recursive: true });
  git(config.issuesClone, 'init', '-q', '-b', 'main');
} else {
  gh(['repo', 'clone', repo, config.issuesClone]);
  // 상태 라벨 9개와 취소 라벨(멱등). 이슈를 올릴 때 --label로 붙일 수 있게 미리 만든다.
  for (const name of ENSURED_LABELS) gh(['label', 'create', name, '--repo', repo, '--force', '--description', `하네스 상태: ${name}`]);
}
mkdirSync(`${config.issuesClone}/.drafts`, { recursive: true });
mkdirSync(`${config.issuesClone}/records`, { recursive: true });
writeFileSync(`${config.issuesClone}/.gitignore`, '.drafts/\n');
writeFileSync(`${config.issuesClone}/advisors.md`, [
  '# 어드바이저 목록',
  '',
  '| 이름 (하위 에이전트) | 아는 영역 | 담당 범위 | 연결된 오퍼레이터 |',
  '|---|---|---|---|',
  project.source
    ? `| advisor | ${project.name} | 대상 프로젝트(\`${project.name}/\`) 전체 | operator |`
    : '| advisor | memo | 메모 프로그램(`memo/`)의 기능, 명령줄, 저장 방식, 테스트 | operator |',
  '',
].join('\n'));
if (!existsSync(`${config.issuesClone}/records/${project.name}.md`)) {
  writeFileSync(`${config.issuesClone}/records/${project.name}.md`, `# 기록 문서: ${project.name}\n\n`);
}
git(config.issuesClone, 'add', '-A');
if (git(config.issuesClone, 'status', '--porcelain').trim()) { // 이미 올라가 있으면 커밋할 것이 없다
  git(config.issuesClone, ...GIT_ID, 'commit', '-q', '-m', 'harness: 초기 문서 (어드바이저 목록, 기록 문서)');
  if (!noClone) git(config.issuesClone, 'push', '-q', 'origin', 'HEAD');
}

console.log(`실행 폴더 준비 완료: ${run}`);
console.log('만든 것:');
for (const f of [...roleFiles.keys(), 'worktrees/', 'logs/', 'handoffs/', 'reviewer-inbox/', `${project.name}/ (대상 프로젝트, git 저장소${project.source ? `, ${project.source}의 복제본` : ''})`, `issues/ (지정 저장소 ${noClone ? '대신 빈 저장소' : '클론'}), advisors.md, records/${project.name}.md`]) console.log(`  ${f}`);
console.log(`다음 실행 명령: ${NEXT}`);
