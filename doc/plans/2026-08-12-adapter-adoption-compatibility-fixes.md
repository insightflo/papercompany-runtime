# Adapter Adoption Compatibility Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Track every step with the checkbox (`- [ ]`) syntax below. Stop after each task for review. This repository owner explicitly forbids commit steps for this work.

**Goal:** Make the adopted adapter/API-key changes safe to run by adding explicit local responsibility authority, deterministic legacy-key reconciliation, focused extractions for oversized mixed files, and operator documentation without changing heartbeat execution.

**Architecture:** Server key issuance receives an explicit responsibility-authority context rather than treating the `local-board` identifier as globally trusted. Migration 0087 becomes a replay-safe, single-transaction reconciliation that computes decisions in a temporary machine relation, persists a secret-free report before mutation, backfills exactly-one eligible candidates, and revokes unresolved active keys. Read-only reporting and the three extractions remain separate modules with narrow typed interfaces.

**Tech Stack:** TypeScript 5.x, Express, Drizzle ORM, PostgreSQL/embedded-postgres, postgres.js, Vitest 3, pnpm workspaces, SQL migrations.

## Global Constraints

- Work only in `/Users/kwak/orca/workspaces/papercompany-runtime/adapter-adoption-integration` on branch `insightflo/adapter-adoption-integration` from base `22b73b8201449a049d3da63f964906c7ccc96228`.
- The approved pre-plan dirty baseline is exactly **45 tracked modified + 20 untracked = 65 paths**, with **0 staged paths**. Preserve it. The plan document itself is a separate planning artifact and raises the visible count by one before implementation.
- Keep company boundaries, actual-user binding, single-use plaintext credentials, mutating activity logs, HTTP/WebSocket fail-closed behavior, and existing agent status guards intact.
- Use an explicit authority context. Never globally authorize the string `local-board`.
- A responsible user must exist in `user` and have either an active same-company user membership or the exact `instance_admin` role.
- Agent-authored prose, comments, Markdown, stdout, stderr, and activity-log prose/JSON are never execution authority. SQL mutations must join the transaction-local decision relation.
- Every new TypeScript implementation, test, or support file in this plan must be at most 300 lines. `packages/adapter-utils/src/types.ts` is the approved existing-file exception; do not enlarge it for these fixes.
- Keep every tracked path containing `heartbeat` byte-identical to base `22b73b8`.
- Do not modify `packages/db/src/client.ts`, `packages/db/src/migrate.ts`, `packages/db/src/migration-runtime.ts`, `packages/db/src/test-embedded-postgres.ts`, migration journal/snapshots, `scripts/dev-runner.mjs`, or heartbeat code.
- Do not create a new migration number. Modify only the existing untracked `0087_agent_api_keys_responsibility_scope.sql`.
- Do not run `pnpm db:generate`, `drizzle-kit push`, or a migration against any real/local operator database. Migration tests may use only disposable embedded PostgreSQL.
- Do not start, restart, deploy, or smoke a running service. Do not push. Do not stage or commit. This plan intentionally contains no commit step.
- Observe RED before changing the production code for each task. A skipped embedded-PostgreSQL test is not RED or GREEN evidence.
- If embedded PostgreSQL fails because the machine has `libicudata.77.dylib` while the binary requests `.77.1`, report that blocker verbatim; do not mask, symlink, or classify skipped tests as passing.
- Apply the smallest requested diff. No heartbeat, queue, workflow, scheduler, runner, generic migration-gate, auth redesign, claim transaction refactor, or unrelated cleanup.

## File Map and Ownership

### Existing baseline paths that this plan may edit further

- `server/src/services/agent-api-key-policy.ts` — explicit authority and binding policy.
- `server/src/__tests__/agent-api-key-policy.test.ts` — policy matrix.
- `server/src/services/agents.ts` — required context on `createApiKey`.
- `server/src/routes/agents.ts` — direct key route context.
- `server/src/routes/access.ts` — durable join-approval context before secret consumption.
- `packages/db/src/migrations/0087_agent_api_keys_responsibility_scope.sql` — transactional reconciliation.
- `packages/adapter-utils/src/server-utils.ts` — compatibility imports/re-exports after extraction.
- `packages/adapter-utils/src/server-utils-env.test.ts` — direct-module and compatibility-path checks.
- `packages/adapters/openclaw-gateway/src/server/execute.ts` — wake-context consumer and compatibility exports.
- `packages/adapters/openclaw-gateway/src/server/test.ts` — probe consumer; protocol fallback remains here.
- `packages/adapters/openclaw-gateway/vitest.config.ts` — give the package an explicit Vitest project name for root-suite discovery checks.

### Previously clean tracked paths this plan may modify

- `packages/db/package.json` — reporter CLI script only.
- `vitest.config.ts` — include OpenClaw in the root full suite.
- `doc/SPEC-implementation.md` — additive normative contract.

### New implementation, test, and operator paths

- `server/src/__tests__/agent-api-key-local-route.integration.test.ts`
- `server/src/__tests__/agent-api-key-join-claim.integration.test.ts`
- `packages/db/src/agent-api-key-responsibility-report.ts`
- `packages/db/src/agent-api-key-responsibility-report-cli.ts`
- `packages/db/src/agent-api-key-responsibility-test-fixture.ts`
- `packages/db/src/agent-api-key-responsibility-report.test.ts`
- `packages/db/src/agent-api-key-responsibility-migration.test.ts`
- `packages/adapter-utils/src/paperclip-env.ts`
- `packages/adapters/openclaw-gateway/src/server/wake-context.ts`
- `packages/adapters/openclaw-gateway/src/server/wake-context.test.ts`
- `packages/adapters/openclaw-gateway/src/server/gateway-probe.ts`
- `packages/adapters/openclaw-gateway/src/server/gateway-probe.test.ts`
- `doc/runbooks/agent-api-key-responsibility-upgrade.md`

### Planning artifact, not an implementation-path addition

- `doc/plans/2026-08-12-adapter-adoption-compatibility-fixes.md`

### Explicitly forbidden paths and actions

- No edits under `server/src/services/*heartbeat*`, any scheduler/queue/workflow implementation, or any heartbeat test.
- No edits to DB migration runners, migration journals, snapshots, generated schema artifacts, `doc/DATABASE.md`, or unrelated adapter files.
- No broad formatter, dependency upgrade, package reinstall, schema generation, real migration, service process, commit, push, deploy, or restart.

---

### Task 1: Make API-key responsibility authority explicit

**Files:**
- Modify: `server/src/__tests__/agent-api-key-policy.test.ts`
- Modify: `server/src/services/agent-api-key-policy.ts`
- Modify: `server/src/services/agents.ts:605-630`
- Modify: `server/src/routes/agents.ts:1917-1921`
- Modify: `server/src/routes/access.ts:2794-2825`

**Interfaces:**
- Produces:
  ```ts
  export type AgentApiKeyResponsibilityAuthority =
    | "authenticated_user"
    | "local_implicit_board";

  export type AgentApiKeyResponsibilityContext = {
    authority: AgentApiKeyResponsibilityAuthority;
  };

  export function requireAgentApiKeyResponsibleUser(
    responsibleUserId: string | null | undefined,
    context: AgentApiKeyResponsibilityContext,
  ): string;

  export async function requireAgentApiKeyResponsibleUserBinding(
    db: Db,
    companyId: string,
    responsibleUserId: string | null | undefined,
    context: AgentApiKeyResponsibilityContext,
  ): Promise<string>;
  ```
- Changes `agentService(db).createApiKey` to require the same context:
  ```ts
  createApiKey(
    id: string,
    name: string,
    responsibleUserId: string | null | undefined,
    context: AgentApiKeyResponsibilityContext,
  ): Promise<{ id: string; name: string; token: string; createdAt: Date }>;
  ```
