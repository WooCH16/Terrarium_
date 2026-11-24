// 오퍼레이터 역할별 훅 판정 프로필. policy.mjs의 decide가 config.role이 있을 때만 부른다.
// policy.mjs와 import 순환을 피하려고 정책 도우미(h)는 인자로 받는다: { normPath, isInside, resolveFrom, tokenize }.
// 허용 목록 방식: "이 하달의 것"만 통과시키고, 나머지는 모두 거부한다.
import { handoffNames } from './handoff.mjs';
import { STATES } from './report.mjs';
import { VERDICT_HEAD } from './protocol.mjs';

const allow = () => ({ allow: true, reason: '허용' });
const deny = (reason) => ({ allow: false, reason });

const NUM = /^[1-9]\d*$/;
const ABS = /^([a-zA-Z]:[\\/]|\/)/;
const GUARDED_SEGMENTS = new Set(['.git', '.gitmodules', '.gitattributes', '.claude']);
const GUARDED_FILES = new Set(['claude.md', 'agents.md']);
const WORK_DENY = '작업 모드는 이 하달의 gh issue·git -C <대상 프로젝트·통합 폴더·이슈 워크트리> 정해진 모양·run-worker·merge-adapter-enqueue 스크립트만 실행한다';

export function roleOf(input, config) {
  if (config.role && input.agent_type === 'worker') return 'worker';
  return config.role ?? 'coordinator';
}

// 워커·병합 어댑터 스크립트: 스크립트별 허용 플래그와 값 모양을 고정한다(플래그는 한 번씩만).
function workScripts(config) {
  const handoff = (v) => v === config.handoff;
  return {
    'run-worker.mjs': { '--handoff': handoff, '--issue': (v) => NUM.test(v), '--model': (v) => /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(v),
      // 같은 하달 안의 의존 이슈는 앞 이슈의 이슈 브랜치에서 시작한다(run-8: main에서 시작해 앞 이슈를 다시 만들고 충돌했다.
      // run-11: 통합 브랜치에서 시작하면 범위에 병합 커밋이 들어가 반영 무결성 검사가 거부했다).
      // 시작 지점 하달(--base-handoff, 결정 8-31)이 있으면 그 하달의 이슈 브랜치도 받는다. 그 하달의 통합 브랜치는 받지 않는다(같은 이유).
      '--base': (v) => v === 'main' || new RegExp(`^${config.handoff}/issue-[1-9][0-9]{0,8}$`).test(v)
        || (typeof config.baseHandoff === 'string' && /^h[1-9]\d*$/.test(config.baseHandoff) && config.baseHandoff !== config.handoff && new RegExp(`^${config.baseHandoff}/issue-[1-9][0-9]{0,8}$`).test(v)),
      // 서로 기대지 않는 이슈의 워커를 한꺼번에 띄운다: 바로 대기 번호를 받고 wait-operator로 결과를 받는다(background.mjs).
      '--detach': (v) => v === 'yes',
      // 워커가 물은 이슈(종료 코드 4)를 오퍼레이터의 결정(.drafts/answer-<n>-h<N>.md)으로 이어 한다(결정 8-38). 경로는 받지 않는다.
      '--answer': (v) => v === 'yes',
      required: ['--handoff', '--issue', '--model'] },
    'merge-adapter-enqueue.mjs': { '--handoff': handoff, required: ['--handoff'] },
    // run-worker가 9분 안에 안 끝나면 종료 코드 8과 대기 번호를 낸다. 이어서 기다리는 명령(run-8).
    'wait-operator.mjs': { '--wait': (v) => /^[0-9a-f]{12}$/.test(v), required: ['--wait'] },
    // 결과 보고서 초안(기준을 글자 그대로 옮긴 표, run-8 R8-2).
    'result-draft.mjs': { '--handoff': handoff, '--issue': (v) => NUM.test(v), required: ['--handoff', '--issue'] },
  };
}

