# 변경 기록 (Changelog)

이 프로젝트의 눈에 띄는 변경을 여기에 적습니다. 형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/)를, 버전은 [유의적 버전](https://semver.org/lang/ko/)을 따릅니다. `0.x` 동안은 부 버전이 올라갈 때도 호환이 깨질 수 있습니다.

## [Unreleased]

## [0.1.0] - 미정 (첫 공개 미리보기, Windows 우선)

첫 공개 버전입니다. 사용자는 코디네이터 한 명과만 대화하고, 코디네이터가 일을 이슈로 쪼개 역할 오퍼레이터와 워커에게 맡깁니다. 리뷰어 판정과 사용자 승인을 거친 결과만 대상 프로젝트의 `main`에 들어갑니다. 릴리스 노트: [docs/releases/v0.1.0.md](docs/releases/v0.1.0.md).

### 추가

- **하네스(`harness/`)**
  - 역할: 코디네이터, 어드바이저, 역할 오퍼레이터 다섯(개발·디자인·테스터·기획·보안), 워커(Pi로 claude·gemini·muse), 리뷰어·라우팅(Jev).
  - 설치·점검: `setup.mjs`(실행 폴더 설치), `preflight.mjs`(사전 점검).
  - 훅: `policy.mjs`, `guard.mjs`. 역할별 허용 명령, 비밀값 보호, 판정 기록 `guard.log`.
  - 반영: 로컬 흐름 `run-reflect`.
  - GitHub Actions 흐름(결정 8-32): 이슈 PR → 하달 PR → CI → 사용자 승인 뒤 머지 트레인. 섞인 하달 반려와 옛 PR·브랜치 정리(8-35), 트레인 실패 원인과 원격 정리 결과 보고도 포함.
  - 역할별 스킬: `harness/<역할>/skills/`.
- **데스크톱 앱(`app/`, Electron)**
  - 관제탑 화면과 코디네이터 터미널(ORCHESTRA 칸). 관제탑 카드·팀·통합·사무실에는 실제 하달 상태가 보입니다.
  - 설정 화면(계정, 설치, 진행): 관제탑 목록 맨 아래 [설정]으로 본창 안에서 열립니다. [저장] 확인 뒤에만 적용되고 관제탑으로 돌아옵니다.
  - 폴더 패널(관제탑 오른쪽 빈 공간): 고른 폴더(기본은 지금 실행 폴더)의 내용을 보입니다. 바뀌는 중인 파일과 그 폴더는 주황, 바뀜이 멈추면 초록으로, 코디네이터에 다음 지시가 들어갈 때까지 남습니다.
  - API 키 보관: 이 컴퓨터의 암호화 저장소에 두고, 코디네이터 터미널에 환경 변수로만 넘깁니다.
  - 시작 잠금: 워커 모델 계정이나 Jev 키가 없으면 코디네이터 터미널이 뜨지 않습니다.
  - Windows 설치 파일(NSIS, 서명 없음).
- **저장소 스킬:** `.claude/skills/issue-flow`(이슈 처리 8단계), `.claude/skills/ci-batch-flow`(이슈를 묶어 CI를 덜 돌리는 흐름).
- **문서:** 정의·설계(`docs/`), 결정 기록(`docs/adr/`), 알려진 한계, 실행 기록(`docs/checks/runs.md`), 기여·보안 안내, 행동 강령, 이슈·PR 양식.
- **CI:** ubuntu에서 문법·자원 검사, 빠른 시험, 느린 시험.

### 알려진 한계

[docs/known-limitations.md](docs/known-limitations.md)를 보세요.

- 같은 `gh` 계정으로 판정을 꾸밀 수 있습니다.
- 워커에는 OS 샌드박스가 없습니다.
- 리뷰어·라우팅이 Jev 한 곳에 달려 있습니다.
- 하네스를 실제로 돌려 본 것은 Windows뿐입니다.

[Unreleased]: https://github.com/WooCH16/Terrarium_/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/WooCH16/Terrarium_/releases/tag/v0.1.0
