# ADR 0009. 워커 세 모델을 모두 Pi로 띄운다

- 상태: **채택됨**
- 날짜: 2026-11-19
- 이슈: #26 (실패 기록 F5·F6)
- 대체: [ADR 0004](0004-pi-worker-reviewer.md) 결정 A의 임시 경로(gemini는 `agy` 직접, claude는 `claude -p` 직접, `temporary: F5·F6`). 리뷰어는 이미 Jev다([ADR 0008](0008-jev-reviewer-routing.md)).
- 유효한 것: 워커 모델 값(`claude`, `gemini`, `muse`), 대체 표, 공개 제한(ADR 0007), 라우팅 기준(소유자 결정 8-9의 모델별 맡길 일).

## 배경

ADR 0004는 워커를 Pi로 띄우려 했지만, Pi에서 Anthropic과 Google 자격 증명이 준비되지 않아(F5·F6) gemini와 claude는 각 CLI를 직접 부르는 임시 경로로 남았다. 소유자가 "셋 다 Pi로"를 골랐다(2026-11-19). 고를 때 claude 워커의 하네스 훅이 없어진다는 점을 알렸다.

## 결정

- `operator.config.json`의 `runners`:
  - claude: `pi ... --model anthropic/claude-sonnet-5-5` (Pi의 Anthropic 계정 로그인, OAuth. 처음엔 haiku였고 소유자 결정 8-15로 sonnet)
  - gemini: `pi ... --model google/gemini-4-hydrogen:medium` (소유자: 하이드로젠 모델. 생각 수준 medium은 예전 agy의 `gemini-4-hydrogen-medium`과 같음). Pi의 Google 연결은 API 키만 받는다(계정 로그인 없음).
  - claude는 난이도별 모델을 둔다(`tiers`, 소유자 결정 8-16): 쉬움 `anthropic/claude-haiku-5-5`, 어려움·모름 `anthropic/claude-sonnet-5-5`.
  - muse: 그대로 `pi ... --model meta/muse-spark-1.3-contributor`.
  - 세 모델 모두 같은 Pi 옵션(`--no-session --no-extensions --no-skills --no-mcp --no-context-files --no-prompt-templates --no-themes --mode json`)을 쓴다. `temporary` 표시는 없앴다.
- 러너 비밀값은 `runners.<모델>.secretEnv`에 이름만 적는다(gemini: `GEMINI_API_KEY`). 스크립트가 환경 변수 → 실행 폴더 `.env` → 하네스 저장소 `.env`에서 읽어 그 러너의 환경 변수로만 넘긴다(`env-file.mjs`). 없으면 그 모델은 쓸 수 없는 것으로 보고 대체 표로 넘어간다. 값은 출력·기록에 남기지 않는다.
- Claude Code 훅 설정은 모델이 아니라 실행 CLI가 `claude`일 때만 붙인다. 이제 기본 설정에서 훅이 걸리는 워커는 없다. 결과 JSON의 `isolation`은 세 모델 모두 "없음"이다.
- 사전 점검은 Pi 모델마다 `pi auth check --model`과 비밀값 유무를 본다.

## 결과와 위험

- **claude 워커의 훅 보호가 없어졌다.** 예전에는 claude 워커에만 쓰기 범위·`main` 보호·비밀값 차단 훅이 걸렸다. 이제 세 워커 모두 Pi의 기본 도구(read, bash, edit, write)를 쓰고, 막는 장치는 다음뿐이다:
  - 작업 폴더가 이슈 워크트리라는 것(쓰기 제한은 아님)
  - `run-worker`의 사후 검사(새 커밋, 금지 경로 변경, 결과 파일 모양, `main` 해시 불변)
  - 합치기 시험, Jev 리뷰어, 코디네이터 대조
  - (2026-11-19 더함) 작업 폴더 밖 보호 대상의 전후 비교: 실행 폴더의 `harness.json`·`operator.local.json`·`.env`·`CLAUDE.md`·`.claude/`, 하네스 폴더 전체, 대상 프로젝트 본 폴더의 `git status`. 바뀌면 그 하달을 막힘으로 끝내고 다시 시도하지 않는다(결과 JSON `outsideChanges`). 쓰기를 막지는 못하고 알아챌 뿐이다.
- 그래서 소유자 결정 8-9의 "설정·권한·보안 변경은 claude"의 근거 중 "claude만 훅이 강제된다"는 더 이상 맞지 않는다. claude에 맡기는 근거는 모델 능력(여러 모듈 이해)만 남는다. 기준을 바꿀지는 소유자가 정한다.
- **비밀값이 워커에 보인다.** (2026-11-19부터 워커는 부모 환경 변수를 통째로 받지 않고 허용 목록(PATH, 임시 폴더, 사용자 프로필, 로캘, 프록시, `GIT_CONFIG_*`, `PI_*` 등)과 그 러너의 `secretEnv`만 받는다. 그래서 코디네이터·오퍼레이터 쪽의 `TYPESAFE_API_KEY`는 워커 환경 변수에 없다. 파일로 읽는 것은 막지 못한다.) gemini 워커의 환경 변수에 `GEMINI_API_KEY`가 있고, Pi의 bash 도구로 읽을 수 있다. Anthropic 자격 증명도 Pi 설정 파일(`~/.pi/agent/auth.json`)에 있어 같은 사용자 권한의 워커가 읽을 수 있다. OS 샌드박스가 없다는 알려진 한계(#31)에 들어간다.
- **제공사 혼잡 때 Pi는 출력 없이 계속 다시 시도한다**(2026-11-19 run-7, Google 503). 그래서 `run-worker`는 러너가 15분 동안 아무것도 출력하지 않으면 끊고, 그 모델을 빼고 대체 표의 다음 모델로 남은 시도를 한다(`docs/checks/runs.md` R7-1).
- Pi는 저장된 자격 증명(`auth.json`)을 환경 변수보다 먼저 쓴다. 예전 키가 남아 있으면 새 키를 넣어도 예전 키로 요청이 간다(2026-11-19에 실제로 겪음). 키를 바꿀 때는 `pi auth logout <제공사>`로 저장된 키를 지운다.

## 확인

- 2026-11-19 실제 호출: Pi로 `anthropic/claude-haiku-5-5`(뒤에 `claude-sonnet-5-5`도)와 `google/gemini-4-hydrogen:medium`이 응답했다(hydrogen은 Google 쪽 503 혼잡 뒤 Pi가 다시 시도해 성공).
- `harness/test/run-worker.test.mjs`: claude 모델을 Pi로 띄우면 훅 설정이 없고 격리 없음으로 기록, `secretEnv`가 없으면 대체, 있으면 러너만 받음.
- `harness/test/preflight.test.mjs`: Pi 계정 준비와 비밀값 확인.
