// 역할 스킬(harness/<역할>/skills/<이름>/SKILL.md): 모양, 규칙 절 참조, 설치, 주입, 훅.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide } from '../policy.mjs';
import { loadModeDocs } from '../operator/launch.mjs';
import { inputText } from '../operator/run-worker.mjs';

const harnessDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROLES = ['coordinator', 'advisor', 'operator', 'worker', 'reviewer'];
const KNOWN = new Set(['{{REPO}}', '{{ISSUES}}', '{{MEMO}}', '{{PROJECT}}', '{{WORKTREES}}', '{{HARNESS}}', '{{RUN}}']);
const skills = (role) => readdirSync(join(harnessDir, role, 'skills')).map((name) => ({ role, name, text: readFileSync(join(harnessDir, role, 'skills', name, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n') }));
const all = ROLES.flatMap(skills);
const headings = (role) => new Set(readFileSync(join(harnessDir, role, 'AGENT.md'), 'utf8').split(/\r?\n/).map((l) => /^#{2,3} (.+)$/.exec(l)?.[1]).filter(Boolean));

test('역할마다 스킬이 있고, 이름은 폴더 이름과 같고 역할 이름으로 시작한다', () => {
  for (const role of ROLES) assert.ok(skills(role).length > 0, role);
  for (const s of all) {
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(s.text);
    assert.ok(fm, `${s.name}: frontmatter`);
    assert.equal(/^name: (.+)$/m.exec(fm[1])?.[1], s.name);
    assert.ok(s.name.startsWith(`${s.role}-`), s.name);
    assert.ok((/^description: (.+)$/m.exec(fm[1])?.[1] ?? '').length > 40, `${s.name}: description`);
  }
});

test('스킬이 가리키는 규칙 절(규칙: "…")은 그 역할의 AGENT.md에 있다', () => {
  for (const s of all) {
    const h = headings(s.role);
    const refs = [...s.text.matchAll(/규칙: ((?:"[^"]+"(?:, )?)+)/g)];
    if (s.role !== 'operator') assert.ok(refs.length > 0, `${s.name}: 규칙 절 참조가 없다`);
    for (const m of refs) {
      for (const q of m[1].matchAll(/"([^"]+)"/g)) assert.ok(h.has(q[1]), `${s.name}: "${q[1]}"가 ${s.role}/AGENT.md 제목에 없다`);
    }
  }
});

test('스킬에는 알려진 자리표시자만 있고 개인 경로·이메일이 없다', () => {
  for (const s of all) {
    for (const p of s.text.match(/\{\{[A-Z]+\}\}/g) ?? []) assert.ok(KNOWN.has(p), `${s.name}: ${p}`);
    assert.doesNotMatch(s.text, /[A-Za-z]:[\\/]Users[\\/]|\/home\/|@[a-z0-9-]+\.(com|net|org)/i, s.name);
  }
});

test('리뷰어 스킬은 Jev 질문 문장을 옮겨 적지 않는다(질문은 AGENT.md의 ## Jev 질문 절에만)', () => {
  const t = skills('reviewer').map((s) => s.text).join('\n');
  assert.doesNotMatch(t, /- 묻는 말:|Does `report`/);
});

test('오퍼레이터 모드 절차는 스킬에서 읽고, frontmatter는 지침에 넣지 않는다', () => {
  for (const mode of ['work', 'research']) {
    const docs = loadModeDocs(mode, harnessDir);
    assert.match(docs, /^# 오퍼레이터 공통 규칙/);
    assert.doesNotMatch(docs, /^name: operator-/m);
    assert.match(docs, mode === 'work' ? /# 작업 모드 절차/ : /# 조사 모드 절차/);
  }
});

test('워커 입력에 워커 스킬 점검표가 붙고, frontmatter와 금지 낱말은 없다', () => {
  const t = inputText({ issue: 7, worktree: 'w', body: 'b', failures: [] });
  assert.match(t, /# 이슈 하나 끝내기/);
  assert.doesNotMatch(t, /^name: worker-issue/m);
  assert.doesNotMatch(t, /코디네이터|사용자/);
  assert.ok(t.indexOf('# 이슈 하나 끝내기') < t.indexOf('# 워커 입력 (이슈 #7)'));
});

test('setup은 코디네이터·어드바이저 스킬을 실행 폴더에 채워 설치하고, 어드바이저 정의에 skills 칸을 넣는다', () => {
  const run = join(mkdtempSync(join(tmpdir(), 'skills-')), 'run');
  const r = spawnSync(process.execPath, [join(harnessDir, 'setup.mjs'), '--run', run, '--repo', 'owner/harness-issues', '--no-clone'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  for (const s of [...skills('coordinator'), ...skills('advisor')]) {
    const f = join(run, '.claude/skills', s.name, 'SKILL.md');
    assert.ok(existsSync(f), s.name);
    assert.doesNotMatch(readFileSync(f, 'utf8'), /\{\{[A-Z]+\}\}/, s.name);
  }
  for (const role of ['operator', 'worker', 'reviewer']) for (const s of skills(role)) assert.ok(!existsSync(join(run, '.claude/skills', s.name)), s.name);
  const agent = readFileSync(join(run, '.claude/agents/advisor.md'), 'utf8');
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(agent)[1];
  for (const s of skills('advisor')) assert.match(fm, new RegExp(`^  - ${s.name}$`, 'm'));
  assert.match(fm, /^tools: Read, Grep, Glob, Write, Bash$/m, '어드바이저에게 Skill 도구는 주지 않는다(미리 주입만)');
});

test('훅: 코디네이터는 자기 스킬은 부르고 다른 역할의 스킬은 부르지 못한다', () => {
  const config = { issuesClone: 'C:/run/issues', targetProject: 'C:/run/memo', designatedRepo: 'o/r', harnessDir: 'C:/h', runDir: 'C:/run' };
  const call = (skill) => decide({ tool_name: 'Skill', tool_input: { skill }, cwd: 'C:/run' }, config, {});
  assert.equal(call('coordinator-handoff').allow, true);
  for (const n of ['advisor-proposal', 'operator-work', 'worker-issue', 'reviewer-verdict']) assert.equal(call(n).allow, false, n);
});