- Preserves `loadAgentApiKeyResponsibleUser(db, companyId, responsibleUserId)` unchanged as a read-only binding lookup.
- For this task only, both route callers pass `{ authority: "authenticated_user" }` so typecheck is restored without enabling local issuance. Task 2 changes the route-specific selection after its RED tests exist.

- [ ] **Step 1: Add the policy RED matrix**

  Extend `agent-api-key-policy.test.ts` with explicit context constants and assertions:

  ```ts
  const authenticated = { authority: "authenticated_user" } as const;
  const localImplicit = { authority: "local_implicit_board" } as const;

  expect(() => requireAgentApiKeyResponsibleUser(null, authenticated))
    .toThrowError(/real responsible user/i);
  expect(() => requireAgentApiKeyResponsibleUser("local-board", authenticated))
    .toThrowError(/real responsible user/i);
  expect(requireAgentApiKeyResponsibleUser("local-board", localImplicit))
    .toBe("local-board");
  expect(() => requireAgentApiKeyResponsibleUser("ordinary-user", localImplicit))
    .toThrowError(/local implicit/i);
  ```

  Retain DB-backed cases and pass the explicit context to each call. Cover: missing user row, foreign-company membership only, suspended membership, active same-company membership, role rows without an actual user, and an actual user with exact `instance_admin` role.

- [ ] **Step 2: Run the policy test and capture RED**

  Run:

  ```sh
  pnpm vitest run server/src/__tests__/agent-api-key-policy.test.ts
  ```

  Expected: FAIL because current functions accept one argument and reject `local-board` even under explicit local authority. If embedded PostgreSQL is skipped, stop and report the environment blocker rather than counting this step.

- [ ] **Step 3: Implement the minimal authority gate**

  In `agent-api-key-policy.ts`, normalize once and enforce exact authority/identifier pairing before the existing DB binding lookup:

  ```ts
  const normalized = responsibleUserId?.trim() || null;
  if (!normalized) throw responsibleUserRequired();

  if (
    context.authority === "authenticated_user" &&
    normalized === "local-board"
  ) {
    throw responsibleUserRequired();
  }

  if (
    context.authority === "local_implicit_board" &&
    normalized !== "local-board"
  ) {
    throw forbidden("Local implicit responsibility must bind to local-board", {
      code: "RESPONSIBLE_USER_REQUIRED",
    });
  }
  ```

  Keep the existing `RESPONSIBLE_USER_REQUIRED` and `RESPONSIBLE_USER_UNAVAILABLE` error contracts. Do not let local authority skip the actual `user` + membership/instance-admin check.

- [ ] **Step 4: Thread the required context through the service and both callers**

  Import the context as a type in `agents.ts`; pass it from `createApiKey` to `requireAgentApiKeyResponsibleUserBinding`. Temporarily pass `{ authority: "authenticated_user" }` from both `routes/agents.ts` and `routes/access.ts`. Pass `req.actor.userId ?? null` from the direct route instead of converting local actor identity to `null`.

  Confirm all call sites are accounted for:

  ```sh
  rg -n "createApiKey\(|requireAgentApiKeyResponsibleUser(Binding)?\(" server/src
  ```

  Expected: every invocation includes the context argument; no compatibility default or optional authority remains.

- [ ] **Step 5: Run GREEN policy checks and server typecheck**

  Run:

  ```sh
  pnpm vitest run server/src/__tests__/agent-api-key-policy.test.ts
  pnpm --filter @paperclipai/server typecheck
  ```

  Expected: PASS. Direct/join local issuance remains denied until Task 2.

---

### Task 2: Enable only the two approved local-trusted issuance paths

**Files:**
- Create: `server/src/__tests__/agent-api-key-local-route.integration.test.ts`
- Create: `server/src/__tests__/agent-api-key-join-claim.integration.test.ts`
- Modify: `server/src/routes/agents.ts:1917-1921`
- Modify: `server/src/routes/access.ts:2755-2838`

**Interfaces:**
- Consumes `AgentApiKeyResponsibilityContext` and the required `createApiKey` signature from Task 1.
- Direct route authority derives only from `req.actor.source === "local_implicit"`; it still passes the actual `req.actor.userId`.
- Join authority derives only from the current route option plus the durable approved row:
  ```ts
  function responsibilityContextForJoinClaim(
    deploymentMode: DeploymentMode,
    joinRequest: Pick<
      typeof joinRequests.$inferSelect,
      "status" | "approvedAt" | "approvedByUserId"
    >,
  ): AgentApiKeyResponsibilityContext;
  ```
  Keep this helper private to `access.ts` unless extraction is needed solely to remain under the existing-file exception; do not create a generic authorization abstraction.

- [ ] **Step 1: Write direct-route integration RED tests**

  Build the test with `startEmbeddedPostgresTestDatabase()`, seed `local-board` into `user`, exact `instance_admin` or active same-company membership, a company, and an active agent. Exercise the real Express app in `local_trusted` mode. Assert:

  ```ts
  expect(createResponse.status).toBe(201);
  expect(createdRow.responsibleUserId).toBe("local-board");
  expect(await authenticateReturnedToken(createResponse.body.token))
    .toMatchObject({ type: "agent", agentId, companyId });
  ```

  Add negative cases for a non-`local_implicit` board/session actor presenting `userId: "local-board"`, missing `local-board` user binding, and existing pending/terminated agent guards. The pseudo-local cases must return 403 and create no key.

- [ ] **Step 2: Write join-claim integration RED tests**

  Seed approved agent join rows and exact claim metadata. Test:

  - local-trusted + `status=approved` + non-null `approvedAt` + `approvedByUserId=local-board` succeeds;
  - returned key binds to `local-board` and authenticates through the real HTTP API-key middleware;
  - authenticated deployment rejects a historical local-board approval;
  - missing approval timestamp rejects;
  - missing user, foreign membership, suspended membership reject;
  - actual eligible authenticated approver succeeds;
  - actual `instance_admin` with a real user succeeds;
  - every policy rejection leaves `claimSecretConsumedAt` null and creates no key.

  Use a secret sentinel such as `claim-secret-MUST-NOT-LEAK` and assert it does not appear in response bodies or activity details.

- [ ] **Step 3: Run both files and capture RED**

  Run:

  ```sh
  pnpm vitest run \
    server/src/__tests__/agent-api-key-local-route.integration.test.ts \
    server/src/__tests__/agent-api-key-join-claim.integration.test.ts
  ```

  Expected: direct local create and local join claim return 403 because Task 1 deliberately passes authenticated authority. Returned-token assertions cannot be reached. Reject/secret-consumption assertions should already pass.

- [ ] **Step 4: Select direct-route authority from actor source only**

  Replace the temporary context with:

  ```ts
  const responsibilityContext: AgentApiKeyResponsibilityContext =
    req.actor.source === "local_implicit"
      ? { authority: "local_implicit_board" }
      : { authority: "authenticated_user" };

  const key = await svc.createApiKey(
    id,
    req.body.name,
    req.actor.userId ?? null,
    responsibilityContext,
  );
  ```

  Do not use deployment mode, a user-ID string comparison, board actor type, session presence, or board API-key presence as a substitute for `source === "local_implicit"`.

- [ ] **Step 5: Select join authority from deployment mode and durable approval**

  Before responsibility validation, require all four local facts:

  ```ts
  const responsibilityContext: AgentApiKeyResponsibilityContext =
    opts.deploymentMode === "local_trusted" &&
    joinRequest.status === "approved" &&
    joinRequest.approvedAt !== null &&
    joinRequest.approvedByUserId === "local-board"
      ? { authority: "local_implicit_board" }
      : { authority: "authenticated_user" };
  ```

  Pass the same context to the pre-consumption `requireAgentApiKeyResponsibleUserBinding` call and to `agents.createApiKey`. Preserve the order:

  1. row/type/status/created-agent metadata;
  2. claim-secret validity/expiry/unused checks;
  3. no existing key;
  4. responsibility binding;
  5. claim-secret consumption;
  6. key creation and structured claim activity.

  Do not move responsibility validation after secret consumption and do not make claim/key creation transactional in this bounded change.

