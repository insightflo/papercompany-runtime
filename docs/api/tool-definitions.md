---
title: Tool Definitions
summary: Company custom tools for agents
---

Companies can define custom tools that agents can invoke. Tools are scoped to a company.

## List Tools

```
GET /api/companies/{companyId}/tools
```

Returns all custom tools defined in the company.

## Create Tool

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

Creates a custom tool.

## Update Tool

```
PATCH /api/companies/{companyId}/tools/{toolId}
{
  "description": "Updated description"
}
```

Updates a custom tool. Fields are the same as create.

## Delete Tool

```
DELETE /api/companies/{companyId}/tools/{toolId}
```

Deletes a custom tool.

## Test Tool

```
POST /api/companies/{companyId}/tools/{toolId}/test
{
  "arguments": { "query": "climate risks" }
}
```

Runs the tool with sample arguments and returns the output for validation.
