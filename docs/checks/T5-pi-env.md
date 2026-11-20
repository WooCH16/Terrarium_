# T5 Pi 환경 시험 결과 (이슈 #8, ADR 0004 시험 1, 2, 3, 6)

- 실행일: 2026-11-18 (Windows 11, Git Bash)
- 기준 커밋: `9993bde`
- 시험 위치: 저장소 밖 임시 폴더(`<tmp>/t5run`, `<tmp>/t5sbx`). 저장소 파일은 시험에 쓰지 않았다.
- 모델에는 `Reply with exactly: pong` 같은 공개 문장만 보냈다.
- 출력 발췌에서 사용자 이름, 경로, 암호화된 추론 토큰은 지웠다.

## 요약

| 시험 | 상태 | 막는 task |
|---|---|---|
| 1. Pi 실행 방법과 버전 | 통과 (Pi가 이미 설치되어 있었다) | 없음 |
| 2. 모델 호출: Pi → Muse | 통과 | 없음 |
| 2. 모델 호출: `agy` → Gemini 4 Hydrogen (Medium) | 통과 (Pi를 거치지 않은 직접 호출) | 없음 |
| 2. 모델 호출: `claude -p` → Claude Haiku 5.5 | 통과 (Pi를 거치지 않은 직접 호출) | 없음 |
| 2. 모델 호출: Pi → `agy` → Gemini | 미실행 (Pi에 `agy`를 부르는 길이 없음) | 소유자 결정 필요. T6, T7 |
| 2. 모델 호출: Pi → Claude | 미실행 (Pi의 `anthropic` 자격 증명이 `not_ready`) | 소유자 결정 필요. T6, T7 |
| 3. `agy --sandbox` 읽기 전용 | **`--sandbox`만으로는 실패, 설정 추가 시 통과** (`write_file(*)` deny 규칙, 반복 시험 2/6. `T5-agy-readonly-loop.md`) | Pi를 거치는 경로(시험 2)가 남음. 한계는 반복 시험 문서 참고 |
| 6. 판정자 식별 | 소유자 결정 필요 (결정하지 않음) | T6의 판정 검증 |

## 시험 1. Pi 실행 방법과 버전

| 항목 | 내용 |
|---|---|
| 실행한 명령 | `command -v pi`, `pi --version`, `pi --help`, `pi list`, `pi mcp list`, `npm ls -g --depth=0` (읽기 전용) |
| 결과 | 통과 |
| 출력 발췌 | `pi --version` → `1.5.1`. 패키지는 `@earendil-works/pi-coding-agent@1.5.1`(전역 npm). `pi --help` 첫 줄은 `pi - AI coding assistant with read, bash, edit, write tools`. `pi list` → `No packages installed.` `pi mcp list` → `No MCP servers configured.` |
| 비고 | Pi는 이미 설치되어 있어 설치하지 않았다. 그래서 "외부 도구 설치 전 제시" 7개 항목은 이번에는 필요 없다(이 커밋의 `AGENT.md`에는 해당 항목 절이 없다). 실행 명령은 `pi`, 비대화형은 `pi -p`, 읽기 전용 도구 제한은 `--tools read,grep,find,ls`(도움말의 예시), 출력 기록은 `--mode json`이다. |
| 막는 task | 없음 |

## 시험 2. 모델 호출

### 모델 ID 확인

| 실행한 명령 | 출력 발췌 |
|---|---|
| `agy models` | `gemini-4-hydrogen-low`, `-medium`, `-high`, `-xhigh`가 있다(예: `gemini-4-hydrogen-medium  Gemini 4 Hydrogen (Medium)`). `gemini-4-argon-*`, `gemini-3.8-flash-*`, `claude-opus-5-5-*`, `claude-sonnet-5-5-*`, `gpt-oss-120b-medium`도 있다. |
| `pi --list-models` | provider `meta`만 나온다: `muse-spark-1.1`, `muse-spark-1.2`, `muse-spark-1.2-contributor`, `muse-spark-1.3`, `muse-spark-1.3-contributor`, `muse-wonder-1.0` (컨텍스트 1.0M). Claude와 Gemini 모델은 Pi 목록에 없다. |
| `pi --list-models haiku`, `pi --list-models gemini` | `No models matching ...` |
| `pi auth check --provider meta` | `ready` |
| `pi auth check --provider anthropic` | `not_ready` |

