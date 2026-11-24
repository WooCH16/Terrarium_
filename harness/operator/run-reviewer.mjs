// 리뷰어 실행. 리뷰어는 TypeSafe System One 모델 Jev다(이슈 #44, ADR 0008). 두 모드가 있다.
//   결과 보고서 판정: node run-reviewer.mjs --issue <n> [--worker-model claude|gemini|muse]
//   조언 판정:       node run-reviewer.mjs --advice <제안문 파일> --advice-id <id>
//
// 판단은 Jev, 결정은 코드(jev-review.mjs). 기계적으로 볼 수 있는 기준은 코드가 보고, 문제가 있으면 Jev를 부르지 않고 거부한다.
// 그다음 완료 기준 한 줄마다 Jev에 Noul로 묻고, 모두 예(설정 jev.yes 이상)일 때만 허용한다. 아니오나 애매(jev.no와 jev.yes 사이)는 거부다.
// Jev 호출이 실패하면(키 없음 제외) 판정이 아니라 종료 코드 6이다. 실패를 거부로 읽지 않는다.
// 리뷰어는 늘 워커(claude, gemini, muse)와 다른 제공사다(ADR 0004의 규칙은 저절로 지켜진다). 리뷰어 순환과 공개 가능 표시에 따른 건너뛰기는 없다.
//
// 결과 보고서 판정: 이슈의 가장 최근 `## 결과 보고서`를 판정하고 이슈 댓글로 남긴 뒤 stdout에 한 줄만 낸다.
//   <댓글 URL> | 리뷰어 판정: 허용|거부 | 모델: jev (<응답의 모델 ID>)
//   허용 댓글은 `## 리뷰어 판정: 허용`과 `허용된 커밋: <보고서의 커밋 해시>` 두 줄로 시작한다(합치기 스크립트의 collectAllowed가 읽는 형식).
//
// 조언 판정(ADR 0006): 어드바이저가 직접 부른다.
//   - 제안문 파일은 리뷰어 전용 폴더 <실행 폴더>/reviewer-inbox/ 바로 아래에 있어야 한다(setup.mjs가 만든다). 실제 경로(심볼릭 링크를 따라간 것)도 같아야 한다.
//   - 스크립트가 파일 바이트를 한 번 읽어 SHA-256을 계산한다. MAX_ADVICE_CHARS자를 넘거나 UTF-8이 아니면 입력 오류(2)다.
//   - 판정마다 <실행 폴더>/advice-log.jsonl에 JSON 한 줄을 덧붙인다:
//       { time, file, adviceId, sha256, verdict, reasons(거부일 때), malformed(false), reviewer, attempt }
//     그다음 제안문 파일을 지운다. 판정이 나오지 않은 실패(종료 코드 2·4·6)는 기록하지 않고, 파일을 남기고, 한도에 세지 않는다.
//   - 허용: 제안문 바이트를 그대로 <실행 폴더>/handoffs/advice-<해시 앞 8자리>.md에 복사하고(훅이 쓰기를 막는 폴더) stdout에 한 줄을 낸다:
//       리뷰어 판정: 허용 | 허용된 조언: <64자리> | 전달 파일: <경로> | 조언 id: <id> | 모델: jev (<모델 ID>) | 시도: <n>/2
//   - 거부: stdout 첫 줄 `리뷰어 판정: 거부 | 모델: jev (<모델 ID>) | 시도: <n>/2`, 다음 줄부터 거부 이유(어드바이저가 고칠 근거).
//   - 2회 한도: 같은 --advice-id로 거부가 2번 기록되어 있으면 Jev를 부르지 않고 stdout에 한 줄을 낸 뒤 종료 코드 7로 끝난다.
//
// 키: TYPESAFE_API_KEY(환경 변수 → 실행 폴더 .env → 하네스 저장소 .env, jev.mjs). 키는 출력·기록·댓글에 남기지 않는다.
//
// 종료 코드:
//   0 판정을 남겼다(허용이든 거부든. 보고서 판정은 이슈 댓글, 조언 판정은 실행 기록)
//   2 인자·설정·입력 오류(키 없음 포함)
//   4 결과 불인정(판정하는 동안 제안문이 바뀜)
//   5 판정 게시·기록 실패(보고서 판정의 댓글 게시, 조언 판정의 실행 기록·전달 파일·제안문 삭제)
//   6 Jev 호출 실패(네트워크, 시간 초과, 429, 200 아님, 응답 모양 어긋남). 일시적 실패(네트워크, 시간 초과, 429, 5xx)는 2회 다시 부른 뒤다(이슈 #25)
//   7 같은 조언이 이미 2번 거부됨(조언 판정만. 코디네이터가 기록된 해시와 거부 이유로 사용자에게 묻는다)
//   3은 쓰지 않는다. 다른 스크립트에서 3은 "중단"이다(소유자 결정 4-1).
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, readdirSync, mkdirSync, appendFileSync, unlinkSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve as resolvePath, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadOperatorConfig, ConfigError } from './config.mjs';
import { WORKER_TYPES } from './model-exec.mjs';
import { askJevWithRetry, findJevKey, JevError, KEY_NAME } from './jev.mjs';
import { issueCriteria, reportProblems, reportQuestions, proposalProblems, proposalQuestions, decide, probabilityTable } from './jev-review.mjs';
import { normPath } from '../policy.mjs';
import { REPORT_HEAD, VERDICT_ALLOW, VERDICT_REJECT, ALLOWED_COMMIT, REVIEWER_MODEL, WORKER_MODEL, ACTUAL_WORKER_MODEL, fieldLine } from './protocol.mjs';

