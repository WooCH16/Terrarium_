# 소유자 결정 기록 (이슈 #2)

2026-11-18에 소유자에게 하나씩 물어 받은 답이다. 반영 여부는 각 줄의 "반영" 칸에 적는다.

| # | 항목 | 결정 | 반영 |
|---|---|---|---|
| 1 | 조언 판정의 형식과 실행 수단 | 리뷰어 전용 폴더, 어드바이저가 `run-reviewer --advice`로 직접 호출, `허용된 조언: <SHA-256>`, 2회 한도는 스크립트, 리뷰어 후보에 Muse 포함(공개 가능한 제안문만) | ADR 0006 작성. `run-reviewer --advice`, 훅 정책, `reviewer-inbox/` 구현함. `coordinator.md` 반영함. 제안문의 "공개 가능" 표시를 붙이는 기준(어드바이저 정의)은 남음 |
| 2-1 | 재작업 한도 초과 처리 | **모아서 보고**(overview 7.2·7.3). 막힌 이슈는 반복해도 실패한 것이므로 모아 두었다가 7.3 조건에서 보고한다 | `harness/coordinator.md` 직접 지시 경로 9번, "막힌 이슈의 모음 보고" 끝 줄 |
| 2-2 | 시나리오 9의 "3.3" 표기 | **7.2의 오기**로 보고 "7.2·7.3"으로 고친다 | `docs/01-overview.md` 9절 시나리오 9 |
| 2-3 | 재작업 경로 | **반영 없이 새 하달로 재작업**. 한도 안에서는 사용자 개입 없이 돈다(코드와 `docs/operator.md` 3.2 변경 필요) | `harness/coordinator.md` 직접 지시 경로 8번. 오퍼레이터 코드(`run-operator`, `merge-adapter`), `docs/operator.md` 3.2, 시험 `operator-rework.test.mjs` |
| 2-4 | 결과 없음 처리 | **2회 다시 시키고**, 그래도 없으면 보류하고 막힌 이슈로 모아 보고한다(8-4로 보류 대신 `막힘`) | `harness/coordinator.md` 직접 지시 경로 7번, "응답 없음 판정", "실패" |
| 3-1 | 승인 표현의 기본 목록 | "승인", "진행해", "좋아", "그대로 해", "OK/ㅇㅋ"만 승인. "음", "글쎄", 조건이 붙은 말은 승인이 아니므로 다시 묻는다. 승인은 가장 최근 버전에만 적용 | `harness/coordinator.md` "승인 규칙" 끝 줄 |
| 3-2 | 승인본이 있을 때 요구 변경 | **항상 vN+1을 만들어 다시 승인**받는다 | `harness/coordinator.md` "작업 중 요구가 바뀔 때" 끝 줄 |
| 3-3 | 응답 없음의 시간 값 | **30분** 동안 소식(댓글, 커밋, 상태 변경)이 없으면 응답 없음. 설정값으로 둔다. 그 뒤는 2-4대로 | `harness/coordinator.md` "응답 없음 판정" 2번, `coordinator.config.json`의 `noResponseMinutes`, overview 8절 |
| 3-4 | "부족하다"의 기준 | **리뷰어에게 맡긴다.** 코디네이터는 따로 판단하지 않고 조언 판정의 거부를 부족으로 본다 | `harness/coordinator.md` 직접 지시 경로 5번(ADR 0006에 맞춤). 겹치던 "1회 다시 묻기"는 8-3으로 지움 |
| 4-1 | `run-reviewer` 종료 코드 3 | 리뷰어 실행 실패를 **6**으로 바꿔 모든 스크립트에서 3은 "중단"으로 맞춘다 | 코드·시험·`harness/README.md` 반영함. `coordinator.md`의 "run-reviewer 종료 코드"는 남음 |
| 4-2 | 리뷰어 스크립트 실패 시 할 일 | 실행 실패, 결과 불인정, 게시 실패: **같은 리뷰어로 2회** 다시 띄우고, 안 되면 **다음 후보로 2회**, 그래도 실패하면 **멈추고 사용자에게 보고**한다. 설정 오류(2)는 바로 알린다(제안 그대로로 봄). 실패를 허용으로 보지 않는다 **(바뀜 → ADR 0008, 이슈 #25: 리뷰어가 Jev 하나라 다음 후보가 없다. 일시적 Jev 실패는 스크립트가 2회 다시 부르고 코디네이터는 6을 다시 부르지 않는다. 4·5는 코디네이터가 2회 다시 부른다)** | `harness/coordinator.md` "run-reviewer 종료 코드"(6 기준). 다음 후보로 넘기는 수단은 스크립트에 없음 |
| 5-1 | 안 쓰는 리뷰어 하위 에이전트 정의 | `harness/agents/reviewer.md`, `setup.mjs`의 복사, 관련 시험을 **지운다** | 반영함(정의·복사·시험 삭제, 훅의 reviewer 하위 에이전트 분기 삭제). 이미 만든 실행 폴더의 `.claude/agents/reviewer.md`는 `--refresh`가 지우지 않지만 훅이 reviewer를 막는다 |
| 5-2 | `docs/harness/` 옛 복사본 | `coordinator.md`, `README.md`는 **지우고** `advisor.md`는 남긴다 | 두 파일 지움, 참조 정리(`README.md`, `docs/README.md`, `harness/README.md`) |
| 5-3 | 오퍼레이터 모델 대체 표 | **순환형으로 채운다**: claude → gemini → muse → claude. 리뷰어 순환은 실제로 쓴 모델 타입 기준, 보고서에 지정 → 실제를 적는다. muse로 대체되면 Contributor 등급이라 공개 가능한 이슈인지 확인이 필요하다 | `operator.config.json` `fallback`, 이슈 본문 `공개 가능: 예`일 때만 muse로 대체, 보고서 `실제 워커 모델:` 줄을 리뷰어 순환이 읽음, `docs/operator.md`, 이슈 양식에 `공개 가능` 칸 |
| 6 | 이슈 삭제 권한 | 삭제하지 않고 **"취소" 라벨을 붙여 닫는다**(`gh issue close`). 권한은 넓히지 않는다 | `harness/coordinator.md` "이슈 취소", overview 4.3. `취소` 라벨 생성은 8-1로 반영 |
| 7 | 2단계 임시 결정(`docs/checks/T6-T7-pi-scripts.md` "임시 결정") | 1, 2, 4, 5, 7~11은 **시작값대로 확정**. 3은 결정 1로 정함 | 확정. `docs/checks/T6-T7-pi-scripts.md` "임시 결정"에 표시 |
| 7-6 | gemini·claude의 Pi 우회 경로 | **Pi로 통일한다.** F5는 Pi에서 `agy`를 부르는 방식(Pi 확장 또는 Pi의 bash 도구)을 설계하고, F6는 소유자가 Pi의 Anthropic 자격 증명을 설정한다. 그때까지 직접 경로는 임시로 남는다 | 대기(F5 설계, F6 소유자 설정) |

## 2026-11-19 추가 결정

합친 뒤 남은 질문 다섯 개를 다시 물어 받은 답이다.

| # | 항목 | 결정 | 반영 |
|---|---|---|---|
| 8-1 | `취소` 라벨이 없을 때 | **`run-operator`가 만든다.** 상태 라벨을 만드는 자리(`setup`·`run-operator`·`run-research`)에서 `취소`도 함께 만든다. 상태 라벨이 아니고 코디네이터 권한은 넓히지 않는다(ADR 없음) | `report.mjs` `ENSURED_LABELS`, `run-operator.mjs` `ensureLabels`, `setup.mjs`, `docs/operator.md` 10.3절 |
| 8-2 | 조언 수정 횟수 | **판정 2번**(첫 제출 + 수정 1회). 구현은 그대로 두고 규칙 문서를 맞춘다 | `coordinator.config.json` `advisorRevisionAfterReject: 1`, `coordinator.md` 5번, overview 3.5·8절. `run-reviewer.mjs` `ADVICE_LIMIT = 2`와 같은지 시험으로 묶음 |
| 8-3 | "부족하면 1회 다시 묻는다" | **지우고 합친다.** 부족함은 조언 판정의 거부로만 다룬다 | `advisorRevisionWhenInsufficient` 설정·규칙 줄·시험 삭제, overview 3.5·8절·9절 시나리오 6 |
| 8-4 | 결과 없음 재시도와 재작업 한도 | **따로 센다.** 2회 다시 시켜도 보고서가 없으면 그 자리에서 `막힘`으로 두고 막힌 이슈로 모아 보고한다 | `run-operator.mjs`(`handoffs/no-report.json`, `operator.config.json` `noReportRetries: 2`), `coordinator.md` 7번·"응답 없음 판정", `docs/operator.md` 3.2, 시험 `operator-rework.test.mjs` |
| 8-5 | 새 하달의 시작점 | **선행 반영 때까지 기다린다.** 의존하는 이슈가 허용됐지만 아직 반영되지 않았으면 이번 하달에서 빼고 `대기`로 둔다. 반영 뒤 `main`에서 다시 시작한다. 이슈 양식의 칸 이름은 "의존하는 이슈"다 | 상태 `대기` 추가(`report.mjs`, 합치기 제외), `run-operator.mjs`, `coordinator.md` 7번·종료 코드 표, `docs/operator.md` 3.2·10.3절, overview 4.1 |
| 8-6 | Muse에 넘기는 내용 | **공개 여부를 따지지 않는다.** 소유자의 비공개 내용(이슈, 제안문, 보고서, 대상 코드)도 Muse에 들어가도 된다. 5-3과 ADR 0006 결정 6의 공개 제한을 대체한다 | ADR 0007. 공개 기본값은 제한을 켜 두고(오픈소스 v0 0단계), 이 결정은 실행 폴더의 `operator.local.json`(`runners.muse.publicOnly: false`, git 없음, 훅 보호)에 둠. 조언 판정도 설정을 보게 바꿈(`run-reviewer.mjs`), `coordinator.md` 이슈 양식 설명, `docs/operator.md` 5.1·10.2·14·15절, `harness/operator/work.md`. 장치는 `publicOnly: true`로 다시 켤 수 있다 |
| 8-7 | 리뷰어와 라우팅 모델 | **Jev(TypeSafe System One, HTTP API)로 대체한다.** 라우팅은 판단 영역이고, 하달마다 워커 모델과 유형을 Jev가 고른다. 키 이름은 `TYPESAFE_API_KEY`(값은 그대로) | ADR 0008, `run-reviewer.mjs`, `jev-review.mjs`, `route-issue.mjs`, `operator.config.json` `jev`, `coordinator.md` 6·8번, 이슈 #44 |
| 8-8 | Jev 판정이 애매할 때(0.3~0.7) | **거부로 처리한다.** 기준별 확률을 이유로 남기고, 재작업 한도(2회)에 센다 | `jev-review.mjs` `decide`, ADR 0008 결정 1 |
| 8-9 | 라우팅의 워커 모델 기준 | **간단한 코드는 muse(값이 싸서).** muse: 파일 한두 개 안에서 끝나고 기대 동작이 분명한 코드 변경(작은 버그 수정, 옵션 하나, 시험 추가)과 문서·예시. gemini: 범위가 분명한 여러 파일 기능 변경. claude: 여러 파일·모듈을 이해해야 하는 변경, 설정·권한·보안·비밀값 변경. 처음 몇 번은 muse의 거부율을 보고 기준을 좁힐지 정한다 | `operator.config.json` `jev.routing.workerModels`, `harness/e2e/jev-probe.mjs`, ADR 0008 결정 2, 이슈 #44 |
| 8-10 | 워커 실행 경로 | **셋 다 Pi로.** claude는 Pi의 Anthropic 계정 로그인, gemini는 하이드로젠 모델(`google/gemini-4-hydrogen:medium`)과 `GEMINI_API_KEY`. claude 워커의 하네스 훅이 없어진다는 점을 알고 골랐다 | ADR 0009, `operator.config.json` `runners`, `run-worker.mjs`, `preflight.mjs`, 이슈 #26 |
| 8-11 | 남은 v0의 진행 방식 | **위임.** "코디네이터는 계획대로, 어드바이저·오퍼레이터·워커는 알아서 만들고, 데스크톱 앱이 완성되면 알려 달라. 중간 조언은 fable." 결정 9-4와 #42의 "설계 방향은 소유자가 준다", #34의 "뼈대 전에 확인받는다"를 이 위임으로 대체한다. 어드바이저 초안 문서는 참고만 한다. 실제 모델 호출은 필요한 만큼 쓰고 기록한다 | `docs/checks/open-source-v0.md`, 이슈 #34·#42 |
| 8-12 | 공개 저장소의 내부 이슈 #2~#18, PR #1(#33) | **끝난 것만 닫는다.** 결과 요약 댓글과 함께 닫고, 남은 것(T12·T13·D1·D2)은 v0 이슈에 연결해 둔다. PR #1은 손대지 않는다 | 이슈 #33 |
| 8-13 | Windows 설치 파일 코드 서명(#41) | **v0는 서명 없이.** 처음 설치할 때 "알 수 없는 게시자" 경고가 뜨는 것과 넘어가는 방법을 README에 적는다. 서명은 v1 | 이슈 #41 |
| 8-14 | 앱 화면(#40) | ~~**새 화면.** 관제탑의 팀·진행률 모양 대신 하네스 상태(이슈와 상태 라벨, 하달, 판정 기록)에 맞는 화면을 새로 만든다~~ **(바뀜 → 8-18)** | 이슈 #40 |
| 8-15 | claude 워커 모델 | **sonnet까지만 올린다(`anthropic/claude-sonnet-5-5`).** "낮은 모델이 이해할 수 있을 정도의 작업 단위로 쪼개서 줄 것이라 걱정하지 마." 그래서 어드바이저의 설계 원칙에 "작업 단위는 작은 워커 모델(muse·haiku급)도 한 번에 이해할 크기로 나눈다"를 넣는다 | `operator.config.json` `runners.claude`, 어드바이저 설계(#42) |
| 8-18 | 앱 화면과 코디네이터(8-14 고침) | **소유자가 만든 관제탑 화면을 쓰고, 그 화면의 코디네이터 칸(ORCHESTRA)에만 Claude 세션을 넣는다.** "내가 만든 관제탑 화면을 사용할거고, 그 화면에서 코디네이터 부분만 클로드 세션을 넣을거야." 8-14는 9-5(관제탑 화면을 앱 화면으로)와 다르게 적혔던 것이다. 코디네이터는 대화형 터미널로 넣는다. 관제탑의 나머지(카드·팀·통합·사무실)는 이번에 바꾸지 않고, 실제 상태와 잇는 방식은 따로 정한다 | ADR 0011, `app/main.js`, `app/lib/terminal.mjs`, `js/terminal.js` |
| 8-20 | 컴팩션 뒤 복구 보고 | **컴팩션이 끝나면 훅(`SessionStart`, matcher `compact`)이 압축 후 검증 알림과 보존 노트 경로를 넣고, 보존 노트 이름은 `{{ISSUES}}/records/<프로젝트>-보존.md`.** 어시스턴트 제안에 "제안대로 둘 다 해줘"(2026-11-20). run-18 시나리오 10에서 복구 보고가 빠진 것을 고침 | `harness/compact-notice.mjs`, `setup.mjs`, `coordinator/AGENT.md` |
| 8-21 | 하달 중 Esc | **(가) Esc에도 하달이 살아남게 분리 실행에 발사 프로세스를 하나 더 거치고, (나) 끊긴 뒤 코디네이터는 가장 최근 대기 번호(`handoffs/last-wait.json`, run-18 h7에서 고침)로 이어 기다리고, 죽었으면 `stop-operator`로 정리한 뒤 묻는다.** 같은 말로 정함 | `operator/background.mjs`, `coordinator/AGENT.md` |
| 8-22 | 역할마다 하는 일을 스킬로 | **각 역할이 해야 할 일을 스킬(`SKILL.md`)로 저장한다("원래 이런 방식"). AGENT.md는 그대로 두고 스킬을 더한다.** 스킬은 `harness/<역할>/skills/<역할>-<일>/`에 두고, 순서와 확인할 점을 적으며 AGENT.md 절을 가리킨다. 받는 방법은 역할마다 다르다: 코디네이터는 Skill 도구, 어드바이저는 하위 에이전트 정의의 `skills:` 미리 주입, 오퍼레이터·워커는 지침 글에 붙임, 리뷰어(Jev 코드)는 주입하지 않는 절차 문서. 오퍼레이터 모드 문서(`work/research/reflect.md`)는 스킬로 옮겼다 | 2026-11-20 대화 | run-18 h9 |
| 8-23 | 어드바이저 분야 지식 | **어드바이저에게 분야별 전문가 지식 md(웹 사이트, 앱, 게임 개발, 보안, 마케팅, 디자인)를 넣는다. 분야마다 후보 3개를 시험해 가장 나은 것을 고르고, 시니어 수준으로 개념을 아는지 문제와 채점으로 확인하며, 부족하면 보강을 되풀이한다.** v0의 어드바이저는 하나(8-17)이므로 후보 3개는 그 어드바이저에 붙일 지식 파일 후보다. 파일은 스킬 `advisor-domain-knowledge`의 `knowledge/`에 두고 닿는 분야만 Read로 읽는다(docs/advisor.md 8절) | 2026-11-21 대화 | 시험 기록(작업 폴더, 저장소 밖) |
| 8-19 | 관제탑 카드·팀·통합·사무실의 실제 상태 | **최근 하달 = 오퍼레이터 카드, 하달이 맡은 이슈 = 워커, 막대는 이슈 라벨 단계, 읽기 전용.** 어시스턴트의 제안에 "조언대로 해줘". 하달 멈춤 단추는 다음에 정한다 | ADR 0011 덧붙임, `app/lib/tower.mjs`, `js/live.js` |
| 8-17 | 위임(8-11) 아래 정한 것 | **v0의 어드바이저는 하나**(대상 프로젝트 전체, 협의는 v1). **조언 id는 코디네이터가 정한다**(`adv-<영문 요약>-<번호>`, 시각을 쓰지 않음). **재작업 한도는 리뷰어 판정을 받은 보고서로 센다**(판정 없는 실패 보고서는 세지 않고 전체 상한을 따로 둔다). **같은 하달의 의존 이슈는 통합 브랜치에서 시작한다.** 정리본 경로의 요구 변경은 새 승인 없이 처리하고, 승인 표현 목록은 따로 두지 않는다(overview 3.6·3.7). 근거는 실제 실행 기록 | `docs/checks/runs.md`, 커밋 기록 |
| 8-16 | claude 워커의 난이도 분류 | **sonnet과 haiku를 둘 다 쓰고 어려움 정도로 나눈다. 기준은 Claude가 세운다.** 쉬움(haiku): 이슈 글만으로 한 번에 고칠 수 있음(고칠 파일과 기대 동작이 적혀 있고 기존 설계를 먼저 이해할 필요 없음). 어려움(sonnet): 여러 부분이 맞물리는 방식을 먼저 읽어야 하거나, 경계 조건이 불분명하거나, 동시성·데이터 이전·보안 영향이 있음. 보안 경계(비밀값·권한·파일 접근 범위·인증·바깥 입력 신뢰)에 닿으면 어려움. 애매하면 어려움. 어려운 일은 muse에 보내지 않는다 | `operator.config.json` `runners.claude.tiers`·`jev.routing.difficulty`, `route-issue.mjs`, `runners.mjs`, ADR 0008 결정 2 |
