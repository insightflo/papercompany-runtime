---
title: Company Skills
summary: Company-scoped agent skills, import, and project scanning
---

Companies can maintain their own skill libraries that agents use at runtime. Skills are versioned and synced to agent workspaces.

## List Skills

```
GET /api/companies/{companyId}/skills
```

Returns all skills defined in the company.

## Get Skill

```
GET /api/companies/{companyId}/skills/{skillId}
```

Returns a single skill including its metadata.

## Create Skill

```
POST /api/companies/{companyId}/skills
{
  "slug": "html-for-beginners",
  "name": "HTML for Beginners",
  "description": "Guidance for writing beginner-friendly HTML",
  "content": "# Skill content in markdown"
}
```

Creates a new local company skill.

## Update Status

```
GET /api/companies/{companyId}/skills/{skillId}/update-status
```

Returns the sync/update status of a skill.

## Skill Files

### List Files

```
GET /api/companies/{companyId}/skills/{skillId}/files
```

Returns the skill's file tree.

### Update File

```
PATCH /api/companies/{companyId}/skills/{skillId}/files
{
  "path": "SKILL.md",
  "content": "# Updated content"
}
```

Updates a single file within the skill.

## Install / Update

```
POST /api/companies/{companyId}/skills/{skillId}/install-update
```

Installs the skill or applies pending updates to agent workspaces.

## Import

```
POST /api/companies/{companyId}/skills/import
{
  "source": "insightflo/papercompany-operations/company-skills/html-for-beginners"
}
```

Imports a skill from a GitHub repository or a local path. Returns `imported`, `warnings`, and conflict details.

## Scan Projects

```
POST /api/companies/{companyId}/skills/scan-projects
{
  "projectIds": ["{projectId}"]
}
```

Scans project workspaces for skill files (e.g. `.agents/skills`, `SKILL.md`) and imports or updates them. Returns `discovered`, `imported`, `updated`, `conflicts`, and `warnings`.

## Delete Skill

```
DELETE /api/companies/{companyId}/skills/{skillId}
```

Deletes a skill.
