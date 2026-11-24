import { test, after } from 'node:test';
import { withMixedRunners } from './helpers/mixed-runners.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from '../operator/run-worker.mjs';

// 이슈 #10(T7)의 끝나는 조건을 가짜 CLI 주입으로 확인한다(실제 모델을 부르지 않는다).
// 기존 operator-worker.test.mjs는 재시도·결과 파일 검사·금지 경로·pid·중단 등 러너 공통 동작을 이미 덮는다.
const fwd = (p) => p.split(String.fromCharCode(92)).join('/');
const here = fwd(fileURLToPath(new URL('.', import.meta.url))).replace(/[/]+$/, '');
const harnessReal = `${here}/..`;
const T = { timeout: 90000 };
const made = [];
after(() => { for (const d of made) { try { rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 잠긴 파일은 무시 */ } } });
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...ID, ...a], { encoding: 'utf8', stdio: 'pipe' }).trim();

// 가짜 CLI(pi, agy, claude 공용): 작업 폴더에 파일 하나를 커밋하고 결과 파일을 쓰고, CLI별 출력 형식으로 모델 이름을 낸다.
const FAKE = `
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const E = process.env;
const argv = process.argv.slice(2);
let stdin = ''; for await (const c of process.stdin) stdin += c;
if (E.FAKE_STALL_ON && argv.includes(E.FAKE_STALL_ON)) { setInterval(() => {}, 1000); await new Promise(() => {}); }
if (E.FAKE_PROVIDER_ERROR_ON && argv.includes(E.FAKE_PROVIDER_ERROR_ON)) { console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [], provider: 'google', model: 'gemini-test', stopReason: 'error', errorMessage: '503 This model is currently experiencing high demand' } })); process.exit(0); }
writeFileSync(E.FAKE_REC, JSON.stringify({ argv, stdin, cwd: process.cwd(), author: E.GIT_AUTHOR_NAME ?? null, claudeRole: E.HARNESS_REQUIRE_ROLE ?? null, gemini: E.GEMINI_API_KEY ? 'set' : null, typesafe: E.TYPESAFE_API_KEY ? 'set' : null, other: E.OTHER_PROVIDER_KEY ? 'set' : null }));
if (E.FAKE_TOUCH) writeFileSync(E.FAKE_TOUCH, 'changed by worker');
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
writeFileSync('feature.txt', String(Math.random()));
git('add', '-A'); git('commit', '-q', '-m', 'work');
const hash = git('rev-parse', 'HEAD');
mkdirSync('.harness', { recursive: true });
const secs = [['이슈 번호', E.FAKE_ISSUE], ['변경 요약', '기능 추가'], ['테스트 명령과 결과', 'node --test: 통과'], ['커밋 해시', hash]];
writeFileSync('.harness/worker-result.md', secs.map(([k, v]) => '## ' + k + '\\n' + v + '\\n').join('\\n'));
const model = E.FAKE_MODEL;
if (E.FAKE_KIND === 'pi') {
  const am = { role: 'assistant', content: [], provider: 'meta', ...(model ? { model } : {}) };
  console.log([{ type: 'message_start', message: { role: 'system', content: '' } }, { type: 'message_start', message: am }, { type: 'message_end', message: { ...am, content: [{ type: 'text', text: 'done' }], stopReason: 'stop' } }].map((o) => JSON.stringify(o)).join('\\n'));
} else if (E.FAKE_KIND === 'agy') {
  const li = argv.indexOf('--log-file');
  if (li > -1) writeFileSync(argv[li + 1], 'I1 printmode.go:208] Print mode: starting (promptLength=9, model="' + model + '", conversationID="")\\n');
  console.log(JSON.stringify({ conversation_id: 'conv-9', status: 'SUCCESS', response: 'done' }));
} else if (E.FAKE_KIND === 'claude') {
  console.log(JSON.stringify({ result: 'done', is_error: false, modelUsage: model ? { [model]: {} } : {} }));
}
`;

