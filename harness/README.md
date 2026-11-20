# 하네스 첫 버전

`docs/01-overview.md`, ADR 0001(결정 3·4·5), ADR 0002(결정 A·B, 결정 B의 리뷰어 실행 방식은 ADR 0004로 대체됨), ADR 0003(본문은 이 저장소에 없음, `docs/operator.md`를 따름), ADR 0004(결정 A·B·C)를 따르는 코디네이터 하네스입니다. 이 폴더의 문서가 기준입니다.

## 구성

| 파일 | 하는 일 |
|---|---|
| `coordinator/AGENT.md` | 코디네이터 규칙. 실행 폴더의 `CLAUDE.md`가 됩니다(설계: `docs/coordinator.md`) |
| `advisor/AGENT.md` | 어드바이저 정의. 실행 폴더의 `.claude/agents/advisor.md`가 됩니다(설계: `docs/advisor.md`) |
| `worker/AGENT.md` | 워커 규칙. `run-worker.mjs`가 워커 입력 맨 앞에 붙입니다(설계: `docs/worker.md`) |
| `reviewer/AGENT.md` | 리뷰어(Jev) 규칙과 판정 질문. `jev-review.mjs`가 질문 절을 읽습니다(설계: `docs/reviewer.md`) |
| `agents/*.md` | 하위 에이전트: advisor 하나. ADR 0004 결정 B에 따라 리뷰어는 하위 에이전트가 아니라 별도 실행(`run-reviewer`)이고, 코디네이터는 리뷰어를 하위 에이전트로 부르지 못합니다(훅이 막음). 쓰이지 않던 v1 리뷰어 정의(`reviewer.md`)는 지웠습니다(소유자 결정 5-1). 워커는 하위 에이전트가 아니라 `run-worker`가 띄우는 별도 실행입니다 |
| `operator/AGENT.md`, `operator/{work,research,reflect}.md` | 오퍼레이터 세션의 규칙과 모드별 절차. 오퍼레이터는 하위 에이전트가 아니라 `run-operator`·`run-research`로 시작하는 독립 세션입니다. `reflect.md`는 `run-reflect`가 코드로 하는 일을 적은 것입니다 |
| `operator/*.mjs` | 오퍼레이터 스크립트(시작, 워커, 리뷰어, 합치기, 반영, 중단). 설정은 `operator/operator.config.json` |
| `operator/run-reviewer.mjs` | 리뷰어 판정. 리뷰어는 Jev(TypeSafe System One, HTTP API)다(ADR 0008). 코디네이터가 `--issue <번호>`로 결과 보고서를, 어드바이저가 `--advice <실행 폴더>/reviewer-inbox/<파일> --advice-id <id>`로 제안문을 판정받는다. 스크립트가 양식·해시·근거 파일을 먼저 보고, 완료 기준마다 Jev에 묻고(Noul), 모두 0.7 이상일 때만 허용한다(애매하면 거부). 판정 댓글(`## 리뷰어 판정: 허용`, `허용된 커밋:`)과 조언 실행 기록(`advice-log.jsonl`, `handoffs/advice-<해시 8자리>.md`, 같은 id 2번 거부면 종료 코드 7)은 예전 형식 그대로다. 종료 코드는 스크립트 머리말(0 판정, 2 입력 오류·키 없음, 4 제안문 바뀜, 5 게시·기록 실패, 6 Jev 호출 실패, 7 조언 2회 거부) |
| `operator/route-issue.mjs`, `operator/jev.mjs`, `operator/jev-review.mjs` | 라우팅과 Jev 호출(ADR 0008). `route-issue.mjs --draft <이름>`은 `.drafts/`의 이슈 초안을 보고 Jev가 워커 모델과 유형을 고른다(보기 설명은 `operator.config.json`의 `jev.routing`). 키는 `TYPESAFE_API_KEY`(환경 변수 또는 실행 폴더·하네스 저장소의 `.env`) |
| `operator/run-worker.mjs` | 워커 실행(ADR 0004 결정 A). 모델 값(`claude`, `gemini`, `muse`)별 실행 경로는 `operator.config.json`의 `runners`가 정합니다. 기본 설정은 세 모델 모두 Pi로 띄웁니다(ADR 0009): claude는 Pi의 Anthropic 계정 로그인, gemini는 `GEMINI_API_KEY`(환경 변수 또는 `.env`, `runners.gemini.secretEnv`), muse는 Pi 그대로. 이 경우 하네스 훅이 걸리는 워커가 없고 사후 검사·합치기 시험·Jev 리뷰어가 막습니다. Pi에 저장된 예전 키는 `.env`보다 먼저 쓰이므로 키를 바꿀 때는 `pi auth logout <제공사>`로 지웁니다 |
| `policy.mjs`, `guard.mjs` | PreToolUse 훅. 코디네이터(`agent_type` 없음)에 허용 목록을 적용하고, 모든 역할에 비밀값·하네스 파일 보호를 적용합니다. advisor는 읽기, `reviewer-inbox/` 안 쓰기, 조언 판정 명령 하나만 됩니다(ADR 0006). 오류가 나면 막습니다 |
| `preflight.mjs` | 사전 점검. 설치·실행에 필요한 도구, 워커 모델(1곳 이상), Jev 키를 확인합니다 |
| `setup.mjs` | 실행 폴더를 만듭니다. 지정 저장소가 `PRIVATE`가 아니면 아무것도 쓰지 않고 종료 코드 2로 끝납니다. `--advisor-stub`은 advisor 자리에 어드바이저 대역을 설치합니다. 리뷰어 전용 폴더 `reviewer-inbox/`도 만듭니다(`--refresh`로도 생깁니다) |
| `coordinator.config.json`, `config.mjs` | 코디네이터가 쓰는 수치(overview 8절의 시작값)와 워커 모델 허용 값(`claude`, `gemini`, `muse`). 오퍼레이터가 쓰는 값은 `operator/operator.config.json`에 있습니다 |
| `stubs/` | 시험용 대역: 오퍼레이터 대역(`operator-stub.mjs`), 어드바이저 대역(`advisor-stub.md`, `proposals/`), 어드바이저 목록 예시 |
| `fixtures/memo/` | 시험용 메모 프로그램(정렬 기능 없음) |
| `e2e/verify.mjs` | 종단 시험 결과를 GitHub 이슈·git·테스트로 직접 확인합니다 |

