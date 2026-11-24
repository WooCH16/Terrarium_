# B1. 앱에서 코디네이터 세션을 띄우는 방식 확인 (#39)

- 날짜: 2026-11-19
- 실행 폴더: `C:/Users/<you>/terrarium-run-7` (`setup --advisor-stub`)
- Claude Code: 2.1.328

## 방법

작은 드라이버(Node `child_process.spawn`)가 실행 폴더에서 다음을 띄운다:

```
claude -p --input-format stream-json --output-format stream-json --verbose --setting-sources project,local --allowedTools "Bash Write Edit Read Glob Grep Agent TodoWrite Skill"
```

표준 입력에 `{"type":"user","message":{"role":"user","content":"..."}}` 한 줄을 쓰고, 표준 출력에서 `{"type":"result",...}` 줄을 받으면 다음 메시지를 쓴다. 마지막 결과 뒤 표준 입력을 닫는다.

보낸 세 메시지:
1. 지정 저장소가 비공개인지만 확인해서 한 줄로 답해줘.
2. 방금 확인한 결과를 다시 한 줄로만 말해줘. 도구는 쓰지 마.
3. 시험이야: memo 폴더에 note.txt 파일을 Write 도구로 만들어 봐. 막히면 막혔다고만 말해.

## 결과

| 턴 | 도구 호출 | `guard.log` | 응답 |
|---|---|---|---|
| 1 | Bash `gh repo view ... --json visibility` | 허용 | 비공개(PRIVATE) |
| 2 | 없음 | 없음 | 첫 턴의 결과를 다시 말함(맥락 유지) |
| 3 | Write `memo/note.txt` | **거부**(코디네이터는 대상 프로젝트를 수정하지 않는다) | "막혔습니다. 하네스 가드가 ... 거부했습니다." 파일 없음 |

- 세 턴 모두 같은 `session_id`였고 프로세스 종료 코드는 0이었다.
- 첫 시도처럼 두 메시지를 한꺼번에 쓰고 표준 입력을 닫으면 첫 메시지만 처리됐다. 앱은 결과를 받은 뒤 다음 메시지를 보내야 한다.
- 표준 오류에 "Ignoring 8 permissions.allow entries ... not been trusted"가 나온다. 신뢰하지 않은 폴더라 설정 파일의 허용 목록을 무시한다는 뜻이고, `--allowedTools`가 대신한다. 훅은 신뢰와 상관없이 돌았다.
- 비밀값 파일 읽기 시도로 훅 거부를 보려던 메시지는 이 확인을 돌린 도구(Claude Code 자동 모드)가 막아서 보내지 않았다. 비밀값 차단은 `policy.test.mjs`가 본다.

## 결론

ADR 0010 결정 4(stream-json 자식 프로세스)를 쓴다. 대화형 터미널을 앱에 넣는 방식(`node-pty`)은 필요 없다.

**(2026-11-20 바뀜)** 결정 8-18에 따라 앱은 대화형 터미널(`node-pty`)로 코디네이터를 띄운다(ADR 0011). 이 확인은 `-p` 방식의 기록으로 남긴다. 시나리오 시험(`verify.mjs`)은 지금도 `-p`를 쓴다.