function setup() {
  const root = fwd(mkdtempSync(`${fwd(tmpdir())}/rw-`));
  made.push(root);
  const run = `${root}/run`;
  const harnessDir = `${root}/harness`;
  const target = `${root}/target`;
  mkdirSync(`${run}/handoffs/h1`, { recursive: true });
  mkdirSync(`${harnessDir}/operator`, { recursive: true });
  // 실제 기본 설정에서 claude·gemini 러너만 CLI가 섞인 시험용 모양으로 바꾼다(기본은 세 모델 모두 Pi, ADR 0009). 기본값 자체는 operator-config 시험이 본다.
  writeFileSync(`${harnessDir}/operator/operator.config.json`, JSON.stringify(withMixedRunners(JSON.parse(readFileSync(`${harnessReal}/operator/operator.config.json`, 'utf8')))));
  mkdirSync(target, { recursive: true });
  git(target, 'init', '-q', '-b', 'main');
  writeFileSync(`${target}/README.md`, 'hi');
  git(target, 'add', '-A'); git(target, 'commit', '-q', '-m', 'init');
  writeFileSync(`${run}/harness.json`, JSON.stringify({ harnessDir, designatedRepo: 'o/r', issuesClone: `${root}/issues`, targetProject: target, worktrees: `${run}/worktrees` }));
  const fake = `${root}/fake-cli.mjs`;
  writeFileSync(fake, FAKE);
  const s = { root, run, target, fake, rec: `${root}/rec.json` };
  s.env = { HARNESS_RUN_DIR: run, HARNESS_PI_BIN: fake, HARNESS_AGY_BIN: fake, HARNESS_CLAUDE_BIN: fake, FAKE_REC: s.rec, HARNESS_WORKER_PASS_ENV: 'FAKE_*' };
  s.exec = async (model, { issue = 7, env = {}, body = '본문', deps = {} } = {}) => {
    const out = []; const err = [];
    const code = await main(['--handoff', 'h1', '--issue', String(issue), '--model', model], { ...s.env, FAKE_ISSUE: String(issue), ...env }, {
      write: (l) => out.push(l), writeErr: (l) => err.push(l), fetchIssueBody: async () => body, ...deps,
    });
    return { code, out, err, rec: out[0] ? JSON.parse(out[0]) : null };
  };
  s.recorded = () => JSON.parse(readFileSync(s.rec, 'utf8'));
  s.worktrees = () => git(s.target, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => fwd(l.slice(9)));
  return s;
}
const K = {
  claude: { FAKE_KIND: 'claude', FAKE_MODEL: 'claude-haiku-5-5' },
  gemini: { FAKE_KIND: 'agy', FAKE_MODEL: 'gemini-4-hydrogen-medium' },
  muse: { FAKE_KIND: 'pi', FAKE_MODEL: 'muse-spark-1.3-contributor' },
};

