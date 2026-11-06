// P1 execution-root fixture helpers moved out of heartbeat-recovery-boundary.test.ts
// (T16d, file <=1000 lines). Bodies are moved verbatim; every helper receives the harness or
// db handle it operates on, so no module-level connection is captured here.
import { expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { agents, companies, missions, issues, heartbeatRuns, agentWakeupRequests, workflowDefinitions, workflowStepRuns, workflowRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../../adapters/types.js";
import { createReplacementRootNotifications } from "../../services/issue-assignment-wakeup.js";
import { freezeHeartbeatActualDrainIdentity } from "../../services/heartbeat-actual-drain.js";
import { readWorkflowAttemptProof } from "../../services/heartbeat-finalization/workflow-attempt-proof.js";
import { acknowledgeHeartbeatRunBeforeAdapter, claimQueuedHeartbeatRun } from "../../services/heartbeat-finalization/shadow-writes.js";
import { insertWorkflowWakeRequest } from "../../services/heartbeat-workflow-wake.js";
import { type QaFileOwnerRuntime } from "../../services/workflow/control-flow/qa-remediation-runtime.js";
import { type AdmissionHarness } from "./qa-remediation-admission-public-fixture.js";
import { within } from "./qa-remediation-parent-death-harness.js";

export type P1WorkflowScenario = { companyId: string; missionId: string; workflowId: string; runId: string };

export async function createP1LifecycleScenario(harness: AdmissionHarness) {
  const companyId = randomUUID(), missionId = randomUUID(), workflowId = randomUUID(), runId = randomUUID();
  const authorId = randomUUID(), verifierId = randomUUID();
  const producerIssueId = randomUUID(), qaIssueId = randomUUID();
  await harness.db.insert(companies).values({ id: companyId, name: "P1 execution-root lifecycle",
    issuePrefix: `P1${companyId.slice(0, 8)}`, workProductRoot: harness.root });
  await harness.db.insert(agents).values([
    { id: authorId, companyId, name: "P1 producer", status: "active", adapterType: "codex_local",
      adapterConfig: { cwd: harness.root, promptTemplate: "P1 producer" },
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 2 } } },
    { id: verifierId, companyId, name: "P1 QA", status: "active", adapterType: "codex_local",
      adapterConfig: { cwd: harness.root, promptTemplate: "P1 QA" },
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 2 } } },
  ]);
  await harness.db.insert(missions).values({ id: missionId, companyId, title: "P1 execution-root mission",
    ownerAgentId: authorId, status: "active" });
  await harness.db.insert(workflowDefinitions).values({ id: workflowId, companyId, missionId,
    name: "P1 producer and QA", stepsJson: [
      { id: "p1-producer", name: "P1 producer", agentId: authorId, dependencies: [],
        conditionalDependencies: [{ stepId: "p1-qa", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 }] },
      { id: "p1-qa", name: "P1 QA", type: "qa", agentId: verifierId, dependencies: ["p1-producer"] },
    ] });
  await harness.db.insert(workflowRuns).values({ id: runId, companyId, missionId, workflowId,
    status: "running", triggeredBy: "test", dispatchAuthorityVersion: 1 });
  await harness.db.insert(issues).values([
    { id: producerIssueId, companyId, missionId, title: "P1 producer report", status: "todo",
      assigneeAgentId: authorId, originKind: "workflow_execution", originRunId: runId },
    { id: qaIssueId, companyId, missionId, title: "[QA] P1 producer report", status: "todo",
      assigneeAgentId: verifierId, originKind: "workflow_execution", originRunId: runId },
  ]);
  const [producer] = await harness.db.insert(workflowStepRuns).values({ workflowRunId: runId,
    stepId: "p1-producer", issueId: producerIssueId, status: "pending" }).returning();
  const [qa] = await harness.db.insert(workflowStepRuns).values({ workflowRunId: runId,
    stepId: "p1-qa", issueId: qaIssueId, status: "pending" }).returning();
  if (!producer || !qa) throw new Error("P1 producer/QA workflow attempts were not created");
  return { companyId, missionId, workflowId, runId, authorId, verifierId, producer, qa, producerIssueId, qaIssueId,
    file: path.join(harness.root, "missions", missionId, "runs", runId, "steps", producer.stepId, "report.md") };
}

export async function createP1NoHistoryScenario(harness: AdmissionHarness, companyId: string, name: string) {
  const missionId = randomUUID(), workflowId = randomUUID(), runId = randomUUID(), agentId = randomUUID();
  await harness.db.insert(agents).values({ id: agentId, companyId, name, status: "active", adapterType: "codex_local",
    adapterConfig: { cwd: harness.root, promptTemplate: name },
    runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 2 } } });
  await harness.db.insert(missions).values({ id: missionId, companyId, title: `${name} mission`, ownerAgentId: agentId, status: "active" });
  await harness.db.insert(workflowDefinitions).values({ id: workflowId, companyId, missionId,
    name: `${name} workflow`, stepsJson: [] });
  await harness.db.insert(workflowRuns).values({ id: runId, companyId, missionId, workflowId,
    status: "running", triggeredBy: "test", dispatchAuthorityVersion: 1 });
  return { scenario: { companyId, missionId, workflowId, runId }, agentId };
}

