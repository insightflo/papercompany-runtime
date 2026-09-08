# 워크플로 실행 입력

대상: 워크플로 정의 작성자와 운영자. 목적: 실행마다 받는 값을 선언하고, 저장·검증·화면의 차이를 이해한다.

`runInputs`로 텍스트, 단일 선택(radio), 복수 선택(checkbox), 켜기/끄기(switch)를 선언한다. 실행 화면은 이 선언으로 입력창을 만든다. 이 기능은 실행 입력 지원이며, 콘텐츠 제작 방식이나 운영 워크플로 변경을 포함하지 않는다.

## 선언 예시

승인된 콘텐츠 종류 선언:

```json
{"key":"section","label":"콘텐츠 종류","type":"radio","required":true,"options":[{"value":"manuals","label":"매뉴얼"},{"value":"concepts","label":"개념 설명"}],"default":"manuals"}
```

복수 선택과 스위치:

```json
[
  {"key":"tags","label":"태그","type":"checkbox","required":false,"options":[{"value":"a","label":"A"},{"value":"b","label":"B"}],"default":["a"]},
  {"key":"enabled","label":"활성화","type":"switch","default":true}
]
```

- 한 정의에 최대 5개를 선언한다. `key`는 중복 없이 영문·숫자·밑줄 1~40자다.
- `type`을 생략하면 기존 text 입력이다. text에는 `options`나 `default`를 추가할 수 없다.
- radio 값은 문자열, checkbox 값은 문자열 배열, switch 값은 boolean이다. 문자열 `"false"`는 boolean `false`가 아니다.
- 선택지 `value`는 빈 문자열과 중복을 허용하지 않는다. 기본값도 선언된 선택지와 정확히 일치해야 한다. checkbox 기본값에는 중복을 넣을 수 없다.
- `required`를 생략하면 필수다. 선택 입력은 `required:false`를 명시한다.
- 잘못된 정의는 정의 검증 오류다. 아래 실행값 오류(400)와 구분한다. 서버 도메인 선언 검증 오류는 기존 422 경계를 사용한다.

## 누락, 기본값, false, 빈 배열

서버는 키가 없거나 값이 `undefined`일 때만 선택형 기본값을 적용한다. JSON 요청에서는 `undefined` 대신 키를 생략한다.

| 전달값 | 처리 |
|---|---|
| 키 생략 + 기본값 있음 | 기본값 적용 후 검증 |
| 키 생략 + 선택 입력 + 기본값 없음 | 생략 상태 유지 |
| 키 생략 + 필수 선택형 + 기본값 없음 | 필수 오류 |
| switch `false` | 유효한 답변. 기본값 `true`로 덮어쓰지 않음 |
| checkbox `[]` | 명시적 빈 선택. 선택 입력이면 유효, 필수면 오류 |
| 선택형 `null` | 누락이 아닌 잘못된 형식 |

필수 radio도 유효한 기본값이 있으면 생략할 수 있다. 필수 switch는 `false`로도 충족한다. 필수 checkbox는 최소 한 항목이 필요하므로 선언상 허용되는 `default:[]`도 실행값 검증에서 거절된다. 서버는 값 형식을 강제로 바꾸거나 선택 문자열을 다듬지 않는다. 관련 없는 metadata 키는 보존한다.

## 기존 텍스트와 파생 입력

```json
[
  {"key":"url","label":"영상 URL","placeholder":"https://youtu.be/dQw4w9WgXcQ"},
  {"key":"videoId","label":"영상 ID","deriveFrom":{"input":"url","extract":"youtubeVideoId"}}
]
```

서버 처리 순서는 **선택형 기본값 → 기존 파생 처리 → 값 검증**이다. 파생은 선언 순서의 기존 단일 순회이며, 의존 순서 재정렬이나 새 순환 참조 금지 규칙을 추가하지 않는다. 원본 키는 같은 선언 목록에 있어야 한다. `deriveFrom`은 text에만 허용하며, 추출기는 `youtubeVideoId`다. 기존 youtu.be, watch, shorts 형식을 지원한다.

