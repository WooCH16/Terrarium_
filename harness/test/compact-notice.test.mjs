// 컴팩션 알림 훅(소유자 결정 8-20): setup이 SessionStart(compact) 훅을 넣고, 알림에 보존 노트·기록 문서 경로와 보고 형식이 있다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { noticeText } from '../compact-notice.mjs';

const script = fileURLToPath(new URL('../compact-notice.mjs', import.meta.url));

test('컴팩션 알림: 압축 후 검증, 세 가지 보고, 보존 노트·기록 문서 경로', () => {
  const t = noticeText({ issuesClone: 'C:/run/issues', projectName: 'memo' });
  assert.match(t, /압축 후 검증/);
  assert.match(t, /완료 \/ 일부 누락 \/ 복구 실패/);
  assert.match(t, /보존 노트: C:\/run\/issues\/records\/memo-보존\.md/);
  assert.match(t, /기록 문서: C:\/run\/issues\/records\/memo\.md/);
});

test('컴팩션 알림: 설정을 못 읽어도 실패하지 않고 경로 없이 알린다(종료 코드 0)', () => {
  const out = execFileSync(process.execPath, [script, '--config', 'C:/없는/harness.json'], { encoding: 'utf8' });
  assert.match(out, /컴팩션이 일어났다/);
  assert.doesNotMatch(out, /보존 노트:/);
});
