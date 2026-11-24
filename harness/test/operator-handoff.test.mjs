import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nextHandoff, handoffNames, ownsPath } from '../operator/handoff.mjs';

const tmpRun = () => mkdtempSync(join(tmpdir(), 'op-handoff-')).replace(/\\/g, '/');

test('nextHandoff는 h1, h2를 차례로 점유한다', () => {
  const run = tmpRun();
  assert.equal(nextHandoff(run), 'h1');
  assert.equal(nextHandoff(run), 'h2');
  assert.ok(existsSync(`${run}/handoffs/h1`));
  assert.ok(existsSync(`${run}/handoffs/h2`));
});

test('nextHandoff는 이미 있는 번호를 건너뛴다', () => {
  const run = tmpRun();
  mkdirSync(`${run}/handoffs/h1`, { recursive: true });
  assert.equal(nextHandoff(run), 'h2');
});

test('handoffNames는 고정 이름 규칙을 따른다', () => {
  const run = '/tmp/run';
  const n = handoffNames('h1', 7, run);
  assert.equal(n.integrationBranch, 'integration/h1');
  assert.equal(n.issueBranch, 'h1/issue-7');
  assert.equal(n.worktree, `${run}/worktrees/h1/issue-7`);
  assert.equal(n.integrationFolder, `${run}/worktrees/h1/integration`);
  assert.equal(n.logDir, `${run}/logs/h1`);
  assert.equal(n.sessionFile, `${run}/handoffs/h1/session.json`);
});

test('handoffNames는 issue가 null이면 issueBranch와 worktree가 null', () => {
  const n = handoffNames('h2', null, '/tmp/run');
  assert.equal(n.issueBranch, null);
  assert.equal(n.worktree, null);
  assert.equal(n.integrationBranch, 'integration/h2');
});

test('ownsPath는 자기 worktree와 로그 폴더만 소유한다', () => {
  const run = '/tmp/run';
  assert.equal(ownsPath('h1', `${run}/worktrees/h1/issue-7/a.txt`, run), true);
  assert.equal(ownsPath('h1', `${run}/worktrees/h1`, run), true);
  assert.equal(ownsPath('h1', `${run}/logs/h1/x.log`, run), true);
  assert.equal(ownsPath('h1', `${run}/worktrees/h10/issue-7/a.txt`, run), false);
  assert.equal(ownsPath('h1', `${run}/logs/h10/x.log`, run), false);
  assert.equal(ownsPath('h1', `${run}/worktrees/h1/../h2/x`, run), false);
  assert.equal(ownsPath('h1', `${run}/worktrees/h2/x`, run), false);
});

test('ownsPath는 대소문자와 역슬래시를 같게 본다', () => {
  const run = 'C:/Run';
  assert.equal(ownsPath('H1', 'c:\\run\\worktrees\\h1\\issue-1\\a.txt', run), true);
  assert.equal(ownsPath('h1', `${run}/Worktrees/H1/x`, run), true);
});
