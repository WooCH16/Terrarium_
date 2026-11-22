// 결정 8-32: 대상 저장소의 GitHub Actions와 주고받는 공통 도우미. push-branch.mjs, run-train.mjs, preflight.mjs, setup.mjs가 쓴다.
// 하네스는 브랜치를 올리고 Actions가 낸 결과(PR, 검사, 트레인 실행)를 읽기만 한다. 쓰는 gh 호출은 run-train의 `gh workflow run harness-train.yml` 하나다.
// 이 모듈의 gh·git 호출은 훅이 보지 않는다(스크립트 안의 자식 프로세스). 그래서 모양을 여기서 고정한다.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

export const fwd = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
export const ONE_LINE = (text) => String(text).replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
export const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const WORKFLOWS = Object.freeze({ issue: 'harness-issue-pr.yml', handoff: 'harness-handoff-pr.yml', train: 'harness-train.yml', ci: 'harness-ci.yml' });

export class FlowError extends Error {}

// 실행 폴더의 harness.json. 대상 원격(결정 8-32)은 targetRepo(owner/name, gh --repo용)와 targetRemote(git push 주소) 두 칸이다. setup --target-repo가 쓴다.
export function readRun(env) {
  const run = fwd(resolvePath(env.HARNESS_RUN_DIR || process.cwd()));
  const file = `${run}/harness.json`;
  if (!existsSync(file)) throw new FlowError('실행 폴더에 harness.json이 없습니다.');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof config.harnessDir !== 'string' || typeof config.targetProject !== 'string' || typeof config.designatedRepo !== 'string' || !REPO.test(config.designatedRepo)) {
    throw new FlowError('harness.json에 harnessDir·targetProject·designatedRepo(owner/name)가 필요합니다.');
  }
  return { run, config };
}

// 대상 원격이 없으면 null(결정 4: 로컬 흐름). 한쪽만 있거나 모양이 틀려도 없는 것으로 본다(쓰지 않는 쪽).
export function targetOf(config) {
  const repo = config?.targetRepo;
  const remote = config?.targetRemote;
  if (typeof repo !== 'string' || !REPO.test(repo) || /\.git$/i.test(repo)) return null;
  if (typeof remote !== 'string' || remote.trim() === '' || /[\s\0]/.test(remote) || remote.startsWith('-')) return null;
  return { repo, remote };
}

// gh 실행(HARNESS_GH_BIN은 시험용 가짜 gh, .mjs/.js면 node로). 종료 코드가 0이 아니어도 okCodes에 들면 stdout을 돌려준다
// (`gh pr checks`는 검사가 실패하면 1, 아직 도는 중이면 8로 끝난다: 확인 필요, gh 2.x 기준).
export function makeGh(env = process.env, timeout = 60000) {
  return (args, { okCodes = [0] } = {}) => {
    const custom = env.HARNESS_GH_BIN;
    const script = custom && /\.(mjs|js)$/i.test(custom);
    const file = custom ? (script ? process.execPath : custom) : 'gh';
    try {
      return execFileSync(file, script ? [custom, ...args] : args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024, windowsHide: true, env });
    } catch (e) {
      if (typeof e?.status === 'number' && okCodes.includes(e.status) && typeof e.stdout === 'string') return e.stdout;
      throw e;
    }
  };
}

// 원격과 주고받는 git(push, ls-remote, fetch). 믿는 git(merge-adapter의 openGit)은 전역 설정을 막아 자격 증명 도우미를 못 읽는다.
// 그래서 원격 호출만 사용자의 git 설정을 그대로 쓴다(확인 필요: 진짜 HTTPS 원격의 인증은 S12에서 본다). 훅 폴더는 막는다(대상 저장소의 pre-push 훅을 돌리지 않는다).
const HOOKS_SINK = process.platform === 'win32' ? '\\\\.\\NUL' : '/dev/null';
export function makeRemoteGit(env = process.env, timeout = 5 * 60 * 1000) {
  const e2 = { ...env, GIT_TERMINAL_PROMPT: '0' };
  for (const k of Object.keys(e2)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|CONFIG_PARAMETERS)$/i.test(k)) delete e2[k];
  return (cwd, args) => execFileSync('git', ['-C', cwd, '-c', `core.hooksPath=${HOOKS_SINK}`, '-c', 'core.fsmonitor=false', ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: e2,
  }).trim();
}

