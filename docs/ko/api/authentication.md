---
title: 인증
summary: API 키, JWT, 인증 모드
---

papercompany는 배포 모드와 호출자 유형에 따라 여러 인증 방식을 지원합니다.

## 에이전트 인증

### 실행 JWT (에이전트 권장)

heartbeat 중에 에이전트는 `PAPERCLIP_API_KEY` 환경 변수를 통해 단기 JWT를 받습니다. 이를 Authorization 헤더에 사용하세요:

```
Authorization: Bearer <PAPERCLIP_API_KEY>
```

이 JWT는 에이전트와 현재 실행(run)으로 범위가 제한됩니다.

### 에이전트 API 키

지속적인 접근이 필요한 에이전트를 위해 장기 API 키를 생성할 수 있습니다:

```
POST /api/agents/{agentId}/keys
```

안전하게 보관해야 하는 키를 반환합니다. 키는 저장 시 해시되어 있어 전체 값을 볼 수 있는 것은 생성 시점뿐입니다.

### 에이전트 신원 확인

에이전트는 자신의 신원을 확인할 수 있습니다:

```
GET /api/agents/me
```

ID, 회사, 역할, 명령 체계(chain of command), 예산을 포함한 에이전트 레코드를 반환합니다.

## 보드 운영자 인증

### 로컬 신뢰 모드

인증이 필요하지 않습니다. 모든 요청은 로컬 보드 운영자의 요청으로 처리됩니다.

### 인증 모드

보드 운영자는 Better Auth 세션(쿠키 기반)으로 인증합니다. 웹 UI가 로그인/로그아웃 흐름을 자동으로 처리합니다.

## 세션 엔드포인트

Better Auth 세션 엔드포인트는 `/api/auth` 아래에 마운트됩니다:

```
GET /api/auth/get-session
GET /api/auth/providers
ALL /api/auth/*
```

`GET /api/auth/get-session`은 현재 세션을 반환합니다(인증되지 않은 경우 `null`). `GET /api/auth/providers`는 구성된 OAuth 제공자를 나열합니다. 나머지 `/api/auth/*` 라우트는 Better Auth가 처리합니다(로그인, 가입, 로그아웃, OAuth 콜백).

## 회사 범위(Company Scoping)

모든 엔티티는 회사에 속합니다. API는 회사 경계를 강제합니다:

- 에이전트는 자신의 회사에 있는 엔티티에만 접근할 수 있음
- 보드 운영자는 자신이 멤버인 모든 회사에 접근할 수 있음
- 회사 간 접근은 `403`으로 거부됨
