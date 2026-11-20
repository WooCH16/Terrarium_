// Jev 리뷰어의 판단과 결정(이슈 #44). "판단은 Jev, 결정은 코드": 기계적으로 볼 수 있는 기준은 코드가 보고,
// 글을 읽어야 하는 판단만 Jev에 Noul로 묻는다. 허용/거부는 이 모듈의 결정 함수가 정한다.
//
// 결과 보고서 판정:
//   코드: 보고서 머리줄, `커밋 해시:` 한 줄, 네 칸(기준별 충족 여부, 근거 위치, 변경 요약, 남은 문제), 이슈의 완료 기준 표,
//         근거 위치에 적힌 파일 경로가 보고서 커밋에 있는지.
//   Jev: 완료 기준 한 줄마다 두 질문 — 보고서가 그 기준을 충족으로 적었는가, 그 기준의 근거 위치를 구체적으로 적었는가.
//   결정: 코드 검사에 문제가 있으면 Jev를 부르지 않고 거부. 모든 질문이 예(≥ yes)이면 허용. 하나라도 아니오나 애매(no < p < yes)면 거부.
// 조언 판정(ADR 0006의 허용 기준):
//   코드: 작업 단위마다 목표, 완료 기준 표(기준 / 확인 방법), 먼저 끝나야 할 것, 전제·위험.
//   Jev: 기준 줄마다 두 질문 — 충족/미충족을 가릴 수 있는 문장인가, 확인 방법이 실행할 수 있는 시험·명령이거나 사람이 직접 보는 확인인가.
//   결정: 위와 같다.
// 질문 문구의 기준은 harness/reviewer/AGENT.md의 `## Jev 질문` 절 하나다(리뷰어 규칙 문서). 이 모듈은 그 절을 읽어 질문을 만든다.
import { readFileSync } from 'node:fs';
import { readNoul } from './jev.mjs';
import { REPORT_HEAD, REPORT_SECTIONS, REPORT_TABLE } from './protocol.mjs';

export { REPORT_SECTIONS };
export const UNIT_SECTIONS = ['목표', '완료 기준', '먼저 끝나야 할 것', '전제·위험'];

export const REVIEWER_DOC = new URL('../reviewer/AGENT.md', import.meta.url);
export const QUESTION_NAMES = ['met', 'evidence', 'decidable', 'checkable'];

// `## Jev 질문` 절의 `### <이름>`마다 `- 묻는 말:`, `- 예:`, `- 아니오:` 줄을 읽는다.
// 하나라도 없으면 오류다(빈 질문으로 판정하지 않는다).
export function parseQuestions(text) {
  const lines = String(text).split(/\r?\n/);
  const start = lines.findIndex((l) => /^## Jev 질문\s*$/.test(l));
  if (start < 0) throw new Error('리뷰어 문서에 `## Jev 질문` 절이 없습니다.');
  const out = {};
  let cur = null;
  for (const l of lines.slice(start + 1)) {
    if (/^## /.test(l)) break;
    const h = /^### (\S+)\s*$/.exec(l);
    if (h) { cur = out[h[1]] = {}; continue; }
    const m = /^- (묻는 말|예|아니오): (.+)$/.exec(l);
    if (cur && m) cur[{ '묻는 말': 'ask', 예: 'yes', 아니오: 'no' }[m[1]]] = m[2].trim();
  }
  for (const n of QUESTION_NAMES) {
    const q = out[n];
    if (!q?.ask || !q.yes || !q.no) throw new Error(`리뷰어 문서의 질문 ${n}에 묻는 말·예·아니오 줄이 모두 있어야 합니다.`);
  }
  return out;
}

let loaded = null;
const questionsDoc = () => (loaded ??= parseQuestions(readFileSync(REVIEWER_DOC, 'utf8')));
// 자리표시 {기준}·{확인 방법} 바꾸기. 값에 $가 있어도 그대로 들어가게 split/join을 쓴다.
const fill = (s, vars) => Object.entries(vars).reduce((acc, [k, v]) => acc.split(`{${k}}`).join(String(v)), s);
function question(name, vars) {
  const q = questionsDoc()[name];
  return { type: 'noul', instructions: fill(q.ask, vars), criteria: { true: fill(q.yes, vars), false: fill(q.no, vars) } };
}

const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const isSep = (line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);

// 마크다운 표: 머리 줄의 칸 이름이 header와 같은 첫 표의 본문 줄들. 없으면 null.
export function readTable(text, header) {
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!lines[i].includes('|')) continue;
    const head = cells(lines[i]);
    if (header.some((h, k) => head[k] !== h) || !isSep(lines[i + 1])) continue;
    const rows = [];
    for (let j = i + 2; j < lines.length && lines[j].includes('|') && lines[j].trim() !== ''; j++) rows.push(cells(lines[j]));
    return rows;
  }
  return null;
}

