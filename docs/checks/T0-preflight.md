# T0 사전 확인 결과

- 확인일: 2026-11-18
- 환경: Claude Code 2.1.327, Windows 11, Node 내장 기능만 사용
- 시험 훅은 저장소 밖 임시 폴더에서 돌렸고, 사용자 전역 설정(`~/.claude/`)은 수정하지 않았다.
- 상태 표기: **확인됨**(공식 문서나 실행으로 확인), **안 됨**(되지 않는 것을 확인), **확인 불가**(확인하지 못함)

## 확인 표

| # | 항목 | 상태 | 근거 |
|---|---|---|---|
| 1 | 컴팩션 직전 신호 (ADR 0001 미확인 1) | 확인됨 (문서). 실제 발화는 시험하지 않음 | Claude Code 공식 문서 Hooks 참고 문서(`code.claude.com/docs/en/hooks`)에 `PreCompact` 이벤트가 있다. 매처는 `manual`(`/compact`)과 `auto`(자동 컴팩션, 유휴 컴팩션)이고, 입력에 `trigger`와 `custom_instructions`가 온다. 종료 코드 2로 컴팩션을 막을 수 있고, 막지 않으면 stdout이 요약 지침으로 쓰인다(1만 자 한도). `PostCompact`도 있다. 자동 컴팩션을 일으켜 보지는 않았으므로 "문서에 있음"까지만 확인했다. |
| 2a | 사용량 통계를 읽는 방법 (ADR 0001 미확인 2) | 확인됨 | 공식 문서 `code.claude.com/docs/en/costs`: 대화형 `/usage`의 Session 블록, 상태줄의 비용 필드, OpenTelemetry 내보내기. 비대화형은 아래 2b의 `--output-format json` 출력에 `total_cost_usd`와 `modelUsage`가 있다. |
| 2b | 사용량 통계에 하위 역할 사용량이 포함되는가 | 확인됨 (`claude -p --output-format json`에 한함). 대화형 `/usage`는 시험하지 않음 | 시험: `claude -p --setting-sources project,local --allowedTools "Agent" --output-format json "Agent 도구를 model을 haiku로 지정해 ... 한 번 호출"` 실행. 결과 JSON의 `modelUsage` 키가 `claude-sonnet-5-5`와 `claude-haiku-5-5` 둘이었다. 하위 에이전트의 사용량이 `modelUsage`와 `total_cost_usd`에 합쳐진다. 공식 문서는 `/usage`의 "Prompt cache" 줄이 주 대화만 센다고 밝히고, `/usage` 합계에 하위 에이전트가 들어가는지는 명시하지 않는다. |
| 3 | 이슈 삭제 권한 (ADR 0001 미확인 3) | 확인됨 (문서와 읽기 전용 호출). 실제 삭제는 하지 않음 | GitHub 문서(이슈 삭제): "People with admin permissions in a repository can permanently delete an issue". 개인 계정 소유 저장소는 그 계정만 삭제할 수 있다. `gh issue delete <번호|URL> [--yes]` 명령이 있다(`gh issue delete --help`). `gh api repos/WooCH16/Terrarium_ --jq .permissions` 결과: `admin:true, maintain:true, pull:true, push:true, triage:true`. 현재 계정에 삭제 권한이 있다. 지정 저장소(미생성)에서도 같은 계정이 소유자면 삭제된다. |
| 4 | 지정 저장소를 알려 주는 방법 (ADR 0001 미확인 4) | 확인됨 | `harness/setup.mjs`는 명령줄 인자 `--repo <owner/name>`으로 받는다(필수, 없으면 사용법을 출력하고 종료). 값은 실행 폴더의 `harness.json`(`designatedRepo`)에 저장되고, 코디네이터 규칙의 `{{REPO}}` 자리에 채워진다. 지정 단위는 **실행 폴더당 저장소 하나**(전체 하나)이며 프로젝트별 지정은 없다. `setup.mjs`는 저장소 공개 여부를 검사하지 않는다. 공개 여부는 `harness/guard.mjs`가 훅에서 `gh repo view <repo> --json visibility`로 확인한다. |
| 5 | PreToolUse 훅 입력의 `agent_type` | 확인됨 | 아래 "시험 훅 기록" 참고. 코디네이터(주 세션)의 입력에는 `agent_id`, `agent_type`이 **없다**. 하위 에이전트의 도구 호출에는 `agent_id`와 `agent_type`(값 `general-purpose`)이 **온다**. 공식 문서도 "하위 에이전트, 팀원, `--agent` 세션 안에서만 온다"고 적는다. |
| 6 | `claude --setting-sources project,local` | 확인됨 | `claude --help`: "`--setting-sources <sources>` Comma-separated list of setting sources to load (user, project, local)." 시험에서 이 옵션으로 프로젝트 설정의 훅이 실행되었다. 같은 옵션인데도 전역 `CLAUDE.md`는 읽혔다: 같은 옵션으로 "사용자 전역 CLAUDE.md가 로드되었는가"를 물었더니 `예`라고 답했다(`harness/README.md`의 "전역 CLAUDE.md는 그래도 읽힙니다"와 같은 결과). |
| 7 | `claude --allowedTools` | 확인됨 | `claude --help`: "`--allowedTools, --allowed-tools <tools...>` Comma or space-separated list of tool names to allow". 시험에서 `--allowedTools "Bash Read Glob Agent"`로 `Bash`와 `Agent` 호출이 허용 확인 없이 실행되었다. 쉼표 구분은 시험하지 않았다. |
| 8 | `gh` 로그인 상태와 권한 범위 | 확인됨 | `gh auth status`: github.com에 로그인됨(키링 저장), 활성 계정 `<you>`, Git 프로토콜 https. 토큰 권한 범위: `gist`, `read:org`, `repo`, `workflow`. 토큰 값은 기록하지 않는다. 대상 저장소는 `private: false`(공개)로 확인되었다. |
| 9 | 기존 하네스 코드 | 있음 | 원본 Terrarium beta 작업 트리에서 복사함. 이 저장소의 `harness/`에 파일 46개(`find harness -type f \| wc -l` = 46). 주요 파일: `setup.mjs`, `guard.mjs`, `policy.mjs`, `coordinator.md`, `agents/`, `operator/`, `fixtures/`, `test/`, `e2e/`. |

