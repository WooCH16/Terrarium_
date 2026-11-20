// 오퍼레이터 작업 세션 시작: node run-operator.mjs --issues <n,n,...> [--handoff h<N>]
// stdout에는 보고 줄(#번호 | 상태 | url)만, 설정·인자·gh 오류는 한국어 한 줄 + 종료 코드 2.
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { loadOperatorConfig, ConfigError } from './config.mjs';
import { nextHandoff } from './handoff.mjs';
import { formatReport, exitCode, STATES, NO_LABEL, ENSURED_LABELS } from './report.mjs';
import { parseDependsOn } from './issue-body.mjs';
import { collectAllowed, provenIssuesOnMain, makeFetchIssueData } from './merge-adapter.mjs';
import { loadModeDocs, launchSession, cleanupHandoff, isStopped, handoffHasWork } from './launch.mjs';
import { REPORT_HEAD, VERDICT_HEAD, LABEL } from './protocol.mjs';

const fwd = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
const ONE_LINE = (text) => String(text).replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
// 새 하달에서 진행중으로 되돌리는 상태: 합치기 스크립트(enqueue)가 건너뛰는 상태와 라벨 없음. 미완료·리뷰대기는 enqueue가 그대로 다시 합친다.
const REDISPATCH_RESET = new Set([NO_LABEL, LABEL.허용됨, LABEL.보류, LABEL.막힘, LABEL.대기]);