- [ ] **Step 6: Run focused server GREEN and fail-closed regressions**

  Run:

  ```sh
  pnpm vitest run \
    server/src/__tests__/agent-api-key-policy.test.ts \
    server/src/__tests__/agent-api-key-local-route.integration.test.ts \
    server/src/__tests__/agent-api-key-join-claim.integration.test.ts \
    server/src/__tests__/agent-auth-middleware.test.ts \
    server/src/__tests__/agent-auth-jwt.test.ts \
    server/src/__tests__/live-events-ws-replay.test.ts
  pnpm --filter @paperclipai/server typecheck
  ```

  Expected: PASS, including returned-token HTTP authentication and existing WebSocket responsibility fail-closed behavior. Do not broaden JWT behavior; it is a regression surface, not a new responsibility-authority source.

---

### Task 3: Add the read-only v1 responsibility reporter and CLI

**Files:**
- Create: `packages/db/src/agent-api-key-responsibility-report.test.ts`
- Create: `packages/db/src/agent-api-key-responsibility-report.ts`
- Create: `packages/db/src/agent-api-key-responsibility-report-cli.ts`
- Modify: `packages/db/package.json`

**Interfaces:**

```ts
export const AGENT_API_KEY_RESPONSIBILITY_MIGRATION =
  "0087_agent_api_keys_responsibility_scope" as const;
export const AGENT_API_KEY_RESPONSIBILITY_REPORT_ACTION =
  "agent_api_key.responsibility_migration_reported" as const;

export type AgentApiKeyResponsibilitySource =
  | "direct_key_created"
  | "join_claim";
export type AgentApiKeyResponsibilityDecision =
  | "backfill"
  | "revoke"
  | "preserve_revoked";
export type AgentApiKeyResponsibilityReportMode = "preview" | "stored";
export type AgentApiKeyResponsibilityRequestedMode =
  | "auto"
  | "preview"
  | "stored";

export type AgentApiKeyResponsibilityCandidate = {
  userId: string;
  sources: AgentApiKeyResponsibilitySource[];
  eligible: boolean;
  eligibilityReasonCodes: string[];
};

export type AgentApiKeyResponsibilityReportKey = {
  keyId: string;
  companyId: string;
  agentId: string;
  keyName: string;
  decision: AgentApiKeyResponsibilityDecision;
  reasonCodes: string[];
  candidates: AgentApiKeyResponsibilityCandidate[];
  resolvedUserId: string | null;
  requiresOperatorAction: boolean;
};

export type AgentApiKeyResponsibilityReport = {
  schemaVersion: 1;
  migration: typeof AGENT_API_KEY_RESPONSIBILITY_MIGRATION;
  mode: AgentApiKeyResponsibilityReportMode;
  generatedAt: string;
  summary: {
    totalKeys: number;
    backfillCount: number;
    revokeCount: number;
    preserveRevokedCount: number;
    requiresOperatorActionCount: number;
  };
  keys: AgentApiKeyResponsibilityReportKey[];
};

export function previewAgentApiKeyResponsibilityReport(
  connectionString: string,
): Promise<AgentApiKeyResponsibilityReport>;
export function readStoredAgentApiKeyResponsibilityReceipt(
  connectionString: string,
): Promise<AgentApiKeyResponsibilityReport>;
export function exportAgentApiKeyResponsibilityReport(
  connectionString: string,
  requestedMode?: AgentApiKeyResponsibilityRequestedMode,
): Promise<AgentApiKeyResponsibilityReport>;
```

Reason codes are a closed implementation contract:

- decision: `exactly_one_eligible_candidate`, `no_provenance`, `no_eligible_candidate`, `conflicting_eligible_candidates`, `already_revoked`;
- eligibility: `active_company_membership`, `instance_admin`, `user_not_found`, `company_membership_missing`, `company_membership_inactive`.

Sort keys by `(companyId, agentId, keyId)`, candidates by `userId`, and every source/reason array lexicographically.

- [ ] **Step 1: Write reporter RED tests**

  Import the absent reporter module. Test pure normalization/aggregation plus disposable-DB preview behavior:

  - direct provenance;
  - exact join claim + join approval provenance;
  - duplicate direct/join evidence from the same user becomes one candidate with two sorted sources;
  - no provenance is not rescued by an unrelated administrator;
  - missing/foreign/suspended users remain in candidates but are ineligible;
  - two eligible users produce `conflicting_eligible_candidates`;
  - revoked keys produce `preserve_revoked`;
  - repeated preview calls have identical `summary` and `keys` after excluding `generatedAt`;
  - stored mode throws `AgentApiKeyResponsibilityReceiptNotFoundError` only when no exact receipt exists;
  - stored mode rejects malformed details, an unsupported `schemaVersion`, or a wrong migration/action/actor contract instead of silently accepting it;
  - auto mode falls back to preview only for the exact receipt-not-found error and propagates malformed-receipt/database errors;
  - CLI parsing accepts only `auto|preview|stored`, emits JSON only on stdout, redacts connection strings from errors, and calls `stop()` on success and failure;
  - serialized output excludes key hash, plaintext key, claim secret/hash, DB URL, credentials, authorization/session values, and the sentinel `MUST-NOT-LEAK`.

- [ ] **Step 2: Run reporter tests and capture RED**

  Run:

  ```sh
  pnpm --filter @paperclipai/db exec vitest run \
    src/agent-api-key-responsibility-report.test.ts
  ```

  Expected: FAIL with module resolution for `agent-api-key-responsibility-report.ts`.

- [ ] **Step 3: Implement preview and stored reads in explicit read-only transactions**

  Use `postgres(connectionString, { max: 1 })`, `sql.begin("read only", ...)`, and `finally { await sql.end(); }`. Preview queries must not reference `responsible_user_id` or `scope_config`, because operators run preview before 0087. Match provenance exactly:

  ```sql
  -- direct_key_created
  al.action = 'agent.key_created'
  AND al.entity_type = 'agent'
  AND al.entity_id = k.agent_id::text
  AND al.company_id = k.company_id
  AND al.actor_type = 'user'
  AND al.details->>'keyId' = k.id::text

  -- join_claim plus durable approved join and exact approval activity
  claim.action = 'agent_api_key.claimed'
  AND claim.entity_type = 'agent_api_key'
  AND claim.entity_id = k.id::text
  AND claim.details->>'agentId' = k.agent_id::text
  AND claim.details->>'joinRequestId' = jr.id::text
  AND jr.request_type = 'agent'
  AND jr.status = 'approved'
  AND jr.approved_at IS NOT NULL
  AND jr.claim_secret_consumed_at IS NOT NULL
  AND jr.company_id = k.company_id
  AND jr.created_agent_id = k.agent_id
  AND approved.action = 'join.approved'
  AND approved.entity_type = 'join_request'
  AND approved.entity_id = jr.id::text
  AND approved.actor_type = 'user'
  AND approved.actor_id = jr.approved_by_user_id
  ```

  Compare malformed JSON IDs as text; never cast historical JSON to UUID. Eligibility requires an actual `user` row plus active same-company `company_memberships(principal_type='user')` or exact `instance_user_roles.role='instance_admin'`.

  Stored mode reads only exact `AGENT_API_KEY_RESPONSIBILITY_REPORT_ACTION` rows whose actor is `system` / `migration:0087_agent_api_keys_responsibility_scope`, validates `schemaVersion === 1` and migration name, then aggregates. If no valid stored rows exist, throw a stable `AgentApiKeyResponsibilityReceiptNotFoundError`. Auto mode tries stored and falls back to preview only for that exact error.

