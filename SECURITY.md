# 보안 정책 (Security Policy)

## 알리는 방법

보안 문제(비밀값이 새는 길, 훅을 우회하는 명령, 권한 밖 GitHub 쓰기 등)는 **공개 이슈로 올리지 마세요.**
GitHub 저장소의 **Security → Report a vulnerability**(비공개 취약점 보고)로 알려 주세요.

적어 주시면 좋은 것:

- 문제의 종류와 영향
- 재현 순서(가짜 토큰·가짜 저장소로)
- 영향을 받는 커밋이나 버전

진짜 비밀값을 보고에 넣지 마세요.

## 지원 범위

- `beta`, `main` 브랜치의 최신 커밋을 고칩니다. 옛 설치본은 따로 고치지 않습니다.
- 하네스의 안전 장치(훅 `harness/policy.mjs`, `harness/guard.mjs`)와 그 한계는 [docs/known-limitations.md](docs/known-limitations.md)에 있습니다. 이미 적힌 한계는 보고하셔도 되지만, 먼저 그 문서를 확인해 주세요.

## 쓰는 분이 지킬 것

- 지정 저장소(이슈가 오가는 곳)는 **비공개**로 둡니다. 사전 점검(`node harness/preflight.mjs`)이 확인합니다.
- 키는 저장소 루트의 `.env`나 앱의 안전 저장소에 둡니다. `.env`는 git에 올라가지 않습니다.

---

**English:** Please do not open public issues for security problems. Use GitHub's private vulnerability reporting (Security → Report a vulnerability). Include the impact and reproduction steps using fake tokens and repositories only. Fixes target the latest commits of `beta` and `main`. Known limits of the harness safeguards are listed in [docs/known-limitations.md](docs/known-limitations.md).
