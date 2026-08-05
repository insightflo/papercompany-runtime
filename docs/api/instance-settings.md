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

Updates experimental settings. Supported fields: `enableIsolatedWorkspaces`, `autoRestartDevServerWhenIdle`, `enableHeartbeatFinalizationV1`.
