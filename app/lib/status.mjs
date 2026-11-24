// 진행 표시(ADR 0010 결정 7, 소유자 결정 8-14): 읽기만 한다. GitHub에는 쓰지 않는다.
// 지정 저장소의 이슈와 상태 라벨, 실행 폴더의 handoffs/, advice-log.jsonl, guard.log를 읽는다.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';

export const STATE_LABELS = ['진행중', '리뷰대기', '미완료', '허용됨', '반영됨', '보류', '막힘', '대기', '거부목록', '취소'];

const readJsonLines = (file, max) => {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  return lines.slice(-max).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
};

export function readRunConfig(run) {
  const f = `${run}/harness.json`;
  if (!existsSync(f)) throw new Error(`실행 폴더가 아닙니다(harness.json 없음): ${run}`);
  return JSON.parse(readFileSync(f, 'utf8'));
}

// ghExec(args) → stdout 문자열. 이슈 읽기만 쓴다.
export async function readIssues(cfg, ghExec) {
  const list = JSON.parse(await ghExec(['issue', 'list', '--repo', cfg.designatedRepo, '--state', 'all', '--limit', '50', '--json', 'number,title,state,labels,updatedAt,url']));
  return list.map((i) => ({
    number: i.number, title: i.title, open: i.state === 'OPEN', url: i.url, updatedAt: i.updatedAt,
    label: (i.labels ?? []).map((l) => l.name).find((n) => STATE_LABELS.includes(n)) ?? '라벨 없음',
  })).sort((a, b) => b.number - a.number);
}

// pid가 살아 있는가(EPERM이면 남의 권한으로 살아 있음).
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

// 담당 팀(결정 8-29). 관제탑 카드 다섯 자리와 같은 값이다.
export const TEAMS = ['dev', 'design', 'tester', 'plan', 'sec'];
const isoOrNull = (v) => (typeof v === 'string' ? v : null);
const nums = (v) => (Array.isArray(v) ? v.filter((n) => Number.isSafeInteger(n) && n > 0) : []);

// 하달 기록(dispatch.json, run-operator·run-research가 쓴다). 없거나 깨졌으면 null(옛 하달).
function readDispatch(file) {
  let d;
  try { d = JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
  if (d === null || typeof d !== 'object' || Array.isArray(d)) return null;
  return {
    team: TEAMS.includes(d.team) ? d.team : null,
    mode: d.mode === 'research' ? 'research' : 'work',
    requested: nums(d.requested),
    live: d.live === null || d.live === undefined ? null : nums(d.live),
    excluded: Array.isArray(d.excluded) ? d.excluded.filter((x) => x && Number.isSafeInteger(x.issue)).map((x) => ({ issue: x.issue, reason: String(x.reason ?? '').slice(0, 20) })) : [],
    base: typeof d.base === 'string' && /^h[1-9]\d*$/.test(d.base) ? d.base : null,
    startedAt: isoOrNull(d.startedAt),
    endedAt: isoOrNull(d.endedAt),
    sessionOk: typeof d.sessionOk === 'boolean' ? d.sessionOk : null,
  };
}

// 워커 기록(workers.jsonl, run-worker가 쓴다). 파일이 없으면 null(모름, 0이 아님). 깨진 줄은 건너뛴다.
// 이슈마다 하나로 모은다: start가 있는 이슈만 워커다(모델을 못 골라 end만 있는 이슈는 워커가 아니다).
function readWorkers(file) {
  if (!existsSync(file)) return null;
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const byIssue = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || !Number.isSafeInteger(e.issue) || (e.event !== 'start' && e.event !== 'end')) continue;
    const w = byIssue.get(e.issue) ?? { issue: e.issue, started: false, done: false, model: null, attempts: null, status: null };
    if (e.event === 'start') { w.started = true; w.done = false; w.model = typeof e.model === 'string' ? e.model : w.model; }
    else {
      w.done = true;
      w.status = typeof e.status === 'string' ? e.status : null;
      w.attempts = Number.isSafeInteger(e.attempts) ? e.attempts : null;
      // 상자에는 짧은 이름(claude·gemini·muse)을 쓴다. 실제 모델 전체 이름은 따로 둔다(run-18 h25: 긴 이름에 잘려 "N회"가 사라졌다).
      if (typeof e.model === 'string') w.model = e.model;
      if (typeof e.actualModel === 'string') w.actualModel = e.actualModel;
    }
    byIssue.set(e.issue, w);
  }
  return [...byIssue.values()].filter((w) => w.started);
}

