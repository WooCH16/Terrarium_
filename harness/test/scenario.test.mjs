// T12(이슈 #15): 시나리오 대본 12개와 검사식.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SCENARIO_DIR, scenarioFile, parseScenario, parseExpr, evaluate } from '../e2e/scenario.mjs';

const verify = fileURLToPath(new URL('../e2e/verify.mjs', import.meta.url));

test('T12: 대본은 12개이고 모두 입력 원문·대역 설정·수치 경계·통과 조건 표를 갖는다', () => {
  assert.equal(readdirSync(SCENARIO_DIR).filter((f) => f.endsWith('.md')).length, 12);
  for (let n = 1; n <= 12; n++) {
    const text = readFileSync(scenarioFile(n), 'utf8');
    for (const h of ['## 사용자 입력 원문', '## 대역 설정', '## 수치 경계', '## 통과 조건']) assert.ok(text.includes(h), `${n}: ${h}`);
    const sc = parseScenario(text);
    assert.ok(sc.checks.length > 0, `${n}`);
    assert.ok(sc.checks.some((c) => c.kind === '자동') || n === 10, `${n}: 자동 검사가 하나 이상`);
  }
  for (const n of [6, 9, 12]) assert.match(readFileSync(scenarioFile(n), 'utf8'), /재작업: 이슈당 2회까지, 3번째에 막힘/);
});

test('T12: verify --scenario N --dry는 검사 항목을 나열하고 0으로 끝난다', () => {
  const r = spawnSync(process.execPath, [verify, '--scenario', '12', '--dry'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^시나리오 12: 조언 거부/);
  assert.match(r.stdout, /자동 {2}.*advice:거부 = 2/);
  assert.match(r.stdout, /직접 {2}/);
  assert.equal(spawnSync(process.execPath, [verify, '--scenario', 'x', '--dry'], { encoding: 'utf8' }).status, 2);
});

test('T12: 검사식은 산출물(이슈·라벨·본문·guard.log·advice-log)로 판정한다', () => {
  const ctx = {
    issues: [{ number: 3, body: '- 유형: 조사\n', labels: [{ name: '보류' }] }],
    guard: [
      { agent_type: null, allow: true, tool_name: 'Bash', summary: 'node C:/h/operator/run-research.mjs --issue 3' },
      { agent_type: null, allow: true, tool_name: 'Agent', summary: 'advisor' },
      { agent_type: 'advisor', allow: true, tool_name: 'Bash', summary: 'node C:/h/operator/run-operator.mjs' },
      { agent_type: null, allow: false, tool_name: 'Bash', summary: 'node C:/h/operator/run-operator.mjs --issues 3' },
    ],
    advice: [{ verdict: '거부' }, { verdict: '거부' }],
    general: () => true,
  };
  const pass = (e) => evaluate(e, ctx).pass;
  assert.ok(pass('issues = 1') && pass('label:보류 >= 1') && pass('body:유형: 조사'));
  assert.ok(pass('guard:run-research >= 1') && pass('guard:Agent = 1'));
  assert.ok(pass('guard:run-operator = 0'), '하위 에이전트 줄과 거부된 줄은 세지 않는다');
  assert.ok(pass('advice:거부 = 2') && pass('advice:허용 = 0') && pass('general'));
  assert.ok(!pass('issues = 0') && !pass('body:유형: 작업'));
  for (const bad of ['issue = 1', 'guard:Write = 0', 'advice:보류 = 1', 'issues == 1']) assert.throws(() => parseExpr(bad), /알 수 없는/, bad);
});
