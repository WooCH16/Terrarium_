// 합치기 어댑터: 허용 이슈 수집, 의존 처리, local-sequential(시험용)·github-queue(조직 저장소용) 어댑터, 반영 흐름.
// 보안: main은 land에서 허용된 40자리 해시의 커밋만, 사용자 결정 뒤 반영 모드로만 바뀐다. 이슈 본문·댓글·라벨은 신뢰하지 않는 데이터로 취급한다.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync, readFileSync, readdirSync, lstatSync, existsSync, renameSync, linkSync } from 'node:fs';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve as resolvePath, dirname } from 'node:path';
import { spawn as nodeSpawn, execFileSync } from 'node:child_process';
import { loadOperatorConfig, ConfigError } from './config.mjs';
import { handoffNames } from './handoff.mjs';
import { workerEnv, questionRecordFile } from './run-worker.mjs';
import { formatLine, exitCode, STATES } from './report.mjs';
import { assertPlain, isStopped, killTree as defaultKillTree, pruneReflectedHandoffs, readPruned } from './launch.mjs';
import { makeGhDeps } from './run-operator.mjs';
import { plainLines, parseDependsOn } from './issue-body.mjs';
import { REPORT_HEAD, VERDICT_ALLOW, VERDICT_REJECT, ALLOWED_COMMIT, ALLOWED_COMMIT_LINE, LABEL } from './protocol.mjs';

export { parseDependsOn };

const fwd = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
const ONE_LINE = (text) => String(text).replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
const FULL_SHA = /^[0-9a-f]{40}$/;
const HANDOFF = /^h[1-9]\d{0,8}$/;
const REVIEW_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/[1-9]\d{0,9}#issuecomment-\d{1,20}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const ZERO_SHA = '0'.repeat(40);
const DEFAULT_TEST_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_BUDGET_MS = 60 * 60 * 1000;
const DEFAULT_OUTPUT_CAP = 8 * 1024 * 1024;

// 어떤 오류가 사용자에게 그대로 보이는지 구분한다: 이 세 종류만 우리가 쓴 문구이고 나머지는 고정 문구로 바꾼다.
export class UsageError extends Error {}
// 무결성 실패: main은 그대로 두고 전체를 중단한다(종료 코드 2).
export class IntegrityError extends Error {}
export class StoppedError extends Error {}
export class HarnessError extends Error {}

// ---------- 신뢰하지 않는 텍스트 파싱 ----------


const labelNames = (labels) => (Array.isArray(labels) ? labels : []).map((l) => (typeof l === 'string' ? l : l?.name)).filter((n) => typeof n === 'string');
// 반영됨 라벨은 제외 기준도 반영 표시도 아니다(작업 모드의 오퍼레이터가 아무 상태 라벨이나 붙일 수 있다). 반영 여부는 main의 조상인지로만 판단한다.
const EXCLUDED_LABELS = new Set([LABEL.거부목록, LABEL.미완료, LABEL.막힘, LABEL.보류, LABEL.대기]);

// 제로폭·형식 문자(\p{Cf})를 지우고 NFKC로 정규화한 줄: 판정처럼 보이는 줄을 느슨하게 알아보는 데만 쓴다.
const loose = (line) => String(line).replace(/\p{Cf}/gu, '').normalize('NFKC');
const timeOf = (v) => (v === undefined || v === null ? null : Date.parse(v));

// createdAt이 모두 유효하면 시간순(같으면 목록 순서)으로, 아니면 목록 순서 그대로.
function inOrder(comments) {
  const times = comments.map((c) => Date.parse(c?.createdAt));
  if (!times.every(Number.isFinite)) return comments;
  return comments.map((c, i) => ({ c, i, t: times[i] })).sort((a, b) => a.t - b.t || (Number(a.c?.id) - Number(b.c?.id) || 0) || a.i - b.i).map((x) => x.c);
}

// 가장 최근 리뷰어 판정 댓글(첫 줄이 `## 리뷰어 판정`처럼 보이는 댓글)이 정확히 `## 리뷰어 판정: 허용`이어야 한다.
// 거부·모양이 다른·제로폭/전각으로 위장한 판정은 모두 판정으로 세어, 더 오래된 허용이 되살아나지 못하게 한다.
// reviewerLogin이 설정되면 그 계정이 쓴 댓글만 판정으로 본다(없으면 작성자를 구분하지 않는다: 리뷰어·오퍼레이터가 같은 gh 계정을 쓴다).
// // (시각은 normalizeRestComments가 만든 createdAt/updatedAt)
// 해시는 허용 판정보다 앞선 가장 최근 `## 결과 보고서` 댓글의 `커밋 해시: <40자리 소문자 16진수>` 한 줄에서 읽고,
// 허용 판정에도 같은 해시의 `허용된 커밋: <40자리>` 줄이 정확히 한 줄 있어야 한다(판정과 해시를 묶는다).
// 보고서나 판정이 수정되었거나 시각을 읽을 수 없으면 제외한다.
export function collectAllowed(issues, opts = {}) {
  if (!Array.isArray(issues)) throw new HarnessError('issues는 배열이어야 합니다');
  const reviewerLogin = typeof opts.reviewerLogin === 'string' && LOGIN.test(opts.reviewerLogin) ? opts.reviewerLogin.toLowerCase() : null;
  const out = [];
  for (const issue of issues) {
    if (issue === null || typeof issue !== 'object' || !Number.isSafeInteger(issue.number) || issue.number <= 0) continue;
    if (labelNames(issue.labels).some((n) => EXCLUDED_LABELS.has(n))) continue;
    const comments = inOrder(Array.isArray(issue.comments) ? issue.comments : []);
    const first = (c) => (typeof c?.body === 'string' ? c.body.split(/\r?\n/, 1)[0] : '');
    // 판정 후보 감지는 느슨하게(BOM·앞 빈 줄·들여쓰기·공백 없는 제목·제로폭·전각), 허용 판정은 원문 첫 줄 정확 일치만 인정한다.
    const lead = (c) => (typeof c?.body === 'string' ? (c.body.split(/\r?\n/).find((l) => loose(l).trim() !== '') ?? '') : '');
    let verdictAt = -1;
    comments.forEach((c, i) => {
      if (!/^\s*#{1,6}\s*리뷰어\s*판정/.test(loose(lead(c)))) return;
      if (reviewerLogin !== null && String(c?.author?.login ?? '').toLowerCase() !== reviewerLogin) return;
      verdictAt = i;
    });
    if (verdictAt < 0 || first(comments[verdictAt]).trimEnd() !== VERDICT_ALLOW) continue;
    // 판정 뒤에 새 결과 보고서가 있으면(새 하달의 재작업) 그 판정은 지난 결과의 것이다: 새 판정이 나올 때까지 제외한다.
    if (comments.slice(verdictAt + 1).some((c) => first(c).startsWith(REPORT_HEAD))) continue;
    const verdict = comments[verdictAt];
    const reviewUrl = verdict.url;
    if (typeof reviewUrl !== 'string' || !REVIEW_URL.test(reviewUrl)) continue;
    let reportAt = -1;
    for (let i = verdictAt - 1; i >= 0; i--) {
      if (first(comments[i]).startsWith(REPORT_HEAD)) { reportAt = i; break; }
    }
    if (reportAt < 0) continue;
    const hashLines = plainLines(comments[reportAt].body).filter((l) => l.startsWith('커밋 해시:'));
    if (hashLines.length !== 1) continue;
    const m = /^커밋 해시: ([0-9a-f]{40})[ \t]*$/.exec(hashLines[0]);
    if (!m) continue;
    const boundLines = plainLines(verdict.body).filter((l) => l.startsWith(ALLOWED_COMMIT));
    const bound = boundLines.length === 1 ? ALLOWED_COMMIT_LINE.exec(boundLines[0]) : null;
    if (!bound || bound[1] !== m[1]) continue;
    // 수정 여부: REST의 created_at/updated_at. 보고서·판정이 수정되었거나(updated_at > created_at) 시각을 읽을 수 없으면 제외한다.
    let edited = false;
    for (const c of [comments[reportAt], verdict]) {
      const created = timeOf(c.createdAt);
      const updated = timeOf(c.updatedAt);
      if (!Number.isFinite(created) || !Number.isFinite(updated) || updated > created) edited = true;
    }
    if (edited) continue;
    const dependsOn = parseDependsOn(issue.body);
    if (dependsOn === null) continue;
    out.push({ issue: issue.number, sha: m[1], reviewUrl, dependsOn });
  }
  return out;
}

// 결정 8-35: 허용되지 않은 이슈가 "반려됐다"는 표시(거부 판정, 미완료·거부목록·막힘 라벨)를 가졌는지. 표시가 없으면(아직 판정 전) null.
// 판정 전 이슈를 통합 브랜치에서 빼면 그 이슈가 돌아올 길이 없다: push-branch는 반려된 이슈만 빼고 다시 만든다.
const REJECT_LABELS = [LABEL.미완료, LABEL.거부목록, LABEL.막힘];
export function rejectionOf(issue, opts = {}) {
  const labels = labelNames(issue?.labels);
  const l = REJECT_LABELS.find((x) => labels.includes(x));
  if (l) return `상태가 ${l}`;
  const reviewerLogin = typeof opts.reviewerLogin === 'string' && LOGIN.test(opts.reviewerLogin) ? opts.reviewerLogin.toLowerCase() : null;
  const comments = inOrder(Array.isArray(issue?.comments) ? issue.comments : []);
  const lead = (c) => (typeof c?.body === 'string' ? (c.body.split(/\r?\n/).find((x) => loose(x).trim() !== '') ?? '') : '');
  let last = null;
  for (const c of comments) {
    if (!/^\s*#{1,6}\s*리뷰어\s*판정/.test(loose(lead(c)))) continue;
    if (reviewerLogin !== null && String(c?.author?.login ?? '').toLowerCase() !== reviewerLogin) continue;
    last = c;
  }
  return last && String(last.body).split(/\r?\n/, 1)[0].trimEnd() === VERDICT_REJECT ? '리뷰어 거부' : null;
}

// 막힌 이슈에 (연쇄로) 의존하는 이슈를 뺀다. 순환이 있어도 끝난다.
export function excludeDependents(allowed, blockedNumbers) {
  const dead = new Set(blockedNumbers);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of allowed) {
      if (!dead.has(item.issue) && item.dependsOn.some((d) => dead.has(d))) { dead.add(item.issue); changed = true; }
    }
  }
  return allowed.filter((item) => !dead.has(item.issue));
}

// 의존 순서(위상 정렬, 번호순 안정). allowed 밖의 의존은 무시한다. 순환에 든 이슈와 그에 의존하는 이슈는 cyclic으로 돌려준다.
export function orderAllowed(allowed) {
  const byNumber = new Map(allowed.map((a) => [a.issue, a]));
  const done = new Set();
  const ordered = [];
  const rest = [...allowed].sort((a, b) => a.issue - b.issue);
  let progress = true;
  while (progress) {
    progress = false;
    for (const item of rest) {
      if (done.has(item.issue)) continue;
      if (item.dependsOn.every((d) => !byNumber.has(d) || done.has(d))) { done.add(item.issue); ordered.push(item); progress = true; }
    }
  }
  return { ordered, cyclic: rest.filter((i) => !done.has(i.issue)) };
}