## 준비

```bash
gh repo create <owner>/harness-issues --private   # 지정 저장소 (비공개)
node harness/preflight.mjs --repo <owner>/harness-issues   # 사전 점검
node harness/setup.mjs --run C:/Users/<you>/terrarium-run --repo <owner>/harness-issues [--project <대상 프로젝트 git 폴더>]
```

사전 점검(`preflight.mjs`)은 node 22 이상, git, `gh` 설치와 로그인, 지정 저장소 비공개 여부, Claude Code, Pi와 워커 모델마다의 계정 준비(`pi auth check --model`), Jev 키(`TYPESAFE_API_KEY`)가 있는지를 보고, 쓸 수 있는 워커 모델이 없거나 키가 없으면 실패합니다. 리뷰어는 Jev라 워커 모델은 1곳이면 됩니다(결정 9-3 바뀜, ADR 0008). 다른 모델로 대체하려면 2곳 이상이 낫습니다. 실패한 항목마다 할 일을 알려 줍니다. `--json`은 같은 결과를 JSON으로 냅니다. CLI의 계정 로그인 여부까지는 보지 않습니다.

대상 프로젝트를 지정하려면 `--project <git 폴더>`를 붙입니다(main 브랜치 필요). 그 저장소를 실행 폴더 안 `<폴더 이름>/`으로 복제하고 원래 저장소와의 연결(origin)은 끊어, 하네스가 원래 저장소에 쓰지 않습니다. 결과는 복제본의 main에서 가져갑니다. 지정하지 않으면 시험용 메모 프로그램(`fixtures/memo`)을 씁니다. 기록 문서는 `issues/records/<폴더 이름>.md`입니다.

