// 스모크 시험용 가짜 코디네이터(진짜 claude 대신 앱의 터미널에 뜬다). 모델·네트워크·GitHub를 부르지 않는다.
// 실행 폴더(현재 폴더)에 하네스가 남기는 기록을 하네스의 기록 함수로 그대로 쓴다:
//   guard.log(훅이 쓰는 모양), advice-log.jsonl, handoffs/h<N>/dispatch.json(writeDispatch), session.json, workers.jsonl(logWorker).
// 줄에 "하달"이 있으면: 어드바이저 1번 → 개발팀 하달(이슈 2개, 워커 2명) → 테스터팀 하달(이슈가 모두 빠져 워커 없음) → 리뷰어 판정.
// 그 밖의 줄: 코디네이터가 파일 하나만 읽고 답한다(하위 세션 없음).
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const run = process.cwd().replace(/\\/g, '/');
const harnessDir = JSON.parse(readFileSync(`${run}/harness.json`, 'utf8')).harnessDir;
const { writeDispatch } = await import(pathToFileURL(`${harnessDir}/operator/run-operator.mjs`).href);
const { logWorker } = await import(pathToFileURL(`${harnessDir}/operator/run-worker.mjs`).href);

const out = (s) => process.stdout.write(s.replace(/\n/g, '\r\n'));
const guard = (row) => appendFileSync(`${run}/guard.log`, `${JSON.stringify({ time: new Date().toISOString(), agent_type: null, allow: true, reason: '허용', summary: '', ...row })}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date();
const iso = () => new Date().toISOString();

function session(h, data) {
  mkdirSync(`${run}/handoffs/${h}`, { recursive: true });
  writeFileSync(`${run}/handoffs/${h}/session.json`, JSON.stringify(data, null, 2));
}

async function dispatchScenario() {
  out('● 할 일을 나누려고 어드바이저를 부릅니다\n');
  guard({ tool_name: 'Read', summary: `${run}/CLAUDE.md` });
  guard({ tool_name: 'Agent', summary: '작업 단위 나누기 조언' });
  await sleep(500);
  guard({ agent_type: 'advisor', tool_name: 'Read', summary: `${run}/memo/src/memo.mjs` });
  guard({ agent_type: 'advisor', tool_name: 'Write', summary: `${run}/reviewer-inbox/adv-smoke-1.md` });
  guard({ agent_type: 'advisor', tool_name: 'Bash', summary: `node ${harnessDir}/operator/run-reviewer.mjs --advice ${run}/reviewer-inbox/adv-smoke-1.md --advice-id adv-smoke-1` });
  await sleep(600);
  appendFileSync(`${run}/advice-log.jsonl`, `${JSON.stringify({ time: iso(), file: 'adv-smoke-1.md', adviceId: 'adv-smoke-1', sha256: '0'.repeat(64), verdict: '허용', malformed: false, reviewer: 'jev (smoke)', attempt: 1 })}\n`);
  guard({ tool_name: 'Bash', summary: 'gh issue create --repo owner/smoke-issues --title 정렬 옵션' });
  out('● 이슈 #11, #12를 개발팀에 하달합니다\n');
  await sleep(400);
  guard({ tool_name: 'Bash', summary: `node ${harnessDir}/operator/run-operator.mjs --issues 11,12` });
  const h1 = { team: 'dev', mode: 'work', requested: [11, 12], live: [11, 12], excluded: [], base: null, startedAt: iso(), endedAt: null, sessionOk: null, rows: null };
  mkdirSync(`${run}/handoffs/h1`, { recursive: true });
  writeDispatch(run, 'h1', h1);
  session('h1', { pid: process.pid, startedAt: iso(), mode: 'work', issues: [11, 12], pids: [] });
  await sleep(700);
  logWorker(run, 'h1', { event: 'start', issue: 11, requestedModel: 'claude', model: 'claude', base: 'main', baseCommit: 'a'.repeat(40) }, now);
  logWorker(run, 'h1', { event: 'start', issue: 12, requestedModel: 'gemini', model: 'gemini', base: 'main', baseCommit: 'a'.repeat(40) }, now);
  await sleep(4000);
  logWorker(run, 'h1', { event: 'end', issue: 11, attempts: 1, model: 'claude', status: '완료' }, now);
  logWorker(run, 'h1', { event: 'end', issue: 12, attempts: 1, model: 'gemini', status: '완료' }, now);
  await sleep(400);
  session('h1', { pid: process.pid, startedAt: h1.startedAt, mode: 'work', issues: [11, 12], pids: [], endedAt: iso() });
  writeDispatch(run, 'h1', { ...h1, endedAt: iso(), sessionOk: true });
  out('● 이슈 #13을 테스터팀에 하달합니다\n');
  await sleep(300);
  guard({ tool_name: 'Bash', summary: `node ${harnessDir}/operator/run-operator.mjs --issues 13` });
  const h2 = { team: 'tester', mode: 'work', requested: [13], live: [], excluded: [{ issue: 13, reason: '이미 반영됨' }], base: null, startedAt: iso(), endedAt: null, sessionOk: null, rows: null };
  mkdirSync(`${run}/handoffs/h2`, { recursive: true });
  writeDispatch(run, 'h2', h2);
  await sleep(900);
  writeDispatch(run, 'h2', { ...h2, endedAt: iso() });
  await sleep(300);
  guard({ tool_name: 'Bash', summary: `node ${harnessDir}/operator/run-reviewer.mjs --issue 11` });
  guard({ tool_name: 'Bash', summary: `node ${harnessDir}/operator/run-reviewer.mjs --issue 12` });
  out('● 끝: 개발팀 2건 완료, 테스터팀은 할 일이 없어 워커 없이 끝났습니다\n');
}

async function answerOnly() {
  guard({ tool_name: 'Read', summary: `${run}/harness.json` });
  await sleep(300);
  out('● 하위 세션 없이 답합니다: 지금 열린 하달은 없습니다\n');
}

out('가짜 코디네이터(스모크 시험용) · 실행 폴더의 기록만 씁니다\n❯ ');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
let line = '';
let busy = Promise.resolve();
process.stdin.on('data', (d) => {
  for (const ch of d) {
    if (ch === '\x03') process.exit(0);
    if (ch === '\r') {
      const text = line;
      line = '';
      out('\n');
      busy = busy.then(() => (/하달/.test(text) ? dispatchScenario() : answerOnly())).then(() => out('❯ '));
    } else if (ch === '\x7f') { line = line.slice(0, -1); out('\b \b'); }
    else if (ch >= ' ') { line += ch; out(ch); }
  }
});
