// Pi 워커 확장(harness/worker/pi-ask.js, 결정 8-39): 결정으로 보이는 명령 가려내기, 오퍼레이터에게 묻고 답 받기, 훅의 허용·거부.
// 실제 Pi 없이 확장의 기본 내보내기에 가짜 pi(registerTool·on을 모으는 것)를 넘겨 시험한다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import piAsk, { classifyCommand, addedDependencies, createAsker, allowed } from '../worker/pi-ask.js';

const fwd = (p) => p.split(String.fromCharCode(92)).join('/');
const made = [];
after(() => { for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 무시 */ } } });
function setup(extra = {}) {
  const root = fwd(mkdtempSync(`${fwd(tmpdir())}/piask-`));
  made.push(root);
  mkdirSync(`${root}/wt/.harness`, { recursive: true });
  mkdirSync(`${root}/drafts`, { recursive: true });
  const env = { HARNESS_ASK_FILE: `${root}/wt/.harness/asking.md`, HARNESS_ANSWER_PREFIX: `${root}/drafts/answer-7-h1-q`, HARNESS_WORKER_ISSUE: '7', HARNESS_ASK_POLL_MS: '20', HARNESS_ASK_WAIT_MS: '3000', ...extra };
  return { root, env };
}
// 오퍼레이터 흉내: 질문 파일이 뜨면 그 번호로 답을 쓴다.
function operator(env, answerFor) {
  const seen = [];
  const timer = setInterval(() => {
    if (!existsSync(env.HARNESS_ASK_FILE)) return;
    const t = readFileSync(env.HARNESS_ASK_FILE, 'utf8');
    const id = /## 질문 번호\n(\S+)/.exec(t)?.[1];
    if (!id || seen.some((s) => s.id === id)) return;
    seen.push({ id, text: t });
    const a = answerFor(t, seen.length);
    if (a !== null) writeFileSync(`${env.HARNESS_ANSWER_PREFIX}${id}.md`, a);
  }, 10);
  return { seen, stop: () => clearInterval(timer) };
}
function fakePi() {
  const tools = {};
  const handlers = {};
  return { tools, handlers, registerTool: (t) => { tools[t.name] = t; }, on: (ev, fn) => { handlers[ev] = fn; } };
}

test('결정으로 보이는 명령: 새 패키지 설치와 시험 지우기만 가려낸다', () => {
  const pkg = ['npm install left-pad', 'npm i -D vitest', 'cd app && npm install lodash --save', 'pnpm add zod', 'yarn add react', 'bun add x',
    'pip install requests', 'pip3 install -U numpy', 'python -m pip install flask', 'uv add httpx', 'uv pip install rich', 'cargo add serde',
    'go get github.com/x/y', 'poetry add pydantic', 'gem install rails', 'dotnet add package Newtonsoft.Json', 'FOO=1 npm install x'];
  for (const c of pkg) assert.equal(classifyCommand(c)?.category, '새 외부 패키지 설치', c);
  const tests = ['rm test/a.test.js', 'rm -rf tests', 'git rm -r __tests__/x.js', 'rm src/foo.spec.ts', 'del tests\\a.js', 'Remove-Item tests/x.js', 'rm pkg/a_test.go', 'rm test_util.py'];
  for (const c of tests) assert.equal(classifyCommand(c)?.category, '기존 시험 지우기', c);
  const ok = ['npm install', 'npm ci', 'npm install --no-audit', 'npm test', 'yarn', 'pip install -r requirements.txt', 'pip install -e .', 'node --test',
    'rm src/a.js', 'git status', 'cat test/a.test.js', 'npm run build', 'ls tests', 'git log -- test'];
  for (const c of ok) assert.equal(classifyCommand(c), null, c);
});

test('package.json에 새 의존성을 더하는 쓰기만 가려낸다', () => {
  const before = JSON.stringify({ name: 'x', dependencies: { a: '1' } });
  assert.deepEqual(addedDependencies('pkg/package.json', before, JSON.stringify({ name: 'x', dependencies: { a: '1', b: '2' }, devDependencies: { c: '3' } })), ['b', 'c']);
  assert.equal(addedDependencies('package.json', before, JSON.stringify({ name: 'y', dependencies: { a: '2' } })), null);
  assert.equal(addedDependencies('other.json', before, JSON.stringify({ dependencies: { z: '1' } })), null);
  assert.deepEqual(addedDependencies('package.json', null, JSON.stringify({ dependencies: { z: '1' } })), ['z']);
});