### 호출 결과

| 경로 | 실행한 명령 | 결과 | 모델 이름과 실행 흔적 |
|---|---|---|---|
| Pi → Muse | `pi -p --no-session --no-tools --no-context-files --no-extensions --no-skills --no-mcp --mode json --model meta/muse-spark-1.3-contributor "Reply with exactly: pong"` | 통과 | 응답 `pong`. 응답 메시지에 `"provider":"meta"`, `"model":"muse-spark-1.3-contributor"`, `"api":"openai-responses"`, `"stopReason":"stop"`, 사용량 입력 422/출력 111 토큰, 비용 약 0.00006(Pi 계산값, 제공자 값 아님) |
| `agy` → Gemini | `agy --model gemini-4-hydrogen-medium --output-format json --log-file <tmp>/agy.log --print "Reply with exactly: pong"` | 통과 (Pi 경유 아님) | JSON에 `"status":"SUCCESS"`, `"response":"pong\n"`, 대화 ID, 토큰 사용량. 응답 JSON에는 모델 이름이 없다. `--log-file`의 로그에 `Print mode: starting (... model="gemini-4-hydrogen-medium" ...)`과 `Propagating selected model override to backend: label="Gemini 4 Hydrogen (Medium)"`가 남는다. 같은 로그에 `Model ID gemini-4-hydrogen-medium not in local config, defaulting to CCPA`가 있으나 이후 `Resolving model`과 위 label 줄이 이어진다. 이 경고가 무엇을 뜻하는지는 확인하지 못했다. |
| `claude -p` → Claude | `claude -p --model claude-haiku-5-5 --output-format json --no-session-persistence "Reply with exactly: pong"` | 통과 (Pi 경유 아님) | `"result":"pong"`, `"is_error":false`, `modelUsage`의 키가 `claude-haiku-5-5` 하나, 비용 약 0.0102 달러 |
| Pi → `agy` → Gemini | 실행하지 않음 | 미실행 | Pi 1.5.1의 `providers.md`에 Gemini는 `GEMINI_API_KEY` 방식으로만 나오고, `agy`나 Antigravity를 부르는 방법은 문서(`docs/`, `README.md`, `examples/`)에서 찾지 못했다. 설치된 Pi에는 확장이 없다(`No packages installed.`). `agy`를 부르려면 Pi 확장이나 bash 도구로 `agy`를 실행하는 방식을 새로 만들어야 하는데, 이는 설계와 설치가 필요한 일이라 하지 않았다. |
| Pi → Claude | 실행하지 않음 | 미실행 | Pi의 `anthropic` provider가 `not_ready`다. 자격 증명(`ANTHROPIC_API_KEY` 등) 설정은 소유자 몫이라 하지 않았다. |

Muse Spark 1.3 Contributor는 Pi의 `meta` provider로 부를 수 있음을 확인했다. 시험 문장은 공개 문장이다.

## 시험 3. `agy --sandbox` 읽기 전용 범위

옵션 확인: `agy --help`에 `--sandbox  Run in a sandbox with terminal restrictions enabled`로만 설명되어 있다. "terminal restrictions"라고만 되어 있어 파일 편집 도구가 제한되는지는 도움말에 없다.

시험 폴더는 저장소 밖 `<tmp>/t5sbx`, 모델은 `gemini-4-hydrogen-medium`이다.