export function operatorWorkScriptOk(tokens, config, h, cwd) {
  const [bin, script, ...rest] = tokens;
  if (bin !== 'node' || !script || !config.handoff || rest.length % 2 !== 0) return false;
  const p = h.resolveFrom(cwd || config.runDir, script);
  const dir = `${h.normPath(config.harnessDir)}/operator/`;
  if (!p.startsWith(dir)) return false;
  const name = p.slice(dir.length);
  const specs = workScripts(config);
  if (!Object.hasOwn(specs, name)) return false;
  const spec = specs[name];
  const seen = new Set();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    if (flag === 'required' || !Object.hasOwn(spec, flag) || seen.has(flag) || !spec[flag](rest[i + 1])) return false;
    seen.add(flag);
  }
  return spec.required.every((f) => seen.has(f));
}

// ---- gh issue ----
const GH_SPECS = {
  view: { pos: 1, flags: { '--repo': 'repo', '--comments': null, '--json': /^[A-Za-z,]+$/ }, required: [] },
  list: { pos: 0, flags: { '--repo': 'repo', '--state': /^(open|closed|all)$/, '--label': 'label', '--json': /^[A-Za-z,]+$/, '--limit': /^\d{1,3}$/ }, required: [] },
  comment: { pos: 1, flags: { '--repo': 'repo', '--body-file': 'body', '-F': 'body' }, required: ['body'] },
  edit: { pos: 1, flags: { '--repo': 'repo', '--add-label': 'label', '--remove-label': 'label' }, required: ['label'] },
};

function ghIssue(tokens, config, deps, h, cwd) {
  const sub = tokens[2];
  if (!Object.hasOwn(GH_SPECS, sub)) return deny(`gh issue ${sub ?? ''}은 작업 모드에서 쓸 수 없다 (comment·edit·view·list만)`);
  const spec = GH_SPECS[sub];
  const rest = tokens.slice(3);
  const kinds = {};
  let positional = 0;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (!t.startsWith('-')) {
      if (++positional > spec.pos || !NUM.test(t)) return deny('gh issue 인자 모양이 올바르지 않다 (이슈 번호는 숫자 하나)');
      continue;
    }
    if (!Object.hasOwn(spec.flags, t)) return deny(`gh issue ${sub}에서 ${t} 옵션은 쓸 수 없다`);
    const kind = spec.flags[t];
    if (kind === null) { kinds[t] = (kinds[t] ?? 0) + 1; continue; }
    const v = rest[++i];
    if (v === undefined) return deny(`${t}에 값이 없다`);
    const name = kind instanceof RegExp ? t : kind;
    kinds[name] = (kinds[name] ?? 0) + 1;
    if (kind instanceof RegExp) {
      if (!kind.test(v) || kinds[name] > 1) return deny(`${t} 값이 올바르지 않다`);
    } else if (kind === 'repo') {
      if (v !== config.designatedRepo) return deny(`이슈는 지정 저장소(${config.designatedRepo})에만 쓴다`);
    } else if (kind === 'label') {
      if (!STATES.includes(v)) return deny(`라벨은 상태 라벨(${STATES.join(', ')})만 쓸 수 있다`);
    } else if (kind === 'body') {
      if (!ABS.test(v)) return deny('본문 파일은 절대 경로로만 쓴다 (비밀값 검사와 gh가 같은 파일을 읽도록)');
      if (!h.isInside(h.resolveFrom(cwd, v),`${config.issuesClone}/.drafts`) || kinds.body > 1) return deny(`본문 파일은 ${config.issuesClone}/.drafts/ 안에 하나만 둔다`);
    }
  }
  if (kinds.repo !== 1) return deny('--repo를 정확히 한 번 명시하라');
  if (positional !== spec.pos) return deny('이슈 번호가 필요하다');
  if (!spec.required.every((k) => kinds[k])) return deny(`gh issue ${sub}에 필요한 옵션이 빠졌다`);
  if (sub === 'comment') {
    // 판정은 리뷰어의 일이다: 오퍼레이터는 `## 리뷰어 판정`으로 시작하는 댓글을 올리지 못한다(제로폭·전각 문자로 위장해도 같이 거부).
    for (const f of rest.flatMap((t, i) => (t === '--body-file' || t === '-F' ? [rest[i + 1]] : []))) {
      let text = null;
      try { text = deps.readFile ? deps.readFile(f) : null; } catch { /* 읽을 수 없으면 policy의 본문 파일 검사가 거부한다 */ }
      const lead = text === null ? '' : String(text).split(/\r?\n/).map((l) => l.replace(/\p{Cf}/gu, '').normalize('NFKC')).find((l) => l.trim() !== '') ?? '';
      if (/^\s*#{1,6}\s*리뷰어\s*판정/.test(lead)) return deny(`리뷰어 판정 댓글(\`${VERDICT_HEAD}\`)은 오퍼레이터가 올릴 수 없다. 판정은 리뷰어의 일이다`);
    }
  }
  if (sub === 'comment' || sub === 'edit') {
    const vis = deps.visibility ? deps.visibility(config.designatedRepo) : null;
    if (vis !== 'PRIVATE') return deny(`지정 저장소가 비공개로 확인되지 않아(${vis}) 쓰지 않는다. 사용자에게 알려라`);
  }
  return allow();
}

