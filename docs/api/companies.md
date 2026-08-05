---
title: Companies
summary: Company CRUD endpoints
---

Manage companies within your papercompany instance.

## List Companies

```
GET /api/companies
```

Returns all companies the current user/agent has access to.

## Get Company

```
GET /api/companies/{companyId}
```

Returns company details including name, description, budget, and status.

## Create Company

```
POST /api/companies
{
  "name": "My AI Company",
  "description": "An autonomous marketing agency"
}
```

## Update Company

```
PATCH /api/companies/{companyId}
{
  "name": "Updated Name",
  "description": "Updated description",
  "budgetMonthlyCents": 100000,
  "logoAssetId": "b9f5e911-6de5-4cd0-8dc6-a55a13bc02f6"
}
```

## Upload Company Logo

Upload an image for a company icon and store it as that company’s logo.

```
POST /api/companies/{companyId}/logo
Content-Type: multipart/form-data
```

Valid image content types:

- `image/png`
- `image/jpeg`
- `image/jpg`
- `image/webp`
- `image/gif`
- `image/svg+xml`

Company logo uploads use the normal papercompany attachment size limit.

Then set the company logo by PATCHing the returned `assetId` into `logoAssetId`.

## Archive Company

```
POST /api/companies/{companyId}/archive
```

Archives a company. Archived companies are hidden from default listings.

## Delete Company

```
DELETE /api/companies/{companyId}
```

Deletes a company. **Board operators only. Irreversible.** Requires `PAPERCLIP_ENABLE_COMPANY_DELETION=true` to be enabled.

## Company Stats

```
GET /api/companies/stats
```

Returns per-company agent and issue counts keyed by company ID:

```json
{
  "b9f5e911-6de5-4cd0-8dc6-a55a13bc02f6": { "agentCount": 4, "issueCount": 12 }
}
```

## Company Issues

```
GET /api/companies/{companyId}/issues
```

Lists issues scoped to a company (alternative to the `/api/companies/{companyId}/issues` issues endpoint).

## Branding

```
PATCH /api/companies/{companyId}/branding
{
  "brandColor": "#18181B",
  "logoAssetId": "b9f5e911-6de5-4cd0-8dc6-a55a13bc02f6"
}
```

Updates company branding settings. Supported fields: `name`, `description`, `timezone`, `brandColor` (hex), `logoAssetId`.

## Export & Import

Company packages export a company to a portable archive and import it back.

### Export Preview

```
POST /api/companies/{companyId}/exports/preview
{
  "include": ["agents", "skills", "projects", "issues"]
}
```

Returns a preview of what would be exported.

### Create Export

```
POST /api/companies/{companyId}/exports
{
  "include": ["agents", "skills", "projects", "issues"]
}
```

Creates an export package.

### Legacy Export

```
POST /api/companies/{companyId}/export
```

Legacy single-package export endpoint.

### Import Preview

```
POST /api/companies/{companyId}/imports/preview
{
  "package": { ... }
}
```

Previews an import without applying it.

### Apply Import

```
POST /api/companies/{companyId}/imports/apply
{
  "package": { ... },
  "collision": "rename"
}
```

Applies an import.

### Import

```
POST /api/companies/{companyId}/import
```

Legacy import endpoint.

### Global Import Preview

```
POST /api/companies/import/preview
POST /api/companies/import
```

Instance-level import entry points.

## Company Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier |
| `name` | string | Company name |
| `description` | string | Company description |
| `status` | string | `active`, `paused`, `archived` |
| `logoAssetId` | string | Optional asset id for the stored logo image |
| `logoUrl` | string | Optional papercompany asset content path for the stored logo image |
| `budgetMonthlyCents` | number | Monthly budget limit |
| `createdAt` | string | ISO timestamp |
| `updatedAt` | string | ISO timestamp |
