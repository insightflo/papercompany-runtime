---
title: Metrics & Health (메트릭 및 상태)
summary: 상태 점검과 운영 메트릭
---

상태 및 메트릭 엔드포인트는 `/api` 아래에 마운트되며 로드 밸런서와 운영자가 사용합니다.

## 상태 점검

```
GET /api/health
```

제어 플레인 상태를 반환합니다.

```
GET /api/health/
```

후행 슬래시가 있는 별칭.

## 메트릭

```
GET /api/metrics
```

Prometheus 텍스트 형식의 운영 메트릭을 반환합니다.

```
GET /api/metrics/json
```

동일한 메트릭을 JSON으로 반환합니다.

## 웹훅

### SRB 웹훅

```
POST /api/srb/webhook
```

SRB(정산) 통합을 위한 인바운드 웹훅.

## LLM 에이전트 구성

LLM 엔드포인트는 `/api` 아래가 아니라 **앱 수준**에 마운트됩니다:

```
GET /llms/agent-configuration.txt
GET /llms/agent-icons.txt
GET /llms/agent-configuration/{adapterType}.txt
```

LLM 도구링용 에이전트 구성 및 아이콘 번들을 반환합니다.