비어 있지 않은 명시적 파생 문자열은 추출 결과보다 우선한다. 필수 파생 실패는 `derivation_failed`, 선택 파생 실패는 해당 값을 생략한다. UI는 파생 필드를 편집칸 대신 안내로 표시하고 서버에 계산을 맡긴다.

일반 text 필수 검사는 서버의 기존 웹훅 경로에만 적용한다. 수동 API와 스케줄러에는 새 일반 text 필수 검사를 추가하지 않는다. 웹훅의 기존 존재 판정은 문자열이면 공백 제거 후 비어 있지 않아야 하고, 비문자열이면 null/undefined가 아니면 존재로 본다. 파생 실패 검사는 일반 text 존재 검사와 별개다.

UI는 기존 방식대로 text의 `placeholder`를 **초기 입력값**으로 채운다. 제출할 text는 앞뒤 공백을 제거하며, 선택 text가 비면 생략한다. UI는 필수 text가 비면 요청을 막는다. 서버는 placeholder를 기본값으로 저장하지 않는다. 따라서 UI 제출과 직접 API 호출의 text 동작을 혼동하지 않는다.

## 실행 화면과 저장

실행명 `runLabel`은 요청 최상위 필드이며 `metadata.runLabel`이 아니다. UI는 실행명 앞뒤 공백을 제거한다. 입력이 없는 정의도 실행명용 대화상자를 표시한다.

UI에서 기본값 없는 switch는 false, checkbox는 빈 선택으로 시작한다. 기본값 없는 선택 radio는 선택하지 않으면 생략한다. 필수 오류는 각 입력과 연결해서 보여 준다. 서버 400 이후에는 값을 유지하고 수정·재시도할 수 있다. 대기 중에는 중복 제출과 닫기를 막으며, 성공 이후 목록 새로고침이 실패해도 재시도 가능한 실행 폼을 다시 열지 않는다. 연결이 끊겨 서버 수락 여부를 모르는 경우까지 중복 실행 방지를 보장하는 기능은 아니다.

정의는 `workflow_definitions.run_inputs`, 실행값은 `workflow_runs.metadata`의 JSONB(형식을 보존하는 JSON 저장)에 남는다. `false`, `[]`, 문자열 배열은 그대로 저장한다. 템플릿은 기존 **문자열 치환**을 유지한다:

- `{$runMetadata.enabled}` → `"false"`
- `{$runMetadata.tags}` → `"[]"`
- `{$runMetadata.sections}` → `'["manuals","concepts"]'`

이는 도구 인자(toolArgs)에 원래 JSON 형식을 주입하는 기능이 아니다. 없는 키의 토큰은 미해결 문자열로 남는다.

## 실행값 오류 응답

```json
{
  "error":"Invalid workflow run input values",
  "details":{
    "version":1,
    "code":"invalid_workflow_run_inputs",
    "fieldErrors":[{"key":"section","code":"invalid_option","message":"'콘텐츠 종류' 항목 값이 선택 목록에 없습니다."}]
  }
}
```

수동·웹훅 HTTP 경계는 실행값 오류를 400으로 반환한다. 필드 코드는 `required`, `invalid_type`, `invalid_option`, `duplicate_value`, `derivation_failed`다. 클라이언트는 버전과 구조를 검증하고 `key`와 `code`로 필드를 구분한다. `message`는 표시용이며 실행·재시도·승인 판단을 위해 읽어 해석하지 않는다.

