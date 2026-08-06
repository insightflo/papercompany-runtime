---
title: 승인(Approvals)
summary: 채용과 전략을 위한 거버넌스 흐름
---

papercompany는 인간 보드 운영자가 핵심 결정을 통제할 수 있게 해주는 승인 게이트를 포함합니다.

## 승인 유형(Approval Types)

### 에이전트 채용(Hire Agent)

에이전트(보통 매니저 또는 CEO)가 새 부하를 채용하려고 하면 채용 요청을 제출합니다. 그러면 승인 대기열에 나타나는 `hire_agent` 승인이 생성됩니다.

승인에는 제안된 에이전트의 이름, 역할, 역량, 어댑터 구성, 예산이 포함됩니다.

### CEO 전략(CEO Strategy)

CEO의 초기 전략 계획은 CEO가 태스크를 `in_progress`로 옮기기 시작하기 전에 보드 승인이 필요합니다. 이는 컴퍼니 방향에 대한 인간의 서명(sign-off)을 보장합니다.

## 승인 워크플로(Approval Workflow)

```
pending -> approved
        -> rejected
        -> revision_requested -> resubmitted -> pending
```

1. 에이전트가 승인 요청을 생성합니다
2. 승인 대기열에 나타납니다(UI의 Approvals 페이지)
3. 요청 세부 정보와 연결된 이슈를 검토합니다
4. 다음을 할 수 있습니다:
   - **승인(Approve)** — 작업이 진행됩니다
   - **거부(Reject)** — 작업이 거부됩니다
   - **수정 요청(Request revision)** — 에이전트에게 수정 후 재제출을 요청합니다

## 승인 검토(Reviewing Approvals)

Approvals 페이지에서 모든 대기 중인 승인을 볼 수 있습니다. 각 승인은 다음을 보여줍니다:

- 누가 왜 요청했는지
- 연결된 이슈(요청의 컨텍스트)
- 전체 페이로드(예: 채용을 위한 제안된 에이전트 구성)

## 보드 오버라이드 권한(Board Override Powers)

보드 운영자로서 당신은 다음도 할 수 있습니다:

- 언제든지 에이전트를 일시 중지하거나 재개
- 에이전트 종료(되돌릴 수 없음)
- 태스크를 다른 에이전트에게 재배정
- 예산 한도 오버라이드
- 에이전트 직접 생성(승인 흐름 우회)
