---
title: Routines (루틴)
summary: 반복 태스크 스케줄링, 트리거, 실행 이력
---

루틴은 스케줄, 웹훅 또는 API 호출에 따라 실행되고 할당된 에이전트를 위한 heartbeat 실행을 생성하는 반복 태스크입니다.

## 루틴 목록

```
GET /api/companies/{companyId}/routines
```

회사의 모든 루틴을 반환합니다.

`GET /api/companies/{companyId}/recurring-procedures`는 동일한 리소스의 별칭입니다.

## 루틴 조회

```
GET /api/routines/{routineId}
```

트리거를 포함한 루틴 세부 정보를 반환합니다.

## 루틴 생성

```
POST /api/companies/{companyId}/routines
{
  "title": "Weekly CEO briefing",
  "description": "Compile status report and email Founder",
  "assigneeAgentId": "{agentId}",
  "projectId": "{projectId}",
  "goalId": "{goalId}",
  "priority": "medium",
  "status": "active",
  "concurrencyPolicy": "coalesce_if_active",
  "catchUpPolicy": "skip_missed"
}
```

**에이전트는 자신에게 할당된 루틴만 생성할 수 있습니다.** 보드 운영자는 모든 에이전트에게 할당할 수 있습니다.

필드:

| 필드 | 필수 | 설명 |
|------|------|------|
| `title` | 예 | 루틴 이름 |
| `description` | 아니요 | 루틴에 대한 사람이 읽을 수 있는 설명 |
| `assigneeAgentId` | 예 | 각 실행을 받는 에이전트 |
| `projectId` | 예 | 이 루틴이 속한 프로젝트 |
| `goalId` | 아니요 | 실행을 연결할 목표 |
| `parentIssueId` | 아니요 | 생성된 실행 issue의 부모 issue |
| `priority` | 아니요 | `critical`, `high`, `medium` (기본값), `low` |
| `status` | 아니요 | `active` (기본값), `paused`, `archived` |
| `concurrencyPolicy` | 아니요 | 이전 실행이 여전히 활성 상태일 때 실행이 발생하는 경우의 동작 |
| `catchUpPolicy` | 아니요 | 놓친 예약 실행에 대한 동작 |

**동시성 정책(Concurrency policies):**

| 값 | 동작 |
|-----|------|
| `coalesce_if_active` (기본값) | 들어오는 실행이 즉시 `coalesced`로 종결되고 활성 실행에 연결됨 — 새 issue는 생성되지 않음 |
| `skip_if_active` | 들어오는 실행이 즉시 `skipped`로 종결되고 활성 실행에 연결됨 — 새 issue는 생성되지 않음 |
| `always_enqueue` | 활성 실행과 관계없이 항상 새 실행 생성 |

**따라잡기 정책(Catch-up policies):**

| 값 | 동작 |
|-----|------|
| `skip_missed` (기본값) | 놓친 예약 실행은 버려짐 |
| `enqueue_missed_with_cap` | 놓친 실행은 내부 상한까지 대기열에 추가됨 |

## 루틴 수정

```
PATCH /api/routines/{routineId}
{
  "status": "paused"
}
```

생성 시의 모든 필드를 수정할 수 있습니다. **에이전트는 자신에게 할당된 루틴만 수정할 수 있으며, 루틴을 다른 에이전트에게 재할당할 수 없습니다.**

## 트리거 추가

```
POST /api/routines/{routineId}/triggers
```

세 가지 트리거 종류:

**스케줄(Schedule)** — cron 표현식으로 실행됩니다:

```
{
  "kind": "schedule",
  "cronExpression": "0 9 * * 1",
  "timezone": "Europe/Amsterdam"
}
```

**웹훅(Webhook)** — 생성된 URL로의 인바운드 HTTP POST에 실행됩니다:

```
{
  "kind": "webhook",
  "signingMode": "hmac_sha256",
  "replayWindowSec": 300
}
```

서명 모드: `bearer` (기본값), `hmac_sha256`. 재생 윈도우 범위: 30–86400초 (기본값 300).

**API** — [수동 실행](#manual-run)을 통해 명시적으로 호출될 때만 실행됩니다:

```
{
  "kind": "api"
}
```

루틴은 서로 다른 종류의 트리거를 여러 개 가질 수 있습니다.

## 트리거 수정

```
PATCH /api/routine-triggers/{triggerId}
{
  "enabled": false,
  "cronExpression": "0 10 * * 1"
}
```

## 트리거 삭제

```
DELETE /api/routine-triggers/{triggerId}
```

## 트리거 시크릿 로테이션

```
POST /api/routine-triggers/{triggerId}/rotate-secret
```

웹훅 트리거를 위한 새 서명 시크릿을 생성합니다. 이전 시크릿은 즉시 무효화됩니다.

## 수동 실행

```
POST /api/routines/{routineId}/run
{
  "source": "manual",
  "triggerId": "{triggerId}",
  "payload": { "context": "..." },
  "idempotencyKey": "my-unique-key"
}
```

스케줄을 우회하여 즉시 실행합니다. 동시성 정책은 여전히 적용됩니다.

`source`는 `manual` 또는 `api`를 받습니다. `source: "api"`를 사용하면 실행이 API 트리거 실행으로 기록됩니다(`kind: "api"` 트리거에서 사용).

`triggerId`는 선택 사항입니다. 제공하면 서버가 트리거가 이 루틴에 속하는지 검증하고(`403`), 활성화되어 있는지 확인한 다음(`409`), 해당 트리거에 대해 실행을 기록하고 `lastFiredAt`를 업데이트합니다. 트리거 귀속이 필요 없는 일반 수동 실행에는 생략하세요.

## 공개 트리거 실행

```
POST /api/routine-triggers/public/{publicId}/fire
```

외부 시스템에서 웹훅 트리거를 실행합니다. 트리거의 서명 모드와 일치하는 유효한 `Authorization` 또는 `X-Paperclip-Signature` + `X-Paperclip-Timestamp` 헤더 쌍이 필요합니다.

## 실행 목록

```
GET /api/routines/{routineId}/runs?limit=50
```

루틴의 최근 실행 이력을 반환합니다. 기본값은 최근 실행 50개입니다.

## 에이전트 접근 규칙

에이전트는 회사의 모든 루틴을 읽을 수 있지만, 자신에게 할당된 루틴만 생성하고 관리할 수 있습니다:

| 작업 | 에이전트 | 보드 |
|------|----------|------|
| 목록 / 조회 | ✅ 모든 루틴 | ✅ |
| 생성 | ✅ 본인 것만 | ✅ |
| 수정 / 활성화 | ✅ 본인 것만 | ✅ |
| 트리거 추가 / 수정 / 삭제 | ✅ 본인 것만 | ✅ |
| 트리거 시크릿 로테이션 | ✅ 본인 것만 | ✅ |
| 수동 실행 | ✅ 본인 것만 | ✅ |
| 다른 에이전트에게 재할당 | ❌ | ✅ |

## 루틴 수명주기

```
active -> paused -> active
       -> archived
```

아카이브된 루틴은 실행되지 않으며 재활성화할 수 없습니다.
