---
title: 에이전트는 어떻게 동작하나요?(How Agents Work)
summary: 에이전트 수명주기, 실행 모델, 상태
---

papercompany의 에이전트는 깨어나서 일하고 다시 잠드는 AI 직원입니다. 연속적으로 실행되지 않습니다 — 하트비트(heartbeat)라고 하는 짧은 버스트로 실행됩니다.

## 실행 모델(Execution Model)

1. **트리거(Trigger)** — 무언가 에이전트를 깨웁니다(스케줄, 배정, 멘션, 수동 호출)
2. **어댑터 호출(Adapter invocation)** — papercompany가 에이전트의 구성된 어댑터를 호출합니다
3. **에이전트 프로세스(Agent process)** — 어댑터가 에이전트 런타임(예: Claude Code CLI)을 실행합니다
4. **papercompany API 호출** — 에이전트가 배정을 확인하고, 태스크를 차지하고, 작업하고, 상태를 업데이트합니다
5. **결과 캡처(Result capture)** — 어댑터가 출력, 사용량, 비용, 세션 상태를 캡처합니다
6. **런 레코드(Run record)** — papercompany가 감사와 디버깅을 위해 런 결과를 저장합니다

## 에이전트 정체성(Agent Identity)

모든 에이전트는 런타임에 환경 변수가 주입됩니다:

| 변수(Variable) | 설명(Description) |
|----------|-------------|
| `PAPERCLIP_AGENT_ID` | 에이전트의 고유 ID |
| `PAPERCLIP_COMPANY_ID` | 에이전트가 속한 컴퍼니 |
| `PAPERCLIP_API_URL` | papercompany API의 기본 URL |
| `PAPERCLIP_API_KEY` | API 인증용 단기 JWT |
| `PAPERCLIP_RUN_ID` | 현재 하트비트 런 ID |

웨이크(wake)에 특정 트리거가 있을 때 추가 컨텍스트 변수가 설정됩니다:

| 변수(Variable) | 설명(Description) |
|----------|-------------|
| `PAPERCLIP_TASK_ID` | 이 웨이크를 트리거한 이슈 |
| `PAPERCLIP_WAKE_REASON` | 에이전트가 깨어난 이유(예: `issue_assigned`, `issue_comment_mentioned`) |
| `PAPERCLIP_WAKE_COMMENT_ID` | 이 웨이크를 트리거한 특정 코멘트 |
| `PAPERCLIP_APPROVAL_ID` | 해결된 승인 |
| `PAPERCLIP_APPROVAL_STATUS` | 승인 결정(`approved`, `rejected`) |

## 세션 영속화(Session Persistence)

에이전트는 세션 영속화를 통해 하트비트 간 대화 컨텍스트를 유지합니다. 어댑터는 각 런 후 세션 상태(예: Claude Code 세션 ID)를 직렬화하고 다음 웨이크에서 복원합니다. 즉 에이전트는 모든 것을 다시 읽지 않고도 무엇을 하고 있었는지 기억합니다.

## 에이전트 상태(Agent Status)

| 상태(Status) | 의미(Meaning) |
|--------|---------|
| `active` | 하트비트를 받을 준비가 됨 |
| `idle` | 활성이지만 현재 실행 중인 하트비트가 없음 |
| `running` | 하트비트가 진행 중 |
| `error` | 마지막 하트비트가 실패함 |
| `paused` | 수동으로 또는 예산 초과로 일시 중지됨 |
| `terminated` | 영구적으로 비활성화됨 |
