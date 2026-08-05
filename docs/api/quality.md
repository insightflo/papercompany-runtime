---
title: Quality
summary: Review items, evidence, evaluator versions, and daily reports
---

The quality subsystem evaluates agent work against evaluator versions, produces review items, and generates daily reports.

## Review Items

### List Review Items

```
GET /api/companies/{companyId}/quality/review-items
```

Lists quality review items for the company.

### Get Review Item

```
GET /api/quality/review-items/{reviewItemId}
```

### Create Review Item

```
POST /api/companies/{companyId}/quality/review-items
{
  "candidateRunId": "{runId}",
  "evaluatorVersionId": "{versionId}"
}
```

Creates a review item for a candidate run.

### Post Verdict

```
POST /api/quality/review-items/{reviewItemId}/verdict
{
  "verdict": "approved",
  "reasoning": "Meets the quality bar"
}
```

Records an evaluation verdict.

### Promote Anchor

```
POST /api/quality/review-items/{reviewItemId}/promote-anchor
```

Promotes the review item's candidate as an anchor example for future evaluations.

### Request Evidence

```
POST /api/quality/review-items/{reviewItemId}/request-evidence
{
  "reason": "Need more context"
}
```

Requests additional evidence from the work agent.

### Submit Evidence

```
POST /api/quality/review-items/{reviewItemId}/evidence
{
  "files": [{ "path": "logs.txt", "content": "..." }]
}
```

Submits evidence for a review item.

## Summary

```
GET /api/companies/{companyId}/quality/summary
```

Returns a quality summary for the company.

## Anchors

```
GET /api/companies/{companyId}/quality/anchors
```

Lists anchor examples used by the quality evaluator.

## Evaluator Versions

### List Evaluator Versions

```
GET /api/companies/{companyId}/quality/evaluator-versions
```

### Promote Evaluator Version

```
POST /api/companies/{companyId}/quality/evaluator-versions/{versionId}/promote
```

Promotes an evaluator version to active.

## Candidate Runs

### List Candidate Runs

```
GET /api/companies/{companyId}/quality/candidate-runs
```

Lists runs queued for quality evaluation.

### Replay Candidate Run

```
POST /api/companies/{companyId}/quality/candidate-runs/{runId}/replay
```

Replays a candidate run through the quality evaluator.

## Daily Reports

### Generate Daily Report

```
POST /api/companies/{companyId}/quality/daily-reports/generate
```

Generates today's quality report.

### List Daily Reports

```
GET /api/companies/{companyId}/quality/daily-reports
```

Lists previously generated daily reports.