// ---- git ----
const plainRef = (a) => /^[A-Za-z0-9_./~^@-]+$/.test(a) && !a.startsWith('-');
const READ_ONLY = {
  status: (a) => ['-s', '--short', '--porcelain', '-b', '--branch'].includes(a),
  log: (a) => ['--oneline', '--stat', '-n'].includes(a) || /^-?\d{1,3}$/.test(a) || plainRef(a),
  diff: (a) => ['--stat', '--cached', '--name-only', '--name-status'].includes(a) || plainRef(a),
  'rev-parse': (a) => ['HEAD', '--short', '--abbrev-ref', '--show-toplevel'].includes(a),
  show: (a) => ['--stat', '--oneline', '--name-only'].includes(a) || plainRef(a),
};

function gitCmd(tokens, config, deps, h, cwd) {
  if (tokens[1] !== '-C' || tokens.length < 4) return deny(WORK_DENY);
  const at = (p) => h.resolveFrom(cwd, p);
  const memo = at(config.targetProject);
  const names = (n) => handoffNames(config.handoff, n, config.runDir);
  const integ = h.normPath(names(null).integrationFolder);
  const integBranch = names(null).integrationBranch;
  const issueOfBranch = (b) => {
    const m = /^([^/]+)\/issue-([1-9]\d*)$/.exec(b ?? '');
    return m && m[1] === config.handoff ? m[2] : null;
  };
  const ownBranch = (b) => b === integBranch || issueOfBranch(b) !== null;
  const issueOfPath = (p) => {
    const prefix = `${h.normPath(config.runDir)}/worktrees/${config.handoff.toLowerCase()}/issue-`;
    const n = p.startsWith(prefix) ? p.slice(prefix.length) : '';
    return NUM.test(n) && h.normPath(names(n).worktree) === p ? n : null;
  };
  const ctx = at(tokens[2]);
  const sub = tokens[3];
  const rest = tokens.slice(4);
  const bad = () => deny(`git ${sub ?? ''}의 이 모양은 작업 모드에서 허용하지 않는다`);

  if (Object.hasOwn(READ_ONLY, sub)) {
    if (ctx !== memo && ctx !== integ && issueOfPath(ctx) === null) return deny('읽기 명령은 대상 프로젝트·이 하달의 통합 폴더·이슈 워크트리에서만 쓴다');
    return rest.every(READ_ONLY[sub]) ? allow() : bad();
  }
  if (sub === 'worktree' && ctx === memo) {
    const act = rest[0];
    if (act === 'list' && rest.length === 1) return allow();
    if (act === 'remove') {
      const target = rest.length === 2 ? rest[1] : rest.length === 3 && rest[1] === '--force' ? rest[2] : null;
      if (target === null) return bad();
      const p = at(target);
      return p === integ || issueOfPath(p) !== null ? allow() : deny('이 하달의 워크트리·통합 폴더만 지울 수 있다');
    }
    if (act === 'add' && rest.length === 5 && rest[2] === '-b') {
      const [path, , branch, base] = [rest[1], rest[2], rest[3], rest[4]];
      const p = at(path);
      if (branch === integBranch) {
        return p === integ && base === 'main' ? allow() : deny('통합 워크트리는 통합 폴더에 main에서 만든다');
      }
      const n = issueOfBranch(branch);
      if (n !== null && p === h.normPath(names(n).worktree) && (base === 'main' || base === integBranch)) return allow();
      return deny('워크트리 경로·브랜치 이름이 이 하달의 것이 아니거나 시작점이 올바르지 않다');
    }
    return bad();
  }
  if (sub === 'branch' && ctx === memo) {
    return rest.length === 2 && rest[0] === '-D' && ownBranch(rest[1]) ? allow() : deny('이 하달의 브랜치만 -D로 지울 수 있다');
  }
  if (ctx === integ) {
    if (sub === 'merge') {
      const ok = rest.length === 4 && rest[0] === '--no-ff' && issueOfBranch(rest[1]) !== null && rest[2] === '-m' && rest[3] !== '';
      return ok ? allow() : deny('병합은 git -C <통합 폴더> merge --no-ff <이 하달의 이슈 브랜치> -m <메시지> 모양만 쓴다');
    }
    if (sub === 'commit') return rest.length === 2 && rest[0] === '-m' && rest[1] !== '' ? allow() : bad();
    if (sub === 'add') {
      const pathOk = (a) => a === '-A' || (!a.startsWith('-') && !a.startsWith(':') && h.isInside(h.resolveFrom(integ, a), integ)
        && !h.resolveFrom(integ, a).split('/').includes('.git'));
      return rest.length > 0 && rest.every(pathOk) ? allow() : deny('add는 통합 폴더 안 경로나 -A만 쓴다');
    }
  }
  return deny(`git ${sub ?? ''}은 작업 모드에서 이 경로에 쓸 수 없다. main을 바꾸는 명령은 허용하지 않는다`);
}

