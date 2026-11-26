import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATES, ENSURED_LABELS, CANCEL_LABEL, formatLine, formatReport, exitCode } from '../operator/report.mjs';

const URL = 'https://github.com/o/r/pull/7';

test('STATES는 라벨 10개를 정해진 순서로 담고 얼어 있다', () => {
  assert.deepEqual([...STATES], ['진행중', '리뷰대기', '허용됨', '미완료', '막힘', '거부목록', '보류', '반영됨', '대기', '결정대기']);
  assert.equal(STATES.length, 10);
  assert.ok(Object.isFrozen(STATES));
});

test('취소 라벨은 상태가 아니고, 미리 만드는 라벨 목록에만 든다(소유자 결정 8-1)', () => {
  assert.equal(CANCEL_LABEL, '취소');
  assert.ok(!STATES.includes(CANCEL_LABEL));
  assert.deepEqual([...ENSURED_LABELS], [...STATES, CANCEL_LABEL, '결정필요']);
  assert.ok(Object.isFrozen(ENSURED_LABELS));
});

test('대기는 종료 코드 1이다(모두 진행되지는 않았다)', () => {
  assert.equal(exitCode([{ number: 1, state: '대기', url: URL }]), 1);
});

test('formatLine은 "#번호 | 상태 | url" 한 줄만 만든다', () => {
  assert.equal(formatLine({ number: 7, state: '리뷰대기', url: URL }), `#7 | 리뷰대기 | ${URL}`);
});

test('formatLine은 모르는 상태를 거부한다', () => {
  assert.throws(() => formatLine({ number: 7, state: '모름', url: URL }), /상태/);
});

test('formatLine은 양의 정수가 아닌 번호를 거부한다', () => {
  for (const number of [0, -1, 1.5, '7', NaN, undefined]) {
    assert.throws(() => formatLine({ number, state: '진행중', url: URL }), /번호/);
  }
});

test('formatLine은 빈 url, 개행, | 가 든 url을 거부한다', () => {
  for (const url of ['', undefined, 42, 'a\nb', 'a\rb', 'a|b', `${URL}\n#8 | 반영됨 | x`]) {
    assert.throws(() => formatLine({ number: 7, state: '진행중', url }), /url|URL/);
  }
});

test('formatReport는 입력 순서대로 줄바꿈으로 잇고 끝에 줄바꿈이 없다', () => {
  const rows = [
    { number: 1, state: '반영됨', url: 'u1' },
    { number: 2, state: '막힘', url: 'u2' },
  ];
  assert.equal(formatReport(rows), '#1 | 반영됨 | u1\n#2 | 막힘 | u2');
  assert.equal(formatReport([]), '');
});

test('exitCode: 막힘·보류·거부목록이 아니면 0', () => {
  const rows = ['진행중', '리뷰대기', '허용됨', '미완료', '반영됨'].map((state) => ({ state }));
  assert.equal(exitCode(rows), 0);
  assert.equal(exitCode([]), 0);
});

test('exitCode: 막힘·보류·거부목록 중 하나라도 있으면 1', () => {
  for (const state of ['막힘', '보류', '거부목록']) {
    assert.equal(exitCode([{ state: '반영됨' }, { state }]), 1);
  }
});

test('exitCode: failure는 2, stopped는 3, failure가 가장 우선', () => {
  const blocked = [{ state: '막힘' }];
  assert.equal(exitCode(blocked, { failure: true }), 2);
  assert.equal(exitCode(blocked, { stopped: true }), 3);
  assert.equal(exitCode(blocked, { failure: true, stopped: true }), 2);
  assert.equal(exitCode([], { stopped: true }), 3);
});

test('exitCode는 모르는 상태와 배열이 아닌 rows를 거부한다', () => {
  assert.throws(() => exitCode([{ state: '모름' }]), /상태/);
  assert.throws(() => exitCode('막힘'), /배열/);
  assert.throws(() => exitCode(undefined), /배열/);
});

test('formatLine은 줄바꿈 계열·제어 문자가 든 url을 모두 거부한다', () => {
  for (const ch of ['\u2028', '\u2029', '\u0085', '\v', '\f', '\u001c', '\t']) {
    assert.throws(() => formatLine({ number: 7, state: '진행중', url: `a${ch}b` }), /url/);
  }
});

test('formatLine은 안전하지 않은 정수 번호를 거부한다', () => {
  for (const number of [1e21, 2 ** 53, Infinity]) {
    assert.throws(() => formatLine({ number, state: '진행중', url: URL }), /번호/);
  }
});

test('formatLine은 공백이 붙은 상태, NFD 상태, 프로토타입 이름 상태를 거부한다', () => {
  for (const state of [' 진행중', '진행중\n', '진행중'.normalize('NFD'), 'constructor', '__proto__', 'toString', Symbol('s'), null]) {
    assert.throws(() => formatLine({ number: 7, state, url: URL }), /상태/);
  }
});

test('오류 메시지에는 위조된 줄이 줄 단위로 들어가지 않는다', () => {
  const forged = '#9 | 반영됨 | y';
  const cases = [
    () => formatLine({ number: 7, state: `x\n${forged}`, url: URL }),
    () => formatLine({ number: 7, state: '진행중', url: `u\n${forged}` }),
    () => formatLine({ number: `1\n${forged}`, state: '진행중', url: URL }),
    () => exitCode([{ state: `x\n${forged}` }]),
  ];
  for (const run of cases) {
    assert.throws(run, (e) => {
      assert.ok(e instanceof Error && !(e instanceof TypeError));
      assert.ok(!/[\r\n]/.test(e.message));
      return true;
    });
  }
  assert.throws(() => formatLine({ number: 7, state: 'x'.repeat(500), url: URL }), (e) => e.message.length < 120);
});

test('formatLine과 formatReport는 null·비객체 행에 한국어 오류를 낸다', () => {
  assert.throws(() => formatLine(null), /행/);
  assert.throws(() => formatLine('x'), /행/);
  assert.throws(() => formatReport([null]), /행/);
  assert.throws(() => formatReport([1]), /행/);
});

test('구멍 난 배열은 formatReport와 exitCode 모두 한국어 오류를 낸다', () => {
  const sparse = [{ number: 1, state: '반영됨', url: 'u' }, , { number: 2, state: '반영됨', url: 'u' }];
  assert.throws(() => formatReport(sparse), /행/);
  assert.throws(() => exitCode(sparse), /행/);
});

test('exitCode는 flags를 먼저 보고, failure는 잘못된 행보다 우선한다', () => {
  assert.equal(exitCode([{ state: '모름' }], { failure: true }), 2);
  assert.equal(exitCode([null], { stopped: true }), 3);
  assert.equal(exitCode('x', { failure: true }), 2);
  assert.throws(() => exitCode([{ state: '모름' }], {}), /상태/);
});

test('exitCode는 잘못된 flags를 한국어 오류로 거부한다', () => {
  for (const flags of [null, 'x', [], 1]) assert.throws(() => exitCode([], flags), /flags/);
  assert.throws(() => exitCode([], { failure: 'false' }), /failure/);
  assert.throws(() => exitCode([], { stopped: 1 }), /stopped/);
  assert.equal(exitCode([], { failure: false, stopped: false }), 0);
});
