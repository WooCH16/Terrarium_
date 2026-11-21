// 금지·제한 판정 (ADR 0001 결정 3·4, ADR 0002 결정 B). 훅(guard.mjs)이 호출한다.
// agent_type이 없으면 코디네이터 호출로 보고 허용 목록을 적용한다.
import { posix } from 'node:path';
import { roleOf, decideOperatorWork, decideWorker, decideOperatorResearch, decideOperatorReflect, operatorWorkScriptOk, operatorReflectScriptOk } from './operator/profiles.mjs';

const SECRET_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9]{36}/,
  /github_pat_[A-Za-z0-9_]{22,}/,
  /sk-[A-Za-z0-9_-]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /AIza[0-9A-Za-z_-]{35}/,
  /xox[abprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const COORDINATOR_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Agent', 'Task', 'TodoWrite', 'ToolSearch', 'Bash', 'Write', 'Edit', 'Skill']);
// ADR 0004 결정 B: 리뷰어는 하위 에이전트가 아니라 별도 실행이다. 실행 명령은 OPERATOR_SCRIPTS의 run-reviewer.mjs(T6).
const SPAWNABLE = { coordinator: new Set(['advisor']) };
const GH_ISSUE_READ = new Set(['view', 'list']);
const GH_ISSUE_WRITE = new Set(['create', 'comment', 'edit', 'close', 'reopen']);

const allow = () => ({ allow: true, reason: '허용' });
const deny = (reason) => ({ allow: false, reason });

export function normPath(p) {
  let s = String(p ?? '').replace(/\\/g, '/');
  const m = s.match(/^\/([a-zA-Z])\//); // Git Bash 형식 /c/...
  if (m) s = `${m[1]}:/${s.slice(3)}`;
  return posix.normalize(s).replace(/\/+$/, '').toLowerCase();
}

export function isInside(p, dir) {
  const a = normPath(p);
  const b = normPath(dir);
  return a === b || a.startsWith(b + '/');
}

const isAbsolute = (p) => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\');
const resolveFrom = (cwd, p) => (isAbsolute(p) ? normPath(p) : normPath(`${normPath(cwd)}/${String(p).replace(/\\/g, '/')}`));

export function findSecret(text) {
  const s = String(text ?? '');
  return SECRET_PATTERNS.some((re) => re.test(s));
}

// 따옴표를 존중해 토큰으로 나누고, 셸 연결·치환·확장·이스케이프 문자가 있으면 unsafe로 표시한다.
export function tokenize(command) {
  const tokens = [];
  let cur = '';
  let quote = null;
  let started = false;
  let unsafe = false;
  const s = String(command);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === "'") {
      if (c === "'") quote = null; else cur += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '`' || c === '$' || c === '\\') unsafe = true;
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; started = true; continue; }
    if (/\s/.test(c)) {
      if (c === '\n' || c === '\r') unsafe = true;
      if (started) { tokens.push(cur); cur = ''; started = false; }
      continue;
    }
    if (';&|<>`$\\(){}'.includes(c)) unsafe = true;
    cur += c;
    started = true;
  }
  if (quote) unsafe = true;
  if (started) tokens.push(cur);
  return { tokens, unsafe };
}

function bodyFiles(tokens) {
  const files = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '--body-file' || tokens[i] === '-F') files.push(tokens[i + 1]);
    else if (tokens[i].startsWith('--body-file=')) files.push(tokens[i].slice(12));
  }
  return files.filter(Boolean).map((f) => f.replace(/[;&|)]+$/, ''));
}

function writtenText(tool, input) {
  if (tool === 'Write') return input.content;
  if (tool === 'Edit') return input.new_string;
  if (tool === 'MultiEdit') return (input.edits || []).map((e) => e.new_string).join('\n');
  if (tool === 'NotebookEdit') return input.new_source;
  return '';
}

// 어떤 역할도 쓰면 안 되는 곳: 하네스 설정·훅, 실행 폴더 제어 파일, 지정 저장소 클론의 git 내부
function protectedPaths(config) {
  const r = config.runDir;
  const c = config.issuesClone;
  return [`${r}/.claude`, config.harnessDir, `${r}/harness.json`, `${r}/CLAUDE.md`, `${r}/.visibility-cache.json`,
    `${r}/guard.log`, `${r}/logs`, `${r}/handoffs`, `${r}/advice-log.jsonl`, `${r}/operator.local.json`, `${c}/.git`, `${c}/.gitattributes`, `${c}/.gitmodules`];
}
const isProtected = (p, config) => protectedPaths(config).some((d) => isInside(p, d));