const fwd = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
const ONE_LINE = (text) => String(text).replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);

export const REVIEWER_TYPE = 'jev';

// 조언 판정(ADR 0006)
export const ADVICE_LIMIT = 2;
export const MAX_ADVICE_CHARS = 16000;
const ADVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ADVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const inboxOf = (run) => `${fwd(run)}/reviewer-inbox`;
export const adviceLogOf = (run) => `${fwd(run)}/advice-log.jsonl`;

// 이 이슈의 워커 워크트리(<실행 폴더>/worktrees/h<N>/issue-<번호>) 중 하달 번호가 가장 큰 것. 없으면 null.
export function findIssueWorktree(run, issue) {
  let names;
  try { names = readdirSync(`${run}/worktrees`); } catch { return null; }
  const hs = names.map((n) => /^h([1-9]\d*)$/.exec(n)).filter(Boolean).sort((a, b) => Number(b[1]) - Number(a[1]));
  for (const m of hs) {
    const dir = `${run}/worktrees/${m[0]}/issue-${issue}`;
    if (existsSync(dir)) return dir;
  }
  return null;
}

class UsageError extends Error {}
class InputError extends Error {}

const USAGE = '사용법: --issue <번호> [--worker-model claude|gemini|muse] 또는 --advice <제안문 파일> --advice-id <id>';

function parseArgs(argv) {
  const seen = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!['--issue', '--worker-model', '--advice', '--advice-id'].includes(flag)) throw new UsageError(`알 수 없는 인자입니다: ${JSON.stringify(String(flag)).slice(0, 40)}. ${USAGE}`);
    if (flag in seen) throw new UsageError(`인자 ${flag}가 두 번 이상 있습니다.`);
    if (argv[i + 1] === undefined) throw new UsageError(`인자 ${flag}에 값이 필요합니다.`);
    seen[flag] = argv[i + 1];
  }
  if ('--advice' in seen || '--advice-id' in seen) {
    if ('--issue' in seen || '--worker-model' in seen) throw new UsageError(`--advice와 --issue·--worker-model은 같이 쓸 수 없습니다. ${USAGE}`);
    if (!('--advice' in seen) || !('--advice-id' in seen)) throw new UsageError('조언 판정에는 --advice와 --advice-id가 모두 필요합니다.');
    if (!ADVICE_ID.test(seen['--advice-id'])) throw new UsageError('--advice-id는 영문·숫자로 시작하는 64자 이하의 영문·숫자·점·밑줄·붙임표여야 합니다.');
    return { mode: 'advice', advice: seen['--advice'], adviceId: seen['--advice-id'] };
  }
  if (!('--issue' in seen)) throw new UsageError(`인자 --issue가 필요합니다. ${USAGE}`);
  if (!/^[1-9]\d{0,8}$/.test(seen['--issue'])) throw new UsageError('--issue는 양의 정수 이슈 번호여야 합니다.');
  const wm = seen['--worker-model'];
  if (wm !== undefined && !WORKER_TYPES.includes(wm)) throw new UsageError(`--worker-model은 ${WORKER_TYPES.join(', ')} 중 하나여야 합니다.`);
  return { mode: 'issue', issue: Number(seen['--issue']), workerModel: wm ?? null };
}

