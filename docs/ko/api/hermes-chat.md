---
title: Hermes Chat
summary: 회사 운영 에이전트와의 채팅 세션
---

Hermes Chat은 회사 상태를 검사하고 조치를 취할 수 있는 운영 에이전트와의 채팅 세션을 제공합니다.

## 세션

### 세션 목록

```
GET /api/companies/{companyId}/hermes-chat/sessions
```

### 세션 생성

```
POST /api/companies/{companyId}/hermes-chat/sessions
{
  "agentType": "operations-agent"
}
```

### 세션 조회

```
GET /api/companies/{companyId}/hermes-chat/sessions/{sessionId}
```

### 세션 수정

```
PATCH /api/companies/{companyId}/hermes-chat/sessions/{sessionId}
{
  "title": "Debugging workflow stall"
}
```

## 메시지

### 메시지 전송

```
POST /api/companies/{companyId}/hermes-chat/sessions/{sessionId}/messages
{
  "content": "Why is mission 123 stuck?",
  "role": "user"
}
```

사용자 메시지를 추가하고 에이전트의 답변을 반환합니다.

## 운영 에이전트

### 운영 에이전트 조회

```
GET /api/companies/{companyId}/hermes-chat/operations-agent
```

회사의 운영 에이전트 구성을 반환합니다.

### 운영 에이전트 구성

```
POST /api/companies/{companyId}/hermes-chat/operations-agent
{
  "model": "claude-sonnet-5",
  "instructions": "You help debug runtime issues"
}
```

운영 에이전트를 구성합니다.
