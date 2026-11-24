// Pi 워커 확장(결정 8-39): 워커가 결정이 필요하면 오퍼레이터에게 묻고, 답을 받아 같은 세션에서 이어 간다.
// run-worker가 Pi를 `--no-extensions -e <이 파일>`로 띄운다. 다른 확장·패키지는 읽지 않는다(이 파일은 node: 모듈만 쓴다).
//  - 도구 ask_operator: 워커가 이슈가 정하지 않은 갈림길에서 부른다. 답이 올 때까지 기다렸다가 결정을 돌려준다.
//  - 훅(tool_call): 이슈에 없는 결정으로 보이는 명령(새 패키지 설치, 기존 시험 지우기, package.json 의존성 더하기)을
//    실행하기 전에 막고, 오퍼레이터에게 허용 여부를 물어 답이 `허용`일 때만 실행시킨다. 답이 없으면 막는다.
// 통로: 질문은 워크트리의 .harness/asking.md(HARNESS_ASK_FILE)에 쓴다. run-worker가 그것을 보고 오퍼레이터에게 알린다.
// 답은 오퍼레이터가 <지정 저장소 클론>/.drafts/answer-<n>-h<N>-q<질문 번호>.md(HARNESS_ANSWER_PREFIX + 번호 + .md)에 쓴다.
// 답 파일 경로는 모델에게 보이는 글에 넣지 않는다(워커가 스스로 답을 쓰지 않게).
// 통로 환경 변수가 없거나 답이 제한 시간 안에 안 오면, 도구는 "질문 파일을 쓰고 끝내라"를 돌려주고 훅은 막는다.
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, mkdirSync, lstatSync } from 'node:fs';
import { dirname, basename } from 'node:path';

const MAX_ANSWER_BYTES = 16 * 1024;
const POLL_MS = 2000;

