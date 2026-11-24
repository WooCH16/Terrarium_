// 분리 실행한 하달·조사를 이어서 기다린다: node wait-operator.mjs --wait <대기 번호>
// run-operator·run-research가 종료 코드 8(진행 중)과 함께 낸 대기 번호를 받는다(background.mjs).
// 끝났으면 원래 스크립트의 출력 줄과 종료 코드를 그대로 낸다. 아직이면 같은 진행 중 줄과 종료 코드 8. 번호를 모르면 2.
// 분리 실행한 워커가 오퍼레이터의 답을 기다리면(답 파일이 아직 없음) `질문 중: …` 한 줄과 종료 코드 5(결정 8-39).
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { TOKEN, readBg, waitFor, report, waitMsOf } from './background.mjs';

const fwd = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');

export async function main(argv, env = process.env, deps = {}) {
  const write = deps.write ?? ((l) => console.log(l));
  if (argv.length !== 2 || argv[0] !== '--wait' || !TOKEN.test(argv[1] ?? '')) { write('오류: 사용법: node wait-operator.mjs --wait <대기 번호(12자리)>'); return 2; }
  const token = argv[1];
  const run = fwd(env.HARNESS_RUN_DIR || process.cwd());
  if (!existsSync(`${run}/harness.json`)) { write(`오류: 실행 폴더에 harness.json이 없습니다: ${run}`); return 2; }
  const harnessDir = fwd(JSON.parse(readFileSync(`${run}/harness.json`, 'utf8')).harnessDir);
  if (readBg(run, token) === null && (await new Promise((r) => setTimeout(r, 300)), readBg(run, token) === null)) { write(`오류: 대기 번호 ${token}의 분리 실행 기록이 없습니다.`); return 2; }
  return report(await waitFor(run, token, { waitMs: deps.waitMs ?? waitMsOf(env), pollMs: deps.pollMs ?? 1000 }), { token, harnessDir, run, write });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
