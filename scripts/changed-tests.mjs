// 바뀐 파일에 닿는 시험 고르기(docs/plan-ci-merge-queue.md). 의존성 없이 node만 쓴다.
// 가릴 수 없으면 전체를 고른다: 놓치는 쪽보다 더 돌리는 쪽으로 틀린다.
// - 코드: import·new URL·띄우는 스크립트 이름으로 만든 의존 관계를 거꾸로 따라가 닿는 시험을 고른다.
// - 문서: 실행 중에 읽는 모듈(MODULE_READS)과 직접 읽는 시험(TEST_READS)을 표로 적는다. 문서를 읽는 곳을 새로 만들면 여기에 더한다.
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, posix } from 'node:path';

const FULL = [
  /^harness\/operator\/(protocol|report)\.mjs$/, /^harness\/policy\.mjs$/, /^harness\/.*\.json$/, /^harness\/fixtures\//, /^harness\/github\//,
  /^harness\/test\/(?!.*\.test\.mjs$)/, /^scripts\//, /^\.github\//, /(^|\/)package(-lock)?\.json$/,
];
// 실행 중에 문서를 읽는 모듈 → 그 문서의 폴더
const MODULE_READS = {
  'harness/operator/jev-review.mjs': ['harness/reviewer/'],
  'harness/operator/run-worker.mjs': ['harness/worker/'],
  'harness/operator/launch.mjs': ['harness/operator/'],
  'harness/setup.mjs': ['harness/coordinator/', 'harness/advisor/', 'harness/stubs/'],
};
// 문서를 직접 읽는 시험 파일(이름에서 .test.mjs를 뺀 것). 역할 문서 하나를 여러 시험이 읽으므로 어느 것이 바뀌어도 전부 돌린다.
// changed-tests.test.mjs가 AGENT.md·SKILL.md를 말하는 시험이 이 목록에 있는지 확인한다.
export const ROLE_DOC_TESTS = ['rules', 'config', 'skills', 'operator-docs', 'issue-flow-skill', 'advisor', 'github-flow', 'owner-decision', 'setup', 'worker-doc', 'reviewer-doc', 'run-reviewer', 'advisor-stub', 'operator-stub', 'scenario', 'evidence-names', 'operator-launch', 'operator-merge', 'operator-policy', 'operator-research-stop', 'operator-smoke', 'operator-worker', 'run-worker', 'roles-base', 'policy'];
const REPO_DOC_TESTS = ['rules', 'operator-docs', 'advisor', 'preflight', 'workflows', 'workflow-hooks', 'github-flow'];
// 파일 경로를 띄우지 않고 비교하거나 데이터로 적기만 하는 파일: import만 센다.
// 훅(policy, profiles)은 명령에 적힌 스크립트 경로를 허용 목록과 견줄 뿐이고, 이 선택기와 그 시험은 사례로 적는다.
const NO_NAME_EDGES = /(^|\/)(policy|profiles|changed-tests(\.test)?)\.mjs$/;
const CODE = /\.(mjs|cjs|js)$/;

function walk(root, dir, out = []) {
  const abs = join(root, dir);
  if (!existsSync(abs)) return out;
  for (const name of readdirSync(abs)) {
    if (['node_modules', 'fixtures', 'dist', 'build', 'out'].includes(name) || name.startsWith('.')) continue;
    const rel = `${dir}/${name}`;
    if (statSync(join(root, rel)).isDirectory()) walk(root, rel, out);
    else if (CODE.test(name)) out.push(rel);
  }
  return out;
}

