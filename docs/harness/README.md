# 하네스 첫 버전

`docs/overview.md`, ADR 0001(결정 3·4·5), ADR 0002(결정 A·B)를 따르는 코디네이터 하네스입니다.

## 구성

| 파일 | 하는 일 |
|---|---|
| `coordinator.md` | 코디네이터 규칙. 실행 폴더의 `CLAUDE.md`가 됩니다 |
| `agents/*.md` | 하위 에이전트: advisor, reviewer(판정 양식대로만 답함). 워커는 하위 에이전트가 아니라 `run-worker`가 띄우는 독립 세션입니다 |
| `operator/AGENT.md`, `operator/{work,research,reflect}.md` | 오퍼레이터 세션의 규칙과 모드별 절차. 오퍼레이터는 하위 에이전트가 아니라 `run-operator`·`run-research`로 시작하는 독립 세션입니다. `reflect.md`는 `run-reflect`가 코드로 하는 일을 적은 것입니다 |
| `operator/*.mjs` | 오퍼레이터 스크립트(시작, 워커, 합치기, 반영, 중단). 설정은 `operator/operator.config.json` |
| `policy.mjs`, `guard.mjs` | PreToolUse 훅. 코디네이터(`agent_type` 없음)에 허용 목록을 적용하고, 모든 역할에 비밀값·하네스 파일 보호를 적용합니다. 오류가 나면 막습니다 |
| `setup.mjs` | 실행 폴더를 만듭니다 |
| `fixtures/memo/` | 시험용 메모 프로그램(정렬 기능 없음) |
| `e2e/verify.mjs` | 종단 시험 결과를 GitHub 이슈·git·테스트로 직접 확인합니다 |

## 준비

```bash
gh repo create <owner>/terrarium-harness-issues --private   # 지정 저장소 (비공개)
node harness/setup.mjs --run C:/Users/<you>/terrarium-run --repo <owner>/terrarium-harness-issues
```

실행 폴더는 Terrarium **바깥**에 둡니다. 상위 폴더의 `CLAUDE.md`가 코디네이터에게 섞이지 않게 하려는 것입니다. 역할 문서만 바꿨을 때는 `--refresh`를 붙이면 `CLAUDE.md`, 에이전트, 설정만 다시 씁니다.

## 실행

```bash
cd C:/Users/<you>/terrarium-run
claude --setting-sources project,local --allowedTools "Bash Write Edit Read Glob Grep Agent TodoWrite"
```

- `--setting-sources project,local`: 사용자 전역 설정의 플러그인과 훅을 끕니다. 전역 `~/.claude/CLAUDE.md`는 그래도 읽힙니다.
- `--allowedTools`: 실행 폴더를 신뢰된 폴더로 등록하기 전에는 설정 파일의 허용 목록이 무시되므로 명령에서 넘깁니다. 실제 금지는 훅이 합니다.
- 진행 상황은 지정 저장소의 GitHub 이슈 목록에서 봅니다. 훅의 판정은 `<실행 폴더>/guard.log`에 남습니다.

## 시험

```bash
node --test harness/test/*.test.mjs                      # 판정·훅·설치 단위 시험
node harness/e2e/verify.mjs --run <실행 폴더> --since <시작 시각 ISO>   # 종단 시험 확인
```

## 플랫폼

프로세스 정리(`taskkill`, 합치기 시험 뒤의 PowerShell 정리)와 일부 sink(`NUL`, `\.\NUL`)는 Windows 우선으로 만들었습니다. 다른 플랫폼은 시험하지 않았습니다.
