# 어드바이저 정의

어드바이저 정의의 기준은 [`harness/agents/advisor.md`](../../harness/agents/advisor.md) 하나다. `setup.mjs`가 그 파일의 `{{PROJECT}}`·`{{MEMO}}`·`{{RUN}}`·`{{HARNESS}}`를 채워 실행 폴더의 `.claude/agents/advisor.md`로 설치한다. 시험용 대역은 `setup --advisor-stub`으로 `harness/stubs/advisor-stub.md`를 설치한다.

설계(이슈 #42, 2026-11-19, 소유자 위임 8-11):

- v0의 어드바이저는 대상 프로젝트 전체를 맡는 하나다. 훅이 하위 에이전트 이름 `advisor` 하나만 받고, 하위 에이전트끼리는 말할 수 없어 overview 2.3의 "겹치면 모두 부르고 협의"는 v1로 미룬다.
- 입력: 사용자 지시 원문, 대상 프로젝트 경로, 코디네이터가 정한 조언 id, (있으면) 조사 결과 파일 경로.
- 하는 일: 대상 프로젝트를 읽기 도구로 읽고 → 작업 단위(작은 모델도 한 번에 끝낼 크기, 결정 8-15)로 나눈 제안문을 `reviewer-inbox/<조언 id>.md`에 쓰고 → `run-reviewer.mjs --advice … --advice-id <id>`로 판정받고 → 거부면 같은 id로 한 번 고쳐 다시 받고 → 스크립트 출력 줄을 그대로 돌려준다.
- 자료가 모자라면 제안문 대신 `자료 요청: <영역> / <질문>` 한 줄.
- 조언 id 우회 막기: 허용 줄에 `조언 id:`가 붙고, 코디네이터는 그 id와 `advice-log.jsonl`의 그 해시 줄의 `adviceId`가 자기가 넘긴 id인지 확인한다.
- 모델은 코디네이터와 같은 급(`model: inherit`). 분해가 틀리면 워커·리뷰어 비용이 전부 낭비되므로 여기서 아끼지 않는다.
