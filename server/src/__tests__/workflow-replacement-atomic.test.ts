import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, approvals, missions, workflowRuns, workflowStepRuns, workflowRecoveryAuthorities, workflowRunDefinitions, activityLog } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedReplacement } from "./helpers/replacement-scenario.js";
import { admitReplacement } from "../services/workflow/replacement-admission.js";
import { recoverTerminalRun } from "../services/workflow/run-recovery-authority.js";
import { resumeWorkflowRun } from "../services/workflow/workflow-store.js";
import { scheduleWorkflowStepRetry } from "../services/workflow/step-retry-scheduler.js";
import { acceptSourceIssueRecovery } from "../services/workflow/source-issue-recovery-accept.js";
import { claimPlainWorkflowStart } from "../services/workflow/plain-start-claim.js";
import { approvalService } from "../services/approvals.js";
import { approveReplacement } from "../services/workflow/replacement-approval.js";
import { setRunRecoveryFlags } from "./helpers/run-reopen-guard-fixture.js";

describe("atomic replacement (isolated PostgreSQL)", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  const roots: string[] = [];
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("replacement-atomic-"); db = createDb(temp.connectionString); await setRunRecoveryFlags(db, true, true); }, 60_000);
  afterAll(async () => { await db.$client.end(); await temp.cleanup(); roots.forEach((r) => rmSync(r, { recursive: true, force: true })); });
  async function seed() { const s = await seedReplacement(db); roots.push(s.tempRoot); return s; }
  async function state(s: Awaited<ReturnType<typeof seed>>) {
    return { runs: await db.select().from(workflowRuns).where(eq(workflowRuns.companyId, s.companyId)),
      steps: await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, s.run.id)),
      authorities: await db.select().from(workflowRecoveryAuthorities).where(eq(workflowRecoveryAuthorities.companyId, s.companyId)),
      definitions: await db.select().from(workflowRunDefinitions).where(eq(workflowRunDefinitions.companyId, s.companyId)),
      audit: await db.select().from(activityLog).where(eq(activityLog.companyId, s.companyId)) };
  }
  it("same intent contenders consume/create/link once and replay without another start", async () => {
    const s = await seed(); const before = await state(s);
    const results = await Promise.all([admitReplacement(db, s.input, s.actor), admitReplacement(db, s.input, s.actor)]);
    expect(results.filter((r) => !r.replay)).toHaveLength(1);
    expect(results[0].run.id).toBe(results[1].run.id);
    const after = await state(s);
    expect(after.runs).toHaveLength(2); expect(after.authorities).toHaveLength(1); expect(after.definitions).toHaveLength(1);
    expect(after.steps).toEqual(before.steps); expect(after.runs.find((r) => r.id === s.run.id)).toEqual(s.run);
    expect(after.authorities[0]).toMatchObject({ replacementRunId: results[0].run.id, targetAuthorityVersion: 0, resultingAuthorityVersion: 0, status: "consumed" });
    expect(await admitReplacement(db, s.input, s.actor)).toMatchObject({ replay: true });
    expect(await state(s)).toEqual(after);
  });
  it("different intent contenders have one winner", async () => {
    const s = await seed();
    const other = { ...s.input, replacementIntent: { ...s.input.replacementIntent, idempotencyKey: "different" } };
    const results = await Promise.allSettled([admitReplacement(db, s.input, s.actor), admitReplacement(db, other, s.actor)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1); expect((await state(s)).authorities).toHaveLength(1);
  });
  it("replacement versus formal source resume share the same consumption key", async () => {
    const s = await seed();
    const results = await Promise.allSettled([admitReplacement(db, s.input, s.actor), recoverTerminalRun(db, {
      runId: s.run.id, companyId: s.companyId, expectedAuthorityVersion: 0, expectedDecision: "failed", recoveryKind: "manual_resume", requestedBy: "board", now: new Date() })]);
    const after = await state(s); expect(after.authorities).toHaveLength(1);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    if (after.authorities[0].replacementRunId) {
      const before = await state(s); await expect(resumeWorkflowRun(db, s.run.id, s.companyId)).rejects.toThrow("workflow_run_replaced"); expect(await state(s)).toEqual(before);
    } else expect(after.runs).toHaveLength(1);
  });
  it.each(["generation", "cancelled", "mission_cancelled", "approval_rejected", "definition_changed"])("%s rejection writes nothing", async (variant) => {
    const s = await seed();
    if (variant === "generation") await db.update(workflowStepRuns).set({ executionGeneration: 1 }).where(eq(workflowStepRuns.id, s.stepRunId));
    if (variant === "cancelled") await db.update(workflowRuns).set({ status: "cancelled" }).where(eq(workflowRuns.id, s.run.id));
    if (variant === "mission_cancelled") await db.update(missions).set({ status: "cancelled" }).where(eq(missions.id, s.mission.id));
    if (variant === "approval_rejected") await db.update(approvals).set({ status: "rejected" }).where(eq(approvals.id, s.proposal.id));
    if (variant === "definition_changed") await db.$client.unsafe("UPDATE workflow_definitions SET name = 'Changed' WHERE id = $1", [s.run.workflowId]);
    const before = await state(s); await expect(admitReplacement(db, s.input, s.actor)).rejects.toThrow(); expect(await state(s)).toEqual(before);
  });
  it("scheduler and source-issue recovery reject a replaced origin without writes", async () => {
    const s = await seed(); await admitReplacement(db, s.input, s.actor); const before = await state(s);
    const step = before.steps.find((row) => row.id === s.stepRunId)!;
    await expect(scheduleWorkflowStepRetry(db, { companyId: s.companyId, workflowRunId: s.run.id, stepRunId: step.id,
      retryNumber: 1, maxRetries: 2, delaySeconds: 0, observedStatus: "failed", observedRetryCount: step.retryCount,
      observedCompletedAt: step.completedAt, observedLastDispatchRequestId: step.lastDispatchRequestId,
      observedMetadataSnapshot: step.metadata, errorSummary: "test" })).resolves.toMatchObject({ result: "already_changed" });
    expect(await acceptSourceIssueRecovery(db, { run: s.run, stepRunId: step.id, issueId: s.recoveryIssueId })).toBeNull();
    expect(await state(s)).toEqual(before);
  });
  it("linked pending replacement can claim only once and stale target cannot claim", async () => {
    const s = await seed(); const target = (await admitReplacement(db, s.input, s.actor)).run;
    const hook = { activateMission: async () => {} } as never;
    expect(await Promise.all([claimPlainWorkflowStart(db, target.id, hook), claimPlainWorkflowStart(db, target.id, hook)])).toEqual(expect.arrayContaining(["started", "busy"]));
    const other = await seed(); const stale = (await admitReplacement(db, other.input, other.actor)).run;
    await db.update(workflowRuns).set({ dispatchAuthorityVersion: 1 }).where(eq(workflowRuns.id, stale.id));
    expect(await claimPlainWorkflowStart(db, stale.id, hook)).toBe("ineligible");
  });
  it("agent and generic approval paths cannot approve or edit a replacement", async () => {
    const s = await seed(); const before = await db.select().from(approvals).where(eq(approvals.id, s.proposal.id));
    await expect(approveReplacement(db, s.companyId, s.proposal.id, s.actor)).rejects.toThrow("replacement_operator_required");
    await expect(approvalService(db).approve(s.proposal.id, "pretend-board")).rejects.toThrow("board-only");
    await expect(approvalService(db).resubmit(s.proposal.id, {})).rejects.toThrow("board-only");
    expect(await db.select().from(approvals).where(eq(approvals.id, s.proposal.id))).toEqual(before);
  });
  it("mission cancellation owning the lock defeats waiting replacement without partial writes", async () => {
    const s = await seed(); const before = await state(s);
    let release!: () => void, locked!: () => void;
    const gate = new Promise<void>((r) => { release = r; }), ready = new Promise<void>((r) => { locked = r; });
    const cancellation = db.transaction(async (tx) => {
      await tx.select().from(missions).where(eq(missions.id, s.mission.id)).for("update"); locked(); await gate;
      await tx.update(missions).set({ status: "cancelled" }).where(eq(missions.id, s.mission.id));
    });
    await ready; const replacing = admitReplacement(db, s.input, s.actor); release(); await cancellation;
    await expect(replacing).rejects.toThrow(); expect(await state(s)).toEqual(before);
  });
  it("failure after run/snapshot creation rolls back all writes", async () => {
    const s = await seed(); const before = await state(s);
    await db.$client.unsafe(`CREATE FUNCTION fail_replacement_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$;
      CREATE TRIGGER fail_replacement_insert BEFORE INSERT ON workflow_recovery_authorities FOR EACH ROW EXECUTE FUNCTION fail_replacement_insert()`);
    try { await expect(admitReplacement(db, s.input, s.actor)).rejects.toThrow("injected failure"); expect(await state(s)).toEqual(before); }
    finally { await db.$client.unsafe("DROP TRIGGER fail_replacement_insert ON workflow_recovery_authorities; DROP FUNCTION fail_replacement_insert()"); }
  });
});