function operatorWorkBash(input, config, deps, h) {
  const { tokens, unsafe } = h.tokenize(input.tool_input?.command ?? '');
  if (unsafe) return deny('명령 연결·치환·확장·이스케이프·리다이렉트는 쓸 수 없다. 명령은 하나씩 실행하라');
  const cwd = input.cwd || config.runDir;
  try {
    handoffNames(config.handoff, null, config.runDir);
  } catch {
    return deny('작업 모드의 하달 이름 설정이 올바르지 않다');
  }
  if (tokens[0] === 'node' && operatorWorkScriptOk(tokens, config, h, cwd)) return allow();
  if (tokens[0] === 'gh' && tokens[1] === 'issue') return ghIssue(tokens, config, deps, h, cwd);
  if (tokens[0] === 'git') return gitCmd(tokens, config, deps, h, cwd);
  return deny(WORK_DENY);
}

export function decideOperatorWork(input, config, deps, h) {
  const tool = input.tool_name;
  const ti = input.tool_input || {};
  if (tool === 'Read' || tool === 'Grep' || tool === 'Glob') return allow();
  if (tool === 'Bash') return operatorWorkBash(input, config, deps, h);
  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
    const file = ti.file_path || ti.notebook_path;
    if (!file) return deny('쓸 파일 경로가 없다');
    let integ;
    try { integ = handoffNames(config.handoff, null, config.runDir).integrationFolder; } catch { return deny('작업 모드의 하달 이름 설정이 올바르지 않다'); }
    const lex = h.resolveFrom(input.cwd || config.runDir, file);
    const real = h.normPath(deps.realpath ? deps.realpath(lex) : lex);
    const roots = [integ];
    if (tool === 'Write' || tool === 'Edit') roots.push(`${config.issuesClone}/.drafts`);
    // 통합 폴더 안이라도 .git(워크트리 연결 파일)·git 설정·세션 설정 파일은 쓰지 못한다 (윈도우의 끝 점·공백·':스트림'·8.3 이름 포함)
    const guarded = (p) => {
      if (!h.isInside(p, integ)) return false;
      const below = p.slice(h.normPath(integ).length + 1).split('/');
      return below.some((seg, i) => {
        const n = seg.split(':')[0].replace(/[.\s]+$/, '').toLowerCase();
        return GUARDED_SEGMENTS.has(n) || /^git~\d/.test(n) || (i === below.length - 1 && GUARDED_FILES.has(n));
      });
    };
    if (guarded(lex) || guarded(real)) return deny('통합 폴더의 .git·설정 파일(.gitmodules, .gitattributes, .claude, CLAUDE.md, AGENTS.md)은 쓸 수 없다');
    const inRoots = (p) => roots.some((r) => h.isInside(p, r));
    if (!inRoots(lex) || !inRoots(real)) {
      return deny(`${tool}은 ${tool === 'Write' || tool === 'Edit' ? `${config.issuesClone}/.drafts/ 또는 ` : ''}이 하달의 통합 폴더(${integ}) 안에서만 쓸 수 있다`);
    }
    return allow();
  }
  if (tool === 'Agent' || tool === 'Task') return deny('작업 모드는 하위 에이전트를 부르지 않는다. 구현은 run-worker 스크립트로 맡겨라');
  return deny(`작업 모드는 ${tool} 도구를 쓸 수 없다`);
}

