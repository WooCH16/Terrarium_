// 이슈 #44: Jev 라우팅(워커 모델·유형). 실제 API는 부르지 않는다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { main, TYPE_OPTIONS } from '../operator/route-issue.mjs';
import { loadOperatorConfig } from '../operator/config.mjs';
import { decide as policyDecide } from '../policy.mjs';

const fwd = (p) => p.split(String.fromCharCode(92)).join('/');
const made = [];
after(() => { for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 무시 */ } } });
const CFG = loadOperatorConfig(fileURLToPath(new URL('../operator/operator.config.json', import.meta.url)));
const DRAFT = '## 목표\nmemo list에 정렬 옵션을 더한다\n\n## 완료 기준\n| 기준 | 확인 방법 |\n|---|---|\n| a | b |\n';

function fakeJev({ model = 'gemini', type = 'change_to_project', difficulty = 'complex_change', security = 0.1, status = 200 } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const req = JSON.parse(init.body);
    calls.push(req);
    const pick = (q, choice) => ({ type: 'choice', choice, confidence: 0.5, probabilities: Object.fromEntries(Object.keys(q.criteria).map((k) => [k, k === choice ? 0.8 : 0.2 / (Object.keys(q.criteria).length - 1)])) });
    const body = { model: 'jev-1.14.0', answers: { worker_model: pick(req.questions.worker_model, model), issue_type: pick(req.questions.issue_type, type), difficulty: pick(req.questions.difficulty, difficulty), touches_security: { type: 'noul', noul: security } }, usage: { input_tokens: 1, output_tokens: 1 } };
    return { status, text: async () => JSON.stringify(status === 200 ? body : { detail: 'x' }) };
  };
  return { fetch, calls };
}

function setup(text = DRAFT, name = 'sort.md') {
  const root = fwd(mkdtempSync(`${fwd(tmpdir())}/route-`));
  made.push(root);
  mkdirSync(`${root}/issues/.drafts`, { recursive: true });
  writeFileSync(`${root}/issues/.drafts/${name}`, text);
  writeFileSync(`${root}/outside.md`, text);
  const run = async (argv, { jev = fakeJev(), deps = {} } = {}) => {
    const out = []; const err = [];
    const code = await main(argv, { HARNESS_RUN_DIR: root }, { write: (l) => out.push(l), writeErr: (l) => err.push(l), harness: { issuesClone: `${root}/issues` }, cfg: deps.cfg ?? CFG, jevKey: 'k', fetch: jev.fetch, sleep: async () => {}, ...deps });
    return { code, out, err, jev };
  };
  return { root, run };
}

test('#44 라우팅: 워커 모델과 유형을 한 요청의 Choice 둘로 묻고, 가장 높은 보기를 이슈 본문 줄로 낸다', async () => {
  const s = setup();
  const r = await s.run(['--draft', 'sort.md'], { jev: fakeJev({ model: 'gemini', type: 'answer_or_recommendation' }) });
  assert.equal(r.code, 0, r.err.join());
  assert.deepEqual(r.out, ['워커 모델: gemini (Jev 라우팅, 확률 0.80, jev-1.14.0)', '유형: 조사 (Jev 라우팅, 확률 0.80)', '난이도: 어려움 (Jev 라우팅, 쉬움 0.20 < 0.7)']);
  const [req] = r.jev.calls;
  assert.equal(req.model, 'jev-1.14.0');
  assert.deepEqual(req.state, { draft: DRAFT });
  assert.deepEqual(Object.keys(req.questions.issue_type.criteria), Object.keys(TYPE_OPTIONS));
  assert.equal(req.questions.issue_type.criteria.change_to_project, CFG.jev.routing.types.작업);
  assert.equal(req.questions.worker_model.criteria.claude, CFG.jev.routing.workerModels.claude);
});

test('#44 라우팅: 공개 제한이 켜진 모델은 초안에 `공개 가능: 예`가 없으면 보기에서 뺀다(코드가 정한다)', async () => {
  const s = setup();
  const r = await s.run(['--draft', 'sort.md']);
  assert.deepEqual(Object.keys(r.jev.calls[0].questions.worker_model.criteria), ['claude', 'gemini'], '공개 기본 설정은 muse.publicOnly: true');
  const t = setup(`${DRAFT}\n- 공개 가능: 예\n`);
  const r2 = await t.run(['--draft', 'sort.md']);
  assert.deepEqual(Object.keys(r2.jev.calls[0].questions.worker_model.criteria), ['claude', 'gemini', 'muse']);
});