// 이슈 본문의 `## 완료 기준` 아래 `| 기준 | 확인 방법 |` 표의 기준 문장들.
export function issueCriteria(body) {
  const m = /^##[ \t]+완료 기준[ \t]*$/m.exec(String(body ?? ''));
  if (!m) return null;
  const rest = String(body).slice(m.index + m[0].length);
  const end = rest.search(/^##[ \t]/m);
  const rows = readTable(end === -1 ? rest : rest.slice(0, end), ['기준', '확인 방법']);
  if (!rows) return null;
  return rows.map((r) => r[0]).filter((c) => c !== '');
}

// 근거 위치 칸에서 파일 경로로 보이는 것(백틱 안, 경로 구분자나 확장자가 있음)을 뽑는다. `:줄` 꼬리는 뗀다.
export function evidencePaths(report) {
  const rows = readTable(report, REPORT_TABLE) ?? [];
  const out = new Set();
  for (const r of rows) {
    for (const m of String(r[2] ?? '').matchAll(/`([^`\s]+)`/g)) {
      const p = m[1].replace(/:\d+(?:[-:]\d+)?$/, '');
      if (/^[\w.\-/]+$/.test(p) && !p.startsWith('/') && !p.includes('..') && (/\//.test(p) || /\.[A-Za-z0-9]{1,8}$/.test(p))) out.add(p);
    }
  }
  return [...out];
}

// 보고서의 코드 검사. fileExists(path): 보고서 커밋에 그 파일이 있는가(모르면 null을 돌려 검사에서 뺀다).
export function reportProblems({ report, hash, criteria, fileExists }) {
  const problems = [];
  if (!String(report).split(/\r?\n/, 1)[0].startsWith(REPORT_HEAD)) problems.push(`보고서 첫 줄이 \`${REPORT_HEAD}\`가 아닙니다.`);
  if (!hash) problems.push('`커밋 해시: <40자리 소문자 16진수>` 줄이 정확히 한 줄이 아닙니다.');
  for (const s of REPORT_SECTIONS) if (!String(report).includes(s)) problems.push(`보고서에 \`${s}\` 칸이 없습니다.`);
  if (!criteria || criteria.length === 0) problems.push('이슈 본문에서 `## 완료 기준`의 `| 기준 | 확인 방법 |` 표를 읽지 못했습니다.');
  // 보고서 표는 이슈의 기준을 그대로 옮긴다(AGENT.md 결과 보고서 형식). 바꿔 쓴 기준은 Jev가 이슈 기준과 맞추지 못해 판단이 흔들린다(실제 API 시험, 이슈 #44).
  const rows = readTable(report, REPORT_TABLE);
  if (!rows) problems.push('보고서에 `| 기준 | 충족 | 근거 위치 |` 표가 없습니다.');
  else if (criteria) {
    const norm = (t) => String(t).replace(/`/g, '').replace(/\s+/g, ' ').trim();
    const listed = new Set(rows.map((r) => norm(r[0])));
    for (const c of criteria) if (!listed.has(norm(c))) problems.push(`보고서 표에 이슈의 기준이 그대로 없습니다: ${c}`);
  }
  if (fileExists) {
    for (const p of evidencePaths(report)) if (fileExists(p) === false) problems.push(`근거 위치의 파일 \`${p}\`가 보고서 커밋에 없습니다.`);
  }
  return problems;
}

// 결과 보고서 질문. 기준마다 met_<i>, evidence_<i>. 상태는 보고서 하나다.
export function reportQuestions(criteria) {
  const q = {};
  criteria.forEach((c, i) => {
    q[`met_${i + 1}`] = question('met', { 기준: c });
    q[`evidence_${i + 1}`] = question('evidence', { 기준: c });
  });
  return q;
}

// 제안문의 작업 단위(`## 작업 단위 ...`)와 각 단위의 칸·완료 기준 표.
export function proposalUnits(text) {
  const parts = String(text ?? '').split(/^(?=##[ \t]+작업 단위)/m).slice(1);
  return parts.map((p) => {
    const title = p.split(/\r?\n/, 1)[0].replace(/^##[ \t]+/, '').trim();
    const has = (s) => new RegExp(`^###[ \\t]+${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*$`, 'm').test(p);
    const rows = readTable(p, ['기준', '확인 방법']);
    return { title, missing: UNIT_SECTIONS.filter((s) => !has(s)), rows: rows ?? null };
  });
}

export function proposalProblems(text) {
  const units = proposalUnits(text);
  if (units.length === 0) return { units, problems: ['제안문에 `## 작업 단위` 절이 없습니다.'] };
  const problems = [];
  for (const u of units) {
    for (const s of u.missing) problems.push(`${u.title}: \`### ${s}\` 칸이 없습니다.`);
    if (!u.rows || u.rows.length === 0) problems.push(`${u.title}: 완료 기준 표(\`| 기준 | 확인 방법 |\`)가 없거나 비어 있습니다.`);
    else u.rows.forEach((r, i) => { if (!r[0] || !r[1]) problems.push(`${u.title}: 완료 기준 ${i + 1}번째 줄의 기준이나 확인 방법이 비어 있습니다.`); });
  }
  return { units, problems };
}

// 조언 질문. 기준 줄마다 decidable_<u>_<i>, checkable_<u>_<i>. 질문마다 그 줄의 기준·확인 방법을 직접 적는다.
export function proposalQuestions(units) {
  const q = {};
  units.forEach((u, ui) => (u.rows ?? []).forEach((r, i) => {
    const id = `${ui + 1}_${i + 1}`;
    q[`decidable_${id}`] = question('decidable', { 기준: r[0] });
    q[`checkable_${id}`] = question('checkable', { '확인 방법': r[1] });
  }));
  return q;
}

// 질문 이름 → 사람이 읽는 설명(거부 이유에 쓴다).
export function describeQuestion(name, { criteria, units }) {
  let m = /^(met|evidence)_(\d+)$/.exec(name);
  if (m && criteria) return `${m[1] === 'met' ? '충족으로 적혔는가' : '근거 위치가 구체적인가'} — 기준 ${m[2]}: ${criteria[Number(m[2]) - 1]}`;
  m = /^(decidable|checkable)_(\d+)_(\d+)$/.exec(name);
  if (m && units) {
    const u = units[Number(m[2]) - 1];
    const r = u?.rows?.[Number(m[3]) - 1] ?? [];
    return m[1] === 'decidable' ? `충족을 가릴 수 있는 기준인가 — ${u?.title}: ${r[0]}` : `확인 방법을 실행할 수 있는가 — ${u?.title}: ${r[1]}`;
  }
  return name;
}

// 결정: 모든 Noul이 예면 허용, 아니면 거부와 이유(아니오·애매인 질문과 확률).
export function decide(answers, questions, jev, ctx = {}) {
  const lines = [];
  const rows = [];
  for (const name of Object.keys(questions)) {
    const p = answers[name].noul;
    const r = readNoul(p, jev);
    rows.push({ name, p, read: r });
    if (r !== '예') lines.push(`- ${r === '애매' ? '판단이 서지 않음' : '아니오'} (${p.toFixed(2)}): ${describeQuestion(name, ctx)}`);
  }
  return { verdict: lines.length === 0 ? '허용' : '거부', reasons: lines, rows };
}

// 판정 댓글·기록에 붙이는 확률 표.
export function probabilityTable(rows, ctx) {
  return ['| 질문 | 확률 | 읽기 |', '|---|---|---|', ...rows.map((r) => `| ${describeQuestion(r.name, ctx).replace(/\|/g, '\\|')} | ${r.p.toFixed(2)} | ${r.read} |`)];
}