// ---------- git 도구 ----------
// 설계: 믿는 git은 시험 코드가 쓸 수 있는 어떤 것도 읽지 않는다.
// - 병합 커밋은 배관(merge-tree --write-tree + commit-tree)으로만 만든다: 작업 트리·체크아웃·훅이 없고, 결과 해시·트리·부모는 출력에서 바로 기록한다.
// - 전역·시스템 설정, grafts, 훅 폴더, attributes 파일은 쓸 수 없는 sink(NUL 장치)로 돌린다. 저장소 자신의 .git/config는 위험한 키가 없는지 확인하고(없어야 시작한다), 시험이 끝날 때마다 저장소 상태를 다시 확인한다.
// - 검토 전 코드(워커의 테스트)는 일회용 클론에서만 돌고, 거기서는 종료 코드와 제한된 출력만 읽는다. 끝나면 남은 자손 프로세스를 정리한다.
// 이것은 샌드박스가 아니다: 시험 코드는 사용자 권한으로 돈다. os.userInfo().homedir나 절대 경로로 실제 홈·저장소에 닿을 수 있다.

const DEFAULT_GIT_TIMEOUT_MS = 120 * 1000;
const DEFAULT_CLONE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_GH_TIMEOUT_MS = 60 * 1000;
// 시험 코드가 쓸 수 없는 빈 sink: 설정·grafts·attributes·훅 폴더가 이 장치를 가리키면 아무것도 읽히지 않는다.
const SINK = process.platform === 'win32' ? 'NUL' : '/dev/null';
// hooksPath는 작업 폴더 기준 상대 경로로도 읽힐 수 있어 윈도우에서는 장치 경로(\\.\NUL)를 쓴다.
const HOOKS_SINK = process.platform === 'win32' ? '\\\\.\\NUL' : '/dev/null';
// 빈 트리: --attr-source로 주면 작업 트리·index의 .gitattributes를 읽지 않는다. 병합·비교(merge-tree, diff-tree)와 속성을 읽지 않는 호출은 이것을 쓰고,
// 체크아웃된 파일을 다루는 호출(status, read-tree, 시험용 클론 checkout)은 해당 커밋의 커밋된 속성을 쓴다(필터·드라이버는 설정이 있어야 돌고 그 설정은 거부·감시한다).
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function gitEnv(base = process.env) {
  const env = { ...base };
  for (const k of Object.keys(env)) if (/^(GIT_|NODE_TEST_CONTEXT$)/i.test(k)) delete env[k];
  Object.assign(env, {
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: 'true',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: SINK,
    GIT_GRAFT_FILE: SINK,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'terrarium-operator', GIT_AUTHOR_EMAIL: 'operator@localhost',
    GIT_COMMITTER_NAME: 'terrarium-operator', GIT_COMMITTER_EMAIL: 'operator@localhost',
  });
  return env;
}

// 검토 전 워커 코드가 도는 시험 자식 프로세스의 환경: 하네스·GitHub·git 관련 변수(토큰, 실행 폴더 등)를 넘기지 않는다.
// fable 조언 2: 금지 목록이 아니라 워커와 같은 허용 목록을 쓴다(TYPESAFE_API_KEY 등 키가 시험 코드에 보이지 않게).
function testEnv(base = process.env) {
  const env = workerEnv(base);
  for (const k of Object.keys(env)) if (/^(HARNESS_|GH_|GITHUB_|GIT_|NODE_TEST_CONTEXT$)/i.test(k)) delete env[k];
  return env;
}

const isScript = (bin) => /\.(mjs|js)$/i.test(String(bin));
// 시간 초과(execFileSync가 죽인 경우)를 알아보는 검사. 시간 초과는 어떤 경우에도 "아니오"로 읽지 않고 그대로 던진다.
const timedOut = (e) => e?.code === 'ETIMEDOUT' || e?.killed === true;

// 모든 믿는 git 호출: sink 설정, 빈 hooksPath·attributesFile, fsmonitor 끔, GIT_NO_REPLACE_OBJECTS, 시간 제한, 출력 상한.
export function openGit(ctx) {
  const env = gitEnv(ctx.env ?? process.env);
  const bin = ctx.gitBin ?? 'git';
  const defaultTimeout = ctx.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const git = (cwd, args, opts = {}) => {
    const full = ['-C', cwd, `--attr-source=${opts.attrSource ?? EMPTY_TREE}`, '-c', `core.hooksPath=${HOOKS_SINK}`, '-c', `core.attributesFile=${SINK}`, '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false',
      '-c', 'core.autocrlf=false', '-c', 'advice.graftFileDeprecated=false', ...args];
    return execFileSync(isScript(bin) ? process.execPath : bin, isScript(bin) ? [bin, ...full] : full, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env, maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: opts.timeout ?? defaultTimeout, killSignal: 'SIGKILL',
    }).trim();
  };
  return { git, close: () => {} };
}

const tryGit = (git, cwd, args) => {
  try { return git(cwd, args); } catch (e) { if (timedOut(e)) throw e; return null; }
};
// a가 b의 조상인가. 종료 코드 1만 "아니오"이고 시간 초과나 그 밖의 실패는 던진다(닫힌 쪽 실패).
export function isAnc(git, cwd, a, b) {
  try { git(cwd, ['merge-base', '--is-ancestor', a, b]); return true; } catch (e) {
    if (!timedOut(e) && e?.status === 1) return false;
    throw e;
  }
}

// 믿는 실행에서 쓸 수 없는 저장소 설정 키(병합 드라이버, 필터, textconv, pager, 외부 명령, include 등)가 있으면 시작하지 않는다.
const DANGEROUS_KEY = /^(merge\..+\.(driver|recursive)|filter\..+\.|diff\..+\.(textconv|command)|core\.(pager|sshcommand|hookspath|fsmonitor|attributesfile|editor|askpass|gitproxy)|include\.|includeif\.|url\..+\.(insteadof|pushinsteadof)|credential\.)/i;
function verifyRepoConfig(git, ctx) {
  // 모든 범위(local·worktree)를 읽는다. 전역·시스템은 sink라 비어 있다. -c로 우리가 준 값('command line')은 건너뛰고 파일에서 온 항목만 본다.
  const out = git(ctx.memo, ['config', '--list', '--show-origin', '--show-scope', '-z']);
  const tokens = out.split('\0');
  for (let i = 0; i + 2 < tokens.length; i += 3) {
    if (!tokens[i + 1].startsWith('file:')) continue;
    const nl = tokens[i + 2].indexOf('\n');
    const key = nl < 0 ? tokens[i + 2] : tokens[i + 2].slice(0, nl);
    const value = nl < 0 ? null : tokens[i + 2].slice(nl + 1);
    if (DANGEROUS_KEY.test(key)) throw new IntegrityError('저장소 설정에 믿는 실행에서 쓸 수 없는 설정(병합 드라이버·필터·pager·훅 경로·include 등)이 있어 시작하지 않았습니다.');
    if (/^extensions\.worktreeconfig$/i.test(key) && !(value !== null && /^(false|no|off|0|)$/i.test(value.trim()))) {
      throw new IntegrityError('extensions.worktreeConfig가 켜진 저장소는 worktree 설정(config.worktree)을 믿을 수 없어 시작하지 않았습니다.');
    }
  }
}

// 브랜치를 old에서 next로 앞으로만 옮긴다(update-ref compare-and-set).
// 작업 트리는 하네스가 받은 경로(ctx.memo)의 체크아웃에서 그 브랜치가 열려 있을 때만 read-tree -m -u로 맞춘다. worktree 메타데이터(.git/worktrees/*)에서 읽은 경로로는 git을 절대 돌리지 않는다:
// 다른 연결된 작업 폴더에 그 브랜치가 열려 있으면 ref를 옮기기 전에 거부한다.
export function advanceBranch(git, memo, branch, next, old, { allowPrimary }) {
  if (!FULL_SHA.test(next)) throw new IntegrityError('옮길 커밋 해시가 40자리가 아닙니다.');
  const ref = `refs/heads/${branch}`;
  const current = tryGit(git, memo, ['rev-parse', '--verify', '--quiet', ref]) || null;
  if (current !== old) throw new IntegrityError(`${branch} 브랜치가 작업 도중 움직였습니다. 아무것도 바꾸지 않았습니다.`);
  if (old !== null && !isAnc(git, memo, old, next)) throw new IntegrityError(`${branch} 브랜치를 앞으로만 옮길 수 있습니다.`);
  // 그 브랜치가 하네스가 받은 경로(memo) 말고 다른 작업 폴더에 열려 있으면 ref를 옮기기 전에 거부한다(그 폴더의 index가 병합을 되돌리는 것처럼 보이게 된다).
  // 판단은 worktree list --porcelain의 경로·브랜치 줄만 읽어서 한다(그 경로에서 git을 돌리지 않는다). 심어 둔 가짜 항목은 거부만 일으킨다.
  const normPath = (p) => { let x = String(p); try { x = realpathSync.native(x); } catch { /* 없는 경로는 그대로 */ } return fwd(x).toLowerCase(); };
  const mine = normPath(memo);
  for (const block of git(memo, ['worktree', 'list', '--porcelain']).split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const path = lines.find((l) => l.startsWith('worktree '))?.slice(9);
    if (path !== undefined && lines.includes(`branch ${ref}`) && normPath(path) !== mine) throw new HarnessError(`${branch} 브랜치가 다른 작업 폴더에 체크아웃되어 있어 옮기지 않았습니다.`);
  }
  const here = tryGit(git, memo, ['symbolic-ref', '-q', 'HEAD']) === ref;
  if (here) {
    if (!allowPrimary) throw new HarnessError(`${branch} 브랜치가 대상 프로젝트의 체크아웃에 열려 있어 옮기지 않았습니다.`);
    if (git(memo, ['status', '--porcelain', '--untracked-files=no'], { attrSource: old ?? EMPTY_TREE }) !== '') throw new HarnessError(`${branch}가 체크아웃된 폴더에 커밋하지 않은 변경이 있어 옮기지 않았습니다.`);
    if (git(memo, ['status', '--porcelain', '--untracked-files=all', '--', '.gitattributes', ':(glob)**/.gitattributes'], { attrSource: old ?? EMPTY_TREE }) !== '') {
      throw new HarnessError(`${branch}가 체크아웃된 폴더에 추적되지 않았거나 바뀐 .gitattributes가 있어 옮기지 않았습니다.`);
    }
    if (git(memo, ['rev-parse', 'HEAD']) !== old) throw new IntegrityError(`${branch} 브랜치가 작업 도중 움직였습니다. 아무것도 바꾸지 않았습니다.`);
  }
  git(memo, ['update-ref', '-m', 'terrarium merge adapter', ref, next, old ?? ZERO_SHA]);
  if (here) {
    try {
      git(memo, ['read-tree', '-m', '-u', old, next], { attrSource: next });
    } catch (e) {
      try { git(memo, ['update-ref', ref, old, next]); } catch { /* 되돌리지 못하면 아래 오류로 알린다 */ }
      if (timedOut(e)) throw e;
      throw new HarnessError(`${branch} 작업 트리를 새 커밋에 맞추지 못해 되돌렸습니다.`);
    }
  }
}

