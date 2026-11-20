# T6, T7 리뷰어·워커 실행 스크립트 결과 (이슈 #9, #10)

> **리뷰어 부분은 대체됨 → [ADR 0008](../adr/0008-jev-reviewer-routing.md)(이슈 #44):** 리뷰어는 Jev이고 `reviewer-rotation.mjs`·`verdict.mjs`는 지웠다. 아래는 당시 기록이다.

- 실행일: 2026-11-18 (Windows 11, Git Bash, Node 26.7, Pi 1.5.1, `agy` 1.5.11, Claude Code 2.1.x)
- 기준 커밋: `e12e02c`(1단계 결과가 합쳐진 상태). 브랜치 `wt/pi-scripts`.
- 실제 모델 실행은 모두 저장소 밖 임시 폴더에서 했다. 모델에 보낸 것은 `harness/fixtures/memo`(공개 시험 자료)와 그것에 맞춰 만든 가상의 이슈·보고서 문장뿐이다. 설계 문서와 개인 정보는 보내지 않았다.
- GitHub에는 쓰지 않았다. `gh issue comment`는 부르지 않았고 댓글 게시는 가짜 함수 주입으로만 시험했다.
- 상태 표기: **충족**(실행해서 확인), **미충족**, **미검증**(확인하지 못함).

## 만든 것

| 파일 | 내용 |
|---|---|
| `harness/operator/model-exec.mjs` | 공통 모듈. 실행 파일 찾기(`HARNESS_<PI,AGY,CLAUDE>_BIN`, PATH, Windows의 npm 셔틀 풀기), CLI별 출력 관찰기(실제 모델 이름과 흔적을 출력에서 읽는다), 자식 프로세스 실행 |
| `harness/operator/operator.config.json` | `runners.<모델>`에 `cli`, `via`, `modelId`, `temporary`를 더했다. 허용 모델은 `claude`, `gemini`, `muse` |
| `harness/operator/verdict.mjs` | 판정 해석(시험 4) |
| `harness/operator/reviewer-rotation.mjs` | 리뷰어 타입 순환(시험 5) |
| `harness/operator/run-reviewer.mjs` | 리뷰어 실행 스크립트(T6) |
| `harness/operator/run-worker.mjs` | 모델 값별 실행 경로, 실제 모델·커밋 기록(T7) |
| `harness/policy.mjs`, `harness/coordinator.md` | 코디네이터가 `run-reviewer.mjs --issue <번호>`를 부를 수 있게 허용 목록과 규칙에 더했다(F9의 공백) |

모델 값별 실행 방식(러너 추상화): `operator.config.json`의 `runners.<모델>.cli`가 정한다. Pi 경로(F5, F6)가 생기면 그 모델의 항목만 `cli: "pi"`로 바꾸면 된다. 관찰기와 읽기 전용 인자는 CLI별로 이미 있다(`pi`용은 muse에서 쓰고 있다).

| 모델 값 | 실행 방식 | 모델 ID | 읽기 전용(리뷰어) | 비고 |
|---|---|---|---|---|
| `muse` | **Pi** (`pi -p --mode json --model meta/muse-spark-1.3-contributor`) | `meta/muse-spark-1.3-contributor` | `--tools read,grep,find,ls` | Pi 경유 |
| `gemini` | **`agy` 직접** (Pi 경유 아님) | `gemini-4-hydrogen-medium` | `--sandbox --settings`(`write_file(*)` deny) | **임시(F5 대기)** |
| `claude` | **`claude -p` 직접** (Pi 경유 아님) | `claude-haiku-5-5` | `--tools Read,Grep,Glob` | **임시(F6 대기)** |

## 이슈 #9 T6 (리뷰어 실행 스크립트)

| 기준 | 상태 | 근거 |
|---|---|---|
| 시험 4: `## 리뷰어 판정: 허용` 아래 `허용된 커밋: <40자리 해시>` 한 줄만 허용으로 읽고, 그 밖은 모두 거부로 읽는다 | **충족** | `node --test harness/test/verdict.test.mjs`: 32건 통과(허용 1건 + 허용 변형 4건, 어긋난 사례 25건, 거부 형식, 보고서 해시 대조). 아래 "판정 해석 사례 표" |
| 시험 5: 리뷰어 타입이 워커 타입과 항상 다르고, 워커 타입마다 나머지 둘이 번갈아 나온다 | **충족** | `node --test harness/test/reviewer-rotation.test.mjs`: 8건 통과(워커 타입 3개 x 연속 4회). `run-reviewer.test.mjs`에서도 가짜 러너로 같은 12회를 스크립트 전체로 실행해 같은 표를 확인했다 |
| 결과에 모델 이름이 남고, Gemini이면 `agy` 실행 흔적이 남는다. 없으면 결과를 인정하지 않는다 | **충족**(가짜 CLI 주입) | `node --test harness/test/run-reviewer.test.mjs`: 22건 통과. 가짜 Pi·agy·claude를 `HARNESS_*_BIN`으로 주입. 모델 이름 없음, 지정 타입과 다른 모델, agy 로그에 모델 줄 없음, agy 대화 ID 없음, claude 출력에 모델 없음은 종료 코드 4로 끝나고 댓글이 없다. 실제 실행 3건에서도 모델 이름과 흔적이 댓글에 남았다(아래) |
| 리뷰어 실행이 파일을 고치지 못한다 | **충족**(muse/Pi, 그리고 직접 호출 두 경로도 같이 확인) | 실제 Pi 실행 뒤 `git status --porcelain`이 `""`(아래 "읽기 전용 시험"). 스크립트도 실행 전후 `git status --porcelain`을 비교해 달라지면 결과를 인정하지 않는다(시험 있음) |
| 결과 판정은 이슈 댓글로 남고 코디네이터에게는 URL과 한 줄만 간다 | **충족**(`gh`를 가짜 함수로 주입). **실제 GitHub 게시는 미검증** | `run-reviewer.test.mjs`: 기본 `gh` 경로를 `deps.gh` 주입으로 시험했다(`gh issue view 7 --repo o/r --json body,comments`, `gh issue comment 7 --repo o/r --body-file <파일>`의 인자 모양, 게시 시점의 본문 파일 내용, 출력에서 URL 읽기). 실제 `gh`는 부르지 않았다. 댓글 1건 게시(본문은 판정 + 모델 이름 + 흔적), stdout은 정확히 한 줄 `<URL> \| 리뷰어 판정: ... \| 모델: ...`이고 해시·본문은 싣지 않는다. 병합 어댑터의 `collectAllowed`가 이 댓글을 허용으로 읽는지도 시험했다(통과) |
| 실제 Pi로 판정 1건이 형식대로 나온다 | **충족** (Muse, Pi 경유) | 아래 "실제 판정 원문" |

### 판정 해석 사례 표 (`verdict.test.mjs`)

| 입력 | 결과 |
|---|---|
| `## 리뷰어 판정: 허용` + `허용된 커밋: <40자리 소문자>` (앞뒤·사이 빈 줄, 줄 끝 공백, CRLF 허용) | **허용** |
| 빈 응답, 공백만 | 거부(형식 어긋남) |
| 제목만 / 해시 줄만 / 순서가 바뀜 | 거부(형식 어긋남) |
| 해시 39자리, 41자리, 7자리 약식, 대문자, 16진수 아닌 문자 | 거부(형식 어긋남) |
| 콜론 뒤 공백 없음, 전각 콜론, 제목 뒤 설명, 제목 수준 `###`, `허용됨`, 영어 제목, 굵은 글씨, 다른 제목 | 거부(형식 어긋남) |
| 제목 앞 설명 문장, 해시 줄 뒤 설명 문장, 앞 들여쓰기, 코드 울타리 | 거부(형식 어긋남) |
| 해시 줄이 두 번, 허용+거부 제목이 같이 있음, 줄 끝 제로폭 문자 | 거부(형식 어긋남) |
| `## 리뷰어 판정: 거부` + 이유 | 거부(이유 보존) |
| 거부 응답 안에 허용 제목이나 `허용된 커밋` 줄을 섞음 | 거부(형식 어긋남) |
| 허용 해시가 결과 보고서의 `커밋 해시:`와 다르거나 보고서 해시가 40자리가 아님 | 거부로 바꿈(`bindToReport`) |

형식이 어긋난 응답은 거부로 처리하고 응답 원문(2000자까지)을 거부 사유로 댓글에 남긴다(임시, 아래).

### 순환 순서 표 (워커 타입별 연속 4회)

| 워커 타입 | 1회 | 2회 | 3회 | 4회 |
|---|---|---|---|---|
| `claude` | gemini | muse | gemini | muse |
| `gemini` | claude | muse | claude | muse |
| `muse` | claude | gemini | claude | gemini |

순환 위치는 판정 댓글을 게시한 뒤에만 나아간다. 실행이 실패하거나 결과를 인정하지 않은 경우에는 나아가지 않는다.

### 실제 실행 (이 컴퓨터, 모델 호출)

시험 자료는 `harness/fixtures/memo`의 복사본(임시 git 저장소)이고, 이슈 본문과 보고서는 가상의 문장이다. 스크립트의 `gh` 호출은 가짜 함수로 바꿨다(이슈 조회와 댓글 게시).

**실제 판정 원문 1건 (Muse, Pi 경유).** 실제 워커(claude)가 만든 커밋을 검토하게 했다. 스크립트의 자식 프로세스 출력(`--mode json`)을 그대로 받아 둔 것에서 리뷰어의 마지막 어시스턴트 메시지(`stopReason: stop`)의 text 원문을 JSON 문자열로 옮긴다. 이 실행은 이 문서를 쓰는 중에 따로 다시 한 번 한 것이고(약 9초, 위 단계와 같은 워크트리), 모델은 판정 전에 읽기 도구를 한 번 쓴 메시지(`stopReason: toolUse`)를 먼저 냈다.

```text
provider/model = meta/muse-spark-1.3-contributor
text (JSON 문자열) = "## 리뷰어 판정: 허용\n허용된 커밋: 27715248781c4b5782f74142be1ddd95f95b4b18\n"
```

원문은 두 줄이고 끝에 줄바꿈 하나가 붙어 있다. 판정 해석은 이것을 허용으로 읽었다. 스크립트가 올릴 댓글(모델 이름과 흔적은 스크립트가 붙인다):

```text
## 리뷰어 판정: 허용
허용된 커밋: 27715248781c4b5782f74142be1ddd95f95b4b18

리뷰어 모델: muse (meta/muse-spark-1.3-contributor)
실행 경로: pi, Pi
실행 흔적: pi: message.provider/model=meta/muse-spark-1.3-contributor
워커 타입: claude
```

stdout 한 줄: `https://github.com/o/r/issues/7#issuecomment-1 | 리뷰어 판정: 허용 | 모델: muse (meta/muse-spark-1.3-contributor)` (URL은 가짜 게시 함수가 만든 값). 실행 뒤 `git status --porcelain`은 실행 전과 같았다(워커 폴더의 `.harness/`만 추적되지 않은 상태로 전후 동일). 앞서 임시 저장소(커밋 하나, 작업 폴더가 깨끗)에서 한 Muse 실행도 같은 판정이었고 실행 뒤 `git status --porcelain`이 `""`였다(약 15초).

같은 방법으로 다른 두 경로도 각각 1회 확인했다(둘 다 Pi를 거치지 않는다).

| 리뷰어 | 명령 요지 | 결과 | 흔적 |
|---|---|---|---|
| gemini (`agy` 직접) | `agy --model gemini-4-hydrogen-medium --output-format json --log-file <tmp> --sandbox --settings <deny 파일> --print <프롬프트>` | 허용, 약 16초 | `agy: conversation_id=<ID>, log model="gemini-4-hydrogen-medium"` |
| claude (`claude -p` 직접) | `claude -p --model claude-haiku-5-5 --output-format json --tools Read,Grep,Glob --no-session-persistence --strict-mcp-config --disable-slash-commands --setting-sources user --append-system-prompt <...>` | 허용, 약 9초 | `claude: modelUsage=claude-haiku-5-5` |

### 읽기 전용 시험

각 리뷰어 구성에 "파일 덮어쓰기, 새 파일 만들기, 셸로 쓰기"를 즉시 하라고 시키고, 실행 뒤 임시 git 저장소의 `git status --porcelain`과 파일 내용을 확인했다.

| 구성 | 응답 요지 | `git status --porcelain` | 기존 파일 | 새 파일 |
|---|---|---|---|---|
| muse / Pi `--tools read,grep,find,ls` | 쓰기·셸 도구가 없다고 답함(`read`, `grep`, `find`, `ls`만 있다고 보고) | `""` | 그대로 | 없음 |
| gemini / `agy --sandbox --settings`(`write_file(*)` deny) | `write_file`이 deny 규칙으로 막혔고 셸 `echo X > shell.txt`는 `UnauthorizedAccessException` | `""` | 그대로 | 없음 |
| claude / `--tools Read,Grep,Glob --setting-sources user`(재시험 포함) | 쓰기·셸 도구가 비활성화되어 있다고 답함 | `""` | 그대로 | 없음 |

- **Claude를 직접 부를 때의 읽기 전용**은 문서에 없던 구성이다. 위 시험으로 `--tools Read,Grep,Glob`가 쓰기 도구와 셸을 아예 주지 않아 쓰기가 일어나지 않는 것을 확인했다(1회). 다른 모델·반복 시험은 하지 않았다.
- 회당 한 번의 시험이라 통계적 보장은 아니다. 다만 Pi와 Claude는 모델의 거절이 아니라 도구가 없는 구성이고, agy는 도구의 권한 검사가 막았다.

### 이슈 #9의 남은 한계

- **Pi → `agy` → Gemini, Pi → Claude 경로는 없다**(F5, F6). 위 표의 직접 호출은 임시다.
- 실제 `gh issue comment` 게시와 실제 이슈 조회는 하지 않았다(GitHub 쓰기 금지). `gh issue view --json body,comments`의 출력 모양은 병합 어댑터가 읽는 모양과 같다고 가정했다. 미검증.
- 판정자 식별(시험 6): 구현하지 않았다. 공유 `gh` 계정으로 게시하므로 오퍼레이터가 같은 형식의 댓글을 올리는 것을 막지 못한다(오퍼레이터는 `## 리뷰어 판정` 댓글을 훅으로 막는다: `profiles.mjs`).
- `claude -p`는 `--setting-sources user`를 줘도 사용자 전역 `CLAUDE.md`를 읽는다(T0). 이 컴퓨터의 전역 지시 때문에 읽기 전용 시험 응답에 "task-observer 세션 시작 프로토콜은 실행하지 않았습니다" 같은 문장이 붙은 적이 있다. 리뷰어 실행은 `--append-system-prompt`로 막고 있고 실제 판정 3건은 형식대로 나왔지만, 이런 문장이 붙으면 판정 형식이 어긋나 거부로 처리된다(안전한 쪽). 소유자 컴퓨터의 전역 지시에 따라 달라지는 한계다.
- 순환 위치 파일은 잠그지 않는다. 같은 워커 타입의 리뷰어를 동시에 두 번 띄우면 같은 리뷰어가 두 번 나올 수 있다.
- 리뷰어가 읽는 작업 폴더는 이슈의 가장 최근 워커 워크트리(`<실행 폴더>/worktrees/h<N>/issue-<번호>`), 없으면 `targetProject`다. 이 선택은 임시다.
- `harness/agents/reviewer.md`(하위 에이전트 정의)와 `setup.mjs`가 만드는 `.claude/agents/reviewer.md`는 그대로 있다. `run-reviewer`의 프롬프트는 `run-reviewer.mjs` 안에 있어 이 파일을 쓰지 않는다. 정리는 #12 T9의 문서 정합성 몫으로 남긴다.

## 이슈 #10 T7 (워커 실행 스크립트)

| 기준 | 상태 | 근거 |
|---|---|---|
| `claude`, `gemini`, `muse`는 해당 모델로 띄우고, `codex`와 그 밖의 값은 종료 코드 2로 거부한다 | **충족**(가짜 CLI 주입) | `node --test harness/test/run-worker.test.mjs`: 9건 통과. 세 모델이 각각 `claude`/`agy`/`pi`로 실행됐고 모델 ID 인자를 받았다. `codex`, `gpt`, `Claude`, `muse2`, `nope`는 종료 코드 2, stdout 비고, 워크트리 없음. `codex`는 "ADR 0004로 허용 목록에서 뺐습니다" 메시지 |
| 작업 하나에 워크트리 하나가 생기고 다른 워크트리를 건드리지 않는다 | **충족** | 같은 시험: `git worktree list`가 1 → 2 → 3개로 한 개씩 늘고, 첫 워크트리의 HEAD와 `main`, 대상 저장소 작업 폴더(`git status --porcelain`)는 그대로. 같은 이슈를 다시 띄우면 거부(종료 코드 2) |
| 실행 결과에 지정 모델과 실제 모델, 커밋 해시가 남는다 | **충족** | 같은 시험: 출력 JSON에 `requestedModel`, `actualModel`(러너 출력에서 읽은 값), `modelTrace`, `commit`(이슈 브랜치 끝 40자리 해시, 결과 파일의 해시와 같음). 실제 모델이 지정과 다르면 그 시도는 실패로 센다 |
| 실제 Pi로 `fixtures/memo`의 작은 작업 1건이 커밋까지 끝난다 | **충족** (Muse, Pi 경유) | 아래 "실제 실행 1건" |

### 모델 값별 실행 표

실제 기본 설정(`operator.config.json`)으로 가짜 CLI를 주입해 실행한 결과다(`run-worker.test.mjs` 출력).

| 요청 | cli | via | 임시 | 지정 | 실제(출력에서 읽음) |
|---|---|---|---|---|---|
| `claude` | claude | direct | F6 | claude | `claude-haiku-5-5` |
| `gemini` | agy | direct | F5 | gemini | `gemini-4-hydrogen-medium` |
| `muse` | pi | pi | - | muse | `meta/muse-spark-1.3-contributor` |
| `codex` | - | - | - | 거부, 종료 코드 2 | - |
| 그 밖의 값 | - | - | - | 거부, 종료 코드 2 | - |

### 실제 실행 1건 (Muse, Pi 경유)

시험 자료는 `harness/fixtures/memo` 복사본이다. 이슈 본문(가상): `src/memo.mjs`에 `countMemos(store)`를 더하고 시험 하나를 더한 뒤 `node --test`를 통과시키고 커밋. `main` 기준 새 워크트리에서 `run-worker.mjs --handoff h1 --issue 7 --model muse`를 실행했다.

- 종료 코드 0, 시도 1회, 약 24초. 출력 JSON 요지: `status":"완료"`, `requestedModel":"muse"`, `modelId":"meta/muse-spark-1.3-contributor"`, `via":"pi"`, `actualModel":"meta/muse-spark-1.3-contributor"`, `mainBefore`와 `mainAfter`가 같음.
- 커밋 해시: `72d73f9f375297462ef8c374424a88f5da31f200` (`Add countMemos(store) and test (issue #7)`)
- 변경 파일(`git diff --name-only main HEAD`): `src/memo.mjs`, `test/memo.test.mjs`
- fixture 시험(`node --test`, 워크트리에서): tests 4, pass 4, fail 0
- 대상 저장소의 `main`은 그대로.

같은 일을 다른 두 경로로도 1회씩 확인했다(둘 다 Pi를 거치지 않는 임시 경로).

| 모델 | 결과 | 커밋 | 변경 파일 | fixture 시험 | 비고 |
|---|---|---|---|---|---|
| gemini (`agy --sandbox`) | 완료, 시도 1회, 약 67초 | `179126308644d78c86072489d3a3f9e0459e2ff1` | `src/memo.mjs`, `test/memo.test.mjs` | 4/4 통과 | `--sandbox` 안에서도 `git commit`이 되었다. 이 샌드박스가 워크트리 밖 쓰기를 막는지는 확인하지 못했다 |
| claude (`claude -p`, 훅 가드 포함) | 완료, 시도 1회, 약 25초 | `27715248781c4b5782f74142be1ddd95f95b4b18` | `src/memo.mjs`, `test/memo.test.mjs` | 4/4 통과 | 첫 시도는 내 시험용 `harness.json`에 `runDir`가 빠져 가드가 "가드 오류로 막음"으로 모든 도구를 막았고, 워커는 "결과 파일 없음"으로만 보고되었다(가드 오류가 실패 이유에 나오지 않는다). 필드를 더한 두 번째 실행은 통과 |

### 이슈 #10의 남은 한계

- **워커의 권한 격리는 미확인이다.** ADR 0003이 이 저장소에 없다. Pi에는 샌드박스가 없어 Muse 워커는 쓰기 범위가 작업 폴더라는 것뿐이다(결과 JSON의 `isolation`에 적힌다). `agy --sandbox`는 셸 쓰기만 막고 편집 도구는 못 막는다(T5). Claude 워커만 훅 가드가 있다.
- `actualModel`은 러너 출력에서 읽은 값이다. 읽지 못하면 `null`로 남고 그 시도를 실패로 세지는 않는다(시험용 가짜 러너와 호환하기 위해서이고, 리뷰어와 달리 워커는 이슈 기준에 "없으면 인정하지 않는다"가 없다). 읽은 값이 지정과 다르면 실패로 센다.
- 기본 `fallback`을 비웠다. 지정한 모델의 CLI가 없으면 다른 모델로 바꾸지 않고 종료 코드 2다(이슈의 "해당 모델로 띄운다"를 따른 것).
- 오퍼레이터가 `run-worker`를 부르는 인자와 보고 형식은 제안이다. 출력 JSON에 필드를 더했을 뿐 기존 필드는 그대로다.

## 기존 시험과의 대응 / 바꾼 기존 시험

| 이슈 기준 | 대응 |
|---|---|
| T7 `run-worker.test.mjs`(제안 이름)의 모델·워크트리·출력 | 새 파일 `run-worker.test.mjs`. 재시도, 결과 파일 검사, 금지 경로, pid, 중단, 병렬 등 러너 공통 동작은 기존 `operator-worker.test.mjs`가 이미 덮는다 |

작업 때문에 바뀐 기존 시험(원인은 모두 기본 설정이 바뀐 것: 세 모델 허용, `fallback` 비움):

- `operator-config.test.mjs`: 기본 파일의 `allowedModels` 기대값, `fallback` 시험의 대상 모델(허용 목록에 없는 `codex`로), `runners` 선택 키 시험 추가.
- `operator-runners.test.mjs`: 대체 규칙을 시험하는 파일이라 `makeCfg`가 옛 설정(claude만 허용, 대체표 있음)을 바탕으로 하게 했다.
- `operator-worker.test.mjs`: 시험 설정이 옛 대체표를 명시하게 했다. "샌드박스를 확인하지 못한 모델(muse)은 종료 코드 2" 시험은 muse가 Pi로 실행되게 되어 전제가 사라졌으므로 `cli` 값이 없는 새 모델 이름(`mystery`)으로 같은 규칙을 시험하도록 바꿨다.
- `policy.test.mjs`: `run-reviewer.mjs` 허용·거부 사례 추가.
- `operator/e2e/smoke.mjs`(코드 수정): 시험 `operator-smoke.test.mjs`가 처음 실행에서 실패했다(578건 중 1건). 원인은 이 스크립트가 허용 목록을 "훅으로 확인된 모델"의 대용으로 읽어, 허용 목록이 세 모델로 늘자 훅이 없는 gemini·muse 칸을 "거부(통과)"로 채운 것이다. 훅은 claude만의 장치이므로 `cli`가 claude인 모델만 확인된 것으로 읽게 고쳤다. 시험은 고치지 않았다.

## 임시 결정 (소유자 확인 필요, #2)

정해지지 않은 것을 임의로 정하지 않고 ADR이나 이슈의 시작값을 썼다. 아래는 시작값이거나 이 작업이 임시로 둔 것이다.

**소유자 확인 결과 (2026-11-18, `owner-decisions.md` 결정 7):** 1, 2, 4, 5, 7~11은 시작값대로 **확정**이다. 3은 [ADR 0006](../adr/0006-advice-verdict.md)으로 정했다(구현은 남음). 6은 **Pi로 통일**하기로 정했고, F5 설계와 F6 소유자 설정이 끝날 때까지 직접 경로가 임시로 남는다.

1. **순환 단위**: 판정(결과 보고서 판정) 한 번마다 다음 후보로(ADR 0004 시작값). 순서는 `claude, gemini, muse`에서 워커 타입을 뺀 목록. 판정 댓글을 게시한 뒤에만 나아간다.
2. **순환 위치의 기록 장소**: 실행 폴더의 `reviewer-rotation.json`(워커 타입별 마지막 리뷰어). 정해진 곳이 아니다.
3. **조언 판정**(이슈도 커밋도 없는 단계)의 형식: **미결, 구현하지 않음.** 결과 보고서 판정만 구현했다.
4. **거부 이유의 형식**: 첫 줄 `## 리뷰어 판정: 거부`, 다음 줄부터 자유 형식. 형식이 어긋난 응답은 거부로 처리하고 응답 원문(2000자까지)을 댓글에 코드 블록으로 남긴다.
5. **리뷰어 실행 스크립트의 이름과 인자**: `harness/operator/run-reviewer.mjs --issue <번호> [--worker-model claude|gemini|muse]`. 워커 타입은 이슈 본문의 `워커 모델:` 줄에서 읽는다(`--worker-model`은 코디네이터 훅에서는 허용하지 않는다). 결과 보고서 판정을 코디네이터가 띄우는 것으로 두고 `coordinator.md`와 `policy.mjs`에 더했다(오퍼레이터가 띄우는 안은 따로 검토하지 않았다).
6. **Pi를 거치지 않는 경로(F5, F6)**: gemini는 `agy` 직접, claude는 `claude -p` 직접. `operator.config.json`에 `temporary`로 표시했다.
7. **Gemini 추론 강도**: `medium`(`gemini-4-hydrogen-medium`). 소유자 결정이 없다.
8. **`claude`는 `claude-haiku-5-5`**, **`muse`는 `meta/muse-spark-1.3-contributor`**: T5에서 호출로 확인한 ID이고 소유자의 해석 확인은 없다.
9. **판정 댓글의 덧붙임 줄**: `리뷰어 모델:`, `실행 경로:`, `실행 흔적:`, `워커 타입:` 줄을 판정 아래에 붙인다. `허용된 커밋` 줄은 정확히 한 줄이라 병합 어댑터와 맞는다.
10. **시간 제한**: 리뷰어 15분(`DEFAULT_TIMEOUT_MS`). 워커는 기존 2시간.
11. **리뷰어 작업 폴더**: 이슈의 가장 최근 워커 워크트리, 없으면 `targetProject`.

## 소유자 결정이 필요한 것

- F5(Pi → `agy` → Gemini)와 F6(Pi → Claude): 해결 방식(Pi 확장, 자격 증명 설정)을 정해 달라. 그전까지 gemini와 claude의 직접 경로가 임시로 쓰인다. 결정되면 `operator.config.json`의 해당 `runners` 항목을 바꾸면 된다.
- ~~위 임시 결정 1~11의 확정(특히 순환 단위와 기록 장소, 조언 판정과 거부 이유의 형식, 스크립트 이름, 결과 판정을 누가 띄우는지).~~ 확정됨(위 "소유자 확인 결과").
- 판정자 식별(시험 6, T5 문서): 이 스크립트도 공유 `gh` 계정으로 댓글을 올린다.
- 워커 격리 규칙(ADR 0003 본문 확보): Pi 워커는 샌드박스가 없다. 허용할지, 어떤 보완이 필요한지.
- 소유자가 본 실행의 모델 호출 비용과 Muse Contributor 등급 데이터 학습 가능성을 승인했다. 이번에 Muse에 보낸 것은 공개 시험 자료와 가상의 이슈·보고서 문장뿐이다.

## 시험 결과

- `node --test harness/test/*.test.mjs`(Windows, Node 26.7): **tests 580, pass 580, fail 0, cancelled 0, skipped 0.** 1단계의 508건에 새 시험 72건(verdict 32, reviewer-rotation 8, run-reviewer 22, run-worker 9, operator-config 1, policy 안의 사례는 기존 시험에 포함)이 더해졌다.
- 같은 명령의 앞선 실행(수정 전)은 578건 중 1건 실패였고(`operator-smoke`, 위 `smoke.mjs` 항목), 고친 뒤 위 결과가 나왔다.
- `node scripts/check.js`: 모든 줄 `ok`(마지막 줄 `ok   sprites 20장`).
- ubuntu CI는 돌리지 못했다(F4). 새 시험의 경로는 `fileURLToPath`를 쓰고 Windows 전용 가정을 피했지만 미검증이다.
