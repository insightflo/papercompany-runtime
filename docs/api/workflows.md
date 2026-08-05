---
title: Workflows
summary: Workflow definitions, runs, step runs, and agent API endpoints
---

Workflows are DAG-based procedures that orchestrate agent work. A workflow run executes a workflow definition, creating step runs that map to issues and heartbeat runs.

## Workflow Definitions

### List Workflows

```
GET /api/companies/{companyId}/workflows
```

Returns all workflow definitions in the company.

### Get Workflow

```
GET /api/workflows/{workflowId}
```

Returns a single workflow definition.

### Create Workflow

```
POST /api/companies/{companyId}/workflows
{
  "name": "Weekly briefing",
  "description": "Compile status report",
  "steps": []
}
```

### Update Workflow

```
PATCH /api/workflows/{workflowId}
{
  "name": "Weekly briefing v2"
}
```

### Delete Workflow

```
DELETE /api/workflows/{workflowId}
```

Deletes the workflow definition.

### Workflow Overview

```
GET /api/companies/{companyId}/workflows/overview
```

Returns a summary of workflows and their recent run states.

## Workflow Tools

Workflows can reference tools from the company tool registry.

### List Tools

```
GET /api/companies/{companyId}/workflows/tools
```

Lists tools available to workflows.

### Grant Tools

```
POST /api/companies/{companyId}/workflows/tools/grants
{
  "toolIds": ["{toolId}"]
}
```

Grants workflow access to specific tools.

### Revoke Tools

```
DELETE /api/companies/{companyId}/workflows/tools/grants
```

Revokes tool grants.

### Sync From Tool Registry

```
POST /api/companies/{companyId}/workflows/tools/sync-from-tool-registry
```

Re-syncs workflow tools from the company tool registry.

### Enable QA Cap Acceptance

```
POST /api/companies/{companyId}/workflows/qa-cap-acceptance/enable
```

Enables QA capability acceptance for workflows.

## Workflow Runs

### List Runs

```
GET /api/companies/{companyId}/workflow-runs
```

Lists workflow runs in the company.

### List Runs for a Workflow

```
GET /api/workflows/{workflowId}/runs
```

### Create a Run

```
POST /api/workflows/{workflowId}/runs
{
  "runDate": "2026-08-05"
}
```

Starts a new run of the workflow.

### Get Run

```
GET /api/workflow-runs/{runId}
```

### Get Run Detail

```
GET /api/workflow-runs/{runId}/detail
```

Returns the full run detail including step runs, issues, and heartbeat runs.

### Resume a Run

```
POST /api/workflow-runs/{runId}/resume
```

Resumes a paused or stuck workflow run.

### Cancel a Run

```
POST /api/workflow-runs/{runId}/cancel
```

Cancels a workflow run.

## Step Runs

### Rerun a Step

```
POST /api/workflow-step-runs/{stepRunId}/rerun
```

Re-executes a single step run.

## Manual Completion

```
POST /api/issues/{issueId}/workflow/manual-complete
```

Manually marks the workflow step behind an issue as complete.

## Agent API

Agents report workflow outcomes through these endpoints during heartbeats.

### Post Artifacts

```
POST /api/issues/{issueId}/workflow/artifacts
{
  "files": [{ "path": "report.md", "content": "# Report" }]
}
```

### Post Verdict

```
POST /api/issues/{issueId}/workflow/verdict
{
  "verdict": "approve",
  "reasoning": "Evidence meets acceptance criteria"
}
```

### Post Mission Plan QA Verdict

```
POST /api/issues/{issueId}/mission-plan-qa/verdict
{
  "verdict": "approve",
  "reasoning": "Plan is sound"
}
```

### Post Mission Plan Decision

```
POST /api/issues/{issueId}/mission-plan-decision
{
  "decision": "proceed"
}
```

### Complete Workflow

```
POST /api/issues/{issueId}/workflow/complete
{
  "status": "completed",
  "summary": "All steps finished"
}
```

### Owner Recovery Decision

```
POST /api/issues/{issueId}/owner-recovery/decision
{
  "decision": "retry",
  "reasoning": "Transient failure"
}
```

Reports a mission owner's recovery decision for a stuck step.