// ---- 워커 ----
// 쓰기 범위는 config.worktree(절대 경로) 하나다. 없으면 cwd로 대신하지 않고 모두 거부한다(실패 시 닫힘).
// 알려진 한계: 워커가 쓴 테스트와 package.json의 pretest/posttest 스크립트, 워크트리의 .npmrc, core.hooksPath·git 훅은 `node --test`·`npm test`·`git commit`이 실행하는 코드다.
// 임의 코드 실행은 훅이 아니라 OS 샌드박스만 막을 수 있다.
// git add -A / git add . 는 워크트리 전체를 스테이징한다(허용). .claude·CLAUDE.md 등이 커밋되지 않게 하는 일은 run-worker가 한다: 워커별 core.excludesFile(GIT_CONFIG_* env)로 새 파일을 무시하고, 결과 검사에서 금지 경로를 바꾼 커밋을 거부한다(대상 저장소의 info/exclude는 건드리지 않는다).
const WORKER_GUARDED_FILES = new Set(['claude.md', 'agents.md', 'claude.local.md', '.mcp.json']);
const WORKER_DENY = '워커는 정해진 명령(node --test, npm test, git status·diff·log·show·add·commit 등)만 쓸 수 있다. 네트워크·파일 조작·셸 명령은 쓸 수 없다';
const NODE_NPM_DENY = 'node·npm은 정해진 모양(node --test [워크트리 안 경로…], npm test, npm run test)만 쓸 수 있다';
const WORKER_GIT = new Set(['status', 'diff', 'log', 'show', 'add', 'commit', 'rev-parse', 'branch']);
const WORKER_GIT_ARGS = {
  status: (a) => ['-s', '--short', '--porcelain', '-b', '--branch'].includes(a),
  diff: (a) => ['--stat', '--cached', '--name-only', '--name-status'].includes(a) || plainRef(a),
  log: (a) => ['--oneline', '--stat', '-n'].includes(a) || /^-?\d{1,3}$/.test(a) || plainRef(a),
  show: (a) => ['--stat', '--oneline', '--name-only'].includes(a) || plainRef(a),
  'rev-parse': (a) => ['HEAD', '--short', '--abbrev-ref'].includes(a),
};

// 워크트리 아래 경로에 .git·설정·지침 이름이 있으면 true (윈도우의 끝 점·공백·':스트림'·8.3 이름 포함)
function workerGuarded(p, root, h) {
  if (!h.isInside(p, root)) return false;
  const below = h.normPath(p).slice(root.length + 1).split('/');
  return below.some((seg, i) => {
    const n = seg.split(':')[0].replace(/[.\s]+$/, '').toLowerCase();
    return GUARDED_SEGMENTS.has(n) || /~\d/.test(n) || (i === below.length - 1 && WORKER_GUARDED_FILES.has(n));
  });
}

// 'C:../x' 같은 드라이브 상대 경로는 윈도우에서 현재 폴더 기준으로 풀려 어휘 검사를 우회한다
const driveRelative = (p) => /^[a-zA-Z]:(?![\\/])/.test(String(p));
// 경로 인자는 명시한 파일 경로만 쓴다: 셸이 풀어 쓰는 '~'로 시작하는 토큰, 도구가 스스로 푸는 글롭·패스펙 문자 * ? [ ] { }, 8.3 짧은 이름(~N) 조각은 거부한다
const unsafePathArg = (p) => /^~/.test(p) || /[*?[\]{}]/.test(p) || String(p).split(/[\\/]/).some((seg) => /~\d/.test(seg));
const realOfPath =(lex, deps, h) => h.normPath(deps.realpath ? deps.realpath(lex) : lex);

