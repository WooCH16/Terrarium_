# 관제탑 화면과 세션 이벤트

앱 본창의 관제탑 화면(`app/tower/`)이 무엇을 어디서 읽어 그리는지 적은 문서입니다. 코드의 기준은 `app/lib/flow.mjs`(기록 → 이벤트), `app/main.js`(IPC), `app/preload.cjs`(렌더러가 쓰는 API), `app/tower/app.js`(이벤트 → 화면)입니다.

화면 디자인은 소유자가 만든 Terrarium UI(캔버스 위에 코디네이터 창과 하위 세션 창이 뜨는 모양)를 옮긴 것입니다. 원본의 목(mock) 오케스트레이터와 예시 데이터는 가져오지 않았고, 모든 창과 숫자는 실제 기록에서 나옵니다.

## 1. 화면 구성

| 자리 | 무엇 | 출처 |
|---|---|---|
| 가운데 코디네이터 창 | 진짜 Claude Code 코디네이터 터미널(대화형, 실행 폴더에서 뜸). 창 아래 한 줄은 최근 흐름 기록 | `node-pty` + xterm(`app/tower/terminal.js`), 흐름 기록은 아래 이벤트 |
| 오른쪽 ADVISORS | 코디네이터가 부른 어드바이저 하나당 창 하나 | `guard.log` |
| 아래 OPERATORS | 하달 한 번(`handoffs/h<N>`)당 창 하나, 이름은 그 하달의 팀 | `handoffs/h<N>/dispatch.json`, `session.json` |
| 그 아래 WORKERS | 그 하달에서 워커를 부른 이슈 하나당 창 하나, 모델은 하네스가 고른 값 | `handoffs/h<N>/workers.jsonl`의 `start` |
| JEV 표시 | 어드바이저·오퍼레이터가 끝날 때 잠깐 켜짐(리뷰어 Jev 판정 자리) | 화면이 이벤트에서 계산 |
| 왼쪽 위 | [처음 화면], 실행 폴더 단추(목록, 다른 폴더 열기), 열어 둔 실행 폴더 탭 | 앱 설정(`prefs.json`)의 실행 폴더 목록 |
| 오른쪽 위 | live 수, 시각, 사용량, 톱니(설정 요약 → [설정 열기]), 프로필(계정 관리, 진행 기록) | statusline 파일, `gh api user`, 실행 폴더의 `harness.json` |

하달하지 않은 팀의 오퍼레이터, 하달에 없는 이슈의 워커는 화면에 나오지 않습니다. 미리 자리를 잡지 않고 실제로 생긴 세션만 그립니다.

## 2. 기록 → 세션

| 세션 | 생기는 때 | 상태 |
|---|---|---|
| 어드바이저 `adv-<k>` | 코디네이터(`agent_type` 없음)의 `Agent` 도구 줄. 코디네이터는 advisor만 부를 수 있다(policy.mjs) | 어드바이저 줄이 오면 WORKING, `run-reviewer --advice`면 REVIEWING. 코디네이터가 Agent 아닌 도구를 다시 쓰면 DONE |
| 오퍼레이터 `op-h<N>` | 앱을 켠 뒤(또는 새 실행 뒤) 새로 생긴 하달 폴더, 또는 앱을 켤 때 도는 하달 | 세션 프로세스가 살아 있으면 WORKING, 끝난 시각이 있으면 DONE(`sessionOk: false`면 ERROR), 멈춤(`stopped.json`)·끊김(프로세스 없음)은 ERROR |
| 워커 `wk-h<N>-<이슈>` | `workers.jsonl`의 `start` 줄. 모델을 못 골라 `end`만 있는 이슈는 워커가 아니다 | `end`가 없으면 WORKING, `end`의 상태가 `완료`면 DONE, 그 밖(막힘, 실패)은 ERROR |

`guard.mjs`는 Agent 줄의 `summary`에 호출 설명(`description`)을 남깁니다. 어드바이저 창의 할 일 칸이 그 설명입니다.

## 3. 한 번의 실행(run)

- 사용자가 코디네이터 터미널에서 Enter로 한 줄을 보냈을 때 도는 세션이 없으면 새 실행을 시작합니다. 화면을 비우고 그 줄을 기록 맨 위에 둡니다.
- 도는 세션이 있을 때 보낸 줄(질문에 답하기 등)은 같은 실행으로 이어 갑니다.
- 사용자가 치지 않았는데 새 세션이 생기면(앱을 늦게 켰거나 코디네이터가 이어서 일함) 그때 실행을 엽니다.
- 기준점: 앱을 켤 때, 실행 폴더를 바꿀 때, 새 실행을 시작할 때 이미 끝난 기록은 다시 그리지 않습니다.
- 코디네이터 상태: 세션이 돌면 DELEGATING, 세션이 다 끝나고 코디네이터가 20초 동안 도구를 쓰지 않으면 DONE(그 실행에 세션이 없었으면 READY), 그 사이는 THINKING. 잠잠함은 마지막 세션이 끝난 때부터도 셉니다(하달 동안 코디네이터는 `run-operator`를 기다리느라 도구를 쓰지 않기 때문입니다).
- 터미널이 떠 있지 않으면 상태 칸은 OFFLINE(끝났으면 ENDED)입니다.