// 결정 8-35: 다시 만든 통합 브랜치(integration/h<N>)만 앞으로가 아닌 곳으로 옮긴다(update-ref compare-and-set). 다른 모양은 거부한다.
// 어느 작업 폴더(대상 프로젝트 체크아웃 포함)에든 그 브랜치가 열려 있으면 옮기지 않는다(그 폴더의 index가 엉킨다).
export function replaceIntegration(git, memo, branch, next, old) {
  if (!/^integration\/h[1-9]\d{0,8}$/.test(branch)) throw new IntegrityError('다시 만들어 옮기는 브랜치는 integration/h<N> 모양뿐입니다.');
  if (!FULL_SHA.test(next) || !FULL_SHA.test(old)) throw new IntegrityError('옮길 커밋 해시가 40자리가 아닙니다.');
  const ref = `refs/heads/${branch}`;
  for (const block of git(memo, ['worktree', 'list', '--porcelain']).split(/\r?\n\r?\n/)) {
    if (block.split(/\r?\n/).includes(`branch ${ref}`)) throw new HarnessError(`${branch} 브랜치가 작업 폴더에 체크아웃되어 있어 다시 만들지 않았습니다.`);
  }
  git(memo, ['update-ref', '-m', 'terrarium push-branch rebuild (8-35)', ref, next, old]);
}

function ensureNamespace(run, handoff) {
  const runReal = realpathSync.native(run);
  const wt = `${run}/worktrees`;
  const root = `${wt}/${handoff}`;
  const check = () => {
    assertPlain(wt, `${runReal}/worktrees`, 'worktrees');
    assertPlain(root, `${runReal}/worktrees/${handoff}`, `worktrees/${handoff}`);
  };
  check();
  mkdirSync(root, { recursive: true });
  check();
  return { runReal, root };
}

const removeDir = (folder) => rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

class CheckoutFailed extends Error {}

// 검토 전 코드를 돌릴 일회용 클론: 하달 이름 공간 안(링크 없음 확인), 기록한 커밋을 detached로 체크아웃, 끝나면 지운다. origin은 지워 사용자 저장소 주소를 남기지 않는다.
async function withTestClone({ git, ctx, commit }, fn) {
  const { runReal, root } = ensureNamespace(ctx.run, ctx.handoff);
  const folder = `${root}/testclone`;
  const expected = `${runReal}/worktrees/${ctx.handoff}/testclone`;
  const remove = () => { if (assertPlain(folder, expected, `worktrees/${ctx.handoff}/testclone`)) removeDir(folder); };
  remove();
  let failure = null;
  try {
    git(ctx.memo, ['clone', '--local', '--no-hardlinks', '--no-checkout', '-q', '--', ctx.memo, folder], { timeout: ctx.cloneTimeoutMs ?? DEFAULT_CLONE_TIMEOUT_MS });
    assertPlain(folder, expected, `worktrees/${ctx.handoff}/testclone`);
    try { git(folder, ['checkout', '-q', '--detach', commit], { attrSource: commit }); } catch (e) { if (timedOut(e)) throw e; throw new CheckoutFailed(); }
    git(folder, ['remote', 'remove', 'origin']);
    return await fn(folder);
  } catch (e) {
    failure = e;
    throw e;
  } finally {
    try { remove(); } catch { if (failure === null) throw new HarnessError('시험용 클론 폴더를 지우지 못했습니다.'); }
    if (failure === null && existsSync(folder)) throw new HarnessError('시험용 클론 폴더가 남아 있습니다.');
  }
}