export async function addExecutionCandidateAgent(harness: AdmissionHarness, scenario: P1WorkflowScenario, name: string) {
  const agentId = randomUUID();
  await harness.db.insert(agents).values({ id: agentId, companyId: scenario.companyId, name,
    status: "active", adapterType: "codex_local", adapterConfig: { cwd: harness.root, promptTemplate: name },
    runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 2 } } });
  return agentId;
}

export async function addExecutionCandidateStep(harness: AdmissionHarness, scenario: P1WorkflowScenario,
  agentId: string, name: string) {
  const stepId = `p1-${randomUUID()}`;
  const [definition] = await harness.db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, scenario.workflowId));
  if (!definition) throw new Error("P1 workflow definition disappeared");
  await harness.db.update(workflowDefinitions).set({ stepsJson: [
    ...(definition.stepsJson as Record<string, unknown>[]), { id: stepId, name, agentId, dependencies: [] },
  ] }).where(eq(workflowDefinitions.id, scenario.workflowId));
  const issueId = randomUUID();
  await harness.db.insert(issues).values({ id: issueId, companyId: scenario.companyId, missionId: scenario.missionId,
    title: name, status: "todo", assigneeAgentId: agentId,
    originKind: "workflow_execution", originRunId: scenario.runId });
  const [stepRun] = await harness.db.insert(workflowStepRuns).values({ workflowRunId: scenario.runId,
    stepId, issueId, status: "pending" }).returning();
  if (!stepRun) throw new Error("P1 workflow execution step was not created");
  return { issueId, stepRun };
}

export async function addExecutionCandidate(harness: AdmissionHarness, scenario: P1WorkflowScenario,
  agentId: string, target: { issueId: string; stepRun: typeof workflowStepRuns.$inferSelect }) {
  const wakeId = randomUUID(), runId = randomUUID();
  const context = { issueId: target.issueId, missionId: scenario.missionId, workflowRunId: scenario.runId,
    workflowStepRunId: target.stepRun.id, workflowExecutionGeneration: target.stepRun.executionGeneration };
  const inserted = await harness.db.transaction(async tx => {
    const [wake] = await insertWorkflowWakeRequest(tx as unknown as Db, { id: wakeId, companyId: scenario.companyId,
      agentId, source: "workflow.dispatch", reason: "workflow_step_runnable", status: "queued", runId,
      issueId: target.issueId, missionId: scenario.missionId, workflowRunId: scenario.runId,
      workflowStepRunId: target.stepRun.id, workflowExecutionGeneration: target.stepRun.executionGeneration,
      payload: context });
    const [run] = await tx.insert(heartbeatRuns).values({ id: runId, companyId: scenario.companyId,
      agentId, issueId: target.issueId, invocationSource: "automation", status: "queued", wakeupRequestId: wakeId,
      workflowStepRunId: target.stepRun.id, workflowExecutionGeneration: target.stepRun.executionGeneration,
      contextSnapshot: context }).returning();
    return { wake, run };
  });
  const { wake, run } = inserted;
  if (!wake || !run) throw new Error("P1 typed heartbeat/wake identity was not created");
  return run;
}

export async function addG1BDetachedExecutionCandidate(harness: AdmissionHarness, scenario: P1WorkflowScenario, name: string) {
  const agentId = await addExecutionCandidateAgent(harness, scenario, name);
  const issueId = randomUUID(), stepId = `g1b-${randomUUID()}`;
  await harness.db.insert(issues).values({ id: issueId, companyId: scenario.companyId, missionId: scenario.missionId,
    title: name, status: "todo", assigneeAgentId: agentId,
    originKind: "workflow_execution", originRunId: scenario.runId });
  const [stepRun] = await harness.db.insert(workflowStepRuns).values({ workflowRunId: scenario.runId,
    stepId, issueId, status: "pending" }).returning();
  if (!stepRun) throw new Error(`G1-B detached execution step was not created for ${name}`);
  const heartbeat = await addExecutionCandidate(harness, scenario, agentId, { issueId, stepRun });
  return { agentId, issueId, stepRun, heartbeat };
}

export async function claimExecutionCandidate(harness: AdmissionHarness, queued: typeof heartbeatRuns.$inferSelect) {
  const claimedAt = new Date();
  const claimed = await claimQueuedHeartbeatRun(harness.db, queued, claimedAt);
  if (!claimed) throw new Error("P1 atomic heartbeat claim did not claim the queued run");
  const [wake] = await harness.db.update(agentWakeupRequests).set({ status: "claimed", claimedAt, updatedAt: claimedAt })
    .where(and(eq(agentWakeupRequests.id, claimed.wakeupRequestId!), eq(agentWakeupRequests.status, "queued"))).returning();
  if (!wake || wake.runId !== claimed.id || !wake.claimedAt) throw new Error("P1 claimed wake identity was not persisted");
  const acknowledged = await acknowledgeHeartbeatRunBeforeAdapter(harness.db, claimed, new Date());
  if (!acknowledged) throw new Error("P1 claimed heartbeat owner was not acknowledged");
  const [fresh] = await harness.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, claimed.id));
  if (!fresh) throw new Error("P1 claimed heartbeat disappeared");
  return fresh;
}