회사 귀속 확인 뒤, 도구 준비 검사·미션·실행·이슈 생성 전에 입력을 정규화한다. 거절된 입력은 이 실행 기록들을 만들거나 외부 wakeup을 요청하지 않는다. 웹훅은 기존 서명·접수·할당량 처리 순서를 유지하므로 입력 거절 전 접수 행이 남을 수 있지만 실행 번호는 연결되지 않는다. 완료된 접수 키의 재전송은 기존 실행 번호를 반환하며 새 본문 검증이나 추가 할당량 차감을 하지 않는다.

## 호환성과 운영 예외

- 실행 입력 선언을 만드는 편집 UI는 이번 범위에 없다. Flow inputs는 `legacyMetadata.graphFlowInputs`이며 `runInputs`와 다르다. 기존 정의 편집의 부분 수정은 `runInputs`를 보내지 않고 저장된 선언을 보존한다.
- 스케줄러는 실행 전 슬롯을 먼저 확보한다. 필수 선택형 오류가 나면 실행·미션 없이 실패 슬롯과 `lastScheduleError`가 남는다. 같은 시각을 다시 청구해도 기존 슬롯 처리 규칙을 따르며 자동 재시도를 새로 제공하지 않는다.
- 기존 플러그인의 `start-workflow` 전달에는 metadata가 없다. 엔진 기본값은 적용되지만, 플러그인 입력 전달 기능을 추가한 것은 아니다.
- PAQO 자동 생성 경로(`mission-owner-plan-decisions.ts`)는 `createWorkflowRun`을 직접 호출하는 예외다. 현재 runInputs를 선언하지 않는 이 경로를 변경하지 않았다. 모든 실행 생성이 `trigger`를 통과한다고 가정하지 않는다.
- 큐, 승인, 예산, 실행 상태 전이, QA 판정 권위는 이 기능의 변경 범위가 아니다.
- 온보딩 런타임 지원은 concepts 콘텐츠 형식 구현이 아니다. 향후 운영 정의 적용은 **manuals v2.4 유지**, **실제 html-for-beginners 회사 스킬 사용**, **publish/verify의 section 일치**를 별도로 승인받고 검증해야 한다. 이 문서는 운영 정의 수정이나 배포를 승인하지 않는다.

## 로컬 검증

저장소 루트에서 실행한다. DB 테스트는 실제 임시 embedded PostgreSQL을 사용하며, 외부 wakeup 경계만 대체한다. DB 지원 부족으로 건너뛰면 검증 완료가 아니다.

```sh
pnpm exec vitest run server/src/__tests__/workflow-run-input-trigger.integration.test.ts server/src/__tests__/workflow-run-input-scheduler.integration.test.ts --maxWorkers=1 --no-file-parallelism
pnpm exec vitest run server/src/__tests__/workflow-run-input-http.integration.test.ts server/src/__tests__/workflow-webhook.test.ts server/src/__tests__/workflow-webhook-admission.test.ts server/src/__tests__/workflow-webhook-signature.test.ts --maxWorkers=1 --no-file-parallelism
pnpm exec vitest run server/src/__tests__/workflow-run-input-templates.integration.test.ts server/src/__tests__/workflow-tool-step-args.test.ts server/src/__tests__/workflow-dag-engine.test.ts ui/src/pages/workflows/workflow-definition-run-input-preservation.test.ts ui/src/pages/workflows/workflow-definition-edit-patch.test.ts --maxWorkers=1 --no-file-parallelism
pnpm exec playwright test --config tests/workflow-run-inputs/playwright.config.ts --workers=1 --output test-results-workflow-run-inputs-new
```

브라우저 검증은 실제 UI 소스를 Vite `127.0.0.1:5279`에서 제공하고 API HTTP/WS를 테스트 응답으로 가로챈다. `reuseExistingServer:false`이며 운영 백엔드를 사용하지 않는다. 재실행할 때 `--output`은 기존 증거와 겹치지 않는 새 경로를 지정한다. 스크린샷도 각 테스트의 출력 경로를 따른다. 이 결과는 실제 운영 서버 실행이나 배포 확인을 대신하지 않는다.