- [ ] **Step 4: Add the JSON-only CLI**

  Add this package script:

  ```json
  "report:agent-api-key-responsibility": "tsx src/agent-api-key-responsibility-report-cli.ts"
  ```

  Export a testable boundary and invoke it only when the file is the process entry point:

  ```ts
  export type AgentApiKeyResponsibilityReportCliDependencies = {
    resolveConnection: typeof resolveMigrationConnection;
    exportReport: typeof exportAgentApiKeyResponsibilityReport;
    writeStdout(value: string): void;
    writeStderr(value: string): void;
  };

  export async function runAgentApiKeyResponsibilityReportCli(
    args: string[],
    deps?: AgentApiKeyResponsibilityReportCliDependencies,
  ): Promise<number>;
  ```

  The CLI must:

  - parse only `--mode auto|preview|stored`, default `auto`;
  - call existing `resolveMigrationConnection()` from `./migration-runtime.js`;
  - print exactly `JSON.stringify(report, null, 2)` plus a newline to stdout;
  - send errors to stderr without printing connection strings;
  - always call `resolved.stop()` in `finally`;
  - return exit code `0` on success and `1` on a sanitized failure;
  - avoid schema mutation and avoid importing migration application code.

  Unit-test this exported boundary with fake dependencies; do not connect to an operator database to test CLI behavior.

- [ ] **Step 5: Run reporter GREEN, CLI shape check, and DB typecheck**

  Run:

  ```sh
  pnpm --filter @paperclipai/db exec vitest run \
    src/agent-api-key-responsibility-report.test.ts
  pnpm --filter @paperclipai/db typecheck
  ```

  Expected: PASS. Do not point the CLI at a real database during implementation; test its argument parsing/output through dependency injection or a spawned test with a disposable connection only.

---

### Task 4: Make migration 0087 transactional, deterministic, and replay-safe

**Files:**
- Create: `packages/db/src/agent-api-key-responsibility-test-fixture.ts`
- Create: `packages/db/src/agent-api-key-responsibility-migration.test.ts`
- Modify: `packages/db/src/migrations/0087_agent_api_keys_responsibility_scope.sql`

**Interfaces:**
- Consumes the v1 constants, field names, decisions, reasons, and sort rules from Task 3.
- Fixture exposes only test-owned helpers:
  ```ts
  export type LegacyResponsibilityDatabase = {
    connectionString: string;
    apply0087(): Promise<void>;
    reset0087HistoryOnly(): Promise<void>;
    cleanup(): Promise<void>;
  };

  export function startLegacyResponsibilityDatabase(
    testName: string,
  ): Promise<LegacyResponsibilityDatabase>;
  ```
- `apply0087()` must call the same public `applyPendingMigrations(connectionString)` path used by production; it must not execute the SQL file directly.

- [ ] **Step 1: Build a disposable pre-0087 fixture**

  Start with `startEmbeddedPostgresTestDatabase(testName)`, compute the checked-in 0087 file SHA-256, remove only that migration-history row, and restore pre-0087 shape in this order:

  ```sql
  DROP INDEX IF EXISTS agent_api_keys_responsible_user_idx;
  ALTER TABLE agent_api_keys
    DROP CONSTRAINT IF EXISTS agent_api_keys_responsible_user_id_user_id_fk;
  ALTER TABLE agent_api_keys DROP COLUMN IF EXISTS scope_config;
  ALTER TABLE agent_api_keys DROP COLUMN IF EXISTS responsible_user_id;
  ```

  Seed legacy rows using raw postgres.js SQL so the fixture can insert precise company, agent, user, membership, role, join, activity, and key provenance. Keep this support file at or below 300 lines; share compact seed builders rather than duplicating setup in both tests.

- [ ] **Step 2: Write migration RED scenarios**

  In `agent-api-key-responsibility-migration.test.ts`, cover:

  1. direct provenance backfills the exact eligible actor;
  2. join provenance backfills the exact eligible approver;
  3. duplicate evidence for the same user remains one candidate;
  4. no provenance, missing user, foreign membership, suspended membership, and conflicting eligible users revoke active keys;
  5. an unrelated administrator is never selected;
  6. already revoked/null keys remain revoked and unbound;
  7. already-bound keys remain unchanged on replay;
  8. one exact report action exists per staged key and one exact revoke-audit action exists per key actually revoked;
  9. capture preview **before applying 0087**, then compare it with the post-apply stored report after removing `mode` and `generatedAt`;
  10. no forbidden sentinel or secret-shaped field appears in stored details;
  11. report insertion failure rolls back DDL, report, key mutation, revoke audit, and migration history;
  12. two concurrent `applyPendingMigrations()` calls serialize the 0087 data body: one report/key, one revoke audit/actually-revoked key, and the final invariant hold;
  13. deleting only 0087 history and applying again is data-idempotent;
  14. final query returns zero active keys with null responsibility.

  The fixed lock is acquired inside 0087 after the existing runner's pre-check. It guarantees serialization and idempotency of the 0087 DDL/report/backfill/revoke body, but this bounded plan does **not** claim exactly one migration-history row if two runner processes both pass their pre-check before either obtains the SQL lock. Changing that runner ordering is explicitly out of scope; record the observed history-row count in the concurrency test without authorizing a runner edit.

- [ ] **Step 3: Run migration tests and capture RED**

  Run:

  ```sh
  pnpm --filter @paperclipai/db exec vitest run \
    src/agent-api-key-responsibility-migration.test.ts
  ```

  Expected current-0087 failures: direct/join responsibility remains null, unresolved active keys remain active, report rows are absent, replay hits duplicate DDL, and no advisory serialization evidence exists. A skipped embedded DB is a blocker, not successful RED.

- [ ] **Step 4: Make DDL replay-safe under a transaction advisory lock**

  Keep statement-breakpoint separators compatible with the existing runner. Start with:

  ```sql
  SELECT pg_advisory_xact_lock(870087001::bigint);
  --> statement-breakpoint
  ALTER TABLE "agent_api_keys"
    ADD COLUMN IF NOT EXISTS "responsible_user_id" text;
  --> statement-breakpoint
  ALTER TABLE "agent_api_keys"
    ADD COLUMN IF NOT EXISTS "scope_config" jsonb;
  --> statement-breakpoint
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'agent_api_keys_responsible_user_id_user_id_fk'
        AND conrelid = 'agent_api_keys'::regclass
    ) THEN
      ALTER TABLE "agent_api_keys"
        ADD CONSTRAINT "agent_api_keys_responsible_user_id_user_id_fk"
        FOREIGN KEY ("responsible_user_id") REFERENCES "public"."user"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION;
    END IF;
  END $$;
  --> statement-breakpoint
  CREATE INDEX IF NOT EXISTS "agent_api_keys_responsible_user_idx"
    ON "agent_api_keys" USING btree ("responsible_user_id");
  ```

  The existing migration runner already wraps the complete file and history insert in one explicit transaction. Do not add `BEGIN`/`COMMIT` to SQL and do not edit the runner.

- [ ] **Step 5: Materialize one machine decision row per unbound key**

  Create `pg_temp._paperclip_0087_agent_key_decisions ON COMMIT DROP` with:

  ```sql
  key_id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  key_name text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('backfill','revoke','preserve_revoked')),
  reason_codes jsonb NOT NULL,
  candidates jsonb NOT NULL,
  resolved_user_id text,
  requires_operator_action boolean NOT NULL,
  report_activity_id uuid
  ```

  Populate it with CTEs named `direct_evidence`, `join_evidence`, `candidate_evidence`, `candidate_eligibility`, and `per_key_decision`. Use distinct user IDs so repeated evidence from one user is not a conflict. Decision rules are exact:

  ```sql
  CASE
    WHEN k.revoked_at IS NOT NULL THEN 'preserve_revoked'
    WHEN eligible_candidate_count = 1 THEN 'backfill'
    ELSE 'revoke'
  END
  ```

  `resolved_user_id` is non-null only for exact-one eligible candidates. `requires_operator_action` is true only for active keys decided `revoke`. Candidate JSON contains only `userId`, sorted `sources`, `eligible`, and sorted `eligibilityReasonCodes`.