function workerBash(input, config, deps, h, root) {
  const { tokens, unsafe } = h.tokenize(input.tool_input?.command ?? '');
  if (unsafe) return deny('명령 연결·치환·확장·이스케이프·리다이렉트는 쓸 수 없다. 명령은 하나씩 실행하라');
  const cwd = h.resolveFrom(config.worktree, input.cwd || config.worktree);
  if (!h.isInside(cwd, root) || !h.isInside(realOfPath(cwd, deps, h), root)) return deny(`워커의 명령은 자기 워크트리(${root}) 안에서만 실행한다`);
  const inTree = (p) => { if (driveRelative(p) || unsafePathArg(p)) return false; const lex = h.resolveFrom(cwd, p); return h.isInside(lex, root) && h.isInside(realOfPath(lex, deps, h), root); };
  const [head, sub, ...rest] = tokens;

  if (head === 'node' || head === 'npm' || head === 'npx') {
    if (head === 'npm') return (sub === 'test' && rest.length === 0) || (sub === 'run' && rest.length === 1 && rest[0] === 'test') ? allow() : deny(NODE_NPM_DENY);
    if (head !== 'node' || sub !== '--test' || rest.some((a) => a.startsWith('-'))) return deny(NODE_NPM_DENY);
    return rest.every(inTree) ? allow() : deny(`node --test의 경로는 워크트리 안 경로만 쓴다 (${root})`);
  }
  if (head === 'git') {
    if (sub?.startsWith('-')) return deny('git 전역 옵션(-C, -c, --git-dir, --work-tree 등)은 워커가 쓸 수 없다');
    if (!WORKER_GIT.has(sub)) return deny(`git ${sub ?? ''}은 워커가 쓸 수 없는 git 하위 명령이다`);
    const bad = () => deny(`git ${sub}의 이 모양은 워커가 쓸 수 없는 git 사용법이라 허용하지 않는다`);
    if (Object.hasOwn(WORKER_GIT_ARGS, sub)) return rest.length > 0 || sub !== 'rev-parse' ? (rest.every(WORKER_GIT_ARGS[sub]) ? allow() : bad()) : bad();
    if (sub === 'branch') return rest.length === 1 && rest[0] === '--show-current' ? allow() : bad();
    if (sub === 'commit') {
      if (rest.length === 0 || rest.length % 2 !== 0) return bad();
      for (let i = 0; i < rest.length; i += 2) if (rest[i] !== '-m' || rest[i + 1] === '') return bad();
      return allow();
    }
    // add
    if (rest.length === 0) return bad();
    for (const a of rest) {
      if (a === '-A') continue;
      if (a.startsWith('-') || a.startsWith(':')) return bad();
      if (!inTree(a)) return deny(`git add는 워크트리 안 경로만 쓴다 (${root})`);
      const lex = h.resolveFrom(cwd, a);
      if (workerGuarded(lex, root, h) || workerGuarded(realOfPath(lex, deps, h), root, h)) return deny('.git·설정 파일(.gitmodules, .gitattributes, .claude, CLAUDE.md, AGENTS.md 등)은 add할 수 없다');
    }
    return allow();
  }
  return deny(WORKER_DENY);
}

export function decideWorker(input, config, deps, h) {
  const tool = input.tool_name;
  const ti = input.tool_input || {};
  if (typeof config.worktree !== 'string' || !ABS.test(config.worktree) || h.normPath(config.worktree).length < 4) {
    return deny('워커의 워크트리 설정(config.worktree, 절대 경로)이 없어 모든 도구를 거부한다');
  }
  const root = h.normPath(config.worktree);
  if (tool === 'Read' || tool === 'Grep' || tool === 'Glob') return allow();
  if (tool === 'Bash') return workerBash(input, config, deps, h, root);
  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
    const file = ti.file_path || ti.notebook_path;
    if (!file) return deny('쓸 파일 경로가 없다');
    if (driveRelative(file)) return deny(`${tool}은 워커 자기 워크트리 안에서만 쓸 수 있다 (드라이브 상대 경로는 쓸 수 없다)`);
    const lex = h.resolveFrom(input.cwd || root, file);
    const real = realOfPath(lex, deps, h);
    if (workerGuarded(lex, root, h) || workerGuarded(real, root, h)) {
      return deny('워크트리의 .git·설정 파일(.gitmodules, .gitattributes, .claude, CLAUDE.md, AGENTS.md, CLAUDE.local.md, .mcp.json)은 쓸 수 없다');
    }
    if (!h.isInside(lex, root) || !h.isInside(real, root)) return deny(`${tool}은 워커 자기 워크트리 안에서만 쓸 수 있다 (${root})`);
    return allow();
  }
  return deny(`워커는 ${tool} 도구를 쓸 수 없다`);
}

