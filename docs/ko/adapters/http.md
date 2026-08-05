---
title: HTTP 어댑터
summary: HTTP webhook 어댑터
---

`http` 어댑터는 외부 에이전트 서비스로 webhook 요청을 보냅니다. 에이전트는 외부에서 실행되며 papercompany는 이를 트리거만 합니다.

## 사용 시기

- 에이전트가 외부 서비스로 실행될 때(클라우드 함수, 전용 서버)
- fire-and-forget 호출 모델
- 타사 에이전트 플랫폼과의 통합

## 사용하지 말아야 할 때

- 에이전트가 같은 머신에서 로컬로 실행될 때(`process`, `claude_local`, `codex_local` 사용)
- stdout 캡처와 실시간 런 뷰잉이 필요할 때

## 구성

| 필드 | 타입 | 필수 | 설명 |
|-------|------|----------|-------------|
| `url` | string | 예 | POST할 webhook URL |
| `headers` | object | 아니요 | 추가 HTTP 헤더 |
| `timeoutSec` | number | 아니요 | 요청 타임아웃 |

## 동작 방식

1. papercompany가 구성된 URL로 POST 요청을 보냅니다.
2. 요청 본문에는 실행 컨텍스트(에이전트 ID, 태스크 정보, wake 사유)가 포함됩니다.
3. 외부 에이전트가 요청을 처리하고 papercompany API로 콜백합니다.
4. webhook의 응답이 런 결과로 캡처됩니다.

## 요청 본문

webhook은 다음 JSON 페이로드를 받습니다:

```json
{
  "runId": "...",
  "agentId": "...",
  "companyId": "...",
  "context": {
    "taskId": "...",
    "wakeReason": "...",
    "commentId": "..."
  }
}
```

외부 에이전트는 `PAPERCLIP_API_URL`과 API 키를 사용해 Paperclip으로 콜백합니다.