// 시험이 끝난 뒤 남은 자손 프로세스를 정리한다. win32: 시험 시작 뒤에 만들어졌고 부모가 root인(이제 죽은 root의 pid를 부모로 가진) 프로세스와 그 자손.
// 부모가 먼저 죽는 이중 분리(A가 B를 띄우고 죽는 식)는 따라가지 못한다(알려진 한계). 그 밖: 같은 프로세스 그룹을 종료하고,
// /proc이 있으면(Linux) 환경 변수에 이 실행의 표지(TERRARIUM_TEST_SWEEP=<marker>)를 가진 프로세스도 종료한다.
// detached 자손은 새 프로세스 그룹으로 빠져나가고 root가 죽으면 부모가 바뀌어 그룹·부모로는 찾지 못하기 때문이다.
// 표지를 지운 프로세스는 따라가지 못한다(알려진 한계).
export function markedPids(marker, { procDir = '/proc', self = process.pid } = {}) {
  if (!marker || !existsSync(procDir)) return [];
  const needle = `TERRARIUM_TEST_SWEEP=${marker}`;
  const out = [];
  let names = [];
  try { names = readdirSync(procDir); } catch { return []; }
  for (const n of names) {
    if (!/^[1-9][0-9]*$/.test(n) || Number(n) === self) continue;
    try { if (readFileSync(`${procDir}/${n}/environ`, 'latin1').split('\0').includes(needle)) out.push(Number(n)); } catch { /* 없어졌거나 읽을 수 없음 */ }
  }
  return out;
}
function defaultSweep(rootPid, startedAt, marker) {
  if (!rootPid) return;
  if (process.platform === 'win32') {
    const script = `$r=${Number(rootPid)};$s=[DateTimeOffset]::FromUnixTimeMilliseconds(${Number(startedAt) - 2000}).UtcDateTime;`
      + '$all=@(Get-CimInstance Win32_Process | Where-Object { $_.CreationDate -ge $s.ToLocalTime() });'
      + '$kill=New-Object System.Collections.ArrayList;$q=New-Object System.Collections.Queue;$q.Enqueue($r);'
      + 'while($q.Count -gt 0){$p=$q.Dequeue();foreach($c in $all){if($c.ParentProcessId -eq $p -and -not $kill.Contains([int]$c.ProcessId)){[void]$kill.Add([int]$c.ProcessId);$q.Enqueue([int]$c.ProcessId)}}}'
      + 'foreach($k in $kill){Stop-Process -Id $k -Force -ErrorAction SilentlyContinue}';
    try { execFileSync(`${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', timeout: 20000, windowsHide: true }); } catch { /* 정리 실패는 결과를 바꾸지 않는다 */ }
  } else {
    try { process.kill(-rootPid, 'SIGKILL'); } catch { /* 이미 없음 */ }
    for (const pid of markedPids(marker)) { try { process.kill(pid, 'SIGKILL'); } catch { /* 이미 없음 */ } }
  }
}

// node --test를 시간 제한과 출력 상한을 두고 돌린다. 시간 초과·상한 초과는 실패다.
// 시험 프로세스의 HOME·TEMP 등은 이 폴더 옆의 빈 시험 전용 폴더, 전역 git 설정은 빈 파일이고, 토큰류 환경 변수는 넘기지 않는다(샌드박스는 아니다).
// --test-isolation=none: 시험 파일이 러너와 같은 프로세스에서 돌아 자손의 부모가 러너가 되므로 끝난 뒤 정리하기 쉽다.
export function runNodeTests(cwd, { timeoutMs, maxBytes = DEFAULT_OUTPUT_CAP, spawn = nodeSpawn, killTree = defaultKillTree, env = process.env, sweep = defaultSweep } = {}) {
  return new Promise((resolve) => {
    let done = false;
    let timedOutRun = false;
    let overCap = false;
    let bytes = 0;
    let timer;
    let child;
    let home = null;
    const startedAt = Date.now();
    const marker = randomBytes(8).toString('hex');
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { if (child?.pid) sweep(child.pid, startedAt, marker); } catch { /* 정리 실패는 결과를 바꾸지 않는다 */ }
      if (home) { try { removeDir(home); } catch { /* 임시 폴더 */ } }
      resolve({ timedOut: timedOutRun, overCap, ...r });
    };
    const kill = () => {
      if (process.platform === 'win32') { if (child.pid) { try { killTree(child.pid); } catch { /* 이미 끝남 */ } } try { child.kill(); } catch { /* 이미 끝남 */ } }
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* 이미 끝남 */ } } }
    };
    try {
      home = mkdtempSync(`${fwd(dirname(cwd))}/testhome-`);
      mkdirSync(`${home}/tmp`);
      writeFileSync(`${home}/gitconfig`, '');
      const childEnv = { ...testEnv(env), HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, APPDATA: home, LOCALAPPDATA: home, TEMP: `${home}/tmp`, TMP: `${home}/tmp`, TMPDIR: `${home}/tmp`, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: `${home}/gitconfig`, TERRARIUM_TEST_SWEEP: marker };
      child = spawn(process.execPath, ['--test', ...(process.allowedNodeEnvironmentFlags.has('--test-isolation') ? ['--test-isolation=none'] : [])], { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    } catch { finish({ ok: false, code: -1 }); return; }
    const onData = (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes && !overCap) { overCap = true; kill(); setTimeout(() => finish({ ok: false, code: 1 }), 2000).unref(); }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', () => finish({ ok: false, code: -1 }));
    child.on('close', (code, signal) => finish({ ok: code === 0 && !timedOutRun && !overCap, code: code ?? (signal ? 1 : -1) }));
    if (timeoutMs > 0) {
      timer = setTimeout(() => { timedOutRun = true; kill(); setTimeout(() => finish({ ok: false, code: 1 }), 2000).unref(); }, timeoutMs);
    }
  });
}

function budget(ctx) {
  const now = ctx.now ?? (() => Date.now());
  const deadline = now() + (ctx.budgetMs ?? DEFAULT_BUDGET_MS);
  return {
    expired: () => now() >= deadline,
    testMs: () => Math.max(1, Math.min(ctx.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS, deadline - now())),
  };
}

function checkStop(ctx) {
  if (ctx.isStopped?.()) throw new StoppedError('stopped');
}

// 사용자 저장소의 중요한 상태를 요약한다: 모든 ref(다른 하달의 이슈·통합 브랜치는 동시에 움직일 수 있어 뺀다), HEAD, 공용 config·hooks·info·shallow·objects/info.
// 시험이 끝날 때마다, 그리고 마지막 CAS 직전에 비교해 다르면 IntegrityError(실패는 닫힌 쪽).
// .git/worktrees/*는 항목 이름과 gitdir·commondir·config.worktree·locked 내용만 본다(HEAD·index·logs는 동시에 일하는 워커가 바꾼다). 다른 하달의 워커가 새 worktree를 만들면 이 실행이 닫힌 쪽으로 중단될 수 있다(받아들인 오탐).
// 알려진 한계: 다른 하달의 ref, 객체 DB의 새 객체, 작업 트리 파일은 보지 않는다.
function makeGuard(git, ctx) {
  const common = fwd(git(ctx.memo, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const mine = (ref) => {
    const m = /^refs\/heads\/(?:h(\d+)\/|integration\/h(\d+)$)/.exec(ref);
    return m === null || `h${m[1] ?? m[2]}` === ctx.handoff;
  };
  const sig = (p) => {
    try {
      const st = lstatSync(p);
      if (st.isDirectory()) return readdirSync(p).sort().map((n) => `${n}:${sig(`${p}/${n}`)}`).join(',');
      return createHash('sha1').update(readFileSync(p)).digest('hex');
    } catch { return null; }
  };
  // .git/worktrees/*: 항목 이름과 구조를 정하는 파일(gitdir, commondir, config.worktree, locked)만 본다. HEAD·index·logs는 동시에 일하는 워커가 계속 바꾼다.
  const worktreesSig = () => {
    try {
      return readdirSync(`${common}/worktrees`).sort().map((n) => ['gitdir', 'commondir', 'config.worktree', 'locked'].map((x) => `${n}/${x}:${sig(`${common}/worktrees/${n}/${x}`)}`).join(';')).join(',');
    } catch { return null; }
  };
  const snap = () => JSON.stringify({
    refs: git(ctx.memo, ['for-each-ref', '--format=%(refname) %(objectname)']).split('\n').filter((l) => mine(l.split(' ')[0])),
    head: tryGit(git, ctx.memo, ['symbolic-ref', '-q', 'HEAD']),
    config: sig(`${common}/config`), configWorktree: sig(`${common}/config.worktree`), worktrees: worktreesSig(), hooks: sig(`${common}/hooks`), info: sig(`${common}/info`), shallow: sig(`${common}/shallow`), objectsInfo: sig(`${common}/objects/info`),
  });
  const before = snap();
  return {
    check() {
      if (snap() !== before) throw new IntegrityError('실행 중 사용자 저장소의 ref·설정·훅·info·grafts가 바뀌어 중단했습니다.');
    },
  };
}

// 서로를 품은 이슈를 앞서 합치도록 정렬한다(sha가 다른 항목의 조상이면 먼저). 그 밖의 순서는 유지한다.
export function orderByAncestry(git, memo, items) {
  const cache = new Map();
  const contains = (a, b) => {
    if (!a.sha || !b.sha || a.sha === b.sha) return false;
    const key = `${a.sha}>${b.sha}`;
    if (!cache.has(key)) cache.set(key, isAnc(git, memo, a.sha, b.sha));
    return cache.get(key);
  };
  const left = [...items];
  const out = [];
  while (left.length) {
    const k = left.findIndex((x) => left.every((y) => y === x || !contains(y, x)));
    out.push(left.splice(k < 0 ? 0 : k, 1)[0]);
  }
  return out;
}

// 윈도우에서 체크아웃할 수 없는 경로 이름(예약 장치 이름, 끝의 점·공백, 금지 문자).
const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$)$/i;
function isReservedPath(p) {
  return String(p).split('/').some((seg) => RESERVED_NAME.test(seg.split('.')[0]) || /[. ]$/.test(seg) || /[<>:"|?*\u0000-\u001f]/.test(seg));
}

// prev에 sha를 합친 병합 커밋을 배관으로 만든다. 충돌이면 { conflict: true }. 결과 해시·트리·부모는 출력에서 바로 기록한다(작업 트리·HEAD를 읽지 않는다).
export function buildMerge(git, memo, prev, sha, message) {
  let out;
  try {
    out = git(memo, ['merge-tree', '--write-tree', '--no-messages', prev, sha]);
  } catch (e) {
    if (timedOut(e)) throw e;
    if (e?.status === 1) return { conflict: true };
    throw e;
  }
  const tree = out.split('\n')[0].trim();
  if (!FULL_SHA.test(tree)) throw new IntegrityError('병합 결과 트리를 읽지 못했습니다.');
  const commit = git(memo, ['commit-tree', tree, '-p', prev, '-p', sha, '-m', message]);
  if (!FULL_SHA.test(commit)) throw new IntegrityError('병합 커밋 해시를 읽지 못했습니다.');
  return { commit, tree, parents: [prev, sha] };
}

// 이슈 하나를 prev 위에 배관으로 합치고, 기록한 병합 커밋을 일회용 클론에서 테스트한다. 테스트 뒤에는 클론에서 아무것도 읽지 않고(종료 코드와 출력 상한뿐),
// 자손 정리 뒤 사용자 저장소를 다시 확인한다. 합쳐서 통과하면 'merged', 아니면 { status:'rejected', reason }(prev는 그대로).
async function mergeAndTest({ git, ctx, prev, sha, message, test, clock, guard }) {
  if (isAnc(git, ctx.memo, sha, prev)) return { status: 'merged', already: true, commit: prev };
  const built = buildMerge(git, ctx.memo, prev, sha, message);
  if (built.conflict) return { status: 'rejected', reason: '충돌로 합치지 못했습니다' };
  if (process.platform === 'win32') {
    const paths = git(ctx.memo, ['diff-tree', '-r', '-z', '--name-only', '--no-renames', prev, built.commit]).split('\0').filter(Boolean);
    if (paths.some(isReservedPath)) return { status: 'rejected', reason: '윈도우에서 만들 수 없는 경로 이름이 있습니다' };
    // 이 이슈가 더한 경로가 기존 다른 경로와 대소문자만 다르면(윈도우 클론은 하나만 체크아웃한다) 시험한 트리와 합쳐지는 트리가 달라지므로 거부한다.
    const added = git(ctx.memo, ['diff-tree', '-r', '-z', '--name-only', '--no-renames', '--diff-filter=A', prev, built.commit]).split('\0').filter(Boolean);
    if (added.length > 0) {
      const fold = (p) => p.normalize('NFC').toLowerCase();
      const all = git(ctx.memo, ['ls-tree', '-r', '-z', '--name-only', built.commit]).split('\0').filter(Boolean);
      const seenFold = new Map();
      for (const p of all) { const k = fold(p); if (!seenFold.has(k)) seenFold.set(k, new Set()); seenFold.get(k).add(p); }
      if (added.some((p) => seenFold.get(fold(p)).size > 1)) return { status: 'rejected', reason: '기존 경로와 대소문자만 다른 경로를 더합니다(윈도우에서 같은 파일이 됩니다)' };
    }
  }
  let r;
  try {
    r = await withTestClone({ git, ctx, commit: built.commit }, (clone) => test(clone, { timeoutMs: clock.testMs(), maxBytes: ctx.outputCap ?? DEFAULT_OUTPUT_CAP, spawn: ctx.spawn, killTree: ctx.killTree, env: ctx.env, sweep: ctx.sweep }));
  } catch (e) {
    // 이 컴퓨터에서 체크아웃할 수 없는 파일 이름(GIT~1, 역슬래시, 너무 긴 경로 등)이 든 이슈만 거부한다. 클론 폴더는 withTestClone이 이미 지웠다.
    if (e instanceof CheckoutFailed) {
      // 이 이슈 탓인지 확인한다: 이 이슈를 뺀 끝(prev)의 체크아웃이 성공할 때만 이 이슈를 거부한다. prev도 실패하거나 프로브가 실패하면 전체를 중단한다(이슈와 무관한 실패일 수 있다).
      try {
        await withTestClone({ git, ctx, commit: prev }, async () => null);
      } catch (probe) {
        if (timedOut(probe)) throw probe;
        throw new HarnessError('시험용 클론 체크아웃이 이 이슈와 무관하게 실패해 전체를 중단했습니다(기준 커밋의 파일 이름이나 디스크·권한 문제일 수 있습니다).');
      }
      return { status: 'rejected', reason: '이 컴퓨터에서 체크아웃할 수 없는 파일 이름이 있습니다' };
    }
    throw e;
  }
  ctx.afterTest?.();
  guard.check();
  if (!r.ok) return { status: 'rejected', reason: r.timedOut ? '테스트 시간 초과' : r.overCap ? '테스트 출력이 상한을 넘음' : '테스트 실패' };
  return { status: 'merged', ...built };
}

// 기록해 둔 병합 커밋 사슬(기준 → 병합 커밋들)을 저장소에서 다시 읽어 확인한다: 각 병합 커밋의 부모는 정확히 [앞 커밋, 허용된 해시]이고 트리는 기록과 같아야 한다.
export function verifyChain(git, cwd, baseSha, built) {
  let expectParent = baseSha;
  for (const b of built) {
    const line = git(cwd, ['rev-list', '--parents', '-n', '1', b.commit]).split(' ');
    if (line[0] !== b.commit || line.length !== 3 || line[1] !== expectParent || line[2] !== b.sha || line[1] !== b.parents[0] || line[2] !== b.parents[1]) {
      throw new IntegrityError('병합 커밋 사슬이 기록과 달라 중단했습니다.');
    }
    if (git(cwd, ['rev-parse', `${b.commit}^{tree}`]) !== b.tree) throw new IntegrityError('병합 커밋의 트리가 기록과 달라 중단했습니다.');
    expectParent = b.commit;
  }
  return expectParent;
}

// ---------- local-sequential ----------

export function createLocalSequential() {
  return {
    kind: 'local-sequential',
    // items: [{ issue }]. 통합 브랜치(없으면 main)에서 시작한 후보 위에 이슈 브랜치를 차례로 배관 병합하고 테스트한다. 통과분만 통합 브랜치에 앞으로 옮긴다.
    async enqueue(items, ctx) {
      const session = openGit(ctx);
      try {
        const { git } = session;
        verifyRepoConfig(git, ctx);
        const names = handoffNames(ctx.handoff, null, ctx.run);
        const integration = names.integrationBranch;
        const mainSha = git(ctx.memo, ['rev-parse', '--verify', 'refs/heads/main']);
        const oldIntegration = tryGit(git, ctx.memo, ['rev-parse', '--verify', '--quiet', `refs/heads/${integration}`]) || null;
        const baseSha = oldIntegration ?? mainSha;
        const clock = budget(ctx);
        const test = ctx.runTests ?? runNodeTests;
        const guard = makeGuard(git, ctx);
        const results = [];
        const built = [];
        const rejectedShas = [];
        const resolved = items.map((item) => {
          const branch = handoffNames(ctx.handoff, item.issue, ctx.run).issueBranch;
          const sha = tryGit(git, ctx.memo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
          return { issue: item.issue, sha: sha && FULL_SHA.test(sha) ? sha : null };
        });
        let tip = baseSha;
        for (const item of orderByAncestry(git, ctx.memo, resolved)) {
          checkStop(ctx);
          if (clock.expired()) { results.push({ issue: item.issue, status: 'skipped', reason: '전체 제한 시간 초과' }); continue; }
          const { sha } = item;
          if (!sha) { results.push({ issue: item.issue, status: 'rejected', reason: '이슈 브랜치가 없습니다' }); continue; }
          if (isAnc(git, ctx.memo, sha, mainSha)) { results.push({ issue: item.issue, status: 'rejected', reason: '이슈 브랜치에 새 커밋이 없습니다' }); rejectedShas.push(sha); continue; }
          let embedsRejected = false;
          for (const r of rejectedShas) if (isAnc(git, ctx.memo, r, sha)) { embedsRejected = true; break; }
          if (embedsRejected) { results.push({ issue: item.issue, status: 'rejected', reason: '앞서 반려된 이슈의 커밋을 품고 있습니다' }); rejectedShas.push(sha); continue; }
          const r = await mergeAndTest({ git, ctx, prev: tip, sha, message: `통합: 이슈 #${item.issue}`, test, clock, guard });
          if (r.status === 'rejected') rejectedShas.push(sha);
          else if (!r.already) { built.push({ commit: r.commit, tree: r.tree, parents: r.parents, sha }); tip = r.commit; }
          results.push({ issue: item.issue, ...r });
        }
        ctx.beforeFinal?.();
        verifyChain(git, ctx.memo, baseSha, built);
        checkStop(ctx);
        guard.check();
        if (tip !== baseSha) advanceBranch(git, ctx.memo, integration, tip, oldIntegration, { allowPrimary: false });
        return results.map(({ issue, status, reason }) => ({ issue, status, ...(reason ? { reason } : {}) }));
      } finally {
        session.close();
      }
    },

    // allowed: 의존 순서로 정렬된 [{ issue, sha, reviewUrl, dependsOn }]. 허용된 40자리 해시와 정확히 같은 브랜치 끝만 합친다.
    async land(allowed, ctx) {
      const session = openGit(ctx);
      try {
        const { git } = session;
        verifyRepoConfig(git, ctx);
        if (!Array.isArray(allowed)) throw new IntegrityError('허용 목록 모양이 올바르지 않습니다.');
        const mainBefore = git(ctx.memo, ['rev-parse', '--verify', 'refs/heads/main']);
        const seen = new Set();
        let checked = [];
        for (const a of allowed) {
          if (a === null || typeof a !== 'object' || !Number.isSafeInteger(a.issue) || a.issue <= 0 || typeof a.sha !== 'string' || !FULL_SHA.test(a.sha)
            || typeof a.reviewUrl !== 'string' || !REVIEW_URL.test(a.reviewUrl) || !Array.isArray(a.dependsOn)) {
            throw new IntegrityError('허용 항목의 이슈 번호·해시(40자리)·리뷰어 댓글 URL 모양이 올바르지 않습니다.');
          }
          if (seen.has(a.issue)) throw new IntegrityError('허용 목록에 같은 이슈가 두 번 있습니다.');
          seen.add(a.issue);
          const branch = handoffNames(ctx.handoff, a.issue, ctx.run).issueBranch;
          const tip = tryGit(git, ctx.memo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
          if (tip !== a.sha) throw new IntegrityError(`이슈 #${a.issue}의 브랜치 끝이 허용된 해시와 다릅니다. 아무것도 합치지 않았습니다.`);
          checked.push(a);
        }
        const shaSeen = new Set();
        for (const a of checked) {
          if (shaSeen.has(a.sha)) throw new IntegrityError('두 이슈가 같은 커밋을 허용받았습니다. 아무것도 합치지 않았습니다.');
          shaSeen.add(a.sha);
        }
        checked = orderByAncestry(git, ctx.memo, checked);
        // 허용 범위(sha ^main)에는 병합 커밋이 없어야 하고, 합쳐지지 않는 다른 이슈 브랜치를 통째로 품고 있으면 안 된다.
        const listed = new Set(checked.map((a) => a.issue));
        const otherTips = [];
        const refs = git(ctx.memo, ['for-each-ref', '--format=%(refname:lstrip=2) %(objectname)', `refs/heads/${ctx.handoff}/`]);
        for (const line of refs.split('\n')) {
          const m = new RegExp(`^${ctx.handoff}/issue-([1-9]\\d{0,8}) ([0-9a-f]{40})$`).exec(line.trim());
          if (m && !listed.has(Number(m[1]))) otherTips.push(m[2]);
        }
        for (const a of checked) {
          const range = git(ctx.memo, ['rev-list', '--parents', a.sha, `^${mainBefore}`]).split('\n').filter(Boolean);
          if (range.some((l) => l.split(' ').length > 2)) throw new IntegrityError(`이슈 #${a.issue}의 범위에 병합 커밋이 있습니다. 아무것도 합치지 않았습니다.`);
          for (const other of otherTips) {
            if (isAnc(git, ctx.memo, other, mainBefore)) continue;
            if (isAnc(git, ctx.memo, other, a.sha)) {
              throw new IntegrityError(`이슈 #${a.issue}가 합쳐지지 않는 다른 이슈의 커밋을 품고 있습니다. 아무것도 합치지 않았습니다.`);
            }
          }
        }

        const clock = budget(ctx);
        const test = ctx.runTests ?? runNodeTests;
        const results = [];
        const refused = new Set();
        const refusedShas = [];
        const built = [];
        const guard = makeGuard(git, ctx);
        let tip = mainBefore;
        for (const a of checked) {
          checkStop(ctx);
          const deny = (reason) => { refused.add(a.issue); refusedShas.push(a.sha); results.push({ issue: a.issue, status: 'refused', reason }); };
          if (a.dependsOn.some((d) => refused.has(d))) { deny('의존하는 이슈가 합쳐지지 않았습니다'); continue; }
          // 선언한 의존이 없어도 합쳐지지 않은 이슈의 커밋을 품은 이슈는 합치지 않는다.
          let embedsRefused = false;
          for (const r of refusedShas) if (isAnc(git, ctx.memo, r, a.sha)) { embedsRefused = true; break; }
          if (embedsRefused) { deny('합쳐지지 않은 이슈의 커밋을 품고 있습니다'); continue; }
          if (clock.expired()) { deny('전체 제한 시간 초과'); continue; }
          const message = `병합: 이슈 #${a.issue}\n\n이슈 #${a.issue}\n${ALLOWED_COMMIT}: ${a.sha}\n리뷰어 댓글: ${a.reviewUrl}\n`;
          const r = await mergeAndTest({ git, ctx, prev: tip, sha: a.sha, message, test, clock, guard });
          if (r.status === 'merged') {
            if (!r.already) { built.push({ commit: r.commit, tree: r.tree, parents: r.parents, sha: a.sha }); tip = r.commit; }
            results.push({ issue: a.issue, status: r.already ? 'already' : 'merged', sha: a.sha, commit: r.commit });
          } else deny(r.reason);
        }
        // 기록해 둔 병합 커밋(부모 = 앞 커밋과 허용된 해시, 트리)만이 main에서 tip까지의 사슬이어야 한다.
        verifyChain(git, ctx.memo, mainBefore, built);
        checkStop(ctx);
        guard.check();
        if (tip !== mainBefore) {
          // main이 작업 도중 움직였으면 advanceBranch가 거부한다.
          advanceBranch(git, ctx.memo, 'main', tip, mainBefore, { allowPrimary: true });
        }
        return { results, mainBefore, mainAfter: git(ctx.memo, ['rev-parse', '--verify', 'refs/heads/main']) };
      } finally {
        session.close();
      }
    },
  };
}

