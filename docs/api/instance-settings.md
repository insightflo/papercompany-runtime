---
title: Instance Settings
summary: General and experimental instance-wide settings
---

Instance settings are control-plane-wide configuration, managed by instance administrators.

## General Settings

```
GET /api/instance/settings/general
```

Returns general instance settings.

```
PATCH /api/instance/settings/general
{
  "censorUsernameInLogs": true
}
```

Updates general instance settings. The only supported field is `censorUsernameInLogs`.

## Experimental Settings

```
GET /api/instance/settings/experimental
```

Returns experimental feature flags for the instance.

```
PATCH /api/instance/settings/experimental
{
  "enableIsolatedWorkspaces": true,
  "autoRestartDevServerWhenIdle": false,
  "enableHeartbeatFinalizationV1": false
}
```

Updates experimental settings. Supported fields include `enableIsolatedWorkspaces`, `autoRestartDevServerWhenIdle`, `enableHeartbeatFinalizationV1`, and the broad-search allowlists below.

### Broad-search scope release

All three fields accept arrays of UUID strings and default to `[]`:

- `broadSearchAllowedCompanyIdsV1`: companies allowed to use broad search.
- `broadSearchAllowedMissionIdsV1`: missions allowed to use broad search.
- `broadSearchAllowedAgentIdsV1`: running agents allowed to use broad search.

Matching uses **OR** semantics: a matching company, mission, **or** running agent releases the applicable mission search restrictions. Empty or omitted lists grant no override; existing deny behavior remains unchanged. In PATCH requests, omitted fields retain their current values, and `[]` clears that list.

A match fully releases search-scope restrictions and broad scans, including PLAN, PLAN-QA, and no-card recovery paths where a search-permission object exists. It does not create a permission object where none exists, change company access boundaries, or grant unrelated execution authority.

Permissions already resolved in a run snapshot remain authoritative. Saving or clearing an allowlist affects subsequent permission resolution (new runs, or API fallback when no permission snapshot exists), not an already-resolved running snapshot.

```json
{
  "broadSearchAllowedCompanyIdsV1": ["11111111-1111-4111-8111-111111111111"],
  "broadSearchAllowedMissionIdsV1": [],
  "broadSearchAllowedAgentIdsV1": []
}
```
