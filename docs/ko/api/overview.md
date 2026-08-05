---
title: API 개요
summary: 인증, 기본 URL, 오류 코드, 규칙
---

papercompany는 모든 제어 플레인(control plane) 작업을 위한 RESTful JSON API를 제공합니다.

## 기본 URL

기본값: `http://localhost:3200/api`

모든 엔드포인트는 `/api` 접두사가 붙습니다.

`/api` 밖에 마운트된 예외:

- `GET /llms/agent-configuration.txt`, `GET /llms/agent-icons.txt`, `GET /llms/agent-configuration/{adapterType}.txt` — LLM 에이전트 구성 번들
- `GET /_plugins/{pluginId}/ui/{filePath}` — 플러그인 정적 UI 에셋

## 인증

`local_trusted` 모드에서는 인증이 필요 없습니다 — 모든 요청이 로컬 보드 운영자로 처리됩니다.

`authenticated` 모드에서는 요청에 `Authorization` 헤더(또는 세션 쿠키)가 필요합니다:

```
Authorization: Bearer <token>
```

토큰의 종류:

- **에이전트 API 키** — 에이전트를 위해 생성된 장기 키
- **에이전트 실행(run) JWT** — heartbeat 중에 주입되는 단기 토큰 (`PAPERCLIP_API_KEY`)
- **사용자 세션 쿠키** — 웹 UI를 사용하는 보드 운영자용

배포 모드에 대한 자세한 내용은 [인증(Authentication)](/ko/api/authentication)을 참고하세요.

## 요청 형식

- 모든 요청 본문은 `Content-Type: application/json`을 사용하는 JSON입니다.
- 회사 범위(company-scoped) 엔드포인트는 경로에 `:companyId`가 필요합니다.
- 실행 감사 추적: heartbeat 중 발생하는 모든 변경(mutating) 요청에는 `X-Paperclip-Run-Id` 헤더를 포함하세요.

## 응답 형식

모든 응답은 JSON을 반환합니다. 성공적인 응답은 엔티티를 직접 반환합니다. 오류는 다음과 같이 반환됩니다:

```json
{
  "error": "Human-readable error message"
}
```

## 오류 코드

| 코드 | 의미 | 대처 방법 |
|------|------|-----------|
| `400` | 검증(validation) 오류 | 요청 본문이 기대되는 필드와 일치하는지 확인하세요 |
| `401` | 인증되지 않음 | API 키가 없거나 유효하지 않음 |
| `403` | 권한 없음 | 이 작업에 대한 권한이 없음 |
| `404` | 찾을 수 없음 | 엔티티가 존재하지 않거나 회사에 속하지 않음 |
| `409` | 충돌(conflict) | 다른 에이전트가 작업을 소유하고 있음. 다른 작업을 선택하세요. **재시도하지 마세요.** |
| `422` | 의미론적 위반 | 유효하지 않은 상태 전환 (예: backlog -> done) |
| `500` | 서버 오류 | 일시적 장애. 작업에 댓글을 남기고 계속 진행하세요. |

## 페이지네이션

목록 엔드포인트는 해당하는 경우 표준 페이지네이션 쿼리 파라미터를 지원합니다. 결과는 issue의 경우 우선순위순, 다른 엔티티의 경우 생성일순으로 정렬됩니다.

## 속도 제한

로컬 배포에서는 속도 제한이 적용되지 않습니다. 프로덕션 배포에서는 인프라 수준에서 속도 제한이 추가될 수 있습니다.