// 결과 없음 횟수(소유자 결정 2-4): 이슈마다 보고서 없이 끝난 새 하달이 연달아 몇 번인지. 보고서가 늘면 지운다.
// handoffs/ 아래라 코디네이터 훅이 쓰기를 막는다.
const noReportFile = (run) => `${run}/handoffs/no-report.json`;
function readNoReport(run) {
  const f = noReportFile(run);
  if (!existsSync(f)) return {};
  const data = JSON.parse(readFileSync(f, 'utf8'));
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${f}의 모양이 올바르지 않습니다.`);
  return data;
}
function writeNoReport(run, data) {
  const f = noReportFile(run);
  writeFileSync(`${f}.tmp`, JSON.stringify(data, null, 2));
  renameSync(`${f}.tmp`, f);
}

class UsageError extends Error {}

// 댓글 목록에서 "결과 보고서 뒤, 다음 보고서 전에 리뷰어 판정이 있는" 보고서 수.
export function reviewedReports(comments) {
  const heads = comments.map((c) => (typeof c?.body === 'string' ? c.body.trimStart() : ''));
  let count = 0;
  heads.forEach((h, i) => {
    if (!h.startsWith(REPORT_HEAD)) return;
    for (let k = i + 1; k < heads.length && !heads[k].startsWith(REPORT_HEAD); k++) {
      if (heads[k].startsWith(VERDICT_HEAD)) { count++; break; }
    }
  });
  return count;
}

function parseArgs(argv) {
  const seen = {};
  // --force-restart는 값 없는 플래그다(코디네이터의 허용 모양에는 없다: 사람만 쓴다).
  const forceRestart = argv.includes('--force-restart');
  if (forceRestart) argv = argv.filter((t) => t !== '--force-restart');
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (flag !== '--issues' && flag !== '--handoff') throw new UsageError(`알 수 없는 인자입니다: ${JSON.stringify(flag).slice(0, 40)}. 사용법: --issues <n,n,...> [--handoff h<N> [--force-restart]]`);
    if (flag in seen) throw new UsageError(`인자 ${flag}가 두 번 이상 있습니다.`);
    const value = argv[i + 1];
    if (value === undefined) throw new UsageError(`인자 ${flag}에 값이 필요합니다.`);
    seen[flag] = value;
  }
  if (!('--issues' in seen)) throw new UsageError('인자 --issues <n,n,...>가 필요합니다.');
  if (!/^[1-9]\d{0,8}(,[1-9]\d{0,8})*$/.test(seen['--issues'])) throw new UsageError('--issues는 쉼표로 구분한 이슈 번호여야 합니다(예: 7,8).');
  const issues = seen['--issues'].split(',').map(Number);
  if (new Set(issues).size !== issues.length) throw new UsageError('--issues에 같은 번호가 두 번 있습니다.');
  const handoff = seen['--handoff'];
  if (handoff !== undefined && !/^h[1-9]\d*$/.test(handoff)) throw new UsageError('--handoff는 h<번호> 모양이어야 합니다(예: h1).');
  if (forceRestart && handoff === undefined) throw new UsageError('--force-restart는 --handoff와 함께만 쓸 수 있습니다.');
  return { issues, handoff, forceRestart };
}

// gh 배선. exec(bin, args)는 stdout 문자열을 돌려준다(테스트에서 스텁으로 바꾼다).
// HARNESS_GH_BIN(.mjs/.js면 node로 실행)은 테스트용 가짜 gh를 가리키는 환경 변수다.
export function defaultExec(env = process.env) {
  return (bin, args) => {
    const custom = env.HARNESS_GH_BIN;
    const script = custom && /\.(mjs|js)$/i.test(custom);
    const file = custom ? (script ? process.execPath : custom) : bin;
    return execFileSync(file, script ? [custom, ...args] : args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  };
}

export function makeGhDeps(repo, exec = defaultExec()) {
  const view = (n, fields = 'labels,comments,url') => JSON.parse(exec('gh', ['issue', 'view', String(n), '--repo', repo, '--json', fields]));
  const stateLabels = (n, data) => {
    const found = (data.labels ?? []).map((l) => l.name).filter((name) => STATES.includes(name));
    if (found.length > 1) throw new Error(`이슈 #${n}의 상태 라벨이 둘 이상입니다(${found.length}개).`);
    return found.length === 0 ? [NO_LABEL] : found;
  };
  const COLORS = { 진행중: '1D76DB', 리뷰대기: 'FBCA04', 허용됨: '0E8A16', 미완료: 'D93F0B', 막힘: 'B60205', 거부목록: '5319E7', 보류: 'C5DEF5', 반영됨: '006B75', 대기: 'BFD4F2', 취소: 'EDEDED' };
  return {
    // 상태 라벨 9개와 취소 라벨을 만든다(이미 있으면 --force로 색·설명만 갱신). 훅이 걸린 세션 밖에서, 세션을 띄우기 전에 부른다.
    async ensureLabels() {
      for (const name of ENSURED_LABELS) exec('gh', ['label', 'create', name, '--repo', repo, '--force', '--color', COLORS[name], '--description', STATES.includes(name) ? `하네스 상태: ${name}` : `하네스: ${name}`]);
    },
    async fetchIssue(n) {
      const data = view(n);
      const [state] = stateLabels(n, data);
      const report = [...(data.comments ?? [])].reverse().find((c) => typeof c.body === 'string' && c.body.startsWith(REPORT_HEAD));
      return { state, url: report?.url || data.url };
    },
    // 이 이슈에 올라온 결과 보고서 댓글 수(재작업 횟수를 세는 데 쓴다. 보고서 없이 끝난 하달은 세지 않는다).
    async countReports(n) {
      return (view(n).comments ?? []).filter((c) => typeof c.body === 'string' && c.body.startsWith(REPORT_HEAD)).length;
    },
    // 리뷰어 판정을 받은 보고서 수(재작업 한도에 센다, run-8). 판정 없이 끝난 보고서(워커 실패·하네스 결함)는 세지 않는다.
    async countReviewed(n) {
      return reviewedReports(view(n).comments ?? []);
    },
    // 이슈 본문의 `## 의존하는 이슈` 번호. 절이 없거나 읽을 수 없으면 빈 목록(대기 판단에만 쓴다).
    async fetchDependsOn(n) {
      return parseDependsOn(view(n, 'body').body) ?? [];
    },
    // 대기 판단용: 본문·라벨·댓글(수정 시각 포함). 합치기 스크립트와 같은 방식으로 읽어 같은 허용 판정 기준(collectAllowed)을 쓴다.
    fetchIssueData: makeFetchIssueData(exec, repo),
    async setState(n, state) {
      const data = view(n);
      const remove = (data.labels ?? []).map((l) => l.name).filter((name) => STATES.includes(name) && name !== state);
      exec('gh', ['issue', 'edit', String(n), '--repo', repo, '--add-label', state, ...remove.flatMap((l) => ['--remove-label', l])]);
    },
  };
}