const realOf = (p, deps) => normPath(deps.realpath ? deps.realpath(p) : p);

// Bash 명령의 토큰에서 경로 후보를 뽑아 보호 경로에 닿는지 본다(상대 경로는 cwd 기준).
function bashTouchesProtected(command, cwd, config) {
  const { tokens } = tokenize(command);
  for (const t of tokens) {
    for (const part of t.split(/[;&|<>()=]+/)) {
      if (!part || /^-/.test(part) && !part.includes('/')) continue;
      if (isProtected(resolveFrom(cwd || config.runDir, part), config)) return true;
    }
  }
  return false;
}

// 오퍼레이터 시작·중지 스크립트: 스크립트별로 허용 플래그와 값 모양을 고정한다(플래그는 한 번씩만).
const OPERATOR_SCRIPTS = {
  'run-operator.mjs': { '--issues': /^\d+(,\d+)*$/, '--handoff': /^h[1-9]\d*$/, required: ['--issues'] },
  'run-research.mjs': { '--issue': /^\d+$/, required: ['--issue'] },
  'run-reflect.mjs': { '--handoff': /^h[1-9]\d*$/, required: ['--handoff'] },
  // ADR 0004: 리뷰어는 Pi 등으로 띄우는 별도 실행이다. 코디네이터는 이 스크립트로만 부른다(워커 모델은 스크립트가 이슈에서 읽는다).
  'run-reviewer.mjs': { '--issue': /^\d+$/, required: ['--issue'] },
  'stop-operator.mjs': { '--handoff': /^h[1-9]\d*$/, required: ['--handoff'] },
  // run-7: 하달·조사는 분리 실행되고, 9분 안에 안 끝나면 대기 번호(12자리)가 온다. 이어서 기다리는 명령.
  'wait-operator.mjs': { '--wait': /^[0-9a-f]{12}$/, required: ['--wait'] },
  // 이슈 #44: Jev 라우팅(워커 모델·유형). 초안 이름만 받고 스크립트가 지정 저장소 클론의 .drafts/ 안에서 찾는다.
  'route-issue.mjs': { '--draft': /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/, required: ['--draft'] },
};

function operatorScriptArgsOk(script, rest) {
  const spec = OPERATOR_SCRIPTS[script];
  if (!spec || rest.length % 2 !== 0) return false;
  const seen = new Set();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    if (flag === 'required' || !Object.hasOwn(spec, flag) || seen.has(flag) || !spec[flag].test(rest[i + 1])) return false;
    seen.add(flag);
  }
  return spec.required.every((f) => seen.has(f));
}

function operatorScriptCommandOk(tokens, config) {
  const [bin, script, ...rest] = tokens;
  if (bin !== 'node' || !script) return false;
  const p = normPath(script);
  const dir = `${normPath(config.harnessDir)}/operator/`;
  if (!p.startsWith(dir)) return false;
  return operatorScriptArgsOk(p.slice(dir.length), rest);
}

// ADR 0006: 어드바이저(코디네이터 세션의 advisor 하위 에이전트)의 리뷰어 전용 폴더. 실행 폴더 아래에 setup.mjs가 만든다.
export const reviewerInbox = (config) => `${normPath(config.runDir)}/reviewer-inbox`;
const ADVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ADVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

// 어드바이저가 실행할 수 있는 명령은 정확히 하나다: node <하네스>/operator/run-reviewer.mjs --advice <전용 폴더 바로 아래 파일> --advice-id <id>
// (두 플래그는 한 번씩, 순서는 자유. 제안문 경로는 cwd 기준으로 풀고 실제 경로도 전용 폴더 안이어야 한다. run-reviewer.mjs도 같은 검사를 한다.)
function advisorReviewerCommandOk(tokens, config, cwd, deps) {
  const [bin, script, ...rest] = tokens;
  if (bin !== 'node' || !script || rest.length !== 4) return false;
  if (resolveFrom(cwd || config.runDir, script) !== `${normPath(config.harnessDir)}/operator/run-reviewer.mjs`) return false;
  const args = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--advice', '--advice-id'].includes(rest[i]) || rest[i] in args) return false;
    args[rest[i]] = rest[i + 1];
  }
  if (!ADVICE_ID.test(args['--advice-id'] ?? '')) return false;
  const inbox = reviewerInbox(config);
  const lex = resolveFrom(cwd || config.runDir, args['--advice'] ?? '');
  const real = realOf(lex, deps);
  return posix.dirname(lex) === inbox && ADVICE_NAME.test(posix.basename(lex)) && posix.dirname(real) === normPath(realOf(inbox, deps));
}

