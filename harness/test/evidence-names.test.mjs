// F10(결정 8-30): 결과 판정의 근거 칸 검사가 실행 중 생기는 파일 이름·폴더를 파일 경로로 오해하지 않는다.
// run-18 h24에서 거부된 두 보고서 모양(`memos.json`, `.harness/`)과 없는 경로(`src/없는파일.mjs`)를 본다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { reportProblems, classifyEvidence, evidencePaths, issueCriteria } from '../operator/jev-review.mjs';
import { fileCheckerAt } from '../operator/run-reviewer.mjs';

const fwd = (p) => p.split(String.fromCharCode(92)).join('/');
const made = [];
after(() => { for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 무시 */ } } });

// 보고서 커밋: src/cli.mjs, test/cli.test.mjs, README.md.
function repo() {
  const dir = fwd(mkdtempSync(`${fwd(tmpdir())}/evid-`));
  made.push(dir);
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: 'pipe' }).trim();
  g('init', '-q', '-b', 'main');
  g('config', 'user.name', 't');
  g('config', 'user.email', 't@t');
  mkdirSync(`${dir}/src`);
  mkdirSync(`${dir}/test`);
  writeFileSync(`${dir}/src/cli.mjs`, 'export {};\n');
  writeFileSync(`${dir}/test/cli.test.mjs`, 'x\n');
  writeFileSync(`${dir}/README.md`, 'x\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'c');
  const hash = g('rev-parse', 'HEAD');
  return { hash, git: (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
}

const BODY = ['## 목표', 'x', '', '## 완료 기준', '| 기준 | 확인 방법 |', '|---|---|', '| 메모를 저장한다 | `node --test` |', '| 빠른 시작이 돈다 | `node src/cli.mjs` |', '', '## 의존하는 이슈', '없음', ''].join('\n');
const report = (hash, a, b) => [
  '## 결과 보고서', `커밋 해시: ${hash}`, '', '### 기준별 충족 여부', '| 기준 | 충족 | 근거 위치 |', '|---|---|---|',
  `| 메모를 저장한다 | 충족 | ${a} |`, `| 빠른 시작이 돈다 | 충족 | ${b} |`, '', '### 근거 위치', '위 표', '', '### 변경 요약', 'x', '', '### 남은 문제', '없음', '',
].join('\n');

test('F10: h24 모양 — 실행 중 생기는 파일(`memos.json`)과 폴더(`.harness/`)는 문제로 보지 않는다', () => {
  const { hash, git } = repo();
  const r = report(hash, '`test/cli.test.mjs:3`, 실행 뒤 `memos.json`이 생김, `충족/미충족`', '`src/cli.mjs:1`, 작업 폴더 `.harness/`, `허용/거부`');
  assert.deepEqual(reportProblems({ report: r, hash, criteria: issueCriteria(BODY), fileExists: fileCheckerAt(git, hash) }), []);
  assert.ok(!evidencePaths(r).includes('.harness/'), '빗금으로 끝나는 이름은 뽑지 않는다');
});

test('F10: 빗금이 있는 경로는 그대로 있어야 한다 — `src/없는파일.mjs`는 여전히 문제', () => {
  const { hash, git } = repo();
  const r = report(hash, '`src/없는파일.mjs:4`', '`src/cli.mjs:1`');
  const problems = reportProblems({ report: r, hash, criteria: issueCriteria(BODY), fileExists: fileCheckerAt(git, hash) });
  assert.deepEqual(problems, ['근거 위치의 파일 `src/없는파일.mjs`가 보고서 커밋에 없습니다.']);
});

test('F10: 빗금 없는 이름은 커밋 안의 같은 이름을 찾는다 — 다른 폴더의 `cli.mjs`는 확인됨, `memos.json`은 뺌', () => {
  const { hash, git } = repo();
  const r = report(hash, '`cli.mjs`, `memos.json`, `README.md`', '`src/cli.mjs`, `src/없는파일.mjs`, `.harness/`');
  const c = classifyEvidence(r, fileCheckerAt(git, hash));
  assert.deepEqual(c.checked.sort(), ['README.md', 'cli.mjs', 'src/cli.mjs']);
  assert.deepEqual(c.skipped, ['memos.json']);
  assert.deepEqual(c.missing, ['src/없는파일.mjs']);
  // 이름 찾기를 할 수 없는 검사기(옛 주입 모양)면 빗금 없는 이름은 모두 뺀다.
  assert.deepEqual(classifyEvidence(r, () => true).skipped.sort(), ['README.md', 'cli.mjs', 'memos.json']);
  // 이름 찾기는 파일 목록을 한 번만 읽는다.
  let lsTree = 0;
  const counting = fileCheckerAt((args) => { if (args[0] === 'ls-tree') lsTree++; return git(args); }, hash);
  classifyEvidence(report(hash, '`a.json`, `b.json`', '`c.json`'), counting);
  assert.equal(lsTree, 1);
});
