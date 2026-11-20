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

export function readHandoffs(run) {
  const dir = `${run}/handoffs`;
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => /^h[1-9]\d*$/.test(n)).map((name) => {
    const d = `${dir}/${name}`;
    let session = null;
    try { session = JSON.parse(readFileSync(`${d}/session.json`, 'utf8')); } catch { /* 없음 */ }
    return {
      name,
      issues: session?.issues ?? [],
      mode: session?.mode ?? null,
      startedAt: session?.startedAt ?? null,
      endedAt: session?.endedAt ?? null,
      stoppedAt: session?.stoppedAt ?? null,
      stopped: existsSync(`${d}/stopped.json`),
      // 끝난 시각이 없고 오퍼레이터 pid나 러너 pid가 있으면 도는 중으로 본다.
      running: !session?.endedAt && ((Array.isArray(session?.pids) && session.pids.length > 0) || (session?.pid !== undefined && session?.pid !== null)),
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

export async function readStatus(run, ghExec) {
  const cfg = readRunConfig(run);
  let issues = [];
  let issuesError = null;
  try { issues = await readIssues(cfg, ghExec); } catch (e) { issuesError = String(e.message ?? e).slice(0, 300); }
  return { repo: cfg.designatedRepo, project: cfg.projectName ?? 'memo', issues, issuesError, handoffs: readHandoffs(run), advice: readAdvice(run), guard: readGuard(run) };
}
