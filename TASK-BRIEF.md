# 과제: QA 반려 카드 충돌 안전성 + 검증 지적 4건 수정 (Astra 검증 후속)

## 배경과 최종 목표

독립 검증(gpt-6-astra)이 PR #329(QA 반려 카드 서버 템플릿, 이미 병합·배포, main c7a091cc)에서 구조적 허점을 찾았다. 사용자가 4건 수정을 승인했다. 이 과제로 그 4건을 해소한다.

**핵심 사실(조사 완료)**: `operator-decisions-write.ts`의 `loadReplay`는 같은 (companyId, requestKey) 행이 **어떤 상태든**(pending/resolved/cancelled) 존재하고 requestHash가 다르면 무조건 conflict를 던진다. 카드 문구는 requestHash에 포함되므로, 템플릿 문구가 배포로 바뀌면 **같은 generation의 재요청이 conflict**가 되고, loop-driver 경로는 conflict를 "카드 있음" 조건(created/replayed)으로 인정하지 않아 기존 재작업 경로로 흐를 수 있다. 취소된 행도 키를 점유하므로 "취소 후 재생성"으로는 해결 불가.

## 수정 설계 (승인된 방향)

### 1) 템플릿 버전을 요청 키에 포함 (핵심, 검증 지적 #2)

`server/src/services/workflow/qa-source-defect-owner-card.ts`:
- 신규 내보내기 `QA_SOURCE_DEFECT_CARD_TEMPLATE_VERSION = 2` (주석 필수: "카드 definition 문구가 바뀌면 이 값을 올린다 — 문구가 requestHash에 포함되어 같은 키 재요청 conflict를 막는 유일한 안전장치").
- `buildQaSourceDefectCardRequestKey` 형식 변경: `qa-source-defect:{run}:{producer}:{iteration}` → `qa-source-defect:v{TEMPLATE_VERSION}:{run}:{producer}:{iteration}`.
- 효과: 문구 변경 배포 후 같은 generation 재요청이 새 키로 create되고, 기존 supersede 로직(같은 run:producer의 다른 키 pending 카드 cancel)이 옛 버전 카드를 자동 취소한다 — "운영자는 항상 해당 조건의 최신 카드 1장" 설계 의도와 일치.
- 불변: supersede/승격/continuation/옵션 ID/문구 자체는 건드리지 않는다. loop-driver·supervision 호출부 수정 불필요(outcome 계약 불변).
- 영향 증명 의무(규칙 7): requestKey 포맷 소비자를 grep으로 재확인(기존 조사: 외부 소비자 없음, 테스트만)하고 계획 문서에 기록.

### 2) 회사 언어 조회 실패 폴백 (검증 지적 #1)

같은 파일 `ensureQaSourceDefectOwnerCard`: `loadCompanySystemLanguage` 호출을 try/catch로 감싸고, 실패 시 warn 로그(이 파일/서비스의 기존 로그 패턴 따름)와 함께 `"en"` 폴백으로 진행. 이유: 표시 언어 조회 실패가 카드 생성(실행 안전 경로)을 깨면 안 된다. 결정성 참고: 조회 실패+쓰기 성공 조합에서 이후 재시도와 hash가 어긋날 수 있는 극단적 잔여 위험은 문서에 기록(취소: 조회 실패 시 같은 DB 쓰기도 대개 실패).

### 3) 서로게이트 안전 잘림 (검증 지적 #3)

- 서버: 같은 파일의 모든 문자열 잘림(label 80, fact value 200, title 200, evidence description 1000, interpretation/description 4000)을 코드포인트 단위 안전 잘림 헬퍼(예: `Array.from(s).slice(0, n).join("")` 기반, 파일 로컬 함수)로 교체. 기존 잘림 한도 숫자는 유지(단위가 UTF-16 → 코드포인트로 바뀜).
- UI: `ui/src/components/OperatorDecisionFacts.tsx`의 미리보기(앞 120자)와 접기 임계값(200자) 비교도 코드포인트 기준으로. 관련 경계 테스트(200/201) 코드포인트 의미로 갱신 — 단정 약화 금지.
- 이 변경으로 카드 문구(잘림 결과)가 미세하게 변할 수 있음 → 1)의 버전 v2에 자연스럽게 포함(같은 PR에서 도입하므로 추가 bump 불필요).

### 4) 결과 문서 과단정 완화 (검증 지적 #4)

- `doc/plans/2026-10-04-operator-card-readability-results.md`: 부모 검증 부록의 "establish load-sensitive flakiness, not diff regressions" 류 단정을 "강하게 시사하며 CI가 권위 게이트" 수준으로 완화.
- `doc/plans/2026-10-05-qa-card-plain-language.md`(있으면)의 과단정 문장도 동일 완화.
- 이번 과제의 새 계획 문서: `doc/plans/2026-10-05-qa-card-conflict-safety.md` (양식은 기존 doc/plans 관례: 목표/불변/작업/증거/완료기준).

## 테스트 요구 (전부 신규 또는 갱신, 약화 금지)

1. **버전 키 회귀**: 옛 형식 키(`qa-source-defect:{run}:{producer}:{iteration}`)로 pending 카드가 있을 때 ensure 호출 → 옛 카드 cancel + 새 키 카드 created. 같은 generation 두 번째 ensure → replayed.
2. **언어 폴백**: 회사 조회가 실패하도록 주입 → 카드가 en 문구로 생성되고 outcome=created.
3. **코드포인트 경계**: 이모지(서로게이트 쌍) 포함 값이 잘림 지점에서 쪼개지 않는지(서버 헬퍼 + UI 컴포넌트).
4. 기존 qa-source-defect* 테스트의 requestKey 단정을 새 형식으로 갱신.
5. 기존 불변 단정(옵션 ID/outcome/findings 원문/replay)은 그대로 통과.

## 절대 원칙

- 실행 제어 불변: 옵션 ID, action outcome, continuation wiring, 승격 계산, supersede 검색 조건(sourceId like 절) 자체, loop-driver/supervision 호출부 — 수정 금지. requestKey 문자열 형식만 변경.
- `operator-decisions-write.ts`(공유 쓰기 서비스)는 건드리지 않는다 — 모든 변경은 qa-source-defect-owner-card.ts + UI 파일 + 테스트 + 문서.
- findings/QA 참조 원문 불변. 문구(이중화 문자열) 불변 — 이 과제는 문구를 바꾸지 않는다(잘림 경계 제외).
- 이 워크트리에서만 작업. 커밋은 논리 단위. 배포/PR 금지(부모가 검증 후 진행).

## 완료 기준

1. `pnpm -r typecheck` exit 0.
2. `pnpm build` exit 0.
3. 범위 테스트(qa-source-defect*, OperatorDecisionFacts 관련 UI 테스트) 전부 green, RED→GREEN 증거 포함.
4. `pnpm test:run` 실행: 이 diff와 무관한 실패는 기존 프로토콜(실패 파일 격리 재실행, 필요시 base 동일조건)으로 '기존/부하'임을 증명하고 목록 보고. 이 머신은 타 하네스 동시 실행으로 부하 플래키가 있으니 증거 중심으로.
5. 보고: ①계획 요약 ②실제 변경 ③추가 구현과 이유 ④암시적 영향(특히: 신규 카드 키 형식 변경, 언어 폴백 잔여 위험) ⑤미충족.