실행 폴더는 Terrarium **바깥**에 둡니다. 상위 폴더의 `CLAUDE.md`는 설정(`claudeMdExcludes`)으로도 빼지만, 하네스 저장소 안에 두면 하네스 문서와 섞이기 쉽습니다. 역할 문서만 바꿨을 때는 `--refresh`를 붙이면 `CLAUDE.md`, 에이전트, 설정만 다시 씁니다.

## 실행

```bash
cd C:/Users/<you>/terrarium-run
claude --setting-sources project,local --allowedTools "Bash Write Edit Read Glob Grep Agent TodoWrite Skill"
```

- `--setting-sources project,local`: 사용자 전역 설정의 플러그인과 훅을 끕니다. 전역 `~/.claude/CLAUDE.md`·`~/.claude/rules/`와 실행 폴더 상위 폴더의 `CLAUDE.md`는 `setup`이 실행 폴더 설정에 넣는 `claudeMdExcludes`가 뺍니다(오퍼레이터·워커 세션도 같음). 조직이 배포한 관리 정책 `CLAUDE.md`는 뺄 수 없습니다.
- 처음 실행하면 Claude Code가 이 폴더를 신뢰할지 묻습니다. **신뢰를 수락해야 합니다.** 권한 훅(`guard.mjs`)을 포함한 설정의 명령 실행은 신뢰한 폴더에서만 돕니다. 신뢰는 폴더마다 한 번만 묻습니다.
- `--allowedTools`: 신뢰를 수락하기 전에는 설정 파일의 허용 목록이 무시되므로 명령에서 넘깁니다. 실제 금지는 훅이 합니다.
- 진행 상황은 지정 저장소의 GitHub 이슈 목록에서 봅니다. 훅의 판정은 `<실행 폴더>/guard.log`에 남습니다.
- Muse(Contributor 등급, 입력이 학습에 쓰일 수 있음)에는 기본적으로 `공개 가능: 예`인 내용만 넘깁니다. 비공개 내용도 넘겨도 된다면 실행 폴더에 `operator.local.json`을 직접 만듭니다: `{ "runners": { "muse": { "publicOnly": false } } }`. 이 파일은 git에 없고 하네스의 어떤 역할도 쓸 수 없습니다(ADR 0007).

## 시험

```bash
node scripts/test.mjs --fast                             # 빠른 시험(1분 안쪽)
node scripts/test.mjs --slow                             # 오래 걸리는 통합 시험(git 저장소·하위 프로세스를 많이 만듦, 수 분)
node scripts/test.mjs                                    # 전체
node harness/e2e/jev-probe.mjs                           # Jev 실제 API 시험(키 필요, 비용 듦)
node harness/e2e/verify.mjs --run <실행 폴더> --since <시작 시각 ISO> [--test-cmd "<대상 프로젝트 시험 명령>"] [--example memo]   # 종단 시험 확인(일반 검사, --example memo는 메모 정렬 검사 추가)
```

`scripts/test.mjs`는 동시 실행을 2개로 두고(더 많으면 Windows에서 `uv_spawn` 오류), 진짜 모델 CLI가 불리지 않게 `HARNESS_PI_BIN`·`HARNESS_AGY_BIN`·`HARNESS_CLAUDE_BIN`의 기본값을 덫으로 둡니다. 시험이 가짜 CLI를 주지 않고 진짜를 부르려 하면 실패로 끝납니다. 10초 넘게 걸리는 시험 파일을 새로 만들면 스크립트의 `SLOW` 목록에 더합니다.

## 플랫폼

프로세스 정리(`taskkill`, 합치기 시험 뒤의 PowerShell 정리)와 일부 sink(`NUL`, `\.\NUL`)는 Windows 우선으로 만들었습니다. 다른 플랫폼은 시험하지 않았습니다.
