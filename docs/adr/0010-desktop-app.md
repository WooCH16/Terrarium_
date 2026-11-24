# ADR 0010. 데스크톱 앱: Electron, 코디네이터는 stream-json 자식 프로세스

- 상태: **채택됨, 결정 2·4·7은 ADR 0011로 대체됨**
- 날짜: 2026-11-19
- 이슈: #34 (설계), #39 (기술 확인)
- 관련: 소유자 결정 9-5~9-7(앱), 8-11(위임), 8-13(서명 없음), 8-14(새 화면). ADR 0008(Jev), ADR 0009(Pi 워커)

## 배경

하네스는 지금 터미널에서 `setup.mjs`, `preflight.mjs`, 대화형 `claude`를 차례로 실행해야 쓸 수 있다. v0의 마지막 단계는 이것을 Windows 데스크톱 앱 하나로 묶는 것이다. 권한 경계 전체가 "Claude Code가 실행 폴더의 훅(`guard.mjs`)을 돌린다"에 서 있으므로, 앱이 세션을 띄우는 방식이 훅을 그대로 살려야 한다.

## 결정

1. **앱은 `app/` 하위 폴더의 Electron 앱이다.** 첫 npm 의존(Electron, 설치 파일용 electron-builder)은 `app/package.json`에만 둔다. 저장소 루트와 `harness/`는 지금처럼 Node 내장 기능만 쓰고, 하네스 시험과 CI는 의존 설치 없이 돈다.
2. **앱이 하는 일은 넷이다.** 계정 연결(사전 점검 결과 보기, CLI 로그인 창 띄우기, API 키 받기), 실행 폴더 설치(`setup.mjs`), 코디네이터 대화, 진행 표시(읽기 전용).
3. **앱이 하지 않는 일.** 훅을 우회하거나 끄지 않는다. 역할(코디네이터·오퍼레이터·워커)이 하는 일을 앱이 대신하지 않는다. GitHub에 쓰지 않는다(이슈 작성은 코디네이터, 진행 표시는 읽기만). 대상 프로젝트를 고치지 않는다.
4. **코디네이터 세션은 자식 프로세스다:** 실행 폴더에서 `claude -p --input-format stream-json --output-format stream-json --verbose --setting-sources project,local --allowedTools "<README와 같은 목록>"`. 한 프로세스에 사용자 메시지를 한 줄씩 보내고, `result` 줄을 받으면 다음 메시지를 받는다. 앱을 다시 켜면 마지막 `session_id`로 `--resume`한다.
5. **Node.** 하네스 스크립트와 훅은 사용자 컴퓨터의 `node`(22 이상)로 돈다. 앱에 든 Electron의 Node는 쓰지 않는다(훅 명령이 `node "<하네스>/guard.mjs"`다). 사전 점검이 이미 Node 버전을 본다. 하네스 폴더는 설치 파일 안에서 압축 묶음(asar) 밖에 풀린다.
6. **API 키.** CLI 로그인이 없는 키(Jev `TYPESAFE_API_KEY`, Gemini `GEMINI_API_KEY`)만 앱이 받아 Electron `safeStorage`로 암호화해 앱 데이터 폴더에 둔다. 코디네이터 프로세스를 띄울 때 환경 변수로만 넘긴다. 실행 폴더 파일과 로그에는 쓰지 않는다.
   - 코디네이터·오퍼레이터의 Bash는 훅이 허용한 명령 모양만 쓸 수 있고 `$`를 못 쓰므로 환경 변수를 출력할 수 없다.
   - 워커는 부모 환경 변수를 통째로 받지 않고 그 러너의 `secretEnv`만 받는다(A3, ADR 0009). 그래서 Jev 키는 워커에 가지 않고, gemini 워커만 `GEMINI_API_KEY`를 받는다.
   - 워커가 같은 사용자 권한으로 파일을 읽는 것은 막지 못한다(#31 알려진 한계).
7. **진행 표시는 새 화면이다(결정 8-14).** 지정 저장소의 이슈와 상태 라벨(`gh issue list --json`, 1분마다), 실행 폴더의 `handoffs/`, `advice-log.jsonl`, `guard.log`를 읽어 보인다. 관제탑 목업(`index.html`, `js/`)의 팀·진행률 모양은 쓰지 않는다.
8. **설치 파일은 Windows NSIS, 서명 없이(결정 8-13).** README에 "알 수 없는 게시자" 경고를 넘기는 방법을 적는다.

## 확인 (#39, 2026-11-19)

run-7 실행 폴더에서 위 4번의 명령을 자식 프로세스로 띄우고 세 턴을 보냈다(`docs/checks/B1-app-session.md`).

| 통과 조건 | 결과 |
|---|---|
| 훅이 돈다 | `guard.log`에 코디네이터 판정 2줄(허용 1, 거부 1) |
| 금지 동작은 거부로 끝나고 세션은 이어진다 | 대상 프로젝트 `Write`가 거부되고 같은 세션에서 "막혔습니다"로 답함. 파일은 생기지 않음 |
| 둘째 턴이 첫 턴의 맥락을 안다 | 둘째 턴이 도구 없이 첫 턴의 확인 결과를 다시 말함. 세 턴 모두 같은 `session_id` |
| 폴더 신뢰 질문 없이 돈다 | 비대화형(`-p`)에서는 신뢰 질문이 없다. 신뢰하지 않은 폴더라 설정의 `permissions.allow`는 무시되지만 `--allowedTools`로 넘기고, 훅은 그대로 돈다 |
| 10분 넘는 하달 | Bash 도구는 10분에서 끊는다(run-7 R7-2). `run-operator`가 분리 실행과 `wait-operator`로 바뀌어 한 번의 Bash 호출은 9분 안에 끝난다 |

미확인: `PreCompact` 훅이 stream-json 세션에서 발화하는지(시나리오 10), 앱을 닫을 때 진행 중인 하달을 남겨 둘지(지금 설계는 남겨 두고 다시 켜면 `wait-operator`로 이어 감).

## 결과와 위험

- 앱은 Claude Code CLI(`claude`)와 Node를 사용자가 따로 설치해야 한다. 사전 점검 화면이 없는 것을 알린다.
- Claude Code의 stream-json 형식이 바뀌면 대화 화면이 깨진다. 형식은 `type`·`subtype`·`message.content`만 읽고 모르는 줄은 무시한다.
