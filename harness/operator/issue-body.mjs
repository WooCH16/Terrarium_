// 이슈 본문 파싱 도우미(신뢰하지 않는 텍스트). run-operator와 merge-adapter가 같이 쓴다(둘 사이의 import 순환을 피하려고 따로 둔다).

// 코드 블록(``` / ~~~)과 인용(>) 줄을 뺀 줄 목록. 열린 채 끝난 코드 블록은 끝까지 뺀다.
export function plainLines(text) {
  const out = [];
  let fence = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence === null && m) { fence = m[1][0]; continue; }
    if (fence !== null) {
      if (m && m[1][0] === fence) fence = null;
      continue;
    }
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out;
}

// 항목: `#번호` 뒤에 짧은 괄호 메모를 붙여도 된다(예: `#9 (반영됨)`). 메모 안에는 #·괄호를 쓸 수 없고, 번호는 `#` 뒤의 숫자만 뽑는다.
const ITEM = '#[1-9]\\d{0,8}(?:[ \\t]*\\([^()#\\r\\n]{0,80}\\))?';
const NUMS = new RegExp(`^${ITEM}(?:(?:[ \\t]*,[ \\t]*|[ \\t]+)${ITEM})*$`);

// 담당 팀(결정 8-29): 관제탑 카드 다섯 자리와 같은 값. 이름은 관제탑 화면(js/app.js의 NAMES)과 같다.
export const TEAMS = ['dev', 'design', 'tester', 'plan', 'sec'];
export const TEAM_NAMES = { dev: '개발팀', design: '디자인', tester: '테스터', plan: '기획', sec: '보안팀' };

// `- 담당 팀: <값>` 한 줄. 값은 다섯 가운데 하나(대소문자 무시)이고 뒤에 설명("dev (개발팀)")을 붙여도 된다.
// 줄이 없거나, 둘 이상이거나, 모르는 값이면 null(팀 없음).
export function parseTeam(body) {
  const found = plainLines(body).flatMap((l) => {
    const m = /^\s*[-*]?\s*담당 팀\s*:\s*([A-Za-z]+)(?![A-Za-z0-9_-])/.exec(l);
    return m ? [m[1].toLowerCase()] : (/^\s*[-*]?\s*담당 팀\s*:/.test(l) ? [null] : []);
  });
  if (found.length !== 1) return null;
  return TEAMS.includes(found[0]) ? found[0] : null;
}

// `- 유형: <작업|조사>` 한 줄(route-issue가 적는다). 없거나 둘 이상이면 null.
export function parseKind(body) {
  const found = plainLines(body).flatMap((l) => {
    const m = /^\s*[-*]?\s*유형\s*:\s*(작업|조사)(?![\p{L}])/u.exec(l);
    return m ? [m[1]] : [];
  });
  return found.length === 1 ? found[0] : null;
}

// `## 의존하는 이슈` 절만 읽는다. 절이 없거나 둘 이상이거나 모양이 다르면 null(불명확하면 제외한다).
export function parseDependsOn(body) {
  const lines = plainLines(body);
  const heads = lines.flatMap((l, i) => (/^## 의존하는 이슈[ \t]*$/.test(l) ? [i] : []));
  if (heads.length !== 1) return null;
  const content = [];
  for (const line of lines.slice(heads[0] + 1)) {
    if (/^#{1,6}[ \t]/.test(line)) break;
    content.push(line.trim());
  }
  const text = content.filter(Boolean).join(' ').trim();
  if (text === '없음') return [];
  if (!NUMS.test(text)) return null;
  return [...new Set([...text.matchAll(/#([1-9]\d{0,8})/g)].map((m) => Number(m[1])))];
}
