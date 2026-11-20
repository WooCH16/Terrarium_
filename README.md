# Terrarium

[English](README.en.md)

Terrarium은 Claude Code 에이전트를 계층으로 나눠 일을 맡기는 개인용 하네스입니다. 사용자는 코디네이터 한 명과만 대화합니다.

| 역할 | 하는 일 | 실행 |
|---|---|---|
| 코디네이터 | 사용자와 대화하고, 요구를 정리하고, 작업을 이슈로 쪼개 하달하고, 결과를 대조해 보고합니다 | Claude Code 세션(실행 폴더의 `CLAUDE.md`) |
| 어드바이저 | 대상 프로젝트를 읽고 작업 분해 제안문을 씁니다. 조언만 합니다 | 코디네이터의 하위 에이전트 |
| 오퍼레이터 | 이슈를 받아 워커에게 맡기고, 결과를 합치고, 보고서를 씁니다 | 별도 Claude Code 세션 |
| 워커 | 실제 작업을 합니다. 작업마다 워크트리 하나를 씁니다 | Pi(claude·gemini·muse) |
| 리뷰어 | 제안문과 보고서를 허용/거부합니다. 이슈마다 워커 모델·유형·난이도도 고릅니다(라우팅) | Jev(TypeSafe System One API). 판단은 Jev, 결정은 스크립트 |

결과는 오퍼레이터 보고서 → 리뷰어 허용/거부 → 코디네이터 완료 기준 대조 → 사용자 보고 순서로 올라옵니다. 사용자가 반영을 결정해야만 대상 프로젝트의 `main`이 바뀝니다. 자세한 정의는 [docs/00-definition.md](docs/00-definition.md)를 봅니다.

## 범위 (v0)

- **프로토콜이 한국어입니다.** 역할 문서, 이슈 양식, 판정 댓글이 한국어이고 스크립트가 그 글자를 읽습니다(`harness/operator/protocol.mjs`).
- **Windows에서 시험했습니다.** 다른 운영체제는 시험하지 않았습니다.
- **필요한 계정:** GitHub(`gh` 로그인, 비공개 지정 저장소), Claude Code 로그인, 워커 모델 1곳 이상(Pi의 Anthropic 로그인이나 Gemini API 키 등), TypeSafe Jev 키(`TYPESAFE_API_KEY`).
- 받기 전에 [알려진 한계](docs/known-limitations.md)를 읽으세요. 워커에는 OS 샌드박스가 없고, 같은 `gh` 계정으로 판정을 꾸밀 수 있습니다.

## 쓰는 방법: 앱 버전과 Claude CLI 버전

하네스를 쓰는 방법은 두 가지입니다. 어느 쪽이든 코디네이터는 실행 폴더에서 도는 같은 대화형 Claude Code 세션입니다. 같은 규칙(`CLAUDE.md`)과 같은 훅을 쓰므로 하는 일은 같습니다. 다른 것은 창과 준비 과정뿐입니다.

| | 앱 버전 | Claude CLI 버전 |
|---|---|---|
| 코디네이터와 대화하는 곳 | 앱 관제탑 화면의 ORCHESTRA 칸 | 터미널에 직접 띄운 `claude` |
| 사전 점검, 실행 폴더 설치 | 메뉴 [설정]의 화면에서 누름 | `preflight.mjs`, `setup.mjs`를 직접 실행 |
| API 키(`TYPESAFE_API_KEY`, `GEMINI_API_KEY`) | 앱이 이 컴퓨터의 암호화 저장소에 두고 코디네이터에 환경 변수로 넘김 | 저장소 루트의 `.env` |
| 진행 확인 | 메뉴 [설정 > 진행 기록](이슈·하달·판정, 읽기 전용) | GitHub 이슈와 실행 폴더의 기록 파일 |
| 맞는 경우 | 터미널 없이 설치해서 쓸 때 | 하네스를 고치거나 시험할 때, 앱을 설치하지 않을 때 |