// 워커 타입(판정 댓글의 기록용). 가장 최근 결과 보고서에 `실제 워커 모델:` 줄이 있으면 그 값(소유자 결정 5-3)을 먼저 쓴다.
// 그 줄이 둘 이상이거나 값이 허용 목록 밖이면 null. 줄이 없으면 이슈 본문의 `워커 모델:` 줄에서 읽는다.
export function workerTypeOf(body, comments) {
  const rep = comments === undefined ? null : latestReport(comments);
  const actual = rep ? rep.body.split(/\r?\n/).filter((l) => fieldLine(ACTUAL_WORKER_MODEL).test(l)) : [];
  if (actual.length > 1) return null;
  const line = actual.length === 1 ? actual[0] : String(body ?? '');
  const key = actual.length === 1 ? ACTUAL_WORKER_MODEL : WORKER_MODEL;
  const m = new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?${key}[ \\t]*:[ \\t]*\`?([A-Za-z][A-Za-z0-9._-]*)\`?`, 'm').exec(line);
  return m && WORKER_TYPES.includes(m[1]) ? m[1] : null;
}

// 가장 최근 `## 결과 보고서` 댓글과 그 안의 `커밋 해시:` 값(한 줄이고 40자리 소문자 16진수일 때만).
export function latestReport(comments) {
  const list = Array.isArray(comments) ? comments : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const body = typeof list[i]?.body === 'string' ? list[i].body : '';
    if (!body.split(/\r?\n/, 1)[0].startsWith(REPORT_HEAD)) continue;
    const lines = body.split(/\r?\n/).filter((l) => l.startsWith('커밋 해시:'));
    const m = lines.length === 1 ? /^커밋 해시: ([0-9a-f]{40})[ \t]*$/.exec(lines[0]) : null;
    return { comment: list[i], body, hash: m ? m[1] : null };
  }
  return null;
}

const defaultGh = (env) => (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });

function loadHarness(run, deps) {
  if (deps.harness) return deps.harness;
  const f = `${run}/harness.json`;
  if (!existsSync(f)) throw new InputError(`실행 폴더에 harness.json이 없습니다: ${run}`);
  return JSON.parse(readFileSync(f, 'utf8'));
}