// ---------- github-queue (주입한 gh로만 동작한다. 조직 저장소가 생기기 전에는 실제로 쓰지 않는다) ----------
// 켜는 것은 설정 ci.mergeQueue를 'github'로 명시했을 때뿐이다. Task 0 확인 1(머지 큐 사용 가능 여부)의 실제 확인이 통과하기 전에는 켜지 않는다.

// opts.gh(args: string[]) => stdout 문자열. 셸 없이 인자 배열로만 호출된다고 가정한다.
export function createGithubQueue({ gh, repo }) {
  if (typeof gh !== 'function') throw new ConfigError('github-queue 어댑터에는 gh 실행 함수가 필요합니다.');
  if (typeof repo !== 'string' || !REPO.test(repo)) throw new ConfigError('github-queue 어댑터의 저장소 이름이 올바르지 않습니다.');
  const prUrl = (out) => {
    const m = /(https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d{0,9})/.exec(String(out));
    if (!m) throw new HarnessError('gh pr create가 PR 주소를 돌려주지 않았습니다.');
    return m[1];
  };
  return {
    kind: 'github-queue',
    async enqueue(items, ctx) {
      const results = [];
      for (const item of items) {
        checkStop(ctx);
        const head = handoffNames(ctx.handoff, item.issue, ctx.run).issueBranch;
        const base = handoffNames(ctx.handoff, null, ctx.run).integrationBranch;
        const url = prUrl(gh(['pr', 'create', '--repo', repo, '--base', base, '--head', head, '--title', `이슈 #${item.issue} 통합`, '--body', `이슈 #${item.issue}`]));
        gh(['pr', 'merge', url, '--repo', repo, '--auto', '--merge']);
        results.push({ issue: item.issue, status: 'queued', reason: '큐에 넣음(CI 결과는 아직 없음)' });
      }
      return results;
    },
    async land(allowed, ctx) {
      const results = [];
      for (const a of allowed) {
        checkStop(ctx);
        if (!FULL_SHA.test(a?.sha ?? '') || !REVIEW_URL.test(a?.reviewUrl ?? '')) throw new IntegrityError('허용 항목의 해시(40자리)나 리뷰어 댓글 URL 모양이 올바르지 않습니다.');
        const head = handoffNames(ctx.handoff, a.issue, ctx.run).issueBranch;
        const url = prUrl(gh(['pr', 'create', '--repo', repo, '--base', 'main', '--head', head, '--title', `병합: 이슈 #${a.issue}`, '--body', `이슈 #${a.issue}\n${ALLOWED_COMMIT}: ${a.sha}\n리뷰어 댓글: ${a.reviewUrl}\n`]));
        let oid;
        try { oid = String(JSON.parse(gh(['pr', 'view', url, '--repo', repo, '--json', 'headRefOid'])).headRefOid); } catch { throw new IntegrityError('PR의 머리 커밋을 읽지 못했습니다.'); }
        if (oid !== a.sha) throw new IntegrityError(`이슈 #${a.issue}의 PR 머리 커밋이 허용된 해시와 다릅니다.`);
        gh(['pr', 'merge', url, '--repo', repo, '--auto', '--merge', '--match-head-commit', a.sha, '--subject', `병합: 이슈 #${a.issue}`, '--body', `이슈 #${a.issue}\n${ALLOWED_COMMIT}: ${a.sha}\n리뷰어 댓글: ${a.reviewUrl}\n`]);
        results.push({ issue: a.issue, status: 'queued', sha: a.sha }); // 큐에 넣었을 뿐 main은 아직 바뀌지 않았다
      }
      return { results };
    },
  };
}

