// 이슈 #27: 시험 실행 스크립트(scripts/test.mjs)의 빠른·느린 나누기와 진짜 CLI 덫.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SLOW, pick } from '../../scripts/test.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter((f) => f.endsWith('.test.mjs')).sort();

test('#27: SLOW 목록의 파일은 모두 있고, 빠른·느린 묶음은 겹치지 않으며 합치면 전체다', () => {
  for (const f of SLOW) assert.ok(files.includes(f), f);
  const fast = pick('fast', files);
  const slow = pick('slow', files);
  assert.equal(fast.filter((f) => slow.includes(f)).length, 0);
  assert.deepEqual([...fast, ...slow].sort(), files);
  assert.ok(fast.includes('test-runner.test.mjs'));
});

test('#27: 덫은 진짜 CLI 대신 불리면 종료 코드 97로 끝나고 기록을 남긴다', () => {
  const r = spawnSync(process.execPath, [join(here, 'helpers', 'cli-trap.mjs'), '-p', 'x'], { encoding: 'utf8', env: { ...process.env, HARNESS_CLI_TRAP_LOG: '' } });
  assert.equal(r.status, 97);
  assert.match(r.stderr, /시험 덫/);
});