// 모든 역할에 공통: 비밀값, 보호 경로, 하위 에이전트 생성 범위
function commonChecks(input, config, deps) {
  const tool = input.tool_name;
  const toolInput = input.tool_input || {};
  if (WRITE_TOOLS.has(tool)) {
    const filePath = toolInput.file_path || toolInput.notebook_path;
    if (filePath && (isProtected(filePath, config) || isProtected(realOf(filePath, deps), config))) {
      return deny('하네스 설정·제어 파일과 지정 저장소의 git 내부는 고칠 수 없다');
    }
  }
  if (findSecret(writtenText(tool, toolInput))) return deny('비밀값으로 보이는 문자열은 쓰지 않는다. 존재와 용도만 적어라');
  // 역할이 있는 세션(오퍼레이터)의 하위 에이전트는 그 역할 프로필이 막고 자기 문구를 낸다. 여기서 코디네이터로 보면
  // 거부 문구에 coordinator가 찍힌다(run-18 h16, 조사 세션의 web-fetch).
  if ((tool === 'Agent' || tool === 'Task') && !(config.role && !input.agent_type)) {
    const who = input.agent_type ?? 'coordinator';
    const allowed = SPAWNABLE[who];
    if (!allowed || !allowed.has(toolInput.subagent_type)) {
      return deny(`${who}는 ${toolInput.subagent_type ?? '(종류 없음)'} 에이전트를 부를 수 없다`);
    }
  }
  if (tool === 'Bash' || tool === 'PowerShell') {
    const cmd = String(toolInput.command ?? '');
    if (findSecret(cmd)) return deny('명령에 비밀값으로 보이는 문자열이 있다');
    const tk = tokenize(cmd);
    const operatorScript = tool === 'Bash' && !tk.unsafe && (
      (!input.agent_type
        && (operatorScriptCommandOk(tk.tokens, config)
          || (config.role === 'operator-work' && operatorWorkScriptOk(tk.tokens, config, PROFILE_HELPERS, input.cwd))
          || (config.role === 'operator-reflect' && operatorReflectScriptOk(tk.tokens, config, PROFILE_HELPERS, input.cwd))))
      || (input.agent_type === 'advisor' && !config.role && advisorReviewerCommandOk(tk.tokens, config, input.cwd, deps)));
    if (!operatorScript && bashTouchesProtected(cmd, input.cwd, config)) return deny('하네스 설정·제어 파일이나 지정 저장소의 git 내부에 닿는 명령은 실행할 수 없다');
    for (const f of bodyFiles(tokenize(cmd).tokens)) {
      let text;
      try { text = deps.readFile(f); } catch {
        return deny(`본문 파일을 읽을 수 없어 비밀값 검사를 할 수 없다: ${f}. 파일을 먼저 만든 뒤 gh 명령은 따로 실행하라`);
      }
      if (findSecret(text)) return deny('본문 파일에 비밀값으로 보이는 문자열이 있다');
    }
  }
  return null;
}

function repoFlags(tokens) {
  const values = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--repo' || t === '-R') values.push(tokens[i + 1]);
    else if (t.startsWith('--repo=')) values.push(t.slice(7));
    else if (t.startsWith('-R')) values.push(t.slice(2));
  }
  return values;
}

const publicDeny = (vis) => deny(`지정 저장소가 공개 저장소(${vis})라 쓰지 않는다. 사용자에게 알려라`);

