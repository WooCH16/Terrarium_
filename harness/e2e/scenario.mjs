// 시나리오 대본(e2e/scenarios/NN-*.md)을 읽고 "자동" 검사식을 산출물로 확인한다(T12, 이슈 #15).
// verify.mjs --scenario <N> [--dry]가 이 모듈을 쓴다.
//
// 검사식(대본 표의 산출물 칸, 백틱 안):
//   general                         일반 종단 검사(verify.mjs 기본 모드)가 통과
//   issues <op> <n>                 시작 시각 이후 지정 저장소에 생긴 이슈 수
//   label:<라벨>[,<라벨>] <op> <n>  그 이슈 중 라벨(쉼표면 그중 하나)이 붙은 수
//   body:<정규식>                   그 이슈 본문 중 하나라도 맞음
//   guard:<무엇> <op> <n>           코디네이터 guard.log(시작 시각 이후) 줄 수. 무엇: Agent(하위 에이전트 호출),
//                                   run-operator·run-research·run-reflect(그 스크립트 실행), read-records(기록 문서·이슈 목록 읽기)
//   advice:<거부|허용|all> <op> <n>  advice-log.jsonl(시작 시각 이후) 줄 수
//   <op>는 =, >=, <=
// 표 안의 | 문자는 \|로 쓴다(정규식의 "또는").
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SCENARIO_DIR = fileURLToPath(new URL('./scenarios/', import.meta.url));

export function scenarioFile(n, dir = SCENARIO_DIR) {
  const prefix = String(n).padStart(2, '0') + '-';
  const f = readdirSync(dir).find((x) => x.startsWith(prefix) && x.endsWith('.md'));
  if (!f) throw new Error(`시나리오 ${n}의 대본이 없습니다.`);
  return `${dir.replace(/[\\/]$/, '')}/${f}`;
}

export function parseScenario(text) {
  const title = /^# (.+)$/m.exec(text)?.[1]?.trim() ?? '';
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => /^\|\s*검사\s*\|\s*확인\s*\|\s*산출물\s*\|/.test(l));
  if (at === -1) throw new Error('통과 조건 표(| 검사 | 확인 | 산출물 |)가 없습니다.');
  const checks = [];
  for (const l of lines.slice(at + 2)) {
    if (!l.startsWith('|')) break;
    const cells = l.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim().replace(/\\\|/g, '|'));
    if (cells.length !== 3) throw new Error(`표의 줄 모양이 틀립니다: ${l}`);
    const [name, kind, product] = cells;
    if (!['자동', '직접'].includes(kind)) throw new Error(`확인 칸은 자동 또는 직접이어야 합니다: ${l}`);
    const exprs = kind === '자동' ? [...product.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()) : [];
    if (kind === '자동' && exprs.length === 0) throw new Error(`자동 검사에 검사식이 없습니다: ${l}`);
    for (const e of exprs) parseExpr(e);
    checks.push({ name, kind, product, exprs });
  }
  if (checks.length === 0) throw new Error('통과 조건 표가 비어 있습니다.');
  return { title, checks };
}

const CMP = { '=': (a, b) => a === b, '>=': (a, b) => a >= b, '<=': (a, b) => a <= b };
const GUARD_KINDS = ['Agent', 'run-operator', 'run-research', 'run-reflect', 'read-records'];
export function parseExpr(e) {
  if (e === 'general') return { kind: 'general' };
  let m = /^body:(.+)$/.exec(e);
  if (m) { new RegExp(m[1]); return { kind: 'body', re: m[1] }; }
  m = /^(issues|label:[^\s]+|guard:[^\s]+|advice:(?:거부|허용|all))\s*(=|>=|<=)\s*(\d+)$/.exec(e);
  if (!m) throw new Error(`알 수 없는 검사식입니다: ${e}`);
  const [, what, op, n] = m;
  if (what.startsWith('guard:') && !GUARD_KINDS.includes(what.slice(6))) throw new Error(`알 수 없는 guard 항목입니다: ${what}`);
  return { kind: 'count', what, op, n: Number(n) };
}

// ctx: { issues: [{ body, labels: [{ name }] }], guard: [guard.log 줄], advice: [advice-log 줄], general: () => boolean }
export function countOf(what, ctx) {
  if (what === 'issues') return ctx.issues.length;
  // label:<라벨>[,<라벨>...] — 쉼표로 여럿이면 그중 하나라도 붙은 이슈 수
  if (what.startsWith('label:')) { const names = what.slice(6).split(','); return ctx.issues.filter((i) => (i.labels ?? []).some((l) => names.includes(l.name))).length; }
  if (what.startsWith('advice:')) { const v = what.slice(7); return ctx.advice.filter((a) => v === 'all' || a.verdict === v).length; }
  const g = what.slice(6);
  const coord = ctx.guard.filter((l) => l.agent_type === null && l.allow);
  if (g === 'Agent') return coord.filter((l) => l.tool_name === 'Agent' || l.tool_name === 'Task').length;
  if (g === 'read-records') return coord.filter((l) => (l.tool_name === 'Read' && /[\\/]records[\\/]/.test(l.summary ?? '')) || (l.tool_name === 'Bash' && /\bgh issue (list|view)\b/.test(l.summary ?? ''))).length;
  return coord.filter((l) => l.tool_name === 'Bash' && (l.summary ?? '').includes(`${g}.mjs`)).length;
}

export function evaluate(expr, ctx) {
  const p = parseExpr(expr);
  if (p.kind === 'general') { const ok = ctx.general(); return { pass: ok, detail: ok ? '일반 검사 통과' : '일반 검사 실패' }; }
  if (p.kind === 'body') { const re = new RegExp(p.re, 'm'); const hit = ctx.issues.filter((i) => re.test(i.body ?? '')).map((i) => `#${i.number}`); return { pass: hit.length > 0, detail: hit.join(', ') || '맞는 본문 없음' }; }
  const c = countOf(p.what, ctx);
  return { pass: CMP[p.op](c, p.n), detail: `${p.what} = ${c}` };
}

export function readJsonLines(file, since) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)).filter((l) => new Date(l.time) >= since);
}
