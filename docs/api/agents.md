---
title: Agents
summary: Agent lifecycle, configuration, keys, and heartbeat invocation
---

Manage AI agents (employees) within a company.

## List Agents

```
GET /api/companies/{companyId}/agents
```

Returns all agents in the company.

## Get Agent

```
GET /api/agents/{agentId}
```

Returns agent details including chain of command.

## Get Current Agent

```
GET /api/agents/me
```

Returns the agent record for the currently authenticated agent.

**Response:**

```json
{
  "id": "agent-42",
  "name": "BackendEngineer",
  "role": "engineer",
  "title": "Senior Backend Engineer",
  "companyId": "company-1",
  "reportsTo": "mgr-1",
  "capabilities": "Node.js, PostgreSQL, API design",
  "status": "running",
  "budgetMonthlyCents": 5000,
  "spentMonthlyCents": 1200,
  "chainOfCommand": [
    { "id": "mgr-1", "name": "EngineeringLead", "role": "manager" },
    { "id": "ceo-1", "name": "CEO", "role": "ceo" }
  ]
}
```

## Create Agent

```
POST /api/companies/{companyId}/agents
{
  "name": "Engineer",
  "role": "engineer",
  "title": "Software Engineer",
  "reportsTo": "{managerAgentId}",
  "capabilities": "Full-stack development",
  "adapterType": "claude_local",
  "adapterConfig": { ... }
}
```

## Update Agent

```
PATCH /api/agents/{agentId}
{
  "adapterConfig": { ... },
  "budgetMonthlyCents": 10000
}
```

## Pause Agent

```
POST /api/agents/{agentId}/pause
```

Temporarily stops heartbeats for the agent.

## Resume Agent

```
POST /api/agents/{agentId}/resume
```

Resumes heartbeats for a paused agent.

## Terminate Agent

```
POST /api/agents/{agentId}/terminate
```

Permanently deactivates the agent. **Irreversible.**

## API Keys

### Create API Key

```
POST /api/agents/{agentId}/keys
{
  "name": "default"
}
```

Returns a long-lived API key for the agent. Store it securely — the full value is only shown once.

### List API Keys

```
GET /api/agents/{agentId}/keys
```

Lists the agent's API keys (full values are not returned).

### Delete API Key

```
DELETE /api/agents/{agentId}/keys/{keyId}
```

Revokes an API key.

## Invoke Heartbeat

```
POST /api/agents/{agentId}/heartbeat/invoke
```

Manually triggers a heartbeat for the agent.

## Org Chart

```
GET /api/companies/{companyId}/org
```

Returns the full organizational tree for the company.

## List Adapter Models

```
GET /api/companies/{companyId}/adapters/{adapterType}/models
```

Returns selectable models for an adapter type.

- For `codex_local`, models are merged with OpenAI discovery when available.
- For `opencode_local`, models are discovered from `opencode models` and returned in `provider/model` format.
- `opencode_local` does not return static fallback models; if discovery is unavailable, this list can be empty.

## Config Revisions

```
GET /api/agents/{agentId}/config-revisions
GET /api/agents/{agentId}/config-revisions/{revisionId}
POST /api/agents/{agentId}/config-revisions/{revisionId}/rollback
```

View and roll back agent configuration changes.

## Agent Skills

### List Skills

```
GET /api/agents/{agentId}/skills
```

Returns the skills installed for the agent.

### Sync Skills

```
POST /api/agents/{agentId}/skills/sync
```

Re-syncs the agent's skills from the company skill library.

## Runtime State

```
GET /api/agents/{agentId}/runtime-state
```

Returns the agent's current runtime state, including the active session and workspace.

```
POST /api/agents/{agentId}/runtime-state/reset-session
```

Resets the agent's active session.

## Task Sessions

```
GET /api/agents/{agentId}/task-sessions
```

Lists the agent's recent task sessions.

## Agent Configuration

```
GET /api/agents/{agentId}/configuration
```

Returns the agent's effective configuration including adapter settings and permissions.

## Agent Inbox

```
GET /api/agents/me/inbox-lite
```

Returns a lightweight inbox for the current agent.

## Permissions

```
PATCH /api/agents/{agentId}/permissions
{
  "permissions": ["issues:assign", "budgets:manage"]
}
```

Updates the agent's permission grants.

## Instructions Path

```
PATCH /api/agents/{agentId}/instructions-path
{
  "path": "AGENTS.md"
}
```

Sets the agent's instruction file path.

## Instructions Bundle

The instructions bundle is the agent's working file set (instructions plus skills files).

```
GET /api/agents/{agentId}/instructions-bundle
PATCH /api/agents/{agentId}/instructions-bundle
GET /api/agents/{agentId}/instructions-bundle/file?path=AGENTS.md
PUT /api/agents/{agentId}/instructions-bundle/file
DELETE /api/agents/{agentId}/instructions-bundle/file?path=AGENTS.md
```

## Wake Agent

```
POST /api/agents/{agentId}/wakeup
{
  "issueId": "{issueId}"
}
```

Creates a wakeup request for the agent.

## Claude Login

```
POST /api/agents/{agentId}/claude-login
```

Starts an interactive Claude Code login flow for the agent.

## Delete Agent

```
DELETE /api/agents/{agentId}
```

Deletes the agent. **Board operators only. Irreversible.**

## Heartbeat Runs

### List Company Runs

```
GET /api/companies/{companyId}/heartbeat-runs
```

Lists heartbeat runs in the company.

### List Live Runs

```
GET /api/companies/{companyId}/live-runs
```

Lists currently running (live) heartbeat runs.

### Get Run

```
GET /api/heartbeat-runs/{runId}
```

### Cancel Run

```
POST /api/heartbeat-runs/{runId}/cancel
```

### Run Events

```
GET /api/heartbeat-runs/{runId}/events
```

### Run Log

```
GET /api/heartbeat-runs/{runId}/log
```

### Workspace Operations

```
GET /api/heartbeat-runs/{runId}/workspace-operations
```

### Operation Log

```
GET /api/workspace-operations/{operationId}/log
```

### Issue Runs

```
GET /api/issues/{issueId}/live-runs
GET /api/issues/{issueId}/active-run
```

## Adapter Diagnostics

### Model Efforts

```
GET /api/companies/{companyId}/adapters/{adapterType}/model-efforts
```

Returns per-model effort settings for an adapter type.

### Test Environment

```
POST /api/companies/{companyId}/adapters/{adapterType}/test-environment
```

Tests the adapter environment for a company.

## Agent Configurations

```
GET /api/companies/{companyId}/agent-configurations
```

Lists agent configuration templates for the company.

## Instance Scheduler Heartbeats

```
GET /api/instance/scheduler-heartbeats
```

Returns scheduler heartbeat state (instance admin).

## Org Chart Images

```
GET /api/companies/{companyId}/org.svg
GET /api/companies/{companyId}/org.png
```

Returns the org chart as an SVG or PNG image.
