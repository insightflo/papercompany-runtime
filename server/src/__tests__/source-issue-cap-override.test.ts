// server/src/__tests__/source-issue-cap-override.test.ts
//
// [목적] cap-override applied/success + crash-window recovery + queue-rollback 계약 검증.
//   [test isolation] wakeFn: testWake 주입 — codex spawn 없이 exact-key agentWakeupRequests row 생성(계약 보존).
//   [😎] drainHeartbeatRuns(afterAll) — testWake 는 heartbeat_run 을 안 만들므로 즉시 settle(timeout/ECONNREFUSED 0).
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, issueComments, issues, workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { dispatchSourceIssueNativeResume } from "../services/workflow/source-issue-native-resume.js";
import { buildCapOverridePriorSnapshot, casRestoreCapOverrideSnapshot } from "../services/workflow/source-issue-cap-override-snapshot.js";
import {
  auditEvents, buildCapOverrideAuditPayload, capOwnerAction, drainHeartbeatRuns, FORWARD_APPLIED_AT, MAX_ITER, PRODUCER,
  reloadRun, reloadStepRun, seedCapExhaustedRun, startCapOverrideTestDb, testWake, type SeedOpts,
} from "./helpers/cap-override-fixtures.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`skip cap-override tests: ${support.reason ?? "unsupported host"}`);