test('ask_operator: 질문 파일을 쓰고 답을 기다렸다가 결정을 돌려준다. 끝나면 질문·답 파일을 지운다(답 파일 경로는 결과 글에 없다)', async () => {
  const { env } = setup();
  const pi = fakePi();
  piAsk(pi, env);
  const op = operator(env, () => '파랑으로 한다.');
  const r = await pi.tools.ask_operator.execute('t1', { question: '파랑? 빨강?' });
  op.stop();
  const text = r.content[0].text;
  assert.match(text, /^오퍼레이터 결정:\n파랑으로 한다\./);
  assert.ok(!text.includes('drafts'), '답 파일 경로를 모델에게 보이지 않는다');
  assert.match(op.seen[0].text, /## 종류\n질문\n/);
  assert.match(op.seen[0].text, /## 이슈 번호\n7\n/);
  assert.match(op.seen[0].text, /## 질문\n파랑\? 빨강\?/);
  assert.ok(!existsSync(env.HARNESS_ASK_FILE));
  assert.ok(!existsSync(`${env.HARNESS_ANSWER_PREFIX}${op.seen[0].id}.md`));
  assert.equal(r.details.answered, true);
});

test('ask_operator: 답이 제한 시간 안에 안 오면 질문 파일을 쓰고 끝내라고 돌려준다', async () => {
  const { env } = setup({ HARNESS_ASK_WAIT_MS: '200' });
  const pi = fakePi();
  piAsk(pi, env);
  const r = await pi.tools.ask_operator.execute('t1', { question: '?' });
  assert.match(r.content[0].text, /답을 받지 못했다[\s\S]*worker-question\.md/);
  assert.ok(!existsSync(env.HARNESS_ASK_FILE), '질문 파일을 남기지 않는다');
});

test('ask_operator: 통로 환경 변수가 없으면 기다리지 않고 질문 파일 경로로 넘긴다', async () => {
  const pi = fakePi();
  piAsk(pi, {});
  const t0 = Date.now();
  const r = await pi.tools.ask_operator.execute('t1', { question: '?' });
  assert.ok(Date.now() - t0 < 500);
  assert.match(r.content[0].text, /worker-question\.md/);
});

test('ask_operator: 동시에 두 번 불러도 한 번에 하나씩 묻고, 각자 자기 답을 받는다. 한도를 넘으면 더 묻지 않는다', async () => {
  const { env } = setup({ HARNESS_ASK_LIMIT: '2' });
  const pi = fakePi();
  piAsk(pi, env);
  const op = operator(env, (_t, n) => `답 ${n}`);
  const [a, b] = await Promise.all([pi.tools.ask_operator.execute('t1', { question: '하나' }), pi.tools.ask_operator.execute('t2', { question: '둘' })]);
  const c = await pi.tools.ask_operator.execute('t3', { question: '셋' });
  op.stop();
  assert.match(a.content[0].text, /답 1/);
  assert.match(b.content[0].text, /답 2/);
  assert.match(op.seen[0].text, /하나/);
  assert.match(op.seen[1].text, /둘/);
  assert.notEqual(op.seen[0].id, op.seen[1].id);
  assert.match(c.content[0].text, /질문 한도\(2번\)/);
  assert.equal(op.seen.length, 2);
});

test('훅: 결정으로 보이는 명령은 허용 여부를 묻고, 첫 줄이 허용이면 실행, 아니면 막는다. 답이 없으면 막는다', async () => {
  const { env } = setup({ HARNESS_ASK_WAIT_MS: '1500' });
  const pi = fakePi();
  piAsk(pi, env);
  const hook = pi.handlers.tool_call;
  assert.equal(await hook({ toolName: 'bash', input: { command: 'npm test' } }, {}), undefined, '결정이 아닌 명령은 묻지 않는다');
  let op = operator(env, () => '허용: 이슈의 기준 2가 이 패키지를 쓴다.');
  assert.equal(await hook({ toolName: 'bash', input: { command: 'npm install left-pad' } }, {}), undefined);
  op.stop();
  assert.match(op.seen[0].text, /## 종류\n허용 여부\n/);
  assert.match(op.seen[0].text, /npm install left-pad/);
  op = operator(env, () => '거부: 이슈에 없는 패키지다.');
  const no = await hook({ toolName: 'bash', input: { command: 'rm -rf tests' } }, {});
  op.stop();
  assert.equal(no.block, true);
  assert.match(no.reason, /허용하지 않았다: 거부: 이슈에 없는 패키지다/);
  const silent = await hook({ toolName: 'bash', input: { command: 'pip install requests' } }, {});
  assert.equal(silent.block, true, '답이 없으면 막는다');
  assert.match(silent.reason, /허용 없이는 실행하지 않는다/);
});

test('훅: write·edit로 package.json에 의존성을 더해도 허용 여부를 묻는다', async () => {
  const { root, env } = setup();
  const pi = fakePi();
  piAsk(pi, env);
  const file = `${root}/wt/package.json`;
  writeFileSync(file, JSON.stringify({ name: 'x', dependencies: { a: '1' } }, null, 2));
  const op = operator(env, () => '거부');
  const w = await pi.handlers.tool_call({ toolName: 'write', input: { path: file, content: JSON.stringify({ name: 'x', dependencies: { a: '1', b: '1' } }) } }, {});
  const e = await pi.handlers.tool_call({ toolName: 'edit', input: { path: file, edits: [{ oldText: '"a": "1"', newText: '"a": "1",\n    "c": "2"' }] } }, {});
  const plain = await pi.handlers.tool_call({ toolName: 'edit', input: { path: file, edits: [{ oldText: '"name": "x"', newText: '"name": "y"' }] } }, {});
  op.stop();
  assert.equal(w.block, true);
  assert.equal(e.block, true);
  assert.equal(plain, undefined);
  assert.match(op.seen[0].text, /의존성을 더하려 한다: b/);
  assert.match(op.seen[1].text, /의존성을 더하려 한다: c/);
});

test('allowed: 첫 줄이 허용으로 시작할 때만', () => {
  assert.equal(allowed({ answer: '허용' }), true);
  assert.equal(allowed({ answer: '\n허용: 좋다' }), true);
  assert.equal(allowed({ answer: '거부. 허용 안 함' }), false);
  assert.equal(allowed({ answer: '불허용' }), false);
  assert.equal(allowed({ none: true }), false);
});

test('createAsker: 같은 번호의 옛 답 파일은 이번 답이 아니다(묻기 전에 지운다)', async () => {
  const { env } = setup({ HARNESS_ASK_WAIT_MS: '200' });
  writeFileSync(`${env.HARNESS_ANSWER_PREFIX}${process.pid}-1.md`, '옛 답');
  const r = await createAsker(env).ask('질문', '?');
  assert.equal(r.answer, undefined);
});