// 설정 ci.mergeQueue: 'local'(기본) → local-sequential, 'github'(또는 'github-queue') → github-queue. 그 밖의 값은 설정 오류.
export function selectAdapter(mergeQueue, deps = {}) {
  if (mergeQueue === 'local') return createLocalSequential();
  if (mergeQueue === 'github' || mergeQueue === 'github-queue') return createGithubQueue({ gh: deps.gh, repo: deps.repo });
  throw new ConfigError(`알 수 없는 ci.mergeQueue 값입니다: ${JSON.stringify(String(mergeQueue)).slice(0, 40)}`);
}

export async function enqueue(adapter, items, ctx) {
  if (typeof adapter?.enqueue !== 'function') throw new ConfigError('어댑터에 enqueue가 없습니다.');
  return adapter.enqueue(items, ctx);
}

export async function land(adapter, allowed, ctx) {
  if (typeof adapter?.land !== 'function') throw new ConfigError('어댑터에 land가 없습니다.');
  return adapter.land(allowed, ctx);
}

// ---------- 스크립트 공통 ----------

export function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== '--handoff') throw new UsageError('사용법: --handoff h<N> (다른 인자나 중복은 허용하지 않습니다)');
  if (!HANDOFF.test(argv[1])) throw new UsageError('--handoff는 h<번호> 모양이어야 합니다(예: h1).');
  return { handoff: argv[1] };
}

// 이 하달의 이슈 브랜치: 이슈 번호(오름차순)와 끝 해시.
export function discoverTips(git, memo, handoff) {
  const out = git(memo, ['for-each-ref', '--format=%(refname:lstrip=2) %(objectname)', `refs/heads/${handoff}/`]);
  const re = new RegExp(`^${handoff}/issue-([1-9]\\d{0,8}) ([0-9a-f]{40})$`);
  return out.split('\n').map((s) => re.exec(s.trim())).filter(Boolean).map((m) => ({ n: Number(m[1]), sha: m[2] })).sort((a, b) => a.n - b.n);
}

// 다른 하달의 같은 이슈 브랜치(재작업, 소유자 결정 2-3).
// later: 이 하달보다 번호가 큰 하달에 브랜치(h<M>/issue-<n>, M > N)가 있는 이슈 번호들.
// earlier: 이슈 번호 → 이 하달보다 앞선 하달의 그 이슈 브랜치 끝 해시들.
function otherHandoffs(git, memo, handoff) {
  const mine = Number(handoff.slice(1));
  const out = git(memo, ['for-each-ref', '--format=%(refname:lstrip=2) %(objectname)', 'refs/heads/']);
  const later = new Set();
  const earlier = new Map();
  for (const line of out.split('\n')) {
    const m = /^h([1-9]\d{0,8})\/issue-([1-9]\d{0,8}) ([0-9a-f]{40})$/.exec(line.trim());
    if (!m) continue;
    const h = Number(m[1]);
    const n = Number(m[2]);
    if (h > mine) later.add(n);
    else if (h < mine) { if (!earlier.has(n)) earlier.set(n, new Set()); earlier.get(n).add(m[3]); }
  }
  return { later, earlier };
}

// enqueue가 건드리지 않는 상태: 이미 막혔거나 멈췄거나 거부·허용·반영된 이슈의 라벨을 되돌리지 않는다.
const ENQUEUE_KEEP = new Set([LABEL.막힘, LABEL.보류, LABEL.거부목록, LABEL.반영됨, LABEL.허용됨, LABEL.대기]);

function stateOf(labels) {
  const found = labelNames(labels).filter((n) => STATES.includes(n));
  return found.length === 1 ? found[0] : null;
}

function readConfigs(env) {
  const run = fwd(resolvePath(env.HARNESS_RUN_DIR || process.cwd()));
  const configFile = `${run}/harness.json`;
  if (!existsSync(configFile)) throw new HarnessError(`실행 폴더에 harness.json이 없습니다.`);
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  if (typeof config.harnessDir !== 'string' || typeof config.targetProject !== 'string' || typeof config.designatedRepo !== 'string') throw new ConfigError('harness.json에 harnessDir·targetProject·designatedRepo가 필요합니다.');
  if (!REPO.test(config.designatedRepo)) throw new ConfigError('harness.json의 designatedRepo 모양이 올바르지 않습니다.');
  const cfg = loadOperatorConfig(`${fwd(config.harnessDir)}/operator/operator.config.json`, { run });
  return { run, config, cfg };
}

// gh api --paginate가 페이지마다 이어 붙여 낸 JSON 배열들을 하나의 배열로 읽는다(문자열 속 괄호는 세지 않는다).
export function parsePaginated(text) {
  const src = String(text);
  const out = [];
  let i = 0;
  const bad = () => new HarnessError('gh api 응답이 올바른 JSON 배열이 아닙니다.');
  while (i < src.length) {
    if (/\s/.test(src[i])) { i++; continue; }
    if (src[i] !== '[') throw bad();
    let depth = 0;
    let inStr = false;
    let esc = false;
    let k = i;
    for (; k < src.length; k++) {
      const ch = src[k];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '[') depth++;
      else if (ch === ']' && --depth === 0) break;
    }
    if (depth !== 0) throw bad();
    let part;
    try { part = JSON.parse(src.slice(i, k + 1)); } catch { throw bad(); }
    if (!Array.isArray(part)) throw bad();
    out.push(...part);
    i = k + 1;
  }
  return out;
}

// REST 댓글(user.login, created_at, updated_at, html_url) → 내부 모양. 객체가 아닌 항목은 버린다.
export function normalizeRestComments(raw) {
  if (!Array.isArray(raw)) throw new HarnessError('댓글 목록이 배열이 아닙니다.');
  return raw.filter((c) => c !== null && typeof c === 'object').map((c) => ({
    id: c.id, author: { login: c.user?.login }, body: c.body, url: c.html_url, createdAt: c.created_at, updatedAt: c.updated_at,
  }));
}

// 이슈 본문·라벨은 gh issue view로, 댓글은 REST(gh api --paginate)로 가져온다(issue view의 댓글에는 수정 시각이 없다). exec(bin, args)는 stdout 문자열.
export function makeFetchIssueData(exec, repo) {
  return async (n) => {
    const view = JSON.parse(exec('gh', ['issue', 'view', String(n), '--repo', repo, '--json', 'number,state,labels,body,url']));
    const comments = normalizeRestComments(parsePaginated(exec('gh', ['api', `repos/${repo}/issues/${n}/comments?per_page=100`, '--paginate'])));
    const t = (c) => Date.parse(c.createdAt);
    comments.sort((a, b) => (t(a) - t(b)) || (Number(a.id) - Number(b.id)) || 0);
    return { ...view, number: n, comments };
  };
}