## 4. 이벤트 모양

메인 프로세스가 `orchestrator:event`로 보냅니다. 모든 이벤트에 `type`과 `runId`가 있고, 화면은 지금 실행과 `runId`가 다른 이벤트를 버립니다.

| `type` | 내용 | 화면 |
|---|---|---|
| `run.started` | `text` | 앞 실행의 창·기록을 지운다 |
| `coordinator.status` | `status`: READY, THINKING, DELEGATING, DONE, ERROR | 코디네이터 창 오른쪽 위 표시 |
| `coordinator.log` | `text`, `tone`(user, info, advisor, operator, worker, success, error) | 코디네이터 창 아래 한 줄(최근 6줄을 기억) |
| `session.spawned` | `session`: `{ id, role, parentId, label, model, task }` | 창이 뜬다(SPAWNING) |
| `session.status` | `id`, `status`: SPAWNING, REVIEWING, WORKING, DONE, ERROR | 창의 상태 표시 |
| `session.output` | `id`, `text` | 창의 활동 한 줄(다음 상태 변화에 지워짐) |
| `run.finished` | `ok` | 실행 하나가 끝남(한 번만) |

`role`은 `advisor`, `operator`, `worker`이고, 워커의 `parentId`는 그 하달의 오퍼레이터 id입니다. 화면을 다시 읽으면(창 다시 읽기) 메인 프로세스가 지금 실행의 세션과 상태를 다시 보냅니다(`FlowTracker.replay`).

## 5. 위쪽 칸의 값

- **사용량:** 앱은 코디네이터를 띄울 때 `--settings <앱 데이터>/coordinator-settings.json`으로 statusline 명령 하나를 더합니다(`app/lib/statusline.mjs`). Claude Code가 statusline에 주는 JSON에서 `rate_limits.five_hour`, `rate_limits.seven_day`, `context_window.used_percentage`, 모델 이름, 버전만 골라 `<앱 데이터>/coordinator-status.json`에 씁니다. 한도 값은 Claude Pro·Max 구독에서, 세션의 첫 응답 뒤에만 옵니다. 값이 없으면 "사용량 모름"으로 보입니다. 실행 폴더의 훅·권한 설정은 건드리지 않습니다.
- **계정:** GitHub 로그인 이름(`gh api user`, 5분 기억), 실행 폴더의 지정 저장소, 사전 점검 통과 여부.
- **워커 모델:** 하네스가 이슈마다 정합니다(Jev 라우팅). 화면에서는 보기만 합니다.

## 6. 화면 다루기

- 배경 끌기: 화면 이동. 휠: 확대·축소. 배경 두 번 누르기: 원위치. 배경 클릭: 파동.
- 코디네이터 창과 세션 창: 머리줄을 끌어 옮기고, 가장자리를 끌어 크기를 바꿉니다.
- 오퍼레이터 창 두 번 누르기: 그 하달의 워커와 모델, 상태.
- 코디네이터 터미널은 화면 배율을 되돌려 늘 1배로 그립니다. 축소해도 글자가 흐려지지 않고 마우스 선택 위치가 맞습니다. 배율이 바뀌면 터미널 칸 수가 바뀝니다.

## 7. 시험

- `cd app && npm test`: 기록 → 이벤트(`test/flow.test.mjs`). 기록은 하네스의 기록 함수(`writeDispatch`, `logWorker`)로 씁니다.
- `cd app && npm run smoke`: 진짜 앱 창을 띄우고 입력 이벤트로 움직입니다. 코디네이터는 가짜(`test/fake-coordinator.mjs`)라 모델·네트워크·GitHub를 부르지 않습니다. 하달 한 번에 딱 필요한 세션(어드바이저 1, 하달한 두 팀의 오퍼레이터, 워커 2)만 뜨는지, 하위 세션 없는 차례에는 아무것도 뜨지 않는지 등 27개를 봅니다. 결과와 그림은 `app/out/smoke/`.
- 실제 모델로 도는 종단 시험은 `harness/e2e/`(비용 발생)입니다.

## 8. 예전 관제탑에서 빠진 것

0.2.0에서 화면을 바꾸며 저장소 루트의 예전 관제탑(`index.html`, `css/`, `js/`, `assets/`)을 지웠습니다. 그와 함께 빠진 것: 오른쪽 폴더 패널(파일 트리, 수정 중 주황·완료 초록 표시, 폭 조절·접기), 팀 상세·통합·사무실(픽셀 그림) 보기, 늘 다섯 자리인 역할 카드, 브라우저 미리보기(목 데이터). 하달과 이슈 진행은 설정 화면의 진행 기록 탭에 그대로 있습니다.