test('모델 값별 실행 표: claude, gemini, muse는 해당 CLI와 모델로 띄운다', T, async () => {
  const expected = {
    claude: { cli: 'claude', via: 'direct', temporary: undefined, modelId: 'claude-haiku-5-5', actual: 'claude-haiku-5-5', argHas: ['--model', 'claude-haiku-5-5'] },
    gemini: { cli: 'agy', via: 'direct', temporary: undefined, modelId: 'gemini-4-hydrogen-medium', actual: 'gemini-4-hydrogen-medium', argHas: ['--model', 'gemini-4-hydrogen-medium', '--sandbox'] },
    muse: { cli: 'pi', via: 'pi', temporary: undefined, modelId: 'meta/muse-spark-1.3-contributor', actual: 'meta/muse-spark-1.3-contributor', argHas: ['--model', 'meta/muse-spark-1.3-contributor', '--mode', 'json'] },
  };
  for (const model of ['claude', 'gemini', 'muse']) {
    const s = setup();
    const r = await s.exec(model, { env: K[model] });
    const e = expected[model];
    assert.equal(r.code, 0, `${model}: ${r.err.join()}`);
    assert.equal(r.rec.status, '완료');
    assert.equal(r.rec.requestedModel, model);
    assert.equal(r.rec.model, model);
    assert.equal('replacedFrom' in r.rec, false, '지정한 모델로만 띄운다(조용히 다른 모델로 바꾸지 않는다)');
    assert.equal(r.rec.cli, e.cli);
    assert.equal(r.rec.via, e.via);
    assert.equal(r.rec.temporary, e.temporary);
    assert.equal(r.rec.modelId, e.modelId);
    assert.equal(r.rec.actualModel, e.actual, '실제 모델은 러너 출력에서 읽은 값');
    assert.ok(r.rec.modelTrace);
    const a = s.recorded();
    for (const t of e.argHas) assert.ok(a.argv.includes(t), `${model}: ${t} in ${a.argv.join(' ')}`);
    assert.equal(fwd(a.cwd).toLowerCase(), `${s.run}/worktrees/h1/issue-7`.toLowerCase());
    if (model !== 'claude') assert.equal(a.author, 'terrarium-worker');
    if (model === 'muse') assert.ok(a.stdin.includes('worker-input.md'), 'Pi는 표준 입력으로 프롬프트를 받는다');
    if (model === 'gemini') assert.ok(a.argv.includes('--print') && a.argv.at(-1).includes('worker-input.md'), 'agy는 --print 인자로 받는다');
    console.log(`표: ${model} -> cli=${r.rec.cli}, via=${r.rec.via}, 지정=${r.rec.requestedModel}, 실제=${r.rec.actualModel}, 임시=${r.rec.temporary ?? '-'}`);
  }
});

test('codex와 허용 목록 밖의 값은 종료 코드 2로 거부하고 워크트리를 만들지 않는다', T, async () => {
  for (const bad of ['codex', 'gpt', 'Claude', 'muse2', 'nope']) {
    const s = setup();
    const before = s.worktrees();
    const r = await s.exec(bad, { env: K.claude });
    assert.equal(r.code, 2, bad);
    assert.deepEqual(r.out, [], bad);
    assert.equal(r.err.length, 1);
    assert.match(r.err[0], /^오류: .*알 수 없는 모델/);
    assert.deepEqual(s.worktrees(), before, bad);
    assert.ok(!existsSync(`${s.run}/worktrees`), bad);
  }
  const s = setup();
  assert.match((await s.exec('codex')).err[0], /codex는 ADR 0004로 허용 목록에서 뺐습니다/);
});

test('--model 값 모양이 틀려도 종료 코드 2(인자 오류)', T, async () => {
  const s = setup();
  for (const bad of ['', 'a b', '-x', 'x;y']) {
    const out = []; const err = [];
    const code = await main(['--handoff', 'h1', '--issue', '7', '--model', bad], s.env, { write: (l) => out.push(l), writeErr: (l) => err.push(l), fetchIssueBody: async () => 'b' });
    assert.equal(code, 2, JSON.stringify(bad));
  }
});

test('작업 하나에 워크트리 하나가 생기고 다른 워크트리를 건드리지 않는다 (git worktree list 대조)', T, async () => {
  const s = setup();
  const before = s.worktrees();
  assert.equal(before.length, 1);
  const mainHead = git(s.target, 'rev-parse', 'refs/heads/main');
  const r7 = await s.exec('muse', { issue: 7, env: K.muse });
  assert.equal(r7.code, 0, r7.err.join());
  const after1 = s.worktrees();
  assert.equal(after1.length, 2);
  assert.ok(after1.some((p) => p.toLowerCase() === `${s.run}/worktrees/h1/issue-7`.toLowerCase()));
  const head7 = git(`${s.run}/worktrees/h1/issue-7`, 'rev-parse', 'HEAD');
  // 두 번째 작업: 첫 워크트리는 그대로이고 새 워크트리가 하나만 더 생긴다.
  const r8 = await s.exec('gemini', { issue: 8, env: K.gemini });
  assert.equal(r8.code, 0, r8.err.join());
  const after2 = s.worktrees();
  assert.equal(after2.length, 3);
  assert.ok(after2.some((p) => p.toLowerCase() === `${s.run}/worktrees/h1/issue-8`.toLowerCase()));
  assert.equal(git(`${s.run}/worktrees/h1/issue-7`, 'rev-parse', 'HEAD'), head7, '다른 워크트리의 HEAD는 그대로');
  assert.equal(git(s.target, 'rev-parse', 'refs/heads/main'), mainHead, 'main은 그대로');
  assert.equal(r8.rec.mainBefore, r8.rec.mainAfter);
  assert.equal(git(s.target, 'status', '--porcelain'), '', '대상 저장소 작업 폴더는 그대로');
  // 같은 이슈를 다시 띄우면 새 워크트리를 만들지 않고 거부한다(작업 하나에 워크트리 하나).
  const again = await s.exec('muse', { issue: 7, env: K.muse });
  assert.equal(again.code, 2);
  assert.equal(s.worktrees().length, 3);
});