// ---- 조사·반영 (Task 6) ----
// 둘 다 읽기 위주다: 쓰기는 Write로 <지정 저장소 클론>/.drafts/ 안에만, 대상 프로젝트는 읽기만 한다.
const HANDOFF_RE = /^h[1-9]\d*$/;
const RESEARCH_DENY = '조사 모드는 gh issue comment·view(조사 이슈 하나), git -C <대상 프로젝트> status·log·diff·rev-parse·show 읽기 명령만 실행한다';
const REFLECT_DENY = '반영 모드는 node <하네스>/operator/merge-adapter-land.mjs --handoff <자기 하달>과 git -C <대상 프로젝트> status·log·diff·rev-parse·show 읽기 명령만 실행한다';

// 설정이 빠지거나 모양이 틀리면 모든 도구를 거부한다(실패 시 닫힘).
function gateConfig(config, label, needIssue) {
  if (typeof config.handoff !== 'string' || !HANDOFF_RE.test(config.handoff)) {
    return deny(`${label} 모드의 하달 설정(config.handoff, h<번호>)이 없거나 올바르지 않아 모든 도구를 거부한다`);
  }
  if (needIssue && !(Number.isSafeInteger(config.issue) && config.issue > 0)) {
    return deny(`${label} 모드의 조사 이슈 설정(config.issue, 양의 정수)이 없거나 올바르지 않아 모든 도구를 거부한다`);
  }
  return null;
}

function draftsOnlyWrite(input, config, deps, h, label) {
  const tool = input.tool_name;
  const drafts = `${config.issuesClone}/.drafts`;
  if (tool !== 'Write') return deny(`${label} 모드는 Write로 ${drafts}/ 안에만 쓴다 (${tool}은 쓸 수 없다)`);
  const file = input.tool_input?.file_path;
  if (!file) return deny('쓸 파일 경로가 없다');
  // 드라이브 상대 경로('C:x')와 ':스트림' 이름은 윈도우에서 어휘 검사를 우회한다
  if (driveRelative(file) || String(file).replace(/^[a-zA-Z]:/, '').includes(':')) {
    return deny(`${label} 모드는 드라이브 상대 경로·':스트림' 이름으로 쓸 수 없다 (${drafts}/ 안의 일반 파일만)`);
  }
  const lex = h.resolveFrom(input.cwd || config.runDir, file);
  const real = h.normPath(deps.realpath ? deps.realpath(lex) : lex);
  if (h.isInside(lex, config.targetProject) || h.isInside(real, config.targetProject)) return deny('대상 프로젝트는 읽기 전용이라 쓸 수 없다');
  if (!h.isInside(lex, drafts) || !h.isInside(real, drafts)) return deny(`${label} 모드는 ${drafts}/ 안에서만 쓸 수 있다`);
  return allow();
}

// git -C <대상 프로젝트> 읽기 전용: 인자 모양은 작업 모드의 READ_ONLY 표를 그대로 쓴다.
function memoGitReadOnly(tokens, config, h, cwd, denyMsg) {
  if (tokens[1] !== '-C' || tokens.length < 4 || !Object.hasOwn(READ_ONLY, tokens[3])) return deny(denyMsg);
  if (h.resolveFrom(cwd, tokens[2]) !== h.resolveFrom(cwd, config.targetProject)) return deny('읽기 명령은 대상 프로젝트에서만 쓴다');
  return tokens.slice(4).every(READ_ONLY[tokens[3]]) ? allow() : deny(`git ${tokens[3]}의 이 모양은 읽기 전용 모드에서 허용하지 않는다`);
}

const GH_RESEARCH_FLAGS = { comment: ['--repo', '--body-file'], view: ['--repo', '--comments'] };