function coordinatorGh(tokens, config, deps) {
  const sub = tokens[2];
  const repos = repoFlags(tokens);
  if (repos.length !== 1 || repos[0] !== config.designatedRepo) {
    return deny(`이슈는 지정 저장소(${config.designatedRepo})에만 쓴다. --repo를 정확히 한 번 명시하라`);
  }
  for (const f of bodyFiles(tokens)) {
    if (!isInside(f, `${config.issuesClone}/.drafts`)) return deny(`본문 파일은 ${config.issuesClone}/.drafts/ 안에 둔다`);
  }
  // 판정은 리뷰어, 결과 보고서는 오퍼레이터의 일이다: 코디네이터 댓글이 그 머리줄로 시작하면 거부한다(제로폭·전각 문자 위장 포함).
  if (sub === 'comment') {
    const texts = [];
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === '--body' || tokens[i] === '-b') texts.push(tokens[i + 1] ?? '');
      else if (tokens[i].startsWith('--body=')) texts.push(tokens[i].slice(7));
    }
    for (const f of bodyFiles(tokens)) { try { texts.push(String(deps.readFile(f))); } catch { /* 읽을 수 없는 본문 파일은 gh가 실패한다 */ } }
    for (const text of texts) {
      const lead = String(text).split(/\r?\n/).map((l) => l.replace(/\p{Cf}/gu, '').normalize('NFKC')).find((l) => l.trim() !== '') ?? '';
      if (/^\s*#{1,6}\s*(리뷰어\s*판정|결과\s*보고서)/.test(lead)) return deny('리뷰어 판정과 결과 보고서 댓글은 코디네이터가 올리지 않는다. 판정은 리뷰어(run-reviewer), 보고서는 오퍼레이터의 일이다');
    }
  }
  if (GH_ISSUE_WRITE.has(sub)) {
    const vis = deps.visibility(config.designatedRepo);
    if (vis !== 'PRIVATE') return publicDeny(vis);
  }
  return allow();
}

// git -C <클론> 의 하위 명령마다 허용하는 인자 모양을 고정한다.
function gitArgsOk(sub, rest, config) {
  const plainRef = (a) => /^[A-Za-z0-9_./~^@-]+$/.test(a) && !a.startsWith('-');
  switch (sub) {
    case 'status': return rest.every((a) => ['-s', '--short', '--porcelain'].includes(a));
    case 'add': return rest.length > 0 && rest.every((a) => a === '-A'
      || (!a.startsWith('-') && isInside(resolveFrom(config.issuesClone, a), config.issuesClone)));
    case 'commit': {
      if (rest.length < 2 || rest.length % 2) return false;
      for (let i = 0; i < rest.length; i += 2) if (rest[i] !== '-m') return false;
      return true;
    }
    case 'push': return [[], ['origin'], ['origin', 'HEAD'], ['origin', 'main']].some((s) => s.join(' ') === rest.join(' '));
    case 'pull': return rest.every((a) => ['--ff-only', '--rebase'].includes(a));
    case 'log': return rest.every((a) => ['--oneline', '--stat', '-n'].includes(a) || /^-n?\d{1,3}$/.test(a) || /^\d{1,3}$/.test(a) || plainRef(a));
    case 'diff': return rest.every((a) => ['--stat', '--cached'].includes(a) || plainRef(a));
    case 'rev-parse': return rest.every((a) => ['HEAD', '--short', '--abbrev-ref'].includes(a));
    default: return false;
  }
}

function coordinatorBash(command, config, deps) {
  const { tokens, unsafe } = tokenize(command);
  if (unsafe) return deny('명령 연결·치환·확장·이스케이프·리다이렉트는 쓸 수 없다. 명령은 하나씩 실행하라');
  const [bin, a1, a2] = tokens;
  if (bin === 'node' && operatorScriptCommandOk(tokens, config)) return allow();
  if (bin === 'gh' && a1 === 'issue' && (GH_ISSUE_READ.has(a2) || GH_ISSUE_WRITE.has(a2))) return coordinatorGh(tokens, config, deps);
  if (bin === 'gh' && a1 === 'repo' && a2 === 'view' && tokens[3] === config.designatedRepo
    && tokens.slice(4).every((a) => ['--json', 'visibility', 'name', 'visibility,name'].includes(a))) return allow();
  if (bin === 'git' && a1 === '-C' && normPath(a2) === normPath(config.issuesClone)) {
    const sub = tokens[3];
    if (!gitArgsOk(sub, tokens.slice(4), config)) return deny(`git ${sub ?? ''}의 이 인자 모양은 허용하지 않는다`);
    if (sub === 'push') {
      const vis = deps.visibility(config.designatedRepo);
      if (vis !== 'PRIVATE') return publicDeny(vis);
    }
    return allow();
  }
  return deny('코디네이터는 지정 저장소의 gh issue·gh repo view·git -C <지정 저장소 클론> 명령과 오퍼레이터 시작·중지 스크립트(node <하네스>/operator/run-operator·run-research·run-reflect·stop-operator.mjs, 정해진 플래그 모양만)만 실행한다. 대상 프로젝트 실행은 오퍼레이터에게 맡겨라');
}

