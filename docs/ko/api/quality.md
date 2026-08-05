---
title: Quality (품질)
summary: 리뷰 항목, 증거, 평가자 버전, 일일 보고서
---

품질 하위 시스템은 평가자 버전에 대해 에이전트 작업을 평가하고, 리뷰 항목을 생성하며, 일일 보고서를 생성합니다.

## 리뷰 항목

### 리뷰 항목 목록

```
GET /api/companies/{companyId}/quality/review-items
```

회사의 품질 리뷰 항목을 나열합니다.

### 리뷰 항목 조회

```
GET /api/quality/review-items/{reviewItemId}
```

### 리뷰 항목 생성

```
POST /api/companies/{companyId}/quality/review-items
{
  "title": "Evaluate Q3 research report",
  "targetType": "work_product",
  "triggerSource": "delivery_verification",
  "missionId": "{missionId}",
  "targetId": "{targetId}",
  "failureType": "evidence_gap",
  "priority": "high",
  "triggerMetadata": {},
  "evidenceRefs": []
}
```

리뷰 항목을 생성합니다. `title`, `targetType`, `triggerSource`는 필수입니다.

`targetType`은 `work_product`, `public_url`, `mission_output`, `other` 중 하나입니다.

`triggerSource`는 `delivery_verification`, `post_completion_audit`, `oversight_stall`, `plan_qa_failure`, `final_qa_failure`, `user_feedback`, `manual` 중 하나입니다.

### 평결 게시

```
POST /api/quality/review-items/{reviewItemId}/verdict
{
  "verdict": "pass",
  "reason": "Meets the quality bar"
}
```

평가 평결을 기록합니다. `verdict`는 `pass`, `fail`, `request_changes`, `needs_evidence`, `dismissed` 중 하나입니다.

### 앵커 승격

```
POST /api/quality/review-items/{reviewItemId}/promote-anchor
{
  "verdictId": "{verdictId}",
  "title": "Anchor example title"
}
```

리뷰 항목의 후보를 향후 평가를 위한 앵커 예시로 승격합니다. `verdictId`와 `title`은 필수입니다.

### 증거 요청

```
POST /api/quality/review-items/{reviewItemId}/request-evidence
{
  "requiredEvidenceSurfaces": ["transcript", "work_products"],
  "reason": "Need more context"
}
```

작업 에이전트에게 추가 증거를 요청합니다. `requiredEvidenceSurfaces`는 필수입니다.

### 증거 제출

```
POST /api/quality/review-items/{reviewItemId}/evidence
{
  "surface": "transcript",
  "status": "verified",
  "expected": { "format": "run transcript" },
  "actual": { "transcriptId": "run-123" },
  "sourceRunId": "{runId}",
  "sourceUrl": "https://...",
  "blocking": true
}
```

리뷰 항목에 대한 증거를 제출합니다. `surface`와 `status`는 필수입니다. `status`는 `missing`, `pending`, `verified`, `failed`, `insufficient`, `stale` 중 하나입니다.

## 요약

```
GET /api/companies/{companyId}/quality/summary
```

회사에 대한 품질 요약을 반환합니다.

## 앵커

```
GET /api/companies/{companyId}/quality/anchors
```

품질 평가자가 사용하는 앵커 예시를 나열합니다.

## 평가자 버전

### 평가자 버전 목록

```
GET /api/companies/{companyId}/quality/evaluator-versions
```

### 평가자 버전 승격

```
POST /api/companies/{companyId}/quality/evaluator-versions/{versionId}/promote
```

평가자 버전을 활성 상태로 승격합니다.

## 후보 실행

### 후보 실행 목록

```
GET /api/companies/{companyId}/quality/candidate-runs
```

품질 평가를 위해 대기열에 있는 실행을 나열합니다.

### 후보 실행 재생

```
POST /api/companies/{companyId}/quality/candidate-runs/{runId}/replay
```

품질 평가자를 통해 후보 실행을 다시 재생합니다.

## 일일 보고서

### 일일 보고서 생성

```
POST /api/companies/{companyId}/quality/daily-reports/generate
```

오늘의 품질 보고서를 생성합니다.

### 일일 보고서 목록

```
GET /api/companies/{companyId}/quality/daily-reports
```

이전에 생성된 일일 보고서를 나열합니다.
