import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, companies, heartbeatRuns, missions, workflowRuns, workflowStepRuns, workflowRecoveryAuthorities, workflowTerminalDecisions } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedToolRecoveryScenario } from "./helpers/tool-recovery-scenario.js";
import { setRunRecoveryFlags } from "./helpers/run-reopen-guard-fixture.js";
import { retryIssueLessToolWorkflowStepInternal } from "../services/workflow/retry-issue-less-manual.js";
import { loadWorkflowExecutionContext } from "../services/workflow/workflow-execution-context.js";
import { setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";
import { reconcileDueWorkflowStepRetries } from "../services/workflow/retry-reconciler.js";

describe("atomic issue-less recovery (isolated Postgres)", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const roots: string[] = [];
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("atomic-tool-recovery-");
    db = createDb(temp.connectionString);
    await setRunRecoveryFlags(db, true, true);
  }, 60_000);
  afterAll(async () => { setWorkflowToolStepExecutor(null); await db.$client.end(); await temp.cleanup(); roots.forEach((r) => rmSync(r, { recursive: true, force: true })); });
  async function seed() {
    const s = await seedToolRecoveryScenario({ db, artifactExists: false }); roots.push(s.tempRoot);
    await db.insert(workflowTerminalDecisions).values({ companyId: s.companyId, workflowRunId: s.workflowRunId,
      decidedAuthorityVersion: 0, decision: "failed", policyCause: "recovery_deadline_hard", discoveryPath: "stuck_diagnostic", origin: "reconciler", reason: "test", recoveryGate: {} });
    return s;
  }
  async function snapshot(s: Awaited<ReturnType<typeof seed>>) {
    return { run: await db.select().from(workflowRuns).where(eq(workflowRuns.id, s.workflowRunId)),
      steps: await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, s.workflowRunId)),
      authorities: await db.select().from(workflowRecoveryAuthorities).where(eq(workflowRecoveryAuthorities.workflowRunId, s.workflowRunId)) };
  }
  function retry(s: Awaited<ReturnType<typeof seed>>, extra: Record<string, unknown> = {}) {
    return retryIssueLessToolWorkflowStepInternal({ db, companyId: s.companyId, runId: s.workflowRunId,
      stepId: "collect-us-stockflow", recoveryRequestReference: "same-key",
      expectedFailure: { stepRunId: s.stepRunId, authorityVersion: 0, executionGeneration: 0, dispatchRequestId: null },
      loadWorkflowExecutionContext, isIssueLessToolStep: () => true,
      resetUnlaunchedTerminalStepRuns: async () => [],
      syncWorkflowRunState: async () => ({ status: "running" }) as never, ...extra } as Parameters<typeof retryIssueLessToolWorkflowStepInternal>[0]);
  }
  it("same-key concurrent winner consumes and resets once; loser writes nothing", async () => {
    const s = await seed();
    const results = await Promise.all([retry(s), retry(s)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const after = await snapshot(s);
    expect(after.authorities).toHaveLength(1);
    expect(after.run[0]).toMatchObject({ status: "running", dispatchAuthorityVersion: 1 });
    expect(after.steps.find((r) => r.id === s.stepRunId)).toMatchObject({ status: "pending", executionGeneration: 1 });
    expect(await retry(s)).toBeNull(); expect(await snapshot(s)).toEqual(after);
  });
  it.each(["cancelled", "mission_cancelled", "stale_generation", "stale_dispatch", "stale_version", "consumed", "superseded", "missing_decision", "budget", "live"])("%s denial leaves every recovery row unchanged", async (variant) => {
    const s = await seed();
    if (variant === "budget") await db.update(companies).set({ budgetMonthlyCents: 1, spentMonthlyCents: 1 }).where(eq(companies.id, s.companyId));
    if (variant === "live") {
      const [mission] = await db.select().from(missions).where(eq(missions.companyId, s.companyId));
      await db.insert(heartbeatRuns).values({ companyId: s.companyId, agentId: mission.ownerAgentId, workflowStepRunId: s.stepRunId, status: "running" });
    }
    if (variant === "cancelled") await db.update(workflowRuns).set({ status: "cancelled" }).where(eq(workflowRuns.id, s.workflowRunId));
    if (variant === "mission_cancelled") {
      const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, s.workflowRunId));
      await db.update(missions).set({ status: "cancelled" }).where(eq(missions.id, run.missionId!));
    }
    if (variant === "stale_generation") await db.update(workflowStepRuns).set({ executionGeneration: 1 }).where(eq(workflowStepRuns.id, s.stepRunId));
    if (variant === "stale_dispatch") await db.update(workflowStepRuns).set({ lastDispatchRequestId: randomUUID() }).where(eq(workflowStepRuns.id, s.stepRunId));
    if (variant === "stale_version") await db.update(workflowRuns).set({ dispatchAuthorityVersion: 1 }).where(eq(workflowRuns.id, s.workflowRunId));
    if (variant === "consumed") {
      const [decision] = await db.select().from(workflowTerminalDecisions).where(eq(workflowTerminalDecisions.workflowRunId, s.workflowRunId));
      await db.insert(workflowRecoveryAuthorities).values({ companyId: s.companyId, workflowRunId: s.workflowRunId, targetAuthorityVersion: 0,
        resultingAuthorityVersion: 1, targetDecisionId: decision.id, recoveryKind: "supervision_tool_retry", requestReference: "same-key", requestedBy: "test" });
    }
    if (variant === "missing_decision") await db.delete(workflowTerminalDecisions).where(eq(workflowTerminalDecisions.workflowRunId, s.workflowRunId));
    const before = await snapshot(s);
    expect(await retry(s, variant === "superseded" ? { validateIntent: async () => false } : {})).toBeNull(); expect(await snapshot(s)).toEqual(before);
  });
  it("reset write failure rolls back consumed authority and run reopen", async () => {
    const s = await seed(); const before = await snapshot(s);
    await db.$client.unsafe(`CREATE FUNCTION reject_test_reset() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id = '${s.stepRunId}'::uuid AND NEW.status = 'pending' THEN RAISE EXCEPTION 'reset write failed'; END IF;
      RETURN NEW; END $$; CREATE TRIGGER reject_test_reset BEFORE UPDATE ON workflow_step_runs FOR EACH ROW EXECUTE FUNCTION reject_test_reset()`);
    try {
      await expect(retry(s)).rejects.toThrow("reset write failed");
      expect(await snapshot(s)).toEqual(before);
    } finally { await db.$client.unsafe("DROP TRIGGER reject_test_reset ON workflow_step_runs; DROP FUNCTION reject_test_reset()"); }
  });
  it("cancellation wins between observation and locked acceptance", async () => {
    const s = await seed(); const before = await snapshot(s);
    let release!: () => void; let locked!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const ready = new Promise<void>((r) => { locked = r; });
    const cancellation = db.transaction(async (tx) => {
      await tx.select().from(missions).where(eq(missions.id, before.run[0].missionId!)).for("update");
      locked(); await gate;
      await tx.update(missions).set({ status: "cancelled" }).where(eq(missions.id, before.run[0].missionId!));
      await tx.update(workflowRuns).set({ status: "cancelled" }).where(eq(workflowRuns.id, s.workflowRunId));
    });
    await ready;
    let observed!: () => void;
    const observation = new Promise<void>((r) => { observed = r; });
    const recovery = retry(s, { loadWorkflowExecutionContext: async (...args: Parameters<typeof loadWorkflowExecutionContext>) => {
      const context = await loadWorkflowExecutionContext(...args); observed(); return context;
    } });
    await observation; release(); await cancellation;
    expect(await recovery).toBeNull();
    const after = await snapshot(s);
    expect(after.steps).toEqual(before.steps); expect(after.authorities).toEqual([]);
    expect(after.run[0].status).toBe("cancelled");
  });
  it.each(["recover", "cancel", "stale", "wrong_receipt", "budget", "live"])("postcommit crash: %s only the already accepted attempt", async (variant) => {
    const s = await seed();
    await expect(retry(s, { syncWorkflowRunState: async () => { throw new Error("postcommit crash"); } })).rejects.toThrow("postcommit crash");
    const after = await snapshot(s);
    expect(after.authorities).toHaveLength(1);
    expect(after.steps.find((r) => r.id === s.stepRunId)?.metadata).toMatchObject({ ownerToolRetry: {
      schemaVersion: 1, authorityId: after.authorities[0].id, executionGeneration: 1, authorityVersion: 1,
    } });
    if (variant === "budget") await db.update(companies).set({ budgetMonthlyCents: 1, spentMonthlyCents: 1 }).where(eq(companies.id, s.companyId));
    if (variant === "live") {
      const [mission] = await db.select().from(missions).where(eq(missions.companyId, s.companyId));
      await db.insert(heartbeatRuns).values({ companyId: s.companyId, agentId: mission.ownerAgentId, workflowStepRunId: s.stepRunId, status: "running" });
    }
    if (variant === "cancel") await db.update(workflowRuns).set({ status: "cancelled" }).where(eq(workflowRuns.id, s.workflowRunId));
    if (variant === "stale") await db.update(workflowStepRuns).set({ executionGeneration: 9 }).where(eq(workflowStepRuns.id, s.stepRunId));
    if (variant === "wrong_receipt") await db.update(workflowStepRuns).set({ metadata: { ownerToolRetry: { schemaVersion: 1, authorityId: randomUUID(), authorityVersion: 1, executionGeneration: 1 } } }).where(eq(workflowStepRuns.id, s.stepRunId));
    const beforeDelivery = await snapshot(s);
    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true }));
    await Promise.all([reconcileDueWorkflowStepRetries(db), reconcileDueWorkflowStepRetries(db)]);
    const delivered = await snapshot(s);
    if (variant === "recover") {
      const step = delivered.steps.find((r) => r.id === s.stepRunId)!;
      expect(step.status).toBe("running"); expect(step.lastDispatchRequestId).toBeTruthy();
      expect(step.metadata).toMatchObject({ toolQueue: { status: "queued" }, toolInvocation: { requestId: step.lastDispatchRequestId } });
      await reconcileDueWorkflowStepRetries(db);
      expect(await snapshot(s)).toEqual(delivered);
    } else expect(delivered).toEqual(beforeDelivery);
    expect(delivered.authorities).toEqual(after.authorities);
  });
});