| 시험 | 실행한 명령(요지) | 결과 | 근거 |
|---|---|---|---|
| (a) 읽기 | `agy --sandbox ... --print "Read the file probe.txt ... reply with its exact content only."` | 통과 | 응답 `ORIGINAL-LINE-ALPHA` |
| (b) 쓰기 1: 일반 요청 | `agy --sandbox ... --print "Overwrite the file probe.txt ... so it contains exactly: MODIFIED-BY-AGY ..."` | **실패 (쓰기가 막히지 않음)** | 응답 `Succeeded. Overwrote probe.txt and verified via read_file ...`. 파일 해시(sha256)가 `04ce372f...f69d457`에서 `428dbc9a...a4cafe`로 바뀌었고 내용이 `MODIFIED-BY-AGY`가 되었다. |
| (b) 쓰기 2: 셸 명령만 쓰게 한 요청 | `agy --sandbox ... --print "Using ONLY a shell command ..., run: echo SHELL-WRITE > probe2.txt"` | 막힘 | 셸이 `UnauthorizedAccessException`(액세스가 거부되었습니다)을 냈고, 파일 해시는 `a20e5990...f0aa4`로 그대로이며 내용은 `ORIGINAL-LINE-BETA`다. |

판정: **실패.** `agy --sandbox`는 셸 명령으로 쓰는 것은 막았지만 에이전트의 파일 편집 도구로 쓰는 것은 막지 못했다. 시험 3의 통과 기준("쓰기 시도가 막힘")을 채우지 못했다. 따라서 `--sandbox`만으로 리뷰어의 읽기 전용을 보장할 수 없다.

- 이 시험은 `--sandbox`만으로는 실패했다. 이후 **반복 시험**(`docs/checks/T5-agy-readonly-loop.md`)으로 `--sandbox`에 `--settings`로 `{"permissions":{"deny":["write_file(*)"]}}`를 더하면 읽기는 되고 편집 도구 쓰기, 새 파일 만들기, 셸 쓰기·삭제·덧붙이기·폴더 만들기가 모두 막히는 것을 연속 2회 확인했다. 그래서 `--sandbox`만 쓰는 구성에 대한 "리뷰어 모델 재논의" 필요는 이 설정으로 해소된다. 이 설정이 실제 리뷰어 실행(Pi 경유)에서도 쓰이는지는 별개로 남아 있다.
- 확인하지 못한 것: `--mode plan`이나 다른 옵션 조합이 쓰기를 막는지, 이 동작이 운영체제나 `agy` 버전(`1.5.11`)에 따라 다른지. 이번에는 시험하지 않았다.
- 시험 파일은 임시 폴더에 있고 저장소에는 없다.

## 시험 6. 판정자 식별 (소유자 결정 필요)

이 문서는 결정하지 않는다. 열린 문제 목록(`open-issues.md`)은 이 저장소에 없어 ADR 0004와 이슈 #2를 근거로 썼다.

**문제:** 오퍼레이터, 리뷰어, 코디네이터가 같은 GitHub 계정으로 `gh`를 쓰기 때문에, 이슈 댓글의 작성자만으로는 어느 쪽이 쓴 판정인지 구별하지 못한다. 그래서 오퍼레이터나 워커가 `## 리뷰어 판정: 허용` 댓글을 직접 써도 구별할 수 없다. `harness/operator/AGENT.md`의 "잔여 위험"에도 "공유 gh 계정에서 판정을 위조할 수 있다"는 점이 사용자 결정 대기로 적혀 있다.

**확인한 사실**
- 현재 `gh`는 계정 하나로 로그인되어 있다(`gh auth status`. 토큰은 적지 않는다).
- `harness/operator/merge-adapter.mjs`에는 `reviewerLogin` 옵션이 있어, 설정하면 그 계정이 쓴 판정 댓글만 인정한다. 설정하지 않으면 작성자를 구분하지 않는다고 주석에 적혀 있다.
- 같은 파일은 판정 댓글의 `createdAt`/`updatedAt`을 읽어 수정된 판정과 보고서를 제외하고, 허용 판정의 `허용된 커밋:` 해시가 보고서의 `커밋 해시:`와 같은지 대조한다.
- `docs/adr/0004-pi-worker-reviewer.md`는 이 항목을 "미결(시험 6)"으로 두었다.