// 코디네이터가 읽거나 검색하면 안 되는 비밀값 파일 이름 (예시·견본 파일은 허용)
const SECRET_FILE_NAMES = [/^\.env(\..+)?$/, /\.(pem|key|p12|pfx)$/, /^id_(rsa|dsa|ecdsa|ed25519)$/, /^\.(netrc|npmrc)$/,
  /^credentials(\..+)?$/, /^secrets?\.(json|ya?ml|toml)$/];
const EXAMPLE_FILE = /\.(example|sample|template)$/;

function isSecretFileName(name) {
  // Windows는 끝의 점·공백과 ':스트림' 이름을 같은 파일로 본다
  const base = String(name).split(':')[0].replace(/[.\s]+$/, '');
  return !EXAMPLE_FILE.test(base) && SECRET_FILE_NAMES.some((re) => re.test(base));
}
const isSecretFile = (p) => isSecretFileName(normPath(p).split('/').pop());
// Grep의 glob 인자가 비밀값 파일 이름을 가리키는지: '*'를 비우거나 아무 글자로 바꿔 두 번 본다
const globNamesSecret = (g) => {
  const seg = String(g).replace(/\\/g, '/').split('/').pop().toLowerCase();
  return isSecretFileName(seg.replace(/\*/g, '')) || isSecretFileName(seg.replace(/\*/g, 'x'));
};

// Read·Grep가 비밀값 파일(.env, 키 파일 등)을 읽거나 검색하지 못하게 한다. 코디네이터, 그 하위 에이전트, 조사 모드 오퍼레이터에 같이 쓴다.
function secretReadCheck(input, config, deps) {
  const toolInput = input.tool_input || {};
  const target = toolInput.file_path ?? toolInput.path;
  if (target) {
    const abs = resolveFrom(input.cwd || config.runDir, target);
    if (isSecretFile(abs) || isSecretFile(realOf(abs, deps))) {
      return deny('비밀값 파일(.env, 키 파일 등)은 읽지 않는다. 존재와 용도만 확인하고 값은 보지 마라');
    }
  }
  if (input.tool_name === 'Grep' && toolInput.glob && globNamesSecret(toolInput.glob)) {
    return deny('비밀값 파일(.env, 키 파일 등)은 검색하지 않는다');
  }
  return null;
}

// 코디네이터 세션의 하위 에이전트는 advisor 하나다(리뷰어는 하위 에이전트가 아니라 별도 실행, ADR 0004 결정 B. 소유자 결정 5-1로 정의도 지웠다).
// advisor: 읽기(비밀값 파일 제외) + 리뷰어 전용 폴더 안 Write·Edit + 조언 판정 명령 하나(ADR 0006 결정 2).
// 대상 프로젝트·작업 폴더·지정 저장소 클론·git·gh 명령은 쓸 수 없다.
function decideSubagent(input, config, deps) {
  const who = input.agent_type;
  const tool = input.tool_name;
  const toolInput = input.tool_input || {};
  if (who !== 'advisor') return deny(`알 수 없는 하위 에이전트(${who})는 도구를 쓸 수 없다`);
  if (tool === 'Read' || tool === 'Grep' || tool === 'Glob') return secretReadCheck(input, config, deps) ?? allow();
  // 대화형 세션에서 하위 에이전트는 결과를 SubagentHandback으로 코디네이터에게 돌려준다. 막으면 어드바이저가 보고 없이 끝난다(run-18, 2026-11-20).
  // 이 도구는 부모에게 글을 돌려줄 뿐 파일·명령·밖에 닿지 않는다.
  if (tool === 'SubagentHandback') return allow();
  const inbox = reviewerInbox(config);
  if (tool === 'Write' || tool === 'Edit') {
    const file = toolInput.file_path;
    if (!file) return deny('쓸 파일 경로가 없다');
    const lex = resolveFrom(input.cwd || config.runDir, file);
    if (!isInside(lex, inbox) || lex === inbox || !isInside(realOf(lex, deps), realOf(inbox, deps))) return deny(`advisor는 리뷰어 전용 폴더(${inbox}/) 안에만 쓸 수 있다`);
    return allow();
  }
  if (tool === 'Bash') {
    const { tokens, unsafe } = tokenize(toolInput.command);
    if (unsafe) return deny('명령 연결·치환·확장·이스케이프·리다이렉트는 쓸 수 없다. 명령은 하나씩 실행하라');
    if (advisorReviewerCommandOk(tokens, config, input.cwd, deps)) return allow();
    return deny(`advisor가 실행할 수 있는 명령은 node ${normPath(config.harnessDir)}/operator/run-reviewer.mjs --advice <${inbox}/ 바로 아래 파일> --advice-id <id> 하나뿐이다`);
  }
  return deny(`advisor는 ${tool} 도구를 쓸 수 없다 (읽기 도구, 리뷰어 전용 폴더 안 Write·Edit, 조언 판정 명령, 결과 돌려주기만)`);
}

