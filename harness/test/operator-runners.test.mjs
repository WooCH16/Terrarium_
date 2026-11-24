import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadOperatorConfig, ConfigError } from '../operator/config.mjs';
import { resolveModel, runnerCommand, publicOkOf, ModelBlockedError } from '../operator/runners.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const base = loadOperatorConfig(join(here, '..', 'operator', 'operator.config.json'));
// 이 파일은 대체(fallback) 규칙을 시험한다. makeCfg는 옛 설정(claude만 허용, 대체표 있음)이고, 순환 시험은 기본 설정(base: 세 모델, 순환 대체 표)을 쓴다.
const makeCfg = (over = {}) => ({ ...structuredClone(base), allowedModels: ['claude'], fallback: { gemini: 'claude', muse: 'claude' }, ...over });
const all = () => true;

test('허용되고 CLI가 있으면 그대로 쓴다', () => {
  const r = resolveModel('claude', makeCfg(), all);
  assert.deepEqual(r, { model: 'claude' });
});

test('허용 목록 밖이면 fallback으로 대체하고 이유를 돌려준다', () => {
  const r = resolveModel('muse', makeCfg(), all);
  assert.equal(r.model, 'claude');
  assert.equal(r.replacedFrom, 'muse');
  assert.match(r.reason, /허용 목록 밖/);
});

test('허용 모델인데 CLI가 없으면 fallback으로 대체한다', () => {
  const cfg = makeCfg({ allowedModels: ['claude', 'muse'] });
  const r = resolveModel('muse', cfg, (m) => m !== 'muse');
  assert.equal(r.model, 'claude');
  assert.equal(r.replacedFrom, 'muse');
  assert.match(r.reason, /CLI 없음/);
});

const throwsMsg = (fn, re) => assert.throws(fn, (e) => e instanceof ConfigError && re.test(e.message));
const WP = { worktree: '/w', promptFile: '/p' };

test('대체 모델도 CLI가 없으면 ConfigError(대체 모델 ... 쓸 수 없음)', () => {
  const cfg = makeCfg({ allowedModels: ['claude', 'muse'] });
  throwsMsg(() => resolveModel('muse', cfg, () => false), /대체 모델 claude도 쓸 수 없습니다/);
});

test('대체 모델이 허용 목록에 없으면 ConfigError(대체 모델 ... 쓸 수 없음)', () => {
  const cfg = makeCfg({ fallback: { muse: 'gemini' } });
  throwsMsg(() => resolveModel('muse', cfg, all), /대체 모델 gemini도 쓸 수 없습니다/);
});

// 소유자 결정 5-3: 대체 표는 순환형이다. 대체 모델도 쓸 수 없으면 표를 따라 다음 모델로 간다(예전의 "한 단계만"을 바꿨다).
test('대체는 표를 따라 이어진다: 대체 모델이 허용돼 있으나 CLI가 없으면 그 fallback(claude)로 간다', () => {
  const cfg = makeCfg({
    allowedModels: ['claude', 'gemini'],
    fallback: { muse: 'gemini', gemini: 'claude' },
  });
  const avail = (m) => m === 'claude';
  const r = resolveModel('muse', cfg, avail);
  assert.equal(r.model, 'claude');
  assert.equal(r.replacedFrom, 'muse');
  assert.deepEqual(r.skipped, ['gemini(쓸 수 없음)']);
});

test('기본 설정의 대체 표는 claude → gemini → muse → claude 순환이다', () => {
  assert.deepEqual(base.fallback, { claude: 'gemini', gemini: 'muse', muse: 'claude' });
  assert.equal(base.runners.muse.publicOnly, true, '공개 기본 설정은 muse 공개 제한을 켠다(8-6은 실행 폴더의 로컬 설정에서만 끈다)');
});

test('순환: 지정 모델 CLI가 없으면 표의 다음 모델, 그것도 없으면 그다음 모델', () => {
  assert.deepEqual(resolveModel('claude', base, (m) => m !== 'claude'), { model: 'gemini', replacedFrom: 'claude', reason: 'claude CLI 없음' });
  const r = resolveModel('gemini', base, (m) => m === 'claude', { publicOk: true });
  assert.equal(r.model, 'claude');
  assert.deepEqual(r.skipped, ['muse(쓸 수 없음)']);
});

test('순환이 한 바퀴 돌아 지정 모델로 돌아오면 멈추고 ConfigError(모두 쓸 수 없음)', () => {
  throwsMsg(() => resolveModel('claude', base, () => false), /대체 모델 gemini, muse도 쓸 수 없습니다/);
});

// 공개 제한 장치는 publicOnly: true를 켠 설정으로 본다(기본 설정은 소유자 결정 8-6으로 꺼져 있다).
const gated = structuredClone(base);
gated.runners.muse.publicOnly = true;

test('제한을 끈 설정(로컬 설정, 8-6): 공개 가능 표시가 없어도 muse로 대체한다', () => {
  const open = structuredClone(base);
  open.runners.muse.publicOnly = false;
  const r = resolveModel('gemini', open, (m) => m !== 'gemini', { publicOk: false });
  assert.equal(r.model, 'muse');
  assert.equal('skipped' in r, false);
});

test('publicOnly를 켜면 muse로 대체: 이슈에 공개 가능 표시가 있을 때만 쓴다', () => {
  const avail = (m) => m === 'muse';
  assert.equal(resolveModel('gemini', gated, avail, { publicOk: true }).model, 'muse');
  // 표시가 없으면 muse를 건너뛰고 다음(claude)으로 간다.
  const r = resolveModel('gemini', gated, (m) => m !== 'gemini', { publicOk: false });
  assert.equal(r.model, 'claude');
  assert.deepEqual(r.skipped, ['muse(공개 가능 표시 없음)']);
});

