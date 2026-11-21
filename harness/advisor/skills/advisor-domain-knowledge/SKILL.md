---
name: advisor-domain-knowledge
description: 지시가 웹 사이트·앱·게임 개발·보안·마케팅·디자인 분야의 판단을 요구할 때, 그 분야의 시니어 지식 파일만 골라 읽고 작업 단위와 "전제·위험"에 반영하는 순서. 작업을 나누기 전에 쓴다. 하위 에이전트 정의의 skills 칸으로 미리 주입되고, 지식 파일은 필요할 때 Read로 읽는다.
user-invocable: false
---

# 분야 지식

규칙 원문은 어드바이저 정의(규칙: "할 일") 2번과 6번이다. 지식 파일은 작업을 나누고 잘못된 전제·위험·빠진 고려를 짚을 때 쓰는 일반 원리다. 대상 프로젝트의 사실을 대신하지 않는다.

## 지식 파일

| 분야 | 파일 | 다루는 것 |
|---|---|---|
| 웹 사이트 | `{{RUN}}/.claude/skills/advisor-domain-knowledge/knowledge/web.md` | 렌더링·성능, 프런트엔드 구조, HTTP·캐시, API·데이터, 접근성, SEO, 배포·관측 |
| 앱 | `{{RUN}}/.claude/skills/advisor-domain-knowledge/knowledge/app.md` | 수명 주기·백그라운드, 오프라인·동기화, 네이티브·크로스플랫폼, 권한, 배포·심사, 크래시 |
| 게임 개발 | `{{RUN}}/.claude/skills/advisor-domain-knowledge/knowledge/game.md` | 게임 루프·프레임 시간, 렌더링, 물리, 엔티티 구조, 입력, 멀티플레이, 밸런스, 에셋 |
| 보안 | `{{RUN}}/.claude/skills/advisor-domain-knowledge/knowledge/security.md` | 위협 모델링, 인증·인가, 웹·API 취약점, 암호, 비밀값, 공급망, 인프라, 사고 대응 |
| 마케팅 | `{{RUN}}/.claude/skills/advisor-domain-knowledge/knowledge/marketing.md` | 포지셔닝, 퍼널·성장 루프, 채널, 측정·귀속, 실험과 통계, 리텐션, 가격, 메시지 |
| 디자인 | `{{RUN}}/.claude/skills/advisor-domain-knowledge/knowledge/design.md` | 사용자 조사, 정보 구조, 인터랙션, 시각 위계, 디자인 시스템, 접근성, 사용성 평가 |

## 순서

1. 대상 프로젝트를 먼저 읽는다(규칙 1번 그대로). 그다음 지시가 어느 분야의 판단에 닿는지 고른다.
2. 닿는 분야의 파일만 Read로 읽는다. 둘 이상이면 각각 읽고, 닿는 분야가 없으면 읽지 않는다. 모든 파일을 미리 읽지 않는다.
3. 지식과 대상 프로젝트(코드·문서·시험)가 어긋나면 프로젝트가 우선이다. 어긋난 점은 해당 단위의 "전제·위험"에 적는다.
4. 지식으로 짚은 잘못된 전제·위험·빠진 고려는 해당 단위의 "전제·위험"이나 "완료 기준"에 적는다. 지시에 없는 일을 새 단위로 더하지 않는다(규칙 2번).
5. 파일에 나온 제품 이름·버전·수치는 예시다. 제안문에 정답처럼 옮기지 않는다. 지금의 동작을 확인해야만 제안문을 쓸 수 있으면 자료 요청 한 줄로 돌려준다(규칙 6번).
6. 지식 파일을 고치거나 다른 곳에 옮겨 쓰지 않는다.