// gh 호출(HARNESS_GH_BIN은 시험용 가짜 gh): 셸 없이 인자 배열로, 시간 제한과 출력 상한을 둔다.
function ghExec(env, timeout) {
  return (bin, args) => {
    const custom = env.HARNESS_GH_BIN;
    const script = custom && /\.(mjs|js)$/i.test(custom);
    const file = custom ? (script ? process.execPath : custom) : bin;
    return execFileSync(file, script ? [custom, ...args] : args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  };
}

function makeDeps(env, config, deps) {
  const exec = ghExec(env, deps.ghTimeoutMs ?? DEFAULT_GH_TIMEOUT_MS);
  const ghDeps = makeGhDeps(config.designatedRepo, exec);
  const fetchIssueData = deps.fetchIssueData ?? makeFetchIssueData(exec, config.designatedRepo);
  return { fetchIssueData, setState: deps.setState ?? ((n, s) => ghDeps.setState(n, s)), exec };
}

function adapterFor(cfg, config, deps, env) {
  if (deps.adapter) return deps.adapter;
  const exec = ghExec(env, deps.ghTimeoutMs ?? DEFAULT_GH_TIMEOUT_MS);
  return selectAdapter(cfg.ci.mergeQueue, { gh: (args) => exec('gh', args), repo: config.designatedRepo });
}

const issueUrl = (config, n, data) => {
  const u = data?.url;
  if (typeof u === 'string' && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/[1-9]\d{0,9}$/.test(u)) return u;
  return `https://github.com/${config.designatedRepo}/issues/${n}`;
};

function baseCtx({ run, config, cfg, handoff, deps }) {
  return {
    memo: fwd(config.targetProject), run, handoff,
    isStopped: deps.isStopped ?? (() => isStopped(run, handoff)),
    testTimeoutMs: deps.testTimeoutMs, budgetMs: deps.budgetMs, outputCap: deps.outputCap,
    runTests: deps.runTests, spawn: deps.spawn, killTree: deps.killTree, now: deps.now, env: deps.env,
    gitBin: deps.gitBin, gitTimeoutMs: deps.gitTimeoutMs ?? (Number.isSafeInteger(config.gitTimeoutMs) && config.gitTimeoutMs > 0 ? config.gitTimeoutMs : undefined),
    cloneTimeoutMs: deps.cloneTimeoutMs ?? (Number.isSafeInteger(config.cloneTimeoutMs) && config.cloneTimeoutMs > 0 ? config.cloneTimeoutMs : undefined),
    afterTest: deps.afterTest, sweep: deps.sweep,
  };
}

async function runEnqueue({ run, config, cfg, handoff, env, deps }) {
  const ctx = baseCtx({ run, config, cfg, handoff, deps });
  const { fetchIssueData, setState } = makeDeps(env, config, deps);
  const adapter = adapterFor(cfg, config, deps, env);
  const session = openGit(ctx);
  let tips;
  const onMain = new Set();
  try {
    tips = discoverTips(session.git, ctx.memo, handoff);
    for (const t of tips) if (isAnc(session.git, ctx.memo, t.sha, 'refs/heads/main')) onMain.add(t.n);
  } finally { session.close(); }
  if (tips.length === 0) throw new HarnessError('이 하달의 이슈 브랜치가 없습니다.');
  const numbers = tips.map((t) => t.n);
  // 의존 순서: 이슈 본문의 `의존하는 이슈` 절을 읽을 수 있으면 그 순서, 아니면 번호순.
  const datas = new Map();
  for (const n of numbers) datas.set(n, await fetchIssueData(n));
  // 이미 막힘·보류·거부목록·반영됨·허용됨인 이슈는 합치지도 다시 표시하지도 않고 현재 상태로 보고한다. main에 이미 있는 이슈는 건너뛰고 반영됨으로 보고한다.
  const rows = [];
  const skipped = [];
  const todo = [];
  for (const n of numbers) {
    const state = stateOf(datas.get(n)?.labels);
    if (state !== null && ENQUEUE_KEEP.has(state)) skipped.push({ number: n, state, url: issueUrl(config, n, datas.get(n)) });
    // 워커가 묻고 아직 답을 받지 못했다(질문 기록이 남음, 결정 8-38): 브랜치에 질문 전의 반쯤 한 커밋이 있을 수 있어 합치지 않는다.
    else if (existsSync(questionRecordFile(run, handoff, n))) skipped.push({ number: n, state: LABEL.막힘, url: issueUrl(config, n, datas.get(n)) });
    else if (onMain.has(n)) skipped.push({ number: n, state: LABEL.반영됨, url: issueUrl(config, n, datas.get(n)) });
    else todo.push(n);
  }
  if (todo.length > 0) {
    const nodes = todo.map((n) => ({ issue: n, dependsOn: parseDependsOn(datas.get(n)?.body) ?? [] }));
    const { ordered, cyclic } = orderAllowed(nodes);
    const items = [...ordered, ...cyclic].map((x) => ({ issue: x.issue }));
    const results = await enqueue(adapter, items, ctx);
    for (const r of results) {
      const state = r.status === 'merged' ? LABEL.리뷰대기 : r.status === 'rejected' ? LABEL.미완료 : r.status === 'queued' ? LABEL.진행중 : LABEL.보류;
      if (r.status === 'merged' || r.status === 'rejected') await setState(r.issue, state);
      rows.push({ number: r.issue, state, url: issueUrl(config, r.issue, datas.get(r.issue)) });
    }
  }
  return [...rows, ...skipped];
}

// main의 첫 부모 사슬에서 이 하네스가 만든 병합 커밋(부모 둘, 첫 줄 `병합: 이슈 #<N>`, `허용된 커밋: <40자리>` 줄)의 이슈 번호들.
// ctx.run이 있으면 머지 트레인(결정 8-32)이 반영한 이슈도 더한다: run-train이 handoffs/h<N>/train.json에 남긴 허용된 해시가 main의 조상일 때만.
// 트레인은 GitHub Actions가 하달 단위로 합치므로 이슈마다의 병합 커밋이 main의 첫 부모 사슬에 없다. train.json은 handoffs/ 아래라 에이전트가 쓰지 못한다.
export function provenIssuesOnMain(git, ctx) {
  const proven = provenByMergeCommits(git, ctx);
  if (typeof ctx.run === 'string') for (const n of trainProvenIssues(git, ctx.memo, ctx.run)) proven.add(n);
  return proven;
}

export const trainRecordFile = (run, handoff) => `${run}/handoffs/${handoff}/train.json`;

// train.json: { train, runUrl, at, issues: [{ issue, sha }] }. 모양이 틀리거나 해시가 main에 없으면 세지 않는다.
export function trainProvenIssues(git, memo, run) {
  const out = new Set();
  let names = [];
  try { names = readdirSync(`${run}/handoffs`).filter((n) => HANDOFF.test(n)); } catch { return out; }
  for (const h of names) {
    let d;
    try { d = JSON.parse(readFileSync(trainRecordFile(run, h), 'utf8')); } catch { continue; }
    for (const it of Array.isArray(d?.issues) ? d.issues : []) {
      if (!Number.isSafeInteger(it?.issue) || it.issue <= 0 || !FULL_SHA.test(it?.sha ?? '')) continue;
      if (isAnc(git, memo, it.sha, 'refs/heads/main')) out.add(it.issue);
    }
  }
  return out;
}

function provenByMergeCommits(git, ctx) {
  const out = git(ctx.memo, ['log', '--first-parent', '--format=%H%x00%P%x00%B', '-z', 'refs/heads/main']);
  const tokens = out.split('\0');
  const proven = new Set();
  for (let i = 0; i + 2 < tokens.length; i += 3) {
    const parents = tokens[i + 1].split(' ').filter(Boolean);
    if (parents.length !== 2) continue;
    const lines = tokens[i + 2].split(/\r?\n/);
    const m = /^병합: 이슈 #([1-9]\d{0,8})$/.exec(lines[0]);
    const hashLine = lines.find((l) => ALLOWED_COMMIT_LINE.test(l));
    if (m && hashLine && parents[1] === ALLOWED_COMMIT_LINE.exec(hashLine)[1]) proven.add(Number(m[1]));
  }
  return proven;
}

// 반영 순서(결정 8-31): 다른 하달(시작 지점, --base)의 결과 위에서 시작한 하달은 그 하달이 먼저 main에 들어가야 한다.
// 뒤 하달만 반영하면 앞 하달의 커밋이 의존 선언과 상관없이 범위(sha ^main)에 섞여 들어간다(병합 커밋이 없어 아래 무결성 검사로는 걸리지 않는다).
// 기준은 git 조상 관계다(의존 글·라벨이 아님):
//   (가) dispatch.json의 base 하달의 이슈 브랜치 끝 가운데 이 하달의 브랜치가 품고 있고 main에 없는 것이 있으면 거부.
//       base 하달 전체가 아니라 품은 끝만 본다(그 하달의 다른 이슈가 끝내 거부돼도 이 하달이 막히지 않게).
//   (나) workers.jsonl의 시작 기록에서 다른 하달의 브랜치에서 시작한 워커의 시작 커밋이 main에 없고 그 이슈 브랜치가 아직 품고 있으면 거부
//       (base 하달이 중단·정리돼 브랜치가 사라진 경우).
// 함께 반영하는 길은 두지 않는다. 문제가 없으면 null.
// opts.ahead: 같은 트레인에서 이 하달보다 앞에 쌓이는 하달들(run-train, 결정 8-32). 그 하달의 결과는 main에 먼저 들어가는 것으로 본다.
export function baseOrderProblem(git, memo, run, handoff, tips, opts = {}) {
  const ahead = opts.ahead instanceof Set ? opts.ahead : new Set();
  const onMain = (sha) => isAnc(git, memo, sha, 'refs/heads/main');
  const embeds = (sha) => tips.some((t) => isAnc(git, memo, sha, t.sha));
  let base = null;
  try {
    const d = JSON.parse(readFileSync(`${run}/handoffs/${handoff}/dispatch.json`, 'utf8'));
    if (typeof d?.base === 'string' && HANDOFF.test(d.base) && d.base !== handoff) base = d.base;
  } catch { /* 기록이 없으면 (나)만 본다 */ }
  const refuse = (h, n) => `${handoff}은 ${h}의 결과${n ? `(#${n})` : ''} 위에서 시작했고 그 결과가 아직 main에 없습니다. ${h}부터 반영하세요. 아무것도 합치지 않았습니다.`;
  if (base && !ahead.has(base)) {
    for (const t of discoverTips(git, memo, base)) if (!onMain(t.sha) && embeds(t.sha)) return refuse(base, t.n);
  }
  let lines = [];
  try { lines = readFileSync(`${run}/handoffs/${handoff}/workers.jsonl`, 'utf8').split(/\r?\n/).filter(Boolean); } catch { /* 없음 */ }
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const m = /^(h[1-9]\d{0,8})\/issue-[1-9]\d{0,8}$/.exec(e?.base ?? '');
    if (e?.event !== 'start' || !m || m[1] === handoff || ahead.has(m[1]) || !FULL_SHA.test(e.baseCommit ?? '')) continue;
    if (!onMain(e.baseCommit) && embeds(e.baseCommit)) return refuse(m[1], null);
  }
  return null;
}

async function runLand({ run, config, cfg, handoff, env, deps }) {
  const ctx = baseCtx({ run, config, cfg, handoff, deps });
  const { fetchIssueData, setState } = makeDeps(env, config, deps);
  const adapter = adapterFor(cfg, config, deps, env);
  const session = openGit(ctx);
  let tips;
  let others;
  try {
    tips = discoverTips(session.git, ctx.memo, handoff);
    others = otherHandoffs(session.git, ctx.memo, handoff);
    const order = baseOrderProblem(session.git, ctx.memo, run, handoff, tips);
    if (order) throw new HarnessError(order);
  } finally { session.close(); }
  const numbers = tips.map((t) => t.n);
  if (numbers.length === 0) {
    // 반영된 뒤 정리된 하달(pruned.json)을 다시 반영하면: 오류가 아니라 지금 상태를 보고한다(main에 있으면 반영됨).
    const pruned = readPruned(run, handoff);
    if (!pruned) throw new HarnessError('이 하달의 이슈 브랜치가 없습니다.');
    const check = openGit(ctx);
    let proven;
    try { proven = provenIssuesOnMain(check.git, ctx); } finally { check.close(); }
    (deps.writeErr ?? ((line) => console.error(line)))(`참고: ${handoff}는 반영된 뒤 정리된 하달입니다(브랜치 없음). 지금 상태만 보고합니다.`);
    const rows = [];
    for (const n of pruned) {
      const data = await fetchIssueData(n);
      rows.push({ number: n, state: proven.has(n) ? LABEL.반영됨 : LABEL.보류, url: issueUrl(config, n, { ...data, number: n }) });
    }
    return rows;
  }
  const issues = [];
  for (const n of numbers) issues.push({ ...(await fetchIssueData(n)), number: n });
  // 의존 절을 읽을 수 없는 이슈는 허용 수집에서 빠진다(불명확하면 제외). 보고 줄만으로는 이유가 보이지 않으므로 stderr에 한 줄 남긴다.
  // 반영에서 뺀 이슈마다 이유를 한 줄씩 stderr에 남긴다(이슈 #24). 보고 줄(보류)만으로는 이유가 보이지 않는다. 이슈마다 처음 정해진 이유 하나만 쓴다.
  const why = new Map();
  const because = (n, reason) => { if (!why.has(n)) why.set(n, reason); };
  for (const i of issues) {
    if (parseDependsOn(i.body) === null) because(i.number, '`## 의존하는 이슈` 절을 읽을 수 없습니다. 절은 하나만 두고 `#번호`(쉼표 구분) 또는 `없음`만 적으세요.');
  }
  const reviewerLogin = deps.reviewerLogin ?? config.reviewerLogin;
  // 새 하달로 재작업한 이슈(소유자 결정 2-3)는 하달마다 자기 결과만 반영한다.
  // - 더 뒤의 하달에 같은 이슈의 브랜치가 있으면 이 하달의 결과는 대체된 것이다: 반영하지 않는다.
  // - 허용된 해시가 이 하달의 브랜치 끝이 아니라 앞선 하달의 그 이슈 브랜치 끝이면 지난 결과의 허용이다: 이 하달에서는 반영하지 않는다.
  //   어느 하달의 끝도 아닌 해시는 그대로 land로 넘겨 무결성 오류가 되게 한다.
  const tipOf = new Map(tips.map((t) => [t.n, t.sha]));
  const collected = collectAllowed(issues, { reviewerLogin });
  const allowedAll = collected.filter((a) => {
    if (others.later.has(a.issue)) { because(a.issue, '더 뒤의 하달에 같은 이슈의 브랜치가 있어 이 하달의 결과는 대체됐습니다'); return false; }
    if (a.sha !== tipOf.get(a.issue) && others.earlier.get(a.issue)?.has(a.sha)) { because(a.issue, '허용된 커밋이 이 하달이 아니라 앞선 하달의 결과입니다'); return false; }
    return true;
  });
  const allowedNumbers = new Set(allowedAll.map((a) => a.issue));
  const collectedNumbers = new Set(collected.map((a) => a.issue));
  for (const i of issues) {
    if (collectedNumbers.has(i.number)) continue;
    const st = stateOf(i.labels);
    because(i.number, EXCLUDED_LABELS.has(st) ? `상태가 ${st}입니다` : '쓸 수 있는 허용 판정이 없습니다(최신 판정이 허용이 아니거나, 판정 뒤에 새 결과 보고서가 있거나, 보고서·판정이 수정됐거나, 커밋 해시가 묶이지 않음)');
  }
  // 반영됨 라벨은 믿지 않는다: 허용되지 않은 이슈는 모두 막힌 것으로 보고 그에 의존하는 이슈도 뺀다.
  // 이 하달 밖 이슈에 대한 의존은 main에 그 이슈의 병합 커밋(첫 부모 사슬, 이 하네스가 만든 모양)이 있을 때만 충족된 것이다.
  const numberSet = new Set(numbers);
  const outside = [...new Set(allowedAll.flatMap((a) => a.dependsOn))].filter((d) => !numberSet.has(d));
  let unproven = [];
  if (outside.length > 0) {
    const provenSession = openGit(ctx);
    try {
      const proven = provenIssuesOnMain(provenSession.git, ctx);
      unproven = outside.filter((d) => !proven.has(d));
    } finally { provenSession.close(); }
  }
  const blocked = [...numbers.filter((n) => !allowedNumbers.has(n)), ...unproven];
  const eligible = excludeDependents(allowedAll, blocked);
  const eligibleNumbers = new Set(eligible.map((a) => a.issue));
  const dead = new Set([...blocked, ...allowedAll.filter((a) => !eligibleNumbers.has(a.issue)).map((a) => a.issue)]);
  for (const a of allowedAll) {
    if (eligibleNumbers.has(a.issue)) continue;
    const d = a.dependsOn.find((x) => dead.has(x));
    because(a.issue, unproven.includes(d) ? `의존하는 #${d}가 main에 반영되지 않았습니다` : `의존하는 #${d}가 이번에 반영되지 않습니다`);
  }
  const { ordered, cyclic } = orderAllowed(eligible);
  for (const c of cyclic) because(c.issue, '의존 관계에 순환이 있습니다');
  const rowFor = (n, state) => ({ number: n, state, url: issueUrl(config, n, issues.find((i) => i.number === n)) });
  const landed = new Map();
  if (ordered.length > 0) {
    const outcome = await land(adapter, ordered, ctx);
    for (const r of outcome.results) landed.set(r.issue, r);
  }
  // 반영됨은 허용된 해시가 land 뒤의 main의 조상일 때만(믿는 git 환경에서 다시 확인한다).
  const onMain = new Set();
  const verifySession = openGit(ctx);
  try {
    for (const [n, r] of landed) {
      if ((r.status === 'merged' || r.status === 'already') && FULL_SHA.test(r.sha ?? '') && isAnc(verifySession.git, ctx.memo, r.sha, 'refs/heads/main')) onMain.add(n);
    }
  } finally { verifySession.close(); }
  const rows = [];
  for (const n of numbers) {
    if (onMain.has(n)) {
      await setState(n, LABEL.반영됨);
      rows.push(rowFor(n, LABEL.반영됨));
    } else {
      // 합쳐지지 않은 이슈는 어떤 이유든 종료 코드 0이 되지 않게 한다: 거부목록·막힘은 그대로, 나머지는 보류.
      const state = stateOf(issues.find((i) => i.number === n)?.labels);
      const r = landed.get(n);
      if (r) because(n, r.status === 'queued' ? '큐에 넣었고 아직 main에 없습니다' : `합치기 결과 ${r.status}${r.reason ? `: ${r.reason}` : ''}`);
      because(n, 'main에서 허용된 커밋을 확인하지 못했습니다');
      (deps.writeErr ?? ((line) => console.error(line)))(`참고: #${n}을 반영에서 뺐습니다: ${why.get(n)}`);
      rows.push(rowFor(n, state === LABEL.거부목록 || state === LABEL.막힘 ? state : LABEL.보류));
    }
  }
  return rows;
}

// 같은 하달에서 합치기 스크립트 둘이 동시에 돌지 않게 하는 잠금 파일({ pid, token, createdAt }).
// 잠금을 만들거나 낡은 것을 치우거나 풀 때는 모두 교체 구간 뮤텍스(`<잠금>.mutex`, link로 원자적으로 만든다) 안에서만 하므로 세 실행이 한꺼번에 달려들어도
// 살아 있는 잠금을 지우는 일이 없다. 뮤텍스가 죽은 프로세스의 것이면 고유 이름으로 옮겨 토큰을 확인한 뒤 치운다. 토큰이 다른 잠금은 지우지 않는다.
export function acquireLock(file, { beforeTakeover, beforeAway, afterAway, mutexWaitMs = 5000 } = {}) {
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } };
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const readLock = (p) => { try { const o = JSON.parse(readFileSync(p, 'utf8')); return o !== null && typeof o === 'object' ? o : null; } catch { return null; } };
  const body = (token) => JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() });
  const busy = () => new HarnessError('같은 하달의 다른 합치기가 진행 중입니다.');
  const createExclusive = (path, content) => {
    const tmp = `${path}.new-${randomUUID()}`;
    writeFileSync(tmp, content);
    try { linkSync(tmp, path); return true; } catch (e) { if (e?.code === 'EEXIST') return false; throw e; } finally { rmSync(tmp, { force: true }); }
  };
  // 토큰이 expected인 파일만 지운다: 고유 이름으로 옮긴 뒤 확인하고, 다르면 원래 자리에 돌려놓는다(자리가 찼으면 그쪽이 이긴다).
  const removeIfToken = (path, expected) => {
    const tmp = `${path}.away-${randomUUID()}`;
    if (path === file) beforeAway?.(path);
    try { renameSync(path, tmp); } catch { return; }
    if (path === file) afterAway?.(path);
    if ((readLock(tmp)?.token ?? null) === expected) { rmSync(tmp, { force: true }); return; }
    try { linkSync(tmp, path); } catch { throw new HarnessError('잠금 파일 상태가 일관되지 않아 중단했습니다(옮겨 둔 파일은 지우지 않았습니다).'); }
    rmSync(tmp, { force: true });
  };
  const mutex = `${file}.mutex`;
  const withMutex = (fn) => {
    const mtoken = randomUUID();
    const deadline = Date.now() + mutexWaitMs;
    for (;;) {
      if (createExclusive(mutex, body(mtoken))) break;
      const m = readLock(mutex);
      if (!(m && Number.isSafeInteger(m.pid) && m.pid > 0 && alive(m.pid))) { removeIfToken(mutex, m?.token ?? null); continue; }
      if (Date.now() > deadline) throw busy();
      sleep(25);
    }
    try { return fn(); } finally { removeIfToken(mutex, mtoken); }
  };
  const token = randomUUID();
  withMutex(() => {
    const cur = readLock(file);
    if (cur && Number.isSafeInteger(cur.pid) && cur.pid > 0 && alive(cur.pid)) throw busy();
    beforeTakeover?.();
    // 치우기 직전에 다시 읽어 내가 본 낡은 잠금과 같은 것만 치운다(뮤텍스를 모르는 쪽이 그사이 새 잠금을 만들었을 수 있다).
    const again = readLock(file);
    if (again && Number.isSafeInteger(again.pid) && again.pid > 0 && alive(again.pid)) throw busy();
    if (existsSync(file)) removeIfToken(file, again?.token ?? null);
    if (!createExclusive(file, body(token))) throw busy();
  });
  return () => { try { withMutex(() => { if (readLock(file)?.token === token) rmSync(file, { force: true }); }); } catch { /* 풀지 못해도 결과를 바꾸지 않는다 */ } };
}

