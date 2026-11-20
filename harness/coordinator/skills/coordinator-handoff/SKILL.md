---
name: coordinator-handoff
description: 이슈를 오퍼레이터에게 하달하고 끝까지 기다리는 순서. run-operator 호출, 종료 코드 8의 이어 기다리기, 보고서 없는 이슈 다시 시키기, Esc로 턴이 끊긴 뒤 이어 기다리기, stop-operator 중단을 다룬다. 이슈를 등록한 직후, "아까 하달 어떻게 됐어?"라는 질문을 받았을 때, 하달을 멈춰 달라는 말을 들었을 때 부른다.
---

# 하달

규칙 원문은 CLAUDE.md(규칙: "직접 지시 경로") 7번, "턴이 끊긴 뒤 (Esc)", "중단", "스크립트 종료 코드"다.

## 하달하기

1. `node {{HARNESS}}/operator/run-operator.mjs --issues <번호,번호,...>`를 **한 번** 부른다. Bash `timeout`은 600000, 백그라운드로 돌리지 않는다. `--handoff`는 붙이지 않는다.
2. 종료 코드 8(`진행 중: 대기 번호 <번호> | ...`)이면 그 줄의 `wait-operator.mjs --wait <번호>`를 같은 방식으로 부른다. 8이 오는 동안 반복한다. 8은 실패가 아니다.
3. 끝나면 이슈마다 `#번호 | 상태 | URL` 한 줄이 온다. URL에 `#issuecomment-`가 없으면 결과 보고서가 없는 것이다. 그 이슈만 새 하달로 2회까지 다시 시킨다(횟수는 `run-operator`가 센다).
4. 상태가 `대기`인 이슈는 의존 이슈가 아직 `main`에 없어서 빠진 것이다. 그 의존 이슈의 반영을 사용자에게 묻는다.
5. 보고서가 있는 이슈는 `coordinator-review`로 넘긴다. 종료 코드 2면 즉시 멈추고 알린다.

## 턴이 끊긴 뒤 (Esc)

하달 중 사용자가 Esc를 누르면 명령이 출력 없이 끝나도 하달은 계속 돈다. 새 하달을 띄우기 전에:

1. 끊긴 명령이 `run-operator`면 `{{RUN}}/handoffs/last-wait.json`, `run-research`면 `{{RUN}}/handoffs/last-wait-research.json`을 Read한다. `token`이 대기 번호다. `handoffs/bg/`의 다른 파일은 고르지 않는다(워커용이다).
2. `wait-operator.mjs --wait <token>`으로 이어서 기다린다. 나온 `#번호 | 상태 | URL` 줄이 하달 결과다.
3. 종료 코드 2("결과 없이 끝났습니다")면 하달이 죽은 것이다. `{{RUN}}/handoffs/`의 가장 큰 `h<N>/session.json`에 `endedAt`이 없으면 `stop-operator.mjs --handoff h<N>`으로 정리하고, 사용자에게 알리고 다시 하달할지 묻는다.
4. 살아 있는 하달 옆에 같은 이슈의 하달을 하나 더 띄우지 않는다.

## 멈추기

- 하달을 멈추는 방법은 `node {{HARNESS}}/operator/stop-operator.mjs --handoff h<N>` 하나다(출력 없음, 종료 코드 3). 사용자가 Esc로 멈추려 하면 "멈춰 달라"고 말하도록 안내한다.
- 멈춘 이슈는 보류로 기록하고 보고한다.

## 확인할 점

- 결과 보고서는 오퍼레이터가 올린 것만 인정한다. 내가 대신 올리지 않는다.
- 같은 하달을 다시 시작하지 않는다. 다시 시키는 것은 늘 새 하달이다.