- [ ] **Step 6: Persist the v1 report before any key mutation**

  Under the advisory lock, reuse an existing exact report row for a staged key or allocate `gen_random_uuid()`, store it in `report_activity_id`, then insert only absent rows:

  ```sql
  INSERT INTO activity_log (
    id, company_id, actor_type, actor_id, action,
    entity_type, entity_id, agent_id, details
  )
  SELECT
    d.report_activity_id,
    d.company_id,
    'system',
    'migration:0087_agent_api_keys_responsibility_scope',
    'agent_api_key.responsibility_migration_reported',
    'agent_api_key',
    d.key_id::text,
    d.agent_id,
    jsonb_build_object(
      'schemaVersion', 1,
      'migration', '0087_agent_api_keys_responsibility_scope',
      'generatedAt', transaction_timestamp(),
      'key', jsonb_build_object(
        'keyId', d.key_id,
        'companyId', d.company_id,
        'agentId', d.agent_id,
        'keyName', d.key_name,
        'decision', d.decision,
        'reasonCodes', d.reason_codes,
        'candidates', d.candidates,
        'resolvedUserId', d.resolved_user_id,
        'requiresOperatorAction', d.requires_operator_action
      )
    )
  FROM pg_temp._paperclip_0087_agent_key_decisions d
  WHERE NOT EXISTS (
    SELECT 1 FROM activity_log existing
    WHERE existing.id = d.report_activity_id
  );
  ```

  Never include `key_hash`, plaintext tokens, claim secrets/hashes, database URLs, credentials, auth headers, cookies, or session values.

- [ ] **Step 7: Backfill/revoke from the temp relation and assert the invariant**

  Backfill only active exact-one rows whose responsibility is still null. Revoke unresolved active rows only when the matching report row exists:

  ```sql
  UPDATE agent_api_keys k
  SET responsible_user_id = d.resolved_user_id
  FROM pg_temp._paperclip_0087_agent_key_decisions d
  WHERE k.id = d.key_id
    AND d.decision = 'backfill'
    AND d.resolved_user_id IS NOT NULL
    AND k.responsible_user_id IS NULL
    AND k.revoked_at IS NULL;

  UPDATE agent_api_keys k
  SET revoked_at = transaction_timestamp()
  FROM pg_temp._paperclip_0087_agent_key_decisions d
  JOIN activity_log report
    ON report.id = d.report_activity_id
   AND report.action = 'agent_api_key.responsibility_migration_reported'
  WHERE k.id = d.key_id
    AND d.decision = 'revoke'
    AND k.responsible_user_id IS NULL
    AND k.revoked_at IS NULL;
  ```

  A revoke audit is required. Use stable action `agent_api_key.revoked_by_responsibility_migration` and insert exactly one company-scoped structured row for each key actually changed by the revoke update. Implement the update and audit as one statement using `WITH revoked AS (UPDATE ... RETURNING ...) INSERT INTO activity_log ... SELECT ... FROM revoked`, with an exact action/actor/entity dedupe predicate. The audit is display/evidence only; it must never authorize the update, which continues to join the temp decision relation and the pre-existing report row.

  Finish with a `DO` block that raises if this count is non-zero:

  ```sql
  SELECT count(*) FROM agent_api_keys
  WHERE revoked_at IS NULL AND responsible_user_id IS NULL;
  ```

- [ ] **Step 8: Prove report-before-revoke rollback and serialization**

  For rollback, install a test-only trigger that raises on the exact report action, call the public migration runner, then assert:

  - responsibility columns are absent;
  - `revoked_at` is unchanged;
  - no report row exists;
  - no 0087 history row exists.

  For serialization, call `Promise.all([apply0087(), apply0087()])` against one disposable DB and assert both settle without a data-integrity failure, report count is one per staged key, revoke audit is exactly one per actually revoked key, and the final invariant holds. Query and report the 0087 history-row count as runner evidence, but do not require an exactly-one history result or modify the runner: the lock starts inside the migration transaction after the runner's out-of-transaction history pre-check.

- [ ] **Step 9: Run combined DB GREEN and typecheck**

  Run:

  ```sh
  pnpm --filter @paperclipai/db exec vitest run \
    src/agent-api-key-responsibility-report.test.ts \
    src/agent-api-key-responsibility-migration.test.ts
  pnpm --filter @paperclipai/db typecheck
  ```

  Expected: PASS with the same public migration runner. Do not generate metadata and do not run the migration CLI against a non-disposable database.

---

### Task 5: Extract Paperclip environment construction from `server-utils.ts`

**Files:**
- Modify: `packages/adapter-utils/src/server-utils-env.test.ts`
- Create: `packages/adapter-utils/src/paperclip-env.ts`
- Modify: `packages/adapter-utils/src/server-utils.ts:199-314,959`

**Interfaces:**

```ts
export type BuildPaperclipEnvOptions = {
  context?: Record<string, unknown> | null;
  apiUrl?: string | null;
};

export function buildPaperclipEnv(
  agent: { id: string; companyId: string },
  options?: BuildPaperclipEnvOptions,
): Record<string, string>;
export function isPaperclipRuntimeEnvKey(key: string): boolean;
export function sanitizeInheritedPaperclipEnv(
  env: NodeJS.ProcessEnv,
): Record<string, string>;
export function buildPaperclipExecutionEnv(
  runtimeEnv: Record<string, string>,
  configuredEnv: unknown,
  authToken?: string | null,
): Record<string, string>;
```

- Preserve all exports through `@paperclipai/adapter-utils/server-utils`.
- Also allow direct import from `@paperclipai/adapter-utils/paperclip-env` through the existing wildcard package export.
- `runChildProcess()` in `server-utils.ts` continues to use an imported `sanitizeInheritedPaperclipEnv` binding.

- [ ] **Step 1: Add direct-module and compatibility RED assertions**

  Change the test to import both modules directly and assert function identity/behavior:

  ```ts
  import * as env from "./paperclip-env.js";
  import * as compatibility from "./server-utils.js";

  expect(compatibility.buildPaperclipEnv).toBe(env.buildPaperclipEnv);
  expect(compatibility.buildPaperclipExecutionEnv)
    .toBe(env.buildPaperclipExecutionEnv);
  expect(compatibility.sanitizeInheritedPaperclipEnv)
    .toBe(env.sanitizeInheritedPaperclipEnv);
  ```

  Keep runtime-over-config precedence, configured/inherited Paperclip-key stripping, provider credential preservation, and explicit auth-token precedence tests.

- [ ] **Step 2: Run and capture RED**

  Run:

  ```sh
  pnpm --filter @paperclipai/adapter-utils exec vitest run \
    src/server-utils-env.test.ts
  ```

  Expected: FAIL because `paperclip-env.ts` does not exist.

- [ ] **Step 3: Move the cohesive environment block without behavior changes**

  Move the existing `server-utils.ts:199-314` implementation and option type into `paperclip-env.ts`. Do not import `parseObject` back from `server-utils.ts`; use a local non-array object guard:

  ```ts
  function asObject(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }
  ```

  In `server-utils.ts`, import `sanitizeInheritedPaperclipEnv` for internal use and re-export the complete public set:

  ```ts
  import { sanitizeInheritedPaperclipEnv } from "./paperclip-env.js";
  export {
    type BuildPaperclipEnvOptions,
    buildPaperclipEnv,
    buildPaperclipExecutionEnv,
    isPaperclipRuntimeEnvKey,
    sanitizeInheritedPaperclipEnv,
  } from "./paperclip-env.js";
  ```

  Do not add these functions to `src/index.ts`; existing consumers use the server-utils subpath and wildcard exports already expose the new direct module.

- [ ] **Step 4: Run focused GREEN and environment regressions**

  Run:

  ```sh
  pnpm --filter @paperclipai/adapter-utils exec vitest run \
    src/server-utils-env.test.ts
  pnpm vitest run \
    server/src/__tests__/paperclip-env.test.ts \
    server/src/__tests__/*-local-adapter-environment.test.ts \
    server/src/__tests__/adapter-registry.test.ts
  pnpm --filter @paperclipai/adapter-utils typecheck
  pnpm --filter @paperclipai/server typecheck
  ```

  Expected: PASS with unchanged environment values and secret precedence.

