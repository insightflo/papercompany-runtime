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
  "defaultStorageProvider": "local",
  "allowedHostnames": ["paperclip.example.com"]
}
```

Updates general instance settings.

## Experimental Settings

```
GET /api/instance/settings/experimental
```

Returns experimental feature flags for the instance.

```
PATCH /api/instance/settings/experimental
{
  "workflowNativeSchedulerEnabled": true
}
```

Updates experimental settings.