## 시험 훅 기록

방법: 저장소 밖 임시 폴더에 프로젝트 설정(`.claude/settings.json`)으로 `PreToolUse` 훅(`matcher: "*"`)을 두었다. 훅은 받은 stdin JSON을 파일에 저장하고 종료 코드 0으로 통과시킨다. 그 폴더에서 아래 명령을 한 번 실행했다.

```
claude -p --setting-sources project,local --allowedTools "Bash Read Glob Agent" --output-format json "<Bash로 ls 1회, Agent로 general-purpose 하위 에이전트 1회 호출해 echo sub 실행>"
```

훅이 3번 호출되었다. 아래는 저장한 stdin JSON에서 `session_id`, `transcript_path`, `cwd`(개인 경로 포함)를 지운 발췌다.

코디네이터(주 세션)의 `Bash` 호출 — `agent_id`, `agent_type` 없음:

```json
{"permission_mode":"default","effort":{"level":"medium"},"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls","description":"List current directory"},"tool_use_id":"toolu_..."}
```

코디네이터의 `Agent` 호출 — `agent_id`, `agent_type` 없음(`subagent_type`은 `tool_input` 안에만 있다):

```json
{"permission_mode":"default","hook_event_name":"PreToolUse","tool_name":"Agent","tool_input":{"description":"Run echo sub","subagent_type":"general-purpose","prompt":"..."},"tool_use_id":"toolu_..."}
```

하위 에이전트의 `Bash` 호출 — `agent_id`, `agent_type` 있음:

```json
{"permission_mode":"default","agent_id":"acaa73cda87489c6d","agent_type":"general-purpose","effort":{"level":"medium"},"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"echo sub","description":"Print \"sub\" to stdout"},"tool_use_id":"toolu_..."}
```

관찰:
- `agent_type` 값은 하위 에이전트 정의 이름(`general-purpose`)이다. `harness/agents/`에 정의한 이름이면 그 이름이 올 것으로 보이나, 사용자 정의 하위 에이전트 이름은 이번에 시험하지 않았다.
- Pi로 띄우는 워커와 리뷰어, `claude -p`로 띄우는 오퍼레이터 세션은 별도 프로세스이므로 이 시험의 대상이 아니다.
- `claude -p`는 stdin이 없으면 3초를 기다린다는 경고를 낸다. `< /dev/null`로 피할 수 있다.

## "안 됨"/"확인 불가" 항목이 바꾸는 task

"안 됨"인 항목은 없다. 아래는 상태가 완전하지 않거나 결과가 task에 영향을 주는 항목이다.

- 항목 1(PreCompact 실제 발화 미시험): #13 T10(코디네이터 규칙의 빈칸)에서 보존 노트 갱신 규칙을 `PreCompact` 훅 기반으로 쓰되, 실제 발화는 #14 T11(첫 한 바퀴)이나 #16 T13(점검표, 시나리오 10)에서 처음 확인한다. 기능이 없다고 판명되면 "에이전트가 정한 시점에 남기는 규칙"으로 바꾼다.
- 항목 2b(대화형 `/usage`의 하위 포함 여부 미시험): 사용량 추적은 `claude -p --output-format json`의 `modelUsage`를 읽는 방식으로 하면 #14 T11, #16 T13(시나리오 2)에 영향이 없다. 대화형 `/usage`를 읽어야 한다면 그 task에서 따로 확인한다.
- 항목 4(`setup.mjs`가 공개 여부를 검사하지 않음) 및 항목 8(대상 저장소 `WooCH16/Terrarium_`가 공개): 이 저장소는 ADR 0001이 요구하는 비공개 이슈 저장소로 쓸 수 없다. #14 T11은 비공개 저장소를 새로 만들거나 지정해야 하고(#2의 첫 항목), #6 T3은 `--repo`에 공개 저장소를 넘기면 거부되는지(guard의 점검)를 시험 항목으로 넣을 만하다.
- 항목 5(하위 에이전트에만 `agent_type`이 옴): #5 T2의 "코디네이터에는 허용 목록, 하위 에이전트에는 다른 규칙" 가정(`harness/README.md`)이 맞다. 시험 입력에 `agent_type`이 없는 경우와 있는 경우 둘을 넣는다. 사용자 정의 하위 에이전트(`advisor`, `reviewer`)의 `agent_type` 값은 #5 T2나 #11 T8에서 처음 확인한다.
- 항목 9(기존 코드 있음): #4 T1~#7 T4, #9 T6, #10 T7은 새로 만들기가 아니라 가져온 코드를 같은 시험으로 검증하고 보완하는 일로 본다. 범위는 소유자 확인이 필요하다(#2의 코드 위치 항목).