// 파일 → 그 파일이 기대는 저장소 코드 파일들
function dependencies(root, files) {
  const known = new Set(files);
  const graph = new Map();
  for (const file of files) {
    const code = readFileSync(join(root, file), 'utf8').split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
    const deps = new Set();
    for (const m of code.matchAll(/(?:from\s+|import\(\s*|new URL\(\s*)['"](\.\.?\/[^'"]+)['"]/g)) {
      const target = posix.normalize(`${posix.dirname(file)}/${m[1]}`);
      if (known.has(target)) deps.add(target);
    }
    // 스크립트를 띄우거나 경로로 조립하는 문자열(`}/operator/x.mjs`, 'x.mjs')만 센다. 설명·명령 예시 속의 이름은 세지 않는다.
    // 폴더가 적혀 있으면 그 폴더까지 맞는 파일만 잇는다(config.mjs는 두 곳에 있다).
    if (!NO_NAME_EDGES.test(file)) {
      for (const m of code.matchAll(/(?:\}\/|['"`])((?:[\w.-]+\/)*[\w.-]+\.(?:mjs|cjs|js))['"`]/g)) {
        const want = m[1].replace(/^(\.\.?\/)+/, '');
        for (const target of files) if (target !== file && (target === want || target.endsWith(`/${want}`))) deps.add(target);
      }
    }
    graph.set(file, deps);
  }
  return graph;
}

// changed: 저장소 기준 경로(/) 목록. 알 수 없으면 null. → { all, tests: [시험 파일 이름], app, reason }
export function selectTests(changed, { root }) {
  const full = (reason) => ({ all: true, tests: [], app: true, reason });
  if (!Array.isArray(changed)) return full('바뀐 파일을 알 수 없음');
  if (changed.length === 0) return full('바뀐 파일이 없음');
  const files = [...walk(root, 'harness'), ...walk(root, 'scripts'), ...walk(root, 'app')];
  const graph = dependencies(root, files);
  const testOf = (name) => `harness/test/${name}.test.mjs`;
  const tests = new Set();
  const seeds = new Set();
  let app = false;
  for (const path of changed) {
    const rule = FULL.find((r) => r.test(path));
    if (rule) return full(`전체 대상 파일: ${path}`);
    if (/^harness\/test\/[^/]+\.test\.mjs$/.test(path)) { if (existsSync(join(root, path))) tests.add(path); continue; }
    if (/^[^/]+\.md$/.test(path) || /^\.claude\/.*\.md$/.test(path) || path === 'LICENSE') continue; // 시험이 읽지 않는다(check.js는 늘 돈다)
    const isDoc = path.endsWith('.md') && /^(harness|docs|app)\//.test(path);
    if (path.startsWith('app/')) {
      app = true;
      if (CODE.test(path) && existsSync(join(root, path))) seeds.add(path);
      continue;
    }
    if (isDoc) {
      const names = path.startsWith('docs/') ? REPO_DOC_TESTS : path.startsWith('harness/') ? ROLE_DOC_TESTS : null;
      if (!names) return full(`어느 시험이 읽는지 모르는 문서: ${path}`);
      for (const name of names) if (existsSync(join(root, testOf(name)))) tests.add(testOf(name));
      for (const [mod, reads] of Object.entries(MODULE_READS)) if (reads.some((d) => path.startsWith(d))) seeds.add(mod);
      continue;
    }
    if (CODE.test(path) && graph.has(path)) { seeds.add(path); continue; }
    return full(`가릴 수 없는 파일: ${path}`);
  }
  // 거꾸로 따라가기: 바뀐 파일에 기대는 파일들. 닿는 시험이 하나도 없는 모듈이 있으면 전체다.
  for (const seed of seeds) {
    const reached = new Set([seed]);
    for (let grew = true; grew;) {
      grew = false;
      for (const [file, deps] of graph) {
        if (reached.has(file) || /\.test\.mjs$/.test(file)) continue;
        if ([...deps].some((d) => reached.has(d))) { reached.add(file); grew = true; }
      }
    }
    const hit = [...graph].filter(([file, deps]) => /^harness\/test\/[^/]+\.test\.mjs$/.test(file) && [...deps].some((d) => reached.has(d)));
    if (hit.length === 0 && seed.startsWith('harness/')) return full(`닿는 시험이 없는 모듈: ${seed}`);
    for (const [file] of hit) tests.add(file);
  }
  return { all: false, tests: [...tests].map((t) => posix.basename(t)).sort(), app, reason: '' };
}

// base와 갈라진 뒤 바뀐 파일(커밋 전 변경과 새 파일 포함). 알 수 없으면 null.
export function changedFiles(base, git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) {
  try {
    const from = git(['merge-base', base, 'HEAD']).trim();
    if (!from) return null;
    const list = [git(['diff', '--name-only', '--no-renames', '-z', from]), git(['ls-files', '--others', '--exclude-standard', '-z'])];
    return [...new Set(list.join('\0').split('\0').filter(Boolean).map((p) => p.replace(/\\/g, '/')))];
  } catch { return null; }
}
