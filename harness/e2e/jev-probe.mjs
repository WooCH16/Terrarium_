// Jev 실제 API 시험(이슈 #44, ADR 0008). 하네스의 질문을 그대로 써서 가상의 보고서·제안문·초안에 묻고 기대값과 비교한다.
//   node harness/e2e/jev-probe.mjs [--out <결과 JSON 파일>]
// - 실제로 TypeSafe API를 부르므로 키(TYPESAFE_API_KEY)와 소유자의 허락이 필요하다. 보내는 내용은 이 파일의 가상 사례와
//   어드바이저 대역 제안문(harness/stubs/proposals)뿐이다. 키는 출력하지 않는다.
// - --out을 주면 사례마다의 요청 전문과 응답을 남긴다(같은 요청을 다시 돌려 비교할 수 있게).
// - 종료 코드: 0 모든 기대값과 맞음, 1 어긋난 사례가 있음, 2 키 없음 등, 6 API 호출 실패.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { askJev, findJevKey, readNoul, JevError, KEY_NAME } from '../operator/jev.mjs';
import { reportQuestions, proposalProblems, proposalQuestions, reportProblems, decide } from '../operator/jev-review.mjs';
import { routingQuestions, decideRoute } from '../operator/route-issue.mjs';
import { publicOkOf } from '../operator/runners.mjs';
import { loadOperatorConfig } from '../operator/config.mjs';

const harnessDir = dirname(dirname(fileURLToPath(import.meta.url))).replace(/\\/g, '/');
const cfg = loadOperatorConfig(`${harnessDir}/operator/operator.config.json`);
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx === -1 ? null : process.argv[outIdx + 1];

const criteria = ['`memo list --sort title`이 제목의 가나다순으로 출력한다', 'README에 `--sort` 사용 예시가 있다'];
const row = (c, met, ev) => `| ${c} | ${met} | ${ev} |`;
const report = (rows) => ['## 결과 보고서', `커밋 해시: ${'a'.repeat(40)}`, '', '### 기준별 충족 여부', '| 기준 | 충족 | 근거 위치 |', '|---|---|---|', ...rows, '', '### 변경 요약', '`cli.mjs`에 --sort 옵션을 더했다.', '', '### 남은 문제', '없음'].join('\n');
// 기대값: 질문별 읽기(예/아니오)와 판정. 코드 검사에서 걸리는 사례는 Jev에 보내지 않는다.
const REPORTS = {
  good: [[row(criteria[0], '충족', '`test/sort.test.mjs`의 "sort by title" 시험, `node --test` 통과'), row(criteria[1], '충족', '`README.md:12-20`')], { met_1: '예', evidence_1: '예', met_2: '예', evidence_2: '예' }, '허용'],
  cmdEvidence: [[row(criteria[0], '충족', '`node --test` 실행, 12개 통과'), row(criteria[1], '충족', '`README.md`의 "정렬" 절')], { evidence_1: '예', evidence_2: '예' }, '허용'],
  unmet: [[row(criteria[0], '충족', '`test/sort.test.mjs`의 "sort by title" 시험'), row(criteria[1], '미충족', 'README를 아직 고치지 않음')], { met_1: '예', met_2: '아니오' }, '거부'],
  partial: [[row(criteria[0], '부분 충족: 영어 제목만 정렬됨', '`test/sort.test.mjs`'), row(criteria[1], '충족', '`README.md:12`')], { met_1: '아니오' }, '거부'],
  vague: [[row(criteria[0], '충족', '확인함'), row(criteria[1], '충족', '`README.md:12`')], { evidence_1: '아니오', evidence_2: '예' }, '거부'],
  later: [[row(criteria[0], '충족', '다음 하달에서 확인 예정'), row(criteria[1], '충족', '`README.md:12`')], { evidence_1: '아니오' }, '거부'],
};
const PROPOSALS = { normal: '허용', rejectable: '거부' };
// 라우팅 초안: [본문, 기대 유형, 기대 워커 모델(조사는 참고만)]. 소유자 결정 8-9: 간단한 코드는 muse, 범위가 분명한 여러 파일 기능은 gemini,
// 여러 모듈을 이해해야 하거나 설정·권한·보안 변경은 claude. muse가 보기에 들어가도록 초안에 `공개 가능: 예`를 둔다.
const PUB = '\n- 공개 가능: 예\n';
const DRAFTS = {
  fixBug: [`## 목표\n\`memo add\`가 빈 제목을 받으면 오류를 내게 고친다. 바꿀 파일은 \`cli.mjs\` 하나다.\n${PUB}`, '작업', 'muse', '쉬움'],
  addTest: [`## 목표\n\`store.mjs\`의 \`remove\` 함수에 없는 id를 넣었을 때의 시험을 \`test/store.test.mjs\`에 하나 더한다.\n${PUB}`, '작업', 'muse', '쉬움'],
  docs: [`## 목표\nREADME에 \`memo list --sort\` 사용 예시를 더한다.\n${PUB}`, '작업', 'muse', '쉬움'],
  feature: [`## 목표\nmemo에 태그 기능을 더한다. \`memo add --tag\`로 태그를 붙이고 \`memo list --tag\`로 거른다. 저장 형식(\`store.mjs\`), 명령줄(\`cli.mjs\`), 시험, README를 함께 고친다.\n${PUB}`, '작업', 'gemini', null],
  security: [`## 목표\n\`MEMO_FILE\` 환경 변수로 받은 저장 경로가 사용자 홈 밖이나 다른 사용자의 파일을 가리키면 거부하게 하고, 저장 파일 권한을 본인만 읽고 쓰게 바꾼다.\n${PUB}`, '작업', 'claude', '어려움'],
  refactor: [`## 목표\n저장 계층을 갈아 끼울 수 있게 \`store.mjs\`, \`cli.mjs\`, 시험 전체의 구조를 바꾼다. JSON 파일 저장과 메모리 저장 두 구현이 같은 인터페이스를 따르게 한다.\n${PUB}`, '작업', 'claude', '어려움'],
  research: [`## 목표\nmemo 저장 형식을 JSON에서 SQLite로 바꿀 가치가 있는지 조사해 추천을 보고한다. 코드는 바꾸지 않는다.\n${PUB}`, '조사', null, null],
  howTo: [`## 목표\nmemo의 저장 파일이 커지면 어떻게 하는 게 좋을지 알려 달라.\n${PUB}`, '조사', null, null],
};

