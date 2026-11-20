// 라우팅(이슈 #44, ADR 0008): 이슈 본문 초안을 보고 Jev가 워커 모델과 유형을 판단하고, 코드가 정한다.
//   node route-issue.mjs --draft <초안 파일 이름>
// - 초안은 지정 저장소 클론의 `.drafts/<이름>`(코디네이터가 이슈를 올리기 전에 쓰는 곳)에서만 읽는다. 이름만 받는다(경로 불가).
// - 질문 둘을 한 요청으로 묻는다(Choice): 유형(작업/조사), 워커 모델(설정의 allowedModels). 보기의 설명은 설정 jev.routing에 있다.
//   하달마다 맡길 일이 다르므로 설명은 설정에서 바꾼다. 질문 문구는 이 파일에만 둔다.
// - 코드가 정하는 것: 공개 제한이 켜진 모델(runners.<m>.publicOnly)은 초안에 `공개 가능: 예`가 없으면 보기에서 뺀다. 답은 가장 높은 보기를 쓴다.
// - 출력(stdout, 코디네이터가 이슈 본문의 `## 영역, 워커 모델, 유형` 절에 옮겨 적는다):
//     워커 모델: <모델> (Jev 라우팅, 확률 <p>)
//     유형: <작업|조사> (Jev 라우팅, 확률 <p>)
//     난이도: <쉬움|어려움> (Jev 라우팅, 확률 <p>). 워커 러너가 난이도별 모델을 두면(claude: 쉬움 haiku, 어려움 sonnet) run-worker가 이 줄로 고른다
// - 종료 코드: 0 결정함, 2 인자·설정·입력 오류(키 없음 포함), 6 Jev 호출 실패(실패를 답으로 읽지 않는다. 일시적 실패는 2회 다시 부른 뒤, 이슈 #25).
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadOperatorConfig, ConfigError } from './config.mjs';
import { askJevWithRetry, findJevKey, JevError, KEY_NAME } from './jev.mjs';
import { publicOkOf } from './runners.mjs';
import { normPath } from '../policy.mjs';
import { WORKER_MODEL, ISSUE_KIND, DIFFICULTY } from './protocol.mjs';

const fwd = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
const ONE_LINE = (text) => String(text).replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
const DRAFT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_DRAFT_CHARS = 16000;
// 유형 보기 이름은 내용을 말하는 영어 이름으로 보낸다(보기 이름이 모델에 전달된다). 결과는 한국어 값으로 옮긴다.
export const TYPE_OPTIONS = { change_to_project: '작업', answer_or_recommendation: '조사' };
// 난이도(소유자 결정 8-16). 워커 모델과 상관없이 함께 묻고(질문 하나라 거의 공짜), 러너가 난이도별 모델(tiers)을 둘 때만 쓴다.
export const DIFFICULTY_OPTIONS = { simple_change: '쉬움', complex_change: '어려움' };
export const SIMPLE_ONLY = ['muse'];

// 질문. cfg: 설정, models: 고를 수 있는 워커 모델 목록.
export function routingQuestions(cfg, models) {
  const t = cfg.jev.routing.types;
  return {
    issue_type: {
      type: 'choice',
      instructions: 'What does `draft` ask the worker to deliver?',
      criteria: Object.fromEntries(Object.entries(TYPE_OPTIONS).map(([opt, ko]) => [opt, t[ko]])),
    },
    difficulty: {
      type: 'choice',
      instructions: 'How hard is the change that `draft` asks for?',
      criteria: Object.fromEntries(Object.entries(DIFFICULTY_OPTIONS).map(([opt, ko]) => [opt, cfg.jev.routing.difficulty[ko]])),
    },
    // 보안 영향은 따로 묻는다(실제 API 시험에서 보안 변경이 쉬움·어려움 반반으로 갈렸다: 고칠 파일이 적혀 있어 두 설명에 다 걸린다).
    touches_security: {
      type: 'noul',
      instructions: 'Does `draft` change a security boundary: secrets, permissions, which files or paths may be read or written, authentication, or how input from outside the program is trusted?',
      criteria: {
        true: 'The change decides who or what may read, write, or run something, or how credentials are stored or passed, such as refusing paths outside a folder or restricting file permissions.',
        false: 'The change alters an ordinary feature, message, test, or document. Rejecting an empty or malformed value for a normal feature, such as an empty memo title, is not a security boundary.',
      },
    },
    worker_model: {
      type: 'choice',
      instructions: 'Which kind of work does `draft` describe?',
      criteria: Object.fromEntries(models.map((m) => [m, cfg.jev.routing.workerModels[m]])),
    },
  };
}

