# AGENTS.md

Guidance for human and AI contributors working in this repository.

## 1. Purpose

Paperclip is a control plane for AI-agent companies.
The current implementation target is V1 and is defined in `doc/SPEC-implementation.md`.

## 2. Read This First

Before making changes, read in this order:

1. `doc/GOAL.md`
2. `doc/PRODUCT.md`
3. `doc/SPEC-implementation.md`
4. `doc/DEVELOPING.md`
5. `doc/DATABASE.md`

`doc/SPEC.md` is long-horizon product context.
`doc/SPEC-implementation.md` is the concrete V1 build contract.

## 3. Repo Map

- `server/`: Express REST API and orchestration services
- `ui/`: React + Vite board UI
- `packages/db/`: Drizzle schema, migrations, DB clients
- `packages/shared/`: shared types, constants, validators, API path constants
- `doc/`: operational and product docs

## 4. Dev Setup (Auto DB)

Use embedded PGlite in dev by leaving `DATABASE_URL` unset.

```sh
pnpm install
pnpm dev
```

This starts:

- API: `http://localhost:3100`
- UI: `http://localhost:3100` (served by API server in dev middleware mode)

Quick checks:

```sh
curl http://localhost:3100/api/health
curl http://localhost:3100/api/companies
```

Reset local dev DB:

```sh
rm -rf data/pglite
pnpm dev
```

## 5. Core Engineering Rules

1. Keep changes company-scoped.
Every domain entity should be scoped to a company and company boundaries must be enforced in routes/services.

2. Keep contracts synchronized.
If you change schema/API behavior, update all impacted layers:
- `packages/db` schema and exports
- `packages/shared` types/constants/validators
- `server` routes/services
- `ui` API clients and pages

3. Preserve control-plane invariants.
- Single-assignee task model
- Atomic issue checkout semantics
- Approval gates for governed actions
- Budget hard-stop auto-pause behavior
- Activity logging for mutating actions

4. Do not replace strategic docs wholesale unless asked.
Prefer additive updates. Keep `doc/SPEC.md` and `doc/SPEC-implementation.md` aligned.

5. Keep plan docs dated and centralized.
New plan documents belong in `doc/plans/` and should use `YYYY-MM-DD-slug.md` filenames.

6. Keep branch/worktree ownership explicit.
Before making code changes, inspect the current branch, `git status --short`, and existing worktrees. Do not start unrelated work in a dirty checkout. If existing changes are not part of the requested task, preserve them with a named stash or move the new task to a clean branch/worktree. One task purpose gets one branch/worktree; do not mix workflow, heartbeat, UI, docs, and cleanup changes in a leftover branch.

7. Do not modify execution-control code without impact proof.
For workflow, heartbeat, queue, issue status, mission planning, and PLAN-QA paths, identify the execution source of truth before editing. Queue/run semantics must be preserved: status fields are display/result state, not proof that execution was requested or performed. Check callers, tests, and a live or DB-facing proof surface before claiming the change is safe.

8. Keep implementation files under 300 lines.
During development, do not let a single source, test, or support file grow past 300 lines. Split cohesive helpers, components, fixtures, or focused tests into separate files before crossing the limit. If a legacy file already exceeds 300 lines, do not make it larger unless the change is a targeted reduction or an explicitly approved exception.
9. Never use agent-authored natural language as execution authority.
Comments, prose, Markdown, stdout, and stderr must never decide retry, branch, completion, reopen, wakeup, escalation, approval, QA verdict, artifact registration, or next workflow step. Parsing is allowed only for machine-produced, versioned, schema-validated contracts. Human-readable comments may be generated from structured records for display, but the runtime must never read them back as authority. Execution consumers (supervision, materialization, QA gates, recovery, verdict ledgers) must read only durable structured submissions/tables submitted through dedicated write APIs; legacy comment-derived ledger rows (non-null `sourceCommentId`) are display/audit only and must be ignored. When no structured authority exists, fail closed and use the existing bounded retry/re-dispatch path; do not add parser tolerance or keyword fallbacks.

## 6. Database Change Workflow

When changing data model:

1. Edit `packages/db/src/schema/*.ts`
2. Ensure new tables are exported from `packages/db/src/schema/index.ts`
3. Generate migration:

```sh
pnpm db:generate
```

4. Validate compile:

```sh
pnpm -r typecheck
```

Notes:
- `packages/db/drizzle.config.ts` reads compiled schema from `dist/schema/*.js`
- `pnpm db:generate` compiles `packages/db` first

## 7. Verification Before Hand-off

Run this full check before claiming done:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

If anything cannot be run, explicitly report what was not run and why.

## 8. API and Auth Expectations

- Base path: `/api`
- Board access is treated as full-control operator context
- Agent access uses bearer API keys (`agent_api_keys`), hashed at rest
- Agent keys must not access other companies

When adding endpoints:

- apply company access checks
- enforce actor permissions (board vs agent)
- write activity log entries for mutations
- return consistent HTTP errors (`400/401/403/404/409/422/500`)

## 9. UI Expectations

- Keep routes and nav aligned with available API surface
- Use company selection context for company-scoped pages
- Surface failures clearly; do not silently ignore API errors

## 10. Definition of Done

A change is done when all are true:

1. Behavior matches `doc/SPEC-implementation.md`
2. Typecheck, tests, and build pass
3. Contracts are synced across db/shared/server/ui
4. Docs updated when behavior or commands change
