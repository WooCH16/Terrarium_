// 어드바이저 대역의 보조 코드: 고정 제안문을 고르고, 제안문 양식을 검사하고, 어드바이저 목록에서 맞는 어드바이저를 찾는다.
// 양식은 docs/01-overview.md 3.5절이다: 작업 단위마다 목표 / 완료 기준(기준·확인 방법) / 먼저 끝나야 할 것 / 전제·위험.
// 그 항목 구성은 설계를 정리하는 쪽의 해석이고, 어드바이저 설명 양식은 아직 미결이다(10절).
//
// 사용법: node advisor-stub.mjs <정상|부족|거부>   → 해당 제안문을 stdout에 낸다
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const MARK = '[대역] 어드바이저 대역이 쓴 제안문이다. 실제 어드바이저의 조언이 아니다.';
export const MODES = { 정상: 'normal', 부족: 'insufficient', 거부: 'rejectable' };
export const UNIT_FIELDS = ['목표', '완료 기준', '먼저 끝나야 할 것', '전제·위험'];
// 확인 방법 칸이 이 값이면 확인할 수 없는 기준이다.
const NO_METHOD = /^(없음|알아서.*|미정|-|—)?$/;

export function proposal(mode) {
  const file = MODES[mode];
  if (!file) throw new Error(`알 수 없는 방식입니다: ${mode} (가능: ${Object.keys(MODES).join(', ')})`);
  return readFileSync(join(here, 'proposals', `${file}.md`), 'utf8');
}

// 작업 단위(`## 작업 단위 ...`)로 나눠 단위마다 항목(`### ...`) 본문을 돌려준다.
export function parseProposal(text) {
  const units = [];
  for (const block of text.replace(/\r\n/g, '\n').split(/^## /m).slice(1)) {
    const [title, ...rest] = block.split('\n');
    if (!title.startsWith('작업 단위')) continue;
    const fields = {};
    for (const part of rest.join('\n').split(/^### /m).slice(1)) {
      const [name, ...body] = part.split('\n');
      fields[name.trim()] = body.join('\n').trim();
    }
    units.push({ title: title.trim(), fields });
  }
  return units;
}

// 양식 검사: 빠졌거나 비어 있는 항목, 기준 표가 없는 단위를 돌려준다. 문제가 없으면 빈 배열.
export function missingFields(text) {
  const problems = [];
  const units = parseProposal(text);
  if (units.length === 0) problems.push('작업 단위가 없다');
  for (const u of units) {
    for (const f of UNIT_FIELDS) {
      if (!(f in u.fields) || u.fields[f] === '') problems.push(`${u.title}: ${f} 없음`);
    }
    if (u.fields['완료 기준'] && criteriaRows(u.fields['완료 기준']).length === 0) problems.push(`${u.title}: 완료 기준 표에 행이 없다`);
  }
  return problems;
}

function criteriaRows(table) {
  return table.split('\n').filter((l) => l.startsWith('|')).slice(2)
    .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));
}

// 확인할 수 없는 기준(확인 방법이 없거나 "없음", "알아서 확인한다")을 돌려준다. 리뷰어가 거부할 만한 제안문을 가려낸다.
export function unverifiableCriteria(text) {
  const out = [];
  for (const u of parseProposal(text)) {
    for (const [criterion, method] of criteriaRows(u.fields['완료 기준'] ?? '')) {
      if (NO_METHOD.test(method ?? '')) out.push(`${u.title}: "${criterion}"의 확인 방법이 없다`);
    }
  }
  return out;
}

// 어드바이저 목록(markdown 표)을 읽는다. 머리글과 구분선 아래의 행만 센다.
export function parseAdvisors(text) {
  return text.replace(/\r\n/g, '\n').split('\n').filter((l) => l.startsWith('|')).slice(2).map((l) => {
    const [name, area, scope, operator] = l.split('|').slice(1, -1).map((c) => c.trim());
    return { name, area, scope, operator };
  });
}

// 영역 이름이 "아는 영역"에 들어 있는 어드바이저들. 없으면 빈 배열(= 맞는 어드바이저 없음, 즉시 보고).
export function matchAdvisors(listText, area) {
  const key = String(area).trim().toLowerCase();
  if (key === '') return [];
  return parseAdvisors(listText).filter((a) => a.area.toLowerCase().split(/[,\s/]+/).includes(key));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(proposal(process.argv[2] ?? '정상'));
  } catch (e) {
    console.error(`오류: ${e.message}`);
    process.exitCode = 2;
  }
}