// 모양을 먼저 좁게 고정(이슈 번호는 config.issue 하나, 플래그는 한 번씩)한 뒤 저장소·본문 파일·비공개 검사는 ghIssue에 맡긴다.
function researchGh(tokens, config, deps, h, cwd) {
  const sub = tokens[2];
  if (!Object.hasOwn(GH_RESEARCH_FLAGS, sub)) return deny(RESEARCH_DENY);
  if (tokens[3] !== String(config.issue)) return deny(`조사 이슈 #${config.issue}에만 쓸 수 있다 (다른 이슈 번호는 거부)`);
  const allowed = GH_RESEARCH_FLAGS[sub];
  const rest = tokens.slice(4);
  const seen = new Set();
  for (let i = 0; i < rest.length; i++) {
    const f = rest[i];
    if (!allowed.includes(f) || seen.has(f)) return deny(`gh issue ${sub}에서 ${f}는 쓸 수 없거나 한 번만 쓸 수 있다 (허용: ${allowed.join(', ')})`);
    seen.add(f);
    if (f !== '--comments') i++;
  }
  if (!seen.has('--repo')) return deny('--repo를 정확히 한 번 명시하라');
  if (sub === 'comment' && !seen.has('--body-file')) return deny('gh issue comment에 --body-file(본문 파일)이 필요하다');
  return ghIssue(tokens, config, deps, h, cwd);
}

function readOnlyBash(input, config, h, denyMsg, extra) {
  const { tokens, unsafe } = h.tokenize(input.tool_input?.command ?? '');
  if (unsafe) return deny('명령 연결·치환·확장·이스케이프·리다이렉트는 쓸 수 없다. 명령은 하나씩 실행하라');
  const cwd = input.cwd || config.runDir;
  const r = extra(tokens, cwd);
  if (r) return r;
  if (tokens[0] === 'git') return memoGitReadOnly(tokens, config, h, cwd, denyMsg);
  return deny(denyMsg);
}

export function decideOperatorResearch(input, config, deps, h) {
  const bad = gateConfig(config, '조사', true);
  if (bad) return bad;
  const tool = input.tool_name;
  if (tool === 'Read' || tool === 'Grep' || tool === 'Glob') return allow();
  if (tool === 'Bash') {
    return readOnlyBash(input, config, h, RESEARCH_DENY,
      (tokens, cwd) => (tokens[0] === 'gh' && tokens[1] === 'issue' ? researchGh(tokens, config, deps, h, cwd) : null));
  }
  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') return draftsOnlyWrite(input, config, deps, h, '조사');
  // 웹 읽기는 소유자가 허용했다(run-18 #42·#43: 자료 요청은 대개 바깥 서비스의 동작을 묻는다).
  // 직접 도구가 없는 환경에서는 web-fetch 하위 에이전트로 읽는다. 그 안에서는 웹 읽기 도구만 쓴다(decide).
  if (tool === 'WebFetch' || tool === 'WebSearch') return allow();
  if ((tool === 'Agent' || tool === 'Task') && input.tool_input?.subagent_type === 'web-fetch') return allow();
  if (tool === 'Agent' || tool === 'Task') return deny('조사 모드는 웹 읽기(web-fetch) 말고는 하위 에이전트를 부르지 않는다');
  return deny(`조사 모드는 ${tool} 도구를 쓸 수 없다`);
}

// 반영 스크립트: node <하네스>/operator/merge-adapter-land.mjs --handoff <자기 하달> 한 모양만.
export function operatorReflectScriptOk(tokens, config, h, cwd) {
  if (tokens.length !== 4 || tokens[0] !== 'node' || tokens[2] !== '--handoff') return false;
  if (typeof config.handoff !== 'string' || !HANDOFF_RE.test(config.handoff) || tokens[3] !== config.handoff) return false;
  return h.resolveFrom(cwd || config.runDir, tokens[1]) === `${h.normPath(config.harnessDir)}/operator/merge-adapter-land.mjs`;
}

export function decideOperatorReflect(input, config, deps, h) {
  const bad = gateConfig(config, '반영', false);
  if (bad) return bad;
  const tool = input.tool_name;
  if (tool === 'Read' || tool === 'Grep' || tool === 'Glob') return allow();
  if (tool === 'Bash') {
    return readOnlyBash(input, config, h, REFLECT_DENY,
      (tokens, cwd) => (tokens[0] === 'node' ? (operatorReflectScriptOk(tokens, config, h, cwd) ? allow() : deny(REFLECT_DENY)) : null));
  }
  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') return draftsOnlyWrite(input, config, deps, h, '반영');
  if (tool === 'Agent' || tool === 'Task') return deny('반영 모드는 하위 에이전트를 부르지 않는다');
  return deny(`반영 모드는 ${tool} 도구를 쓸 수 없다`);
}
