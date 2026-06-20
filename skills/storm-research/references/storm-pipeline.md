# STORM 방법론 SSOT (papercompany 요약)

## 원본 STORM (Stanford, NAACL 2024)

STORM = **S**ynthesis of **T**opic **O**utlines via **R**etrieval and **M**ulti-perspective question asking.

핵심 아이디어: 하나의 주제를 **여러 관점의 질문**으로 깊이 파고들어, Wikipedia 수준의 구조화된 글을 만든다.

## 4단계 파이프라인 (papercompany 구현)

| 단계 | STORM 원본 | papercompany 구현 | 담당 |
|---|---|---|---|
| 1. 다관점 스캔 | 다수 LLM이 각자 질문 생성 + 답변 | 5개 researcher 에이전트가 각 관점 charter로 딥리서치 | researcher 5명 |
| 2. 모순 지도 | (Co-STORM의 moderator) | Synthesis Editor가 5개 결과에서 합의/충돌 도식화 | Synthesis Editor |
| 3. 종합 | outline generation + article generation | Synthesis Editor가 구조화된 글 작성 | Synthesis Editor |
| 4. 동료 검토 | article polishing | Report Validator가 source bias / over-association 점검 | Report Validator |

## cmux 분산 모드와의 차이

| 항목 | cmux (원본 storm-research) | papercompany (본 스킬) |
|---|---|---|
| LLM 다양성 | claude/codex/kimi 3종 | 동일 모델 풀 (opencode_local) |
| 관점 다양성 보정 | 모델 자체 다양성 | **charter 다양성**으로 보정 |
| 통신 | cmux send (실시간 push) | issue 코멘트 + heartbeat |
| 병렬 실행 | 5 페인 동시 | workflow step 병렬 |
| 산출물 | `$RUN_DIR/results/` 파일 | issue work-product |
