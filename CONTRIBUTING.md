# 기여 안내 (Contributing)

Terrarium에 관심 가져 주셔서 고맙습니다. 이 문서는 이슈와 PR을 보내는 방법을 짧게 적습니다. English summary is at the bottom.

## 시작하기

1. 저장소를 포크하고 받습니다.
2. Node.js 24 이상이 필요합니다. 앱을 고치려면 `app/`에서 `npm install`을 합니다.
3. 시험을 돌립니다.

   ```bash
   node scripts/test.mjs --fast   # 빠른 시험
   node scripts/check.js          # CI와 같은 검사
   ```

   하네스 시험만 볼 때는 바꾼 파일과 관련된 것만 돌리세요. 전체를 한 번에 돌리면 메모리를 많이 씁니다.

   ```bash
   cd harness && node --test --test-concurrency=1 test/<파일>.test.mjs
   ```

## 이슈

- 버그는 재현 순서, 기대한 결과, 실제 결과, 운영체제를 적어 주세요.
- 기능 제안은 풀고 싶은 문제부터 적어 주세요.
- 보안 문제는 공개 이슈로 올리지 마세요. [SECURITY.md](SECURITY.md)를 보세요.

## PR

- 한 PR에는 한 가지 변경만 담습니다.
- 동작을 바꾸면 시험을 함께 더합니다(먼저 실패하는 시험을 쓰고 고칩니다).
- 설계를 바꾸는 변경은 `docs/adr/`의 결정 기록과 `docs/checks/owner-decisions.md`를 먼저 읽어 주세요. 기존 결정과 다르면 PR 설명에 이유를 적어 주세요.
- 문서는 지금 문체(짧은 한국어 문장, 결정 번호 표기)를 따릅니다. 영어 PR도 괜찮습니다.
- 관제탑 화면(`index.html`, `css/`, `js/`, `assets/`)의 디자인을 크게 바꾸려면 먼저 이슈로 의논해 주세요.

## 올리면 안 되는 것

이 저장소는 공개입니다. 아래는 커밋하지 마세요.

- API 키, 토큰, `.env`, 로그인 정보
- 개인 경로(`C:/Users/<이름>/...`), 이메일, 비공개 저장소 이름
- 실행 폴더(`terrarium-run-*`)의 기록, 앱 설정 파일

예시 값은 `o/r`, `owner/app`, `ghp_` + `A` 반복 같은 가짜를 씁니다. 하네스 훅도 토큰 모양을 막지만, 커밋 전에 한 번 더 확인해 주세요.

## 라이선스

보낸 기여는 이 저장소의 [MIT 라이선스](LICENSE)로 배포되는 데 동의한 것으로 봅니다.

---

## English summary

- Requires Node.js 24+. Run `node scripts/test.mjs --fast` and `node scripts/check.js` before opening a PR. For harness changes, run only the related test files with `node --test --test-concurrency=1`.
- One change per PR. Add tests for behavior changes. Read `docs/adr/` before changing the design.
- Discuss large changes to the control-tower UI (`index.html`, `css/`, `js/`, `assets/`) in an issue first.
- This repository is public: never commit keys, tokens, `.env`, personal paths, emails or private repository names. Use fake examples such as `owner/app`.
- Report security issues privately, see [SECURITY.md](SECURITY.md).
- Contributions are licensed under the repository's [MIT License](LICENSE).
