[대역] 어드바이저 대역이 쓴 제안문이다. 실제 어드바이저의 조언이 아니다.
# 제안문: memo 목록 정렬 (부족)

## 작업 단위 1: 정렬 기능 추가

### 목표
`list` 명령에 `--sort title`과 `--sort created` 옵션을 더한다.

### 완료 기준
| 기준 | 확인 방법 |
|---|---|
| `list --sort title`이 제목 순으로 출력한다 | `node --test memo/test/sort.test.mjs`의 title 정렬 사례 |

### 먼저 끝나야 할 것
없음

## 작업 단위 2: 정렬 사용법 문서

### 목표
`memo/README.md`에 정렬 옵션 사용법을 더한다.

### 완료 기준
| 기준 | 확인 방법 |
|---|---|
| README에 `--sort title` 예시가 있다 | `node memo/cli.mjs list --sort title`의 출력이 README 예시와 같다 |

### 전제·위험
- README가 아직 없으면 새로 만든다.