// skip: 다시 읽지 않을 하달 이름(관제탑 흐름이 이미 끝난 것으로 본 하달). 그 하달은 { name, running: false }만 둔다.
export function readHandoffs(run, alive = pidAlive, { skip } = {}) {
  const dir = `${run}/handoffs`;
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => /^h[1-9]\d*$/.test(n)).map((name) => {
    if (skip?.has(name)) return { name, running: false, skipped: true };
    const d = `${dir}/${name}`;
    let session = null;
    try { session = JSON.parse(readFileSync(`${d}/session.json`, 'utf8')); } catch { /* 없음 */ }
    const dispatch = readDispatch(`${d}/dispatch.json`);
    // 끝난 시각이 없고 적힌 프로세스(오퍼레이터, 드라이버, 러너) 중 하나라도 살아 있어야 도는 중이다.
    // 코디네이터가 하달 도중 Esc로 끊으면 하달 프로세스가 통째로 죽고 endedAt이 남지 않는다(run-18 h5). 그런 하달은 orphaned다.
    const recorded = [session?.pid, session?.driverPid, ...(Array.isArray(session?.pids) ? session.pids : [])].filter((p) => p !== undefined && p !== null);
    const open = Boolean(session) && !session.endedAt;
    const stopped = existsSync(`${d}/stopped.json`);
    const running = open && recorded.some((p) => alive(p));
    return {
      name,
      issues: session?.issues ?? dispatch?.live ?? [],
      mode: session?.mode ?? dispatch?.mode ?? null,
      team: dispatch?.team ?? null,
      dispatch,
      workers: readWorkers(`${d}/workers.jsonl`),
      startedAt: session?.startedAt ?? dispatch?.startedAt ?? null,
      endedAt: session?.endedAt ?? dispatch?.endedAt ?? null,
      stoppedAt: session?.stoppedAt ?? null,
      stopped,
      running,
      orphaned: open && !stopped && recorded.length > 0 && !running,
      modified: statSync(d).mtime.toISOString(),
    };
  }).sort((a, b) => Number(b.name.slice(1)) - Number(a.name.slice(1)));
}

export function readAdvice(run, max = 10) {
  return readJsonLines(`${run}/advice-log.jsonl`, max).map((a) => ({ time: a.time, adviceId: a.adviceId, verdict: a.verdict, sha: String(a.sha256 ?? '').slice(0, 8), attempt: a.attempt })).reverse();
}

export function readGuard(run, max = 200) {
  const rows = readJsonLines(`${run}/guard.log`, max);
  const denied = rows.filter((r) => r.allow === false).slice(-10).reverse().map((r) => ({ time: r.time, who: r.agent_type ?? 'coordinator', tool: r.tool_name, reason: String(r.reason ?? '').slice(0, 200) }));
  return { total: rows.length, denied };
}

export async function readStatus(run, ghExec, { alive } = {}) {
  const cfg = readRunConfig(run);
  let issues = [];
  let issuesError = null;
  try { issues = await readIssues(cfg, ghExec); } catch (e) { issuesError = String(e.message ?? e).slice(0, 300); }
  return { repo: cfg.designatedRepo, project: cfg.projectName ?? 'memo', issues, issuesError, handoffs: readHandoffs(run, alive), advice: readAdvice(run), guard: readGuard(run) };
}
