// 이슈 #20: verify.mjs의 일반 검사는 메모 예제가 아닌 대상 프로젝트에서도 돌고, 메모 검사는 --example memo로만 돈다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const harnessDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const fwd = (p) => p.replace(/\\/g, '/');
const g = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { encoding: 'utf8' });

const issue = (n) => ({
  number: n, title: `작업 ${n}`, state: 'CLOSED', createdAt: '2026-11-19T01:00:00Z',
  body: '## 지시 원문\n> 무엇\n\n## 완료 기준\n| 기준 | 확인 방법 |\n|---|---|\n| a | b |\n\n- 워커 모델: claude\n',
  comments: [
    { body: '## 결과 보고서\n기준별 충족 여부\n근거 위치\n변경 요약\n남은 문제\n- 실제 워커 모델: claude\n' },
    { body: '## 리뷰어 판정: 허용\n리뷰어 모델: gemini\n' },
    { body: '## 코디네이터 대조 결과\n맞음\n' },
  ],
});

function makeRun() {
  const root = mkdtempSync(join(tmpdir(), 'verify-'));
  const run = fwd(join(root, 'run'));
  const project = `${run}/shop`;
  mkdirSync(project, { recursive: true });
  g(project, 'init', '-q', '-b', 'main');
  writeFileSync(`${project}/a.txt`, 'a\n');
  g(project, 'add', '-A');
  g(project, 'commit', '-q', '-m', 'init');
  g(project, 'branch', 'h1/issue-5');
  g(project, 'branch', 'h1/issue-6');
  const bare = fwd(join(root, 'issues.git'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const clone = `${run}/issues`;
  mkdirSync(`${clone}/records`, { recursive: true });
  g(clone, 'init', '-q', '-b', 'main');
  writeFileSync(`${clone}/records/shop.md`, '# 기록 문서: shop\n\n- 2026-11-19 전달 예정: #5, #6\n- 2026-11-19 최종 보고: #5, #6\n');
  g(clone, 'add', '-A');
  g(clone, 'commit', '-q', '-m', 'records');
  g(clone, 'remote', 'add', 'origin', bare);
  g(clone, 'push', '-q', '-u', 'origin', 'main');
  writeFileSync(`${run}/harness.json`, JSON.stringify({ designatedRepo: 'owner/harness-issues', issuesClone: clone, targetProject: project, projectName: 'shop', runDir: run }));
  const issues = `${root}/issues.json`;
  writeFileSync(issues, JSON.stringify([issue(5), issue(6)]));
  const fakeGh = `${root}/gh.mjs`;
  writeFileSync(fakeGh, `import { readFileSync } from 'node:fs';\nprocess.stdout.write(readFileSync(${JSON.stringify(issues)}, 'utf8'));\n`);
  return { run, fakeGh };
}

const verify = ({ run, fakeGh }, extra = []) => spawnSync(process.execPath, [join(harnessDir, 'e2e', 'verify.mjs'), '--run', run, '--since', '2026-11-19T00:00:00Z', ...extra],
  { encoding: 'utf8', env: { ...process.env, HARNESS_GH_BIN: fakeGh } });

test('#20: 메모가 아닌 대상 프로젝트에서 일반 검사가 모두 통과하고 메모 검사는 돌지 않는다', () => {
  const ctx = makeRun();
  const r = verify(ctx);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /records\/shop\.md에 "최종 보고" 줄/);
  assert.match(r.stdout, /--test-cmd가 없어 건너뜀/);
  assert.doesNotMatch(r.stdout, /정렬|--sort/);
});

test('#20: --test-cmd는 대상 프로젝트 main에서 돌고 실패하면 검사가 실패한다', () => {
  const ctx = makeRun();
  assert.equal(verify(ctx, ['--test-cmd', 'node -e "process.exit(0)"']).status, 0);
  const r = verify(ctx, ['--test-cmd', 'node -e "process.exit(3)"']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL {2}\(반영 뒤\) 대상 프로젝트 main에서 시험 통과/);
});

test('#20: --example memo는 메모 정렬 검사를 더한다(메모가 아니면 실패)', () => {
  const r = verify(makeRun(), ['--example', 'memo']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL {2}\(반영 뒤\) main에 정렬 테스트가 있음/);
});

test('#20: 모르는 예제 이름이나 빈 인자는 종료 코드 2', () => {
  const ctx = makeRun();
  assert.equal(verify(ctx, ['--example', 'shop']).status, 2);
  assert.equal(verify(ctx, ['--test-cmd']).status, 2);
});
