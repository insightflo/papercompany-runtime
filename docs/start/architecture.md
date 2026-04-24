---
title: Architecture
summary: Stack overview, request flow, and how Paperclip coordinates work systems
---

Paperclip is a monorepo with four main layers. Product-wise, it is a control plane for company operations. Implementation-wise, V1 still centers much of that work around agents, issues, adapters, and workspaces.

## Stack Overview

```
┌─────────────────────────────────────┐
│  React UI (Vite)                    │
│  Dashboard, org management, work    │
├─────────────────────────────────────┤
│  Express.js REST API (Node.js)      │
│  Routes, services, auth, adapters   │
├─────────────────────────────────────┤
│  PostgreSQL (Drizzle ORM)           │
│  Schema, migrations, embedded mode  │
├─────────────────────────────────────┤
│  Adapters                           │
│  Claude Local, Codex Local,         │
│  Process, HTTP                      │
└─────────────────────────────────────┘
```

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, Vite 6, React Router 7, Radix UI, Tailwind CSS 4, TanStack Query |
| Backend | Node.js 20+, Express.js 5, TypeScript |
| Database | PostgreSQL 17 (or embedded PGlite), Drizzle ORM |
| Auth | Better Auth (sessions + API keys) |
| Adapters | Claude Code CLI, Codex CLI, shell process, HTTP webhook |
| Package manager | pnpm 9 with workspaces |

## Repository Structure

```
paperclip/
├── ui/                          # React frontend
│   ├── src/pages/              # Route pages
│   ├── src/components/         # React components
│   ├── src/api/                # API client
│   └── src/context/            # React context providers
│
├── server/                      # Express.js API
│   ├── src/routes/             # REST endpoints
│   ├── src/services/           # Business logic
│   ├── src/adapters/           # Agent execution adapters
│   └── src/middleware/         # Auth, logging
│
├── packages/
│   ├── db/                      # Drizzle schema + migrations
│   ├── shared/                  # API types, constants, validators
│   ├── adapter-utils/           # Adapter interfaces and helpers
│   └── adapters/
│       ├── claude-local/        # Claude Code adapter
│       └── codex-local/         # OpenAI Codex adapter
│
├── skills/                      # Agent skills
│   └── paperclip/               # Core Paperclip skill (heartbeat protocol)
│
├── cli/                         # CLI client
│   └── src/                     # Setup and control-plane commands
│
└── doc/                         # Internal documentation
```

## Request Flow

When a heartbeat fires:

1. **Trigger** — Scheduler, manual invoke, or event (assignment, mention) triggers a heartbeat
2. **Adapter invocation** — Server calls the configured adapter's `execute()` function
3. **Agent process** — Adapter spawns the agent (e.g. Claude Code CLI) with Paperclip env vars and a prompt
4. **Agent work** - The agent calls Paperclip's REST API to check assignments, checkout work items, do work, and update status
5. **Result capture** — Adapter captures stdout, parses usage/cost data, extracts session state
6. **Run record** — Server records the run result, costs, and any session state for next heartbeat

## Execution Model

Adapters are the bridge between Paperclip and agent runtimes. They are execution infrastructure, not the business identity of the product. Each adapter is a package with three modules:

- **Server module** — `execute()` function that spawns/calls the agent, plus environment diagnostics
- **UI module** — stdout parser for the run viewer, config form fields for agent creation
- **CLI module** — terminal formatter for `paperclipai run --watch`

Built-in adapters: `claude_local`, `codex_local`, `process`, `http`. You can create custom adapters for any runtime.

Paperclip also sits above the broader set of work systems where business work is actually completed. Those systems are not all represented as adapters today, but product-wise they matter just as much as the agent runtimes.

## Key Design Decisions

- **Control plane, not execution plane** — Paperclip orchestrates agents; it doesn't run them
- **Company-scoped** — all entities belong to exactly one company; strict data boundaries
- **Single-assignee work items** - atomic checkout prevents concurrent work on the same unit of work
- **Adapter-agnostic** — any runtime that can call an HTTP API works as an agent
- **Embedded by default** — zero-config local mode with embedded PostgreSQL
