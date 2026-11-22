// 이슈 #18·#42(D2): 진짜 어드바이저 정의. 모델은 부르지 않는다(실제 한 바퀴는 #43).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decide } from '../policy.mjs';
import { proposalProblems } from '../operator/jev-review.mjs';

const text = readFileSync(fileURLToPath(new URL('../advisor/AGENT.md', import.meta.url)), 'utf8');
const config = { harnessDir: 'C:/h', runDir: 'C:/run', issuesClone: 'C:/run/issues', targetProject: 'C:/run/memo', designatedRepo: 'o/r' };
const fill = (t) => t.replaceAll('{{HARNESS}}', config.harnessDir).replaceAll('{{RUN}}', config.runDir).replaceAll('{{MEMO}}', config.targetProject).replaceAll('{{PROJECT}}', 'memo');

test('D2: 진짜 어드바이저는 제안문을 쓰고 판정 명령을 부를 도구를 갖고, 코디네이터와 같은 급 모델을 쓴다', () => {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)[1];
  assert.match(front, /^name: advisor$/m);
  assert.match(front, /^tools: Read, Grep, Glob, Write, Bash$/m);
  assert.match(front, /^model: inherit$/m);
  assert.doesNotMatch(text, /대역/, '대역 문구가 남아 있지 않다');
});

test('D2: 정의에 적힌 판정 명령과 쓰기 경로는 훅이 advisor에게 허용하는 모양이다(조언 id를 채우면)', () => {
  const filled = fill(text).replaceAll('<조언 id>', 'adv-sort-1');
  const cmd = /`(node \S+run-reviewer\.mjs --advice \S+ --advice-id \S+)`/.exec(filled)[1];
  const as = (tool_name, tool_input) => decide({ tool_name, tool_input, cwd: config.runDir, agent_type: 'advisor' }, config, { visibility: () => 'PRIVATE', readFile: () => { throw new Error('x'); } });
  assert.equal(as('Bash', { command: cmd }).allow, true, cmd);
  assert.equal(as('Write', { file_path: 'C:/run/reviewer-inbox/adv-sort-1.md', content: 'x' }).allow, true);
  assert.equal(as('Write', { file_path: 'C:/run/memo/a.mjs', content: 'x' }).allow, false, '대상 프로젝트에는 쓸 수 없다');
});

test('D2: 정의의 제안문 양식을 채우면 코드 검사(proposalProblems)를 통과한다', () => {
  const block = /```markdown\r?\n([\s\S]*?)```/.exec(text)[1].split(/^## 작업 단위 2/m)[0]
    .replace('<관찰할 수 있는 결과 하나>', '`list --sort title`이 제목순으로 출력한다')
    .replace('<그 줄만으로 실행할 수 있는 명령이나 시험 이름>', '`node --test test/sort.test.mjs`');
  assert.deepEqual(proposalProblems(block).problems, []);
});

test('패널(결정 8-24): 어드바이저는 패널 폴더에 초안을 쓰고 서로 읽을 수 있지만, 패널 초안으로는 판정 명령을 실행할 수 없다', () => {
  const as = (tool_name, tool_input) => decide({ tool_name, tool_input, cwd: config.runDir, agent_type: 'advisor' }, config, { visibility: () => 'PRIVATE', readFile: () => { throw new Error('x'); } });
  const panel = 'C:/run/reviewer-inbox/panel/adv-sort-1';
  for (const seat of ['a', 'b', 'c']) {
    assert.equal(as('Write', { file_path: `${panel}/${seat}.md`, content: 'x' }).allow, true, seat);
    assert.equal(as('Read', { file_path: `${panel}/${seat}.md` }).allow, true, seat);
  }
  const judge = (file) => as('Bash', { command: `node C:/h/operator/run-reviewer.mjs --advice ${file} --advice-id adv-sort-1` });
  assert.equal(judge(`${panel}/a.md`).allow, false, '패널 초안은 판정에 바로 올릴 수 없다');
  assert.equal(judge('C:/run/reviewer-inbox/adv-sort-1.md').allow, true, '최종 제안문은 지금처럼 판정받는다');
  assert.equal(as('Write', { file_path: 'C:/run/memo/panel.md', content: 'x' }).allow, false);
});

test('패널(결정 8-24): 코디네이터 정의·조언 스킬·어드바이저 정의가 같은 단계 이름을 쓴다', () => {
  const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
  const coord = read('../coordinator/skills/coordinator-advice/SKILL.md');
  const panel = read('../advisor/skills/advisor-panel/SKILL.md');
  for (const stage of ['패널 단계: 초안', '패널 단계: 교환', '패널 단계: 최종']) {
    assert.ok(coord.includes(stage), `coordinator-advice: ${stage}`);
    assert.ok(panel.includes(stage), `advisor-panel: ${stage}`);
  }
  assert.match(text, /패널 단계: 초안\|교환\|최종/);
  assert.match(coord, /조언 id는 넘기지 않는다/);
  assert.match(panel, /판정 명령을 실행하지 않는다/);
});

test('패널(결정 8-26): 교환 단계는 자기 초안을 추천하지 못하고, 세기 단계는 자기 추천 줄을 세지 않는다', () => {
  const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
  // 단계 하나의 글만 떼어 본다: 번호 매긴 단계의 시작부터 다음 단계 번호 앞까지
  const step = (doc, title) => { const i = doc.indexOf(`**${title}`); assert.ok(i >= 0, title); return doc.slice(i, doc.slice(i + 1).search(/\n\s*\d\. \*\*/) + i + 1); };
  const exchange = step(read('../advisor/skills/advisor-panel/SKILL.md'), '교환');
  assert.match(exchange, /자기 초안은 추천할 수 없다/);
  assert.match(exchange, /다른 두 자리/);
  assert.doesNotMatch(exchange, /자기 초안이어도 된다/);
  const count = step(read('../coordinator/skills/coordinator-advice/SKILL.md'), '세기');
  assert.match(count, /자기 자리를 추천한 줄은 세지 않는다/);
  assert.match(count, /버린다/);
  assert.match(count, /자리 a의 초안/);
  assert.match(read('../coordinator/AGENT.md'), /자기 초안은 추천하지 못한다/);
  assert.match(read('../../docs/checks/owner-decisions.md'), /^\| 8-26 \| 패널 자기 추천 금지 \|/m);
});
