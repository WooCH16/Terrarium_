# 문서 목록

| 파일 | 내용 |
|---|---|
| [00-definition.md](00-definition.md) | Terrarium 정의: 역할, 모델, 결과 흐름, 계획 |
| [01-overview.md](01-overview.md) | 코디네이터 전체 설계. 5장 기록과 컴팩션(5.2 중간 압축 규칙) 포함 |
| [adr/README.md](adr/README.md) | 결정 기록(ADR) 색인. 현재 유효한 ADR은 여기서 "채택됨"인 것 |
| [adr/0001-harness-shape.md](adr/0001-harness-shape.md) | 하네스 구조 결정 |
| [adr/0002-reviewer-gates-advice.md](adr/0002-reviewer-gates-advice.md) | 리뷰어가 조언을 게이트하는 결정 |
| [adr/0004-pi-worker-reviewer.md](adr/0004-pi-worker-reviewer.md) | 워커와 리뷰어의 Pi 실행과 모델 구성 (**제안됨**) |
| [harness/coordinator.md](harness/coordinator.md) | 코디네이터 역할 지침 (실행 문서) |
| [harness/advisor.md](harness/advisor.md) | 어드바이저 역할 지침 |
| [harness/README.md](harness/README.md) | 하네스 사용 설명 (구현 코드는 이 저장소에 없음) |
| [pi-워커-리뷰어.md](pi-워커-리뷰어.md) | Pi 사용 결정의 근거와 시험 계획 |

## 빠진 것

- ADR 0003(오퍼레이터 하네스)과 `operator.md`: 이 저장소에 없습니다. 문서 곳곳이 이 둘을 가리킵니다.
- 설계 논의 기록 등 이력 문서(`history/`): 포함하지 않았습니다.
- 하네스 구현 코드와 테스트(`guard.mjs`, `policy.mjs`, `setup.mjs`, `test/*` 등): 이 저장소에 없습니다.

## 규칙

- 결정을 바꿀 때는 옛 ADR을 고치지 않고 새 ADR을 씁니다. 상태는 "제안됨", "채택됨", "대체됨"입니다.
- 문서 안의 `[보충]` 표시는 설계 논의의 답을 문서 형태로 풀어 쓴 표현이며 확인이 필요합니다.
