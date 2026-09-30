import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agentWakeupRequests, companies, createDb, heartbeatRuns, issues, workflowRuns, workflowStepRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { buildCapOverrideAuditPayload, capOwnerAction, FORWARD_APPLIED_AT, seedCapExhaustedRun } from "./helpers/cap-override-fixtures.js";
import { recoverOwnerCapOverride } from "../services/workflow/source-issue-cap-override-recovery.js";

describe("legacy cap pending audit restart compatibility", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("cap-restart-");
    db = createDb(temp.connectionString);
  }, 60_000);
  afterAll(async () => { await db.$client.end(); await temp.cleanup(); });
  async function seedPending() {
    const s = await seedCapExhaustedRun(db);
    await db.update(workflowRuns).set({ status: "running", completedAt: null }).where(eq(workflowRuns.id, s.workflowRunId));
    await db.update(workflowStepRuns).set({ status: "pending", iterationIndex: 2, startedAt: null, completedAt: null,
      lastDispatchAttemptAt: null, lastDispatchAcceptedAt: null, lastDispatchErrorAt: null, lastDispatchErrorSummary: null,
      lastDispatchRequestId: null, metadata: {} }).where(eq(workflowStepRuns.id, s.producerStepRunId));
    await db.update(issues).set({ status: "todo", completedAt: null, updatedAt: FORWARD_APPLIED_AT }).where(eq(issues.id, s.producerIssueId));
    await db.insert(workflowTransitionEvents).values({ companyId: s.companyId, missionId: s.missionId,
      workflowRunId: s.workflowRunId, workflowStepRunId: s.producerStepRunId, issueId: s.producerIssueId,
      eventType: "owner_cap_override_retry", layer: "workflow_validation", idempotencyKey: `cap-override:${s.ownerDecisionEventId}`,
      payload: buildCapOverrideAuditPayload(s) });
    return s;
  }
  async function state(s: Awaited<ReturnType<typeof seedPending>>) {
    return {
      runs: await db.select().from(workflowRuns).where(eq(workflowRuns.id, s.workflowRunId)),
      steps: await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, s.workflowRunId)).orderBy(workflowStepRuns.id),
      issues: await db.select().from(issues).where(eq(issues.companyId, s.companyId)).orderBy(issues.id),
      audits: await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.idempotencyKey, `cap-override:${s.ownerDecisionEventId}`)),
      wakes: await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, `cap-override-wake:${s.ownerDecisionEventId}`)),
    };
  }
  it("fresh service connection recovers the existing pending audit once using native queue only", async () => {
    const s = await seedPending();
    const restarted = createDb(temp.connectionString);
    const input = { companyId: s.companyId, issueId: s.producerIssueId, ownerAction: capOwnerAction(s) };
    try {
      expect((await recoverOwnerCapOverride(restarted, input))?.kind).toBe("cap_override_applied");
      expect((await recoverOwnerCapOverride(restarted, input))?.kind).toBe("cap_override_already_applied");
      const saved = await state(s);
      expect(saved.audits).toHaveLength(1);
      expect(saved.wakes).toHaveLength(1);
      expect(saved.audits[0].payload).toMatchObject({ status: "accepted", acceptedWakeupRequestId: saved.wakes[0].id });
      expect(saved.wakes[0]).toMatchObject({ status: "queued", workflowRunId: s.workflowRunId, workflowStepRunId: s.producerStepRunId });
      expect(saved.steps.find((x) => x.id === s.producerStepRunId)?.iterationIndex).toBe(2);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, saved.wakes[0].id))).toHaveLength(0);
    } finally { await restarted.$client.end(); }
  });
  it("budget-blocked legacy recovery preserves pending state and does not claim a rollback happened", async () => {
    const s = await seedPending();
    await db.update(companies).set({ budgetMonthlyCents: 1, spentMonthlyCents: 1 }).where(eq(companies.id, s.companyId));
    const before = await state(s);
    expect(await recoverOwnerCapOverride(db, { companyId: s.companyId, issueId: s.producerIssueId, ownerAction: capOwnerAction(s) }))
      .toMatchObject({ kind: "report_only", reason: "wake_rejected" });
    expect(await state(s)).toEqual(before);
  });
});
