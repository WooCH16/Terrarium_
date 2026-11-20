// 시험용 덫(이슈 #27): 시험 실행 스크립트가 HARNESS_PI_BIN·HARNESS_AGY_BIN·HARNESS_CLAUDE_BIN의 기본값으로 이 파일을 둔다.
// 시험이 자기 가짜 CLI를 주지 않고 진짜 모델 CLI를 부르려 하면 여기로 와서 바로 실패한다(실제 호출·비용이 나가지 않는다).
// HARNESS_CLI_TRAP_LOG가 있으면 불린 위치와 인자를 한 줄씩 남긴다.
import { appendFileSync } from 'node:fs';
const line = `${process.cwd()} :: ${process.argv.slice(2).join(' ').slice(0, 200)}`;
if (process.env.HARNESS_CLI_TRAP_LOG) { try { appendFileSync(process.env.HARNESS_CLI_TRAP_LOG, `${line}\n`); } catch { /* 기록 실패는 무시 */ } }
process.stderr.write(`[시험 덫] 진짜 모델 CLI를 부르려 했습니다. 시험에서 가짜 CLI를 주세요: ${line}\n`);
process.exit(97);
