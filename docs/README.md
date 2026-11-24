# 문서 목록

| 파일 | 내용 |
|---|---|
| [00-definition.md](00-definition.md) | Terrarium 정의: 역할, 모델, 결과 흐름, 계획 |
| [01-overview.md](01-overview.md) | 코디네이터 전체 설계. 5장 기록과 컴팩션(5.2 중간 압축 규칙) 포함 |
| [coordinator.md](coordinator.md) | 코디네이터 설계 (역할 하나로 모은 것. 실행 문서 `harness/coordinator/AGENT.md`) |
| [advisor.md](advisor.md) | 어드바이저 설계 (실행 문서 `harness/advisor/AGENT.md`) |
| [operator.md](operator.md) | 오퍼레이터 설계 (ADR 0003 근거. 실행 문서 `harness/operator/AGENT.md`) |
| [worker.md](worker.md) | 워커 설계 (실행 문서 `harness/worker/AGENT.md`) |
| [reviewer.md](reviewer.md) | 리뷰어 설계 (규칙 문서 `harness/reviewer/AGENT.md`) |
| [app-screen.md](app-screen.md) | 데스크톱 앱의 관제탑 화면: 무엇을 읽어 그리는지, 이벤트 모양, 위쪽 칸, `/testgo`, 업데이트 알림, 시험 |
| [known-limitations.md](known-limitations.md) | 알려진 한계(보안, 플랫폼, Jev, 앱, 분리 실행, GitHub 흐름) |
| [adr/README.md](adr/README.md) | 결정 기록(ADR) 색인. 현재 유효한 ADR은 여기서 "채택됨"인 것(0001~0013, workflow) |
| [checks/owner-decisions.md](checks/owner-decisions.md) | 소유자 결정 목록(번호 8-x, 9-x). ADR과 함께 현재 기준 |
| [checks/](checks/) | 구현 task의 확인 결과, 실제 실행 기록(`runs.md`), 시나리오 점검표(`T13-scenarios.md`), 앱 작업 기록(`app-screen-replace.md`) |
| [releases/](releases/) | 버전별 릴리스 노트. 변경 요약은 루트의 [CHANGELOG](../CHANGELOG.md) |
| [pi-워커-리뷰어.md](pi-워커-리뷰어.md) | Pi 사용 결정의 근거와 시험 계획 |
| [../harness/coordinator/AGENT.md](../harness/coordinator/AGENT.md) | 코디네이터 역할 지침 (실행 문서, `setup.mjs`가 실행 폴더의 `CLAUDE.md`로 복사) |
| [../harness/README.md](../harness/README.md) | 하네스 사용 설명 |

## 빠진 것

- 설계 논의 기록 등 이력 문서(`history/`, 그 안의 `open-issues.md`): 이 저장소에 없습니다. 일부러 넣지 않았습니다(인터뷰·시험 기록).

## 규칙

- 결정을 바꿀 때는 옛 ADR을 고치지 않고 새 ADR을 씁니다. 상태는 "제안됨", "채택됨", "대체됨"입니다. 옛 ADR에는 맨 위에 어느 결정이 어디로 대체됐는지 한 줄만 답니다.
- 문서 안의 `[보충]` 표시는 설계 논의의 답을 문서 형태로 풀어 쓴 표현이며 확인이 필요합니다.
- "임시(이슈 #2)" 표시는 2단계 구현이 소유자 결정 없이 시작값이나 임시값으로 둔 것입니다. 목록은 `checks/T6-T7-pi-scripts.md`의 "임시 결정"에 있습니다.
