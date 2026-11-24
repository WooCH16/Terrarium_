// 결정 8-32, workflow.md 부록 B S9: 훅이 처음으로 push를 허용하므로(스크립트 안에서만) 허용 밖 push·PR 쓰기·워크플로 실행을 모두 거부하는지 크게 본다.
// 허용: 코디네이터의 node <하네스>/operator/push-branch.mjs --branch <두 모양>과 run-train.mjs --handoffs <h 목록>뿐.
// 거부: 모든 역할의 직접 git push, gh pr create|merge|edit|close|comment(읽기 포함 직접 gh pr), gh workflow run, gh run, gh api, 잘못된 브랜치 모양.
// "사용자 승인 뒤에만 run-train"은 훅이 아니라 코디네이터 규칙이 지킨다(run-reflect와 같다): 훅은 승인 여부를 모른다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, PUSH_BRANCH, TRAIN_HANDOFFS } from '../policy.mjs';

const run = 'C:/run';
const hd = 'C:/src/Terrarium/harness';
const base = { designatedRepo: 'owner/harness-issues', issuesClone: `${run}/issues`, targetProject: `${run}/memo`, harnessDir: hd, runDir: run, targetRepo: 'owner/app', targetRemote: 'https://github.com/owner/app.git' };
const deps = { visibility: () => 'PRIVATE', readFile: () => { throw new Error('none'); }, realpath: (p) => p };
const bash = (command, config = base, extra = {}) => decide({ tool_name: 'Bash', tool_input: { command }, cwd: run, ...extra }, config, deps);
const allow = (cmd, config, extra) => assert.equal(bash(cmd, config, extra).allow, true, `허용되어야 함: ${cmd} → ${bash(cmd, config, extra).reason}`);
const refuse = (cmd, config, extra) => assert.equal(bash(cmd, config, extra).allow, false, `거부되어야 함: ${cmd}`);

const PB = `node ${hd}/operator/push-branch.mjs`;
const RT = `node ${hd}/operator/run-train.mjs`;

const DIRECT = [
  // 직접 push(어느 브랜치든)
  'git push origin main', 'git push origin HEAD:main', 'git push origin train/20261122-1', 'git push origin feature/x', 'git push origin h1/issue-1',
  'git push origin integration/h1', 'git push --force origin main', `git -C ${run}/memo push origin h1/issue-1`, `git -C ${run}/memo push https://github.com/owner/app.git main`,
  `git -C ${run}/worktrees/h1/integration push origin integration/h1`,
  // PR 쓰기와 읽기(하네스는 스크립트로만 읽는다)
  'gh pr create --repo owner/app --base main --head h1/issue-1 --title t --body b', 'gh pr merge 3 --repo owner/app --merge', 'gh pr edit 3 --repo owner/app --title x',
  'gh pr close 3 --repo owner/app', 'gh pr comment 3 --repo owner/app --body x', 'gh pr view 3 --repo owner/app', 'gh pr checks 3 --repo owner/app', 'gh pr list --repo owner/app',
  // 워크플로 실행(트레인 포함, 다른 저장소·다른 워크플로)
  'gh workflow run harness-train.yml --repo owner/app --ref main -f handoffs=h1', 'gh workflow run harness-train.yml --repo other/repo -f handoffs=h1',
  'gh workflow run deploy.yml --repo owner/app', 'gh workflow enable harness-train.yml --repo owner/app', 'gh run rerun 5 --repo owner/app', 'gh run view 5 --repo owner/app --log',
  'gh api repos/owner/app/merges -f base=main -f head=h1/issue-1', 'gh api -X PUT repos/owner/app/pulls/3/merge',
];

test('S9: 코디네이터도 직접 push·PR·워크플로 실행은 모두 거부', () => {
  for (const c of DIRECT) refuse(c);
  // 거부 이유가 스크립트를 가리킨다
  assert.match(bash('gh pr create --repo owner/app').reason, /push-branch\.mjs/);
  assert.match(bash('gh workflow run harness-train.yml --repo owner/app').reason, /사용자 승인 뒤/);
  assert.match(bash('git push origin main').reason, /push-branch\.mjs/);
  // 지정 저장소 클론의 push(기록 문서)는 지금처럼 허용
  allow(`git -C ${run}/issues push`);
});

test('S9: 코디네이터의 push-branch는 이슈 브랜치·통합 브랜치 두 모양만', () => {
  for (const b of ['h1/issue-2', 'h12/issue-345', 'integration/h3']) allow(`${PB} --branch ${b}`);
  for (const b of ['main', 'train/20261122-1', 'feature/x', 'integration/h0', 'h0/issue-1', 'h1/issue-0', 'h1/issue-01', 'integration/main', 'H1/issue-1', 'h1/issue-1/x', 'refs/heads/main', '+h1/issue-1', 'h1/issue-1:main', 'integration/h1:main']) {
    refuse(`${PB} --branch ${b}`);
  }
  refuse(PB);
  refuse(`${PB} --branch h1/issue-1 --branch h1/issue-2`);
  refuse(`${PB} --branch h1/issue-1 --force`);
  refuse(`${PB} --branch h1/issue-1 --remote https://example.invalid/x.git`);
  refuse(`${PB} --branch "h1/issue-1;git push origin main"`);
  refuse(`${PB} --branch h1/issue-1 && git push origin main`);
  refuse(`node ${run}/memo/push-branch.mjs --branch h1/issue-1`, base);
  refuse(`node C:/elsewhere/harness/operator/push-branch.mjs --branch h1/issue-1`);
});

