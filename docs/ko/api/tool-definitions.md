---
title: Tool Definitions (도구 정의)
summary: 에이전트용 회사 맞춤 도구
---

회사는 에이전트가 호출할 수 있는 맞춤 도구를 정의할 수 있습니다. 도구는 회사 범위로 제한됩니다.

## 도구 목록

```
GET /api/companies/{companyId}/tools
```

회사에 정의된 모든 맞춤 도구를 반환합니다.

## 도구 생성

```
POST /api/companies/{companyId}/tools
{
  "name": "research-search",
  "description": "Search the research knowledge base",
  "schema": {
    "type": "object",
    "properties": {
      "query": { "type": "string" }
    }
  },
  "command": "research-search --query \"{{query}}\""
}
```

맞춤 도구를 생성합니다.

## 도구 수정

```
PATCH /api/companies/{companyId}/tools/{toolId}
{
  "description": "Updated description"
}
```

맞춤 도구를 수정합니다. 필드는 생성과 동일합니다.

## 도구 삭제

```
DELETE /api/companies/{companyId}/tools/{toolId}
```

맞춤 도구를 삭제합니다.

## 도구 테스트

```
POST /api/companies/{companyId}/tools/{toolId}/test
{
  "arguments": { "query": "climate risks" }
}
```

샘플 인자로 도구를 실행하고 검증을 위해 출력을 반환합니다.