test('#44 라우팅 실패: Jev 오류는 6, 키 없음·인자·경로 오류는 2이고 Jev를 부르지 않는다', async () => {
  const s = setup();
  assert.equal((await s.run(['--draft', 'sort.md'], { jev: fakeJev({ status: 429 }) })).code, 6);
  for (const argv of [[], ['--draft'], ['--draft', '../outside.md'], ['--draft', 'none.md'], ['--draft', 'sort.md', '--x', 'y']]) {
    const r = await s.run(argv);
    assert.equal(r.code, 2, JSON.stringify(argv));
    assert.equal(r.jev.calls.length, 0);
  }
  const r = await s.run(['--draft', 'sort.md'], { deps: { jevKey: null } });
  assert.equal(r.code, 2);
  assert.match(r.err[0], /TYPESAFE_API_KEY/);
});

test('#44 훅: 코디네이터는 route-issue.mjs --draft <이름>만 실행할 수 있다', () => {
  const config = { harnessDir: 'C:/h', runDir: 'C:/run', issuesClone: 'C:/run/issues', targetProject: 'C:/run/memo', designatedRepo: 'o/r' };
  const bash = (command) => policyDecide({ tool_name: 'Bash', tool_input: { command }, cwd: 'C:/run/issues' }, config);
  assert.equal(bash('node C:/h/operator/route-issue.mjs --draft sort.md').allow, true);
  for (const c of ['node C:/h/operator/route-issue.mjs --draft ../x.md', 'node C:/h/operator/route-issue.mjs', 'node C:/h/operator/route-issue.mjs --draft a.md --model claude']) {
    assert.equal(bash(c).allow, false, c);
  }
});

test('#44 라우팅: 설정에 설명이 없는 모델은 보기에 넣지 않는다', async () => {
  const cfg = structuredClone(CFG);
  delete cfg.jev.routing.workerModels.claude;
  const s = setup(`${DRAFT}\n- 공개 가능: 예\n`);
  const r = await s.run(['--draft', 'sort.md'], { deps: { cfg } });
  assert.deepEqual(Object.keys(r.jev.calls[0].questions.worker_model.criteria), ['gemini', 'muse']);
});

test('#26 뒤(8-16) 라우팅: 난이도를 같은 요청의 Choice로 묻고 쉬움·어려움 줄을 낸다', async () => {
  const s = setup();
  const r = await s.run(['--draft', 'sort.md'], { jev: fakeJev({ model: 'claude', difficulty: 'simple_change' }) });
  assert.equal(r.code, 0, r.err.join());
  assert.equal(r.out[2], '난이도: 쉬움 (Jev 라우팅, 쉬움 0.80)');
  const sec = await s.run(['--draft', 'sort.md'], { jev: fakeJev({ model: 'claude', difficulty: 'simple_change', security: 0.9 }) });
  assert.equal(sec.out[2], '난이도: 어려움 (Jev 라우팅, 보안 영향 0.90)', '보안 영향이 있으면 쉬움으로 골라도 어려움');
  const q = r.jev.calls[0].questions.difficulty;
  assert.deepEqual(Object.keys(q.criteria), ['simple_change', 'complex_change']);
  assert.equal(q.criteria.simple_change, CFG.jev.routing.difficulty.쉬움);
});

test('8-16: 어려운 일은 muse에 보내지 않고 나머지 보기 중 확률이 가장 높은 모델로 바꾼다', async () => {
  const s = setup(`${DRAFT}
- 공개 가능: 예
`);
  const r = await s.run(['--draft', 'sort.md'], { jev: fakeJev({ model: 'muse', difficulty: 'complex_change' }) });
  assert.equal(r.code, 0, r.err.join());
  assert.ok(['claude', 'gemini'].some((m) => r.out[0] === `워커 모델: ${m} (Jev 라우팅, 확률 0.10, 어려운 일이라 muse 대신, jev-1.14.0)`), r.out[0]);
  const easy = await s.run(['--draft', 'sort.md'], { jev: fakeJev({ model: 'muse', difficulty: 'simple_change' }) });
  assert.match(easy.out[0], /^워커 모델: muse /);
});