// kind: 'enqueue' | 'land' | 'reflect'. 세 진입 스크립트가 같은 본체를 쓴다(reflect는 land와 같은 흐름).
export async function runScript(kind, argv, env = process.env, deps = {}) {
  const write = deps.write ?? ((line) => console.log(line));
  const writeErr = deps.writeErr ?? ((line) => console.error(line));
  const fail = (reason) => { writeErr(`오류: ${ONE_LINE(reason)}`); return 2; };
  try {
    const { handoff } = parseArgs(argv);
    const { run, config, cfg } = readConfigs(env);
    if (!existsSync(`${run}/handoffs/${handoff}`)) return fail(`하달 ${handoff} 폴더가 없습니다.`);
    const stopped = exitCode([], { stopped: true });
    if ((deps.isStopped ?? (() => isStopped(run, handoff)))()) return stopped;
    const release = acquireLock(`${run}/handoffs/${handoff}/merge.lock`);
    let rows;
    try {
      rows = await (kind === 'enqueue' ? runEnqueue : runLand)({ run, config, cfg, handoff, env, deps });
    } finally {
      release();
    }
    write(rows.map((r) => formatLine(r)).join('\n'));
    // 로컬 반영(run-reflect) 뒤 브랜치 정리: 이슈가 모두 main에 반영된 하달(같은 이슈의 옛 시도 포함)의 브랜치·작업 폴더를 지운다.
    // 원격 흐름은 run-train이 같은 일을 한다(결정 8-35). 정리 실패는 반영 결과를 바꾸지 않고 참고 줄만 남긴다(stdout은 보고 줄만).
    if (kind === 'reflect') {
      try {
        const memo = fwd(config.targetProject);
        const proven = provenIssuesOnMain(openGit({ env }).git, { memo, run, env });
        const pr = (deps.pruneReflectedHandoffs ?? pruneReflectedHandoffs)({ run, memo, proven });
        if (pr.cleaned.length) writeErr(`참고: 반영된 하달을 정리했습니다: ${pr.cleaned.join(', ')}(브랜치·작업 폴더)`);
        for (const x of pr.failed) writeErr(`참고: ${x.handoff}를 정리하지 못했습니다: ${ONE_LINE(x.reason).slice(0, 160)}`);
      } catch (e) {
        writeErr(`참고: 반영된 하달 정리를 건너뛰었습니다(${ONE_LINE(e?.message ?? e).slice(0, 120)}).`);
      }
    }
    return exitCode(rows);
  } catch (e) {
    if (e instanceof StoppedError) return exitCode([], { stopped: true });
    if (e instanceof UsageError) return fail(`인자 오류: ${e.message}`);
    if (e instanceof ConfigError) return fail(`설정 오류: ${e.message}`);
    if (e instanceof IntegrityError) return fail(`무결성 검사 실패: ${e.message}`);
    if (e instanceof HarnessError) return fail(e.message);
    if (e?.code === 'ETIMEDOUT' || e?.killed === true) return fail('외부 명령(git 또는 gh)이 제한 시간을 넘겨 중단했습니다. 아무것도 바꾸지 않았습니다.');
    // 그 밖의 오류(git·gh·파일 시스템)는 이슈·워커가 고른 문자열이 섞일 수 있어 원문을 싣지 않는다.
    return fail(`합치는 중 예기치 못한 오류가 났습니다(${ONE_LINE(e?.code ?? e?.name ?? 'Error').slice(0, 30)}).`);
  }
}
