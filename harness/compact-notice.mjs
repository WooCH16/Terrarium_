// 컴팩션 알림 훅(SessionStart, matcher "compact"). 소유자 결정 8-20, run-18.
// 컴팩션이 끝나면 Claude Code가 이 스크립트의 표준 출력을 코디네이터 대화에 넣는다.
// 코디네이터가 보존 노트와 기록 문서를 다시 읽고 "완료 / 일부 누락 / 복구 실패"를 보고하게 한다(coordinator/AGENT.md "압축 후 검증").
// 사용: node compact-notice.mjs --config <실행 폴더>/harness.json
// 무엇을 읽든 실패하면 경로 없이 알림만 낸다. 훅이 실패해 세션을 막지 않게 늘 종료 코드 0이다.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function noticeText(config) {
  const issues = config?.issuesClone;
  const project = config?.projectName;
  const lines = [
    '[하네스 알림] 방금 대화 컴팩션이 일어났다. 코디네이터 규칙의 "압축 후 검증"을 지금 한다.',
    '1. 보존 노트와 기록 문서를 다시 읽고, 보존 항목이 모두 남았는지 확인한다. 찾지 못한 항목은 추측으로 채우지 않는다.',
    '2. 사용자에게 하는 다음 답은 반드시 아래 셋 중 한 줄로 시작한다(사용자가 무슨 말을 했든):',
    '   컴팩션 복구: 완료 (완료 / 일부 누락 / 복구 실패 중 완료)',
    '   컴팩션 복구: 일부 누락 — <빠진 항목> (완료 / 일부 누락 / 복구 실패 중 일부 누락)',
    '   컴팩션 복구: 복구 실패 — <이유> (완료 / 일부 누락 / 복구 실패 중 복구 실패)',
    '   보존 노트 파일이 없으면 "컴팩션 복구: 일부 누락 — 보존 노트 없음"이다.',
  ];
  if (issues && project) {
    lines.push(`보존 노트: ${issues}/records/${project}-보존.md`);
    lines.push(`기록 문서: ${issues}/records/${project}.md`);
  }
  return lines.join('\n');
}

// 명령줄로 불렸을 때만 출력한다(시험은 noticeText만 가져다 쓴다).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf('--config');
  let config = null;
  if (i !== -1) { try { config = JSON.parse(readFileSync(process.argv[i + 1], 'utf8')); } catch { /* 경로 없이 알린다 */ } }
  console.log(noticeText(config));
}
