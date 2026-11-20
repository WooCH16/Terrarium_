# 문서 목록

| 파일 | 내용 |
|---|---|
| [00-definition.md](00-definition.md) | Terrarium 정의: 역할, 모델, 결과 흐름, 계획 |
| [01-overview.md](01-overview.md) | 코디네이터 전체 설계. 5장 기록과 컴팩션(5.2 중간 압축 규칙) 포함 |
| [operator.md](operator.md) | 오퍼레이터 설계 (ADR 0003 근거) |
| [adr/README.md](adr/README.md) | 결정 기록(ADR) 색인. 현재 유효한 ADR은 여기서 "채택됨"인 것 |
| [adr/0001-harness-shape.md](adr/0001-harness-shape.md) | 하네스 구조 결정 |
| [adr/0002-reviewer-gates-advice.md](adr/0002-reviewer-gates-advice.md) | 리뷰어가 조언을 게이트하는 결정 |
| [adr/0004-pi-worker-reviewer.md](adr/0004-pi-worker-reviewer.md) | 워커와 리뷰어의 Pi 실행과 모델 구성 (**채택됨**) |
| [../harness/coordinator.md](../harness/coordinator.md) | 코디네이터 역할 지침 (실행 문서, `setup.mjs`가 실행 폴더의 `CLAUDE.md`로 복사) |
| [../harness/README.md](../harness/README.md) | 하네스 사용 설명 |
| [harness/advisor.md](harness/advisor.md) | 어드바이저 역할 지침 |
| [checks/](checks/) | 구현 task의 확인 결과와 실패 정리 |
| [pi-워커-리뷰어.md](pi-워커-리뷰어.md) | Pi 사용 결정의 근거와 시험 계획 |

## 빠진 것

- ADR 0003(오퍼레이터 하네스) 본문: 이 저장소에 없습니다. 문서 곳곳이 `adr/0003-operator-harness.md`를 가리키지만 그 파일은 없습니다. 오퍼레이터 설계는 `operator.md`가 있습니다.
- 설계 논의 기록 등 이력 문서(`history/`, 그 안의 `open-issues.md`): 이 저장소에 없습니다.

## 규칙

- 결정을 바꿀 때는 옛 ADR을 고치지 않고 새 ADR을 씁니다. 상태는 "제안됨", "채택됨", "대체됨"입니다.
- 문서 안의 `[보충]` 표시는 설계 논의의 답을 문서 형태로 풀어 쓴 표현이며 확인이 필요합니다.
- "임시(이슈 #2)" 표시는 2단계 구현이 소유자 결정 없이 시작값이나 임시값으로 둔 것입니다. 목록은 `checks/T6-T7-pi-scripts.md`의 "임시 결정"에 있습니다.