// 원격 브랜치의 끝 해시. 없으면 null.
export function remoteSha(rgit, memo, remote, branch) {
  const out = rgit(memo, ['ls-remote', remote, `refs/heads/${branch}`]);
  const line = out.split('\n').map((l) => l.trim()).find((l) => l.endsWith(`\trefs/heads/${branch}`));
  const sha = line ? line.split('\t')[0] : null;
  return sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

// 대상 저장소 main에 워크플로 파일이 있는지(contents API, 읽기). 없거나 읽지 못하면 false.
export function hasWorkflow(gh, repo, file) {
  try { gh(['api', `repos/${repo}/contents/.github/workflows/${file}?ref=main`, '--jq', '.path']); return true; } catch { return false; }
}

// head·base가 맞고 머리 커밋이 sha인 PR. 없으면 null. 읽기만 한다(gh pr list).
export function findPr(gh, repo, { head, base, sha, state = 'all' }) {
  const list = JSON.parse(gh(['pr', 'list', '--repo', repo, '--head', head, '--base', base, '--state', state, '--json', 'number,url,headRefOid,state,baseRefName,headRefName']) || '[]');
  if (!Array.isArray(list)) return null;
  const pr = list.find((p) => p?.headRefName === head && p?.baseRefName === base && (sha === undefined || p?.headRefOid === sha));
  return pr ? { number: pr.number, url: String(pr.url), state: pr.state, headRefOid: pr.headRefOid } : null;
}

// PR 검사 결과(gh pr checks, 읽기). bucket: pass·fail·pending·skipping·cancel(확인 필요: gh 2.x의 --json bucket).
// 검사가 아직 하나도 없으면 pending으로 본다(Actions가 막 시작했을 수 있다).
export function readChecks(gh, repo, number) {
  let out;
  try { out = gh(['pr', 'checks', String(number), '--repo', repo, '--json', 'name,bucket,state,link'], { okCodes: [0, 1, 8] }); } catch (e) {
    if (/no checks reported/i.test(String(e?.stderr ?? ''))) return { state: 'pending', checks: [] };
    throw e;
  }
  let list;
  try { list = JSON.parse(out || '[]'); } catch { return { state: 'pending', checks: [] }; }
  if (!Array.isArray(list) || list.length === 0) return { state: 'pending', checks: [] };
  const checks = list.map((c) => ({ name: ONE_LINE(c?.name ?? '').slice(0, 100), bucket: String(c?.bucket ?? '').toLowerCase(), link: typeof c?.link === 'string' ? c.link.slice(0, 300) : '' }));
  if (checks.some((c) => c.bucket === 'fail' || c.bucket === 'cancel')) return { state: 'fail', checks };
  if (checks.some((c) => c.bucket === 'pending' || c.bucket === '')) return { state: 'pending', checks };
  return { state: 'pass', checks };
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fn이 null이 아닌 값을 낼 때까지 pollMs마다 부른다. waitMs가 지나면 null.
export async function poll(fn, { waitMs, pollMs, now = () => Date.now(), sleep = realSleep }) {
  const until = now() + waitMs;
  for (;;) {
    const v = await fn();
    if (v !== null && v !== undefined) return v;
    if (now() >= until) return null;
    await sleep(pollMs);
  }
}

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
// 기다림 한도: PR·CI는 기본 30분, 트레인은 기본 60분. 시험은 환경 변수로 줄인다.
export const ciWait = (env) => ({ waitMs: num(env.HARNESS_CI_WAIT_MS, 30 * 60 * 1000), pollMs: num(env.HARNESS_CI_POLL_MS, 15000) });
export const trainWait = (env) => ({ waitMs: num(env.HARNESS_TRAIN_WAIT_MS, 60 * 60 * 1000), pollMs: num(env.HARNESS_CI_POLL_MS, 15000) });
