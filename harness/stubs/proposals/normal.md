[대역] 어드바이저 대역이 쓴 제안문이다. 실제 어드바이저의 조언이 아니다.
# 제안문: memo 목록 정렬 (정상)

## 작업 단위 1: 정렬 기능 추가

### 목표
`list` 명령에 `--sort title`과 `--sort created` 옵션을 더한다. 옵션이 없으면 지금처럼 저장한 순서로 보인다.

### 완료 기준
| 기준 | 확인 방법 |
|---|---|
| `list --sort title`이 제목의 가나다·알파벳 순으로 출력한다 | `node --test memo/test/sort.test.mjs`의 title 정렬 사례 |
| `list --sort created`가 만든 시각 순으로 출력한다 | 같은 시험의 created 정렬 사례 |
| 옵션이 없으면 출력 순서가 바뀌지 않는다 | 기존 `node --test memo/test/memo.test.mjs`가 그대로 통과한다 |

### 먼저 끝나야 할 것
없음

### 전제·위험
- 제목이 같은 메모의 상대 순서는 정하지 않았다. 필요하면 사용자에게 묻는다.
- 저장 형식(`memos.json`)은 바꾸지 않는다.

## 작업 단위 2: 정렬 사용법 문서

### 목표
`memo/README.md`에 정렬 옵션 사용법을 한 절 더한다.

### 완료 기준
| 기준 | 확인 방법 |
|---|---|
| README에 `--sort title`, `--sort created` 예시가 각각 있다 | `node memo/cli.mjs list --sort title`의 출력이 README 예시와 같다 |

### 먼저 끝나야 할 것
작업 단위 1

### 전제·위험
- README가 아직 없으면 새로 만든다.
