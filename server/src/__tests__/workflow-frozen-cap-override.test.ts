import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, issues, workflowRunDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";

import { captureHttpError } from "./helpers/workflow-execution-definition-fixture.js";
import { corruptSnapshotSteps, editLiveDefinition } from "./helpers/workflow-frozen-execution-fixture.js";
import { captureFrozenRecoveryState } from "./helpers/workflow-frozen-recovery-state.js";
import {
  auditEvents,
  buildCapOverrideAuditPayload,
  capOwnerAction,
  drainHeartbeatRuns,
  FORWARD_APPLIED_AT,
  MAX_ITER,
  PRODUCER,
  PRODUCER_ISSUE_UPDATED_AT,
  QA,
  reloadRun,
  reloadStepRun,
  seedCapExhaustedRun,
  startCapOverrideTestDb,
  testWake,
  type Seed,
} from "./helpers/cap-override-fixtures.js";
import { dispatchSourceIssueNativeResume } from "../services/workflow/source-issue-native-resume.js";
import { dispatchCapOverrideWake } from "../services/workflow/source-issue-cap-override-dispatch.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`skip frozen cap-override tests: ${support.reason ?? "unsupported host"}`);

describeEP("frozen cap-override (captured producer graph governs authority, dispatch, recovery)", () => {
  let db!: Awaited<ReturnType<typeof startCapOverrideTestDb>>["db"];
  let testDb!: Awaited<ReturnType<typeof startCapOverrideTestDb>>;
  beforeAll(async () => { testDb = await startCapOverrideTestDb(); db = testDb.db; }, 60_000);
  afterAll(async () => { await drainHeartbeatRuns(db); await testDb.cleanup(); });

  /** run+producer+issue forwarded to the post-forward state + pending audit (race-test seeding pattern). */
  async function seedForwardedPendingAudit() {
    const s = await seedCapExhaustedRun(db, { frozenDefinition: true });
    await db.update(workflowRuns).set({ status: "running", completedAt: null }).where(eq(workflowRuns.id, s.workflowRunId));
    await db.update(workflowStepRuns).set({
      status: "pending", iterationIndex: MAX_ITER + 1, startedAt: null, completedAt: null,
      lastDispatchAttemptAt: null, lastDispatchAcceptedAt: null, lastDispatchErrorAt: null,
      lastDispatchErrorSummary: null, lastDispatchRequestId: null, metadata: {},
    }).where(eq(workflowStepRuns.id, s.producerStepRunId));
    await db.update(issues).set({ status: "todo", completedAt: null, updatedAt: FORWARD_APPLIED_AT }).where(eq(issues.id, s.producerIssueId));
    const payload = buildCapOverrideAuditPayload(s);
    const [audit] = await db.insert(workflowTransitionEvents).values({
      companyId: s.companyId, missionId: s.missionId, workflowRunId: s.workflowRunId,
      workflowStepRunId: s.producerStepRunId, issueId: s.producerIssueId,
      eventType: "owner_cap_override_retry", layer: "workflow_validation",
      idempotencyKey: `cap-override:${s.ownerDecisionEventId}`, payload,
    }).returning({ id: workflowTransitionEvents.id });
    return { s, auditId: audit!.id, payload };
  }

  const freshApplyLiveGraphs = [
    ["backedge removed", (s: Seed) => [
      { id: PRODUCER, name: "Produce artifact", agentId: s.qaAgentId, dependencies: [] },
      { id: QA, name: "[QA] Validate the produced artifact", agentId: s.qaAgentId, dependencies: [PRODUCER] },
    ]],
    ["backedge retained with raised live cap and changed producer assignee", (s: Seed) => [
      { id: PRODUCER, name: "Produce artifact", agentId: s.qaAgentId, dependencies: [], conditionalDependencies: [{ stepId: QA, when: "qa_request_changes", isBackEdge: true, maxIterations: MAX_ITER + 5 }] },
      { id: QA, name: "[QA] Validate the produced artifact", agentId: s.qaAgentId, dependencies: [PRODUCER] },
    ]],
  ] as const;

  it.each(freshApplyLiveGraphs)("fresh apply uses the captured cap/backedge and producer identity despite a live graph edit (%s)", async (_name, liveStepsJson) => {
    const s = await seedCapExhaustedRun(db, { frozenDefinition: true });
    await editLiveDefinition(db, s.workflowId, { stepsJson: liveStepsJson(s) });

    const outcome = await dispatchSourceIssueNativeResume(db, {
      companyId: s.companyId,
      issueId: s.producerIssueId,
      allowBlockedIssue: true,
      ownerAction: capOwnerAction(s),
      wakeFn: testWake(db),
    });

    expect(outcome).toMatchObject({
      kind: "cap_override_applied",
      workflowRunId: s.workflowRunId,
      workflowDefinitionId: s.workflowId,
      fromIteration: MAX_ITER,
      toIteration: MAX_ITER + 1,
      cap: MAX_ITER,
    });
    expect(await reloadRun(db, s.workflowRunId)).toMatchObject({ status: "running", completedAt: null });
    expect(await reloadStepRun(db, s.workflowRunId, PRODUCER)).toMatchObject({ status: "pending", iterationIndex: MAX_ITER + 1 });
    const wakes = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, s.companyId),
      eq(agentWakeupRequests.idempotencyKey, `cap-override-wake:${s.ownerDecisionEventId}`),
      eq(agentWakeupRequests.requestKind, "workflow_resume"),
    ));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.agentId).toBe(s.producerAgentId);
    expect(wakes[0]!.workflowStepRunId).toBe(s.producerStepRunId);
    expect(wakes[0]!.issueId).toBe(s.producerIssueId);
    const audits = await auditEvents(db, s.companyId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.payload).toMatchObject({ status: "accepted", toIteration: MAX_ITER + 1, cap: MAX_ITER });
  });

  it("a captured graph without backedge/cap gains no authority from a live backedge edit", async () => {
    const s = await seedCapExhaustedRun(db, {
      frozenDefinition: true,
      frozenStepsJson: ({ producerAgentId, qaAgentId }) => [
        { id: PRODUCER, name: "Produce artifact", agentId: producerAgentId, dependencies: [] },
        { id: QA, name: "[QA] Validate the produced artifact", agentId: qaAgentId, dependencies: [PRODUCER] },
      ],
    });
    await editLiveDefinition(db, s.workflowId, {
      stepsJson: [
        { id: PRODUCER, name: "Produce artifact", agentId: s.producerAgentId, dependencies: [], conditionalDependencies: [{ stepId: QA, when: "qa_request_changes", isBackEdge: true, maxIterations: MAX_ITER }] },
        { id: QA, name: "[QA] Validate the produced artifact", agentId: s.qaAgentId, dependencies: [PRODUCER] },
      ],
    });

    const outcome = await dispatchSourceIssueNativeResume(db, {
      companyId: s.companyId,
      issueId: s.producerIssueId,
      allowBlockedIssue: true,
      ownerAction: capOwnerAction(s),
      wakeFn: testWake(db),
    });

    expect(outcome).toMatchObject({ kind: "report_only", reason: "cap_override_no_back_edge" });
    expect(await reloadRun(db, s.workflowRunId)).toMatchObject({ status: "failed" });
    expect(await reloadStepRun(db, s.workflowRunId, PRODUCER)).toMatchObject({ status: "completed", iterationIndex: MAX_ITER });
    expect(await auditEvents(db, s.companyId)).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, s.companyId),
      eq(agentWakeupRequests.idempotencyKey, `cap-override-wake:${s.ownerDecisionEventId}`),
    ))).toHaveLength(0);
  });

  it("recovery dispatch recognizes the captured producer identity despite a live backedge-removal edit", async () => {
    const { s, auditId, payload } = await seedForwardedPendingAudit();
    await editLiveDefinition(db, s.workflowId, {
      stepsJson: [
        { id: PRODUCER, name: "Live produce", agentId: s.qaAgentId, dependencies: [] },
        { id: QA, name: "[QA] Validate the produced artifact", agentId: s.qaAgentId, dependencies: [PRODUCER] },
      ],
    });

    const result = await dispatchCapOverrideWake(db, {
      companyId: s.companyId,
      auditId,
      auditIdempotencyKey: `cap-override:${s.ownerDecisionEventId}`,
      payload,
      wakeKey: `cap-override-wake:${s.ownerDecisionEventId}`,
      wakeFn: testWake(db),
      allowBlockedIssue: true,
      mode: "recover",
    });

    expect(result).toMatchObject({ kind: "cap_override_applied", workflowRunId: s.workflowRunId, toIteration: MAX_ITER + 1, cap: MAX_ITER });
    const wakes = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, s.companyId),
      eq(agentWakeupRequests.idempotencyKey, `cap-override-wake:${s.ownerDecisionEventId}`),
    ));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.agentId).toBe(s.producerAgentId);
  });

  it.each(["missing", "corrupt"] as const)("a %s snapshot at entry rejects the recovery dispatch with 422 and leaves the FULL pending state unchanged", async (state) => {
    const { s, auditId, payload } = await seedForwardedPendingAudit();
    if (state === "missing") {
      await db.delete(workflowRunDefinitions).where(eq(workflowRunDefinitions.workflowRunId, s.workflowRunId));
    } else {
      await corruptSnapshotSteps(db.$client, s.workflowRunId);
    }
    const [auditBefore] = await db.select({ payload: workflowTransitionEvents.payload }).from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, auditId));
    expect((auditBefore!.payload as Record<string, unknown>).status).toBe("pending");
    const before = await captureFrozenRecoveryState(db, s.workflowRunId);

    const error = await captureHttpError(dispatchCapOverrideWake(db, {
      companyId: s.companyId,
      auditId,
      auditIdempotencyKey: `cap-override:${s.ownerDecisionEventId}`,
      payload,
      wakeKey: `cap-override-wake:${s.ownerDecisionEventId}`,
      wakeFn: testWake(db),
      allowBlockedIssue: true,
      mode: "recover",
    }));

    expect(error.status).toBe(422);
    expect(error.message).toBe("historical_definition_unproven");
    expect(await captureFrozenRecoveryState(db, s.workflowRunId)).toEqual(before);
    expect(await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, s.companyId),
      eq(agentWakeupRequests.idempotencyKey, `cap-override-wake:${s.ownerDecisionEventId}`),
    ))).toHaveLength(0);
  });

  it.each(["missing", "corrupt"] as const)("fresh apply rejects a %s snapshot with 422 before any state change or target wake", async (state) => {
    const s = await seedCapExhaustedRun(db, { frozenDefinition: true });
    if (state === "missing") {
      await db.delete(workflowRunDefinitions).where(eq(workflowRunDefinitions.workflowRunId, s.workflowRunId));
    } else {
      await corruptSnapshotSteps(db.$client, s.workflowRunId);
    }
    const before = await captureFrozenRecoveryState(db, s.workflowRunId);

    const error = await captureHttpError(dispatchSourceIssueNativeResume(db, {
      companyId: s.companyId,
      issueId: s.producerIssueId,
      allowBlockedIssue: true,
      ownerAction: capOwnerAction(s),
      wakeFn: testWake(db),
    }));

    expect(error.status).toBe(422);
    expect(error.message).toBe("historical_definition_unproven");
    expect(await captureFrozenRecoveryState(db, s.workflowRunId)).toEqual(before);
    expect(await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, s.companyId),
      eq(agentWakeupRequests.idempotencyKey, `cap-override-wake:${s.ownerDecisionEventId}`),
    ))).toHaveLength(0);
  });

  it("corruption introduced after the claim does not wake and restores the baseline prior state", async () => {
    const { s, auditId, payload } = await seedForwardedPendingAudit();

    const result = await dispatchCapOverrideWake(db, {
      companyId: s.companyId,
      auditId,
      auditIdempotencyKey: `cap-override:${s.ownerDecisionEventId}`,
      payload,
      wakeKey: `cap-override-wake:${s.ownerDecisionEventId}`,
      wakeFn: testWake(db),
      allowBlockedIssue: true,
      mode: "fresh",
      afterClaim: async () => { await corruptSnapshotSteps(db.$client, s.workflowRunId); },
    });

    expect(result).toMatchObject({ kind: "report_only", reason: "cap_override_queue_rolled_back" });
    expect(await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, s.companyId),
      eq(agentWakeupRequests.idempotencyKey, `cap-override-wake:${s.ownerDecisionEventId}`),
    ))).toHaveLength(0);
    expect(await reloadRun(db, s.workflowRunId)).toMatchObject({ status: "failed", completedAt: expect.any(Date) });
    expect(await reloadStepRun(db, s.workflowRunId, PRODUCER)).toMatchObject({ status: "completed", iterationIndex: MAX_ITER });
    const [issue] = await db.select().from(issues).where(eq(issues.id, s.producerIssueId));
    expect(issue).toMatchObject({ status: "todo", updatedAt: PRODUCER_ISSUE_UPDATED_AT });
  });
});