test('실행 결과에 지정 모델, 실제 모델, 커밋 해시가 남고 해시는 이슈 브랜치의 새 커밋이다', T, async () => {
  const s = setup();
  const r = await s.exec('muse', { env: K.muse });
  assert.equal(r.code, 0);
  const rec = r.rec;
  assert.equal(rec.requestedModel, 'muse');
  assert.equal(rec.actualModel, 'meta/muse-spark-1.3-contributor');
  assert.match(rec.commit, /^[0-9a-f]{40}$/);
  assert.equal(rec.commit, git(s.target, 'rev-parse', 'refs/heads/h1/issue-7'));
  const result = readFileSync(`${s.run}/worktrees/h1/issue-7/.harness/worker-result.md`, 'utf8');
  assert.ok(result.includes(rec.commit), '결과 파일의 커밋 해시와 같다');
  assert.notEqual(rec.commit, git(s.target, 'rev-parse', 'refs/heads/main'));
});

test('실제 모델이 지정과 다르면 그 시도는 실패로 센다(막힘)', T, async () => {
  const s = setup();
  const r = await s.exec('muse', { env: { ...K.muse, FAKE_MODEL: 'some-other-model' } });
  assert.equal(r.code, 1);
  assert.equal(r.rec.status, '막힘');
  assert.equal(r.rec.attempts, 3);
  assert.match(r.rec.failures[0], /실제 모델\(meta\/some-other-model\)이 지정한 모델\(muse\)과 다릅니다/);
  assert.equal(r.rec.actualModel, 'meta/some-other-model');
  assert.equal(r.rec.commit, null);
});

test('러너 출력에서 모델 이름을 읽지 못하면 actualModel은 null(확인하지 못함)이고 요청한 값을 옮겨 적지 않는다', T, async () => {
  const s = setup();
  const r = await s.exec('muse', { env: { ...K.muse, FAKE_MODEL: '' } });
  assert.equal(r.code, 0);
  assert.equal(r.rec.actualModel, null);
  assert.equal(r.rec.modelTrace, null);
});

// 소유자 결정 5-3: 대체 표는 순환형(claude → gemini → muse → claude)이다. 예전에는 대체 표가 비어 있어 CLI가 없으면 종료 코드 2였다.
const NO = (s) => `${s.root}/없음.mjs`;
test('지정 모델의 CLI가 없으면 대체 표의 다음 모델로 띄우고 지정·실제·사유를 남긴다', T, async () => {
  const s = setup();
  const r = await s.exec('muse', { env: { ...K.claude, HARNESS_PI_BIN: NO(s) } });
  assert.equal(r.code, 0, r.err.join());
  assert.equal(r.rec.requestedModel, 'muse');
  assert.equal(r.rec.model, 'claude');
  assert.equal(r.rec.replacedFrom, 'muse');
  assert.equal(r.rec.replacedReason, 'muse CLI 없음');
  assert.equal(r.rec.cli, 'claude');
  assert.equal(r.rec.actualModel, 'claude-haiku-5-5');
});

