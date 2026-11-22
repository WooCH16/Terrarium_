// 이슈 #21: 사전 점검 스크립트. 외부 명령은 대역(exec, launcher)으로 바꾼다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runPreflight, formatReport, MIN_PROVIDERS } from '../preflight.mjs';

const harnessDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const CFG = {
  allowedModels: ['claude', 'gemini', 'muse'],
  runners: { claude: { cli: 'claude', command: ['claude'] }, gemini: { cli: 'agy', command: ['agy'] }, muse: { cli: 'pi', command: ['pi'] } },
};

// have: 실행되는 CLI 이름들. out: 명령별 결과 덮어쓰기('gh auth status' 등)
function deps({ have = ['git', 'gh', 'claude', 'agy', 'pi'], out = {}, env = {}, nodeVersion = '24.1.0', jev = true } = {}) {
  const calls = [];
  return {
    calls,
    env, nodeVersion, cfg: CFG,
    findJevKey: () => (jev ? { key: 'k', source: 'test' } : null),
    launcher: (name) => (have.includes(name) ? { bin: `/bin/${name}`, args: [] } : null),
    exec: (bin, args) => {
      const key = `${bin.split('/').pop()} ${args.join(' ')}`;
      calls.push(key);
      if (key in out) return out[key];
      return { status: 0, stdout: `${key} ok\n`, stderr: '' };
    },
  };
}
const byId = (res, id) => res.checks.find((c) => c.id === id);

test('#21: 모두 갖추면 통과하고, 모델 3곳을 센다', () => {
  const res = runPreflight({}, deps());
  assert.equal(res.ok, true, formatReport(res));
  assert.equal(res.providers, 3);
  assert.deepEqual(res.models.map((m) => [m.model, m.ok]), [['claude', true], ['gemini', true], ['muse', true]]);
  assert.equal(byId(res, 'repo'), undefined, '--repo 없으면 저장소 검사를 하지 않는다');
});

test(`#21: 쓸 수 있는 워커 모델이 ${MIN_PROVIDERS}곳 미만이면 실패하고 무엇을 설치할지 알린다(결정 9-3, 바뀜: 1곳)`, () => {
  assert.equal(MIN_PROVIDERS, 1);
  const one = runPreflight({}, deps({ have: ['git', 'gh', 'claude'] }));
  assert.equal(byId(one, 'providers').ok, true, '워커 모델 1곳이면 된다(리뷰어는 Jev)');
  assert.match(byId(one, 'providers').detail, /^1곳: claude$/);
  const res = runPreflight({}, deps({ have: ['git', 'gh', 'claude'], out: { 'claude --version': { status: 1, stdout: '', stderr: 'x' } } }));
  assert.equal(res.ok, false);
  const p = byId(res, 'providers');
  assert.equal(p.ok, false);
  assert.match(p.detail, /^0곳: 없음$/);
  assert.match(p.fix, /gemini\(agy\)/);
  assert.match(p.fix, /muse\(pi\)/);
  assert.match(formatReport(res), /사전 점검 실패/);
});

test('#21: 실행은 되지만 --version이 실패하는 CLI는 쓸 수 없는 것으로 센다', () => {
  const res = runPreflight({}, deps({ out: { 'agy --version': { status: 1, stdout: '', stderr: 'boom\n' }, 'pi --version': { status: 1, stdout: '', stderr: '' } } }));
  assert.equal(res.providers, 1);
  assert.equal(res.ok, true, '워커 모델 1곳(claude)이면 통과(결정 9-3 바뀜)');
  assert.equal(res.models.find((m) => m.model === 'gemini').ok, false);
  assert.equal(res.models.find((m) => m.model === 'gemini').detail, 'boom');
});

