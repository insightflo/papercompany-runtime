# papercompany Architecture Implementation Plan

**Status**: Draft
**Date**: 2026-03-31
**Scope**: Full system design for the papercompany product based on interview decisions

---

## 1. Executive Summary

papercompany is a purpose-built autonomous agent operating platform derived from paperclip. Where paperclip is a general-purpose framework for running AI agents on issues, papercompany is an opinionated product that integrates five core capabilities — workflow orchestration, tool management, knowledge retrieval, execution governance, and scheduling — directly into the server runtime rather than treating them as optional plugins.

The key differences from paperclip:

| Dimension | paperclip | papercompany |
|---|---|---|
| Core capabilities | Plugin-based (optional install) | Natively integrated into server/src/services/ |
| Human interaction | Platform UI accounts | Channel-only (Telegram v1) |
| Unit of work | Issue | Mission (hierarchical: Mission -> Issues) |
| Session model | Per-run session | Mission-scoped persistent session |
| Governance | None | Worktree harness (MUST / SHOULD / MAY) |
| Company structure | Single-tier | Two-tier (business companies + maintenance company) |
| Scheduler | Heartbeat timer loop | Cron-based wakeup (ops-monitor pattern) |
| SRB | Cross-company plugin bridge | Same-instance + HTTP webhook cross-server |
| pi-local adapter | Included | Removed |
| Deployment | Docker / self-hosted | Self-hosted, git clone + pnpm install |

papercompany is a fresh start — no migration from existing paperclip data is required.

---

## 2. Architecture Overview

```
                          ┌─────────────────────────────────────────────────────┐
                          │                  papercompany server                 │
                          │                                                       │
  Telegram Bot            │  ┌─────────────┐    ┌──────────────────────────┐    │
  (channel-only UI) ──────┼──► channel/     │    │  Mission Layer           │    │
                          │  │  telegram.ts │    │  missions.ts             │    │
                          │  └──────┬───────┘    │  (Mission → Issues tree) │    │
                          │         │             └──────────────────────────┘    │
                          │  ┌──────▼───────────────────────────────────────┐   │
                          │  │              Core Services                    │   │
                          │  │                                               │   │
                          │  │  ┌──────────────┐  ┌──────────────────────┐  │   │
                          │  │  │  workflow/   │  │  tools/              │  │   │
                          │  │  │  engine.ts   │  │  registry.ts         │  │   │
                          │  │  │  (DAG exec)  │  │  (tool dispatch)     │  │   │
                          │  │  └──────────────┘  └──────────────────────┘  │   │
                          │  │                                               │   │
                          │  │  ┌──────────────┐  ┌──────────────────────┐  │   │
                          │  │  │  knowledge/  │  │  scheduler/          │  │   │
                          │  │  │  base.ts     │  │  cron-wakeup.ts      │  │   │
                          │  │  │  (KB store)  │  │  (cron agent wakeup) │  │   │
                          │  │  └──────────────┘  └──────────────────────┘  │   │
                          │  │                                               │   │
                          │  │  ┌──────────────────────────────────────┐    │   │
                          │  │  │  worktree/                           │    │   │
                          │  │  │  harness.ts  rule-store.ts           │    │   │
                          │  │  │  (MUST/SHOULD/MAY enforcement)       │    │   │
                          │  │  └──────────────────────────────────────┘    │   │
                          │  └───────────────────────────────────────────────┘   │
                          │                                                       │
                          │  ┌──────────────────────────────────────────────┐   │
                          │  │  Existing Services (unchanged)               │   │
                          │  │  heartbeat.ts  issues.ts  agents.ts          │   │
                          │  │  companies.ts  routines.ts  secrets.ts       │   │
                          │  └──────────────────────────────────────────────┘   │
                          │                                                       │
                          │  ┌──────────────────────────────────────────────┐   │
                          │  │  SRB (Service Request Bridge)                │   │
                          │  │  same-instance: in-process event bus         │   │
                          │  │  cross-server:  HTTP webhook POST             │   │
                          │  └──────────────────────────────────────────────┘   │
                          │                                                       │
                          │  ┌──────────────────────────────────────────────┐   │
                          │  │  Mission Session Store                       │   │
                          │  │  (replaces per-run agentTaskSessions)        │   │
                          │  └──────────────────────────────────────────────┘   │
                          └─────────────────────────────────────────────────────┘
                                     │                    │
                             ┌───────▼──────┐    ┌───────▼──────┐
                             │  Adapters    │    │  PostgreSQL   │
                             │  claude-local│    │  (existing    │
                             │  codex-local │    │   + new       │
                             │  cursor-local│    │   tables)     │
                             │  gemini-local│    └───────────────┘
                             │  openclaw-gw │
                             │  opencode-lc │
                             └─────────────┘

  UI (React/Vite)
  ┌──────────────────────────────────────────────────────┐
  │  Mission Board                                        │
  │  ┌─────────────────────────────────────────────────┐ │
  │  │ Mission: "Deploy v2"                            │ │
  │  │  └── Issue: "Write migration script"  [agent A]│ │
  │  │  └── Issue: "Run integration tests"   [agent B]│ │
  │  │  └── Issue: "Update docs"             [agent C]│ │
  │  └─────────────────────────────────────────────────┘ │
  │  Worktree Rules Panel  |  Company Switcher           │
  └──────────────────────────────────────────────────────┘
```

---

## 3. Core Services Design

Each plugin is dissolved into a native service. The plugin runtime sandbox, plugin-lifecycle management, and plugin entity store are no longer involved for these five capabilities — they communicate directly through the shared Drizzle database and the existing server dependency injection pattern.

### 3.1 Workflow Engine (`server/src/services/workflow/`)

**Responsibility**: Define, execute, and reconcile DAG-structured workflows. A workflow is a directed acyclic graph of steps, each step assigned to an agent, with explicit dependency edges.

**Key interfaces**:

```typescript
// server/src/services/workflow/types.ts

export interface WorkflowDefinition {
  id: string;
  companyId: string;
  name: string;
  steps: WorkflowStep[];    // from existing dag-engine.ts — reuse as-is
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  companyId: string;
  missionId: string | null; // NEW: link to Mission
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  triggeredBy: string;       // agentId or "scheduler" or "channel"
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}

export interface WorkflowStepRun {
  id: string;
  workflowRunId: string;
  stepId: string;
  issueId: string | null;   // linked issue for this step
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  startedAt: Date | null;
  completedAt: Date | null;
}
```

**DB schema changes**:

```sql
-- New tables (replaces plugin entity records)
CREATE TABLE workflow_definitions (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES companies(id),
  name        TEXT NOT NULL,
  steps_json  JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workflow_runs (
  id           TEXT PRIMARY KEY,
  workflow_id  TEXT NOT NULL REFERENCES workflow_definitions(id),
  company_id   TEXT NOT NULL,
  mission_id   TEXT REFERENCES missions(id),  -- NEW
  status       TEXT NOT NULL DEFAULT 'pending',
  triggered_by TEXT NOT NULL,
  started_at   TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workflow_step_runs (
  id              TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  step_id         TEXT NOT NULL,
  issue_id        TEXT REFERENCES issues(id),
  status          TEXT NOT NULL DEFAULT 'pending',
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ
);
```