const gitIn = (deps, cwd) => deps.git ?? ((args) => execFileSync('git', ['-C', cwd, '-c', 'core.fsmonitor=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));

// 보고서 커밋에 그 파일이 있는가. 작업 폴더가 git 저장소가 아니거나 커밋이 없으면 null(검사에서 뺀다).
// byName(name): 커밋 안에 그 이름(마지막 조각)의 파일이 있는가(빗금 없는 근거 이름, 결정 8-30). 파일 목록은 한 번만 읽는다. 읽지 못하면 false(검사에서 뺀다).
export function fileCheckerAt(git, hash) {
  if (!hash) return null;
  try { git(['cat-file', '-e', `${hash}^{commit}`]); } catch { return null; }
  const exists = (p) => { try { git(['cat-file', '-e', `${hash}:${p}`]); return true; } catch { return false; } };
  let names = null;
  exists.byName = (name) => {
    if (names === null) {
      try { names = new Set(String(git(['ls-tree', '-r', '--name-only', '-z', hash])).split('\0').filter(Boolean).map((f) => f.slice(f.lastIndexOf('/') + 1))); } catch { names = new Set(); }
    }
    return names.has(name);
  };
  return exists;
}

// 실행 기록(advice-log.jsonl)을 읽는다. 깨진 줄이 있으면 한도를 셀 수 없으므로 오류로 멈춘다.
export function readAdviceLog(file) {
  if (!existsSync(file)) return [];
  const out = [];
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    let e;
    try { e = JSON.parse(lines[i]); } catch { throw new InputError(`실행 기록의 ${i + 1}번째 줄이 JSON이 아닙니다: ${file}`); }
    if (e === null || typeof e !== 'object' || Array.isArray(e)) throw new InputError(`실행 기록의 ${i + 1}번째 줄이 객체가 아닙니다: ${file}`);
    out.push(e);
  }
  return out;
}

// 제안문 경로를 확인한다: 리뷰어 전용 폴더 바로 아래의 일반 파일이고, 실제 경로도 그 폴더 안이어야 한다.
function checkProposalPath(run, given) {
  const inbox = inboxOf(run);
  const file = fwd(resolvePath(given));
  if (normPath(dirname(file)) !== normPath(inbox) || !ADVICE_NAME.test(basename(file))) {
    throw new InputError(`제안문 파일은 리뷰어 전용 폴더(${inbox}/) 바로 아래에 있어야 하고, 이름은 영문·숫자·점·밑줄·붙임표만 씁니다: ${ONE_LINE(given)}`);
  }
  let real;
  let realInbox;
  try { real = fwd(realpathSync(file)); realInbox = fwd(realpathSync(inbox)); } catch { throw new InputError(`제안문 파일이 없습니다: ${file}`); }
  if (normPath(dirname(real)) !== normPath(realInbox)) throw new InputError(`제안문 파일의 실제 경로가 리뷰어 전용 폴더 밖입니다: ${real}`);
  if (!statSync(real).isFile()) throw new InputError(`제안문 경로가 일반 파일이 아닙니다: ${file}`);
  return file;
}

const sha256Of = (buf) => createHash('sha256').update(buf).digest('hex');

// 코드 검사를 통과했으면 Jev에 묻고 결정한다. 돌려주는 값: { verdict, reasons, table, model } 또는 { fail: [코드, 사유] }.
async function judge({ problems, questions, state, ctx, cfg, env, run, deps }) {
  if (problems.length > 0) return { verdict: '거부', reasons: problems.map((p) => `- ${p}`), table: null, model: '호출 안 함: 코드 검사에서 거부' };
  const found = deps.jevKey !== undefined ? (deps.jevKey ? { key: deps.jevKey } : null) : findJevKey({ env: { ...process.env, ...env }, run, harnessDir: fwd(dirname(dirname(fileURLToPath(import.meta.url)))) });
  if (!found) return { fail: [2, `${KEY_NAME}가 없습니다. 환경 변수나 실행 폴더의 .env에 넣으세요(값은 출력하지 않습니다).`] };
  let res;
  try {
    res = await (deps.askJev ?? askJevWithRetry)({ jev: cfg.jev, key: found.key, state, questions, fetchImpl: deps.fetch }, { sleep: deps.sleep });
  } catch (e) {
    if (e instanceof JevError) return { fail: [6, e.message] };
    throw e;
  }
  const d = decide(res.answers, questions, cfg.jev, ctx);
  return { verdict: d.verdict, reasons: d.reasons, table: probabilityTable(d.rows, ctx), model: res.model };
}

async function adviceMain({ advice, adviceId }, env, deps, out) {
  const { write, fail } = out;
  const run = fwd(resolvePath(env.HARNESS_RUN_DIR || process.cwd()));
  loadHarness(run, deps);
  const file = checkProposalPath(run, advice);
  const logFile = deps.adviceLog ?? adviceLogOf(run);
  const log = readAdviceLog(logFile);
  const mine = log.filter((e) => e.adviceId === adviceId);
  const rejected = mine.filter((e) => e.verdict === '거부');
  if (rejected.length >= ADVICE_LIMIT) {
    write(`같은 조언(--advice-id ${adviceId})이 이미 ${rejected.length}번 거부되어 더 판정하지 않습니다. 코디네이터가 실행 기록(${logFile})의 해시와 거부 이유로 사용자에게 물어야 합니다.`);
    return 7;
  }
  const attempt = mine.length + 1;

  const buf = readFileSync(file);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return fail(2, `제안문이 UTF-8 글이 아닙니다: ${file}`); }
  if (text.trim() === '') return fail(2, `제안문이 비어 있습니다: ${file}`);
  if (text.length > MAX_ADVICE_CHARS) return fail(2, `제안문이 너무 깁니다(${text.length}자, 한도 ${MAX_ADVICE_CHARS}자). 나누어 판정받으세요.`);
  const sha = sha256Of(buf);

  const cfg = deps.cfg ?? loadOperatorConfig(fileURLToPath(new URL('./operator.config.json', import.meta.url)), { run });
  const { units, problems } = proposalProblems(text);
  const questions = problems.length === 0 ? proposalQuestions(units) : {};
  const j = await judge({ problems, questions, state: { proposal: text }, ctx: { units }, cfg, env, run, deps });
  if (j.fail) return fail(...j.fail);
  let now;
  try { now = readFileSync(file); } catch { now = null; }
  if (!now || sha256Of(now) !== sha) return fail(4, '결과를 인정하지 않습니다: 판정하는 동안 제안문 파일이 바뀌었거나 없어졌습니다.');

  const reviewer = `${REVIEWER_TYPE} (${j.model})`;
  const reasons = j.verdict === '허용' ? null : j.reasons.join('\n');
  const entry = {
    time: new Date().toISOString(), file: basename(file), adviceId, sha256: sha, verdict: j.verdict,
    ...(reasons !== null ? { reasons } : {}), malformed: false, reviewer, attempt,
  };
  let handoff = null;
  try {
    if (j.verdict === '허용') {
      mkdirSync(`${run}/handoffs`, { recursive: true });
      handoff = `${run}/handoffs/advice-${sha.slice(0, 8)}.md`;
      writeFileSync(handoff, buf);
    }
    appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
  } catch (e) { return fail(5, `판정을 기록하지 못했습니다: ${ONE_LINE(e.message)}`); }
  try { unlinkSync(file); } catch (e) { return fail(5, `판정은 기록했지만 제안문을 지우지 못했습니다: ${ONE_LINE(e.message)}`); }

  const tail = `모델: ${reviewer} | 시도: ${attempt}/${ADVICE_LIMIT}`;
  if (j.verdict === '허용') {
    write(`리뷰어 판정: 허용 | 허용된 조언: ${sha} | 전달 파일: ${handoff} | 조언 id: ${adviceId} | ${tail}`);
  } else {
    const lines = [`리뷰어 판정: 거부 | ${tail}`, reasons];
    if (rejected.length + 1 >= ADVICE_LIMIT) lines.push(`같은 조언(--advice-id ${adviceId})이 ${ADVICE_LIMIT}번 거부되었습니다. 더 판정받을 수 없으니 코디네이터에게 알리세요. 코디네이터가 사용자에게 묻습니다.`);
    write(lines.join('\n'));
  }
  return 0;
}

export async function main(argv, env = process.env, deps = {}) {
  const write = deps.write ?? ((line) => console.log(line));
  const writeErr = deps.writeErr ?? ((line) => console.error(line));
  const fail = (code, reason) => { writeErr(`오류: ${ONE_LINE(reason)}`); return code; };
  let tmp = null;
  try {
    const args = parseArgs(argv);
    if (args.mode === 'advice') return await adviceMain(args, env, deps, { write, fail });
    const { issue, workerModel } = args;
    const run = fwd(resolvePath(env.HARNESS_RUN_DIR || process.cwd()));
    const hj = loadHarness(run, deps);
    const repo = hj.designatedRepo;
    if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return fail(2, 'harness.json의 designatedRepo가 owner/name 모양이 아닙니다.');
    const cfg = deps.cfg ?? loadOperatorConfig(fileURLToPath(new URL('./operator.config.json', import.meta.url)), { run });
    const gh = deps.gh ?? defaultGh(env);
    const fetchIssue = deps.fetchIssue ?? (async (n) => JSON.parse(gh(['issue', 'view', String(n), '--repo', repo, '--json', 'body,comments'])));
    const data = await fetchIssue(issue);
    if (typeof data?.body !== 'string') return fail(2, `이슈 #${issue}의 본문을 가져오지 못했습니다.`);
    const rep = latestReport(data.comments);
    if (!rep) return fail(2, `이슈 #${issue}에 결과 보고서(\`${REPORT_HEAD}\`로 시작하는 댓글)가 없습니다.`);
    const workerType = workerModel ?? workerTypeOf(data.body, data.comments);

    // 근거 파일은 보고서 커밋에서 확인한다(작업 폴더: 이 이슈의 워커 워크트리, 없으면 대상 프로젝트).
    const reviewCwd = fwd(deps.reviewCwd ?? findIssueWorktree(run, issue) ?? hj.targetProject ?? run);
    const fileExists = fileCheckerAt(gitIn(deps, reviewCwd), rep.hash);
    const criteria = issueCriteria(data.body);
    const problems = reportProblems({ report: rep.body, hash: rep.hash, criteria, fileExists });
    if (!fileExists && rep.hash) problems.push('보고서의 커밋이 작업 폴더의 저장소에 없어 근거 파일을 확인할 수 없습니다.');
    const questions = problems.length === 0 ? reportQuestions(criteria) : {};
    const j = await judge({ problems, questions, state: { report: rep.body }, ctx: { criteria }, cfg, env, run, deps });
    if (j.fail) return fail(...j.fail);

    const bodyLines = j.verdict === '허용'
      ? [VERDICT_ALLOW, `${ALLOWED_COMMIT}: ${rep.hash}`]
      : [VERDICT_REJECT, '', '고칠 점:', ...j.reasons];
    const trailer = [
      '',
      `${REVIEWER_MODEL}: ${REVIEWER_TYPE} (${j.model})`,
      '실행 경로: TypeSafe System One HTTP API(판단은 Jev, 허용·거부 결정은 스크립트)',
      `워커 타입: ${workerType ?? '알 수 없음'}`,
      ...(j.table ? ['', '### Jev 판단', ...j.table] : []),
    ];
    const comment = `${[...bodyLines, ...trailer].join('\n')}\n`;

    const post = deps.postComment ?? (async (n, text) => {
      tmp = mkdtempSync(`${fwd(tmpdir())}/reviewer-`);
      const f = `${tmp}/verdict-comment.md`;
      writeFileSync(f, text);
      return gh(['issue', 'comment', String(n), '--repo', repo, '--body-file', f]).trim().split(/\s+/).pop();
    });
    let url;
    try { url = await post(issue, comment); } catch (e) { return fail(5, `판정 댓글을 게시하지 못했습니다: ${ONE_LINE(e.message)}`); }
    write(`${ONE_LINE(url)} | 리뷰어 판정: ${j.verdict} | 모델: ${REVIEWER_TYPE} (${j.model})`);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) return fail(2, `인자 오류: ${e.message}`);
    if (e instanceof ConfigError) return fail(2, `설정 오류: ${e.message}`);
    if (e instanceof InputError) return fail(2, e.message);
    return fail(2, e?.message ?? String(e));
  } finally {
    if (tmp) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 무시 */ } }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
