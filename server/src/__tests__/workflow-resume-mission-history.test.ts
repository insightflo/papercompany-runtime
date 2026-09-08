import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDb, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import {
  canonicalMissionDomain,
  cleanupResourceTables,
  readMissionHistoryReadonly,
  readModelScope,
  seedAdditionalMission,
  seedCompleteStepRuns,
  seedForeignReadModelGraph,
  seedMissionSiblingRun,
  seedReadModelDelegation,
  seedReadModelGraph,
  seedReadModelHeartbeat,
  seedReadModelIssue,
  seedReadModelStepRun,
  seedReadModelWakeup,
  seedResourceFinalization,
  seedResourceFinalizationStep,
  seedResourceMissionRuntime,
  seedResourceRuntimeService,
  seedResourceWorkspaceOperation,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
} from "./helpers/workflow-resume-mission-fixture.js";

/**
 * [purpose] Task5c3c sibling history union via public readResumeMissionHistory (항상 실제
 *   repeatable-read read-only 트랜잭션). 각 독립 OR/discovery 경로를 다른 원인 없이 별도
 *   fixture 로 검증한다: sibling raw step fields, run-only/step-only/owner-only wakeup 과
 *   heartbeat, step-linked null-mission issue, fresh mission issue, delegations with foreign
 *   counterpart, multi-run dedupe by database id, union resource call. Real embedded Postgres,
 *   no mocks, no skipped suites.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEP("readResumeMissionHistory — sibling history union", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("resume-mission-history-");
    if (!started.supported) throw new Error(started.reason);
    fixture = started;
    db = createDb(fixture.connectionString);
  }, 60_000);

  afterEach(async () => {
    await cleanupResourceTables(db);
  });

  afterAll(async () => {
    if (fixture?.supported) await fixture.cleanup();
  });

  /** frozen selected graph + 1:1 step rows — collector 통과 최소 selected 그래프. */
  async function seedSelectedGraph() {
    const graph = await seedReadModelGraph(fixture.sql, db);
    await seedCompleteStepRuns(db, graph);
    return graph;
  }

  it("preserves sibling raw step toolQueue/toolInvocation/dispatch owner/generation and expired lease exactly; sibling semantic step ids need not match selected definition", async () => {
    const graph = await seedSelectedGraph();
    const sibling = await seedMissionSiblingRun(fixture.sql, { companyId: graph.companyId, missionId: graph.missionId, status: "completed" });
    const ownerWakeup = await seedReadModelWakeup(db, { companyId: graph.companyId, agentId: graph.agentId });
    const ownerHeartbeat = await seedReadModelHeartbeat(db, { companyId: graph.companyId, agentId: graph.agentId });
    const sibStep = await seedReadModelStepRun(db, {
      runId: sibling,
      stepId: "sib-semantic-x",
      status: "running",
      executionGeneration: 6,
      lastDispatchRequestId: "req-sib-1",
      dispatchOwnerWakeupRequestId: ownerWakeup,
      dispatchOwnerHeartbeatRunId: ownerHeartbeat,
      metadata: {
        toolQueue: { status: "queued", queuedAt: "2024-05-02T09:00:00.000Z" },
        toolInvocation: { toolName: "sib-tool", args: { q: 1 } },
      },
    });
    const leaseExpiresAt = new Date("2024-05-01T00:00:00.000Z");
    const leaseToken = randomUUID();
    const fin = await seedResourceFinalization(db, {
      companyId: graph.companyId, heartbeatRunId: ownerHeartbeat, leaseToken,
      owner: "sib-finalizer", leaseExpiresAt, state: "pending", attempts: 2,
    });

    const result = await readMissionHistoryReadonly(db, readModelScope(graph));
    const stepRow = result.missionSteps.find((row) => row.id === sibStep)!;
    expect(stepRow.stepId).toBe("sib-semantic-x");
    expect(stepRow.metadata).toEqual({
      toolQueue: { status: "queued", queuedAt: "2024-05-02T09:00:00.000Z" },
      toolInvocation: { toolName: "sib-tool", args: { q: 1 } },
    });
    expect(stepRow.lastDispatchRequestId).toBe("req-sib-1");
    expect(stepRow.dispatchOwnerWakeupRequestId).toBe(ownerWakeup);
    expect(stepRow.dispatchOwnerHeartbeatRunId).toBe(ownerHeartbeat);
    expect(stepRow.executionGeneration).toBe(6);
    expect(result.history.wakeups.map((row) => row.id)).toContain(ownerWakeup);
    expect(result.history.heartbeats.map((row) => row.id)).toContain(ownerHeartbeat);
    const finRow = result.resources.finalizations.find((row) => row.id === fin)!;
    expect(finRow.finalizerLeaseToken).toBe(leaseToken);
    expect(finRow.finalizerOwner).toBe("sib-finalizer");
    expect(finRow.finalizerLeaseExpiresAt).toEqual(leaseExpiresAt);
    expect(finRow.attempts).toBe(2);
  }, 30_000);

  it("discovers a sibling run-only typed wakeup independently, then its linked heartbeat, finalization and workspace operation through the union", async () => {
    const graph = await seedSelectedGraph();
    const sibling = await seedMissionSiblingRun(fixture.sql, { companyId: graph.companyId, missionId: graph.missionId, status: "running" });
    await seedReadModelStepRun(db, { runId: sibling, stepId: "sib-chain-step" });
    const wakeup = await seedReadModelWakeup(db, { companyId: graph.companyId, agentId: graph.agentId, workflowRunId: sibling });
    const heartbeat = await seedReadModelHeartbeat(db, { companyId: graph.companyId, agentId: graph.agentId, wakeupRequestId: wakeup });
    const fin = await seedResourceFinalization(db, { companyId: graph.companyId, heartbeatRunId: heartbeat, terminalOutcome: "failed" });
    const operation = await seedResourceWorkspaceOperation(db, { companyId: graph.companyId, heartbeatRunId: heartbeat, phase: "cleanup" });

    const result = await readMissionHistoryReadonly(db, readModelScope(graph));
    expect(result.history.wakeups.map((row) => row.id)).toEqual([wakeup]);
    const wakeRow = result.history.wakeups[0]!;
    expect(wakeRow.workflowRunId).toBe(sibling);
    expect(wakeRow.missionId).toBeNull();
    expect(wakeRow.issueId).toBeNull();
    expect(wakeRow.workflowStepRunId).toBeNull();
    expect(result.history.heartbeats.map((row) => row.id)).toEqual([heartbeat]);
    expect(result.resources.finalizations.map((row) => row.id)).toEqual([fin]);
    expect(result.resources.workspaceOperations.map((row) => row.id)).toEqual([operation]);
  }, 30_000);

  it("discovers a run-only wakeup of a zero-step sibling run", async () => {
    const graph = await seedSelectedGraph();
    const zeroStepRun = await seedMissionSiblingRun(fixture.sql, { companyId: graph.companyId, missionId: graph.missionId, status: "pending" });
    const wakeup = await seedReadModelWakeup(db, { companyId: graph.companyId, agentId: graph.agentId, workflowRunId: zeroStepRun });

    const result = await readMissionHistoryReadonly(db, readModelScope(graph));
    expect(result.missionSteps.filter((row) => row.workflowRunId === zeroStepRun)).toEqual([]);
    expect(result.history.wakeups.map((row) => row.id)).toEqual([wakeup]);
  }, 30_000);

  it("discovers a sibling step-only wakeup — no mission/run/issue alternatives in the fixture", async () => {
    const graph = await seedSelectedGraph();
    const sibling = await seedMissionSiblingRun(fixture.sql, { companyId: graph.companyId, missionId: graph.missionId });
    const sibStep = await seedReadModelStepRun(db, { runId: sibling, stepId: "sib-only-step" });
    const wakeup = await seedReadModelWakeup(db, { companyId: graph.companyId, agentId: graph.agentId, workflowStepRunId: sibStep });

    const result = await readMissionHistoryReadonly(db, readModelScope(graph));
    expect(result.history.wakeups.map((row) => row.id)).toEqual([wakeup]);
    expect(result.history.wakeups[0]!.workflowStepRunId).toBe(sibStep);
    expect(result.history.wakeups[0]!.missionId).toBeNull();
    expect(result.history.wakeups[0]!.workflowRunId).toBeNull();
    expect(result.history.wakeups[0]!.issueId).toBeNull();
  }, 30_000);

  it("discovers sibling step-only heartbeats across older generation and unknown status — no issue/context alternatives", async () => {
    const graph = await seedSelectedGraph();
    const sibling = await seedMissionSiblingRun(fixture.sql, { companyId: graph.companyId, missionId: graph.missionId });
    const sibStep = await seedReadModelStepRun(db, { runId: sibling, stepId: "sib-hb-step" });
    const priorGeneration = await seedReadModelHeartbeat(db, {
      companyId: graph.companyId, agentId: graph.agentId, workflowStepRunId: sibStep, workflowExecutionGeneration: 1,
    });
    const unknownStatus = await seedReadModelHeartbeat(db, {
      companyId: graph.companyId, agentId: graph.agentId, workflowStepRunId: sibStep,
      status: "mystery_unknown_status", workflowExecutionGeneration: 9,
    });

    const result = await readMissionHistoryReadonly(db, readModelScope(graph));
    expect(result.history.heartbeats.map((row) => row.id)).toEqual([priorGeneration, unknownStatus].sort());
    expect(result.history.heartbeats.find((row) => row.id === priorGeneration)!.workflowExecutionGeneration).toBe(1);
    expect(result.history.heartbeats.find((row) => row.id === unknownStatus)!.status).toBe("mystery_unknown_status");
    expect(result.history.issues).toEqual([]);
    expect(result.history.heartbeats.every((row) => row.issueId === null && row.wakeupRequestId === null)).toBe(true);
    expect(result.history.heartbeats.every((row) => row.contextSnapshot === null)).toBe(true);
  }, 30_000);

  it("discovers sibling owner-ID-only wakeup and heartbeat with all typed/legacy links absent", async () => {
    const graph = await seedSelectedGraph();
    const sibling = await seedMissionSiblingRun(fixture.sql, { companyId: graph.companyId, missionId: graph.missionId });
    const ownerWakeup = await seedReadModelWakeup(db, { companyId: graph.companyId, agentId: graph.agentId });
    const ownerHeartbeat = await seedReadModelHeartbeat(db, { companyId: graph.companyId, agentId: graph.agentId });
    await seedReadModelStepRun(db, {
      runId: sibling, stepId: "sib-owner-step",
      dispatchOwnerWakeupRequestId: ownerWakeup, dispatchOwnerHeartbeatRunId: ownerHeartbeat,
    });

    const result = await readMissionHistoryReadonly(db, readModelScope(graph));
    expect(result.history.wakeups.map((row) => row.id)).toEqual([ownerWakeup]);
    expect(result.history.heartbeats.map((row) => row.id)).toEqual([ownerHeartbeat]);
    const wakeRow = result.history.wakeups[0]!;
    expect(wakeRow.missionId).toBeNull();
    expect(wakeRow.workflowRunId).toBeNull();
    expect(wakeRow.workflowStepRunId).toBeNull();
    expect(wakeRow.issueId).toBeNull();
    expect(wakeRow.payload).toBeNull();
    const heartbeatRow = result.history.heartbeats[0]!;
    expect(heartbeatRow.issueId).toBeNull();
    expect(heartbeatRow.workflowStepRunId).toBeNull();
    expect(heartbeatRow.wakeupRequestId).toBeNull();
    expect(heartbeatRow.contextSnapshot).toBeNull();
  }, 30_000);

  it("discovers a sibling step-linked issue with missionId null plus its issue-only wakeup and heartbeat", async () => {
    const graph = await seedSelectedGraph();
    const sibling = await seedMissionSiblingRun(fixture.sql, { companyId: graph.companyId, missionId: graph.missionId });
    const nullMissionIssue = await seedReadModelIssue(db, { companyId: graph.companyId });
    await seedReadModelStepRun(db, { runId: sibling, stepId: "sib-issue-step", issueId: nullMissionIssue });
    const issueWakeup = await seedReadModelWakeup(db, { companyId: graph.companyId, agentId: graph.agentId, issueId: nullMissionIssue });
    const issueHeartbeat = await seedReadModelHeartbeat(db, { companyId: graph.companyId, agentId: graph.agentId, issueId: nullMissionIssue });

    const result = await readMissionHistoryReadonly(db, readModelScope(graph));
    expect(result.history.issues.map((row) => row.id)).toEqual([nullMissionIssue]);
    expect(result.history.issues[0]!.missionId).toBeNull();
    expect(result.history.wakeups.map((row) => row.id)).toEqual([issueWakeup]);
    expect(result.history.heartbeats.map((row) => row.id)).toEqual([issueHeartbeat]);
  }, 30_000);

  it("includes a fresh same-mission issue with no step and its linked wakeup/heartbeat; excludes same-company other-mission issue", async () => {
    const graph = await seedSelectedGraph();
    const freshIssue = await seedReadModelIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
    const issueWakeup = await seedReadModelWakeup(db, { companyId: graph.companyId, agentId: graph.agentId, issueId: freshIssue });
    const issueHeartbeat = await seedReadModelHeartbeat(db, { companyId: graph.companyId, agentId: graph.agentId, issueId: freshIssue });
    const otherMission = await seedAdditionalMission(fixture.sql, graph.companyId, graph.agentId);
    const otherMissionIssue = await seedReadModelIssue(db, { companyId: graph.companyId, missionId: otherMission });

    const result = await readMissionHistoryReadonly(db, readModelScope(graph));
    expect(result.history.issues.map((row) => row.id)).toEqual([freshIssue]);
    expect(result.history.wakeups.map((row) => row.id)).toEqual([issueWakeup]);
    expect(result.history.heartbeats.map((row) => row.id)).toEqual([issueHeartbeat]);
    const canonical = await canonicalMissionDomain(db);
    expect(canonical.issues.map((row) => row.id)).toContain(otherMissionIssue); // DB 에는 있지만
    expect(result.history.issues.map((row) => row.id)).not.toContain(otherMissionIssue); // scope 밖이므로 제외
  }, 30_000);

  it("collects sibling source run/step-only delegation with legitimate foreign target, and incoming delegation to sibling issue, without arbitrary foreign fetch", async () => {
    const graph = await seedSelectedGraph();
    const foreign = await seedForeignReadModelGraph(fixture.sql, db);
    const sibling = await seedMissionSiblingRun(fixture.sql, { companyId: graph.companyId, missionId: graph.missionId });
    const siblingIssue = await seedReadModelIssue(db, { companyId: graph.companyId });
    const sibStep = await seedReadModelStepRun(db, { runId: sibling, stepId: "sib-delegation-step", issueId: siblingIssue });
    const outgoing = await seedReadModelDelegation(db, {
      sourceCompanyId: graph.companyId, sourceWorkflowRunId: sibling, sourceWorkflowStepRunId: sibStep,
      targetCompanyId: foreign.companyId, targetIssueId: foreign.issueId,
    });
    const incoming = await seedReadModelDelegation(db, {
      sourceCompanyId: foreign.companyId, sourceWorkflowRunId: foreign.runId, sourceWorkflowStepRunId: foreign.stepRunId,
      targetCompanyId: graph.companyId, targetIssueId: siblingIssue,
    });

    const result = await readMissionHistoryReadonly(db, readModelScope(graph));
    expect(result.history.delegations.map((row) => row.id)).toEqual([outgoing, incoming].sort());
    expect(result.history.delegations.find((row) => row.id === outgoing)!.targetCompanyId).toBe(foreign.companyId);
    expect(result.history.delegations.find((row) => row.id === incoming)!.sourceCompanyId).toBe(foreign.companyId);
    // 임의 foreign counterpart fetch 없음 — foreign run 은 root 열거에 절대 없다.
    expect(result.missionRuns.map((row) => row.id)).not.toContain(foreign.runId);
  }, 30_000);

  it("includes isolated sibling-heartbeat workspace operation, finalization/stages, runtime service and mission runtime through the final union resource call", async () => {
    const graph = await seedSelectedGraph();
    const sibling = await seedMissionSiblingRun(fixture.sql, { companyId: graph.companyId, missionId: graph.missionId });
    const sibStep = await seedReadModelStepRun(db, { runId: sibling, stepId: "sib-resource-step" });
    const siblingHeartbeat = await seedReadModelHeartbeat(db, { companyId: graph.companyId, agentId: graph.agentId, workflowStepRunId: sibStep });
    const operation = await seedResourceWorkspaceOperation(db, { companyId: graph.companyId, heartbeatRunId: siblingHeartbeat, phase: "build" });
    const fin = await seedResourceFinalization(db, { companyId: graph.companyId, heartbeatRunId: siblingHeartbeat });
    const stage = await seedResourceFinalizationStep(db, {
      companyId: graph.companyId, heartbeatRunId: siblingHeartbeat, heartbeatRunFinalizationId: fin,
      stageKind: "sib-stage", idempotencyKey: "sib-1",
    });
    const service = await seedResourceRuntimeService(db, {
      companyId: graph.companyId, startedByRunId: siblingHeartbeat, scopeType: "project", scopeId: null,
    });
    const otherMission = await seedAdditionalMission(fixture.sql, graph.companyId, graph.agentId);
    // missionId 술어를 피하는 lastRunId 단독 경로 — 다른 mission 소속 runtime 이 형제 heartbeat 로 포함.
    const runtime = await seedResourceMissionRuntime(db, {
      companyId: graph.companyId, missionId: otherMission, agentId: graph.agentId, lastRunId: siblingHeartbeat,
    });

    const result = await readMissionHistoryReadonly(db, readModelScope(graph));
    expect(result.history.heartbeats.map((row) => row.id)).toEqual([siblingHeartbeat]);
    expect(result.resources.workspaceOperations.map((row) => row.id)).toEqual([operation]);
    expect(result.resources.finalizations.map((row) => row.id)).toEqual([fin]);
    expect(result.resources.finalizationSteps.map((row) => row.id)).toEqual([stage]);
    expect(result.resources.workspaceRuntimeServices.map((row) => row.id)).toEqual([service]);
    expect(result.resources.missionAgentRuntimes.map((row) => row.id)).toEqual([runtime]);
  }, 30_000);
});