describeEP("dispatchSourceIssueNativeResume cap-override applied + crash-window recovery", () => {
  let db!: Awaited<ReturnType<typeof startCapOverrideTestDb>>["db"];
  let testDb!: Awaited<ReturnType<typeof startCapOverrideTestDb>>;
  beforeAll(async () => { testDb = await startCapOverrideTestDb(); db = testDb.db; }, 60_000);
  // no afterEach row clearing — isolation is by randomUUID company scope (all queries company-scoped).
  afterAll(async () => { await drainHeartbeatRuns(db); await testDb.cleanup(); });

  const seed = (overrides: SeedOpts = {}) => seedCapExhaustedRun(db, overrides);
  const call = (s: Awaited<ReturnType<typeof seedCapExhaustedRun>>) =>
    dispatchSourceIssueNativeResume(db, { companyId: s.companyId, issueId: s.producerIssueId, allowBlockedIssue: true, ownerAction: capOwnerAction(s), wakeFn: testWake(db) });

  it("SUCCESS: failed run + completed producer at cap + RC + owner decision → revives run, increments iteration, reopens issue, wakes, audits accepted", async () => {
    const s = await seed();
    const outcome = await call(s);
    expect(outcome.kind).toBe("cap_override_applied");
    if (outcome.kind !== "cap_override_applied") return;
    expect(outcome.fromIteration).toBe(MAX_ITER); expect(outcome.toIteration).toBe(MAX_ITER + 1); expect(outcome.cap).toBe(MAX_ITER);
    expect((await reloadRun(db, s.workflowRunId)).status).toBe("running");
    const producer = await reloadStepRun(db, s.workflowRunId, PRODUCER);
    expect(producer.status).toBe("pending"); expect(producer.iterationIndex).toBe(MAX_ITER + 1); expect(producer.completedAt).toBeNull();
    const [issue] = await db.select().from(issues).where(eq(issues.id, s.producerIssueId));
    expect(["todo", "in_progress"]).toContain(issue.status); expect(issue.completedAt).toBeNull();
    const wakes = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.workflowStepRunId, s.producerStepRunId), eq(agentWakeupRequests.requestKind, "workflow_resume"), eq(agentWakeupRequests.idempotencyKey, `cap-override-wake:${s.ownerDecisionEventId}`)));
    expect(wakes).toHaveLength(1);
    const events = await auditEvents(db, s.companyId);
    expect(events).toHaveLength(1);
    const payload = events[0]!.payload as Record<string, unknown>;
    expect(payload).toEqual(expect.objectContaining({
      status: "accepted",
      ownerActionIssueId: s.ownerActionIssueId,
      decisionCommentId: s.ownerDecisionEventId,
      decisionCommentCreatedAt: new Date("2026-07-10T00:20:00.000Z").toISOString(),
      workflowRunId: s.workflowRunId,
      producerIssueId: s.producerIssueId,
      producerStepId: PRODUCER,
      producerStepRunId: s.producerStepRunId,
      qaStepRunId: s.qaStepRunId,
      fromIteration: MAX_ITER,
      cap: MAX_ITER,
      acceptedWakeupRequestId: wakes[0]!.id,
    }));
  });

  it("DUPLICATE: prior accepted audit (full identity) + accepted wake → already_applied, no second wake/audit", async () => {
    const s = await seed();
    const wakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: wakeId, companyId: s.companyId, agentId: s.producerAgentId, source: "test", status: "queued", workflowRunId: s.workflowRunId, workflowStepRunId: s.producerStepRunId, issueId: s.producerIssueId, requestKind: "workflow_resume", idempotencyKey: `cap-override-wake:${s.ownerDecisionEventId}` });
    await db.insert(workflowTransitionEvents).values({ companyId: s.companyId, missionId: s.missionId, workflowRunId: s.workflowRunId, workflowStepRunId: s.producerStepRunId, issueId: s.producerIssueId, eventType: "owner_cap_override_retry", layer: "workflow_validation", idempotencyKey: `cap-override:${s.ownerDecisionEventId}`, payload: buildCapOverrideAuditPayload(s, { status: "accepted", acceptedWakeupRequestId: wakeId }) });
    const outcome = await call(s);
    expect(outcome.kind).toBe("cap_override_already_applied");
    expect(await auditEvents(db, s.companyId)).toHaveLength(1);
  });

  it("CRASH WINDOW: post-forward state (run running/step pending/issue todo) + pending audit → recovery re-wakes, marks accepted (not already_applied, not rollback)", async () => {
    const s = await seed();
    // simulate the crash window: forward committed, wake never happened.
    await db.update(workflowRuns).set({ status: "running", completedAt: null }).where(eq(workflowRuns.id, s.workflowRunId));
    await db.update(workflowStepRuns).set({ status: "pending", iterationIndex: MAX_ITER + 1, startedAt: null, completedAt: null, lastDispatchAttemptAt: null, lastDispatchAcceptedAt: null, lastDispatchErrorAt: null, lastDispatchErrorSummary: null, lastDispatchRequestId: null, metadata: {} }).where(eq(workflowStepRuns.id, s.producerStepRunId));
    await db.update(issues).set({ status: "todo", completedAt: null, updatedAt: FORWARD_APPLIED_AT }).where(eq(issues.id, s.producerIssueId));
    await db.insert(workflowTransitionEvents).values({ companyId: s.companyId, missionId: s.missionId, workflowRunId: s.workflowRunId, workflowStepRunId: s.producerStepRunId, issueId: s.producerIssueId, eventType: "owner_cap_override_retry", layer: "workflow_validation", idempotencyKey: `cap-override:${s.ownerDecisionEventId}`, payload: buildCapOverrideAuditPayload(s, { status: "pending" }) });
    const outcome = await call(s);
    expect(outcome.kind).toBe("cap_override_applied");
    const events = await auditEvents(db, s.companyId);
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as Record<string, unknown>).status).toBe("accepted");
  });

  it("QUEUE ROLLBACK: non-reopenable (cancelled) producer → forward issue CAS lost → full rollback (issue/run/step/audit unchanged)", async () => {
    const s = await seed({ producerIssueStatus: "cancelled" });
    const outcome = await call(s);
    expect(outcome.kind).toBe("report_only");
    if (outcome.kind === "report_only") expect(outcome.reason).toBe("cap_override_queue_rolled_back");
    expect((await reloadRun(db, s.workflowRunId)).status).toBe("failed");
    expect((await reloadStepRun(db, s.workflowRunId, PRODUCER)).status).toBe("completed");
    expect((await db.select().from(issues).where(eq(issues.id, s.producerIssueId)))[0]!.status).toBe("cancelled");
    expect(await auditEvents(db, s.companyId)).toHaveLength(0);
  });

  it("NO OWNER ACTION: failed run + completed producer without ownerAction → report_only (normal resume unchanged)", async () => {
    const s = await seed();
    const outcome = await dispatchSourceIssueNativeResume(db, { companyId: s.companyId, issueId: s.producerIssueId, allowBlockedIssue: true });
    expect(outcome.kind).toBe("report_only");
  });

  it("NORMAL PATH: running run + ownerAction → normal dispatched wake (cap-override does not interfere)", async () => {
    const s = await seed({ runStatus: "running", producerIteration: 0 });
    const outcome = await dispatchSourceIssueNativeResume(db, { companyId: s.companyId, issueId: s.producerIssueId, allowBlockedIssue: true, agentId: s.producerAgentId, ownerAction: capOwnerAction(s), wakeFn: testWake(db) });
    expect(outcome.kind).toBe("dispatched");
    expect(await auditEvents(db, s.companyId)).toHaveLength(0);
  });

  it("uses the marker-selected QA edge cap instead of Math.max across sibling back-edges", async () => {
    const s = await seed();
    await db.update(workflowDefinitions).set({ stepsJson: [
      { id: PRODUCER, name: "Produce", agentId: s.producerAgentId, dependencies: [], conditionalDependencies: [{ stepId: "qa-validate", when: "qa_request_changes", isBackEdge: true, maxIterations: 1 }, { stepId: "qa-other", when: "qa_request_changes", isBackEdge: true, maxIterations: 5 }] },
      { id: "qa-validate", name: "[QA] Primary", agentId: s.qaAgentId, dependencies: [PRODUCER] },
      { id: "qa-other", name: "[QA] Other", agentId: s.qaAgentId, dependencies: [PRODUCER] },
    ] }).where(eq(workflowDefinitions.id, s.workflowId));
    const outcome = await call(s);
    expect(outcome.kind).toBe("cap_override_applied");
    if (outcome.kind === "cap_override_applied") expect(outcome.cap).toBe(1);
  });

  it("allows a later generation via a new structured owner decision targeting the producer", async () => {
    const s = await seed({ producerIteration: 2 });
    await db.insert(workflowTransitionEvents).values({ companyId: s.companyId, missionId: s.missionId, workflowRunId: s.workflowRunId, workflowStepRunId: s.producerStepRunId, issueId: s.producerIssueId, eventType: "owner_cap_override_retry", layer: "workflow_validation", idempotencyKey: `cap-override:old-decision`, payload: { generation: 1 } });
    const newCommentId = randomUUID();
    const newEventId = randomUUID();
    await db.insert(issueComments).values({ id: newCommentId, companyId: s.companyId, issueId: s.ownerActionIssueId, authorAgentId: s.ownerAgentId, createdAt: new Date("2026-07-10T00:30:00.000Z"), body: `### Mission owner decision\nDecision: retry_source_issue\nSource issue: ${s.producerIssueId}\nReason: new generation retry.` });
    await db.insert(workflowTransitionEvents).values({
      id: newEventId, companyId: s.companyId, missionId: s.missionId, issueId: s.ownerActionIssueId, heartbeatRunId: s.ownerDecisionHeartbeatRunId,
      eventType: "mission_owner_decision", layer: "mission_owner_recovery", decision: "retry_source_issue", reason: "owner_recovery_api", reasonCode: "owner_recovery_api", createdAt: new Date("2026-07-10T00:30:00.000Z"),
      payload: { kind: "mission_owner_decision", source: "owner_recovery_api", ownerActionIssueId: s.ownerActionIssueId, sourceIssueId: s.producerIssueId, commentId: newCommentId, decision: "retry_source_issue", reworkTargetRef: s.producerIssueId },
    });
    const outcome = await dispatchSourceIssueNativeResume(db, { companyId: s.companyId, issueId: s.producerIssueId, allowBlockedIssue: true, ownerAction: capOwnerAction(s, newEventId), wakeFn: testWake(db) });
    expect(outcome.kind).toBe("cap_override_applied");
  });

  it("clears stale producer metadata before wake context is built", async () => {
    const s = await seed({ producerMetadata: { workflowReworkContract: { stale: true }, toolResult: { stale: true }, semanticQaVerdict: "request_changes" } });
    const outcome = await call(s);
    expect(outcome.kind).toBe("cap_override_applied");
    const producer = await reloadStepRun(db, s.workflowRunId, PRODUCER);
    expect(producer.metadata).not.toHaveProperty("workflowReworkContract");
    expect(producer.metadata).not.toHaveProperty("toolResult");
  });

  // [BLOCKER3] rollback CAS: WHERE metadata = cleanedMeta(forward stored), SET prior. stale removable metadata
  //   가 forward 에 의해 cleaned 되고, wake 실패 시 rollback 이 정확히 원복한다(casRestore 직접 검증).
  it("ROLLBACK CAS: stale removable metadata cleaned by forward → wake-failure rollback restores prior metadata (WHERE=cleanedMeta)", async () => {
    const s = await seed({ producerMetadata: { workflowReworkContract: { stale: true }, toolResult: { x: 1 } } });
    const priorRun = await reloadRun(db, s.workflowRunId);
    const priorStep = await reloadStepRun(db, s.workflowRunId, PRODUCER);
    const [priorIssue] = await db.select().from(issues).where(eq(issues.id, s.producerIssueId));
    const cleanedMeta: Record<string, unknown> = {}; // forward clears rework/toolResult keys from {workflowReworkContract,toolResult}
    // simulate post-forward: step pending iter+1 with cleanedMeta, run running, issue todo, audit pending.
    await db.update(workflowStepRuns).set({ status: "pending", iterationIndex: MAX_ITER + 1, startedAt: null, completedAt: null, lastDispatchRequestId: null, metadata: cleanedMeta }).where(eq(workflowStepRuns.id, s.producerStepRunId));
    await db.update(workflowRuns).set({ status: "running", completedAt: null }).where(eq(workflowRuns.id, s.workflowRunId));
    await db.update(issues).set({ status: "todo", completedAt: null, updatedAt: FORWARD_APPLIED_AT }).where(eq(issues.id, s.producerIssueId));
    const auditKey = `cap-override:rollback-${s.producerStepRunId}`;
    await db.insert(workflowTransitionEvents).values({ companyId: s.companyId, workflowRunId: s.workflowRunId, workflowStepRunId: s.producerStepRunId, issueId: s.producerIssueId, eventType: "owner_cap_override_retry", layer: "workflow_validation", idempotencyKey: auditKey, payload: { ...buildCapOverrideAuditPayload(s), status: "pending", idempotencyKey: auditKey } });
    const ok = await casRestoreCapOverrideSnapshot(db, {
      companyId: s.companyId,
      snapshot: buildCapOverridePriorSnapshot({ run: priorRun, stepRun: priorStep, issue: priorIssue }),
      cleanedMetadata: cleanedMeta,
      toIteration: MAX_ITER + 1,
      forwardedIssueUpdatedAt: FORWARD_APPLIED_AT.toISOString(),
      auditIdempotencyKey: auditKey,
      auditPayload: buildCapOverrideAuditPayload(s),
    });
    expect(ok).toBe("restored");
    const restored = await reloadStepRun(db, s.workflowRunId, PRODUCER);
    expect(restored.status).toBe("completed");
    expect(restored.metadata).toEqual(priorStep.metadata);   // prior original metadata restored (not cleanedMeta)
    const ev = (await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.idempotencyKey, auditKey)))[0];
    expect((ev!.payload as Record<string, unknown>).status).toBe("rolled_back");   // audit pending→rolled_back (no delete)
  });
});