---

### Task 6: Extract OpenClaw wake-context construction

**Files:**
- Create: `packages/adapters/openclaw-gateway/src/server/wake-context.test.ts`
- Create: `packages/adapters/openclaw-gateway/src/server/wake-context.ts`
- Modify: `packages/adapters/openclaw-gateway/src/server/execute.ts:22-33,276-479,1121-1150`

**Interfaces:**

```ts
export type OpenClawWakePayload = {
  runId: string;
  agentId: string;
  companyId: string;
  taskId: string | null;
  issueId: string | null;
  wakeReason: string | null;
  wakeCommentId: string | null;
  approvalId: string | null;
  approvalStatus: string | null;
  issueIds: string[];
};

export type OpenClawWakeContext = {
  wakePayload: OpenClawWakePayload;
  wakeText: string;
  paperclipEnv: Record<string, string>;
  payloadTemplate: Record<string, unknown>;
};

export function buildOpenClawWakeContext(
  ctx: AdapterExecutionContext,
  payloadTemplate: Record<string, unknown>,
): OpenClawWakeContext;
export function appendWakeText(baseText: string, wakeText: string): string;
export function resolveClaimedApiKeyPath(value: unknown): string;
export function buildStandardPaperclipPayload(
  ctx: AdapterExecutionContext,
  wakePayload: OpenClawWakePayload,
  paperclipEnv: Record<string, string>,
  payloadTemplate: Record<string, unknown>,
): Record<string, unknown>;
```

- Preserve source-level compatibility exports for `buildStandardPaperclipPayload` and `resolveClaimedApiKeyPath` from `execute.ts`.
- Keep process execution, gateway calls, session behavior, and protocol code in `execute.ts`.

- [ ] **Step 1: Write wake-context RED tests**

  Cover task/issue fallback, legacy `commentId` compatibility, unsupported extra payload preservation, the existing behavior that ignores an invalid `paperclipApiUrl` override and keeps the default URL, workspace/workspaces/runtime service context, claimed API-key path defaulting, template text followed by wake text, and absence of the actual API-key value in wake text.

- [ ] **Step 2: Run and capture RED**

  Run:

  ```sh
  pnpm --filter @paperclipai/adapter-openclaw-gateway exec vitest run \
    --config vitest.config.ts \
    src/server/wake-context.test.ts
  ```

  Expected: FAIL because `wake-context.ts` does not exist.

- [ ] **Step 3: Move wake construction and reduce the consumer**

  Move only `WakePayload` and the cohesive wake helpers from current `execute.ts:22-33,276-479`. Replace the `1121-1150` setup with one `buildOpenClawWakeContext()` call plus `appendWakeText()`. Keep the same serialized property names and defaults. Re-export the two previously imported test helpers from `execute.ts`.

- [ ] **Step 4: Run focused OpenClaw GREEN**

  Run:

  ```sh
  pnpm --filter @paperclipai/adapter-openclaw-gateway exec vitest run \
    --config vitest.config.ts \
    src/server/wake-context.test.ts \
    src/server/execute.test.ts \
    src/server/protocol.test.ts
  pnpm --filter @paperclipai/adapter-openclaw-gateway typecheck
  ```

  Expected: PASS with no execution-protocol behavior change.

---

### Task 7: Extract the single-protocol gateway probe and register package tests

**Files:**
- Create: `packages/adapters/openclaw-gateway/src/server/gateway-probe.test.ts`
- Create: `packages/adapters/openclaw-gateway/src/server/gateway-probe.ts`
- Modify: `packages/adapters/openclaw-gateway/src/server/test.ts:83-214,307-330`
- Modify: `packages/adapters/openclaw-gateway/vitest.config.ts`
- Modify: `vitest.config.ts`

**Interfaces:**

```ts
export type GatewayProbeStatus = "ok" | "challenge_only" | "failed";
export type GatewayProbeInput = {
  url: string;
  headers: Record<string, string>;
  authToken: string | null;
  password: string | null;
  role: string;
  scopes: string[];
  protocol: GatewayProtocolSelection;
  timeoutMs: number;
};
export type GatewayProbeResult = {
  status: GatewayProbeStatus;
  protocolMismatch: boolean;
};
export function probeGateway(
  input: GatewayProbeInput,
): Promise<GatewayProbeResult>;
```

- `gateway-probe.ts` owns WebSocket/random UUID setup, raw-data conversion, object guards, mismatch recognition, timeout, and one-protocol probe.
- `test.ts` retains `resolveGatewayProtocol`, `fallbackGatewayProtocol`, first-attempt/fallback orchestration, and info/warn/error rendering. Fallback happens at most once and never inside `probeGateway`.

- [ ] **Step 1: Write probe RED tests with a local WebSocket test server**

  Test: challenge triggers the correct connect frame; accepted response returns `ok`; structured protocol mismatch returns `challenge_only` plus `protocolMismatch: true`; generic auth rejection does not mark mismatch; missing nonce, socket close, and timeout return `failed`; cleanup closes client/server and timers after every case.

- [ ] **Step 2: Run and capture RED**

  Run:

  ```sh
  pnpm --filter @paperclipai/adapter-openclaw-gateway exec vitest run \
    --config vitest.config.ts \
    src/server/gateway-probe.test.ts
  ```

  Expected: FAIL because `gateway-probe.ts` does not exist.

- [ ] **Step 3: Move the single-protocol probe and preserve fallback orchestration**

  Move current `test.ts:83-214` helpers and probe implementation. Change `test.ts:307-330` to call the imported function for the selected protocol, then once for `fallbackGatewayProtocol()` only when `protocolMismatch` is true. Preserve current status messages and error categorization.

- [ ] **Step 4: Give OpenClaw an explicit test-project name and register it at the root**

  In `packages/adapters/openclaw-gateway/vitest.config.ts`, preserve the Node environment and add the stable project name:

  ```ts
  test: {
    name: "openclaw-gateway",
    environment: "node",
  }
  ```

  Add exactly this project entry to the root `vitest.config.ts`:

  ```ts
  "packages/adapters/openclaw-gateway",
  ```

  This is an explicit safety addition discovered during plan verification: the package already has a config, but current `pnpm test:run` does not discover it. Do not alter other projects or package scripts.

- [ ] **Step 5: Run focused GREEN and prove root discovery**

  Run:

  ```sh
  pnpm --filter @paperclipai/adapter-openclaw-gateway exec vitest run \
    --config vitest.config.ts \
    src/server/gateway-probe.test.ts \
    src/server/wake-context.test.ts \
    src/server/execute.test.ts \
    src/server/protocol.test.ts
  pnpm vitest run --project openclaw-gateway
  pnpm --filter @paperclipai/adapter-openclaw-gateway typecheck
  ```

  Expected: PASS and the root command reports the OpenClaw project rather than “no test files found.”

---

### Task 8: Document the normative policy and operator upgrade procedure

**Files:**
- Modify: `doc/SPEC-implementation.md`
- Create: `doc/runbooks/agent-api-key-responsibility-upgrade.md`

**Interfaces:**
- Documentation must use the exact constants, decisions, commands, and invariant query defined in Tasks 1–4.
- Documentation is explanatory only and is never read by runtime control flow.