// ---- 결정으로 보이는 명령 가려내기 ----
const PKG_MANAGERS = {
  npm: ['install', 'i', 'add', 'isntall'], pnpm: ['add', 'install', 'i'], bun: ['add', 'install', 'i'], yarn: ['add'],
  cargo: ['add'], poetry: ['add'], gem: ['install'], composer: ['require'], conda: ['install'], go: ['get'],
};
const TEST_PATH = /(^|[\\/])(tests?|__tests__|specs?)([\\/]|$)|\.(test|spec)\.[A-Za-z0-9]+$|_test\.(go|py|rb)$|(^|[\\/])test_[^\\/]*\.py$/i;
const unquote = (t) => t.replace(/^(['"])(.*)\1$/, '$2');
const words = (seg) => (seg.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(unquote);
const plainArgs = (args, valueFlags = []) => {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (valueFlags.includes(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    out.push(a);
  }
  return out;
};

// 명령 한 줄에서 결정으로 보이는 것. 없으면 null.
export function classifyCommand(command) {
  for (const seg of String(command ?? '').split(/&&|\|\||[;|\n]/)) {
    let w = words(seg.trim());
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w = w.slice(1); // 앞의 VAR=값
    if (w[0] === 'sudo') w = w.slice(1);
    if (!w.length) continue;
    const bin = basename(w[0]).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
    let rest = w.slice(1);
    // python -m pip install …, py -m pip …
    if ((bin === 'python' || bin === 'python3' || bin === 'py') && rest[0] === '-m' && rest[1] === 'pip') rest = rest.slice(2);
    const isPip = bin === 'pip' || bin === 'pip3' || ((bin === 'python' || bin === 'python3' || bin === 'py') && w[1] === '-m');
    if (isPip || (bin === 'uv' && rest[0] === 'pip')) {
      const r = bin === 'uv' ? rest.slice(1) : rest;
      if (r[0] === 'install' && plainArgs(r.slice(1), ['-r', '--requirement', '-e', '--editable', '-c', '--constraint', '-i', '--index-url', '--target', '-t']).filter((a) => a !== '.').length) return { category: '새 외부 패키지 설치', command: seg.trim() };
      continue;
    }
    if (bin === 'uv' && rest[0] === 'add') return { category: '새 외부 패키지 설치', command: seg.trim() };
    if (bin === 'dotnet' && rest[0] === 'add' && rest.includes('package')) return { category: '새 외부 패키지 설치', command: seg.trim() };
    if (Object.hasOwn(PKG_MANAGERS, bin) && PKG_MANAGERS[bin].includes(rest[0]) && plainArgs(rest.slice(1)).length) return { category: '새 외부 패키지 설치', command: seg.trim() };
    // 시험 지우기: rm·del·git rm·Remove-Item 등에 시험 경로
    const delArgs = ['rm', 'del', 'erase', 'rmdir', 'rd', 'unlink', 'remove-item', 'ri'].includes(bin) ? rest : bin === 'git' && rest[0] === 'rm' ? rest.slice(1) : null;
    if (delArgs && plainArgs(delArgs).some((a) => TEST_PATH.test(a))) return { category: '기존 시험 지우기', command: seg.trim() };
  }
  return null;
}

const depKeys = (text) => {
  try {
    const j = JSON.parse(text);
    return new Set(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap((k) => Object.keys(j?.[k] ?? {})));
  } catch { return null; }
};
// write·edit 도구가 package.json에 새 의존성을 더하는지. 더하면 그 이름들, 아니면 null.
export function addedDependencies(path, before, after) {
  if (basename(String(path ?? '')).toLowerCase() !== 'package.json') return null;
  const a = depKeys(after);
  if (!a) return null;
  const b = depKeys(before ?? '{}') ?? new Set();
  const added = [...a].filter((k) => !b.has(k));
  return added.length ? added : null;
}
const readOr = (p, fallback) => { try { return readFileSync(p, 'utf8'); } catch { return fallback; } };
function afterEdit(before, input) {
  const edits = Array.isArray(input?.edits) ? input.edits : [input];
  let text = before;
  for (const e of edits) {
    const o = e?.oldText ?? e?.old_string;
    const n = e?.newText ?? e?.new_string;
    if (typeof o !== 'string' || typeof n !== 'string') return null;
    if (!text.includes(o)) return null;
    text = text.replace(o, () => n);
  }
  return text;
}

// ---- 오퍼레이터에게 묻기 ----
export function createAsker(env = process.env, { now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = Number(env.HARNESS_ASK_POLL_MS) > 0 ? Number(env.HARNESS_ASK_POLL_MS) : POLL_MS } = {}) {
  const askFile = env.HARNESS_ASK_FILE;
  const prefix = env.HARNESS_ANSWER_PREFIX;
  const issue = env.HARNESS_WORKER_ISSUE;
  const waitMs = Number(env.HARNESS_ASK_WAIT_MS) > 0 ? Number(env.HARNESS_ASK_WAIT_MS) : 30 * 60 * 1000;
  const limit = Number(env.HARNESS_ASK_LIMIT) > 0 ? Number(env.HARNESS_ASK_LIMIT) : 3;
  let count = 0;
  let chain = Promise.resolve();
  const ready = typeof askFile === 'string' && askFile !== '' && typeof prefix === 'string' && prefix !== '' && /^[1-9]\d*$/.test(issue ?? '');
  // 답: { answer } | { none: true }(통로 없음·시간 초과·중단) | { limit: true }
  async function once(kind, text, signal) {
    if (!ready) return { none: true };
    if (count >= limit) return { limit: true };
    count++;
    const id = `${process.pid}-${count}`;
    const answerFile = `${prefix}${id}.md`;
    rmSync(answerFile, { force: true }); // 같은 번호의 옛 답은 이번 답이 아니다
    mkdirSync(dirname(askFile), { recursive: true });
    const tmp = `${askFile}.${process.pid}.tmp`;
    writeFileSync(tmp, ['## 질문 번호', id, '', '## 종류', kind, '', '## 이슈 번호', issue, '', '## 질문', String(text).trim(), ''].join('\n'));
    renameSync(tmp, askFile);
    const until = now() + waitMs;
    try {
      for (;;) {
        if (signal?.aborted) return { none: true };
        let st = null;
        try { st = lstatSync(answerFile); } catch { /* 아직 없음 */ }
        if (st) {
          if (!st.isFile() || st.size > MAX_ANSWER_BYTES) { rmSync(answerFile, { force: true }); return { none: true }; }
          const answer = readFileSync(answerFile, 'utf8').trim();
          rmSync(answerFile, { force: true });
          if (answer) return { answer };
        }
        if (now() >= until) return { none: true };
        await sleep(pollMs);
      }
    } finally {
      rmSync(askFile, { force: true });
    }
  }
  // 한 번에 하나씩: Pi는 같은 응답의 도구 호출을 동시에 돌린다. 두 질문이 한 답을 나눠 갖지 않게 줄 세운다.
  const ask = (kind, text, signal) => {
    const p = chain.then(() => once(kind, text, signal));
    chain = p.catch(() => {});
    return p;
  };
  return { ask, get count() { return count; }, limit };
}

const FALLBACK = '고르지 말고 워크트리의 .harness/worker-question.md에 `## 이슈 번호`와 `## 질문`을 쓰고 작업을 끝내라(결과 파일은 쓰지 않는다). 오퍼레이터가 답한 뒤 다시 부른다.';
export function toolText(r, limit) {
  if (r.answer) return `오퍼레이터 결정:\n${r.answer}\n\n이 결정대로 계속한다. 같은 것을 다시 묻지 않는다.`;
  if (r.limit) return `이번 실행의 질문 한도(${limit}번)에 닿았다. 더 묻지 않는다. ${FALLBACK}`;
  return `오퍼레이터의 답을 받지 못했다. ${FALLBACK}`;
}
// 훅이 물은 허용 여부의 답: 첫 줄이 `허용`으로 시작하면 실행한다.
export const allowed = (r) => Boolean(r.answer) && /^허용/.test(r.answer.split(/\r?\n/).find((l) => l.trim())?.trim() ?? '');

export default function piAsk(pi, env = process.env) {
  const asker = createAsker(env);
  pi.registerTool({
    name: 'ask_operator',
    label: '오퍼레이터에게 묻기',
    description: '이슈가 정하지 않은 갈림길(목표·완료 기준이 두 가지로 읽혀 동작이 달라짐, 기준끼리 부딪히거나 그대로는 맞출 수 없음, 이슈에 없는 새 패키지·다른 코드가 쓰는 함수·인자·파일 형식 바꾸기·기존 시험 지우기가 필요함)에서 고르지 말고 이 도구로 오퍼레이터에게 묻는다. 답이 올 때까지 기다렸다가 결정을 돌려준다.',
    parameters: {
      type: 'object',
      properties: { question: { type: 'string', description: '정해지지 않은 것, 고를 수 있는 것(가, 나 …)과 각각 무엇이 달라지는지, 권하는 것과 이유' } },
      required: ['question'],
      additionalProperties: false,
    },
    async execute(_id, params, signal) {
      const r = await asker.ask('질문', params?.question ?? '', signal);
      return { content: [{ type: 'text', text: toolText(r, asker.limit) }], details: { answered: Boolean(r.answer) } };
    },
  });
  pi.on('tool_call', async (event, ctx) => {
    let found = null;
    if (event?.toolName === 'bash') {
      const c = classifyCommand(event.input?.command);
      if (c) found = `${c.category}: 워커가 다음 명령을 실행하려 한다.\n\`${c.command}\``;
    } else if (event?.toolName === 'write' || event?.toolName === 'edit') {
      const p = event.input?.path ?? event.input?.file_path;
      const before = readOr(p, null);
      const after = event.toolName === 'write' ? event.input?.content : before === null ? null : afterEdit(before, event.input);
      const added = typeof after === 'string' ? addedDependencies(p, before, after) : null;
      if (added) found = `새 외부 패키지 설치: 워커가 ${p}에 의존성을 더하려 한다: ${added.join(', ')}`;
    }
    if (!found) return undefined;
    const r = await asker.ask('허용 여부', `${found}\n\n이슈에 없는 결정이라 실행 전에 허용을 묻는다. 첫 줄에 \`허용\` 또는 \`거부\`와 이유를 적어 답한다.`, ctx?.signal);
    if (allowed(r)) return undefined;
    return { block: true, reason: r.answer ? `오퍼레이터가 허용하지 않았다: ${r.answer}` : `이슈에 없는 결정(${found.split(':')[0]})이라 오퍼레이터의 허용 없이는 실행하지 않는다. 이 명령 없이 하거나, ${FALLBACK}` };
  });
}