const found = findJevKey({ env: process.env, harnessDir });
if (!found) { console.error(`오류: ${KEY_NAME}가 없습니다.`); process.exit(2); }
const log = [];
const lines = [];
let tokens = 0;
let misses = 0;
const mark = (ok) => { if (!ok) misses++; return ok ? '맞음' : '어긋남'; };
async function ask(label, state, questions) {
  const res = await askJev({ jev: cfg.jev, key: found.key, state, questions });
  tokens += res.usage?.input_tokens ?? 0;
  log.push({ label, request: { model: cfg.jev.model, state, questions }, response: res });
  return res;
}

try {
  for (const [name, [rows, expect, verdict]] of Object.entries(REPORTS)) {
    const text = report(rows);
    if (reportProblems({ report: text, hash: 'a'.repeat(40), criteria, fileExists: null }).length) { lines.push(`어긋남 report:${name} 코드 검사에서 걸림(사례가 잘못됨)`); misses++; continue; }
    const q = reportQuestions(criteria);
    const res = await ask(`report:${name}`, { report: text }, q);
    for (const [qn, want] of Object.entries(expect)) {
      const p = res.answers[qn].noul;
      lines.push(`${mark(readNoul(p, cfg.jev) === want)} report:${name} ${qn} ${p.toFixed(2)} (기대 ${want})`);
    }
    const d = decide(res.answers, q, cfg.jev, { criteria });
    lines.push(`${mark(d.verdict === verdict)} report:${name} 판정 ${d.verdict} (기대 ${verdict})`);
  }
  for (const [name, verdict] of Object.entries(PROPOSALS)) {
    const text = readFileSync(`${harnessDir}/stubs/proposals/${name}.md`, 'utf8');
    const { units, problems } = proposalProblems(text);
    if (problems.length) { lines.push(`어긋남 proposal:${name} 코드 검사에서 걸림`); misses++; continue; }
    const q = proposalQuestions(units);
    const res = await ask(`proposal:${name}`, { proposal: text }, q);
    const d = decide(res.answers, q, cfg.jev, { units });
    lines.push(`${mark(d.verdict === verdict)} proposal:${name} 판정 ${d.verdict} (기대 ${verdict}; 최저 ${Math.min(...d.rows.map((r) => r.p)).toFixed(2)}, 최고 ${Math.max(...d.rows.map((r) => r.p)).toFixed(2)})`);
  }
  for (const [name, [text, type, model, difficulty]] of Object.entries(DRAFTS)) {
    // route-issue.mjs와 같은 보기: 설명이 있는 모델 가운데, 공개 제한 모델은 공개 가능 표시가 있을 때만.
    const models = cfg.allowedModels.filter((m) => m in cfg.jev.routing.workerModels && (cfg.runners[m]?.publicOnly !== true || publicOkOf(text)));
    const res = await ask(`route:${name}`, { draft: text }, routingQuestions(cfg, models));
    const d = decideRoute(res.answers, cfg.jev);
    lines.push(`${mark(d.type === type)} route:${name} 유형 ${d.type} ${d.typeP.toFixed(2)} (기대 ${type})`);
    lines.push(`${model ? mark(d.model === model) : '참고'} route:${name} 워커 모델 ${d.model} ${d.modelP.toFixed(2)} (기대 ${model ?? '없음: 조사'})`);
    lines.push(`${difficulty ? mark(d.difficulty === difficulty) : '참고'} route:${name} 난이도 ${d.difficulty}(${d.difficultyWhy}) (기대 ${difficulty ?? '경계·조사'})`);
  }
} catch (e) {
  if (e instanceof JevError) { console.error(`오류: ${e.message}`); process.exit(6); }
  throw e;
}

for (const l of lines) console.log(l);
console.log(`\n모델 ${log[0]?.response?.model}, 요청 ${log.length}개, 입력 토큰 ${tokens}, 어긋남 ${misses}개`);
if (OUT) writeFileSync(OUT, JSON.stringify({ time: new Date().toISOString(), model: log[0]?.response?.model, tokens, lines, log }, null, 1));
process.exit(misses ? 1 : 0);
