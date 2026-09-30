import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agentWakeupRequests, approvals, companies, heartbeatRuns, issues, missions, workflowRecoveryAuthorities, workflowRuns, workflowStepRuns, workflowTerminalDecisions, workflowTransitionEvents } from "@paperclipai/db";
import { buildCapOverrideAuditPayload, FORWARD_APPLIED_AT, MAX_ITER, seedCapExhaustedRun, startCapOverrideTestDb, testWake } from "./helpers/cap-override-fixtures.js";
import { dispatchCapOverrideWake } from "../services/workflow/source-issue-cap-override-dispatch.js";
import { casRestoreCapOverrideSnapshot, parseCapOverridePriorSnapshot } from "../services/workflow/source-issue-cap-override-snapshot.js";

describe("cap recovery locked refusal and durable dispatch", () => {
  let fixture: Awaited<ReturnType<typeof startCapOverrideTestDb>>;
  beforeAll(async () => { fixture = await startCapOverrideTestDb(); }, 60_000);
  afterAll(async () => { await fixture.cleanup(); });
  async function seed() {
    const db = fixture.db, s = await seedCapExhaustedRun(db);
    await db.update(workflowRuns).set({ status: "running", completedAt: null }).where(eq(workflowRuns.id, s.workflowRunId));
    await db.update(workflowStepRuns).set({ status: "pending", iterationIndex: MAX_ITER + 1, startedAt: null, completedAt: null,
      lastDispatchAttemptAt: null, lastDispatchAcceptedAt: null, lastDispatchErrorAt: null, lastDispatchErrorSummary: null,
      lastDispatchRequestId: null, metadata: {} }).where(eq(workflowStepRuns.id, s.producerStepRunId));
    await db.update(issues).set({ status: "todo", completedAt: null, updatedAt: FORWARD_APPLIED_AT }).where(eq(issues.id, s.producerIssueId));
    const payload = buildCapOverrideAuditPayload(s);
    const [audit] = await db.insert(workflowTransitionEvents).values({ companyId: s.companyId, missionId: s.missionId,
      workflowRunId: s.workflowRunId, workflowStepRunId: s.producerStepRunId, issueId: s.producerIssueId,
      eventType: "owner_cap_override_retry", layer: "workflow_validation", idempotencyKey: `cap-override:${s.ownerDecisionEventId}`, payload }).returning();
    return { ...s, payload, auditId: audit.id };
  }
  async function snapshot(s: Awaited<ReturnType<typeof seed>>) {
    const db = fixture.db;
    return { runs: await db.select().from(workflowRuns).where(eq(workflowRuns.id, s.workflowRunId)),
      steps: await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, s.workflowRunId)),
      issues: await db.select().from(issues).where(eq(issues.companyId, s.companyId)),
      events: await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.companyId, s.companyId)),
      wakes: await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, s.companyId)) };
  }
  function dispatch(s: Awaited<ReturnType<typeof seed>>, wakeFn = testWake(fixture.db)) {
    return dispatchCapOverrideWake(fixture.db, { companyId: s.companyId, auditId: s.auditId,
      auditIdempotencyKey: `cap-override:${s.ownerDecisionEventId}`, payload: s.payload,
      wakeKey: `cap-override-wake:${s.ownerDecisionEventId}`, allowBlockedIssue: true, mode: "recover", wakeFn });
  }
  it.each(["cancel", "mission_cancel", "budget", "live", "replaced"])("%s refuses dispatch and restore with every row unchanged", async (variant) => {
    const s = await seed(), db = fixture.db;
    if (variant === "replaced") {
      const [approval] = await db.insert(approvals).values({ companyId: s.companyId, type: "workflow_replacement", status: "approved", payload: {} }).returning();
      const [target] = await db.insert(workflowRuns).values({ companyId: s.companyId, missionId: s.missionId, workflowId: s.workflowId, triggeredBy: "test" }).returning();
      const [terminal] = await db.insert(workflowTerminalDecisions).values({ companyId: s.companyId, workflowRunId: s.workflowRunId,
        decidedAuthorityVersion: 0, decision: "failed", policyCause: "recovery_deadline_hard", discoveryPath: "stuck_diagnostic", origin: "reconciler" }).returning();
      await db.insert(workflowRecoveryAuthorities).values({ companyId: s.companyId, workflowRunId: s.workflowRunId,
        targetAuthorityVersion: 0, resultingAuthorityVersion: 0, targetDecisionId: terminal.id, recoveryKind: "replacement_from_start_v1",
        requestedBy: "test", requestReference: randomUUID(), ownerDecisionEventId: s.ownerDecisionEventId,
        operatorApprovalId: approval.id, replacementRunId: target.id, requestHash: "a".repeat(64), replacementContract: {} });
    }
    if (variant === "cancel") await db.update(workflowRuns).set({ status: "cancelled" }).where(eq(workflowRuns.id, s.workflowRunId));
    if (variant === "mission_cancel") await db.update(missions).set({ status: "cancelled" }).where(eq(missions.id, s.missionId));
    if (variant === "budget") await db.update(companies).set({ budgetMonthlyCents: 1, spentMonthlyCents: 1 }).where(eq(companies.id, s.companyId));
    if (variant === "live") await db.insert(heartbeatRuns).values({ companyId: s.companyId, agentId: s.producerAgentId,
      issueId: s.producerIssueId, workflowStepRunId: s.producerStepRunId, status: "running" });
    const before = await snapshot(s);
    expect((await dispatch(s)).kind).toBe("report_only");
    expect(await snapshot(s)).toEqual(before);
    expect(await casRestoreCapOverrideSnapshot(db, { companyId: s.companyId, snapshot: parseCapOverridePriorSnapshot(s.payload.priorSnapshot)!,
      cleanedMetadata: {}, toIteration: MAX_ITER + 1, forwardedIssueUpdatedAt: FORWARD_APPLIED_AT.toISOString(),
      auditIdempotencyKey: `cap-override:${s.ownerDecisionEventId}`, auditPayload: s.payload })).toBe("lost");
    expect(await snapshot(s)).toEqual(before);
  });
  it("mission-lock cancellation wins before a waiting cap dispatcher without audit or queue writes", async () => {
    const s = await seed(), db = fixture.db;
    let release!: () => void, locked!: () => void;
    const gate = new Promise<void>((r) => { release = r; }), ready = new Promise<void>((r) => { locked = r; });
    const cancel = db.transaction(async (tx) => {
      await tx.select().from(missions).where(eq(missions.id, s.missionId)).for("update"); locked(); await gate;
      await tx.update(missions).set({ status: "cancelled" }).where(eq(missions.id, s.missionId));
    });
    await ready;
    const before = await snapshot(s), pending = dispatch(s);
    release(); await cancel;
    expect((await pending).kind).toBe("report_only"); expect(await snapshot(s)).toEqual(before);
  });
  it("accepted audit failure rolls back the queue request in the same transaction", async () => {
    const s = await seed(), db = fixture.db, before = await snapshot(s);
    await db.$client.unsafe(`CREATE FUNCTION fail_cap_accept() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id = '${s.auditId}'::uuid AND NEW.payload->>'status' = 'accepted' THEN RAISE EXCEPTION 'accept crash'; END IF;
      RETURN NEW; END $$; CREATE TRIGGER fail_cap_accept BEFORE UPDATE ON workflow_transition_events FOR EACH ROW EXECUTE FUNCTION fail_cap_accept()`);
    try {
      await dispatch(s).catch(() => undefined);
      expect(await snapshot(s)).toEqual(before);
    } finally { await db.$client.unsafe("DROP TRIGGER fail_cap_accept ON workflow_transition_events; DROP FUNCTION fail_cap_accept()"); }
  });
  it("native cap delivery persists exactly one queue request and never launches a heartbeat before commit", async () => {
    const s = await seed(), db = fixture.db;
    const results = await Promise.all([1, 2].map(() => dispatchCapOverrideWake(db, { companyId: s.companyId, auditId: s.auditId,
      auditIdempotencyKey: `cap-override:${s.ownerDecisionEventId}`, payload: s.payload,
      wakeKey: `cap-override-wake:${s.ownerDecisionEventId}`, allowBlockedIssue: true, mode: "recover" })));
    expect(results.filter((r) => r.kind === "cap_override_applied")).toHaveLength(1);
    const wakes = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, s.companyId),
      eq(agentWakeupRequests.idempotencyKey, `cap-override-wake:${s.ownerDecisionEventId}`)));
    expect(wakes).toHaveLength(1); expect(wakes[0].status).toBe("queued");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, wakes[0].id))).toHaveLength(0);
  });
});
