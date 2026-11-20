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
