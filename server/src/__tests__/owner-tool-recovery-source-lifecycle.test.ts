import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agentWakeupRequests, createDb, heartbeatRuns, issues, workflowRecoveryAuthorities, missions, workflowDefinitions, workflowRunDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedToolRecoveryScenario } from "./helpers/tool-recovery-scenario.js";
import { applyOwnerToolRecovery } from "../services/missions/owner-tool-recovery.js";
import { loadToolRecoveryBriefFacts } from "../services/missions/tool-recovery-brief-facts.js";
import { missionService } from "../services/missions.js";
import { completeWorkflowToolStepFromResult, processQueuedWorkflowToolStepRuns, setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";
import { captureExecutionDefinition } from "../services/workflow/execution-definition.js";
import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";
import { createNativeAdapterBoundary, createOwnerToolSourceLifecycleFixture, successfulAdapterResult } from "./helpers/owner-tool-source-lifecycle-fixture.js";
import { assertNativeAssignmentObservation, assertNativeBaseline, assertNativeDownstreamAfterDrain,
  runAndAssertNativeSupervision } from "./helpers/owner-tool-source-lifecycle-observation.js";
const { adapterExecute, assignmentPromises, assignmentInputs } = vi.hoisted(() => ({
  adapterExecute: vi.fn(),
  assignmentPromises: [] as Promise<unknown>[], assignmentInputs: [] as unknown[],
}));
vi.mock("../adapters/index.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../adapters/index.js")>();
  return { ...actual, getServerAdapter: (...args: Parameters<typeof actual.getServerAdapter>) => ({
    ...actual.getServerAdapter(...args), execute: adapterExecute,
  }) };
});
vi.mock("../services/issue-assignment-wakeup.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/issue-assignment-wakeup.js")>();
  return { ...actual, queueIssueAssignmentWakeup: (input: Parameters<typeof actual.queueIssueAssignmentWakeup>[0]) => {
    assignmentInputs.push(input);
    const pending = actual.queueIssueAssignmentWakeup(input);
    if (pending) assignmentPromises.push(pending); return pending;
  } };
});
describe("owner tool source recovery lifecycle (real DB)", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const roots: string[] = [];
  beforeAll(async () => { adapterExecute.mockResolvedValue(successfulAdapterResult()); temp = await startEmbeddedPostgresTestDatabase("owner-tool-source-lifecycle-"); db = createDb(temp.connectionString); }, 60_000);
  const fixture = createOwnerToolSourceLifecycleFixture({ getDb: () => db, roots, assignmentPromises,
    completeToolStep: completeWorkflowToolStepFromResult, captureDefinition: captureExecutionDefinition, assertCompletion: result => expect(result).not.toBeNull() });
  const { seedRecovered, context, decide, currentTarget, lifecycleState, ownerRetryState, nativeDownstreamState } = fixture;
  async function apply(s: Awaited<ReturnType<typeof seedRecovered>>) {
    const { c, issue, sourceIssue } = await context(s); return applyOwnerToolRecovery({ db, mission: c.mission, issue, sourceIssue, stepRows: c.stepRows, apply: true });
  }
  afterEach(async () => { await Promise.all(assignmentPromises.splice(0)); await waitForHeartbeatExecutionsToDrain(db); setWorkflowToolStepExecutor(null); adapterExecute.mockReset().mockResolvedValue(successfulAdapterResult()); assignmentInputs.splice(0); });
  afterAll(async () => { await Promise.all(assignmentPromises.splice(0)); if (db) await waitForHeartbeatExecutionsToDrain(db); setWorkflowToolStepExecutor(null); await temp?.cleanup(); roots.forEach(root => rmSync(root, { recursive: true, force: true })); });
  it("recognizes the exact completed legacy v1 source before missing intent, even with unrelated failed work", async () => {
    const s = await seedRecovered("done");
    await db.insert(workflowTransitionEvents).values({ companyId: s.companyId, missionId: s.missionId,
      issueId: s.recoveryIssueId, layer: "mission_owner_recovery", eventType: "ordinary_transition", idempotencyKey: null, payload: {} });
    await db.insert(workflowStepRuns).values({ workflowRunId: s.workflowRunId, stepId: "unrelated-failed-step",
      issueId: null, status: "failed", startedAt: new Date(), completedAt: new Date(), metadata: { toolResult: { success: false } } });
    const { c, issue, sourceIssue } = await context(s);
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, s.workflowRunId));
    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, s.stepRunId));
    expect(run).toMatchObject({ status: "running", dispatchAuthorityVersion: 2 });
    expect(stepRun).toMatchObject({ status: "completed", executionGeneration: 0, lastDispatchRequestId: expect.any(String) });
    const resolved = await applyOwnerToolRecovery({ db, mission: c.mission, issue, sourceIssue, stepRows: c.stepRows, apply: true });
    expect(resolved).toMatchObject({ outcome: { kind: "no_op", outcome: "blocked", reason: "source_already_recovered", target: null } });
    expect(resolved?.appliedAction).toBeUndefined();
    const row = c.stepRows.find(candidate => candidate.stepRun.id === s.stepRunId)!;
    const step = (row.definition.stepsJson as Array<{ id: string }>).find(candidate => candidate.id === row.stepRun.stepId)!;
    const facts = await loadToolRecoveryBriefFacts(db, { mission: c.mission, oversightIssue: sourceIssue,
      run: row.run, stepRun: row.stepRun, step: step as never, workflowName: row.definition.name });
    expect(facts.execution).toMatchObject({ decision: "source_already_recovered", sourceState: "source_recovered", status: "no_recovery_needed" });
  });
  it("passes exact v1 identity, frozen facts, and structured intent through native retry guards", async () => {
    const s = await seedRecovered("done", true, true);
    const target = await currentTarget(s); await decide(s, target);
    const executor = vi.fn().mockResolvedValue({ accepted: true }); setWorkflowToolStepExecutor(executor);
    const result = await missionService(db).runActiveMissionOwnerSupervision({ companyId: s.companyId, staleAfterMinutes: 1,
      now: new Date(), applyOwnerDecisionActions: true });
    const queued = await ownerRetryState(s), authority = queued.authorities[0]!;
    expect(queued.authorities).toHaveLength(1); expect(queued.run).toMatchObject({ status: "running", dispatchAuthorityVersion: target.expectedAuthorityVersion + 1 });
    expect(authority).toMatchObject({ companyId: s.companyId, workflowRunId: s.workflowRunId, targetAuthorityVersion: target.expectedAuthorityVersion,
      resultingAuthorityVersion: target.expectedAuthorityVersion + 1,
      recoveryKind: "supervision_tool_retry", requestReference: `mission-native-tool-step-retry:${s.missionId}:${s.recoveryIssueId}:${s.workflowRunId}:collect-us-stockflow`,
      status: "consumed", consumedAt: expect.any(Date), ownerDecisionEventId: expect.any(String) });
    expect(queued.stepRun).toMatchObject({ status: "running", executionGeneration: target.expectedExecutionGeneration + 1,
      lastDispatchRequestId: expect.any(String), lastDispatchAcceptedAt: null, lastDispatchErrorAt: null,
      metadata: { ownerToolRetry: { schemaVersion: 1, authorityId: authority.id, authorityVersion: authority.resultingAuthorityVersion,
        executionGeneration: target.expectedExecutionGeneration + 1, ownerActionIssueId: s.recoveryIssueId, decisionEventId: authority.ownerDecisionEventId },
        toolInvocation: { toolName: "collect-us-stockflow" }, toolQueue: { status: "queued" } } });
    const requestId = queued.stepRun.lastDispatchRequestId!, invocation = queued.stepRun.metadata?.toolInvocation as Record<string, unknown>;
    expect(invocation.requestId).toBe(requestId);
    expect(queued.outcomes).toHaveLength(1); expect(queued.outcomes[0]!.payload).toMatchObject({ schema: "recovery_outcome.v1",
      authorityId: authority.id, decisionEventId: authority.ownerDecisionEventId, target, dispatchRequestId: requestId, outcome: "dispatched" });
    expect(result.missions[0]?.recoveryOutcomes).toContainEqual(expect.objectContaining({ kind: "retry_requested", outcome: "dispatched",
      authorityId: authority.id, target, dispatchRequestId: requestId }));
    expect(result.missions[0]?.appliedActions).toContainEqual(expect.objectContaining({ type: "native_tool_step_retry",
      workflowRunId: s.workflowRunId, stepRunId: s.stepRunId }));
    expect(executor).not.toHaveBeenCalled();
    const [frozenDefinition] = await db.select().from(workflowRunDefinitions).where(eq(workflowRunDefinitions.workflowRunId, s.workflowRunId));
    const frozenTool = (frozenDefinition.steps as Array<Record<string, unknown>>).find(step => step.id === "collect-us-stockflow")!;
    expect([frozenTool.agentId, frozenTool.assigneeAgentId, Object.hasOwn(frozenTool, "agentId"), Object.hasOwn(frozenTool, "assigneeAgentId")])
      .toEqual(["", undefined, true, false]);
    const dispatch = await processQueuedWorkflowToolStepRuns(db);
    expect(dispatch).toEqual({ claimedCount: 1, executedCount: 1, failedCount: 0, skippedCount: 0 }); expect(executor).toHaveBeenCalledTimes(1);
    expect(executor.mock.calls[0]![0]).toMatchObject({ companyId: s.companyId, workflowRunId: s.workflowRunId,
      workflowId: queued.run.workflowId, stepRunId: s.stepRunId, stepId: "collect-us-stockflow", toolName: "collect-us-stockflow",
      requestId, executionGeneration: target.expectedExecutionGeneration + 1 });
    expect(executor.mock.calls[0]![0].agentId).toBeUndefined();
    expect(executor.mock.calls[0]![0].args).toEqual(invocation.args);
    const claimed = await ownerRetryState(s);
    expect(claimed.stepRun).toMatchObject({ status: "running", executionGeneration: target.expectedExecutionGeneration + 1,
      lastDispatchRequestId: requestId, lastDispatchAcceptedAt: expect.any(Date), metadata: { toolQueue: { status: "claimed", claimedAt: expect.any(String) },
        toolInvocation: { requestId } } });
    expect(claimed.authorities).toEqual(queued.authorities); expect(claimed.outcomes).toEqual(queued.outcomes);
    expect(await processQueuedWorkflowToolStepRuns(db)).toEqual({ claimedCount: 0, executedCount: 0, failedCount: 0, skippedCount: 0 });
    expect(executor).toHaveBeenCalledTimes(1); expect(await ownerRetryState(s)).toEqual(claimed);
  });
  it("keeps supervision read-only with a downstream assignment and heartbeat boundary spy", async () => {
    const boundary = createNativeAdapterBoundary(); adapterExecute.mockImplementation(boundary.execute);
    let scenario: Awaited<ReturnType<typeof seedRecovered>> | undefined;
    let downstreamWakeId: string | undefined, downstreamIssueId: string | undefined, downstreamGeneration: number | undefined;
    try {
    const s = await seedRecovered("todo"); scenario = s; await boundary.entered;
    const [downstream] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, s.downstreamStepRunId));
    const [downstreamIssue] = await db.select().from(issues).where(eq(issues.id, downstream.issueId!));
    downstreamIssueId = downstreamIssue.id;
    downstreamGeneration = downstream.executionGeneration;
    assertNativeAssignmentObservation({ assignmentInputs, downstream, downstreamIssue, companyId: s.companyId,
      workflowRunId: s.workflowRunId, issueId: downstreamIssue.id });
    const downstreamWakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.issueId, downstreamIssue.id));
    expect(downstreamWakes).toHaveLength(1);
    downstreamWakeId = downstreamWakes[0]!.id;
    expect(downstreamWakes[0]).toMatchObject({ companyId: s.companyId, missionId: s.missionId, source: "assignment", status: "claimed",
      issueId: downstreamIssue.id, workflowRunId: s.workflowRunId, workflowStepRunId: downstream.id,
      workflowExecutionGeneration: downstream.executionGeneration, runId: expect.any(String), claimedAt: expect.any(Date) });
    const { c } = await context(s);
    const executor = vi.fn(); setWorkflowToolStepExecutor(executor);
    const before = await lifecycleState(s);
    assertNativeBaseline({ before, downstreamWakes, downstream, downstreamIssueId: downstreamIssue.id,
      sourceStepRunId: s.stepRunId, downstreamStepRunId: s.downstreamStepRunId, companyId: s.companyId, ownerAgentId: s.ownerAgentId });
    expect(adapterExecute).toHaveBeenCalledTimes(1);
    const supervisionNow = new Date();
    await runAndAssertNativeSupervision({ db, before, sourceStepRunId: s.stepRunId, snapshot: () => lifecycleState(s),
      artifactPath: s.artifactPath, supervise: () => missionService(db).runActiveMissionOwnerSupervision({
        companyId: s.companyId, staleAfterMinutes: 1, now: supervisionNow, applyOwnerDecisionActions: true }),
      settle: () => Promise.all(assignmentPromises.splice(0)), assertBoundaries: () => {
        expect(executor).not.toHaveBeenCalled(); expect(adapterExecute).toHaveBeenCalledTimes(1); expect(assignmentInputs).toHaveLength(1);
      }, companyId: s.companyId, missionId: s.missionId, missionTitle: c.mission.title,
      ownerAgentId: c.mission.ownerAgentId, now: supervisionNow });
    } finally {
      boundary.release();
      try {
        await waitForHeartbeatExecutionsToDrain(db);
        if (scenario) await assertNativeDownstreamAfterDrain(db, scenario, downstreamIssueId!, downstreamWakeId!, downstreamGeneration!);
      }
      finally { adapterExecute.mockReset().mockResolvedValue(successfulAdapterResult()); }
    }
  });
  it.each(["missing_result", "missing_invocation", "unsettled_queue", "mismatched_request", "mismatched_invocation_request",
    "mismatched_queue_request", "mismatched_result_time", "mismatched_queue_time", "failed_legacy", "unrelated_success"])("holds source with %s evidence", async variant => {
    const s = await seedRecovered();
    const { c, issue, sourceIssue } = await context(s);
    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, s.stepRunId));
    const metadata = structuredClone(stepRun.metadata) as Record<string, Record<string, unknown>>;
    if (variant === "missing_result") delete metadata.toolResult;
    if (variant === "missing_invocation") delete metadata.toolInvocation;
    if (variant === "unsettled_queue") metadata.toolQueue.status = "running";
    if (variant === "mismatched_request") metadata.toolResult.requestId = randomUUID();
    if (variant === "mismatched_invocation_request") metadata.toolInvocation.requestId = randomUUID();
    if (variant === "mismatched_queue_request") metadata.toolQueue.requestId = randomUUID();
    if (variant === "mismatched_result_time") metadata.toolResult.completedAt = new Date(0).toISOString();
    if (variant === "mismatched_queue_time") metadata.toolQueue.settledAt = new Date(0).toISOString();
    if (variant === "failed_legacy") await db.update(workflowStepRuns).set({ status: "failed", metadata: {} }).where(eq(workflowStepRuns.id, s.stepRunId));
    if (variant === "unrelated_success") {
      await db.update(workflowStepRuns).set({ metadata: {} }).where(eq(workflowStepRuns.id, s.stepRunId));
      await db.insert(workflowStepRuns).values({ workflowRunId: s.workflowRunId, stepId: "unrelated-success", issueId: null,
        status: "completed", completedAt: stepRun.completedAt, lastDispatchRequestId: stepRun.lastDispatchRequestId, metadata });
    }
    if (variant !== "failed_legacy" && variant !== "unrelated_success") await db.update(workflowStepRuns).set({ metadata }).where(eq(workflowStepRuns.id, s.stepRunId));
    const result = await applyOwnerToolRecovery({ db, mission: c.mission, issue, sourceIssue, stepRows: c.stepRows, apply: true });
    expect(result?.outcome).toMatchObject({ kind: "no_op", outcome: "blocked" });
    if (variant === "failed_legacy") expect(result?.outcome.reason).toBe("legacy_source_observation_only");
    else expect(result?.outcome.reason).toMatch(/^source_success_evidence_/);
    if (variant === "failed_legacy") {
      const [current] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, s.stepRunId));
      const row = c.stepRows.find(candidate => candidate.stepRun.id === s.stepRunId)!;
      const facts = await loadToolRecoveryBriefFacts(db, { mission: c.mission, oversightIssue: sourceIssue,
        run: row.run, stepRun: current, step: null, workflowName: row.definition.name });
      expect(facts.execution).toMatchObject({ sourceState: "held", status: "blocked_evidence_unavailable" });
    }
  });
  it.each(["edited_current", "corrupt_snapshot"])("uses frozen definition for %s", async variant => {
    const s = await seedRecovered("done", true);
    const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id,
      (await db.select().from(workflowRuns).where(eq(workflowRuns.id, s.workflowRunId)))[0]!.workflowId));
    await db.update(workflowDefinitions).set({ stepsJson: [{ id: "collect-us-stockflow", name: "edited", type: "agent",
      agentId: s.ownerAgentId, dependencies: [] }] }).where(eq(workflowDefinitions.id, definition.id));
    const { c, issue, sourceIssue } = await context(s);
    if (variant === "corrupt_snapshot") await db.update(workflowRunDefinitions).set({ steps: [] }).where(eq(workflowRunDefinitions.workflowRunId, s.workflowRunId));
    const result = await applyOwnerToolRecovery({ db, mission: c.mission, issue, sourceIssue, stepRows: c.stepRows, apply: true });
    const row = c.stepRows.find(candidate => candidate.stepRun.id === s.stepRunId)!;
    const originalStep = (row.definition.stepsJson as Array<{ id: string }>).find(candidate => candidate.id === row.stepRun.stepId)!;
    const facts = await loadToolRecoveryBriefFacts(db, { mission: c.mission, oversightIssue: sourceIssue,
      run: row.run, stepRun: row.stepRun, step: originalStep as never, workflowName: row.definition.name });
    if (variant === "edited_current") {
      expect(result?.outcome.reason).toBe("source_already_recovered");
      expect(facts.execution).toMatchObject({ sourceState: "source_recovered", status: "no_recovery_needed" });
    } else {
      expect(result?.outcome).toMatchObject({ reason: "source_definition_unavailable", outcome: "blocked" });
      expect(facts.execution).toMatchObject({ sourceState: "held", status: "blocked_evidence_unavailable" });
    }
  });
  it.each(["identity", "scope", "authority", "generation", "request"])("holds recovered source before classification on %s target mismatch", async field => {
    const s = await seedRecovered();
    const target = await currentTarget(s);
    if (field === "identity") target.stepRunId = randomUUID();
    if (field === "scope") target.workflowRunId = randomUUID();
    if (field === "authority") target.expectedAuthorityVersion++;
    if (field === "generation") target.expectedExecutionGeneration++;
    if (field === "request") target.failedDispatchRequestId = randomUUID();
    await decide(s, target);
    const result = await apply(s);
    expect(result?.outcome).toMatchObject({ kind: "no_op", outcome: "blocked", reason: "decision_target_mismatch" });
  });
  it.each(["live_heartbeat", "contradictory_heartbeat", "live_wakeup", "contradictory_wakeup"])("holds source with %s structured dispatch reference", async variant => {
    const s = await seedRecovered();
    const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, s.stepRunId));
    const live = variant.startsWith("live_");
    if (variant.endsWith("heartbeat")) {
      const id = randomUUID();
      await db.insert(heartbeatRuns).values({ id, companyId: s.companyId, agentId: s.ownerAgentId,
        workflowStepRunId: live ? s.stepRunId : s.downstreamStepRunId,
        workflowExecutionGeneration: step.executionGeneration, status: live ? "running" : "succeeded",
        settledAt: live ? null : new Date() });
      await db.update(workflowStepRuns).set({ dispatchOwnerHeartbeatRunId: id }).where(eq(workflowStepRuns.id, s.stepRunId));
    } else {
      const id = randomUUID();
      await db.insert(agentWakeupRequests).values({ id, companyId: s.companyId, agentId: s.ownerAgentId, source: "workflow",
        status: live ? "queued" : "completed", workflowRunId: live ? s.workflowRunId : randomUUID(),
        workflowStepRunId: live ? s.stepRunId : s.downstreamStepRunId, workflowExecutionGeneration: step.executionGeneration });
      await db.update(workflowStepRuns).set({ dispatchOwnerWakeupRequestId: id }).where(eq(workflowStepRuns.id, s.stepRunId));
    }
    const result = await apply(s);
    expect(result?.outcome).toMatchObject({ kind: "no_op", outcome: "blocked" });
    expect(result?.outcome.reason).toMatch(/^source_dispatch_/);
  });
  it.each(["duplicate", "malformed"])("holds %s identity links", async variant => {
    const s = await seedRecovered();
    if (variant === "duplicate") await db.insert(workflowTransitionEvents).values({ companyId: s.companyId, missionId: s.missionId,
      issueId: s.recoveryIssueId, workflowRunId: s.workflowRunId, workflowStepRunId: s.stepRunId,
      layer: "mission_owner_recovery", eventType: "owner_tool_recovery_target_v1",
      idempotencyKey: `owner-tool-card:${s.stepRunId}:duplicate`,
      payload: { schemaVersion: 1, kind: "tool_step", workflowRunId: s.workflowRunId, stepRunId: s.stepRunId } });
    else await db.update(workflowTransitionEvents).set({ payload: { schemaVersion: 1, kind: "tool_step",
      workflowRunId: s.workflowRunId, stepRunId: "bad" } }).where(eq(workflowTransitionEvents.issueId, s.recoveryIssueId));
    const result = await apply(s);
    expect(result?.outcome).toMatchObject({ kind: "no_op", outcome: "blocked",
      reason: variant === "duplicate" ? "source_binding_ambiguous" : "source_binding_invalid" });
  });
  it("holds a structured decision aimed at another failed run instead of selecting that run", async () => {
    const s = await seedToolRecoveryScenario({ db, artifactExists: false }); roots.push(s.tempRoot);
    const [sourceRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, s.workflowRunId));
    const [otherRun] = await db.insert(workflowRuns).values({ id: randomUUID(), companyId: s.companyId,
      workflowId: sourceRun.workflowId, missionId: s.missionId, triggeredBy: "test", status: "failed" }).returning();
    const [otherStep] = await db.insert(workflowStepRuns).values({ workflowRunId: otherRun.id, stepId: "collect-us-stockflow",
      issueId: null, status: "failed", startedAt: new Date(), lastDispatchRequestId: "other-run-request",
      metadata: { toolResult: { success: false } } }).returning();
    await db.insert(workflowTransitionEvents).values({ companyId: s.companyId, missionId: s.missionId,
      issueId: s.recoveryIssueId, workflowRunId: s.workflowRunId, workflowStepRunId: s.stepRunId,
      layer: "mission_owner_recovery", eventType: "owner_tool_recovery_target_v1",
      idempotencyKey: `owner-tool-card:${s.stepRunId}`,
      payload: { schemaVersion: 1, kind: "tool_step", workflowRunId: s.workflowRunId, stepRunId: s.stepRunId } });
    await decide(s, { kind: "tool_step", workflowRunId: otherRun.id, stepRunId: otherStep.id,
      expectedAuthorityVersion: 0, expectedExecutionGeneration: 0, failedDispatchRequestId: "other-run-request" });
    const result = await apply(s);
    expect(result?.outcome).toMatchObject({ kind: "no_op", outcome: "blocked", reason: "decision_target_mismatch" });
    expect(result?.appliedAction).toBeUndefined();
  });
  it("holds a valid v1 link whose exact run belongs to another mission", async () => {
    const s = await seedRecovered("done");
    const [currentRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, s.workflowRunId));
    const foreignMissionId = randomUUID(), foreignRunId = randomUUID(), foreignStepId = randomUUID();
    await db.insert(missions).values({ id: foreignMissionId, companyId: s.companyId, ownerAgentId: s.ownerAgentId,
      title: "Other mission", status: "active" });
    await db.insert(workflowRuns).values({ id: foreignRunId, companyId: s.companyId, workflowId: currentRun.workflowId,
      missionId: foreignMissionId, triggeredBy: "test", status: "failed" });
    await db.insert(workflowStepRuns).values({ id: foreignStepId, workflowRunId: foreignRunId,
      stepId: "collect-us-stockflow", issueId: null, status: "failed", startedAt: new Date(), metadata: { toolResult: { success: false } } });
    const [link] = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.issueId, s.recoveryIssueId));
    await db.update(workflowTransitionEvents).set({ workflowRunId: foreignRunId, workflowStepRunId: foreignStepId,
      idempotencyKey: `owner-tool-card:${foreignStepId}`,
      payload: { schemaVersion: 1, kind: "tool_step", workflowRunId: foreignRunId, stepRunId: foreignStepId } })
      .where(eq(workflowTransitionEvents.id, link.id));
    const result = await apply(s);
    expect(result?.outcome).toMatchObject({ kind: "no_op", outcome: "blocked", reason: "source_binding_target_mismatch" });
    const foreignCompany = await seedToolRecoveryScenario({ db, artifactExists: false }); roots.push(foreignCompany.tempRoot);
    await db.update(workflowTransitionEvents).set({ workflowRunId: s.workflowRunId, workflowStepRunId: foreignCompany.stepRunId,
      idempotencyKey: `owner-tool-card:${foreignCompany.stepRunId}`,
      payload: { schemaVersion: 1, kind: "tool_step", workflowRunId: s.workflowRunId, stepRunId: foreignCompany.stepRunId } })
      .where(eq(workflowTransitionEvents.id, link.id));
    const foreignMembership = await apply(s);
    expect(foreignMembership?.outcome).toMatchObject({ reason: "source_binding_target_mismatch", outcome: "blocked" });
  });
});