export function decide(input, config, deps) {
  const tool = input.tool_name;
  const toolInput = input.tool_input || {};
  const common = commonChecks(input, config, deps);
  if (common) return common;
  if (config.role) {
    // 조사 세션의 web-fetch 하위 에이전트는 웹 읽기 도구만 쓴다.
    if (config.role === 'operator-research' && input.agent_type === 'web-fetch') {
      return tool === 'WebFetch' || tool === 'WebSearch' ? allow() : deny(`조사 모드의 web-fetch 에이전트는 ${tool} 도구를 쓸 수 없다`);
    }
    if (input.agent_type && input.agent_type !== 'worker') return deny(`역할이 있는 세션은 알 수 없는 agent_type(${input.agent_type})을 허용하지 않는다`);
    if ((config.role === 'operator-research' || config.role === 'operator-reflect') && input.agent_type) {
      return deny(`${config.role} 역할은 하위 에이전트(${input.agent_type})를 허용하지 않는다`);
    }
    const role = roleOf(input, config);
    if (role === 'operator-work') return decideOperatorWork(input, config, deps, PROFILE_HELPERS);
    // 조사 모드는 웹을 읽으므로(웹 글이 지시처럼 보일 수 있다) 비밀값 파일도 읽지 못하게 훅으로 막는다(작업 모드·워커는 docs/operator.md 9.3대로 참조 가능).
    if (role === 'operator-research' && (tool === 'Read' || tool === 'Grep' || tool === 'Glob')) { const s = secretReadCheck(input, config, deps); if (s) return s; }
    if (role === 'operator-research') return decideOperatorResearch(input, config, deps, PROFILE_HELPERS);
    if (role === 'operator-reflect') return decideOperatorReflect(input, config, deps, PROFILE_HELPERS);
    if (role === 'worker') return decideWorker(input, config, deps, PROFILE_HELPERS);
    return deny(`${role} 역할의 훅 프로필이 아직 없어 모든 도구를 거부한다`);
  }
  if (input.agent_type) return decideSubagent(input, config, deps);

  if (!COORDINATOR_TOOLS.has(tool)) return deny(`코디네이터는 ${tool} 도구를 쓸 수 없다`);
  // 어드바이저 스킬도 실행 폴더의 같은 스킬 폴더에 설치된다(하위 에이전트에 미리 주입하려고). 다른 역할의 스킬은 코디네이터가 부르지 않는다.
  if (tool === 'Skill') {
    const name = String(toolInput?.skill ?? '').split(':').pop();
    if (/^(advisor|operator|worker|reviewer)-/.test(name)) return deny(`코디네이터는 다른 역할의 스킬(${name.slice(0, 60)})을 부르지 않는다. 코디네이터 스킬은 coordinator-로 시작한다`);
  }
  if (tool === 'Read' || tool === 'Grep') {
    const r = secretReadCheck(input, config, deps);
    if (r) return r;
  }
  if (tool === 'Write' || tool === 'Edit') {
    const real = realOf(toolInput.file_path, deps);
    if (isInside(toolInput.file_path, config.targetProject) || isInside(real, config.targetProject)) {
      return deny('코디네이터는 대상 프로젝트를 수정하지 않는다. 대상 프로젝트 수정은 오퍼레이터에게 맡겨라');
    }
    if (!isInside(toolInput.file_path, config.issuesClone) || !isInside(real, config.issuesClone)) {
      return deny(`코디네이터는 지정 저장소 클론 밖에는 쓰지 않는다 (쓸 수 있는 곳: ${config.issuesClone})`);
    }
    return allow();
  }
  if (tool === 'Bash') return coordinatorBash(toolInput.command, config, deps);
  return allow();
}

// 프로필 모듈(operator/profiles.mjs)에 넘기는 도우미. import 순환을 피하려고 인자로 전달한다.
const PROFILE_HELPERS = { normPath, isInside, resolveFrom, tokenize };
