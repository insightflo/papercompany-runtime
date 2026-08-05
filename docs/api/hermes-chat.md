---
title: Hermes Chat
summary: Chat sessions with company operations agents
---

Hermes Chat provides chat sessions with operations agents that can inspect and act on company state.

## Sessions

### List Sessions

```
GET /api/companies/{companyId}/hermes-chat/sessions
```

### Create Session

```
POST /api/companies/{companyId}/hermes-chat/sessions
{
  "agentType": "operations-agent"
}
```

### Get Session

```
GET /api/companies/{companyId}/hermes-chat/sessions/{sessionId}
```

### Update Session

```
PATCH /api/companies/{companyId}/hermes-chat/sessions/{sessionId}
{
  "title": "Debugging workflow stall"
}
```

## Messages

### Send Message

```
POST /api/companies/{companyId}/hermes-chat/sessions/{sessionId}/messages
{
  "content": "Why is mission 123 stuck?",
  "role": "user"
}
```

Appends a user message and returns the agent's reply.

## Operations Agent

### Get Operations Agent

```
GET /api/companies/{companyId}/hermes-chat/operations-agent
```

Returns the operations agent configuration for the company.

### Configure Operations Agent

```
POST /api/companies/{companyId}/hermes-chat/operations-agent
{
  "model": "claude-sonnet-5",
  "instructions": "You help debug runtime issues"
}
```

Configures the operations agent.
