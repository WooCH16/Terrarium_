# 워커 설계

- 실행 문서: [`harness/worker/AGENT.md`](../harness/worker/AGENT.md) (`run-worker.mjs`가 읽어 워커 입력 맨 앞에 붙인다)
- 스킬: `harness/worker/skills/worker-issue`(이슈 하나 끝내기 점검표). 워커 모델은 Claude Code가 아닐 수 있어 Skill 도구로 부르지 않고, `run-worker.mjs`가 실행 문서 뒤에 본문(frontmatter 뺌)을 붙인다.
- 실행 코드: `harness/operator/run-worker.mjs`, `runners.mjs`, `model-exec.mjs`
- 결정: ADR 0004(워커는 시작 스크립트로), ADR 0007(Muse 공개 제한), ADR 0008(라우팅), ADR 0009(세 모델 모두 Pi). 오퍼레이터 쪽 접점은 [operator.md](operator.md) 5장

## 1. 개요

워커는 이슈 하나를 맡아 실제로 코드를 고치는 역할이다. 오퍼레이터가 `run-worker.mjs`로 부르고, 작업이 끝나면 결과 파일을 남기고 종료한다. 하위 에이전트가 아니라 **Pi 하네스로 띄우는 별도 프로세스**다(ADR 0004, 0009).

## 2. 하는 일과 하지 않는 일

| 하는 일 | 하지 않는 일 |
|---|---|
| 자기 워크트리에서 코드 고치기, 시험 더하고 돌리기 | 워크트리 밖 쓰기, `main` 바꾸기 |
| 이슈 브랜치에 커밋 | `git push`, 이슈 댓글 같은 외부 쓰기 |
| `.harness/worker-result.md`에 결과 네 칸 쓰기 | 결과 보고서 쓰기(오퍼레이터), 판정(리뷰어), 합치기(오퍼레이터) |

## 3. 실행

- **명령:** `node run-worker.mjs --handoff h<N> --issue <n> --model <claude|gemini|muse> [--base main]`
- **워크트리:** 스크립트가 이슈 브랜치 `h<N>/issue-<n>`의 워크트리를 `worktrees/h<N>/issue-<n>`에 만든다.
- **모델(ADR 0009):** 세 모델 모두 Pi로 띄운다. claude는 `anthropic/claude-sonnet-5-5`이고, 이슈의 `난이도: 쉬움`이면 `anthropic/claude-haiku-5-5`(결정 8-16). gemini는 `google/gemini-4-hydrogen:medium`, muse는 `meta/muse-spark-1.3-contributor`.
- **누가 모델을 정하나:** 라우팅(`route-issue.mjs`, Jev)이 이슈마다 워커 모델·유형·난이도를 정하고, 코디네이터가 이슈 본문에 옮긴다(ADR 0008).
- **비밀값:** 러너마다 `runners.<모델>.secretEnv`에 이름만 적는다(gemini: `GEMINI_API_KEY`). 스크립트가 환경 변수 → 실행 폴더 `.env` → 하네스 저장소 `.env`에서 읽어 그 러너에만 넘긴다.

## 4. 입력과 출력

- **입력:** `.harness/worker-input.md` = 실행 문서 전체 + 워커 스킬 본문 + `# 워커 입력 (이슈 #n)` 절(이슈 번호, 워크트리, 이슈 본문, 이전 실패 이유). 다른 이슈, 코디네이터·사용자 대화는 넘기지 않는다. 이슈 본문은 참고용 데이터로 넘긴다.
- **출력:** `.harness/worker-result.md`의 네 칸(`이슈 번호`, `변경 요약`, `테스트 명령과 결과`, `커밋 해시`). 칸 이름은 `protocol.mjs`의 `RESULT_FIELDS`이고, 시험이 실행 문서와 같은지 확인한다.
- **스크립트 출력:** 한 줄 JSON(시작·종료 `main` 해시, 시도 횟수, 실제로 띄운 `model`, 대체됐을 때 `replacedFrom`·`replacedReason`, 워크트리 이름).

## 5. 검사와 다시 시키기

- 시도마다 결과 파일을 검사한다: 파일이 있는지, 네 칸이 다 있는지, 이슈 번호가 맞는지, 커밋 해시가 이 이슈 브랜치에 기준 커밋 뒤로 새로 생긴 커밋인지, 금지 경로(`.claude`, `CLAUDE.md`, `AGENTS.md`, `CLAUDE.local.md`, `.mcp.json`, `.harness/`)를 바꾸지 않았는지.
- 어긋나면 그 이유를 `이전 실패 이유`에 붙여 다시 시킨다. 최대 `workerRetries + 1`번(기본 3번).
- 러너가 15분 동안 아무것도 출력하지 않으면 멈춘 것으로 보고 대체 모델로 넘긴다. 한 시도의 시간 한도는 2시간이다.

## 6. 모델 대체

- 지정 모델을 쓸 수 없으면(허용 목록 밖, CLI 없음, 러너 비밀값 없음) 대체 표를 돈다: `claude` → `gemini` → `muse` → `claude`. 한 바퀴 돌아 지정 모델로 돌아오면 멈춘다.
- `muse`는 Contributor 등급이라 입력이 학습에 쓰일 수 있다. 대체로 `muse`에 넘기는 것은 이슈 본문에 `공개 가능: 예`가 정확히 한 줄 있을 때만이다(ADR 0007, 실행 폴더 설정으로 끌 수 있다).
- 대체가 일어나면 오퍼레이터가 결과 보고서에 `모델: <지정> → <실제>`와 사유를 적는다.

## 7. 종료 코드

`0` 성공, `1` 막힘(모든 시도 실패, 또는 공개 제한으로 쓸 모델이 남지 않음), `2` 설정·인자·모델·저장소 실패, `3` 중단(`stop-operator`의 표시).

## 8. 안전과 한계

- **격리가 없다.** Pi에는 샌드박스가 없다. 작업 폴더가 워크트리라는 것뿐이다(ADR 0009, 알려진 한계 2). 워크트리 밖 쓰기, 외부 쓰기, 비밀값 기록은 실행 문서의 규칙과 결과 검사, 리뷰어 판정으로만 막는다.
- 합치기 시험은 워커가 쓴 시험 코드를 사용자 권한으로 돌린다.
- 오퍼레이터의 `stop-operator`가 `session.json`의 `pids`에 적힌 러너를 끝낸다.