export function executionAdmission(ownerRuntime: QaFileOwnerRuntime) {
  return { ownerRuntime, outerNotifications: createReplacementRootNotifications(), resolutionMap: new Map<string, unknown>(),
    bindResolutionMap: () => {}, driftBudget: { corrections: 0 } };
}

export async function assertP1AdapterAttempt(db: Db, context: AdapterExecutionContext, expected: {
  companyId: string; agentId: string; missionId: string; workflowRunId: string; issueId: string; stepRunId: string; stepId: string;
}) {
  const [heartbeat] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, context.runId));
  const [wake] = heartbeat?.wakeupRequestId
    ? await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, heartbeat.wakeupRequestId)) : [];
  const [issue] = await db.select().from(issues).where(eq(issues.id, expected.issueId));
  if (!heartbeat || !wake || !issue) throw new Error(`P1 adapter identity is missing persisted rows for ${context.runId}`);
  const proof = readWorkflowAttemptProof(wake);
  const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, proof.stepRunId));
  if (!step) throw new Error(`P1 attempt proof step ${proof.stepRunId} is missing for ${context.runId}`);
  expect(context.agent.id).toBe(expected.agentId);
  expect(context.context.issueId).toBe(expected.issueId);
  expect(issue).toMatchObject({ id: expected.issueId, companyId: expected.companyId, missionId: expected.missionId,
    assigneeAgentId: expected.agentId, originKind: "workflow_execution", originRunId: expected.workflowRunId });
  expect(step).toMatchObject({ id: expected.stepRunId, workflowRunId: expected.workflowRunId, stepId: expected.stepId,
    issueId: expected.issueId });
  expect(heartbeat).toMatchObject({ id: context.runId, companyId: expected.companyId, agentId: expected.agentId,
    issueId: expected.issueId, wakeupRequestId: wake.id, workflowStepRunId: expected.stepRunId,
    workflowExecutionGeneration: step.executionGeneration });
  expect(wake).toMatchObject({ companyId: expected.companyId, agentId: expected.agentId, issueId: expected.issueId,
    missionId: expected.missionId, workflowRunId: expected.workflowRunId, workflowStepRunId: expected.stepRunId,
    workflowExecutionGeneration: step.executionGeneration, runId: context.runId });
  expect(proof).toMatchObject({ schemaVersion: 1, companyId: expected.companyId, agentId: expected.agentId,
    missionId: expected.missionId,
    workflowRunId: expected.workflowRunId, issueId: expected.issueId, stepRunId: expected.stepRunId,
    executionGeneration: step.executionGeneration, retryCount: step.retryCount,
    iterationIndex: step.iterationIndex, wakeupRequestId: wake.id, parentHeartbeatRunId: null });
  return { heartbeat, wake, issue, step, proof };
}

export async function waitForP1ProducerDrain(db: Db, identity: NonNullable<Awaited<ReturnType<typeof freezeHeartbeatActualDrainIdentity>>>,
  expectedResult: AdapterExecutionResult) {
  await within(vi.waitFor(async () => {
    const [heartbeat] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, identity.heartbeatRunId));
    const events = await db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, identity.companyId), eq(workflowTransitionEvents.workflowRunId, identity.workflowRunId),
      eq(workflowTransitionEvents.workflowStepRunId, identity.workflowStepRunId), eq(workflowTransitionEvents.issueId, identity.issueId),
      eq(workflowTransitionEvents.heartbeatRunId, identity.heartbeatRunId), eq(workflowTransitionEvents.eventType, "heartbeat_actual_drained_v1")));
    expect(heartbeat).toMatchObject({ id: identity.heartbeatRunId, status: "succeeded", exitCode: expectedResult.exitCode,
      resultJson: expectedResult.resultJson, executorOwnerId: identity.executorOwnerId,
      executorOwnerLeaseEpoch: identity.ownerLeaseEpoch, executorOwnerLeaseToken: identity.ownerLeaseToken,
      executionEpoch: identity.executionEpoch, executionToken: identity.executionToken });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ schemaVersion: "workflow.heartbeat-actual-drain.v1",
      identity, actual: { outcome: "fulfilled" }, cleanup: { runtimeServicesRelease: { called: true, succeeded: true },
        heartbeatSettlement: { called: true, succeeded: true },
        resources: { workspaceOperationsSettled: true, runtimeServicesStopped: true, missionRuntimeIdle: true } } });
  }, { timeout: 30_000, interval: 20 }), "exact natural P1 producer actual drain");
}
