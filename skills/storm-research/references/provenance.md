# 출처 규칙 + 정직성 계약 (papercompany STORM)

## 출처 강제 규칙

1. **모든 주장에 출처(URL)를 박는다.** 출처 없는 단언 금지.
2. **수치는 정확히.** 원 논문/보고서가 뭐라고 했는지 확인 후 인용. claim drift 금지.
3. **추측은 `[추론]` 라벨.** 출처 없는 추론과 출처 있는 인용을 구분.
4. **가짜 출처·가짜 수치 절대 금지.** URL이 존재하는지, 내용이 일치하는지 확인.

## STORM 방법론 출처

| 자원 | URL |
|---|---|
| 원논문 (Shao et al., NAACL 2024) | https://arxiv.org/abs/2402.14207 |
| 라이브 도구 | https://storm.genie.stanford.edu |
| 코드 (MIT) | https://github.com/stanford-oval/storm |

## 본 스킬의 정직성 계약

1. 이 스킬은 STORM의 **재해석**(cmux 없이 papercompany에서 구현)이지, 공식 STORM 도구가 아님.
2. LLM 다양성(cmux 분산 모드의 핵심)이 없으므로, **관점 charter 다양성**으로 품질을 보정.
3. 동료 검토(Report Validator)가 source bias transfer / over-association 점검 필수.