test('S9: 코디네이터의 run-train은 하달 목록 한 모양만(승인 여부는 규칙이 지킨다)', () => {
  for (const l of ['h1', 'h24,h25', 'h1,h2,h3']) allow(`${RT} --handoffs ${l}`);
  for (const l of ['main', 'h1;h2', 'h1,,h2', 'h0', 'h1,main', 'train/1', '1,2', `${Array.from({ length: 11 }, (_, i) => `h${i + 1}`).join(',')}`]) refuse(`${RT} --handoffs ${l}`);
  refuse(RT);
  refuse(`${RT} --handoffs h1 --merge-partial`);
  refuse(`${RT} --handoff h1`);
});

test('S9: 다른 역할(작업·조사·반영 오퍼레이터, 워커, 어드바이저)은 두 스크립트도 직접 push·PR도 못 한다', () => {
  const roles = [
    { ...base, role: 'operator-work', handoff: 'h1' },
    { ...base, role: 'operator-research', handoff: 'h1', issue: 4 },
    { ...base, role: 'operator-reflect', handoff: 'h1' },
  ];
  const scripts = [`${PB} --branch h1/issue-1`, `${PB} --branch integration/h1`, `${RT} --handoffs h1`];
  for (const config of roles) {
    for (const c of [...scripts, ...DIRECT]) refuse(c, config);
  }
  const worker = { ...base, role: 'operator-work', handoff: 'h1', worktree: `${run}/worktrees/h1/issue-1` };
  for (const c of [...scripts, ...DIRECT]) refuse(c, worker, { agent_type: 'worker', cwd: `${run}/worktrees/h1/issue-1` });
  for (const c of [...scripts, ...DIRECT]) refuse(c, base, { agent_type: 'advisor' });
});

test('8-35: 강제 push는 push-branch 안에서만(다시 만든 integration/h<N>, --force-with-lease). 직접 강제 push와 강제 플래그는 모두 거부', async () => {
  const FORCE = [
    'git push --force-with-lease origin integration/h1', `git push --force-with-lease=refs/heads/integration/h1:${'a'.repeat(40)} origin integration/h1:integration/h1`,
    'git push origin +integration/h1', 'git push origin +integration/h1:integration/h1', 'git push -f origin integration/h1', 'git push --force origin h1/issue-1',
    `git -C ${run}/memo push --force-with-lease origin integration/h1`, 'git push --force-with-lease origin main', 'git push origin +main',
  ];
  const roles = [base, { ...base, role: 'operator-work', handoff: 'h1' }, { ...base, role: 'operator-reflect', handoff: 'h1' }];
  for (const config of roles) for (const c of FORCE) refuse(c, config);
  for (const flag of ['--force', '--force-with-lease', '--rebuild', '-f', '--lease']) {
    refuse(`${PB} --branch integration/h1 ${flag}`);
    refuse(`${PB} ${flag} --branch integration/h1`);
  }
  refuse(`${PB} --branch +integration/h1`);
  allow(`${PB} --branch integration/h1`);
  // 스크립트의 강제 push 인자는 integration/h<N>에서만 나온다
  const { forcePushArgs, parseArgs } = await import('../operator/push-branch.mjs');
  assert.throws(() => parseArgs(['--branch', 'integration/h1', '--force-with-lease']), /사용법/);
  for (const b of ['h1/issue-1', 'main', 'train/20261122-1']) assert.throws(() => forcePushArgs('origin', b, 'a'.repeat(40)));
  assert.match(forcePushArgs('origin', 'integration/h1', 'a'.repeat(40)).join(' '), /^push --porcelain --force-with-lease=refs\/heads\/integration\/h1:a{40} origin /);
});

test('S9: 정규식은 스크립트와 훅이 같은 것을 쓴다', async () => {
  const { parseArgs } = await import('../operator/push-branch.mjs');
  const { parseArgs: trainArgs } = await import('../operator/run-train.mjs');
  for (const b of ['h1/issue-2', 'integration/h3', 'main', 'train/x', 'feature/x']) {
    let ok = true;
    try { parseArgs(['--branch', b]); } catch { ok = false; }
    assert.equal(ok, PUSH_BRANCH.test(b), b);
  }
  for (const l of ['h1,h2', 'h1;h2', 'main']) {
    let ok = true;
    try { trainArgs(['--handoffs', l]); } catch { ok = false; }
    assert.equal(ok, TRAIN_HANDOFFS.test(l), l);
  }
  assert.throws(() => trainArgs(['--handoffs', 'h1,h1']), /두 번/);
});
