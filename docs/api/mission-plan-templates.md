---
title: Mission Plan Templates
summary: Reusable templates for mission plans
---

Mission plan templates define reusable structures for planning missions with evidence-gated execution slices.

## List Templates

```
GET /api/companies/{companyId}/mission-plan-templates
```

## Get Template

```
GET /api/companies/{companyId}/mission-plan-templates/{templateId}
```

## Create Template

```
POST /api/companies/{companyId}/mission-plan-templates
{
  "name": "Standard research mission",
  "description": "Default structure for research missions",
  "phases": []
}
```

## Update Template

```
PATCH /api/companies/{companyId}/mission-plan-templates/{templateId}
{
  "name": "Standard research mission v2"
}
```

## Duplicate Template

```
POST /api/companies/{companyId}/mission-plan-templates/{templateId}/duplicate
{
  "name": "Research mission (copy)"
}
```

Creates a copy of a template.

## Delete Template

```
DELETE /api/companies/{companyId}/mission-plan-templates/{templateId}
```
