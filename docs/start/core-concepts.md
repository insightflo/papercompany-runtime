---
title: Core Concepts
summary: Companies, teams, work items, work systems, and governance
---

Paperclip organizes company operations around a few key concepts. The current V1 implementation still uses terms like issues, adapters, and workspaces, but the product model is broader than a coding workflow.

## Company

A company is the top-level unit of organization. Each company has:

- A **mission and goals** - the reason it exists and the outcomes it is trying to achieve
- **Teams and workers** - agents organized with roles and reporting lines
- **Budgets and governance** - policies, approvals, and spend limits
- **Work items** - the units of action that move the company forward
- **Work systems** - the systems where work is actually completed and recorded

One Paperclip instance can run multiple companies.

## Teams and Agents

Paperclip models workers primarily as agents today, but the product language is closer to agent teams than isolated bots. Each agent has:

- **Execution configuration** - how the agent runs and what systems it can use
- **Role and reporting** - title, who they report to, who they support
- **Capabilities** - what kind of work they are good at
- **Budget** - per-agent monthly spend limit
- **Status** - active, idle, running, error, paused, or terminated

Agents are organized in a strict tree hierarchy. Every agent reports to exactly one manager (except the CEO). This is the current V1 expression of team structure.

## Work Items

Work items are the atomic units of action in the company. In V1, they are represented primarily as issues. Every work item has:

- A title, description, status, and priority
- An assignee (one agent at a time)
- A parent relationship so work can be traced upward
- Goal, mission, or work context depending on the current V1 surface

### Status Lifecycle

```
backlog -> todo -> in_progress -> in_review -> done
                       |
                    blocked
```

Terminal states: `done`, `cancelled`.

The transition to `in_progress` requires an **atomic checkout** - only one agent can own a work item at a time. If two agents try to claim the same one simultaneously, one gets a `409 Conflict`.

## Work Systems

Work systems are the regulated systems where work is completed and recorded.
They enforce shared formats, required fields, state transitions, and durable business records.

Examples can include ERP, CRM, ticketing, back-office, document, submission, or engineering systems.
Paperclip does not replace these systems. It coordinates work across them.

## Heartbeats

Agents don't run continuously. They wake up in **heartbeats** — short execution windows triggered by Paperclip.

A heartbeat can be triggered by:

- **Schedule** — periodic timer (e.g. every hour)
- **Assignment** - a new work item is assigned to the agent
- **Comment** — someone @-mentions the agent
- **Manual** — a human clicks "Invoke" in the UI
- **Approval resolution** — a pending approval is approved or rejected

Each heartbeat, the agent checks context, reviews assignments, picks work, checks out a work item, does the work, and updates status. This is the **heartbeat protocol**.

## Governance

Some actions require board (human) approval:

- **Hiring agents** — agents can request to hire subordinates, but the board must approve
- **CEO strategy** — the CEO's initial strategic plan requires board approval
- **Board overrides** - the board can pause, resume, or terminate any agent and reassign any work item

The board operator has full visibility and control through the web UI. Every mutation is logged in an **activity audit trail**. Over time, this governance layer should expand beyond work-item control into verification, exception handling, and outcome visibility.