test('#21: node 버전, git, gh 설치와 로그인을 확인한다', () => {
  assert.equal(byId(runPreflight({}, deps({ nodeVersion: '20.11.0' })), 'node').ok, false);
  assert.equal(byId(runPreflight({}, deps({ have: ['gh', 'claude', 'agy'] })), 'git').ok, false);
  const noGh = runPreflight({ repo: 'owner/x' }, deps({ have: ['git', 'claude', 'agy'] }));
  assert.equal(byId(noGh, 'gh').ok, false);
  assert.equal(byId(noGh, 'gh-auth'), undefined);
  assert.equal(byId(noGh, 'repo').ok, false, 'gh가 없으면 저장소도 확인하지 못한 것으로 실패');
  const noAuth = runPreflight({}, deps({ out: { 'gh auth status': { status: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts.\n' } } }));
  assert.equal(byId(noAuth, 'gh-auth').ok, false);
  assert.match(byId(noAuth, 'gh-auth').fix, /gh auth login/);
});

test('#21: --repo는 지정 저장소가 PRIVATE일 때만 통과한다', () => {
  const v = (vis) => ({ 'gh repo view owner/x --json visibility -q .visibility': { status: 0, stdout: `${vis}\n`, stderr: '' } });
  assert.equal(byId(runPreflight({ repo: 'owner/x' }, deps({ out: v('PRIVATE') })), 'repo').ok, true);
  assert.equal(byId(runPreflight({ repo: 'owner/x' }, deps({ out: v('PUBLIC') })), 'repo').ok, false);
  const missing = runPreflight({ repo: 'owner/x' }, deps({ out: { 'gh repo view owner/x --json visibility -q .visibility': { status: 1, stdout: '', stderr: 'Could not resolve\n' } } }));
  assert.equal(byId(missing, 'repo').ok, false);
  assert.equal(byId(missing, 'repo').detail, 'Could not resolve');
  // 결정 8-28: 없으면 setup --create-repo가 만들어 준다고 알리고, 공개 저장소는 만들어 주지 않는다고 따로 적는다
  const fix = byId(missing, 'repo').fix;
  assert.match(fix, /gh repo create owner\/x --private/);
  assert.match(fix, /--create-repo/);
  assert.match(fix, /저장소가 없으면/);
  assert.match(fix, /공개인 저장소는 만들어 주지 않으니/);
});

test('#21: HARNESS_CLAUDE_BIN이 .cmd이면 실패하고 .exe면 통과한다(Windows npm 셔틀 문제)', () => {
  const bad = runPreflight({}, deps({ env: { HARNESS_CLAUDE_BIN: 'C:/npm/claude.cmd' } }));
  assert.equal(byId(bad, 'claude-bin').ok, false);
  assert.match(byId(bad, 'claude-bin').fix, /claude\.exe/);
  assert.equal(byId(runPreflight({}, deps({ env: { HARNESS_CLAUDE_BIN: 'C:/npm/claude.exe' } })), 'claude-bin').ok, true);
  assert.equal(byId(runPreflight({}, deps()), 'claude-bin'), undefined);
});

test('#21: claude CLI는 코디네이터 검사와 모델 검사에서 한 번만 실행한다', () => {
  const d = deps();
  runPreflight({}, d);
  assert.equal(d.calls.filter((c) => c === 'claude --version').length, 1);
});

test('#21: 명령줄 사용법 오류는 종료 코드 2', () => {
  for (const args of [['--bogus'], ['--repo'], ['--repo', 'not a repo']]) {
    const r = spawnSync(process.execPath, [join(harnessDir, 'preflight.mjs'), ...args], { encoding: 'utf8' });
    assert.equal(r.status, 2, args.join(' '));
  }
});

test('#44: Jev 키가 없으면 실패하고, 있으면 출처만 보이고 값은 보이지 않는다', () => {
  const none = runPreflight({}, deps({ jev: false }));
  assert.equal(none.ok, false);
  assert.equal(byId(none, 'jev-key').ok, false);
  assert.match(byId(none, 'jev-key').fix, /TYPESAFE_API_KEY/);
  const ok = runPreflight({}, deps());
  assert.equal(byId(ok, 'jev-key').detail, '있음(test)');
  assert.ok(!JSON.stringify(ok).includes('"k"'), '키 값은 결과에 없다');
});

test('#26: Pi로 띄우는 모델은 pi auth check --model로 계정 준비까지 본다', () => {
  const cfg = { allowedModels: ['claude', 'muse'], runners: { claude: { cli: 'pi', command: ['pi'], modelId: 'anthropic/claude-x' }, muse: { cli: 'pi', command: ['pi'], modelId: 'meta/muse-x' } } };
  const d = deps({ out: { 'pi auth check --model anthropic/claude-x': { status: 1, stdout: 'not_ready\n', stderr: '' } } });
  const res = runPreflight({}, { ...d, cfg });
  assert.deepEqual(res.models.map((m) => [m.model, m.ok]), [['claude', false], ['muse', true]]);
  assert.match(res.models[0].detail, /not_ready.*pi auth login/);
  assert.equal(res.providers, 1);
});

test('#26: secretEnv가 있는 모델은 비밀값이 없으면 쓸 수 없고, 있으면 확인 명령에만 넘기며 결과에 값이 없다', () => {
  const cfg = { allowedModels: ['gemini'], runners: { gemini: { cli: 'pi', command: ['pi'], modelId: 'google/g', secretEnv: ['GEMINI_API_KEY'] } } };
  const none = runPreflight({}, { ...deps(), cfg, readSecret: () => null });
  assert.equal(none.models[0].ok, false);
  assert.match(none.models[0].detail, /GEMINI_API_KEY 없음/);
  const seenEnv = [];
  const d = deps();
  const exec = d.exec;
  const res = runPreflight({}, { ...d, cfg, readSecret: () => ({ value: 'g-secret', source: 'test' }), exec: (bin, args, t, extra) => { seenEnv.push(extra); return exec(bin, args); } });
  assert.equal(res.models[0].ok, true);
  assert.ok(seenEnv.some((e) => e?.GEMINI_API_KEY === 'g-secret'));
  assert.ok(!JSON.stringify(res).includes('g-secret'));
});