test('대체가 이어진다: claude CLI가 없고 gemini도 없으면 muse(공개 가능 이슈)로 띄운다', T, async () => {
  const s = setup();
  const r = await s.exec('claude', { env: { ...K.muse, HARNESS_CLAUDE_BIN: NO(s), HARNESS_AGY_BIN: NO(s) }, body: '## 목표\nx\n- 공개 가능: 예\n' });
  assert.equal(r.code, 0, r.err.join());
  assert.equal(r.rec.model, 'muse');
  assert.equal(r.rec.replacedFrom, 'claude');
  assert.deepEqual(r.rec.skipped, ['gemini(쓸 수 없음)']);
});

// 공개 제한 장치는 설정 사본의 publicOnly를 켜서 본다(기본 설정은 소유자 결정 8-6으로 꺼져 있다).
function gate(s) {
  const f = `${s.root}/harness/operator/operator.config.json`;
  const c = JSON.parse(readFileSync(f, 'utf8'));
  c.runners.muse.publicOnly = true;
  writeFileSync(f, JSON.stringify(c));
}

test('실행 폴더의 operator.local.json으로 제한을 끄면(8-6) 공개 가능 표시가 없어도 muse로 대체한다', T, async () => {
  const s = setup();
  writeFileSync(`${s.run}/operator.local.json`, JSON.stringify({ runners: { muse: { publicOnly: false } } }));
  const r = await s.exec('gemini', { env: { ...K.muse, HARNESS_AGY_BIN: NO(s) } });
  assert.equal(r.code, 0, r.err.join());
  assert.equal(r.rec.model, 'muse');
});

test('publicOnly를 켜면 공개 가능 표시가 없을 때 muse로 대체하지 않고 다음(claude)으로 간다', T, async () => {
  const s = setup();
  gate(s);
  const r = await s.exec('gemini', { env: { ...K.claude, HARNESS_AGY_BIN: NO(s) } });
  assert.equal(r.code, 0, r.err.join());
  assert.equal(r.rec.model, 'claude');
  assert.deepEqual(r.rec.skipped, ['muse(공개 가능 표시 없음)']);
});