| 후보 | 장점 | 단점 | 확인할 수 있는 사실 |
|---|---|---|---|
| A. 리뷰어용 GitHub 계정을 따로 둔다 | 작성자 로그인으로 판정자를 구별할 수 있다. 병합 어댑터의 `reviewerLogin`이 이미 이 방식을 받는다. | 계정과 토큰을 하나 더 관리해야 하고, 그 토큰을 리뷰어 실행에만 주도록 `gh` 환경을 나눠야 한다. 저장소 접근 권한 부여가 필요하다. 계정 만들기와 토큰 발급은 소유자 몫이다. | `reviewerLogin` 코드가 있다(위). 계정이 이미 있는지는 확인하지 못했다. |
| B. 스크립트가 판정 댓글 ID와 해시를 기록하고, 병합 때 대조한다 | 계정을 늘리지 않는다. 판정 댓글을 쓴 것이 리뷰어를 띄운 스크립트임을 기록으로 남길 수 있다. | 같은 사용자 권한의 프로세스는 기록도 고칠 수 있어 근본적으로 작성자를 구별하지는 못한다. 기록 위치와 형식을 새로 정해야 한다. | 어댑터는 이미 해시 대조와 수정 시각 검사를 한다. 댓글 ID를 기록하는 부분은 코드에서 확인하지 못했다. |

(두 후보를 함께 쓸 수도 있으나 이 문서는 어느 쪽도 권하지 않는다.)

**소유자 결정 필요.** 결정 기록이 생기면 이슈 #8의 시험 6 완료 조건("소유자가 정했다")이 채워진다.

## 모델 ID 세 개와 Gemini 추론 강도의 확정 여부

| 항목 | 확인한 값 | 출처 | 확정 여부 |
|---|---|---|---|
| `claude` (Claude Haiku 5.5) | `claude-haiku-5-5` | `claude -p --model claude-haiku-5-5` 호출이 성공했고 `modelUsage`가 `claude-haiku-5-5` | 모델 ID는 호출로 확인됨. 소유자 확정 기록은 없음 |
| `gemini` (Gemini 4 Hydrogen) | `gemini-4-hydrogen-{low,medium,high,xhigh}` | `agy models` 출력. `gemini-4-hydrogen-medium` 호출 성공, 로그에 label `Gemini 4 Hydrogen (Medium)` | 모델 ID는 확인됨. 소유자의 `Hydrazine`→`Hydrogen` 해석 확인은 없음 |
| `muse` (Muse Spark 1.3 Contributor) | `muse-spark-1.3-contributor` (provider `meta`) | `pi --list-models` 출력과 Pi 호출 응답의 `"model"` 필드 | 모델 ID는 확인됨. 소유자의 해석 확인은 없음 |
| Gemini 추론 강도 | 시험에는 `medium`만 썼다 | 위 호출 | **미확정.** `low`, `high`, `xhigh`는 호출하지 않았고 소유자의 결정은 없다 |

이슈 #8의 "모델 ID 세 개와 Gemini 추론 강도가 확정되었다"는 기준은 **추론 강도와 소유자 확인이 남아 있어 아직 채워지지 않았다.**

## 소유자 결정이 필요한 것

1. 시험 3 실패에 대한 처리(리뷰어 모델 재논의).
2. Pi가 `agy`나 Claude를 부르게 할지, 한다면 어떤 방식(Pi 확장, 자격 증명 설정)으로 할지. 둘 다 설치나 자격 증명 설정이 따른다.
3. Gemini 추론 강도.
4. 시험 6의 판정자 식별 방법.