- [ ] **Step 1: Add the API-key responsibility contract to the implementation spec**

  Additive edits only:

  - §7.3: add `responsible_user_id` and `scope_config`; state that every active key has non-null responsibility and eligibility means an actual user plus active same-company user membership or exact instance admin.
  - Agent auth/API sections: direct create and join claim use the same binding policy; only explicit `local_implicit` in local-trusted mode can bind `local-board`; authenticated/session/board-key pseudo-local and historical local approvals in authenticated mode reject.
  - State HTTP and WebSocket both fail closed when key responsibility is missing, unavailable, suspended, or out of company.
  - §15.2: specify deterministic direct/join provenance, exact-one backfill, report-before-mutation, unresolved revoke/reissue, idempotent replay, and one migration-file transaction with history.
  - §16: list report secret exclusions.
  - §17: add policy, direct/join, HTTP/WS, rollback, serialization, idempotency, parity, invariant, and secret-sentinel regressions.

- [ ] **Step 2: Write the operator runbook with exact commands**

  Use these sections in order:

  1. Purpose and interruption risk.
  2. Backup and restoration boundary. Run a one-off backup to an operator-owned directory and verify the returned file is non-empty:
     ```sh
     BACKUP_DIR="${BACKUP_DIR:?set an operator-owned backup directory}"
     pnpm paperclipai db:backup --dir "$BACKUP_DIR" --json > /tmp/paperclip-0087-backup.json
     BACKUP_FILE=$(node -e 'const fs=require("fs");const t=fs.readFileSync("/tmp/paperclip-0087-backup.json","utf8");const m=t.match(/\{[\s\S]*\}/);if(!m)process.exit(1);process.stdout.write(JSON.parse(m[0]).backupFile)')
     test -s "$BACKUP_FILE"
     ```
     State that this repository has no automatic restore command. If restoration is required, stop the upgrade and use the approved PostgreSQL restore procedure for the deployment after confirming target/overwrite direction; do not improvise a restore from this runbook.
  3. Optional read-only preview, saved for later comparison:
     ```sh
     pnpm --filter @paperclipai/db report:agent-api-key-responsibility -- --mode preview \
       > /tmp/agent-api-key-responsibility-preview.json
     ```
  4. Apply checked-in migrations:
     ```sh
     pnpm db:migrate
     ```
  5. Read committed receipt:
     ```sh
     pnpm --filter @paperclipai/db report:agent-api-key-responsibility -- --mode stored \
       > /tmp/agent-api-key-responsibility-stored.json
     ```
  6. Verify invariant:
     ```sql
     SELECT count(*) AS invalid_active_key_count
     FROM agent_api_keys
     WHERE revoked_at IS NULL
       AND responsible_user_id IS NULL;
     ```
     Expected result: `0`.
  7. Reissue keys listed with `requiresOperatorAction: true` through the supported board key-creation API/UI; old plaintext cannot be recovered.
  8. Verify a reissued key over HTTP without echoing it:
     ```sh
     : "${PAPERCLIP_API_URL:?set API origin, for example http://localhost:3200}"
     : "${PAPERCLIP_API_KEY:?set the reissued key without echoing it}"
     curl --fail-with-body --silent --show-error \
       -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
       "$PAPERCLIP_API_URL/api/agents/me" >/tmp/paperclip-agent-me.json
     ```
     Verify WebSocket on `/api/companies/$PAPERCLIP_COMPANY_ID/events/ws` with the bearer header using a client that does not log headers; success means the upgrade returns HTTP 101 and the connection opens. Do not put the token in the query string, shell tracing, command history, or report. If no approved header-capable WebSocket client is installed, record WebSocket verification as not run rather than installing one or exposing the token.
  9. Secret exclusion checklist.
  10. Failure/rollback interpretation.

  Include two bold warnings:

  - `drizzle-kit push` is insufficient because it does not execute 0087 data reconciliation/report/revocation.
  - Automatic migration commits report and revocation together; it does not provide a human pre-ack window.

- [ ] **Step 3: Check documentation terminology and commands**

  Run:

  ```sh
  rg -n "responsible_user_id|scope_config|local_implicit|local-board|responsibility_migration_reported|requiresOperatorAction|db:migrate|drizzle-kit push|WebSocket" \
    doc/SPEC-implementation.md \
    doc/runbooks/agent-api-key-responsibility-upgrade.md
  ```

  Expected: every required term appears in the intended section, and the runbook uses the exact package script/action from Tasks 3–4.

---

### Task 9: Run focused/full verification and prove scope accounting

**Files:**
- Verify only; no additional source changes unless a failing check identifies an in-scope defect in Tasks 1–8.

**Interfaces:**
- Produces a closeout with separate sections for: original approved plan; actual changed files/behavior; additions beyond the approved design; non-obvious effects; commands and exact results; baseline/new-path accounting; unresolved blockers.

- [ ] **Step 1: Capture the 65-path baseline before the first implementation edit**

  At execution start, exclude this planning artifact and assert the approved count:

  ```sh
  cd /Users/kwak/orca/workspaces/papercompany-runtime/adapter-adoption-integration
  BASE=22b73b8201449a049d3da63f964906c7ccc96228
  PLAN=doc/plans/2026-08-12-adapter-adoption-compatibility-fixes.md
  {
    git diff --name-only "$BASE"
    git ls-files --others --exclude-standard
  } | sort -u | grep -vx "$PLAN" > /tmp/adapter-adoption-baseline-65.txt
  test "$(wc -l < /tmp/adapter-adoption-baseline-65.txt | tr -d ' ')" = 65
  test "$(git diff --cached --name-only | wc -l | tr -d ' ')" = 0
  ```

  Create an exact pre-implementation hash manifest for all 65 existing baseline files:

  ```sh
  python3 - <<'PY'
  import hashlib, pathlib
  inventory = pathlib.Path('/tmp/adapter-adoption-baseline-65.txt')
  output = pathlib.Path('/tmp/adapter-adoption-baseline-sha256.tsv')
  rows = []
  for raw in inventory.read_text().splitlines():
      path = pathlib.Path(raw)
      if not path.is_file():
          raise SystemExit(f'baseline path missing before implementation: {raw}')
      rows.append(f'{hashlib.sha256(path.read_bytes()).hexdigest()}\t{raw}')
  output.write_text('\n'.join(rows) + '\n')
  print(f'wrote {len(rows)} hashes to {output}')
  PY
  ```

  At closeout, any baseline path outside the explicit implementation allow-list must match this manifest.

- [ ] **Step 2: Enforce the new-file 300-line limit and legacy extraction reduction**

  Check all new TypeScript files:

  ```sh
  BASE=22b73b8201449a049d3da63f964906c7ccc96228
  for file in \
    server/src/__tests__/agent-api-key-local-route.integration.test.ts \
    server/src/__tests__/agent-api-key-join-claim.integration.test.ts \
    packages/db/src/agent-api-key-responsibility-report.ts \
    packages/db/src/agent-api-key-responsibility-report-cli.ts \
    packages/db/src/agent-api-key-responsibility-test-fixture.ts \
    packages/db/src/agent-api-key-responsibility-report.test.ts \
    packages/db/src/agent-api-key-responsibility-migration.test.ts \
    packages/adapter-utils/src/paperclip-env.ts \
    packages/adapters/openclaw-gateway/src/server/wake-context.ts \
    packages/adapters/openclaw-gateway/src/server/wake-context.test.ts \
    packages/adapters/openclaw-gateway/src/server/gateway-probe.ts \
    packages/adapters/openclaw-gateway/src/server/gateway-probe.test.ts
  do
    lines=$(wc -l < "$file" | tr -d ' ')
    printf '%4s %s\n' "$lines" "$file"
    test "$lines" -le 300
  done
  ```

  Check that the three mixed legacy files are no longer larger than base:

  ```sh
  for file in \
    packages/adapters/openclaw-gateway/src/server/execute.ts \
    packages/adapters/openclaw-gateway/src/server/test.ts \
    packages/adapter-utils/src/server-utils.ts
  do
    base_lines=$(git show "$BASE:$file" | wc -l | tr -d ' ')
    current_lines=$(wc -l < "$file" | tr -d ' ')
    printf '%4s -> %4s %s\n' "$base_lines" "$current_lines" "$file"
    test "$current_lines" -le "$base_lines"
  done
  ```