test('publicOnly를 켜고 공개 가능 표시가 없어 muse를 건너뛰고 남은 모델이 없으면 막힘(종료 코드 1), 워크트리를 만들지 않는다', T, async () => {
  const s = setup();
  gate(s);
  const r = await s.exec('gemini', { env: { ...K.muse, HARNESS_AGY_BIN: NO(s), HARNESS_CLAUDE_BIN: NO(s) }, body: '공개 가능: 아니오' });
  assert.equal(r.code, 1, r.err.join());
  assert.equal(r.rec.status, '막힘');
  assert.equal(r.rec.attempts, 0);
  assert.match(r.rec.failures[0], /muse\(공개 가능 표시 없음\)/);
  assert.equal(s.worktrees().length, 1);
  // 워커 기록(결정 8-29): 러너를 띄우지 않았으므로 end 한 줄만(관제탑은 start가 있는 이슈만 워커로 센다).
  const lines = readFileSync(`${s.run}/handoffs/h1/workers.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.event, l.issue, l.status, l.attempts]), [['end', 7, '막힘', 0]]);
});

test('지정 모델이 muse면 공개 가능 표시 없이도 muse로 띄운다(대체가 아니다)', T, async () => {
  const s = setup();
  const r = await s.exec('muse', { env: K.muse });
  assert.equal(r.code, 0, r.err.join());
  assert.equal(r.rec.model, 'muse');
  assert.equal('replacedFrom' in r.rec, false);
});

test('세 모델의 CLI가 모두 없으면 종료 코드 2이고 워크트리를 만들지 않는다', T, async () => {
  const s = setup();
  const r = await s.exec('muse', { env: { ...K.muse, HARNESS_PI_BIN: NO(s), HARNESS_AGY_BIN: NO(s), HARNESS_CLAUDE_BIN: NO(s) }, body: '공개 가능: 예' });
  assert.equal(r.code, 2);
  assert.deepEqual(r.out, []);
  assert.match(r.err[0], /대체 모델 claude, gemini도 쓸 수 없습니다/);
  assert.deepEqual(s.worktrees().length, 1);
});

test('격리 방식이 결과에 적힌다(Pi는 샌드박스 없음, agy는 --sandbox)', T, async () => {
  const s = setup();
  const r = await s.exec('muse', { env: K.muse });
  assert.match(r.rec.isolation, /^없음/);
  const g = await setup().exec('gemini', { env: K.gemini });
  assert.match(g.rec.isolation, /--sandbox/);
});

test('공개 기본 설정: 로컬 설정이 없으면 공개 가능 표시 없는 이슈를 muse로 대체하지 않는다', T, async () => {
  const s = setup();
  const r = await s.exec('gemini', { env: { ...K.claude, HARNESS_AGY_BIN: NO(s) } });
  assert.equal(r.code, 0, r.err.join());
  assert.equal(r.rec.model, 'claude');
  assert.deepEqual(r.rec.skipped, ['muse(공개 가능 표시 없음)']);
});

test('#26: claude 모델을 Pi로 띄우면(runners.claude.cli: pi) 훅 설정 없이 Pi로 실행하고 격리 없음으로 적는다', T, async () => {
  const s = setup();
  const cfgFile = `${s.root}/harness/operator/operator.config.json`;
  const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
  cfg.runners.claude = { command: ['pi', '-p', '--no-session', '--mode', 'json', '--model', 'anthropic/claude-test'], cli: 'pi', via: 'pi', modelId: 'anthropic/claude-test' };
  writeFileSync(cfgFile, JSON.stringify(cfg));
  const r = await s.exec('claude', { env: { FAKE_KIND: 'pi', FAKE_MODEL: 'anthropic/claude-test' } });
  assert.equal(r.code, 0, r.err.join());
  assert.equal(r.rec.model, 'claude');
  assert.equal(r.rec.cli, 'pi');
  assert.match(r.rec.isolation, /^없음/);
  const a = s.recorded().argv;
  assert.ok(a.includes('anthropic/claude-test'));
  assert.ok(!a.includes('--settings') && !a.includes('--setting-sources'), 'Pi 실행에는 Claude Code 훅 설정을 붙이지 않는다');
});

test('#26: runners.<m>.secretEnv의 값을 실행 폴더 .env에서 읽어 러너 환경 변수로만 넘기고, 없으면 그 모델을 쓸 수 없다', T, async () => {
  const s = setup();
  const cfgFile = `${s.root}/harness/operator/operator.config.json`;
  const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
  cfg.runners.gemini = { command: ['pi', '-p', '--no-session', '--mode', 'json', '--model', 'google/gemini-test'], cli: 'pi', via: 'pi', modelId: 'google/gemini-test', secretEnv: ['GEMINI_API_KEY'] };
  writeFileSync(cfgFile, JSON.stringify(cfg));
  const env = { FAKE_KIND: 'pi', FAKE_MODEL: 'google/gemini-test', GEMINI_API_KEY: '' };
  // 키가 없으면 gemini를 쓸 수 없어 대체 표로 넘어간다(공개 표시가 없어 muse를 건너뛰고 claude).
  const none = await s.exec('gemini', { env: { ...env, FAKE_KIND: 'claude', FAKE_MODEL: 'claude-haiku-5-5' } });
  assert.equal(none.code, 0, none.err.join());
  assert.equal(none.rec.model, 'claude');
  assert.equal(none.rec.replacedFrom, 'gemini');
  // 실행 폴더 .env에 키가 있으면 gemini로 띄우고 러너가 키를 받는다. 결과 JSON에는 값이 없다.
  writeFileSync(`${s.run}/.env`, 'GEMINI_API_KEY=test-gemini-key\n');
  const r = await s.exec('gemini', { issue: 8, env });
  assert.equal(r.code, 0, r.err.join());
  assert.equal(r.rec.model, 'gemini');
  assert.equal(s.recorded().gemini, 'set');
  assert.ok(!r.out.join('\n').includes('test-gemini-key'));
});

test('8-16: 러너가 tiers를 두면 이슈 본문의 난이도로 모델을 고르고, 난이도가 없으면 기본(어려움 쪽) 모델을 쓴다', T, async () => {
  const s = setup();
  const cfgFile = `${s.root}/harness/operator/operator.config.json`;
  const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
  cfg.runners.claude = { command: ['pi', '-p', '--mode', 'json', '--model', 'anthropic/claude-big'], cli: 'pi', via: 'pi', modelId: 'anthropic/claude-big', tiers: { 쉬움: 'anthropic/claude-small', 어려움: 'anthropic/claude-big' } };
  writeFileSync(cfgFile, JSON.stringify(cfg));
  const easy = await s.exec('claude', { env: { FAKE_KIND: 'pi', FAKE_MODEL: 'claude-small' }, body: '## 목표\nx\n- 난이도: 쉬움 (Jev 라우팅, 확률 0.90)\n' });
  assert.equal(easy.code, 0, easy.err.join());
  assert.ok(s.recorded().argv.includes('anthropic/claude-small'));
  assert.equal(easy.rec.modelId, 'anthropic/claude-small');
  assert.equal(easy.rec.difficulty, '쉬움');
  const none = await s.exec('claude', { issue: 8, env: { FAKE_KIND: 'pi', FAKE_MODEL: 'claude-big' }, body: '## 목표\nx\n' });
  assert.equal(none.code, 0, none.err.join());
  assert.ok(s.recorded().argv.includes('anthropic/claude-big'));
  assert.equal(none.rec.difficulty, '모름(기본 모델)');
});

test('A3 가: 워커는 허용 목록의 환경 변수만 받는다(부모의 TYPESAFE_API_KEY·다른 키는 넘기지 않고, 러너의 secretEnv만 더한다)', T, async () => {
  const s = setup();
  const r = await s.exec('muse', { env: { ...K.muse, TYPESAFE_API_KEY: 'jev-secret', OTHER_PROVIDER_KEY: 'x' } });
  assert.equal(r.code, 0, r.err.join());
  const rec = s.recorded();
  assert.equal(rec.typesafe, null);
  assert.equal(rec.other, null);
});

test('A3 나: 워커가 작업 폴더 밖의 보호 대상(실행 폴더 설정, 하네스, 대상 프로젝트 본 폴더)을 바꾸면 다시 시도하지 않고 막힘', T, async () => {
  for (const [touch, label] of [['run/harness.json', '실행 폴더/harness.json'], ['run/operator.local.json', '실행 폴더/operator.local.json'], ['run/advice-log.jsonl', '실행 폴더/advice-log.jsonl'], ['harness/operator/operator.config.json', '하네스/operator/operator.config.json']]) {
    const s = setup();
    const r = await s.exec('muse', { env: { ...K.muse, FAKE_TOUCH: `${s.root}/${touch}` } });
    assert.equal(r.code, 1, touch);
    assert.equal(r.rec.status, '막힘');
    assert.equal(r.rec.attempts, 1, '보호 대상이 바뀌면 다시 시도하지 않는다');
    assert.deepEqual(r.rec.outsideChanges, [label], touch);
    assert.match(r.rec.failures[0], /작업 폴더 밖의 보호 대상이 바뀌었습니다/);
  }
  // 대상 프로젝트 본 폴더 변화는 실패가 아니라 경고다(사용자가 하달 중에 자기 저장소에서 일할 수 있다, fable 조언 2).
  const s = setup();
  const r = await s.exec('muse', { env: { ...K.muse, FAKE_TOUCH: `${s.root}/target/stray.txt` } });
  assert.equal(r.code, 0, r.err.join());
  assert.equal(r.rec.status, '완료');
  assert.equal(r.rec.targetProjectChanged, true);
});

test('run-7 결함: 러너가 출력 없이 멈추면(제공사 503 재시도) 끊고 대체 표의 다음 모델로 넘긴다', T, async () => {
  const s = setup();
  const cfgFile = `${s.root}/harness/operator/operator.config.json`;
  const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
  for (const [m, id] of [['gemini', 'google/gemini-test'], ['claude', 'anthropic/claude-test']]) cfg.runners[m] = { command: ['pi', '-p', '--mode', 'json', '--model', id], cli: 'pi', via: 'pi', modelId: id };
  writeFileSync(cfgFile, JSON.stringify(cfg));
  const r = await s.exec('gemini', { env: { FAKE_KIND: 'pi', FAKE_MODEL: '', FAKE_STALL_ON: 'google/gemini-test' }, deps: { stallMs: 1500 } });
  assert.equal(r.code, 0, r.err.join() + r.out.join());
  assert.equal(r.rec.model, 'claude', '공개 표시가 없어 muse를 건너뛰고 claude');
  assert.equal(r.rec.replacedFrom, 'gemini');
  assert.match(r.rec.replacedReason, /gemini 응답 없음/);
  assert.equal(r.rec.attempts, 2);
  assert.match(r.rec.failures[0], /출력하지 않아 종료했습니다/);
});

test('run-8 결함: 명령줄로 실행해도 돈다(진입점 뒤에 둔 상수의 초기화 전 접근 없음)', T, async () => {
  const s = setup();
  const gh = `${s.root}/fake-gh.mjs`;
  writeFileSync(gh, "console.log(JSON.stringify({ body: '본문' }));");
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../operator/run-worker.mjs', import.meta.url)), '--handoff', 'h1', '--issue', '7', '--model', 'muse'],
    { encoding: 'utf8', env: { ...process.env, ...s.env, ...K.muse, FAKE_ISSUE: '7', HARNESS_GH_BIN: gh } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(JSON.parse(r.stdout.trim()).status, '완료');
});

test('run-8 결함: 하네스 스크립트의 명령줄 진입점은 파일의 마지막 문장이다(뒤에 선언이 오면 명령줄 실행에서만 깨진다)', () => {
  const dirs = ['../operator/', '../', '../e2e/'].map((d) => fileURLToPath(new URL(d, import.meta.url)));
  for (const dir of dirs) {
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.mjs'))) {
      const text = readFileSync(`${dir}/${name}`, 'utf8');
      const at = text.search(/^if \(process\.argv\[1\]/m);
      if (at < 0) continue;
      const after = text.slice(at).replace(/^if[\s\S]*?\n\}\r?\n/, '');
      assert.doesNotMatch(after, /^(const|let|class|function|export)\b/m, name);
    }
  }
});

test('run-8 결함: 러너가 제공사 오류(503 포기)로 결과 없이 끝나면 그 모델을 빼고 대체 표의 다음 모델로 넘긴다', T, async () => {
  const s = setup();
  const cfgFile = `${s.root}/harness/operator/operator.config.json`;
  const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
  for (const [m, id] of [['gemini', 'google/gemini-test'], ['claude', 'anthropic/claude-test']]) cfg.runners[m] = { command: ['pi', '-p', '--mode', 'json', '--model', id], cli: 'pi', via: 'pi', modelId: id };
  writeFileSync(cfgFile, JSON.stringify(cfg));
  const r = await s.exec('gemini', { env: { FAKE_KIND: 'pi', FAKE_MODEL: '', FAKE_PROVIDER_ERROR_ON: 'google/gemini-test' } });
  assert.equal(r.code, 0, r.err.join());
  assert.equal(r.rec.model, 'claude');
  assert.equal(r.rec.attempts, 2);
  assert.match(r.rec.failures[0], /제공사 오류: 503/);
});

test('시나리오 9의 가짜 워커(e2e/fakes/bad-worker.mjs)는 Pi처럼 돌아 결과 파일과 커밋을 남긴다(기능은 만들지 않음)', T, async () => {
  const s = setup();
  const bad = fileURLToPath(new URL('../e2e/fakes/bad-worker.mjs', import.meta.url));
  const r = await s.exec('muse', { env: { HARNESS_PI_BIN: bad } });
  assert.equal(r.code, 0, r.err.join());
  assert.equal(r.rec.status, '완료');
  assert.equal(r.rec.actualModel, 'meta/muse-spark-1.3-contributor');
});