test('muse를 건너뛰고 남은 모델이 없으면 ModelBlockedError(막힘), ConfigError가 아니다', () => {
  assert.throws(() => resolveModel('gemini', gated, (m) => m === 'muse'), (e) => e instanceof ModelBlockedError && !(e instanceof ConfigError) && /공개 가능 표시 없음/.test(e.message));
});

test('지정 모델이 muse면 공개 가능 표시 없이도 그대로 쓴다(대체가 아니다)', () => {
  assert.deepEqual(resolveModel('muse', base, () => true), { model: 'muse' });
});

test('publicOkOf: `공개 가능: 예` 한 줄만 인정한다', () => {
  assert.equal(publicOkOf('목표\n- 공개 가능: 예\n'), true);
  assert.equal(publicOkOf('공개 가능: `예`'), true);
  assert.equal(publicOkOf('공개 가능: 아니오'), false);
  assert.equal(publicOkOf('공개 가능: 예 (아마)'), false);
  assert.equal(publicOkOf('공개 가능: 예\n공개 가능: 예'), false, '여러 줄이면 인정하지 않는다');
  assert.equal(publicOkOf('공개 가능: 예\n공개 가능: 아니오'), false);
  assert.equal(publicOkOf('본문에 공개 가능: 예 라고 섞인 문장'), false);
  assert.equal(publicOkOf(''), false);
  assert.equal(publicOkOf(undefined), false);
});

test('fallback 항목이 없으면 ConfigError(대체 모델(fallback)도 없음)', () => {
  const cfg = makeCfg({ fallback: {} });
  throwsMsg(() => resolveModel('muse', cfg, all), /대체 모델\(fallback\)도 없습니다/);
});

test('모르는 모델 이름은 ConfigError(알 수 없는 모델)이고 대체하지 않는다', () => {
  const cfg = makeCfg({ fallback: { mystery: 'claude' } });
  throwsMsg(() => resolveModel('mystery', cfg, all), /알 수 없는 모델/);
});

test('빈 문자열/비문자열 요청은 ConfigError(문자열이어야 함)', () => {
  throwsMsg(() => resolveModel('', makeCfg(), all), /비어 있지 않은 문자열/);
  throwsMsg(() => resolveModel(undefined, makeCfg(), all), /비어 있지 않은 문자열/);
});

test('공백만 있는 이름은 알 수 없는 모델', () => {
  throwsMsg(() => resolveModel('   ', makeCfg(), all), /알 수 없는 모델/);
});

test('프로토타입 이름(__proto__, constructor, toString)은 알 수 없는 모델', () => {
  for (const name of ['__proto__', 'constructor', 'toString']) {
    throwsMsg(() => resolveModel(name, makeCfg(), all), /알 수 없는 모델/);
    throwsMsg(() => runnerCommand(name, WP, makeCfg()), /알 수 없는 모델/);
  }
});

test('자기 자신을 가리키는 fallback은 연쇄 없이 ConfigError', () => {
  const cfg = makeCfg({ allowedModels: ['claude', 'muse'], fallback: { muse: 'muse' } });
  throwsMsg(() => resolveModel('muse', cfg, (m) => m !== 'muse'), /대체 모델 muse도 쓸 수 없습니다/);
});

test('fallback 대상이 runners에 없으면 허용 목록에 있어도 ConfigError', () => {
  const cfg = makeCfg({ allowedModels: ['claude', 'ghost'], fallback: { muse: 'ghost' } });
  throwsMsg(() => resolveModel('muse', cfg, all), /대체 모델 ghost도 쓸 수 없습니다/);
});

test('available이 함수가 아니면 ConfigError', () => {
  throwsMsg(() => resolveModel('claude', makeCfg(), undefined), /available.*함수/);
});

test('runnerCommand: bin은 command[0], 나머지는 args', () => {
  const r = runnerCommand('claude', { worktree: '/w', promptFile: '/p.md' }, makeCfg());
  assert.equal(r.bin, base.runners.claude.command[0]);
  assert.deepEqual(r.args, base.runners.claude.command.slice(1));
});

test('runnerCommand: {worktree}, {promptFile} 토큰을 통째로 치환한다', () => {
  const cfg = makeCfg();
  cfg.runners.claude = { command: ['claude', '--cwd', '{worktree}', '--file', '{promptFile}', 'x{worktree}'] };
  const r = runnerCommand('claude', { worktree: '/w', promptFile: '/p.md' }, cfg);
  assert.deepEqual(r.args, ['--cwd', '/w', '--file', '/p.md', 'x{worktree}']);
});

test('runnerCommand: 허용되지 않은 모델은 ConfigError(허용 목록 밖)', () => {
  throwsMsg(() => runnerCommand('muse', WP, makeCfg()), /허용 목록 밖의 모델은 실행할 수 없습니다/);
});

test('runnerCommand: 모르는 모델은 ConfigError(알 수 없는 모델)', () => {
  throwsMsg(() => runnerCommand('nope', WP, makeCfg()), /알 수 없는 모델/);
});

test('runnerCommand: command가 비어 있으면 ConfigError', () => {
  const cfg = makeCfg();
  cfg.runners.claude = { command: [] };
  throwsMsg(() => runnerCommand('claude', WP, cfg), /command가 비어 있습니다/);
});