두 버전 모두 Node 22 이상, git, [GitHub CLI](https://cli.github.com/)(`gh auth login`), [Claude Code](https://claude.com/claude-code)(로그인), Pi(`npm install -g @earendil-works/pi-coding-agent`, `pi auth login anthropic` 등)가 있어야 합니다. 지정 저장소는 비공개여야 합니다.

같은 실행 폴더를 두 버전에서 번갈아 열 수 있습니다. 터미널에서 만든 실행 폴더는 앱 설정 창 위쪽의 실행 폴더 **열기…**로 고르면 됩니다. 다만 한 실행 폴더에 코디네이터를 둘 띄우지는 마세요. 앱과 터미널에서 동시에 열면 하달이 겹칩니다.

### 1. 앱 버전

`app/`에 Windows 데스크톱 앱이 있습니다(ADR 0010, 0011). 본창은 관제탑 화면이고, ORCHESTRA 칸에 코디네이터 터미널이 뜹니다. 관제탑의 오퍼레이터 카드·팀·통합·사무실에는 그 실행 폴더의 최근 하달 다섯 개가 보입니다(하달 하나가 카드 하나, 맡은 이슈가 워커, 막대는 이슈 라벨 단계, 읽기 전용).

```bash
cd app
npm install
npm start            # 개발 실행
npm run dist         # Windows 설치 파일: app/dist/Terrarium Setup <버전>.exe
```

처음 쓸 때 순서:

1. 메뉴 **[설정 > 계정]**: 로그인 창 단추로 Claude Code, GitHub, Pi에 로그인합니다. API 키를 넣고, 지정 저장소(`<소유자>/<이름>`)를 적어 **사전 점검**을 누릅니다. 점검을 통과해야 코디네이터 터미널이 뜹니다.
2. 메뉴 **[설정 > 실행 폴더 설치]**: 지정 저장소, 실행 폴더 이름, 대상 프로젝트(main 브랜치가 있는 git 폴더, 비우면 시험용 메모 프로그램)를 넣고 **설치**를 누릅니다.
3. 본창의 **ORCHESTRA 칸**: 터미널이 뜨면 코디네이터에게 바로 말합니다. 처음에는 폴더 신뢰 질문이 나오니 **Yes**를 고르세요. "No"를 고르면 실행 폴더 설정의 허용 목록이 적용되지 않습니다.
   - Esc로 턴을 끊고, `/compact` 같은 Claude Code 명령을 그대로 씁니다.
   - 코디네이터가 끝나면 터미널에서 Enter를 누르면 이어서 다시 열리고, N을 누르면 새 대화가 열립니다.
   - 앱을 다시 켜면 그 실행 폴더의 앞 대화가 이어서 열립니다.

설치 파일은 코드 서명이 없습니다(소유자 결정 8-13). 처음 실행할 때 Windows가 "Windows의 PC 보호" 경고를 띄우면 **추가 정보 → 실행**을 누릅니다.

### 2. Claude CLI 버전

터미널에서 스크립트를 직접 실행하고, 실행 폴더에서 `claude`를 띄워 코디네이터와 대화합니다.

```bash
# 1. 키: 저장소 루트의 .env에 넣습니다(git에 올라가지 않음)
#    TYPESAFE_API_KEY=...      (필수, 리뷰어·라우팅)
#    GEMINI_API_KEY=...        (gemini 워커를 쓸 때)

# 2. 비공개 지정 저장소를 만들고 사전 점검
gh repo create <owner>/harness-issues --private
node harness/preflight.mjs --repo <owner>/harness-issues

# 3. 실행 폴더 설치 (대상 프로젝트를 주지 않으면 시험용 메모 프로그램)
node harness/setup.mjs --run C:/Users/<you>/my-run --repo <owner>/harness-issues --project C:/path/to/your/git/project

# 4. 실행: 실행 폴더에서 코디네이터를 띄웁니다(앱이 띄우는 것과 같은 설정)
cd C:/Users/<you>/my-run
claude --setting-sources project,local --allowedTools "Bash Write Edit Read Glob Grep Agent TodoWrite Skill"
#    이어서 하려면 같은 명령에 --continue 또는 --resume <세션 id>를 붙입니다

# 5. 확인 (실행이 끝난 뒤)
node harness/e2e/verify.mjs --run C:/Users/<you>/my-run --since <시작 시각 ISO>
```

`--project`는 대상 저장소를 실행 폴더 안으로 복제하고 `origin`을 끊어, 하네스가 원래 저장소에 쓰지 않게 합니다. 대상 프로젝트마다 지정 저장소를 따로 만드세요. 자세한 설명(신뢰 질문, Muse 공개 제한, 시험)은 [harness/README.md](harness/README.md)에 있습니다.

## 폴더

| 경로 | 내용 |
|---|---|
| `harness/` | 하네스 코드와 역할 문서(기준). 역할마다 `harness/<역할>/AGENT.md`(코디네이터, 어드바이저, 오퍼레이터, 워커, 리뷰어)가 있고 설계는 `docs/<역할>.md`입니다. 코디네이터 문서는 실행 폴더의 `CLAUDE.md`가 됩니다 |
| `app/` | 데스크톱 앱(Electron) |
| `docs/` | 정의, 설계, ADR, 확인과 실행 기록(`docs/checks/`) |
| `index.html`, `css/`, `js/`, `assets/` | 관제탑 화면. 앱의 본창이며, 브라우저로 열면 목 데이터로 돕니다(`js/terminal.js`는 앱에서만 동작) |
| `scripts/` | 시험 실행(`test.mjs`), CI 검사(`check.js`) |

## 시험

```bash
node scripts/test.mjs --fast   # 빠른 시험
node scripts/test.mjs          # 전체(수 분)
node scripts/check.js          # CI 검사
```

## 라이선스

[MIT](LICENSE).

## 문서

- [docs/00-definition.md](docs/00-definition.md): 정의
- [docs/01-overview.md](docs/01-overview.md): 코디네이터 설계
- [docs/operator.md](docs/operator.md): 오퍼레이터 설계
- [docs/adr/README.md](docs/adr/README.md): 결정 기록(ADR) 색인
- [docs/known-limitations.md](docs/known-limitations.md): 알려진 한계
- [docs/checks/runs.md](docs/checks/runs.md): 실제 실행 기록