**Migration from plugin**: The `dag-engine.ts` and `reconciler.ts` logic is lifted verbatim. The `PluginContext` dependency is replaced with direct DB access via the Drizzle `db` instance and the existing `heartbeatService`.

---

### 3.2 Tool Registry (`server/src/services/tools/`)

**Responsibility**: Catalog available tools per company, validate tool invocations against the worktree harness, and dispatch to the correct adapter or MCP endpoint.

**Key interfaces**:

```typescript
// server/src/services/tools/types.ts

export interface ToolDefinition {
  id: string;
  companyId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;  // JSON Schema
  adapterType: string;                   // "mcp" | "builtin" | "http"
  adapterConfig: Record<string, unknown>;
  enabled: boolean;
  createdAt: Date;
}

export interface ToolInvocation {
  toolId: string;
  issueId: string;
  agentId: string;
  args: Record<string, unknown>;
  worktreeCheckResult: WorktreeCheckResult;  // must pass before dispatch
}
```

**DB schema changes**:

```sql
CREATE TABLE tool_definitions (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL REFERENCES companies(id),
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  input_schema   JSONB NOT NULL DEFAULT '{}',
  adapter_type   TEXT NOT NULL,
  adapter_config JSONB NOT NULL DEFAULT '{}',
  enabled        BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);

CREATE TABLE tool_audit_log (
  id          TEXT PRIMARY KEY,
  tool_id     TEXT NOT NULL REFERENCES tool_definitions(id),
  company_id  TEXT NOT NULL,
  issue_id    TEXT REFERENCES issues(id),
  agent_id    TEXT REFERENCES agents(id),
  args_hash   TEXT NOT NULL,  -- SHA-256 of args JSON (no PII storage)
  result      TEXT NOT NULL,  -- "allowed" | "blocked_must" | "blocked_should"
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

### 3.3 Knowledge Base (`server/src/services/knowledge/`)

**Responsibility**: Store and retrieve knowledge artifacts per company. Supports three types: static (fixed text), RAG (MCP server-backed vector retrieval), ontology (knowledge graph path).

**Key interfaces**:

```typescript
// server/src/services/knowledge/types.ts

export interface KnowledgeBase {
  id: string;
  companyId: string;
  name: string;
  type: "static" | "rag" | "ontology";
  description: string;
  maxTokenBudget: number;
  config: StaticConfig | RagConfig | OntologyConfig;
  createdAt: Date;
  updatedAt: Date;
}

export interface KBRetrievalRequest {
  kbId: string;
  query: string;
  agentId: string;
  maxTokens?: number;
}

export interface KBRetrievalResult {
  content: string;
  tokenCount: number;
  source: string;
}
```

**DB schema changes**:

```sql
CREATE TABLE knowledge_bases (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES companies(id),
  name            TEXT NOT NULL,
  type            TEXT NOT NULL,  -- 'static' | 'rag' | 'ontology'
  description     TEXT NOT NULL DEFAULT '',
  max_token_budget INT NOT NULL DEFAULT 4096,
  config_json     JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);

CREATE TABLE agent_kb_grants (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  kb_id       TEXT NOT NULL REFERENCES knowledge_bases(id),
  granted_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, kb_id)
);
```

---

### 3.4 Scheduler (`server/src/services/scheduler/`)

**Responsibility**: Trigger agent wakeups on cron schedules without a heartbeat timer loop. The model is: a cron expression stored per schedule entry; the existing `routines.ts` / `cron.ts` cron parser is reused; the scheduler polls on a coarse interval (e.g., every 60 s) and fires any overdue schedules.

This is architecturally identical to how `ops-monitor` in `paperclip-addon` works: no persistent timer threads, no distributed lock contention. The scheduler process is a single lightweight interval that queries `schedules` where `next_run_at <= now()`.

**Key interfaces**:

```typescript
// server/src/services/scheduler/types.ts

