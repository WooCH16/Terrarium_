import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLimits } from '../lib/limits.mjs';

test('한도 창: 읽을 수 있는 한도는 막대로, 못 읽는 계정은 상태와 이유만', () => {
  const rows = buildLimits({
    status: { fiveHour: { pct: 8, resetsAt: 1795519200 }, sevenDay: { pct: 53, resetsAt: 1795651200 }, context: 8 },
    gh: { limit: 5000, remaining: 4871, reset: 1795504880 },
    pi: { anthropic: { status: 'ready', authType: 'oauth' }, meta: { status: 'not_ready' } },
    keys: { TYPESAFE_API_KEY: true, GEMINI_API_KEY: false },
  });
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.deepEqual(rows.map((r) => r.name), ['Claude', 'GitHub', 'Pi · Anthropic', 'Pi · Meta', 'Gemini', 'Jev(TypeSafe)']);
  assert.deepEqual(by.Claude.meters.map((m) => [m.label, m.pct]), [['5시간 한도', 8], ['주간 한도', 53], ['코디네이터 컨텍스트', 8]]);
  assert.equal(by.GitHub.meters[0].label, 'API 4871/5000 남음');
  assert.equal(by.GitHub.meters[0].pct, 3);
  assert.equal(by['Pi · Anthropic'].state, '연결됨');
  assert.match(by['Pi · Anthropic'].note, /알려 주지 않습니다/);
  assert.equal(by['Pi · Meta'].state, '연결 안 됨');
  assert.equal(by.Gemini.state, '키 없음');
  assert.equal(by['Jev(TypeSafe)'].state, '키 있음');
  for (const r of rows.slice(2)) assert.equal(r.meters.length, 0, `${r.name}은 지어낸 막대가 없다`);
});

test('한도 창: 아무것도 못 읽으면 모름과 할 일을 적는다', () => {
  const rows = buildLimits({});
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.equal(by.Claude.state, '모름');
  assert.match(by.Claude.note, /첫 답/);
  assert.equal(by.GitHub.state, '모름');
  assert.equal(by['Pi · Anthropic'].state, '모름');
  assert.match(by['Pi · Anthropic'].note, /확인하지 못했습니다/);
  // 구독이 아니면(컨텍스트만 옴) 한도 막대가 없는 이유를 적는다
  const api = Object.fromEntries(buildLimits({ status: { context: 11 } }).map((r) => [r.name, r]));
  assert.equal(api.Claude.meters.length, 1);
  assert.match(api.Claude.note, /구독/);
});
