---
title: Company Instructions
summary: Company-wide instruction files injected into agent workspaces
---

Companies can maintain instruction files (such as `AGENTS.md`) that are injected into agent workspaces at runtime.

## Get Instructions

```
GET /api/companies/{companyId}/instructions
```

Returns the company instruction manifest (list of files).

## Get Instruction File

```
GET /api/companies/{companyId}/instructions/file?path=AGENTS.md
```

Returns the content of a single instruction file.

## Write Instruction File

```
PUT /api/companies/{companyId}/instructions/file
{
  "path": "AGENTS.md",
  "content": "# Company instructions\n..."
}
```

Creates or updates a single instruction file. Returns the file path and size.

## Delete Instruction File

```
DELETE /api/companies/{companyId}/instructions/file?path=AGENTS.md
```

Deletes a single instruction file. The `path` query parameter is required.