export interface Schedule {
  id: string;
  companyId: string;
  agentId: string;
  cronExpression: string;
  timezone: string;
  missionId: string | null;  // if set, wakeup targets this mission context
  enabled: boolean;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  createdAt: Date;
}
```

**DB schema changes**:

```sql
CREATE TABLE schedules (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES companies(id),
  agent_id        TEXT NOT NULL REFERENCES agents(id),
  cron_expression TEXT NOT NULL,
  timezone        TEXT NOT NULL DEFAULT 'UTC',
  mission_id      TEXT REFERENCES missions(id),
  enabled         BOOLEAN NOT NULL DEFAULT true,
  last_run_at     TIMESTAMPTZ,
  next_run_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX schedules_next_run_idx ON schedules (next_run_at)
  WHERE enabled = true;

-- compute_next_run: PostgreSQL function wrapping the cron parser
-- The server-side TypeScript uses cronstrue/cron-parser; the DB function is for
-- use inside the UPDATE...RETURNING claim statement.
-- Implementation: call cron-parser.parseExpression(cron_expression).next().toDate()
-- and store as TIMESTAMPTZ in the same transaction.
-- For the initial implementation, compute next_run_at in TypeScript before INSERT,
-- and update it in the claim query via the JS scheduler after each run.
```

**Runtime loop** (called from `server/src/index.ts` startup):

```typescript
// CRITICAL FIX: claim-then-run pattern with FOR UPDATE SKIP LOCKED
// Prevents duplicate wakeup when multiple processes/instances are running.
setInterval(async () => {
  const claimed = await db.execute(sql`
    WITH due AS (
      SELECT id
      FROM schedules
      WHERE enabled = true AND next_run_at <= now()
      ORDER BY next_run_at
      FOR UPDATE SKIP LOCKED
      LIMIT 100
    )
    UPDATE schedules s
    SET last_run_at = now(),
        next_run_at = compute_next_run(s.cron_expression, s.timezone),
        updated_at  = now()
    FROM due
    WHERE s.id = due.id
    RETURNING s.id, s.agent_id, s.mission_id
  `);
  // Fire wakeups in parallel after the atomic claim
  await Promise.allSettled(
    claimed.rows.map((s) =>
      heartbeatService.wakeupAgent(s.agent_id, {
        missionId: s.mission_id,
        reason: `scheduler:${s.id}`,
      })
    )
  );
}, 60_000);
```

---

### 3.5 Worktree (`server/src/services/worktree/`)

This is the only completely new service with no plugin predecessor. Details are in Section 4.

---

## 4. Worktree Harness Design

The worktree is a governance layer that intercepts agent actions at decision points and evaluates them against a per-company rule set before allowing execution.

### 4.1 Rule Enforcement Model

Three tiers of rule severity:

| Tier | Behavior | Agent Experience |
|------|----------|-----------------|
| MUST | Hard block — action is refused, agent receives an error | `WorktreeViolation` thrown, run halted |
| SHOULD | Warning — action proceeds but a warning is logged and the agent is notified | Warning appended to run log |
| MAY | Guideline — action proceeds with no interruption, violation is silently recorded | Audit log only |

A rule targets a specific action class (e.g., `file:write`, `tool:invoke`, `issue:status_change`, `agent:spawn`) plus an optional predicate (path pattern, tool name, target status, etc.).

### 4.2 Rule Definition Format

After evaluating three options — JSON Schema, a custom DSL, and a structured YAML format — the recommended choice is **structured JSON with a predicate mini-language**. This is preferable to a DSL because:

- It is directly serializable to/from the database without a parser
- It is editable via a generic JSON editor in the UI without custom tooling
- It can be validated with standard JSON Schema

```json
{
  "id": "rule-001",
  "name": "No direct prod database writes",
  "severity": "MUST",
  "action": "tool:invoke",
  "predicate": {
    "toolName": { "$in": ["db_execute", "psql"] },
    "args.connection": { "$contains": "prod" }
  },
  "message": "Production database writes require human approval. Use the staging connection."
}
```

Predicate operators: `$eq`, `$ne`, `$in`, `$notIn`, `$contains`, `$startsWith`, `$endsWith`, `$matches` (regex — see safety note), `$gt`, `$lt`.

**HIGH FIX: `$matches` ReDoS protection.**
The `$matches` operator MUST apply two guards in `predicate-eval.ts`:
1. Max pattern length: reject patterns longer than 200 characters
2. Execution timeout: wrap `regex.test()` in a 50ms deadline (use `vm.runInNewContext` with timeout, or the `re2` npm package for guaranteed linear-time matching)

```typescript
// predicate-eval.ts — $matches handler
import RE2 from "re2";  // O(n) guaranteed, no backtracking
const re = new RE2(pattern);  // throws if invalid pattern
return re.test(String(value));
```

The predicate evaluator is a ~100-line pure function — no external dependency.

**Decision map** (`decisionMap` field on each rule): A rule can carry a `decisionMap` field that captures the reasoning behind the rule. This is displayed to agents in violation messages and to humans in the governance UI.

```json
{
  "decisionMap": {
    "context": "Prod DB had two accidental deletes in Q1 2025",
    "rationale": "Zero-touch prod requires change-request approval",
    "alternatives": ["Use staging env", "Open an approval issue first"]
  }
}
```

### 4.3 Governance Flow

```
Human defines rules in UI
       │
       ▼
Rules saved to worktree_rules table (status: "pending")
       │
       ▼
Agents analyze rules during idle cycles
  → May propose amendments (new rule, severity change, predicate refinement)
  → Amendment stored as worktree_rule_proposals (status: "proposed")
       │
       ▼
Human reviews proposals in UI
  → Accept → rule updated in worktree_rules
  → Reject → proposal closed with rejection note
       │
       ▼
Active rules enforced at runtime by WorktreeHarness.check()
```

The harness exposes a single method that all checkpoints call:

```typescript
// server/src/services/worktree/harness.ts

export interface WorktreeCheckResult {
  allowed: boolean;
  tier: "MUST" | "SHOULD" | "MAY" | null;
  violatedRuleId: string | null;
  message: string | null;
}

export async function checkAction(
  db: Db,
  companyId: string,
  action: string,
  context: Record<string, unknown>
): Promise<WorktreeCheckResult>
```

**DB schema**:

```sql
CREATE TABLE worktree_rules (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL REFERENCES companies(id),
  name         TEXT NOT NULL,
  severity     TEXT NOT NULL CHECK (severity IN ('MUST', 'SHOULD', 'MAY')),
  action       TEXT NOT NULL,
  predicate    JSONB NOT NULL DEFAULT '{}',
  decision_map JSONB NOT NULL DEFAULT '{}',
  message      TEXT NOT NULL DEFAULT '',
  enabled      BOOLEAN NOT NULL DEFAULT true,
  version      INT NOT NULL DEFAULT 1,
  created_by   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE worktree_rule_proposals (
  id              TEXT PRIMARY KEY,
  rule_id         TEXT REFERENCES worktree_rules(id),  -- NULL = new rule proposal
  company_id      TEXT NOT NULL REFERENCES companies(id),
  proposed_by     TEXT NOT NULL,  -- agentId
  proposed_change JSONB NOT NULL, -- full rule JSON after proposed change
  rationale       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'proposed'
                    CHECK (status IN ('proposed', 'accepted', 'rejected')),
  reviewed_by     TEXT,
  reviewed_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE worktree_audit_log (
  id          TEXT PRIMARY KEY,
  rule_id     TEXT REFERENCES worktree_rules(id),
  company_id  TEXT NOT NULL,
  agent_id    TEXT REFERENCES agents(id),
  issue_id    TEXT REFERENCES issues(id),
  action      TEXT NOT NULL,
  result      TEXT NOT NULL CHECK (result IN ('allowed', 'warned', 'blocked')),
  context_hash TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 4.4 Open Question: Worktree Rule Editor UI

Three options, each with different trade-offs:

**Option A — Raw JSON editor** (simplest): Monaco editor directly on the JSONB. Low build cost, high friction for non-technical operators.

**Option B — Form-based builder** (recommended for v1): A structured form with dropdowns for `severity`, `action`, and a dynamic predicate builder. Moderate build cost, usable by operations staff.

**Option C — Natural language → rule compiler**: Free-text input compiled to rule JSON by an LLM. High UX, highest risk of silent miscompilation. Defer to v2.

Recommendation: Option B for v1, with Option A as fallback for power users.

---

## 5. Mission-Scoped Session Design

### 5.1 Problem with Per-Run Sessions

The current `agentTaskSessions` table stores session state keyed by `(agentId, runId)`. When an agent's heartbeat run ends and a new run starts (even on the same issue), the adapter creates a fresh session, losing all conversational context from prior runs.

For papercompany, agents working on a Mission should maintain context across the multiple runs that constitute the mission's lifecycle.

### 5.2 Session Lifecycle

```
Mission created
    │
    ▼
MissionSession created (status: "active", session_token issued)
    │
    ├── Run 1: agent uses session_token, adapter loads context
    │       │
    │       └── Run ends → session NOT destroyed, token reused
    │
    ├── Run 2: same session_token → adapter continues from prior context
    │
    ├── Run N: ...
    │
    └── Mission completed / cancelled / expired
            │
            ▼
        MissionSession closed → adapter session compacted or dropped
```

### 5.3 Storage Design

```typescript
// server/src/services/sessions/types.ts

export interface MissionSession {
  id: string;
  missionId: string;
  agentId: string;
  companyId: string;
  sessionToken: string;       // passed to adapter as existing session
  adapterType: string;        // "claude_local" | "codex_local" etc.
  status: "active" | "compacting" | "closed" | "expired";
  lastActiveAt: Date;
  runCount: number;
  createdAt: Date;
  expiresAt: Date | null;     // null = never expires (until mission ends)
}
```

```sql
-- CRITICAL FIX: session_token must never be stored in plaintext.
-- Store a reference to the secrets table; the actual token is encrypted at rest.
CREATE TABLE mission_sessions (
  id              TEXT PRIMARY KEY,
  mission_id      TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  agent_id        TEXT NOT NULL REFERENCES agents(id),
  company_id      TEXT NOT NULL,
  session_secret_id TEXT NOT NULL REFERENCES secrets(id),  -- replaces plaintext session_token
  adapter_type    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'compacting', 'closed', 'expired')),
  last_active_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  run_count       INT NOT NULL DEFAULT 0,
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (mission_id, agent_id, adapter_type)
);
```

### 5.4 Expiry Policy (Open Question — Recommended Options)

| Policy | Trigger | Trade-off |
|--------|---------|-----------|
| Mission-lifetime | Expires when mission is closed/cancelled | Simple, but missions may last months |
| Idle timeout | Expires after N days of no agent activity on the mission | Balanced — handles abandoned missions |
| Token budget | Expires when adapter-reported context length exceeds threshold | Technically optimal, requires adapter support |
| Explicit compaction | Agent calls a `compact_session` tool | Agent-controlled, highest fidelity |

**Recommendation for v1**: Idle timeout of 30 days, configurable per company. If an expired session is referenced, the harness creates a new session and passes a summary note as the first message.

The existing `resolveSessionCompactionPolicy` in `@paperclipai/adapter-utils` already handles compaction thresholds — reuse it when the mission session approaches the adapter's context limit.

### 5.5 Integration with Heartbeat

In `heartbeat.ts`, the `SESSIONED_LOCAL_ADAPTERS` set already gates whether a session token is passed to the adapter. The change is:

- Before: look up `agentTaskSessions` by `(agentId, runId)` → per-run session
- After: look up `mission_sessions` by `(missionId, agentId)` → mission-scoped session
- If no `missionId` is set on the run (legacy compatibility): fall back to per-run behavior

---

## 6. Two-Tier Company Model

### 6.1 Motivation

papercompany operates companies that do business work (e.g., ops-team, dev-team) and a single maintenance company that has elevated privileges: it can modify agent code, update tool definitions, and deploy new worktree rules across all companies. Business companies cannot modify code or cross-company data.

### 6.2 Role Taxonomy

```
Instance
├── maintenance_company (exactly one, flagged in companies table)
│   └── Roles:  maintenance_admin, maintenance_engineer
│       Permissions: code modify, global tool registry edit, cross-company rule push
└── business_company (N companies)
    └── Roles: company_admin, company_agent_operator, channel_bot
        Permissions: mission create/manage, issue create, local tool registry, local KB
```

### 6.3 Implementation

**Option A — Flag on existing companies table** (recommended): Add a `company_kind` column (`"business" | "maintenance"`). A single maintenance company is created at bootstrap. API middleware checks `company_kind` for gated endpoints.

**Option B — Separate tenant model**: Create a `maintenance_tenants` table with foreign keys. Higher isolation but requires parallel API surfaces.

Recommendation: Option A — the existing `companies` table already has per-company permission scoping via `company-scoped token` in better-auth. Adding a `company_kind` column keeps the model simple.

```sql
ALTER TABLE companies
  ADD COLUMN company_kind TEXT NOT NULL DEFAULT 'business'
    CHECK (company_kind IN ('business', 'maintenance'));

ALTER TABLE companies
  ADD COLUMN allows_code_modify BOOLEAN NOT NULL DEFAULT false;
```

**Middleware gate**:

```typescript
// server/src/middleware/company-kind-gate.ts

export function requireMaintenanceCompany() {
  return async (req, res, next) => {
    const company = await companyService.get(req.companyId);
    if (company.companyKind !== "maintenance") {
      return res.status(403).json({ error: "maintenance_company_required" });
    }
    next();
  };
}
```

**CRITICAL FIX: Centralized enforcement via route prefix, not per-route application.**

Individual routes MUST NOT apply `requireMaintenanceCompany()` manually — this creates gaps when new routes are added.
Instead, mount the middleware on the entire `/maintenance/*` prefix in `routes/index.ts`:

```typescript
// server/src/routes/index.ts
app.use("/maintenance", requireMaintenanceCompany());
app.use("/maintenance/worktree/rules/push", worktreeRoutes);  // push to other companies
app.use("/maintenance/tools/builtins", toolsMaintenanceRoutes);
app.use("/maintenance/agents/:id/code", agentCodeRoutes);
app.use("/maintenance/instance/settings", instanceSettingsRoutes);
```

Business-company routes are mounted under `/api/` with company-scoped JWT enforcement only.
Maintenance routes are mounted under `/maintenance/` with `requireMaintenanceCompany()` applied once.

**Gated endpoints** (require maintenance company — all under `/maintenance/` prefix):

- `POST /worktree/rules` with `push_to_company_id` — deploy rules to another company
- `POST /tools/definitions` when `adapterType === "builtin"` — register built-in tools
- `POST /agents/:id/code` — modify agent system prompt or code
- `GET /instance/settings` (write) — instance-level configuration

---

## 7. SRB (Service Request Bridge) Design

### 7.1 Current State

The existing `service-request-bridge` plugin (in `packages/plugins/service-request-bridge/`) synchronizes issues between two companies within the same paperclip instance using `BridgeLink` entity records. There is no cross-server capability.

### 7.2 Two-Path Architecture

```
                       ┌─────────────────────────────────┐
                       │         SRB Router               │
                       │  srbService.route(request)       │
                       └────────┬──────────────────┬──────┘
                                │                  │
                    ┌───────────▼───────┐  ┌───────▼────────────┐
                    │ Same-Instance Path │  │ Cross-Server Path  │
                    │                   │  │                    │
                    │ In-process        │  │ HTTP POST to       │
                    │ cross-company     │  │ remote webhook     │
                    │ event bus call    │  │ endpoint           │
                    │                   │  │                    │
                    │ No network hop    │  │ Async, retried     │
                    │ Transactional     │  │ Signed with HMAC   │
                    └───────────────────┘  └────────────────────┘
```

### 7.3 Same-Instance Path

When a request targets a company on the same server, the SRB calls the target company's issue service directly via an in-process function call. No HTTP overhead.

**Atomicity**: The same-instance path uses a single DB transaction. The source event and the target issue creation are committed together. If the target issue creation fails, the source event is not recorded either. This is achieved by passing the existing Drizzle transaction context:

```typescript
// same-instance path — transactional
await db.transaction(async (tx) => {
  await srbStore.recordEvent(tx, linkId, event);
  await issueService.createFromSRB(tx, targetCompanyId, event.payload);
});
```

```typescript
// server/src/services/srb/router.ts

export async function routeSRBRequest(
  db: Db,
  request: SRBRequest
): Promise<SRBResult> {
  const link = await srbStore.getLink(request.linkId);

  if (link.remoteServerUrl === null) {
    // same-instance: direct in-process dispatch
    return srbLocalDispatch(db, link, request);
  } else {
    // cross-server: HTTP webhook
    return srbWebhookDispatch(link, request);
  }
}
```

### 7.4 Cross-Server Path

The remote server exposes a webhook endpoint:

```
POST /srb/webhook
Authorization: Bearer <HMAC-signed JWT>
Content-Type: application/json

{
  "linkId": "...",
  "event": "issue.status_changed",
  "payload": { ... },
  "ts": 1743400000,
  "sig": "<HMAC-SHA256>"
}
```

**Security**: Each cross-server link stores a shared secret in the `secrets` table. The sender signs the payload body with HMAC-SHA256. The receiver verifies the signature before processing.

**HIGH FIX: Replay protection + idempotency key required.**

Webhook requests MUST include:
```
X-SRB-Timestamp: <unix seconds>      # reject if |now - ts| > 300s
X-SRB-Signature: <HMAC-SHA256>       # computed over "ts.body"
X-SRB-Idempotency-Key: <uuid>        # stored in srb_nonce table, unique constraint
```

```sql
CREATE TABLE srb_nonce (
  idempotency_key TEXT PRIMARY KEY,
  link_id         TEXT NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX srb_nonce_cleanup_idx ON srb_nonce (received_at);
-- Background job deletes nonces older than 10 minutes
```

**Reliability**: Failed webhook deliveries are stored in `srb_delivery_log` with status `failed`. A background job retries with exponential backoff up to 10 attempts.

```sql
CREATE TABLE srb_links (
  id                  TEXT PRIMARY KEY,
  local_company_id    TEXT NOT NULL REFERENCES companies(id),
  remote_company_id   TEXT NOT NULL,       -- company on remote server
  remote_server_url   TEXT,                -- NULL = same instance
  direction           TEXT NOT NULL,
  shared_secret_id    TEXT REFERENCES secrets(id),
  created_by          TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE srb_delivery_log (
  id           TEXT PRIMARY KEY,
  link_id      TEXT NOT NULL REFERENCES srb_links(id),
  event        TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'delivered', 'failed', 'abandoned')),
  attempt_count INT NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  next_retry_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## 8. Channel Integration (Telegram v1)

### 8.1 Webhook vs Polling Decision

| Criterion | Webhook | Polling |
|-----------|---------|---------|
| Requires public HTTPS endpoint | Yes | No |
| Latency | Low (instant) | Higher (depends on interval) |
| Infrastructure | Needs reverse proxy / ngrok in dev | Works behind NAT / firewall |
| Complexity | Slightly higher (cert, ngrok) | Simpler |
| Scalability | Better (event-driven) | Polling loop |
| Self-hosted default | Harder (NAT issues) | Easier |

**Decision**: Use **long polling** for v1. papercompany is self-hosted and operators may be behind NAT or corporate firewalls where exposing a webhook endpoint is non-trivial. Long polling removes this operational dependency. Switching to webhook later requires only changing the Telegram Bot initialization call — the message handler logic is identical.

The polling loop uses Telegram's `getUpdates` API with `timeout=25` (long poll). This is already idiomatic for self-hosted Telegram bots and has no latency penalty in practice (<1 s response time).

### 8.2 Implementation Structure

```
server/src/channel/
├── telegram/
│   ├── bot.ts           — TelegramBot class, polling loop, message dispatch
│   ├── commands.ts      — /status, /assign, /mission, /approve command handlers
│   ├── formatter.ts     — issue → human-readable message formatter
│   └── types.ts         — TelegramMessage, TelegramUpdate types
└── index.ts             — channel registry, startup
```

**Message flow**:

```
Telegram user sends message in company channel
  → bot.ts receives update via long poll
  → commands.ts dispatches by command prefix
  → mission command → missionService.create() or get()
  → approve command → approvalsService.approve()
  → status command → missionService.getStatus() → formatter.ts → reply
```

**Outbound notifications** (agent sends update to Telegram):

Agents do not call Telegram directly. Instead, a `live-events.ts` listener subscribes to issue/mission status changes and sends Telegram messages via the bot. This keeps the Telegram dependency isolated in the channel layer.

**DB schema**:

```sql
CREATE TABLE channel_configs (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES companies(id),
  kind        TEXT NOT NULL DEFAULT 'telegram',
  config_json JSONB NOT NULL,  -- bot_token, chat_id, etc. (encrypted at rest)
  enabled     BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, kind)
);
```

The `bot_token` is stored as a reference to the `secrets` table (same pattern as adapter secrets) — never in `config_json` directly.

### 8.3 Bot JWT Lifecycle

The Telegram bot authenticates to the papercompany API using a short-lived company-scoped JWT, not a static API key.

```
Lifecycle:
- Initial JWT issued at bot startup (TTL: 1 hour)
- Bot checks expiry before each API call; re-issues 5 minutes before expiry
- JWT is issued to a dedicated service account agent with role "channel_bot"
- Revocation: deleting the service account invalidates all outstanding tokens
- Key rotation: JWT signing key rotated monthly via secrets service
```

This aligns with the existing better-auth + company-scoped token model. No additional infrastructure is required.

### 8.4 Telegram Bot Privileges

The Telegram bot account is the only channel-side user. It has a `company_kind = "business"` JWT that is scoped to one company. Human operators interact entirely through the bot — they do not have platform UI accounts. Therefore, all approvals, mission commands, and status queries flow through the Telegram command interface.

---

## 9. UI Architecture

### 9.1 Current State

The existing UI (`ui/src/pages/`) is issue-centric: `Issues.tsx`, `IssueDetail.tsx`, `Goals.tsx`, `Dashboard.tsx`. Issues are flat lists under a project.

### 9.2 Mission-Centric Hierarchy

papercompany introduces a Mission as the primary unit of work. The UI tree becomes:

```
Company
└── Missions (replaces flat Issues list as top-level navigation)
    └── Mission Detail
        ├── Mission Header (status, assignee agents, goal)
        ├── Issue Tree (child issues, nested)
        │   └── Issue Detail (unchanged, slides in)
        ├── Workflow Run Panel (DAG visualization)
        ├── Worktree Rules Panel (active rules, violations log)
        └── Session Panel (active mission session info)
```

### 9.3 New Pages

| Page | Route | Description |
|------|-------|-------------|
| `Missions.tsx` | `/missions` | List of all missions for the current company |
| `MissionDetail.tsx` | `/missions/:id` | Mission-scoped issue tree + panels |
| `MissionCreate.tsx` | `/missions/new` | Create mission with initial workflow |
| `WorktreeRules.tsx` | `/worktree/rules` | Rule list, create/edit form, proposals |
| `WorktreeProposals.tsx` | `/worktree/proposals` | Agent-proposed rule amendments |
| `SchedulerConfig.tsx` | `/scheduler` | Cron schedule management |
| `ChannelConfig.tsx` | `/settings/channel` | Telegram bot setup |

### 9.4 Component Changes

- `Sidebar.tsx` — Add "Missions" as primary nav item; keep "Issues" as secondary (for uncategorized issues)
- `Dashboard.tsx` — Replace goal-centric summary with mission progress summary
- `CompanySettings.tsx` — Add tabs for Channel, Scheduler, Worktree Rules
- Remove `Goals.tsx` from main navigation (Goals still exist as metadata on Missions but are no longer standalone navigation)

### 9.5 API Surface Changes

New REST endpoints to support the UI:

```
GET    /missions                    — list missions (company-scoped)
POST   /missions                    — create mission
GET    /missions/:id                — mission detail
PATCH  /missions/:id                — update mission
DELETE /missions/:id                — cancel/archive mission
GET    /missions/:id/issues         — issues belonging to this mission
GET    /missions/:id/workflow-runs  — workflow runs for this mission

GET    /worktree/rules              — list rules
POST   /worktree/rules              — create rule
PATCH  /worktree/rules/:id          — update rule
GET    /worktree/proposals          — list proposals
PATCH  /worktree/proposals/:id      — accept/reject proposal

GET    /scheduler/schedules         — list schedules
POST   /scheduler/schedules         — create schedule
PATCH  /scheduler/schedules/:id     — update schedule
DELETE /scheduler/schedules/:id     — delete schedule

GET    /channel/config              — get channel config
PUT    /channel/config              — upsert channel config
POST   /channel/test                — send test message
```

---

## 10. Implementation Phases

Dependencies flow from data model → services → API → UI → channels. Each phase is independently deployable and testable.

### Phase 1 — Database Foundation (Week 1-2)

Goal: All new tables created with migrations. No service logic yet.

- Add `company_kind` and `allows_code_modify` columns to `companies`
- Create `missions` table (id, company_id, title, status, goal_id, created_at)
- Create `mission_sessions` table
- Create `workflow_definitions`, `workflow_runs`, `workflow_step_runs` tables
- Create `tool_definitions`, `tool_audit_log` tables
- Create `knowledge_bases`, `agent_kb_grants` tables
- Create `schedules` table
- Create `worktree_rules`, `worktree_rule_proposals`, `worktree_audit_log` tables
- Create `srb_links`, `srb_delivery_log` tables
- Create `channel_configs` table

Deliverable: `drizzle/migrations/0XXX_papercompany_core.sql`

### Phase 2 — Service Integration: Workflow + Tools + Knowledge (Week 3-4)

Goal: Three plugin modules lifted into server services with tests passing.

- Extract `dag-engine.ts`, `reconciler.ts`, `workflow-store.ts`, `workflow-utils.ts` into `server/src/services/workflow/`
- Replace `PluginContext` calls with direct `db` + `heartbeatService` calls
- Extract tool-registry logic into `server/src/services/tools/`
- Extract knowledge-base logic into `server/src/services/knowledge/`
- Wire up service constructors in `server/src/services/index.ts`
- Unit tests for DAG validation, tool dispatch, KB retrieval

Deliverable: Three new service modules, existing plugin directories marked `deprecated`

### Phase 3 — Scheduler Service (Week 5)

Goal: Cron-based agent wakeup running without heartbeat timer dependency.

- Implement `server/src/services/scheduler/cron-wakeup.ts`
- Reuse existing `cron.ts` parser
- Wire polling loop in `server/src/index.ts`
- Remove heartbeat timer dependency for scheduled wakeups
- Test with 5-minute and hourly cron schedules

Deliverable: `scheduler/` service, `schedules` CRUD API

### Phase 4 — Worktree Harness (Week 6-7)

Goal: MUST/SHOULD/MAY rule enforcement active on all tool invocations.

- Implement `server/src/services/worktree/harness.ts` — predicate evaluator
- Implement `server/src/services/worktree/rule-store.ts` — CRUD for rules
- Implement `server/src/services/worktree/proposal-store.ts` — agent proposal flow
- Hook `WorktreeHarness.check()` into tool dispatch path (`tools/registry.ts`)
- Hook into `heartbeat.ts` at file-write and command-execute decision points
- REST API for rules and proposals
- Integration tests covering all three severity tiers

Deliverable: Worktree harness active on all tool invocations

### Phase 5 — Mission Layer + Session Persistence (Week 8-9)

Goal: Missions as first-class entities with persistent agent sessions.

- Implement `server/src/services/missions.ts`
- Implement `server/src/services/sessions/mission-session-store.ts`
- Modify `heartbeat.ts`: resolve mission session instead of per-run session when `missionId` is set
- Link workflow runs to missions via `mission_id` FK
- REST API for missions (CRUD + issue tree)
- Test: agent runs 3 consecutive heartbeats on the same mission, session token is reused across runs

Deliverable: `missions` and `mission_sessions` services, heartbeat integration

### Phase 6 — SRB Redesign (Week 10)

Goal: Same-instance and cross-server SRB paths operational.

- Implement `server/src/services/srb/router.ts` — path selection logic
- Implement `server/src/services/srb/local-dispatch.ts` — in-process path
- Implement `server/src/services/srb/webhook-dispatch.ts` — HTTP webhook sender
- Implement `POST /srb/webhook` receiver endpoint with HMAC verification
- Implement retry worker for `srb_delivery_log` failed records
- Remove dependency on plugin entity store for bridge links

Deliverable: SRB service with two paths, delivery retry worker

### Phase 7 — Telegram Channel (Week 11)

Goal: Telegram bot operational as the sole human interaction channel.

- Implement `server/src/channel/telegram/bot.ts` — long-poll loop
- Implement command handlers: `/status`, `/mission`, `/approve`, `/assign`
- Implement outbound notifier via `live-events.ts` subscription
- REST API for channel config (token stored via secrets service)
- Test: end-to-end mission status query via Telegram

Deliverable: Telegram bot running, channel config API

### Phase 8 — UI Overhaul (Week 12-14)

Goal: Mission-centric UI replacing the issue-list primary navigation.

- `Missions.tsx` — mission list with status chips
- `MissionDetail.tsx` — issue tree, workflow panel, worktree panel
- `WorktreeRules.tsx` and `WorktreeProposals.tsx`
- `SchedulerConfig.tsx`
- `ChannelConfig.tsx`
- Sidebar update, Dashboard update
- Remove Goals from primary navigation

Deliverable: Full UI overhaul, all new pages functional

---

## 11. File Structure

```
server/src/
├── services/
│   ├── workflow/                        (NEW — from packages/plugins/workflow-engine)
│   │   ├── engine.ts                    — workflow service (create, trigger, cancel)
│   │   ├── dag-engine.ts                — lifted from plugin (minimal changes)
│   │   ├── reconciler.ts                — lifted from plugin (PluginContext → db)
│   │   ├── workflow-store.ts            — lifted from plugin
│   │   ├── workflow-utils.ts            — lifted from plugin
│   │   ├── run-guards.ts                — lifted from plugin
│   │   └── types.ts                     — TypeScript interfaces
│   ├── tools/                           (NEW — from packages/plugins/tool-registry)
│   │   ├── registry.ts                  — tool CRUD + dispatch
│   │   ├── audit.ts                     — lifted from plugin
│   │   └── types.ts
│   ├── knowledge/                       (NEW — from packages/plugins/knowledge-base)
│   │   ├── base.ts                      — KB CRUD + retrieval
│   │   ├── kb-store.ts                  — lifted from plugin
│   │   └── types.ts
│   ├── scheduler/                       (NEW — from paperclip-addon/ops-monitor pattern)
│   │   ├── cron-wakeup.ts               — polling loop + due-schedule query
│   │   └── types.ts
│   ├── worktree/                        (NEW — no predecessor)
│   │   ├── harness.ts                   — checkAction() entry point
│   │   ├── predicate-eval.ts            — predicate mini-language evaluator
│   │   ├── rule-store.ts                — CRUD for worktree_rules
│   │   ├── proposal-store.ts            — CRUD for worktree_rule_proposals
│   │   └── types.ts
│   ├── missions.ts                      (NEW)
│   ├── sessions/
│   │   └── mission-session-store.ts     (NEW)
│   ├── srb/                             (NEW — replaces plugin)
│   │   ├── router.ts
│   │   ├── local-dispatch.ts
│   │   ├── webhook-dispatch.ts
│   │   └── types.ts
│   ├── heartbeat.ts                     (MODIFIED — mission session integration)
│   ├── issues.ts                        (MODIFIED — mission_id FK support)
│   ├── companies.ts                     (MODIFIED — company_kind field)
│   └── index.ts                         (MODIFIED — wire new services)
├── routes/
│   ├── missions.ts                      (NEW)
│   ├── worktree.ts                      (NEW)
│   ├── scheduler.ts                     (NEW)
│   ├── channel.ts                       (NEW)
│   ├── srb-webhook.ts                   (NEW — inbound webhook receiver)
│   └── index.ts                         (MODIFIED)
├── channel/
│   ├── telegram/
│   │   ├── bot.ts                       (NEW)
│   │   ├── commands.ts                  (NEW)
│   │   ├── formatter.ts                 (NEW)
│   │   └── types.ts                     (NEW)
│   └── index.ts                         (NEW)
└── middleware/
    └── company-kind-gate.ts             (NEW)

ui/src/
├── pages/
│   ├── Missions.tsx                     (NEW)
│   ├── MissionDetail.tsx                (NEW)
│   ├── MissionCreate.tsx                (NEW)
│   ├── WorktreeRules.tsx                (NEW)
│   ├── WorktreeProposals.tsx            (NEW)
│   ├── SchedulerConfig.tsx              (NEW)
│   ├── ChannelConfig.tsx                (NEW)
│   ├── Dashboard.tsx                    (MODIFIED)
│   └── Issues.tsx                       (MODIFIED — secondary nav)
└── components/
    ├── MissionIssueTree.tsx             (NEW)
    ├── WorkflowDagPanel.tsx             (NEW)
    ├── WorktreeRuleForm.tsx             (NEW)
    └── ...

drizzle/migrations/
└── 0XXX_papercompany_core.sql           (NEW — all Phase 1 tables)

packages/plugins/
├── workflow-engine/                     DEPRECATED (kept for reference, not loaded)
├── tool-registry/                       DEPRECATED
├── knowledge-base/                      DEPRECATED
└── service-request-bridge/             DEPRECATED
```

---

## 12. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **Plugin extraction breaks existing plugin host tests** | High | Medium | Run plugin integration tests after each Phase 2-3 extraction. Mark deprecated plugins as non-loadable in dev only after tests pass. |
| **Mission-scoped sessions cause context overflow** | Medium | High | Implement idle-timeout expiry (30 days) and integrate existing `resolveSessionCompactionPolicy` from `@paperclipai/adapter-utils`. Monitor `run_count` per session. |
| **Worktree MUST blocks legitimate agent actions** | Medium | High | All MUST rules must have a `decisionMap.alternatives` field before activation. Add a "dry-run mode" that logs violations without blocking for 48 h before enforcement activates. |
| **SRB webhook delivery silent failures** | Medium | High | `srb_delivery_log` retry worker is mandatory in Phase 6. Expose delivery status in UI. Alert via Telegram on >3 consecutive failures per link. |
| **Telegram long polling drops updates under load** | Low | Medium | Telegram's `getUpdates` offset tracking prevents duplicate delivery. Add idempotency key to `channel_events` table. Test with burst message sequences. |
| **Two-tier company middleware gate bypassed** | Low | Critical | Integration test: assert that a business-company JWT receives 403 on all maintenance-gated endpoints. Include in CI. |
| **Drizzle migration fails on existing production data** | Low (fresh start) | Low | Confirmed fresh start — no migration needed. Document as explicit constraint in `docs/deploy/fresh-start-required.md`. |
| **Worktree rule predicate evaluator has correctness bugs** | Medium | High | Full unit test matrix for all predicate operators (`$eq`, `$in`, `$matches`, etc.) with known-good and known-bad inputs. Fuzz test with random JSON. |
| **Phases 7-8 (Telegram + UI) deprioritized under time pressure** | High | Medium | Telegram is a hard dependency for human-in-the-loop approval. It must ship before worktree MUST rules are enabled in production. UI overhaul can be staged — Mission pages first, Worktree UI second. |

---

## 13. Open Questions

The following items require a decision before the relevant implementation phase begins.

### OQ-1: Worktree Rule Editor UI Format (blocks Phase 4 UI, Week 6)

Three options documented in Section 4.2. Recommendation is Option B (form-based builder). Decision needed before `WorktreeRules.tsx` is designed.

### OQ-2: Mission Session Expiry Policy (blocks Phase 5, Week 8)

Recommendation is 30-day idle timeout. Alternatives: mission-lifetime, token budget, explicit compaction. Decision needed before `mission-session-store.ts` is implemented.

### OQ-3: Telegram Webhook vs Polling (blocks Phase 7, Week 11)

Recommendation is long polling for v1 (self-hosted NAT compatibility). If the target deployment environment guarantees a public HTTPS endpoint, webhook is preferable. Decision needed before `bot.ts` is implemented.

### OQ-4: Mission DB Schema (blocks Phase 1, Week 1)

`missions` table needs confirmation of fields:

- Does a Mission have a single `assignee_agent_id`, or a list of participating agents?
- Is a Mission always linked to a Goal, or can it exist without one?
- What are the valid Mission statuses? Proposed: `planning | active | paused | completed | cancelled`

### OQ-5: Worktree Governance — Agent Proposal Frequency Limit (blocks Phase 4)

If agents can freely propose rule amendments, the proposal queue could become noisy. Should there be a rate limit per agent per day? Or a minimum confidence threshold before a proposal is submitted? Proposed: max 3 proposals per agent per 24 h per company.

### OQ-6: Maintenance Company Bootstrap (blocks Phase 1)

How is the single maintenance company created? Options:
- CLI seed script run once at installation
- Auto-created on first `pnpm start` if no companies exist
- Manual POST to a setup endpoint

Recommendation: auto-create during `server/src/index.ts` startup if `companies` table is empty (same pattern as instance settings bootstrap).

### OQ-7: SRB Cross-Server Authentication Key Rotation (blocks Phase 6)

When a cross-server webhook shared secret needs to be rotated, both servers must update simultaneously. What is the rotation protocol? Options: dual-secret overlap window (old + new both valid for 24 h) vs hard cutover.

---

## 14. Observability & Operations (HIGH — Added by Round 1 Review)

Both reviewers flagged the absence of observability as a significant gap. papercompany MUST implement the following before production deployment.

### 14.1 Metrics (SLI/SLO)

Key service-level indicators to instrument:

| SLI | SLO Target | Collection Point |
|-----|-----------|-----------------|
| Scheduler due-to-wakeup latency | p95 < 90s | `cron-wakeup.ts` |
| Worktree check latency | p99 < 50ms | `harness.ts:checkAction()` |
| SRB webhook delivery rate | > 99% within 60s | `srb_delivery_log` |
| Mission session reuse rate | > 80% of runs | `mission_sessions.run_count` |
| Telegram command response latency | p95 < 3s | `commands.ts` |

Instrumentation: use the `prom-client` npm package, expose `/metrics` endpoint (Prometheus-compatible), scrape with Grafana.

### 14.2 Distributed Tracing

Add OpenTelemetry trace context to all service entry points. Minimum trace spans:
- `worktree.checkAction(companyId, action)` — include rule match result
- `scheduler.claimAndWakeup()` — include claim count and wakeup latency
- `srb.route(linkId)` — include path selected (local/webhook) and delivery status

### 14.3 Audit Log Retention Policy (TTL)

High-volume tables require TTL cleanup to prevent unbounded growth:

```sql
-- Background job (runs daily at 03:00 KST via scheduler)
DELETE FROM worktree_audit_log WHERE created_at < now() - INTERVAL '90 days';
DELETE FROM tool_audit_log       WHERE created_at < now() - INTERVAL '90 days';
DELETE FROM srb_delivery_log     WHERE created_at < now() - INTERVAL '30 days'
                                   AND status IN ('delivered', 'abandoned');
DELETE FROM srb_nonce            WHERE received_at < now() - INTERVAL '10 minutes';
```

Add partial indexes to support efficient status-based queries:

```sql
CREATE INDEX worktree_audit_company_idx ON worktree_audit_log (company_id, created_at DESC);
CREATE INDEX srb_delivery_retry_idx     ON srb_delivery_log (status, next_retry_at)
  WHERE status IN ('pending', 'failed');
CREATE INDEX workflow_runs_mission_idx  ON workflow_runs (company_id, mission_id, created_at DESC);
CREATE INDEX mission_sessions_idle_idx  ON mission_sessions (company_id, status, last_active_at)
  WHERE status = 'active';
```

### 14.4 Alerting

Minimum alert rules (Telegram outbound via bot):

| Alert | Threshold | Severity |
|-------|-----------|---------|
| Scheduler not running | No cron-wakeup log for >120s | Critical |
| SRB delivery failures | >3 consecutive `failed` per link | High |
| Worktree MUST block rate spike | >10 blocks/min per company | High |
| Telegram bot offline | No `getUpdates` call for >60s | High |

---

## Appendix A: ADR-001 — Dissolve Plugins into Native Services

```
# ADR-001: Dissolve Core Plugins into Server Services

## Status
Accepted

## Context
The five core capabilities of papercompany (workflow-engine, tool-registry,
knowledge-base, ops-monitor/scheduler, service-request-bridge) are currently
implemented as paperclip plugins. Running them as plugins introduces:
- Plugin sandbox overhead on every invocation
- PluginContext abstraction layer between services and the database
- Plugin entity store as an intermediate persistence layer
- Plugin lifecycle management (load, unload, hot-reload) not needed for core services

## Decision
Dissolve all five plugins into server/src/services/ as first-class services.
The plugin code is lifted with minimal changes; PluginContext calls are replaced
with direct database access. The plugin directories are marked deprecated and
removed from the plugin loader.

## Consequences
Easier: Direct database queries, simpler service-to-service calls, no plugin
sandbox for core operations, smaller runtime memory footprint.
Harder: Cannot hot-reload these services without a server restart. Cannot be
distributed to third parties as installable plugins. The plugin SDK's entity
scope model is no longer available for these services — schema must be designed
explicitly.
```

## Appendix B: ADR-002 — Mission as Primary Unit of Work

```
# ADR-002: Introduce Mission as Primary Unit of Work Above Issues

## Status
Accepted

## Context
paperclip's issue is a self-contained unit of work. papercompany needs a
container that spans multiple issues, maintains agent session context, and
carries governance rules (worktree). Without a Mission layer, agents lose
context between runs, workflows have no natural grouping, and the channel
integration has no clear command target.

## Decision
Add a missions table as a parent of issues. Missions are the primary navigation
item in the UI and the target of Telegram commands. Issues remain unchanged as
the execution unit for individual agent runs.

## Consequences
Easier: Session persistence scoped to a mission, clear workflow grouping,
simpler Telegram command model.
Harder: Existing issue-centric integrations (webhooks, API clients) need to
be mission-aware. The issue list UI becomes a secondary view. Any agent that
currently receives issues directly must now receive them in mission context.
```

## Appendix C: ADR-003 — Long Polling over Webhook for Telegram v1

```
# ADR-003: Use Telegram Long Polling for v1 Channel Integration

## Status
Accepted

## Context
Telegram Bot API supports two update delivery modes: webhook (Telegram pushes
updates via HTTPS POST) and long polling (bot periodically calls getUpdates).
papercompany is self-hosted and operators may deploy behind NAT or firewalls
where exposing a public HTTPS endpoint is operationally difficult.

## Decision
Use long polling (getUpdates with timeout=25) for v1. The message handler
logic is identical between the two modes. Switching to webhook in a future
release requires changing only the bot initialization code.

## Consequences
Easier: Works behind NAT with no reverse proxy or certificate management.
Simpler local development.
Harder: Slightly higher latency than webhook (typically <1 s in practice).
Cannot run multiple bot instances for horizontal scaling (polling conflicts).
Acceptable for v1 single-server deployment.
```
