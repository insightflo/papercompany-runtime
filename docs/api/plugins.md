---
title: Plugins
summary: Plugin catalog, lifecycle, tools, bridge, jobs, and webhooks
---

The plugin system extends the control plane with installable modules. Plugins can contribute tools, UI, jobs, and webhooks.

## Plugin Catalog

### List Plugins

```
GET /api/plugins
```

Lists installed plugins.

### List Plugin Examples

```
GET /api/plugins/examples
```

Lists example plugins available for reference.

### UI Contributions

```
GET /api/plugins/ui-contributions
```

Lists UI components contributed by plugins.

### Get Plugin

```
GET /api/plugins/{pluginId}
```

Returns plugin details and manifest.

## Plugin Lifecycle

### Install Plugin

```
POST /api/plugins/install
{
  "source": "insightflo/research-workbench",
  "version": "1.2.0"
}
```

Installs a plugin from a registry source.

### Uninstall Plugin

```
DELETE /api/plugins/{pluginId}
```

Removes a plugin.

### Enable Plugin

```
POST /api/plugins/{pluginId}/enable
```

### Disable Plugin

```
POST /api/plugins/{pluginId}/disable
```

### Upgrade Plugin

```
POST /api/plugins/{pluginId}/upgrade
```

Upgrades the plugin to the latest version.

## Plugin Tools

### List Tools

```
GET /api/plugins/tools
```

Lists all tools contributed by plugins.

### Execute Tool

```
POST /api/plugins/tools/execute
{
  "tool": "insightflo.research-workbench:research-search",
  "arguments": { "query": "climate risks" },
  "runContext": {
    "agentId": "{agentId}",
    "runId": "{runId}",
    "companyId": "{companyId}"
  }
}
```

Executes a plugin tool. The `runContext` must contain a valid agent run context, otherwise the host returns `Agent run context is not valid for tool execution`.

## Bridge

### Send Data

```
POST /api/plugins/{pluginId}/bridge/data
{
  "channel": "events",
  "payload": { "type": "updated" }
}
```

### Send Action

```
POST /api/plugins/{pluginId}/bridge/action
{
  "action": "refresh",
  "payload": {}
}
```

### Stream Channel

```
GET /api/plugins/{pluginId}/bridge/stream/{channel}
```

Opens a server-sent event stream for a plugin channel.

### Plugin Data

```
POST /api/plugins/{pluginId}/data/{key}
{
  "value": {}
}
```

### Plugin Actions

```
POST /api/plugins/{pluginId}/actions/{key}
{
  "arguments": {}
}
```

## Jobs

### List Jobs

```
GET /api/plugins/{pluginId}/jobs
```

### List Job Runs

```
GET /api/plugins/{pluginId}/jobs/{jobId}/runs
```

### Trigger Job

```
POST /api/plugins/{pluginId}/jobs/{jobId}/trigger
{
  "input": {}
}
```

Triggers a job run.

## Webhooks

### Plugin Webhook

```
POST /api/plugins/{pluginId}/webhooks/{endpointKey}
```

Delivers an inbound webhook to a plugin endpoint.

## Dashboard

### Plugin Dashboard

```
GET /api/plugins/{pluginId}/dashboard
```

Returns dashboard data contributed by the plugin.

## Configuration

### Get Config

```
GET /api/plugins/{pluginId}/config
```

### Set Config

```
POST /api/plugins/{pluginId}/config
{
  "values": {}
}
```

### Test Config

```
POST /api/plugins/{pluginId}/config/test
{
  "values": {}
}
```

Tests plugin configuration without applying it.

## Diagnostics

### Plugin Health

```
GET /api/plugins/{pluginId}/health
```

### Plugin Logs

```
GET /api/plugins/{pluginId}/logs
```

## Static UI

### Plugin UI Files

```
GET /api/_plugins/{pluginId}/ui/{filePath}
```

Serves static UI assets contributed by a plugin.