function header({ handoff, issues, run, config }) {
  return [
    '# 이번 세션',
    `- 하달: ${handoff}`,
    `- 이슈: ${issues.map((n) => `#${n}`).join(', ')}`,
    `- 실행 폴더: ${run}`,
    `- 지정 저장소: ${config.designatedRepo}`,
    `- 이슈 클론: ${config.issuesClone}`,
    `- 대상 프로젝트: ${config.targetProject}`,
    `- 작업 폴더: ${config.worktrees}/${handoff}`,
  ].join('\n');
}

export async function main(argv, env = process.env, deps = {}) {
  const write = deps.write ?? ((line) => console.log(line));
  const fail = (reason) => { write(`오류: ${ONE_LINE(reason)}`); return 2; };
  try {
    const { issues, handoff: wanted, forceRestart } = parseArgs(argv);
    const run = fwd(env.HARNESS_RUN_DIR || process.cwd());
    const configFile = `${run}/harness.json`;
    if (!existsSync(configFile)) return fail(`실행 폴더에 harness.json이 없습니다: ${run}`);
    const config = JSON.parse(readFileSync(configFile, 'utf8'));
    const harnessDir = fwd(config.harnessDir);
    const operatorConfig = loadOperatorConfig(`${harnessDir}/operator/operator.config.json`, { run });
    const docs = loadModeDocs('work', harnessDir);

    let handoff = wanted;
    if (handoff !== undefined) {
      if (!existsSync(`${run}/handoffs/${handoff}`)) return fail(`이어받을 하달 ${handoff} 폴더가 없습니다.`);
      // 세션이 실패하면 그 하달의 이름 공간(다른 이슈의 허용된 작업 포함)을 통째로 지우고 다시 시작한다. 브랜치가 남아 있으면 사람이 명시해야만 한다.
      if (!forceRestart && (deps.handoffHasWork ?? handoffHasWork)({ handoff, memo: fwd(config.targetProject) })) {
        return fail(`하달 ${handoff}에 이슈 브랜치·통합 브랜치가 남아 있습니다. 다시 시작하다 실패하면 이 하달의 작업 폴더와 브랜치(허용된 이슈 포함)가 모두 지워집니다. 같은 하달의 재작업은 지원하지 않습니다. 그래도 다시 시작하려면 사람이 --force-restart를 붙여 직접 실행하세요.`);
      }
    } else {
      handoff = nextHandoff(run);
    }
    const launch = deps.launchSession ?? launchSession;
    const cleanup = deps.cleanupHandoff ?? cleanupHandoff;
    const gh = deps.fetchIssue && deps.setState ? deps : makeGhDeps(config.designatedRepo, defaultExec(env));
    const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (gh.ensureLabels) await gh.ensureLabels();
    // 새 하달(재작업 포함, 소유자 결정 2-3): 앞선 결과를 반영하지 않았어도 다시 하달할 수 있다.
    // - 결과 보고서가 이미 (rejectLimit + 1)개 이상이면 재작업 한도를 넘은 것이다: 막힘으로 두고 이번 세션에서 뺀다(코디네이터가 막힌 이슈로 모아 보고한다, 결정 2-1).
    // - 합치기 스크립트가 건너뛰는 상태(허용됨·보류·막힘)와 라벨 없음은 진행중으로 되돌려 이번 하달의 결과가 합쳐지고 다시 리뷰되게 한다. 반영됨·거부목록은 건드리지 않는다.
    // --handoff로 이어받을 때는 라벨 없음만 진행중으로 둔다(재시작은 재작업이 아니다).
    // - 결과 없음(보고서 없이 끝난 새 하달)이 연달아 1 + noReportRetries번이면 막힘이다(결정 2-4). 한도를 넘긴 채 다시 하달해도 막힘으로 둔다.
    // - 의존하는 이슈 가운데 이번 하달 밖의 것이 허용됐지만 아직 반영 안 됐으면 대기로 두고 뺀다. 새 하달의 브랜치는 main에서 시작하므로 그 변경이 없다.
    //   "허용됐다"는 라벨이 아니라 합치기 스크립트와 같은 허용 판정 기준(collectAllowed: 최신 판정이 허용이고 보고서 해시와 묶임)으로,
    //   "반영됐다"는 run-reflect와 같이 main의 병합 커밋(provenIssuesOnMain)으로 본다(이슈 #23: 허용된 이슈는 라벨이 리뷰대기로 남는다).
    //   대기는 결과 없음으로 세지 않는다.
    const fresh = wanted === undefined;
    const blocked = new Set();
    const rejectedOut = new Set(); // 재작업 한도를 넘어 거부목록으로 뺀 이슈
    const held = new Set();
    const before = new Map();
    const noReport = fresh ? readNoReport(run) : {};
    const states = new Map();
    const stateOf = async (n) => { if (!states.has(n)) states.set(n, (await gh.fetchIssue(n)).state); return states.get(n); };
    for (const n of issues) await stateOf(n);
    const waitsOn = new Set();
    if (fresh && gh.fetchDependsOn && gh.fetchIssueData) {
      const onMain = deps.provenOnMain ?? (() => provenIssuesOnMain((cwd, args) => execFileSync('git', ['-C', cwd, '-c', 'core.fsmonitor=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim(), { memo: fwd(config.targetProject) }));
      let proven = null;
      const pending = new Map();
      const awaitingLand = async (d) => {
        if (!pending.has(d)) {
          const allowed = collectAllowed([{ ...(await gh.fetchIssueData(d)), labels: [] }]).length > 0;
          if (allowed && proven === null) proven = onMain();
          pending.set(d, allowed && !proven.has(d));
        }
        return pending.get(d);
      };
      for (const n of issues) {
        for (const d of (await gh.fetchDependsOn(n)).filter((x) => !issues.includes(x))) {
          if (await awaitingLand(d)) { waitsOn.add(n); break; }
        }
      }
    }
    for (const n of issues) {
      const state = states.get(n);
      if (fresh) {
        const reports = gh.countReports ? await gh.countReports(n) : 0;
        // 재작업 한도(결정 2-1)는 리뷰어 판정을 받은 보고서로 센다. 판정 없는 보고서만 쌓여 끝없이 돌지 않게 전체 보고서 수에도 상한을 둔다(run-8).
        const reviewed = gh.countReviewed ? await gh.countReviewed(n) : reports;
        const cap = operatorConfig.rejectLimit + 1 + operatorConfig.noReportRetries;
        if (reviewed > operatorConfig.rejectLimit) { await gh.setState(n, LABEL.거부목록); blocked.add(n); rejectedOut.add(n); continue; }
        if (reports > cap || (noReport[n] ?? 0) > operatorConfig.noReportRetries) { await gh.setState(n, LABEL.막힘); blocked.add(n); continue; }
        if (waitsOn.has(n)) { await gh.setState(n, LABEL.대기); held.add(n); continue; }
        if (REDISPATCH_RESET.has(state)) await gh.setState(n, LABEL.진행중);
        before.set(n, reports);
      } else if (gh.ensureLabels && state === NO_LABEL) await gh.setState(n, LABEL.진행중);
    }
    const live = issues.filter((n) => !blocked.has(n) && !held.has(n));
    const prompt = `${header({ handoff, issues: live, run, config })}\n\n${docs}`;

    let ok = live.length === 0;
    const stopped = exitCode([], { stopped: true });
    for (let attempt = 0; attempt <= operatorConfig.sessionRestarts && !ok; attempt++) {
      // stop-operator의 중단 표시가 있으면 정리도 재시작도 하지 않고 조용히 끝낸다(출력 없음, 종료 코드 3).
      if (isStopped(run, handoff)) return stopped;
      if (attempt > 0) {
        cleanup({ handoff, run, memo: fwd(config.targetProject) });
        // 정리는 git을 돌려 오래 걸릴 수 있다. 그 사이 stop-operator가 표시를 썼다면 다시 띄우지 않는다.
        if (isStopped(run, handoff)) return stopped;
      }
      const r = await launch({ mode: 'work', handoff, run, harnessDir, issues: live, prompt, timeoutMs });
      if (r.spawnError !== undefined) {
        return fail(`세션을 시작할 수 없습니다: ${r.spawnError}. HARNESS_CLAUDE_BIN(기본 claude)은 실행 파일로 직접 실행할 수 있어야 합니다. claude.exe 또는 .js/.mjs 진입 파일 경로를 HARNESS_CLAUDE_BIN에 지정하세요(.cmd 래퍼는 지원하지 않습니다).`);
      }
      if (isStopped(run, handoff)) return stopped;
      ok = r.code === 0 && !r.timedOut;
    }

    // 결과 없음 횟수를 갱신한다(새 하달이고 세션이 끝까지 돈 경우만: 중단·시작 실패는 위에서 이미 돌아갔다).
    const exhausted = new Set();
    if (fresh && gh.countReports && live.length > 0) {
      for (const n of live) {
        if (await gh.countReports(n) > before.get(n)) delete noReport[n];
        else noReport[n] = (noReport[n] ?? 0) + 1;
        if ((noReport[n] ?? 0) > operatorConfig.noReportRetries) exhausted.add(n);
      }
      writeNoReport(run, noReport);
    }

    const rows = [];
    for (const n of issues) {
      if (!blocked.has(n) && !held.has(n) && !exhausted.has(n)) continue;
      if (exhausted.has(n)) await gh.setState(n, LABEL.막힘);
      const { url } = await gh.fetchIssue(n);
      rows.push({ number: n, state: held.has(n) ? LABEL.대기 : rejectedOut.has(n) ? LABEL.거부목록 : LABEL.막힘, url });
    }
    if (!ok) {
      for (const n of live) {
        if (exhausted.has(n)) continue;
        await gh.setState(n, LABEL.보류);
        const { url } = await gh.fetchIssue(n);
        rows.push({ number: n, state: LABEL.보류, url });
      }
    } else {
      for (const n of live) {
        if (exhausted.has(n)) continue;
        const { state, url } = await gh.fetchIssue(n);
        rows.push({ number: n, state, url });
      }
    }
    rows.sort((a, b) => issues.indexOf(a.number) - issues.indexOf(b.number));
    write(formatReport(rows));
    return exitCode(rows);
  } catch (e) {
    if (e instanceof UsageError) return fail(`인자 오류: ${e.message}`);
    if (e instanceof ConfigError) return fail(`설정 오류: ${e.message}`);
    return fail(e?.message ?? String(e));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // 분리 실행(background.mjs): Bash 도구의 10분 제한 안에서 기다리고, 길어지면 종료 코드 8과 대기 번호를 낸다.
  const { cliEntry } = await import('./background.mjs');
  process.exitCode = await cliEntry({ main, entry: fileURLToPath(import.meta.url), record: true });
}