// 결정: 가장 높은 보기. 돌려주는 값 { model, modelP, type, typeP }.
// 난이도 결정: 보안 영향이 있으면(≥ jev.yes) 어려움, 쉬움은 Jev가 jev.yes 이상으로 고를 때만, 그 밖(애매)은 어려움(강한 모델 쪽이 안전하다).
export function decideRoute(answers, jev = { yes: 0.7 }) {
  const m = answers.worker_model;
  const t = answers.issue_type;
  const k = answers.difficulty;
  const easyP = k.probabilities.simple_change ?? 0;
  const security = answers.touches_security?.noul ?? 0;
  const difficulty = security >= jev.yes ? '어려움' : easyP >= jev.yes ? '쉬움' : '어려움';
  const why = security >= jev.yes ? `보안 영향 ${security.toFixed(2)}` : easyP >= jev.yes ? `쉬움 ${easyP.toFixed(2)}` : `쉬움 ${easyP.toFixed(2)} < ${jev.yes}`;
  // 어려운 일은 간단한 코드용 모델(SIMPLE_ONLY, 소유자 결정 8-9의 muse)에 보내지 않는다: 나머지 보기 중 확률이 가장 높은 모델로 바꾼다.
  let model = m.choice;
  let modelNote = '';
  if (difficulty === '어려움' && SIMPLE_ONLY.includes(model)) {
    const rest = Object.entries(m.probabilities).filter(([k]) => !SIMPLE_ONLY.includes(k)).sort((a, b) => b[1] - a[1]);
    if (rest.length) { modelNote = `, 어려운 일이라 ${model} 대신`; model = rest[0][0]; }
  }
  return { model, modelP: m.probabilities[model], modelNote, type: TYPE_OPTIONS[t.choice], typeP: t.probabilities[t.choice], difficulty, difficultyWhy: why };
}

class UsageError extends Error {}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== '--draft') throw new UsageError('사용법: --draft <초안 파일 이름>');
  if (!DRAFT_NAME.test(argv[1])) throw new UsageError('--draft는 .drafts/ 안의 파일 이름이어야 합니다(영문·숫자·점·밑줄·붙임표, 경로 불가).');
  return { draft: argv[1] };
}

export async function main(argv, env = process.env, deps = {}) {
  const write = deps.write ?? ((line) => console.log(line));
  const writeErr = deps.writeErr ?? ((line) => console.error(line));
  const fail = (code, reason) => { writeErr(`오류: ${ONE_LINE(reason)}`); return code; };
  try {
    const { draft } = parseArgs(argv);
    const run = fwd(resolvePath(env.HARNESS_RUN_DIR || process.cwd()));
    const hjFile = `${run}/harness.json`;
    const hj = deps.harness ?? (existsSync(hjFile) ? JSON.parse(readFileSync(hjFile, 'utf8')) : null);
    if (!hj || typeof hj.issuesClone !== 'string') return fail(2, `실행 폴더의 harness.json에 issuesClone이 없습니다: ${run}`);
    const dir = `${fwd(hj.issuesClone)}/.drafts`;
    const file = `${dir}/${draft}`;
    let real;
    try { real = fwd(realpathSync(file)); } catch { return fail(2, `초안 파일이 없습니다: ${file}`); }
    if (normPath(dirname(real)) !== normPath(fwd(realpathSync(dir)))) return fail(2, `초안 파일의 실제 경로가 .drafts/ 밖입니다: ${real}`);
    const text = readFileSync(real, 'utf8');
    if (text.trim() === '') return fail(2, `초안이 비어 있습니다: ${file}`);
    if (text.length > MAX_DRAFT_CHARS) return fail(2, `초안이 너무 깁니다(${text.length}자, 한도 ${MAX_DRAFT_CHARS}자).`);

    const cfg = deps.cfg ?? loadOperatorConfig(fileURLToPath(new URL('./operator.config.json', import.meta.url)), { run });
    const publicOk = publicOkOf(text);
    const models = cfg.allowedModels.filter((m) => m in cfg.jev.routing.workerModels && (cfg.runners[m]?.publicOnly !== true || publicOk));
    if (models.length === 0) return fail(2, '고를 수 있는 워커 모델이 없습니다.');
    const found = deps.jevKey !== undefined ? (deps.jevKey ? { key: deps.jevKey } : null) : findJevKey({ env: { ...process.env, ...env }, run, harnessDir: fwd(dirname(dirname(fileURLToPath(import.meta.url)))) });
    if (!found) return fail(2, `${KEY_NAME}가 없습니다. 환경 변수나 실행 폴더의 .env에 넣으세요(값은 출력하지 않습니다).`);

    let res;
    const questions = routingQuestions(cfg, models);
    try {
      res = await (deps.askJev ?? askJevWithRetry)({ jev: cfg.jev, key: found.key, state: { draft: text }, questions, fetchImpl: deps.fetch }, { sleep: deps.sleep });
    } catch (e) {
      if (e instanceof JevError) return fail(6, e.message);
      throw e;
    }
    const d = decideRoute(res.answers, cfg.jev);
    write(`${WORKER_MODEL}: ${d.model} (Jev 라우팅, 확률 ${d.modelP.toFixed(2)}${d.modelNote}, ${res.model})`);
    write(`${ISSUE_KIND}: ${d.type} (Jev 라우팅, 확률 ${d.typeP.toFixed(2)})`);
    write(`${DIFFICULTY}: ${d.difficulty} (Jev 라우팅, ${d.difficultyWhy})`);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) return fail(2, `인자 오류: ${e.message}`);
    if (e instanceof ConfigError) return fail(2, `설정 오류: ${e.message}`);
    return fail(2, e?.message ?? String(e));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