- [ ] **Step 3: Run focused tests by subsystem**

  Run exactly:

  ```sh
  pnpm vitest run \
    server/src/__tests__/agent-api-key-policy.test.ts \
    server/src/__tests__/agent-api-key-local-route.integration.test.ts \
    server/src/__tests__/agent-api-key-join-claim.integration.test.ts \
    server/src/__tests__/agent-auth-middleware.test.ts \
    server/src/__tests__/agent-auth-jwt.test.ts \
    server/src/__tests__/live-events-ws-replay.test.ts

  pnpm --filter @paperclipai/db exec vitest run \
    src/agent-api-key-responsibility-report.test.ts \
    src/agent-api-key-responsibility-migration.test.ts

  pnpm --filter @paperclipai/adapter-utils exec vitest run \
    src/server-utils-env.test.ts

  pnpm --filter @paperclipai/adapter-openclaw-gateway exec vitest run \
    --config vitest.config.ts \
    src/server/wake-context.test.ts \
    src/server/gateway-probe.test.ts \
    src/server/execute.test.ts \
    src/server/protocol.test.ts

  pnpm vitest run \
    server/src/__tests__/paperclip-env.test.ts \
    server/src/__tests__/*-local-adapter-environment.test.ts \
    server/src/__tests__/adapter-registry.test.ts
  ```

  Expected: all selected tests execute and pass; no skip is accepted for the DB safety tests.

- [ ] **Step 4: Run focused package typechecks**

  Run:

  ```sh
  pnpm --filter @paperclipai/db typecheck
  pnpm --filter @paperclipai/adapter-utils typecheck
  pnpm --filter @paperclipai/adapter-openclaw-gateway typecheck
  pnpm --filter @paperclipai/server typecheck
  ```

  Expected: PASS.

- [ ] **Step 5: Run the repository completion gate**

  Run:

  ```sh
  pnpm -r typecheck
  pnpm test:run
  pnpm build
  git diff --check
  ```

  Expected: PASS. Report every command separately. Do not claim completion if any command was not run or if OpenClaw/DB tests were silently undiscovered or skipped.

- [ ] **Step 6: Prove heartbeat byte identity**

  Run this tracked-path comparison:

  ```sh
  python3 - <<'PY'
  import hashlib, pathlib, subprocess
  base = "22b73b8201449a049d3da63f964906c7ccc96228"
  paths = subprocess.check_output(
      ["git", "ls-tree", "-r", "--name-only", base], text=True
  ).splitlines()
  heartbeat = [p for p in paths if "heartbeat" in p.lower()]
  assert heartbeat, "no tracked heartbeat paths found"
  for path in heartbeat:
      before = subprocess.check_output(["git", "show", f"{base}:{path}"])
      after = pathlib.Path(path).read_bytes()
      assert hashlib.sha256(before).digest() == hashlib.sha256(after).digest(), path
      print(f"IDENTICAL {path}")
  PY
  ```

  Expected: every tracked heartbeat path prints `IDENTICAL`.

- [ ] **Step 7: Produce base/current line and path accounting**

  Run:

  ```sh
  BASE=22b73b8201449a049d3da63f964906c7ccc96228
  {
    git diff --name-only "$BASE"
    git ls-files --others --exclude-standard
  } | sort -u | while IFS= read -r file; do
    test -f "$file" || continue
    if git cat-file -e "$BASE:$file" 2>/dev/null; then
      base_lines=$(git show "$BASE:$file" | wc -l | tr -d ' ')
    else
      base_lines=0
    fi
    current_lines=$(wc -l < "$file" | tr -d ' ')
    printf '%5s %5s %s\n' "$base_lines" "$current_lines" "$file"
  done
  ```

  Closeout accounting must state separately:

  - original pre-plan baseline: 45 tracked + 20 untracked = 65;
  - planning artifact: one file;
  - implementation edits to baseline paths;
  - previously clean tracked paths modified by this plan;
  - new implementation/test/runbook paths;
  - unrelated baseline paths proven unchanged from their pre-implementation hashes;
  - staged count, which must remain zero.

- [ ] **Step 8: Compare out-of-scope baseline hashes, then verify forbidden surfaces and repository state**

  Write the explicit baseline paths that Tasks 1–8 are allowed to change, then compare every other baseline path against the pre-implementation manifest:

  ```sh
  cat >/tmp/adapter-adoption-baseline-allowed-to-change.txt <<'EOF'
  packages/adapter-utils/src/server-utils-env.test.ts
  packages/adapter-utils/src/server-utils.ts
  packages/adapters/openclaw-gateway/src/server/execute.ts
  packages/adapters/openclaw-gateway/src/server/test.ts
  packages/adapters/openclaw-gateway/vitest.config.ts
  packages/db/src/migrations/0087_agent_api_keys_responsibility_scope.sql
  server/src/__tests__/agent-api-key-policy.test.ts
  server/src/routes/access.ts
  server/src/routes/agents.ts
  server/src/services/agent-api-key-policy.ts
  server/src/services/agents.ts
  EOF
  python3 - <<'PY'
  import hashlib, pathlib
  manifest = pathlib.Path('/tmp/adapter-adoption-baseline-sha256.tsv')
  allowed = set(pathlib.Path('/tmp/adapter-adoption-baseline-allowed-to-change.txt').read_text().splitlines())
  for row in manifest.read_text().splitlines():
      expected, raw = row.split('\t', 1)
      if raw in allowed:
          continue
      path = pathlib.Path(raw)
      actual = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else 'MISSING'
      if actual != expected:
          raise SystemExit(f'out-of-scope baseline path changed: {raw}')
  print('all out-of-scope baseline paths unchanged')
  PY
  ```

  Then run:

  ```sh
  BASE=22b73b8201449a049d3da63f964906c7ccc96228
  git diff --cached --name-only
  git status --short --branch
  git diff --name-only "$BASE" | rg -i 'heartbeat|scheduler|queue|workflow|packages/db/src/(client|migrate|migration-runtime|test-embedded-postgres)|migrations/meta' || true
  git diff --check -- \
    doc/plans/2026-08-12-adapter-adoption-compatibility-fixes.md \
    doc/SPEC-implementation.md \
    doc/runbooks/agent-api-key-responsibility-upgrade.md
  ```

  Expected: cached list is empty; out-of-scope baseline hashes match; heartbeat and forbidden DB paths show no current-slice hash changes; no whitespace errors. Existing baseline files with words such as workflow in their path remain classified as pre-existing and must retain their captured hash.

## Review Gate Before Execution

- [ ] Approved Policy A maps to Tasks 1–2, including actual-user binding, exact local authority, direct and join issuance, pre-consumption rejection, and HTTP/WS regressions.
- [ ] Approved Policy B maps to Tasks 3–4, including fixed advisory lock, replay-safe DDL/data body, deterministic provenance, exact-one candidate, report-before-mutation, report-joined revocation, mandatory deduplicated revoke audit, rollback, data idempotency, reporter/CLI, and final invariant. It does not overclaim runner-history uniqueness across two processes that pass the runner pre-check concurrently.
- [ ] All three mixed-file extractions map to Tasks 5–7 and have focused tests and typed interfaces.
- [ ] Normative and operator documentation maps to Task 8.
- [ ] Focused and full verification, line limits, base/current inventory, baseline/new-path separation, and heartbeat identity map to Task 9.
- [ ] No task edits a runner, journal, snapshot, heartbeat, scheduler, queue, or workflow implementation.
- [ ] No task runs schema generation, a real migration, a service, a deploy, a restart, staging, a commit, or a push.
- [ ] Additional safety change beyond the earlier design is explicit: root `vitest.config.ts` registers the existing OpenClaw test project so `pnpm test:run` cannot omit its new tests.
- [ ] Non-obvious operational effect is explicit: unresolved active legacy keys are revoked, cannot be recovered from hashes, and require reissue; the report and revocation become visible together at commit of migration 0087, with no human pre-ack interval.
