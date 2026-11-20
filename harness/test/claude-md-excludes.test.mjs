// 이슈 #22: 사용자 전역 CLAUDE.md와 상위 폴더의 CLAUDE.md가 하네스 세션에 섞이지 않게 claudeMdExcludes를 넣는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claudeMdExcludes, sessionSettings } from '../operator/launch.mjs';

const harnessDir = join(dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/');
const fwd = (p) => p.replace(/\\/g, '/');

test('#22: 전역 CLAUDE.md·rules와 상위 폴더마다의 CLAUDE.md를 빼고, 그 폴더 자신의 것은 남긴다', () => {
  const ex = claudeMdExcludes('C:/a/b/run', 'C:/Users/u');
  assert.deepEqual(ex.slice(0, 2), ['C:/Users/u/.claude/CLAUDE.md', 'C:/Users/u/.claude/rules/**']);
  for (const p of ['C:/a/b/CLAUDE.md', 'C:/a/b/CLAUDE.local.md', 'C:/a/CLAUDE.md', 'C:/CLAUDE.md']) assert.ok(ex.includes(p), p);
  assert.ok(!ex.some((p) => p.startsWith('C:/a/b/run/')), '세션 폴더 자신의 CLAUDE.md는 남는다');
  assert.ok(!ex.some((p) => p.includes('//')), ex.join(' '));
});

test('#22: setup이 만든 코디네이터 설정에 claudeMdExcludes가 있다', () => {
  const run = fwd(join(mkdtempSync(join(tmpdir(), 'cme-')), 'run'));
  const r = spawnSync(process.execPath, [join(harnessDir, 'setup.mjs'), '--run', run, '--repo', 'owner/harness-issues', '--no-clone'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(readFileSync(`${run}/.claude/settings.json`, 'utf8'));
  assert.ok(s.claudeMdExcludes.includes(`${fwd(homedir())}/.claude/CLAUDE.md`));
  assert.ok(s.claudeMdExcludes.includes(`${fwd(dirname(run))}/CLAUDE.md`));
  assert.ok(!s.claudeMdExcludes.includes(`${run}/CLAUDE.md`), '코디네이터 규칙은 남는다');
});

test('#22: 오퍼레이터·워커 세션 설정에도 claudeMdExcludes가 있다', () => {
  const run = fwd(mkdtempSync(join(tmpdir(), 'cme-run-')));
  const op = sessionSettings({ mode: 'work', handoff: 'h1', run, harnessDir });
  assert.ok(op.claudeMdExcludes.includes(`${fwd(homedir())}/.claude/CLAUDE.md`));
  const wt = `${run}/worktrees/h1-issue-3`;
  const w = sessionSettings({ mode: 'worker', handoff: 'h1', run, harnessDir, issue: 3, worktree: wt });
  assert.ok(w.claudeMdExcludes.includes(`${run}/worktrees/CLAUDE.md`));
  assert.ok(!w.claudeMdExcludes.includes(`${wt}/CLAUDE.md`), '대상 프로젝트 자신의 CLAUDE.md는 워커가 읽는다');
});
