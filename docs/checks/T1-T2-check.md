# T1·T2 확인 (이슈 #4, #5)

2026-11-23. 묶음 A: 두 이슈 모두 코드가 이미 있었고, 끝나는 조건을 시험 명령과 CI로 확인했다. 두 이슈를 PR 하나로 묶어 CI를 한 번만 돌린다.

## T1: 뼈대, 설정값, CI 연결 (#4)

| 기준 | 확인 방법 | 결과 |
|---|---|---|
| 8절 수치 중 코디네이터가 쓰는 값이 설정 파일 한 곳에 있다 | `node --test harness/test/config.test.mjs` | 통과 |
| 워커 모델 허용 값이 `claude`, `gemini`, `muse`이고 `codex`가 없다 | 같은 시험(`워커 모델 허용 값은 claude, gemini, muse이고 codex가 없다`, `codex를 넣으면 거부한다`) | 통과. `harness/operator/operator.config.json`의 `allowedModels`도 같다 |
| 단위 시험이 한 명령으로 돈다 | `node scripts/test.mjs`(빠른 시험과 느린 시험을 모두 돈다. `harness/test/*.test.mjs` 전체) | 아래 "전체 시험" |
| CI가 단위 시험을 실행한다 | `.github/workflows/ci.yml`의 `harness-unit`(빠른 시험 → 느린 시험) | 통과. beta `5eed155`의 CI 실행이 성공했다 |
| 기존 검사가 깨지지 않는다 | `node scripts/check.js` | 통과 |

- 이슈의 "전제·위험"에 적힌 것: 코드 위치는 `harness/`로 정해졌다. ubuntu CI에서 깨지던 시험 두 개(`#22` 경로 모양, Linux의 분리된 자손 프로세스 정리)는 `ed419cd`, `7fcb119`, `5eed155`에서 고쳤다. 느린 시험은 CI에서 따로 돈다(`--slow`, 작업 시간 한도 20분).

## T2: 권한 훅 (#5)

| 기준 | 확인 방법 | 결과 |
|---|---|---|
| 허용된 명령 모양만 통과하고 금지 문자가 든 명령은 막힌다 | `node --test harness/test/policy.test.mjs` | 통과 |
| `{{ISSUES}}` 밖 쓰기, `.git/` 내부, `CLAUDE.md`·`harness.json`·`.claude/` 수정이 막힌다 | 같은 시험 | 통과 |
| 비밀값 파일 읽기·검색이 모든 역할에서 막힌다 | 같은 시험 | 통과 |
| 하위 에이전트는 advisor만 부를 수 있다 | 같은 시험 | 통과 |
| 훅 내부 오류가 나면 막고, 판정마다 `guard.log`에 한 줄이 남는다 | `node --test harness/test/guard.test.mjs` | 통과. **고친 것:** 입력 JSON이 깨진 것 같은 가드 오류는 막기만 하고 기록을 남기지 않았다. 이제 설정 파일을 읽은 뒤의 오류는 실행 폴더의 `guard.log`에 한 줄 남긴다(설정 파일조차 못 읽으면 남길 곳을 몰라 막기만 한다). 시험을 더했다 |

`guard.log` 예시 3줄(가짜 실행 폴더, 경로는 `<run>`으로 바꿈):

```
{"time":"2026-11-23T11:58:11.342Z","agent_type":null,"tool_name":"Read","allow":true,"reason":"허용","summary":"<run>\\memo\\cli.mjs"}
{"time":"2026-11-23T11:58:11.397Z","agent_type":null,"tool_name":"Bash","allow":false,"reason":"명령 연결·치환·확장·이스케이프·리다이렉트는 쓸 수 없다. 명령은 하나씩 실행하라","summary":"ls; cat ~/.ssh/id_rsa"}
{"time":"2026-11-23T11:58:11.454Z","agent_type":null,"tool_name":null,"allow":false,"reason":"가드 오류로 막음: Expected property name or '}' in JSON at position 1 (line 1 column 2)","summary":""}
```

## 전체 시험

`node scripts/test.mjs`와 `node scripts/check.js`를 PR 전에 한 번 돌렸다(Windows). 결과는 PR 본문에 적는다.
