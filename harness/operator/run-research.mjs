// 조사 모드 세션 시작: node run-research.mjs --issue <n>
// 진행 중인 하달을 기다리지 않고 새 하달 번호로 바로 시작한다. stdout에는 보고 줄 한 줄(#번호 | 상태 | url)만.
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { loadOperatorConfig, ConfigError } from './config.mjs';
import { nextHandoff } from './handoff.mjs';
import { formatLine, exitCode } from './report.mjs';
import { loadModeDocs, launchSession, isStopped } from './launch.mjs';
import { makeGhDeps, defaultExec } from './run-operator.mjs';
import { LABEL } from './protocol.mjs';

const fwd = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
const ONE_LINE = (text) => String(text).replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000;

class UsageError extends Error {}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== '--issue') throw new UsageError('사용법: --issue <n> (다른 인자와 중복은 허용하지 않습니다)');
  if (!/^[1-9]\d{0,8}$/.test(argv[1])) throw new UsageError('--issue는 양의 정수 이슈 번호여야 합니다(예: 9).');
  return { issue: Number(argv[1]) };
}

export async function main(argv, env = process.env, deps = {}) {
  const write = deps.write ?? ((line) => console.log(line));
  const fail = (reason) => { write(`오류: ${ONE_LINE(reason)}`); return 2; };
  try {
    const { issue } = parseArgs(argv);
    const run = fwd(env.HARNESS_RUN_DIR || process.cwd());
    const configFile = `${run}/harness.json`;
    if (!existsSync(configFile)) return fail(`실행 폴더에 harness.json이 없습니다: ${run}`);
    const config = JSON.parse(readFileSync(configFile, 'utf8'));
    const harnessDir = fwd(config.harnessDir);
    loadOperatorConfig(`${harnessDir}/operator/operator.config.json`, { run });
    const docs = loadModeDocs('research', harnessDir);

    // 진행 중인 하달(폴더가 있는 번호)은 건드리지 않고 다음 빈 번호를 점유한다.
    const handoff = nextHandoff(run);
    const prompt = [
      '# 이번 세션', `- 하달: ${handoff}`, `- 이슈: #${issue}`, `- 실행 폴더: ${run}`,
      `- 지정 저장소: ${config.designatedRepo}`, `- 이슈 클론: ${config.issuesClone}`, `- 대상 프로젝트: ${config.targetProject}`,
    ].join('\n') + `\n\n${docs}`;
    const launch = deps.launchSession ?? launchSession;
    const gh = deps.fetchIssue && deps.setState ? deps : makeGhDeps(config.designatedRepo, defaultExec(env));

    await gh.ensureLabels?.();
    // 한 번만 시도한다(재시작 없음). 시작 실패는 반복하지 않고 바로 오류로 끝낸다.
    const r = await launch({ mode: 'research', handoff, run, harnessDir, issue, prompt, timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS });
    if (r.spawnError !== undefined) {
      return fail(`세션을 시작할 수 없습니다: ${r.spawnError}. HARNESS_CLAUDE_BIN(기본 claude)은 실행 파일로 직접 실행할 수 있어야 합니다. claude.exe 또는 .js/.mjs 진입 파일 경로를 HARNESS_CLAUDE_BIN에 지정하세요(.cmd 래퍼는 지원하지 않습니다).`);
    }
    if (isStopped(run, handoff)) return exitCode([], { stopped: true });
    const ok = r.code === 0 && !r.timedOut;
    if (!ok) await gh.setState(issue, LABEL.보류);
    const { state, url } = await gh.fetchIssue(issue);
    const row = { number: issue, state: ok ? state : LABEL.보류, url };
    write(formatLine(row));
    return exitCode([row]);
  } catch (e) {
    if (e instanceof UsageError) return fail(`인자 오류: ${e.message}`);
    if (e instanceof ConfigError) return fail(`설정 오류: ${e.message}`);
    return fail(e?.message ?? String(e));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // 분리 실행(background.mjs): Bash 도구의 10분 제한 안에서 기다리고, 길어지면 종료 코드 8과 대기 번호를 낸다.
  const { cliEntry } = await import('./background.mjs');
  process.exitCode = await cliEntry({ main, entry: fileURLToPath(import.meta.url) });
}
