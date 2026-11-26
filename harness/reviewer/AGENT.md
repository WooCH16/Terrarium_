# 리뷰어 규칙

리뷰어는 **Jev**(TypeSafe System One 모델)다. Jev는 이 문서를 프롬프트로 읽는 에이전트가 아니다. 판정 질문 하나하나에 예/아니오 확률(Noul)만 돌려준다. 그래서 이 문서는 두 몫을 한다.

- **`## Jev 질문` 절은 실행 문서다.** `harness/operator/jev-review.mjs`가 이 절을 읽어 Jev에 보낼 질문을 만든다. 여기 문장을 고치면 판정 질문이 바뀐다. 질문 이름(`### met` 등)과 줄 머리(`- 묻는 말:`, `- 예:`, `- 아니오:`)는 바꾸지 않는다.
- **나머지 절은 규칙 설명이다.** 코드가 하는 일을 사람이 읽을 수 있게 적은 것이다. 바꾸려면 코드와 함께 바꾼다.

설계는 `docs/reviewer.md`, 결정은 ADR 0002, 0006, 0008에 있다.

## 하는 일

리뷰어는 두 곳에서 허용과 거부를 정한다. 둘 다 `node harness/operator/run-reviewer.mjs`로 부른다.

1. **결과 보고서 판정** (`--issue <n>`): 오퍼레이터가 이슈에 올린 가장 최근 `## 결과 보고서`. 판정은 이슈 댓글로 남는다. 허용 댓글의 `허용된 커밋:` 줄만 합치기 스크립트가 받는다.
2. **조언 판정** (`--advice <제안문> --advice-id <id>`): 어드바이저가 `reviewer-inbox/`에 쓴 제안문. 판정은 `advice-log.jsonl`에 남고, 허용된 제안문만 `handoffs/advice-<해시 앞 8자리>.md`로 옮겨져 코디네이터에게 간다. 같은 조언 id는 2번까지만 판정한다.

## 하지 않는 일

- 코드를 고치거나, 이슈를 만들거나, 완료 기준을 바꾸지 않는다.
- 판단이 서지 않으면 허용하지 않는다(애매하면 거부).
- Jev 호출이 실패하면 판정하지 않는다. 실패를 거부로 읽지 않는다(종료 코드 6).

## 코드가 먼저 보는 것

글을 읽지 않고 볼 수 있는 것은 코드가 본다. 하나라도 어긋나면 Jev를 부르지 않고 거부한다.

- **결과 보고서:** 첫 줄 `## 결과 보고서`, `커밋 해시:` 한 줄, 네 칸(기준별 충족 여부, 근거 위치, 변경 요약, 남은 문제), `| 기준 | 충족 | 근거 위치 |` 표에 이슈의 완료 기준이 그대로 있는지, 근거 위치에 적힌 파일이 보고서 커밋에 있는지.
- **제안문:** `## 작업 단위` 절마다 정해진 칸, `| 기준 | 확인 방법 |` 완료 기준 표, 표의 빈칸.

## 결정

- 완료 기준 한 줄마다 아래 질문 둘을 묻는다.
- 모든 질문이 예(설정 `jev.yes`, 0.7 이상)일 때만 허용한다.
- 아니오(`jev.no`, 0.3 이하)나 애매(그 사이)가 하나라도 있으면 거부다. 그 질문과 확률이 거부 이유가 된다.

## Jev 질문

`{기준}`과 `{확인 방법}`은 완료 기준 표의 그 줄 값으로 바뀐다.

### met

- 대상: 결과 보고서, 완료 기준 한 줄마다
- 묻는 말: Does `report` mark this completion criterion as met? Criterion: "{기준}"
- 예: The report lists this criterion and marks it as met (충족).
- 아니오: The report marks this criterion as not met (미충족), or does not list it.

### evidence

- 대상: 결과 보고서, 완료 기준 한 줄마다
- 묻는 말: Does `report` give a concrete evidence location for this completion criterion? Criterion: "{기준}"
- 예: For this criterion the report names a file and line, a test name, or a command with its result.
- 아니오: For this criterion the report gives no location, or only a general statement such as "done" or "checked".

### scope

- 대상: 결과 보고서, 완료 기준 한 줄마다. 허용·거부를 바꾸지 않는다. 거부 이유에 `[스스로 고침]`(예·애매) 또는 `[사용자 결정]`(아니오)을 붙이는 데만 쓴다(결정 8-44)
- 묻는 말: If this completion criterion is not met yet, could a worker meet it within the issue's own goal and criteria, without a decision the issue does not make? Criterion: "{기준}"
- 예: The fix is clear from the issue: a bug, a missing test, a missing file or evidence, or one obvious way to do it.
- 아니오: Meeting it needs the owner to decide: changing or widening the goal or criteria, or choosing between options the issue leaves open (the report's remaining problems or worker questions say so).

### decidable

- 대상: 제안문, 작업 단위의 완료 기준 한 줄마다
- 묻는 말: Could a reviewer decide, by looking at the finished work, whether this criterion is met or not? Criterion: "{기준}"
- 예: The criterion names an observable result, such as an output, a file, or a behavior that either happens or does not.
- 아니오: The criterion is vague or a matter of taste, such as "works well" or "is clean", so two reviewers could disagree.

### checkable

- 대상: 제안문, 작업 단위의 완료 기준 한 줄마다
- 묻는 말: Is this check something a person can actually run or look at? Check: "{확인 방법}"
- 예: The check is a test name, a command to run, or "사용자가 직접 보고 확인한다" (the user looks at it directly).
- 아니오: The check is missing, circular, or only says the work will be reviewed without saying how.
