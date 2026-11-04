import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { rmSync } from "node:fs";
import { createDb, agents, companies, missions, issues, heartbeatRuns, agentWakeupRequests, issueWorkProducts, instanceSettings,
  workflowDefinitions, workflowStepRuns, workflowRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { HttpError } from "../errors.js";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../adapters/types.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedReplacement } from "./helpers/replacement-scenario.js";
import { seedCapExhaustedRun, capOwnerAction } from "./helpers/cap-override-fixtures.js";
import { applyOwnerCapOverrideRetry } from "../services/workflow/source-issue-cap-override.js";
import { admitReplacement } from "../services/workflow/replacement-admission.js";
import { claimPlainWorkflowStart } from "../services/workflow/plain-start-claim.js";
import { proposeReplacement, approveReplacement } from "../services/workflow/replacement-approval.js";
import { syncWorkflowRunState, syncWorkflowRunStateWithOutcome } from "../services/workflow/dag-engine.js";
import { heartbeatService } from "../services/heartbeat.js";
import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";
import { createReplacementRootNotifications } from "../services/issue-assignment-wakeup.js";
import { registerWorkflowArtifact, completeWorkflowIssue, submitWorkflowVerdict } from "../services/workflow/agent-api.js";
import { registeredProducer } from "../services/work-products/producer-provenance.js";
import { recordWorkflowValidationVerdict } from "../services/workflow/validation-verdict-ledger.js";
import { prepareQaRemediationReservation } from "../services/workflow/control-flow/qa-remediation-prepare.js";
import { QA_REMEDIATION_PREPARATION_EVENT_TYPE } from "../services/workflow/control-flow/qa-remediation-preparation-contract.js";
import { parseQaRemediationCompletion, QA_REMEDIATION_COMPLETION_EVENT_TYPE }
  from "../services/workflow/control-flow/qa-remediation-completion.js";
import { qaRemediationCompletionKey, qaRemediationRefireV2WakeKey, validateQaRemediationCompletionEvidence }
  from "../services/workflow/control-flow/qa-remediation-completion-evidence.js";
import { freezeHeartbeatActualDrainIdentity, readQaRemediationActualDrain } from "../services/heartbeat-actual-drain.js";
import { readWorkflowAttemptProof } from "../services/heartbeat-finalization/workflow-attempt-proof.js";
import { lifecycleInFlightClause } from "../services/heartbeat-finalization/lifecycle-active.js";
import { missionDedupExemptOversightReviewClause } from "../services/heartbeat-mission-dedup.js";
import { isC5NotInvokedProof, readC5NotInvokedProof, QaRemediationAdmissionHold }
  from "../services/workflow/control-flow/qa-remediation-admission-root.js";
import * as admissionRootModule from "../services/workflow/control-flow/qa-remediation-admission-root.js";
import { unresolvedQaRemediationAdmissionPending } from "../services/workflow/control-flow/qa-remediation-admission-root.js";
import type { QaRemediationAdmissionContext } from "../services/workflow/control-flow/qa-remediation-admission-root.js";
import { captureQaCorrectionExecutionIdentity, withQaCorrectionExecutionRoot } from "../services/workflow/control-flow/qa-correction-claim-root.js";
import type { QaCorrectionExecutionIdentity, QaCorrectionExecutionInvokeOnce, QaCorrectionExecutionScope }
  from "../services/workflow/control-flow/qa-correction-claim-root.js";
import { assertHeartbeatRecoveryAdmission } from "../services/heartbeat-recovery-guard.js";
import { acknowledgeHeartbeatRunBeforeAdapter, claimQueuedHeartbeatRun } from "../services/heartbeat-finalization/shadow-writes.js";
import { insertWorkflowWakeRequest } from "../services/heartbeat-workflow-wake.js";
import { createQaFileOwnerRuntime, type QaFileOwnerRuntime } from "../services/workflow/control-flow/qa-remediation-runtime.js";
import { hashQaCorrectionPayload } from "../services/workflow/control-flow/qa-correction-contract.js";
import { createAdmissionHarness, createReplacementAdmissionPair, drainAdmissionFixtureAdapters,
  executeAdmissionFixtureAdapter, type AdmissionHarness, waitForAdmissionDownstreamActual }
  from "./helpers/qa-remediation-admission-public-fixture.js";
import { PYTHON, deferred, within } from "./helpers/qa-remediation-parent-death-harness.js";

const adapter = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", () => ({ getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute: adapter }), runningProcesses: new Map() }));
let db: Db;
let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
const roots: string[] = [];
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("heartbeat-recovery-"); db = createDb(temp.connectionString); }, 60_000);
afterAll(async () => { await waitForHeartbeatExecutionsToDrain(db); await db.$client.end(); await temp.cleanup(); roots.forEach((r) => rmSync(r, { recursive: true, force: true })); });
beforeEach(() => { adapter.mockReset().mockResolvedValue({ exitCode: 1, signal: null, timedOut: false, errorMessage: "test stop", usage: null, provider: "test", model: "test", resultJson: null, runtimeServices: [] }); });

async function source() {
  const s = await seedReplacement(db); roots.push(s.tempRoot);
  const [issue] = await db.insert(issues).values({ companyId: s.companyId, missionId: s.mission.id, assigneeAgentId: s.actor.agentId,
    originKind: "workflow_execution", originRunId: s.run.id, title: "Source execution", status: "todo" }).returning();
  await db.update(workflowStepRuns).set({ issueId: issue.id }).where(eq(workflowStepRuns.id, s.downstreamStepRunId));
  return { ...s, issue };
}
async function stop(s: Awaited<ReturnType<typeof seedReplacement>>, serviceDb = db) {
  await db.update(agents).set({ status: "paused" }).where(eq(agents.id, s.actor.agentId));
  await db.update(missions).set({ status: "cancelled" }).where(eq(missions.id, s.mission.id));
  await waitForHeartbeatExecutionsToDrain(serviceDb);
}
type P1WorkflowScenario = { companyId: string; missionId: string; workflowId: string; runId: string };

async function createP1LifecycleScenario(harness: AdmissionHarness) {
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

async function createP1NoHistoryScenario(harness: AdmissionHarness, companyId: string, name: string) {
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

async function addExecutionCandidateAgent(harness: AdmissionHarness, scenario: P1WorkflowScenario, name: string) {
  const agentId = randomUUID();
  await harness.db.insert(agents).values({ id: agentId, companyId: scenario.companyId, name,
    status: "active", adapterType: "codex_local", adapterConfig: { cwd: harness.root, promptTemplate: name },
    runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 2 } } });
  return agentId;
}

async function addExecutionCandidateStep(harness: AdmissionHarness, scenario: P1WorkflowScenario,
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

async function addExecutionCandidate(harness: AdmissionHarness, scenario: P1WorkflowScenario,
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

async function addG1BDetachedExecutionCandidate(harness: AdmissionHarness, scenario: P1WorkflowScenario, name: string) {
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

async function claimExecutionCandidate(harness: AdmissionHarness, queued: typeof heartbeatRuns.$inferSelect) {
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

function executionAdmission(ownerRuntime: QaFileOwnerRuntime) {
  return { ownerRuntime, outerNotifications: createReplacementRootNotifications(), resolutionMap: new Map<string, unknown>(),
    bindResolutionMap: () => {}, driftBudget: { corrections: 0 } };
}

async function assertP1AdapterAttempt(db: Db, context: AdapterExecutionContext, expected: {
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

async function waitForP1ProducerDrain(db: Db, identity: NonNullable<Awaited<ReturnType<typeof freezeHeartbeatActualDrainIdentity>>>,
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

async function replacementQueue() {
  const s = await source();
  await db.update(workflowDefinitions).set({ stepsJson: [{ id: "agent-root", name: "Agent root", type: "agent", agentId: s.actor.agentId, dependencies: [] }] }).where(eq(workflowDefinitions.id, s.run.workflowId));
  const proposal = await proposeReplacement(db, s.companyId, s.board, { sourceRunId: s.run.id, decisionEventId: s.input.replacementIntent.decisionEventId,
    idempotencyKey: "heartbeat-budget", metadata: {}, externalEffects: "operator_reconciled" });
  await approveReplacement(db, s.companyId, proposal.id, s.board);
  const target = (await admitReplacement(db, { ...s.input, replacementIntent: { ...s.input.replacementIntent, approvalId: proposal.id, idempotencyKey: "heartbeat-budget" } }, s.actor)).run;
  await claimPlainWorkflowStart(db, target.id, { activateMission: async () => {} } as never);
  await syncWorkflowRunState(db, target.id);
  const [request] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.workflowRunId, target.id));
  expect(request.status).toBe("queued");
  return { ...s, target, request };
}

it.each(["typed", "issue-only"])("refuses %s old-source wake after replacement starts", async (scope) => {
  const s = await source();
  const target = (await admitReplacement(db, s.input, s.actor)).run;
  expect(await claimPlainWorkflowStart(db, target.id, { activateMission: async () => {} } as never)).toBe("started");
  try {
    const context = { issueId: s.issue.id, ...(scope === "typed" ? { workflowRunId: s.run.id, workflowStepRunId: s.downstreamStepRunId } : {}) };
    const result = await heartbeatService(db).wakeup(s.actor.agentId, { source: "assignment", reason: "workflow_step_runnable", payload: context, contextSnapshot: context }).catch((error: Error) => error);
    await waitForHeartbeatExecutionsToDrain(db);
    expect(adapter).not.toHaveBeenCalled();
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("workflow_run_replaced");
    expect((await db.select().from(workflowRuns).where(eq(workflowRuns.id, s.run.id)))[0].status).toBe("failed");
  } finally { await stop(s); }
});

it("P1 execution root proves a pre-invocation C5 hold and returns adapter work boxed after DB settlement", async () => {
  let harness: AdmissionHarness | undefined;
  let nativeBlocker: Awaited<ReturnType<ReturnType<typeof createQaFileOwnerRuntime>["begin"]>> | null = null;
  let pendingRoot: Promise<unknown> | null = null;
  let pendingActual: ReturnType<typeof deferred<string>> | null = null;
  const nativeExits: Promise<unknown>[] = [];
  const producerGate = deferred<void>(), qaLedgerGate = deferred<void>(), qaRelease = deferred<void>();
  const producerEntered = deferred<string>(), producerCompleted = deferred<void>(), qaEntered = deferred<string>();
  const qaVerdictWritten = deferred<void>();
  const adapterHandlers = new Map<string, (context: AdapterExecutionContext) => Promise<AdapterExecutionResult>>();
  const unexpectedAdapterEntries: Array<Record<string, unknown>> = [];
  const rejectedQaEntryDiagnostics: Array<Record<string, unknown>> = [];
  const priorEnv = new Map<string, string | undefined>(["PAPERCLIP_STORAGE_PROVIDER", "PAPERCLIP_STORAGE_LOCAL_DIR",
    "PAPERCLIP_WORKFLOW_INSTANT_ADVANCE", "PAPERCLIP_QA_FILE_OWNER_LOCK_ROOT", "PAPERCLIP_QA_FILE_OWNER_PYTHON"]
    .map(key => [key, process.env[key]] as const));
  let producerEntries = 0, originalQaEntries = 0, qaRefireAttempts = 0, qaRefireEntries = 0;
  let qaEntryPhase: "producer_post_drain_sync" | "P1" | "QA release" | "cleanup" = "producer_post_drain_sync";
  let originalQaHeartbeatId: string | null = null, originalQaVerdictEventId: string | null = null;
  let reservationForQaRefire: Awaited<ReturnType<typeof prepareQaRemediationReservation>> | null = null;
  let qaRefireHeartbeatId: string | null = null, qaRefireWakeId: string | null = null;
  let qaRefireCompletionEventId: string | null = null, qaRefirePassVerdictEventId: string | null = null;
  let qaRefireHeartbeatIdentity: Record<string, unknown> | null = null;
  let bodyFailed = false;
  let bodyFailure: unknown;
  const cleanupFailures: unknown[] = [];
  const producerActual: AdapterExecutionResult = { exitCode: 0, signal: null, timedOut: false,
    usage: { inputTokens: 90, cachedInputTokens: 30, outputTokens: 40 }, provider: "p1-producer", model: "fixture",
    costUsd: 0.25, resultJson: { stdout: "P1 producer actual", stderr: "" }, sessionId: "p1-producer-session", runtimeServices: [] };
  const qaActual: AdapterExecutionResult = { exitCode: 0, signal: null, timedOut: false, usage: null,
    provider: "p1-qa", model: "fixture", resultJson: { stdout: "P1 QA actual", stderr: "" }, runtimeServices: [] };
  const qaRefireActual: AdapterExecutionResult = { exitCode: 0, signal: null, timedOut: false, usage: null,
    provider: "p1-qa-refire", model: "fixture", resultJson: { stdout: "P1 QA refire verified published artifact", stderr: "" }, runtimeServices: [] };
  const rejectQaEntry = (context: AdapterExecutionContext, reason: string, details: Record<string, unknown> = {}): never => {
    const diagnostic = { phase: qaEntryPhase, reason, contextRunId: context.runId,
      contextAgentId: context.agent.id,
      contextIssueId: typeof context.context.issueId === "string" ? context.context.issueId : null, ...details };
    if (rejectedQaEntryDiagnostics.length === 0) rejectedQaEntryDiagnostics.push(diagnostic);
    throw new Error(`rejected P1 QA entry: ${JSON.stringify(diagnostic)}`);
  };
  const requireQaEntry = (condition: boolean, context: AdapterExecutionContext, reason: string,
    details: Record<string, unknown> = {}) => {
    if (!condition) rejectQaEntry(context, reason, details);
  };
  const cleanOwnerExit = (exit: unknown) => {
    if (!exit || typeof exit !== "object" || (exit as { code?: unknown }).code !== 0
      || (exit as { signal?: unknown }).signal !== null) throw new Error("P1 native owner did not exit positively");
  };
  try {
    harness = await createAdmissionHarness();
    process.env.PAPERCLIP_STORAGE_PROVIDER = "local_disk";
    const storageRoot = path.join(harness.root, "storage");
    process.env.PAPERCLIP_STORAGE_LOCAL_DIR = storageRoot;
    process.env.PAPERCLIP_WORKFLOW_INSTANT_ADVANCE = "0";
    process.env.PAPERCLIP_QA_FILE_OWNER_LOCK_ROOT = harness.lockRoot;
    process.env.PAPERCLIP_QA_FILE_OWNER_PYTHON = PYTHON!;
    await mkdir(storageRoot, { recursive: true });
    await harness.db.insert(instanceSettings).values({ singletonKey: "default", experimental: { enableHeartbeatFinalizationV1: true } })
      .onConflictDoUpdate({ target: instanceSettings.singletonKey, set: { experimental: { enableHeartbeatFinalizationV1: true } } });
    const scenario = await createP1LifecycleScenario(harness);
    adapter.mockImplementation(async (context: AdapterExecutionContext) => {
      const [heartbeat] = await harness!.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, context.runId));
      const [wake] = heartbeat?.wakeupRequestId
        ? await harness!.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, heartbeat.wakeupRequestId)) : [];
      const issueId = wake?.issueId ?? heartbeat?.issueId
        ?? (typeof context.context.issueId === "string" ? context.context.issueId : null);
      const [issue] = issueId ? await harness!.db.select().from(issues).where(eq(issues.id, issueId)) : [];
      const stepRunId = heartbeat?.workflowStepRunId ?? wake?.workflowStepRunId ?? null;
      const [step] = stepRunId ? await harness!.db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId)) : [];
      let attemptProof: unknown = null;
      if (wake) { try { attemptProof = readWorkflowAttemptProof(wake); } catch (error) { attemptProof = { invalid: String(error) }; } }
      const diagnostic = { contextRunId: context.runId, contextAgentId: context.agent.id,
        contextIssueId: typeof context.context.issueId === "string" ? context.context.issueId : null,
        heartbeat: heartbeat ? { id: heartbeat.id, companyId: heartbeat.companyId, agentId: heartbeat.agentId,
          issueId: heartbeat.issueId, wakeupRequestId: heartbeat.wakeupRequestId, status: heartbeat.status,
          workflowStepRunId: heartbeat.workflowStepRunId, workflowExecutionGeneration: heartbeat.workflowExecutionGeneration } : null,
        wake: wake ? { id: wake.id, companyId: wake.companyId, agentId: wake.agentId, issueId: wake.issueId,
          missionId: wake.missionId, workflowRunId: wake.workflowRunId, workflowStepRunId: wake.workflowStepRunId,
          workflowExecutionGeneration: wake.workflowExecutionGeneration, runId: wake.runId, status: wake.status } : null,
        issue: issue ? { id: issue.id, companyId: issue.companyId, missionId: issue.missionId,
          assigneeAgentId: issue.assigneeAgentId, originRunId: issue.originRunId } : null,
        step: step ? { id: step.id, workflowRunId: step.workflowRunId, stepId: step.stepId, issueId: step.issueId,
          executionGeneration: step.executionGeneration, retryCount: step.retryCount, iterationIndex: step.iterationIndex } : null,
        attemptProof };
      const handler = issueId ? adapterHandlers.get(issueId) : undefined;
      if (!handler) {
        unexpectedAdapterEntries.push(diagnostic);
        throw new Error(`unregistered P1 adapter entry ${JSON.stringify(diagnostic)}`);
      }
      return handler(context);
    });
    adapterHandlers.set(scenario.producerIssueId, async context => {
      producerEntries++;
      if (producerEntries !== 1) throw new Error(`duplicate P1 producer actual entry ${context.runId}`);
      const observed = await assertP1AdapterAttempt(harness!.db, context, { companyId: scenario.companyId,
        agentId: scenario.authorId, missionId: scenario.missionId, workflowRunId: scenario.runId,
        issueId: scenario.producerIssueId, stepRunId: scenario.producer.id, stepId: scenario.producer.stepId });
      producerEntered.resolve(context.runId);
      await producerGate.promise;
      await mkdir(path.dirname(scenario.file), { recursive: true });
      await writeFile(scenario.file, "before\n", "utf8");
      const actor = { actorType: "agent" as const, actorId: scenario.authorId, agentId: scenario.authorId, runId: context.runId };
      await registerWorkflowArtifact({ db: harness!.db, issue: observed.issue, actor,
        data: { path: scenario.file, type: "document", isPrimary: true } });
      if (!(await registeredProducer(harness!.db, scenario.companyId, scenario.producerIssueId, context.runId))) {
        throw new Error("P1 producer actual has no registered producer provenance");
      }
      await completeWorkflowIssue({ db: harness!.db, issue: observed.issue, actor, data: {} });
      producerCompleted.resolve();
      return producerActual;
    });
    adapterHandlers.set(scenario.qaIssueId, async context => {
      if (originalQaHeartbeatId === null) {
        originalQaEntries++;
        originalQaHeartbeatId = context.runId;
        requireQaEntry(originalQaEntries === 1 && qaEntryPhase === "producer_post_drain_sync", context,
          "original QA actual did not enter once during the producer post-drain phase", { originalQaEntries });
        const observed = await assertP1AdapterAttempt(harness!.db, context, { companyId: scenario.companyId,
          agentId: scenario.verifierId, missionId: scenario.missionId, workflowRunId: scenario.runId,
          issueId: scenario.qaIssueId, stepRunId: scenario.qa.id, stepId: scenario.qa.stepId });
        requireQaEntry(observed.wake.payload?.qaRemediationCompletion == null, context,
          "original QA actual unexpectedly carries a completion-refire binding", { wakeupRequestId: observed.wake.id });
        qaEntered.resolve(context.runId);
        await qaLedgerGate.promise;
        const ledger = await recordWorkflowValidationVerdict({ db: harness!.db, issue: observed.issue,
          source: "workflow_api", verdict: "request_changes", actorAgentId: scenario.verifierId,
          heartbeatRunId: context.runId, findings: [{ id: "p1-artifact", summary: "Producer report needs correction", layer: "artifact" }],
          remediations: { items: [{ op: "string_replace", file: scenario.file, find: "before", replace: "after" }] } });
        expect(ledger.satisfied).toBe(true);
        const verdicts = await harness!.peer.select().from(workflowTransitionEvents).where(and(
          eq(workflowTransitionEvents.companyId, scenario.companyId), eq(workflowTransitionEvents.missionId, scenario.missionId),
          eq(workflowTransitionEvents.workflowRunId, scenario.runId), eq(workflowTransitionEvents.workflowStepRunId, scenario.qa.id),
          eq(workflowTransitionEvents.issueId, scenario.qaIssueId), eq(workflowTransitionEvents.heartbeatRunId, context.runId),
          eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
          eq(workflowTransitionEvents.verdict, "request_changes")));
        expect(verdicts).toHaveLength(1);
        originalQaVerdictEventId = verdicts[0]!.id;
        expect(verdicts[0]!.payload).toMatchObject({ kind: "workflow_validation_verdict", verdict: "request_changes",
          workflowRunId: scenario.runId, stepRunId: scenario.qa.id, issueId: scenario.qaIssueId,
          remediations: { items: [{ op: "string_replace", file: scenario.file, find: "before", replace: "after" }] } });
        qaVerdictWritten.resolve();
        await qaRelease.promise;
        return qaActual;
      }
      qaRefireAttempts++;
      if (context.runId === originalQaHeartbeatId) {
        return rejectQaEntry(context, "same-original QA heartbeat attempted a second adapter entry", { qaRefireAttempts });
      }
      requireQaEntry(qaRefireAttempts === 1 && qaRefireEntries === 0, context,
        "extra QA refire entry", { qaRefireAttempts, qaRefireEntries });
      requireQaEntry(qaEntryPhase === "QA release", context,
        "QA refire entered outside the released completion phase");
      if (!reservationForQaRefire || reservationForQaRefire.outcome !== "prepared" || !originalQaVerdictEventId) {
        return rejectQaEntry(context, "QA refire has no committed preparation and original verdict binding");
      }
      const reservation = reservationForQaRefire;
      const observed = await assertP1AdapterAttempt(harness!.peer, context, { companyId: scenario.companyId,
        agentId: scenario.verifierId, missionId: scenario.missionId, workflowRunId: scenario.runId,
        issueId: scenario.qaIssueId, stepRunId: scenario.qa.id, stepId: scenario.qa.stepId });
      const preparationRows = await harness!.peer.select().from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.id, reservation.preparationEventId),
        eq(workflowTransitionEvents.companyId, scenario.companyId), eq(workflowTransitionEvents.missionId, scenario.missionId),
        eq(workflowTransitionEvents.workflowRunId, scenario.runId),
        eq(workflowTransitionEvents.workflowStepRunId, scenario.producer.id),
        eq(workflowTransitionEvents.issueId, scenario.producerIssueId),
        eq(workflowTransitionEvents.eventType, QA_REMEDIATION_PREPARATION_EVENT_TYPE)));
      requireQaEntry(preparationRows.length === 1
        && preparationRows[0]!.id === reservation.preparation.preparationId
        && isDeepStrictEqual(preparationRows[0]!.payload, reservation.preparation), context,
      "QA refire preparation row is not the unique committed reservation", { preparationRowIds: preparationRows.map(row => row.id) });
      const [completionRows, sourceVerdictRows] = await Promise.all([
        harness!.peer.select().from(workflowTransitionEvents).where(and(
          eq(workflowTransitionEvents.companyId, scenario.companyId), eq(workflowTransitionEvents.missionId, scenario.missionId),
          eq(workflowTransitionEvents.workflowRunId, scenario.runId),
          eq(workflowTransitionEvents.workflowStepRunId, scenario.producer.id),
          eq(workflowTransitionEvents.issueId, scenario.producerIssueId),
          eq(workflowTransitionEvents.eventType, QA_REMEDIATION_COMPLETION_EVENT_TYPE))),
        harness!.peer.select().from(workflowTransitionEvents).where(and(
          eq(workflowTransitionEvents.id, originalQaVerdictEventId),
          eq(workflowTransitionEvents.companyId, scenario.companyId), eq(workflowTransitionEvents.missionId, scenario.missionId),
          eq(workflowTransitionEvents.workflowRunId, scenario.runId),
          eq(workflowTransitionEvents.workflowStepRunId, scenario.qa.id),
          eq(workflowTransitionEvents.issueId, scenario.qaIssueId),
          eq(workflowTransitionEvents.heartbeatRunId, originalQaHeartbeatId),
          eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
          eq(workflowTransitionEvents.verdict, "request_changes"))),
      ]);
      requireQaEntry(completionRows.length === 1, context,
        "QA refire requires exactly one committed completion event", { completionEventIds: completionRows.map(row => row.id) });
      requireQaEntry(sourceVerdictRows.length === 1 && sourceVerdictRows[0]!.id === originalQaVerdictEventId, context,
        "QA refire source verdict is not the original scoped request-changes event",
        { sourceVerdictEventIds: sourceVerdictRows.map(row => row.id) });
      let completion: ReturnType<typeof parseQaRemediationCompletion>;
      try { completion = parseQaRemediationCompletion(completionRows[0]!.payload); }
      catch (error) { return rejectQaEntry(context, "QA refire completion payload failed its strict schema", { error: String(error) }); }
      const completionEvent = completionRows[0]!;
      requireQaEntry(completionEvent.id === completion.completionId
        && completionEvent.executionGeneration === reservation.preparation.producer.executionGeneration
        && isDeepStrictEqual(completionEvent.payload, completion), context,
      "QA refire completion row does not match its parsed durable receipt", { completionEventId: completionEvent.id });
      requireQaEntry(completion.preparationId === reservation.preparationEventId
        && completion.companyId === scenario.companyId && completion.missionId === scenario.missionId
        && completion.workflowRunId === scenario.runId
        && completion.producer.stepRunId === scenario.producer.id
        && completion.producer.issueId === scenario.producerIssueId
        && completion.producer.executionGeneration === scenario.producer.executionGeneration
        && completion.verdicts.length === 1, context,
      "QA refire completion receipt is not bound to this exact preparation and producer attempt",
      { completionEventId: completionEvent.id, preparationId: completion.preparationId });
      const sourceVerdict = completion.verdicts[0]!;
      requireQaEntry(sourceVerdict.eventId === originalQaVerdictEventId
        && sourceVerdict.heartbeatRunId === originalQaHeartbeatId
        && sourceVerdict.qa.stepRunId === scenario.qa.id && sourceVerdict.qa.stepId === scenario.qa.stepId
        && sourceVerdict.qa.issueId === scenario.qaIssueId
        && sourceVerdict.qa.executionGeneration === scenario.qa.executionGeneration
        && sourceVerdict.qa.retryCount === scenario.qa.retryCount
        && sourceVerdict.qa.iterationIndex === scenario.qa.iterationIndex
        && sourceVerdictRows[0]!.heartbeatRunId === originalQaHeartbeatId, context,
      "QA refire receipt does not reference the original QA attempt and verdict",
      { sourceVerdictEventId: sourceVerdict.eventId, originalQaVerdictEventId });
      requireQaEntry(completion.files.length === 1 && completion.files[0]!.file === scenario.file
        && completion.files[0]!.status === "applied" && completion.wakes.length === 1, context,
      "QA refire completion lacks exact published-file and single-wake evidence",
      { files: completion.files, wakeCount: completion.wakes.length });
      const completionWake = completion.wakes[0]!;
      requireQaEntry(completionWake.kind === "v2_refire"
        && completionWake.sourceVerdictEventId === originalQaVerdictEventId
        && completionWake.agentId === scenario.verifierId && completionWake.issueId === scenario.qaIssueId
        && completionWake.stepRunId === scenario.qa.id && completionWake.stepId === scenario.qa.stepId
        && completionWake.executionGeneration === scenario.qa.executionGeneration
        && completionWake.wakeupRequestId === observed.wake.id
        && completionWake.idempotencyKey === observed.wake.idempotencyKey
        && completionWake.statusAtCommit === "queued", context,
      "QA refire wake does not exactly match the completion receipt", { completionWake, observedWakeId: observed.wake.id });
      const exactWakeRows = await harness!.peer.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.id, completionWake.wakeupRequestId),
        eq(agentWakeupRequests.companyId, scenario.companyId), eq(agentWakeupRequests.agentId, scenario.verifierId),
        eq(agentWakeupRequests.issueId, scenario.qaIssueId), eq(agentWakeupRequests.missionId, scenario.missionId),
        eq(agentWakeupRequests.workflowRunId, scenario.runId), eq(agentWakeupRequests.workflowStepRunId, scenario.qa.id),
        eq(agentWakeupRequests.workflowExecutionGeneration, scenario.qa.executionGeneration)));
      requireQaEntry(exactWakeRows.length === 1 && exactWakeRows[0]!.runId === context.runId
        && exactWakeRows[0]!.payload?.qaRemediationCompletion != null
        && isDeepStrictEqual(exactWakeRows[0]!.payload?.qaRemediationCompletion, {
          preparationEventId: reservation.preparationEventId, sourceVerdictEventId: originalQaVerdictEventId,
        }), context,
      "persisted QA refire wake is missing the exact completion source pointers",
      { wakeRowIds: exactWakeRows.map(row => row.id) });
      qaRefireHeartbeatId = observed.heartbeat.id;
      qaRefireWakeId = observed.wake.id;
      qaRefireCompletionEventId = completionEvent.id;
      qaRefireHeartbeatIdentity = { id: observed.heartbeat.id, companyId: observed.heartbeat.companyId,
        agentId: observed.heartbeat.agentId, issueId: observed.heartbeat.issueId,
        wakeupRequestId: observed.heartbeat.wakeupRequestId, workflowStepRunId: observed.heartbeat.workflowStepRunId,
        workflowExecutionGeneration: observed.heartbeat.workflowExecutionGeneration,
        executorOwnerId: observed.heartbeat.executorOwnerId, executorOwnerLeaseEpoch: observed.heartbeat.executorOwnerLeaseEpoch,
        executorOwnerLeaseToken: observed.heartbeat.executorOwnerLeaseToken,
        executionEpoch: observed.heartbeat.executionEpoch, executionToken: observed.heartbeat.executionToken };
      const publishedBytes = await readFile(scenario.file, "utf8");
      requireQaEntry(publishedBytes === "after\n", context,
        "QA refire did not read the expected published producer bytes", { publishedBytes });
      const actor = { actorType: "agent" as const, actorId: scenario.verifierId,
        agentId: scenario.verifierId, runId: context.runId };
      const pass = await submitWorkflowVerdict({ db: harness!.db, issue: observed.issue, actor, data: { verdict: "pass" } });
      requireQaEntry(pass.satisfied, context, "official QA refire PASS was not recorded");
      const passVerdicts = await harness!.peer.select().from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.companyId, scenario.companyId), eq(workflowTransitionEvents.missionId, scenario.missionId),
        eq(workflowTransitionEvents.workflowRunId, scenario.runId), eq(workflowTransitionEvents.workflowStepRunId, scenario.qa.id),
        eq(workflowTransitionEvents.issueId, scenario.qaIssueId), eq(workflowTransitionEvents.heartbeatRunId, context.runId),
        eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
        eq(workflowTransitionEvents.verdict, "pass")));
      requireQaEntry(passVerdicts.length === 1, context,
        "official QA refire PASS lacks exactly one scoped verdict event", { passVerdictEventIds: passVerdicts.map(row => row.id) });
      qaRefirePassVerdictEventId = passVerdicts[0]!.id;
      expect(passVerdicts[0]!.payload).toMatchObject({ kind: "workflow_validation_verdict", verdict: "pass",
        workflowRunId: scenario.runId, stepRunId: scenario.qa.id, issueId: scenario.qaIssueId });
      const completedQaIssue = await completeWorkflowIssue({ db: harness!.db, issue: observed.issue, actor, data: {} });
      requireQaEntry(completedQaIssue.status === "done", context, "official QA refire completion did not finish its issue",
        { issueId: completedQaIssue.id, status: completedQaIssue.status });
      qaRefireEntries++;
      return qaRefireActual;
    });

    const producerWake = await heartbeatService(harness.db).wakeup(scenario.authorId, { source: "assignment",
      triggerDetail: "system", reason: "workflow_step_runnable",
      payload: { issueId: scenario.producerIssueId, missionId: scenario.missionId, workflowRunId: scenario.runId,
        workflowStepRunId: scenario.producer.id },
      contextSnapshot: { issueId: scenario.producerIssueId, missionId: scenario.missionId, workflowRunId: scenario.runId,
        workflowStepRunId: scenario.producer.id } });
    if (!producerWake?.id || !producerWake.wakeupRequestId) throw new Error("P1 producer wake did not create its heartbeat binding");
    expect(await within(producerEntered.promise, "real P1 producer adapter entry")).toBe(producerWake.id);
    const [startedProducer] = await harness.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, producerWake.id));
    if (!startedProducer) throw new Error("P1 producer heartbeat disappeared after adapter entry");
    const producerDrainIdentity = await freezeHeartbeatActualDrainIdentity(harness.peer, startedProducer,
      { workflowRunId: scenario.runId });
    if (!producerDrainIdentity) throw new Error("P1 producer actual drain identity was not frozen at start");
    const [producerWakeRow] = await harness.peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, producerWake.wakeupRequestId));
    const producerProof = readWorkflowAttemptProof(producerWakeRow!);
    const [proofStep] = await harness.peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, producerProof.stepRunId));
    if (!proofStep) throw new Error(`P1 attempt proof step ${producerProof.stepRunId} disappeared`);
    expect(proofStep).toMatchObject({ id: producerProof.stepRunId, workflowRunId: producerProof.workflowRunId,
      stepId: scenario.producer.stepId, issueId: producerProof.issueId,
      executionGeneration: producerProof.executionGeneration, retryCount: producerProof.retryCount,
      iterationIndex: producerProof.iterationIndex });
    expect(producerProof).toMatchObject({ schemaVersion: 1, companyId: scenario.companyId, agentId: scenario.authorId,
      missionId: scenario.missionId, workflowRunId: scenario.runId, issueId: scenario.producerIssueId,
      stepRunId: scenario.producer.id,
      executionGeneration: scenario.producer.executionGeneration, retryCount: scenario.producer.retryCount,
      iterationIndex: scenario.producer.iterationIndex, wakeupRequestId: producerWake.wakeupRequestId,
      parentHeartbeatRunId: null });
    producerGate.resolve();
    await within(producerCompleted.promise, "real P1 producer issue completion");
    const qaHeartbeatId = await within(qaEntered.promise, "real P1 QA adapter entry");
    expect(originalQaHeartbeatId).toBe(qaHeartbeatId);
    await waitForP1ProducerDrain(harness.peer, producerDrainIdentity, producerActual);
    qaLedgerGate.resolve();
    await within(qaVerdictWritten.promise, "structured verdict written by the real QA callback");
    const reservation = await prepareQaRemediationReservation(harness.db, { companyId: scenario.companyId,
      missionId: scenario.missionId, workflowRunId: scenario.runId, producerStepRunId: scenario.producer.id,
      qaStepRunIds: [scenario.qa.id] });
    expect(reservation.outcome).toBe("prepared");
    if (reservation.outcome !== "prepared") throw new Error(`P1 production reservation failed: ${JSON.stringify(reservation)}`);
    reservationForQaRefire = reservation;
    const [producerStepBefore] = await harness.peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, scenario.producer.id));
    expect((await readQaRemediationActualDrain(harness.peer, reservation.preparation, producerStepBefore!))
      .kind).toBe("proven");
    expect(reservation.preparation.files.map(file => file.path)).toEqual([scenario.file]);
    const [producerHeartbeatBefore] = await harness.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, producerWake.id));
    const [producerWakeBefore] = await harness.peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, producerWake.wakeupRequestId));
    const [qaHeartbeatBefore] = await harness.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, qaHeartbeatId));
    const [qaWakeBefore] = await harness.peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, qaHeartbeatBefore!.wakeupRequestId!));
    const prepEventsBefore = await harness.peer.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.id, reservation.preparationEventId),
      eq(workflowTransitionEvents.companyId, scenario.companyId), eq(workflowTransitionEvents.missionId, scenario.missionId),
      eq(workflowTransitionEvents.workflowRunId, scenario.runId),
      eq(workflowTransitionEvents.workflowStepRunId, scenario.producer.id),
      eq(workflowTransitionEvents.issueId, scenario.producerIssueId),
      eq(workflowTransitionEvents.eventType, QA_REMEDIATION_PREPARATION_EVENT_TYPE)));
    expect(prepEventsBefore).toHaveLength(1);
    const prepEventBefore = prepEventsBefore[0]!;
    expect(qaHeartbeatBefore).toMatchObject({ id: qaHeartbeatId, status: "running", startedAt: expect.any(Date) });
    expect(prepEventBefore).toMatchObject({ id: reservation.preparationEventId, companyId: scenario.companyId,
      missionId: scenario.missionId, workflowRunId: scenario.runId, workflowStepRunId: scenario.producer.id,
      issueId: scenario.producerIssueId, executionGeneration: reservation.preparation.producer.executionGeneration,
      eventType: QA_REMEDIATION_PREPARATION_EVENT_TYPE });
    expect(prepEventBefore.id).toBe(reservation.preparation.preparationId);
    expect(prepEventBefore.payload.preparationId).toBe(reservation.preparationEventId);
    expect(prepEventBefore.payload).toEqual(reservation.preparation);

    qaEntryPhase = "P1";
    const queuedAgentId = await addExecutionCandidateAgent(harness, scenario, "P1 held executor");
    const queuedTarget = await addExecutionCandidateStep(harness, scenario, queuedAgentId, "P1 held executor step");
    const queued = await addExecutionCandidate(harness, scenario, queuedAgentId, queuedTarget);
    const realRuntime = createQaFileOwnerRuntime({ qaFileOwnerLockRoot: harness.lockRoot, qaFileOwnerPython: PYTHON! });
    const nativeWait = deferred<void>();
    const ownerRuntime: QaFileOwnerRuntime = {
      capability: realRuntime.capability,
      begin: async (targets, options = {}) => {
        const owner = await realRuntime.begin(targets, { ...options, onEvent: event => {
          if (event.type === "lock_wait") nativeWait.resolve();
          options.onEvent?.(event);
        } });
        nativeExits.push(owner.awaitExit());
        return owner;
      },
    };
    const [heldIssue] = await harness.peer.select().from(issues).where(eq(issues.id, queuedTarget.issueId));
    const [heldStep] = await harness.peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, queuedTarget.stepRun.id));
    const [heldWake] = await harness.peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queued.wakeupRequestId!));
    const [heldHeartbeat] = await harness.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.id));
    const pendingPreparationIds = [prepEventBefore!.id];
    const wakeIdsBefore = (await harness.peer.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, scenario.companyId), eq(agentWakeupRequests.workflowRunId, scenario.runId)))
      .orderBy(asc(agentWakeupRequests.id))).map(row => row.id);
    let c5WorkCalls = 0;
    nativeBlocker = await realRuntime.begin([scenario.file]);
    const c5Work = withQaCorrectionExecutionRoot(harness.db, queued, {
      phase: "claim",
      admit: (tx, run) => assertHeartbeatRecoveryAdmission(tx, run),
      work: async () => { c5WorkCalls++; throw new Error("pending C5 preparation must hold before work"); },
      sharedAdmission: executionAdmission(ownerRuntime),
    });
    pendingRoot = c5Work;
    void c5Work.catch(() => undefined);
    await within(nativeWait.promise, "P1 native wait before domain locks");
    await harness.peer.transaction(async tx => {
      const [mission] = await tx.select({ id: missions.id }).from(missions)
        .where(eq(missions.id, scenario.missionId)).for("update");
      const [run] = await tx.select({ id: workflowRuns.id }).from(workflowRuns)
        .where(eq(workflowRuns.id, scenario.runId)).for("update");
      expect(mission?.id).toBe(scenario.missionId);
      expect(run?.id).toBe(scenario.runId);
    });
    cleanOwnerExit(await nativeBlocker.close());
    cleanOwnerExit(await nativeBlocker.awaitExit());
    nativeBlocker = null;
    const c5Result = await c5Work;
    pendingRoot = null;
    expect(c5Result.kind).toBe("c5_held_not_invoked");
    if (c5Result.kind !== "c5_held_not_invoked") throw new Error("P1 C5 hold did not return its typed boundary");
    expect(isC5NotInvokedProof(c5Result.proof)).toBe(true);
    const expectedIdentity = captureQaCorrectionExecutionIdentity(queued);
    const proofBinding = readC5NotInvokedProof(c5Result.proof, harness.db, expectedIdentity, "claim");
    expect(Object.isFrozen(proofBinding)).toBe(true);
    expect(proofBinding.scope).toMatchObject({ kind: "linked", primaryWorkflowRunId: scenario.runId });
    expect(() => readC5NotInvokedProof(c5Result.proof, harness.peer, expectedIdentity, "claim"))
      .toThrow(QaRemediationAdmissionHold);
    expect(() => readC5NotInvokedProof(c5Result.proof, harness.db,
      { ...expectedIdentity, heartbeatRunId: randomUUID() }, "claim")).toThrow(QaRemediationAdmissionHold);
    expect(() => readC5NotInvokedProof(c5Result.proof, harness.db, expectedIdentity, "adapter_start"))
      .toThrow(QaRemediationAdmissionHold);
    cleanOwnerExit(await nativeExits[0]!);
    expect(c5WorkCalls).toBe(0);
    expect(await harness.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.id))).toEqual([heldHeartbeat]);
    expect(await harness.peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queued.wakeupRequestId!))).toEqual([heldWake]);
    expect(await harness.peer.select().from(issues).where(eq(issues.id, queuedTarget.issueId))).toEqual([heldIssue]);
    expect(await harness.peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, queuedTarget.stepRun.id))).toEqual([heldStep]);
    expect(await harness.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, producerHeartbeatBefore!.id)))
      .toEqual([producerHeartbeatBefore]);
    expect(await harness.peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, producerWakeBefore!.id)))
      .toEqual([producerWakeBefore]);
    expect(await harness.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, qaHeartbeatBefore!.id)))
      .toEqual([qaHeartbeatBefore]);
    expect(await harness.peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, qaWakeBefore!.id)))
      .toEqual([qaWakeBefore]);
    expect((await harness.peer.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, scenario.companyId), eq(agentWakeupRequests.workflowRunId, scenario.runId)))
      .orderBy(asc(agentWakeupRequests.id))).map(row => row.id)).toEqual(wakeIdsBefore);
    expect(await harness.peer.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, scenario.companyId), eq(workflowTransitionEvents.missionId, scenario.missionId),
      eq(workflowTransitionEvents.workflowRunId, scenario.runId),
      eq(workflowTransitionEvents.workflowStepRunId, scenario.producer.id),
      eq(workflowTransitionEvents.issueId, scenario.producerIssueId),
      eq(workflowTransitionEvents.eventType, QA_REMEDIATION_PREPARATION_EVENT_TYPE)))
      .then(rows => rows.map(row => row.id).sort())).toEqual(pendingPreparationIds);
    expect(await harness.peer.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.workflowRunId, scenario.runId), eq(workflowTransitionEvents.eventType, "qa_remediation_completed")))
      .then(rows => rows)).toEqual([]);
    expect(await harness.peer.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, scenario.companyId), eq(heartbeatRuns.issueId, scenario.producerIssueId),
      eq(heartbeatRuns.workflowStepRunId, scenario.producer.id)))).toHaveLength(1);

    const ordinaryAgentId = await addExecutionCandidateAgent(harness, scenario, "P1 ordinary executor");
    const [ordinary] = await harness.db.insert(heartbeatRuns).values({ companyId: scenario.companyId,
      agentId: ordinaryAgentId, invocationSource: "automation", status: "queued", contextSnapshot: {} }).returning();
    if (!ordinary) throw new Error("P1 unlinked ordinary heartbeat was not created");
    const ordinaryResult = await withQaCorrectionExecutionRoot(harness.db, ordinary, {
      phase: "claim",
      admit: (tx, run) => assertHeartbeatRecoveryAdmission(tx, run),
      work: async (_tx, _run, scope) => {
        expect(scope).toMatchObject({ kind: "unlinked", workflowRunIds: [] });
        return "ordinary performed";
      },
      sharedAdmission: executionAdmission(ownerRuntime),
    });
    expect(ordinaryResult).toMatchObject({ kind: "performed", value: "ordinary performed" });

    qaEntryPhase = "QA release";
    qaRelease.resolve();
    await waitForHeartbeatExecutionsToDrain(harness.db, 60_000);
    expect(unexpectedAdapterEntries).toEqual([]);
    expect(producerEntries).toBe(1);
    expect(rejectedQaEntryDiagnostics).toEqual([]);
    expect(originalQaEntries).toBe(1);
    expect(qaRefireAttempts).toBe(1);
    expect(qaRefireEntries).toBe(1);
    expect(qaRefireHeartbeatId).not.toBe(qaHeartbeatId);
    if (!qaRefireHeartbeatId || !qaRefireWakeId || !qaRefireCompletionEventId || !qaRefirePassVerdictEventId
      || !qaRefireHeartbeatIdentity || !originalQaVerdictEventId || !reservationForQaRefire
      || reservationForQaRefire.outcome !== "prepared") throw new Error("P1 exact QA refire result identity is incomplete");
    const [qaHeartbeatAfter] = await harness.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, qaHeartbeatId));
    expect(qaHeartbeatAfter).toMatchObject({ id: qaHeartbeatId, status: "succeeded", resultJson: qaActual.resultJson,
      companyId: scenario.companyId, agentId: scenario.verifierId, issueId: scenario.qaIssueId,
      workflowStepRunId: scenario.qa.id, workflowExecutionGeneration: scenario.qa.executionGeneration,
      executorOwnerId: qaHeartbeatBefore!.executorOwnerId,
      executorOwnerLeaseEpoch: qaHeartbeatBefore!.executorOwnerLeaseEpoch,
      executorOwnerLeaseToken: qaHeartbeatBefore!.executorOwnerLeaseToken,
      executionEpoch: qaHeartbeatBefore!.executionEpoch, executionToken: qaHeartbeatBefore!.executionToken });
    const [qaRefireHeartbeatAfter] = await harness.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, qaRefireHeartbeatId));
    expect(qaRefireHeartbeatAfter).toMatchObject({ ...qaRefireHeartbeatIdentity, status: "succeeded",
      resultJson: qaRefireActual.resultJson });
    const [qaWakeAfter] = await harness.peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, qaWakeBefore!.id));
    expect(qaWakeAfter).toMatchObject({ id: qaWakeBefore!.id, companyId: scenario.companyId,
      agentId: scenario.verifierId, issueId: scenario.qaIssueId, missionId: scenario.missionId,
      workflowRunId: scenario.runId, workflowStepRunId: scenario.qa.id });
    const [qaRefireWakeAfter] = await harness.peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, qaRefireWakeId));
    expect(qaRefireWakeAfter).toMatchObject({ id: qaRefireWakeId, companyId: scenario.companyId,
      agentId: scenario.verifierId, issueId: scenario.qaIssueId, missionId: scenario.missionId,
      workflowRunId: scenario.runId, workflowStepRunId: scenario.qa.id, runId: qaRefireHeartbeatId,
      idempotencyKey: expect.any(String), payload: expect.objectContaining({
        qaRemediationCompletion: { preparationEventId: reservationForQaRefire.preparationEventId,
          sourceVerdictEventId: originalQaVerdictEventId } }) });
    expect((await harness.peer.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, scenario.companyId), eq(agentWakeupRequests.missionId, scenario.missionId),
      eq(agentWakeupRequests.workflowRunId, scenario.runId), eq(agentWakeupRequests.workflowStepRunId, scenario.qa.id),
      eq(agentWakeupRequests.issueId, scenario.qaIssueId), eq(agentWakeupRequests.agentId, scenario.verifierId)))
      .then(rows => rows.map(row => row.id).sort()))).toEqual([qaWakeBefore!.id, qaRefireWakeId].sort());
    expect((await harness.peer.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, scenario.companyId), eq(heartbeatRuns.issueId, scenario.qaIssueId),
      eq(heartbeatRuns.workflowStepRunId, scenario.qa.id)))
      .then(rows => rows.map(row => row.id).sort()))).toEqual([qaHeartbeatId, qaRefireHeartbeatId].sort());
    const qaVerdictRows = await harness.peer.select({ id: workflowTransitionEvents.id,
      heartbeatRunId: workflowTransitionEvents.heartbeatRunId, verdict: workflowTransitionEvents.verdict,
      eventType: workflowTransitionEvents.eventType }).from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.companyId, scenario.companyId), eq(workflowTransitionEvents.missionId, scenario.missionId),
        eq(workflowTransitionEvents.workflowRunId, scenario.runId), eq(workflowTransitionEvents.workflowStepRunId, scenario.qa.id),
        eq(workflowTransitionEvents.issueId, scenario.qaIssueId),
        eq(workflowTransitionEvents.eventType, "workflow_validation_verdict")));
    expect(qaVerdictRows.sort((left, right) => left.id.localeCompare(right.id))).toEqual([
      { id: originalQaVerdictEventId, heartbeatRunId: qaHeartbeatId, verdict: "request_changes", eventType: "workflow_validation_verdict" },
      { id: qaRefirePassVerdictEventId, heartbeatRunId: qaRefireHeartbeatId, verdict: "pass", eventType: "workflow_validation_verdict" },
    ].sort((left, right) => left.id.localeCompare(right.id)));
    const completionRowsAfter = await harness.peer.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, scenario.companyId), eq(workflowTransitionEvents.missionId, scenario.missionId),
      eq(workflowTransitionEvents.workflowRunId, scenario.runId),
      eq(workflowTransitionEvents.workflowStepRunId, scenario.producer.id),
      eq(workflowTransitionEvents.issueId, scenario.producerIssueId),
      eq(workflowTransitionEvents.eventType, QA_REMEDIATION_COMPLETION_EVENT_TYPE)));
    expect(completionRowsAfter.map(row => row.id)).toEqual([qaRefireCompletionEventId]);
    const preparationRowsAfter = await harness.peer.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, scenario.companyId), eq(workflowTransitionEvents.missionId, scenario.missionId),
      eq(workflowTransitionEvents.workflowRunId, scenario.runId),
      eq(workflowTransitionEvents.workflowStepRunId, scenario.producer.id),
      eq(workflowTransitionEvents.issueId, scenario.producerIssueId),
      eq(workflowTransitionEvents.eventType, QA_REMEDIATION_PREPARATION_EVENT_TYPE)));
    expect(preparationRowsAfter.map(row => row.id)).toEqual(pendingPreparationIds);
    const [qaIssueAfter] = await harness.peer.select().from(issues).where(eq(issues.id, scenario.qaIssueId));
    expect(qaIssueAfter).toMatchObject({ id: scenario.qaIssueId, status: "done", companyId: scenario.companyId,
      missionId: scenario.missionId, assigneeAgentId: scenario.verifierId });
    const publicAdapterCalls = adapter.mock.calls.length;

    const boxScenario = await createP1NoHistoryScenario(harness, scenario.companyId, "P1 adapter-start executor");
    const boxTargetAgentId = boxScenario.agentId;
    const boxTarget = await addExecutionCandidateStep(harness, boxScenario.scenario, boxTargetAgentId, "P1 adapter-start step");
    const boxCandidate = await claimExecutionCandidate(harness,
      await addExecutionCandidate(harness, boxScenario.scenario, boxTargetAgentId, boxTarget));
    const actualEntered = deferred<void>();
    const actual = deferred<string>();
    pendingActual = actual;
    let actualSettled = false;
    const boxAttempt = withQaCorrectionExecutionRoot(harness.db, boxCandidate, {
      phase: "adapter_start",
      admit: (tx, run) => assertHeartbeatRecoveryAdmission(tx, run),
      work: async (_tx, _run, _scope, _context, invokeOnce) => invokeOnce(() => {
        actualEntered.resolve();
        return actual.promise;
      }),
      sharedAdmission: executionAdmission(ownerRuntime),
    });
    pendingRoot = boxAttempt;
    void boxAttempt.catch(() => undefined);
    const boxedBoundary = await boxAttempt;
    pendingRoot = null;
    expect(boxedBoundary.kind).toBe("performed");
    if (boxedBoundary.kind !== "performed") throw new Error("P1 adapter-start did not return performed");
    await actualEntered.promise;
    const actualResult = boxedBoundary.value.result.then(value => {
      actualSettled = true;
      return value;
    });
    await harness.peer.transaction(async tx => {
      const [committed] = await tx.update(issues).set({ title: "peer committed while adapter promise was pending" })
        .where(eq(issues.id, boxTarget.issueId)).returning({ id: issues.id });
      expect(committed?.id).toBe(boxTarget.issueId);
    });
    expect(actualSettled).toBe(false);
    actual.resolve("adapter result");
    pendingActual = null;
    await expect(actualResult).resolves.toBe("adapter result");

    const syncThrowScenario = await createP1NoHistoryScenario(harness, scenario.companyId, "P1 sync-throw executor");
    const syncThrowAgentId = syncThrowScenario.agentId;
    const syncThrowTarget = await addExecutionCandidateStep(harness, syncThrowScenario.scenario, syncThrowAgentId, "P1 sync throw target");
    const syncThrow = await claimExecutionCandidate(harness,
      await addExecutionCandidate(harness, syncThrowScenario.scenario, syncThrowAgentId, syncThrowTarget));
    let syncExecuteCalls = 0;
    const syncError = await withQaCorrectionExecutionRoot(harness.db, syncThrow, {
      phase: "adapter_start",
      admit: (tx, run) => assertHeartbeatRecoveryAdmission(tx, run),
      work: async (_tx, _run, _scope, _context, invokeOnce) => invokeOnce<string>(() => {
        syncExecuteCalls++;
        throw new Error("sync_adapter_throw");
      }),
      sharedAdmission: executionAdmission(ownerRuntime),
    }).catch(error => error);
    expect(syncExecuteCalls).toBe(1);
    expect(syncError).toMatchObject({ message: "sync_adapter_throw" });
    expect(isC5NotInvokedProof(syncError)).toBe(false);
    expect(adapter).toHaveBeenCalledTimes(publicAdapterCalls);
    expect(unexpectedAdapterEntries).toEqual([]);
  } catch (error) {
    qaEntryPhase = "cleanup";
    bodyFailed = true;
    bodyFailure = error;
  }
  qaEntryPhase = "cleanup";
  if (pendingActual) {
    pendingActual.resolve("cleanup result");
    await pendingActual.promise.catch(error => cleanupFailures.push(error));
    pendingActual = null;
  }
  producerGate.resolve();
  qaLedgerGate.resolve();
  qaRelease.resolve();
  if (nativeBlocker) {
    const blocker = nativeBlocker;
    nativeBlocker = null;
    try { cleanOwnerExit(await blocker.close()); } catch (error) { cleanupFailures.push(error); }
    try { cleanOwnerExit(await blocker.awaitExit()); } catch (error) { cleanupFailures.push(error); }
  }
  if (pendingRoot) {
    const root = pendingRoot;
    pendingRoot = null;
    try { await root; } catch (error) { cleanupFailures.push(error); }
  }
  for (const ownerExit of nativeExits) {
    try { cleanOwnerExit(await ownerExit); } catch (error) { cleanupFailures.push(error); }
  }
  if (harness) {
    try { await waitForHeartbeatExecutionsToDrain(harness.db, 60_000); } catch (error) { cleanupFailures.push(error); }
    if (unexpectedAdapterEntries.length) cleanupFailures.push(new Error(
      `unexpected P1 adapter entries: ${JSON.stringify(unexpectedAdapterEntries)}`));
    try { await harness.close(); } catch (error) { cleanupFailures.push(error); }
  }
  for (const [key, value] of priorEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (bodyFailed) {
    if (cleanupFailures.length) throw new AggregateError([bodyFailure, ...cleanupFailures],
      "P1 test body and cleanup both failed", { cause: bodyFailure });
    throw bodyFailure;
  }
  if (cleanupFailures.length === 1) throw cleanupFailures[0];
  if (cleanupFailures.length > 1) throw new AggregateError(cleanupFailures, "P1 test cleanup failed");
}, 180_000);

it.each(["company", "agent"])("blocks replacement queue at %s monthly hard stop without a pause flag", async (scope) => {
  const s = await replacementQueue();
  try {
    if (scope === "company") await db.update(companies).set({ budgetMonthlyCents: 1, spentMonthlyCents: 1 }).where(eq(companies.id, s.companyId));
    else await db.update(agents).set({ budgetMonthlyCents: 1, spentMonthlyCents: 1 }).where(eq(agents.id, s.actor.agentId));
    await heartbeatService(db).resumeQueuedRuns(s.actor.agentId);
    await waitForHeartbeatExecutionsToDrain(db);
    expect(adapter).not.toHaveBeenCalled();
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, s.request.id)))[0].status).toBe("failed");
  } finally { await stop(s); }
});

it.each(["company", "agent", "mission", "heartbeat", "source"])("rechecks %s changed after claim at the actual adapter boundary", async (scope) => {
  const s = await replacementQueue();
  // Real PG trigger changes the authority after claim, during effect-intent recording,
  // immediately before the guarded adapter callback. No service/DB method is mocked.
  const change = scope === "company" ? `update companies set budget_monthly_cents=1, spent_monthly_cents=1 where id='${s.companyId}'`
    : scope === "agent" ? `update agents set budget_monthly_cents=1, spent_monthly_cents=1 where id='${s.actor.agentId}'`
    : scope === "mission" ? `update missions set status='cancelled' where id='${s.mission.id}'`
    : scope === "source" ? `update heartbeat_runs set issue_id='${s.issue.id}', context_snapshot=jsonb_build_object('issueId','${s.issue.id}','workflowRunId','${s.run.id}') where id=NEW.attempt_run_id::uuid`
    : `update heartbeat_runs set status='cancelled' where id=NEW.attempt_run_id::uuid`;
  await db.execute(sql.raw(`create function test_recovery_boundary_change() returns trigger language plpgsql as $$ begin
    if NEW.company_id='${s.companyId}' then ${change}; end if; return NEW; end $$;
    create trigger test_recovery_boundary before insert on effect_intents for each row execute function test_recovery_boundary_change();`));
  try {
    await heartbeatService(db).resumeQueuedRuns(s.actor.agentId);
    await waitForHeartbeatExecutionsToDrain(db);
    expect(adapter).not.toHaveBeenCalled();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, s.request.id));
    expect(run.startedAt).not.toBeNull();
    expect(["failed", "cancelled"]).toContain(run.status);
    if (scope !== "heartbeat") expect(run.errorCode).toBe("heartbeat_recovery_blocked");
    else expect(run.status).toBe("cancelled");
  } finally {
    await db.execute(sql.raw("drop trigger test_recovery_boundary on effect_intents; drop function test_recovery_boundary_change();"));
    await stop(s);
  }
});

it.each(["heartbeat", "wake"])("rejects a stale issued %s for a permanently replaced source", async (kind) => {
  const s = await source();
  await admitReplacement(db, s.input, s.actor);
  const context = { issueId: s.issue.id, workflowRunId: s.run.id, workflowStepRunId: s.downstreamStepRunId, missionId: s.mission.id };
  const [wake] = await db.insert(agentWakeupRequests).values({ companyId: s.companyId, agentId: s.actor.agentId, source: "automation", status: "queued",
    issueId: s.issue.id, workflowRunId: s.run.id, payload: { ...context, _paperclipWakeContext: context } }).returning();
  if (kind === "heartbeat") {
    const [run] = await db.insert(heartbeatRuns).values({ companyId: s.companyId, agentId: s.actor.agentId, issueId: s.issue.id,
      invocationSource: "automation", status: "queued", wakeupRequestId: wake.id, contextSnapshot: context }).returning();
    await db.update(agentWakeupRequests).set({ runId: run.id }).where(eq(agentWakeupRequests.id, wake.id));
  }
  try {
    await heartbeatService(db).resumeQueuedRuns(s.actor.agentId);
    await waitForHeartbeatExecutionsToDrain(db);
    expect(adapter).not.toHaveBeenCalled();
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id)))[0].status).not.toBe("queued");
    expect((await db.select().from(issues).where(eq(issues.id, s.issue.id)))[0].status).toBe("todo");
  } finally { await stop(s); }
});

it("serializes a late old-source wake behind replacement's mission/run transaction", async () => {
  const s = await source();
  let wake!: Promise<unknown>;
  await db.transaction(async (tx) => {
    await tx.select().from(missions).where(eq(missions.id, s.mission.id)).for("update");
    wake = heartbeatService(db).wakeup(s.actor.agentId, { source: "assignment", payload: { issueId: s.issue.id }, contextSnapshot: { issueId: s.issue.id } }).catch((e: Error) => e);
    // Wait until a real backend is blocked by our transaction, not an arbitrary delay.
    await vi.waitFor(async () => {
      const rows = await db.execute(sql`select pid from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%missions%'`);
      expect(rows.length).toBeGreaterThan(0);
    });
    await admitReplacement(tx as unknown as Db, s.input, s.actor);
  });
  try {
    expect(await wake).toMatchObject({ message: "workflow_run_replaced" });
    expect(adapter).not.toHaveBeenCalled();
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.issueId, s.issue.id))).toHaveLength(0);
  } finally { await stop(s); }
});

it("replacement loses to a live source heartbeat admitted under the shared lock", async () => {
  const s = await source();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  adapter.mockImplementationOnce(async () => { entered(); await gate; return { exitCode: 1, signal: null, timedOut: false, errorMessage: "test stop", runtimeServices: [] }; });
  try {
    await heartbeatService(db).wakeup(s.actor.agentId, { source: "assignment", payload: { issueId: s.issue.id }, contextSnapshot: { issueId: s.issue.id } });
    await ready;
    await expect(admitReplacement(db, s.input, s.actor)).rejects.toThrow("replacement_execution_in_flight");
    expect(adapter).toHaveBeenCalledTimes(1);
  } finally {
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, s.actor.agentId));
    release();
    await stop(s);
  }
});

it.each(["company", "agent"])("also blocks the committed cap recovery queue at %s hard stop", async (scope) => {
  const s = await seedCapExhaustedRun(db);
  const result = await applyOwnerCapOverrideRetry(db, { companyId: s.companyId, issueId: s.producerIssueId, ownerAction: capOwnerAction(s) });
  expect(result.kind).toBe("cap_override_applied");
  const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, `cap-override-wake:${s.ownerDecisionEventId}`));
  expect(wake.status).toBe("queued");
  try {
    if (scope === "company") await db.update(companies).set({ budgetMonthlyCents: 1, spentMonthlyCents: 1 }).where(eq(companies.id, s.companyId));
    else await db.update(agents).set({ budgetMonthlyCents: 1, spentMonthlyCents: 1 }).where(eq(agents.id, s.producerAgentId));
    await heartbeatService(db).resumeQueuedRuns(s.producerAgentId);
    await waitForHeartbeatExecutionsToDrain(db);
    expect(adapter).not.toHaveBeenCalled();
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id)))[0].status).toBe("failed");
  } finally {
    await db.update(agents).set({ status: "paused" }).where(eq(agents.companyId, s.companyId));
    await db.update(missions).set({ status: "cancelled" }).where(eq(missions.id, s.missionId));
    await waitForHeartbeatExecutionsToDrain(db);
  }
});

it("starts the accepted replacement queue with budgets available", async () => {
  const s = await replacementQueue();
  try {
    await heartbeatService(db).resumeQueuedRuns(s.actor.agentId);
    await waitForHeartbeatExecutionsToDrain(db);
    expect(adapter.mock.calls.some(([call]) => call.context.workflowRunId === s.target.id)).toBe(true);
  } finally { await stop(s); }
});

it.each(["owner", "legacy"])("preserves unrelated %s heartbeat liveness", async (kind) => {
  const s = await source();
  await admitReplacement(db, s.input, s.actor);
  const [issue] = await db.insert(issues).values({ companyId: s.companyId, assigneeAgentId: s.actor.agentId, title: "Unrelated work", status: "todo",
    ...(kind === "owner" ? { missionId: s.mission.id, originKind: "mission_owner_action" } : {}) }).returning();
  try {
    const accepted = await heartbeatService(db).wakeup(s.actor.agentId, { source: "assignment", payload: { issueId: issue.id }, contextSnapshot: { issueId: issue.id } });
    await waitForHeartbeatExecutionsToDrain(db);
    expect(accepted).not.toBeNull();
    expect(adapter.mock.calls.some(([call]) => call.context.issueId === issue.id)).toBe(true);
  } finally { await stop(s); }
});

it("P2 public execution holds only with typed C5 proof and preserves boxed actual work", async () => {
  const harness = await createAdmissionHarness();
  const savedEnv = new Map<string, string | undefined>(["PAPERCLIP_STORAGE_PROVIDER", "PAPERCLIP_STORAGE_LOCAL_DIR",
    "PAPERCLIP_WORKFLOW_INSTANT_ADVANCE", "PAPERCLIP_QA_FILE_OWNER_LOCK_ROOT", "PAPERCLIP_QA_FILE_OWNER_PYTHON"]
    .map(key => [key, process.env[key]] as const));
  const qaRelease = deferred<void>(), qaEntered = deferred<void>(), qaVerdictWritten = deferred<void>();
  const secondActualRelease = deferred<void>(), secondActualEntered = deferred<AdapterExecutionContext>();
  const nativeWait = deferred<void>(), unknownOwnerBegin = deferred<void>();
  const ownerExits: Promise<unknown>[] = [];
  const ownerTargetSets: string[][] = [];
  const ownerExitByTargetSet = new Map<number, Promise<unknown>>();
  const handlerByIssue = new Map<string, (context: AdapterExecutionContext) => Promise<AdapterExecutionResult>>();
  const handlerByAgent = new Map<string, (context: AdapterExecutionContext) => Promise<AdapterExecutionResult>>();
  const actual = (label: string): AdapterExecutionResult => ({ exitCode: 0, signal: null, timedOut: false,
    usage: null, provider: label, model: "fixture", resultJson: { stdout: label, stderr: "" }, runtimeServices: [] });
  const producerActual = actual("P2 producer actual"), qaActual = actual("P2 QA actual");
  const qaRefireActual = actual("P2 exact QA completion refire"), secondActual = actual("P2 boxed actual result");
  let scenario: Awaited<ReturnType<typeof createP1LifecycleScenario>> | null = null;
  let reservation: Awaited<ReturnType<typeof prepareQaRemediationReservation>> | null = null;
  let originalQaRunId: string | null = null, qaRefireCount = 0, secondEntries = 0, failNextOwnerBegin = false;
  let nativeBlocker: Awaited<ReturnType<ReturnType<typeof createQaFileOwnerRuntime>["begin"]>> | null = null;
  const cleanupFailures: unknown[] = [];
  let bodyFailure: unknown;
  const cleanExit = (exit: unknown) => {
    expect(exit).toMatchObject({ code: 0, signal: null });
  };
  const waitRun = async (runId: string, status: string) => within(vi.waitFor(async () => {
    const [run] = await harness.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.status).toBe(status);
    return run!;
  }, { timeout: 45_000, interval: 20 }), `P2 heartbeat ${runId} reaches ${status}`);
  const publicWakeOptions = (target: { issueId: string; stepRun: typeof workflowStepRuns.$inferSelect },
    current: Awaited<ReturnType<typeof createP1LifecycleScenario>>) => ({
    source: "assignment" as const, triggerDetail: "system" as const, reason: "workflow_step_runnable",
    payload: { issueId: target.issueId, missionId: current.missionId, workflowRunId: current.runId,
      workflowStepRunId: target.stepRun.id },
    contextSnapshot: { issueId: target.issueId, missionId: current.missionId, workflowRunId: current.runId,
      workflowStepRunId: target.stepRun.id },
  });
  try {
    const storageRoot = path.join(harness.root, "storage");
    process.env.PAPERCLIP_STORAGE_PROVIDER = "local_disk";
    process.env.PAPERCLIP_STORAGE_LOCAL_DIR = storageRoot;
    process.env.PAPERCLIP_WORKFLOW_INSTANT_ADVANCE = "0";
    process.env.PAPERCLIP_QA_FILE_OWNER_LOCK_ROOT = harness.lockRoot;
    process.env.PAPERCLIP_QA_FILE_OWNER_PYTHON = PYTHON!;
    await mkdir(storageRoot, { recursive: true });
    await harness.db.insert(instanceSettings).values({ singletonKey: "default", experimental: { enableHeartbeatFinalizationV1: true } })
      .onConflictDoUpdate({ target: instanceSettings.singletonKey, set: { experimental: { enableHeartbeatFinalizationV1: true } } });
    scenario = await createP1LifecycleScenario(harness);
    adapter.mockImplementation((context: AdapterExecutionContext) => {
      const issueId = typeof context.context.issueId === "string" ? context.context.issueId : null;
      const handler = issueId ? handlerByIssue.get(issueId) : handlerByAgent.get(context.agent.id);
      if (!handler) throw new Error(`unregistered P2 public adapter entry ${context.runId}`);
      return handler(context);
    });
    handlerByIssue.set(scenario.producerIssueId, async context => {
      const observed = await assertP1AdapterAttempt(harness.peer, context, { companyId: scenario!.companyId,
        agentId: scenario!.authorId, missionId: scenario!.missionId, workflowRunId: scenario!.runId,
        issueId: scenario!.producerIssueId, stepRunId: scenario!.producer.id, stepId: scenario!.producer.stepId });
      await mkdir(path.dirname(scenario!.file), { recursive: true });
      await writeFile(scenario!.file, "before\n", "utf8");
      const actor = { actorType: "agent" as const, actorId: scenario!.authorId, agentId: scenario!.authorId, runId: context.runId };
      await registerWorkflowArtifact({ db: harness.db, issue: observed.issue, actor,
        data: { path: scenario!.file, type: "document", isPrimary: true } });
      await completeWorkflowIssue({ db: harness.db, issue: observed.issue, actor, data: {} });
      return producerActual;
    });
    handlerByIssue.set(scenario.qaIssueId, async context => {
      const observed = await assertP1AdapterAttempt(harness.peer, context, { companyId: scenario!.companyId,
        agentId: scenario!.verifierId, missionId: scenario!.missionId, workflowRunId: scenario!.runId,
        issueId: scenario!.qaIssueId, stepRunId: scenario!.qa.id, stepId: scenario!.qa.stepId });
      if (originalQaRunId === null) {
        originalQaRunId = context.runId;
        await recordWorkflowValidationVerdict({ db: harness.db, issue: observed.issue, source: "workflow_api",
          verdict: "request_changes", actorAgentId: scenario!.verifierId, heartbeatRunId: context.runId,
          findings: [{ id: "p2-artifact", summary: "Correct the producer artifact", layer: "artifact" }],
          remediations: { items: [{ op: "string_replace", file: scenario!.file, find: "before", replace: "after" }] } });
        qaEntered.resolve();
        qaVerdictWritten.resolve();
        await qaRelease.promise;
        return qaActual;
      }
      qaRefireCount++;
      const [wake] = await harness.peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, observed.wake.id));
      const binding = wake?.payload?.qaRemediationCompletion;
      const completionRows = await harness.peer.select().from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.companyId, scenario!.companyId), eq(workflowTransitionEvents.workflowRunId, scenario!.runId),
        eq(workflowTransitionEvents.workflowStepRunId, scenario!.producer.id),
        eq(workflowTransitionEvents.eventType, QA_REMEDIATION_COMPLETION_EVENT_TYPE)));
      if (!reservation || reservation.outcome !== "prepared" || completionRows.length !== 1 || !binding
        || typeof binding !== "object" || !("sourceVerdictEventId" in binding)
        || typeof binding.sourceVerdictEventId !== "string") {
        throw new Error("P2 QA refire lacks exact committed preparation/completion binding");
      }
      const completion = parseQaRemediationCompletion(completionRows[0]!.payload);
      expect(completion.preparationId).toBe(reservation.preparationEventId);
      expect(completion.completionId).toBe(completionRows[0]!.id);
      expect(completion.verdicts[0]?.heartbeatRunId).toBe(originalQaRunId);
      expect(completion.verdicts[0]?.eventId).toBe(binding.sourceVerdictEventId);
      expect(binding).toEqual({ preparationEventId: reservation.preparationEventId,
        sourceVerdictEventId: expect.any(String) });
      const verdict = await recordWorkflowValidationVerdict({ db: harness.db, issue: observed.issue, source: "workflow_api",
        verdict: "pass", actorAgentId: scenario!.verifierId, heartbeatRunId: context.runId });
      expect(verdict.satisfied).toBe(true);
      const actor = { actorType: "agent" as const, actorId: scenario!.verifierId, agentId: scenario!.verifierId, runId: context.runId };
      await completeWorkflowIssue({ db: harness.db, issue: observed.issue, actor, data: {} });
      return qaRefireActual;
    });

    const realRuntime = createQaFileOwnerRuntime({ qaFileOwnerLockRoot: harness.lockRoot, qaFileOwnerPython: PYTHON! });
    const ownerRuntime: QaFileOwnerRuntime = { capability: realRuntime.capability,
      begin: async (targets, beginOptions = {}) => {
        const targetSetIndex = ownerTargetSets.length;
        ownerTargetSets.push([...targets]);
        if (failNextOwnerBegin) {
          failNextOwnerBegin = false;
          unknownOwnerBegin.resolve();
          throw new Error("P2 generic adapter-start owner failure");
        }
        const owner = await realRuntime.begin(targets, { ...beginOptions, onEvent: event => {
          if (event.type === "lock_wait") nativeWait.resolve();
          beginOptions.onEvent?.(event);
        } });
        const exit = owner.awaitExit();
        ownerExits.push(exit);
        ownerExitByTargetSet.set(targetSetIndex, exit);
        return owner;
      } };
    const ordinaryService = heartbeatService(harness.db, { qaCorrectionExecution: { ownerRuntime } });
    const producerWake = await ordinaryService.wakeup(scenario.authorId, publicWakeOptions(
      { issueId: scenario.producerIssueId, stepRun: scenario.producer }, scenario));
    if (!producerWake?.wakeupRequestId) throw new Error("P2 producer did not enter the existing public wake path");
    const [producerStarted] = await harness.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, producerWake.id));
    if (!producerStarted) throw new Error("P2 producer heartbeat disappeared");
    const producerDrain = await freezeHeartbeatActualDrainIdentity(harness.peer, producerStarted, { workflowRunId: scenario.runId });
    if (!producerDrain) throw new Error("P2 producer actual-drain identity was not frozen");
    await within(qaEntered.promise, "P2 original QA adapter start");
    await within(qaVerdictWritten.promise, "P2 official request-changes verdict");
    const qaRunId = originalQaRunId!;
    const [qaBefore] = await harness.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, qaRunId));
    if (!qaBefore) throw new Error("P2 original QA heartbeat disappeared");
    const [qaWakeBefore] = await harness.peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, qaBefore.wakeupRequestId!));
    const reservationResult = await prepareQaRemediationReservation(harness.db, { companyId: scenario.companyId,
      missionId: scenario.missionId, workflowRunId: scenario.runId, producerStepRunId: scenario.producer.id,
      qaStepRunIds: [scenario.qa.id] });
    expect(reservationResult.outcome).toBe("prepared");
    if (reservationResult.outcome !== "prepared") throw new Error("P2 preparation was not durably prepared");
    reservation = reservationResult;
    await waitForP1ProducerDrain(harness.peer, producerDrain, producerActual);
    const [producerBefore] = await harness.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, producerWake.id));
    const [preparationBefore] = await harness.peer.select().from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.id, reservation.preparationEventId));
    const wakeIdsBefore = (await harness.peer.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, scenario.companyId), eq(agentWakeupRequests.workflowRunId, scenario.runId)))
      .orderBy(asc(agentWakeupRequests.id))).map(row => row.id);

    const optedService = heartbeatService(harness.db, { qaCorrectionExecution: { ownerRuntime } });
    const heldAgentId = await addExecutionCandidateAgent(harness, scenario, "P2 held public executor");
    const heldTarget = await addExecutionCandidateStep(harness, scenario, heldAgentId, "P2 held public step");
    nativeBlocker = await realRuntime.begin([scenario.file]);
    const heldWake = await optedService.wakeup(heldAgentId, publicWakeOptions(heldTarget, scenario));
    if (!heldWake?.wakeupRequestId) throw new Error("P2 held public wake did not create a heartbeat/wake binding");
    await within(nativeWait.promise, "P2 public adapter-start native lock wait");
    const [heldRunBefore] = await harness.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, heldWake.id));
    if (!heldRunBefore) throw new Error("P2 held heartbeat disappeared while its native owner was blocked");
    expect(heldRunBefore).toMatchObject({ status: "running", executorOwnerReleasedAt: null });
    expect(heldRunBefore.executorOwnerAcknowledgedAt).toBeInstanceOf(Date);
    const heldIdentityBefore = captureQaCorrectionExecutionIdentity(heldRunBefore);
    expect(heldIdentityBefore.executorOwnerReleasedAt).toBeNull();
    const [heldStepBefore] = await harness.peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, heldTarget.stepRun.id));
    const [heldIssueBefore] = await harness.peer.select().from(issues).where(eq(issues.id, heldTarget.issueId));
    if (!heldIssueBefore) throw new Error("P2 held issue disappeared while its native owner was blocked");
    await within(harness.peer.transaction(async tx => {
      const [mission] = await tx.select({ id: missions.id }).from(missions).where(eq(missions.id, scenario!.missionId)).for("update");
      const [workflow] = await tx.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.id, scenario!.runId)).for("update");
      expect(mission?.id).toBe(scenario!.missionId);
      expect(workflow?.id).toBe(scenario!.runId);
    }), "P2 peer mission/run transaction commits while native owner is pending");
    const blocker = nativeBlocker;
    nativeBlocker = null;
    cleanExit(await blocker.close());
    cleanExit(await blocker.awaitExit());
    const held = await waitRun(heldWake.id, "failed");
    expect(held.errorCode).toBe("c5_held_not_invoked");
    const heldWakeAfter = await within(vi.waitFor(async () => {
      const [wake] = await harness.peer.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, heldWake.wakeupRequestId));
      expect(wake?.runId).toBe(held.id);
      expect(wake?.status).toBe("failed");
      return wake!;
    }, { timeout: 30_000, interval: 20 }), "P2 exact held wake terminalization");
    expect(heldWakeAfter).toMatchObject({ id: heldWake.wakeupRequestId, runId: held.id, status: "failed" });
    expect(adapter.mock.calls.filter(([call]) => call.context.issueId === heldTarget.issueId)).toHaveLength(0);
    const [heldStepAfter] = await harness.peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, heldTarget.stepRun.id));
    expect(heldStepAfter).toMatchObject({ id: heldStepBefore!.id, workflowRunId: heldStepBefore!.workflowRunId,
      issueId: heldStepBefore!.issueId, executionGeneration: heldStepBefore!.executionGeneration,
      retryCount: heldStepBefore!.retryCount, iterationIndex: heldStepBefore!.iterationIndex,
      status: heldStepBefore!.status });
    const heldIssueAfter = await within(vi.waitFor(async () => {
      const [issue] = await harness.peer.select().from(issues).where(eq(issues.id, heldTarget.issueId));
      expect(issue?.executionRunId).toBeNull();
      expect(issue?.checkoutRunId).toBeNull();
      expect(issue?.executionAgentNameKey).toBeNull();
      expect(issue?.executionLockedAt).toBeNull();
      return issue!;
    }, { timeout: 30_000, interval: 20 }), "P2 exact held issue owner release");
    expect(heldIssueAfter).toMatchObject({ id: heldTarget.issueId, companyId: heldIssueBefore.companyId,
      assigneeAgentId: heldIssueBefore.assigneeAgentId, status: heldIssueBefore.status,
      executionRunId: null, checkoutRunId: null, executionAgentNameKey: null, executionLockedAt: null });
    const [heldRunAfter] = await harness.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, heldWake.id));
    if (!heldRunAfter) throw new Error("P2 held heartbeat disappeared after terminal owner closure");
    expect(heldRunAfter).toMatchObject({
      id: heldIdentityBefore.heartbeatRunId, companyId: heldIdentityBefore.companyId,
      agentId: heldIdentityBefore.agentId, issueId: heldIdentityBefore.issueId,
      wakeupRequestId: heldIdentityBefore.wakeupRequestId,
      workflowStepRunId: heldIdentityBefore.workflowStepRunId,
      workflowExecutionGeneration: heldIdentityBefore.workflowExecutionGeneration,
      retryOfRunId: heldIdentityBefore.retryOfRunId,
      executionScopeKind: heldIdentityBefore.executionScopeKind,
      executionEpoch: heldIdentityBefore.executionEpoch, executionToken: heldIdentityBefore.executionToken,
      executorOwnerId: heldIdentityBefore.executorOwnerId,
      executorOwnerLeaseEpoch: heldIdentityBefore.executorOwnerLeaseEpoch,
      executorOwnerLeaseToken: heldIdentityBefore.executorOwnerLeaseToken,
      executorOwnerLeaseExpiresAt: heldIdentityBefore.executorOwnerLeaseExpiresAt,
      executorOwnerAcknowledgedAt: heldIdentityBefore.executorOwnerAcknowledgedAt,
      processLossRetryCount: heldIdentityBefore.processLossRetryCount,
      status: "failed", errorCode: "c5_held_not_invoked", finalizationVersion: 1,
      terminalOutcome: "failed", terminalDecisionSource: "heartbeat_status:failed:c5_held_not_invoked",
    });
    expect(heldRunAfter.executorOwnerReleasedAt).toBeInstanceOf(Date);
    expect(heldRunAfter.terminalDecidedAt).toBeInstanceOf(Date);
    expect(Number.isFinite(heldRunAfter.executorOwnerReleasedAt!.getTime())).toBe(true);
    expect(Number.isFinite(heldRunAfter.terminalDecidedAt!.getTime())).toBe(true);
    const heldTerminalAuthority = await harness.peer.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, heldRunAfter.companyId),
      eq(workflowTransitionEvents.heartbeatRunId, heldRunAfter.id),
      eq(workflowTransitionEvents.eventType, "workflow_authority_transition"),
      eq(workflowTransitionEvents.idempotencyKey, "terminal-outcome:" + heldRunAfter.id)));
    expect(heldTerminalAuthority).toHaveLength(1);
    expect(heldTerminalAuthority[0]).toMatchObject({
      companyId: heldRunAfter.companyId, workflowRunId: null,
      workflowStepRunId: heldRunAfter.workflowStepRunId, issueId: heldRunAfter.issueId,
      wakeupRequestId: heldRunAfter.wakeupRequestId, heartbeatRunId: heldRunAfter.id,
      executionGeneration: heldRunAfter.workflowExecutionGeneration,
      executorOwnerId: heldRunAfter.executorOwnerId, layer: "workflow_authority",
      decision: "shadow_write", reason: "terminal_outcome_decided",
      reasonCode: "terminal_outcome_decided", idempotencyKey: "terminal-outcome:" + heldRunAfter.id,
    });
    expect(heldTerminalAuthority[0]!.payload).toEqual({
      version: 1, transition: "terminal_outcome_decided",
      executionEpoch: heldRunAfter.executionEpoch, executionToken: heldRunAfter.executionToken,
      ownerLeaseEpoch: heldRunAfter.executorOwnerLeaseEpoch,
      ownerLeaseToken: heldRunAfter.executorOwnerLeaseToken, outcome: "failed",
      source: "heartbeat_status:failed:c5_held_not_invoked",
    });
    expect(await harness.peer.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.heartbeatRunId, heldRunAfter.id),
      eq(workflowTransitionEvents.eventType, "heartbeat_actual_drained_v1")))).toHaveLength(0);
    expect(await harness.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, producerWake.id))).toEqual([producerBefore]);
    expect(await harness.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, qaRunId))).toEqual([qaBefore]);
    expect(await harness.peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, qaWakeBefore!.id))).toEqual([qaWakeBefore]);
    expect(await harness.peer.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, reservation.preparationEventId)))
      .toEqual([preparationBefore]);
    await optedService.resumeQueuedRuns(heldAgentId);
    expect(adapter.mock.calls.filter(([call]) => call.context.issueId === heldTarget.issueId)).toHaveLength(0);
    const wakeIdsAfterHold = (await harness.peer.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, scenario.companyId), eq(agentWakeupRequests.workflowRunId, scenario.runId)))
      .orderBy(asc(agentWakeupRequests.id))).map(row => row.id);
    expect(wakeIdsAfterHold).toEqual([...wakeIdsBefore, heldWake.wakeupRequestId].sort());

    const unrelatedAgentId = randomUUID();
    await harness.db.insert(agents).values({ id: unrelatedAgentId, companyId: scenario.companyId, name: "P2 unrelated U",
      status: "active", adapterType: "codex_local", adapterConfig: { cwd: harness.root, promptTemplate: "P2 unrelated U" },
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 2 } } });
    handlerByAgent.set(unrelatedAgentId, async () => actual("P2 unrelated U complete"));
    const unrelated = await optedService.wakeup(unrelatedAgentId, { source: "on_demand" });
    if (!unrelated) throw new Error("P2 unrelated public U wake was not created");
    expect((await waitRun(unrelated.id, "succeeded")).resultJson).toEqual({ stdout: "P2 unrelated U complete", stderr: "" });

    qaRelease.resolve();
    await waitForHeartbeatExecutionsToDrain(harness.db, 60_000);
    expect(qaRefireCount).toBe(1);
    const [qaAfter] = await harness.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, qaRunId));
    expect(qaAfter).toMatchObject({ id: qaRunId, status: "succeeded", resultJson: qaActual.resultJson,
      executorOwnerId: qaBefore.executorOwnerId, executorOwnerLeaseEpoch: qaBefore.executorOwnerLeaseEpoch,
      executorOwnerLeaseToken: qaBefore.executorOwnerLeaseToken, executionEpoch: qaBefore.executionEpoch,
      executionToken: qaBefore.executionToken });
    const completionRows = await harness.peer.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, scenario.companyId), eq(workflowTransitionEvents.workflowRunId, scenario.runId),
      eq(workflowTransitionEvents.workflowStepRunId, scenario.producer.id),
      eq(workflowTransitionEvents.eventType, QA_REMEDIATION_COMPLETION_EVENT_TYPE)));
    expect(completionRows).toHaveLength(1);
    expect(completionRows[0]!.payload.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: scenario.file, status: "applied" }),
    ]));
    const historicalPreparationRows = await harness.peer.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.id, reservation.preparationEventId),
      eq(workflowTransitionEvents.eventType, QA_REMEDIATION_PREPARATION_EVENT_TYPE)));
    expect(historicalPreparationRows).toHaveLength(1);

    const allowedAgentId = await addExecutionCandidateAgent(harness, scenario, "P2 allowed public executor");
    const allowedTarget = await addExecutionCandidateStep(harness, scenario, allowedAgentId, "P2 allowed public step");
    handlerByIssue.set(allowedTarget.issueId, async context => {
      const observed = await assertP1AdapterAttempt(harness.peer, context, { companyId: scenario!.companyId,
        agentId: allowedAgentId, missionId: scenario!.missionId, workflowRunId: scenario!.runId,
        issueId: allowedTarget.issueId, stepRunId: allowedTarget.stepRun.id, stepId: allowedTarget.stepRun.stepId });
      secondEntries++;
      secondActualEntered.resolve(context);
      await secondActualRelease.promise;
      const actor = { actorType: "agent" as const, actorId: allowedAgentId, agentId: allowedAgentId, runId: context.runId };
      await completeWorkflowIssue({ db: harness.db, issue: observed.issue, actor, data: {} });
      return secondActual;
    });
    const allowedOwnerTargetSetStart = ownerTargetSets.length;
    const allowedWake = await optedService.wakeup(allowedAgentId, publicWakeOptions(allowedTarget, scenario));
    if (!allowedWake) throw new Error("P2 allowed public wake was not created");
    const enteredContext = await within(secondActualEntered.promise, "P2 public allowed adapter entry");
    expect(enteredContext.runId).toBe(allowedWake.id);
    const [allowedStarted] = await harness.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, enteredContext.runId));
    if (!allowedStarted) throw new Error("P2 allowed heartbeat disappeared while actual was pending");
    await within(harness.peer.transaction(async tx => {
      const [mission] = await tx.select({ id: missions.id }).from(missions).where(eq(missions.id, scenario!.missionId)).for("update");
      const [workflow] = await tx.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.id, scenario!.runId)).for("update");
      const [heartbeat] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.id, allowedStarted.id)).for("update");
      const [issue] = await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, allowedTarget.issueId)).for("update");
      expect([mission?.id, workflow?.id, heartbeat?.id, issue?.id]).toEqual([
        scenario!.missionId, scenario!.runId, allowedStarted.id, allowedTarget.issueId]);
    }), "P2 peer mission/run/heartbeat/issue transaction commits during unresolved actual");
    const allowedOwnerTargetSetIndex = ownerTargetSets.findIndex((targets, index) =>
      index >= allowedOwnerTargetSetStart && targets.includes(scenario!.file));
    if (allowedOwnerTargetSetIndex < 0) {
      throw new Error("P2 allowed adapter-start did not begin a new native owner for the historical target");
    }
    const allowedOwnerExit = ownerExitByTargetSet.get(allowedOwnerTargetSetIndex);
    if (!allowedOwnerExit) throw new Error("P2 allowed native owner has no bound close/exit observation");
    cleanExit(await within(allowedOwnerExit, "P2 allowed native owner closes and exits before contender"));
    const contender = await realRuntime.begin([scenario.file]);
    cleanExit(await contender.close());
    cleanExit(await contender.awaitExit());
    expect(secondEntries).toBe(1);
    expect((await harness.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, allowedStarted.id)))[0])
      .toMatchObject({ status: "running", executorOwnerId: allowedStarted.executorOwnerId,
        executorOwnerLeaseEpoch: allowedStarted.executorOwnerLeaseEpoch, executorOwnerLeaseToken: allowedStarted.executorOwnerLeaseToken });
    expect(await harness.peer.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.heartbeatRunId, allowedStarted.id),
      eq(workflowTransitionEvents.eventType, "heartbeat_actual_drained_v1")))).toHaveLength(0);
    secondActualRelease.resolve();
    await waitForHeartbeatExecutionsToDrain(harness.db, 60_000);
    const [allowedAfter] = await harness.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, allowedStarted.id));
    expect(allowedAfter).toMatchObject({ status: "succeeded", resultJson: secondActual.resultJson,
      executorOwnerId: allowedStarted.executorOwnerId, executorOwnerLeaseEpoch: allowedStarted.executorOwnerLeaseEpoch,
      executorOwnerLeaseToken: allowedStarted.executorOwnerLeaseToken, executionEpoch: allowedStarted.executionEpoch,
      executionToken: allowedStarted.executionToken });
    expect(await harness.peer.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.heartbeatRunId, allowedStarted.id),
      eq(workflowTransitionEvents.eventType, "heartbeat_actual_drained_v1")))).toHaveLength(1);

    const unknownAgentId = await addExecutionCandidateAgent(harness, scenario, "P2 unknown adapter-start executor");
    const unknownTarget = await addExecutionCandidateStep(harness, scenario, unknownAgentId, "P2 unknown adapter-start step");
    const wakeIdsBeforeUnknown = (await harness.peer.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, scenario.companyId), eq(agentWakeupRequests.workflowRunId, scenario.runId)))
      .orderBy(asc(agentWakeupRequests.id))).map(row => row.id);
    failNextOwnerBegin = true;
    const unknownWake = await optedService.wakeup(unknownAgentId, publicWakeOptions(unknownTarget, scenario));
    if (!unknownWake?.wakeupRequestId) throw new Error("P2 unknown public wake did not create a heartbeat/wake binding");
    await within(unknownOwnerBegin.promise, "P2 generic adapter-start guard failure before invocation");
    await waitForHeartbeatExecutionsToDrain(harness.db, 60_000);
    const [unknownAfter] = await harness.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, unknownWake.id));
    const [unknownWakeAfter] = await harness.peer.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, unknownWake.wakeupRequestId));
    expect(unknownAfter).toMatchObject({ id: unknownWake.id, status: "running", errorCode: null, finishedAt: null });
    expect(unknownWakeAfter).toMatchObject({ id: unknownWake.wakeupRequestId, runId: unknownWake.id,
      status: "claimed", finishedAt: null });
    expect(adapter.mock.calls.filter(([call]) => call.context.issueId === unknownTarget.issueId)).toHaveLength(0);
    const wakeIdsAfterUnknown = (await harness.peer.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, scenario.companyId), eq(agentWakeupRequests.workflowRunId, scenario.runId)))
      .orderBy(asc(agentWakeupRequests.id))).map(row => row.id);
    expect(wakeIdsAfterUnknown).toEqual([...wakeIdsBeforeUnknown, unknownWake.wakeupRequestId].sort());
    expect(await harness.peer.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.heartbeatRunId, unknownWake.id),
      eq(workflowTransitionEvents.eventType, "heartbeat_actual_drained_v1")))).toHaveLength(0);
  } catch (error) {
    bodyFailure = error;
  } finally {
    qaRelease.resolve();
    secondActualRelease.resolve();
    if (nativeBlocker) {
      const blocker = nativeBlocker;
      nativeBlocker = null;
      try { cleanExit(await blocker.close()); cleanExit(await blocker.awaitExit()); }
      catch (error) { cleanupFailures.push(error); }
    }
    if (scenario) {
      try { await harness.db.update(agents).set({ status: "paused" }).where(eq(agents.companyId, scenario.companyId)); }
      catch (error) { cleanupFailures.push(error); }
      try { await harness.db.update(missions).set({ status: "cancelled" }).where(eq(missions.id, scenario.missionId)); }
      catch (error) { cleanupFailures.push(error); }
    }
    try { await waitForHeartbeatExecutionsToDrain(harness.db, 60_000); } catch (error) { cleanupFailures.push(error); }
    for (const exit of ownerExits) {
      try { cleanExit(await exit); } catch (error) { cleanupFailures.push(error); }
    }
    try { await harness.close(); } catch (error) { cleanupFailures.push(error); }
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  if (bodyFailure) {
    if (cleanupFailures.length) throw new AggregateError([bodyFailure, ...cleanupFailures], "P2 public test and cleanup failed", { cause: bodyFailure });
    throw bodyFailure;
  }
  if (cleanupFailures.length === 1) throw cleanupFailures[0];
  if (cleanupFailures.length > 1) throw new AggregateError(cleanupFailures, "P2 public test cleanup failed");
}, 240_000);

it("G1-B replacement target claim and adapter start preserve source authority", async () => {
  type ObservedExecution = {
    readonly phase: "claim" | "adapter_start";
    readonly identity: QaCorrectionExecutionIdentity;
    readonly admit: (tx: Db, scope: QaCorrectionExecutionScope, context: QaRemediationAdmissionContext) => Promise<boolean>;
    readonly work: (tx: Db, scope: QaCorrectionExecutionScope, context: QaRemediationAdmissionContext,
      invokeOnce: QaCorrectionExecutionInvokeOnce) => Promise<unknown>;
  };
  type ObservedRootInput = { readonly ownerRuntime: QaFileOwnerRuntime; readonly execution?: ObservedExecution;
    readonly [key: string]: unknown };
  type AdmissionObservation = { phase: "claim" | "adapter_start"; heartbeatRunId: string;
    primaryRunId: string | null; pendingEventIds: string[]; scopeRunIds: readonly string[] };
  type OwnerObservation = { phase: "claim" | "adapter_start" | null; heartbeatRunId: string | null;
    targets: readonly string[]; exit?: unknown };
  type ProbeObservation = Readonly<{ kind: "returned"; eventIds: readonly string[] }>
    | Readonly<{ kind: "typed_hold"; name: "QaRemediationAdmissionHold"; reason: string }>
    | Readonly<{ kind: "error"; name: string; message: string }>
    | Readonly<{ kind: "not_run"; reason: "replacement_source_token_absent" }>;
  type SourcePreparationObservation = Readonly<{ eventId: string; workflowRunId: string;
    preparationRowCount: number; exactPreparationRow: boolean;
    completion: Readonly<{ kind: "valid"; completionId: string } | { kind: "invalid"; reason: string }
      | { kind: "missing_or_ambiguous"; rowIds: readonly string[] }
      | { kind: "not_attempted"; reason: string } | { kind: "read_error"; name: string; message: string }> }>;
  type CapturedWorkEntry = Readonly<{
    phase: "claim" | "adapter_start";
    identity: Readonly<{ heartbeatRunId: string; companyId: string; agentId: string; issueId: string | null;
      wakeupRequestId: string | null; workflowStepRunId: string | null; workflowExecutionGeneration: number | null;
      retryOfRunId: string | null; executionScopeKind: string | null; executionEpoch: number | null;
      executionTokenPresent: boolean; executorOwnerId: string | null; executorOwnerLeaseEpoch: number | null;
      ownerLeaseTokenPresent: boolean; executorOwnerLeaseExpiresAt: string | null;
      executorOwnerAcknowledgedAt: string | null; executorOwnerReleasedAt: string | null; processLossRetryCount: number | null }>;
    wake: Readonly<{ kind: "found"; id: string; companyId: string; agentId: string; issueId: string | null;
      missionId: string | null; runId: string | null; workflowRunId: string | null; workflowStepRunId: string | null;
      workflowExecutionGeneration: number | null; status: string; attempt: ReturnType<typeof readWorkflowAttemptProof> }>
      | Readonly<{ kind: "missing" } | { kind: "invalid"; message: string }>;
    scope: Readonly<{ kind: "unlinked" | "linked"; primaryRunId: string | null; workflowRunIds: readonly string[];
      replacementAuthorities: readonly Readonly<{ sourceRunId: string; targetRunId: string; authorityId: string }>[] }>;
    pending: readonly Readonly<{ eventId: string; workflowRunId: string }>[];
    sourcePendingEventIds: readonly string[];
    targetPendingEventIds: readonly string[];
    replacementSourcePreservation: Readonly<{ present: boolean; sourceRunId: string | null; targetRunId: string | null;
      authorityId: string | null; sourceEventIds: readonly string[] }>;
    unresolved: ProbeObservation;
    wrongDatabase: ProbeObservation;
    wrongTarget: ProbeObservation;
    sourcePreparations: readonly SourcePreparationObservation[];
    ownerTargets: readonly string[];
  }>;
  type WorkObservation = Readonly<{ kind: "captured"; heartbeatRunId: string;
    entry: CapturedWorkEntry }> | Readonly<{ kind: "capture_error"; heartbeatRunId: string;
    phase: "claim" | "adapter_start"; name: string; message: string }>;

  let harness: AdmissionHarness | undefined;
  let pair: Awaited<ReturnType<typeof createReplacementAdmissionPair>> | undefined;
  let admissionSpy: { mockRestore: () => void } | undefined;
  let finishCalled = false;
  let primaryFailure: unknown;
  const cleanupFailures: unknown[] = [];
  const workCalls: Array<{ phase: string; heartbeatRunId: string }> = [];
  const admissionObservations: AdmissionObservation[] = [];
  const workObservations: WorkObservation[] = [];
  const ownerObservations: OwnerObservation[] = [];
  const priorHarnessEnv = new Map<string, string | undefined>(["PAPERCLIP_STORAGE_PROVIDER", "PAPERCLIP_STORAGE_LOCAL_DIR",
    "PAPERCLIP_WORKFLOW_INSTANT_ADVANCE", "PAPERCLIP_QA_FILE_OWNER_LOCK_ROOT", "PAPERCLIP_QA_FILE_OWNER_PYTHON"]
    .map(key => [key, process.env[key]] as const));
  let rootCalls = 0;

  const runCandidate = (candidate: typeof heartbeatRuns.$inferSelect, phase: "claim" | "adapter_start",
    ownerRuntime: QaFileOwnerRuntime) => withQaCorrectionExecutionRoot(harness!.db, candidate, {
    phase,
    admit: (tx, run) => assertHeartbeatRecoveryAdmission(tx, run),
    work: async () => { workCalls.push({ phase, heartbeatRunId: candidate.id }); return "unexpected invocation"; },
    sharedAdmission: executionAdmission(ownerRuntime),
  });

  const captureProbe = async (probe: () => Promise<readonly string[]>): Promise<ProbeObservation> => {
    try { return Object.freeze({ kind: "returned", eventIds: Object.freeze([...(await probe())]) }); }
    catch (error) {
      if (error instanceof QaRemediationAdmissionHold) {
        return Object.freeze({ kind: "typed_hold", name: "QaRemediationAdmissionHold", reason: error.reason });
      }
      return Object.freeze({ kind: "error", name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error) });
    }
  };
  const captureSourcePreparation = async (tx: Db, item: QaRemediationAdmissionContext["pending"][number])
    : Promise<SourcePreparationObservation> => {
    try {
      const preparationRows = await tx.select().from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.id, item.eventId),
        eq(workflowTransitionEvents.companyId, item.preparation.companyId),
        eq(workflowTransitionEvents.eventType, QA_REMEDIATION_PREPARATION_EVENT_TYPE)));
      const preparationRow = preparationRows[0];
      const exactPreparationRow = preparationRows.length === 1 && preparationRow?.id === item.eventId
        && preparationRow.missionId === item.preparation.missionId
        && preparationRow.workflowRunId === item.preparation.workflowRunId
        && preparationRow.workflowStepRunId === item.preparation.producer.stepRunId
        && isDeepStrictEqual(preparationRow.payload, item.preparation);
      const completionRows = await tx.select().from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.companyId, item.preparation.companyId),
        eq(workflowTransitionEvents.workflowRunId, item.preparation.workflowRunId),
        eq(workflowTransitionEvents.eventType, QA_REMEDIATION_COMPLETION_EVENT_TYPE),
        eq(workflowTransitionEvents.idempotencyKey, qaRemediationCompletionKey(item.preparation))));
      let completion: SourcePreparationObservation["completion"];
      if (completionRows.length !== 1) {
        completion = Object.freeze({ kind: "missing_or_ambiguous", rowIds: Object.freeze(completionRows.map(row => row.id)) });
      } else if (!exactPreparationRow) {
        completion = Object.freeze({ kind: "not_attempted", reason: "exact_source_preparation_row_unproven" });
      } else {
        const validation = await validateQaRemediationCompletionEvidence(tx, completionRows[0]!, item.preparation);
        completion = validation.ok
          ? Object.freeze({ kind: "valid", completionId: validation.completion.completionId })
          : Object.freeze({ kind: "invalid", reason: validation.reason });
      }
      return Object.freeze({ eventId: item.eventId, workflowRunId: item.preparation.workflowRunId,
        preparationRowCount: preparationRows.length, exactPreparationRow, completion });
    } catch (error) {
      return Object.freeze({ eventId: item.eventId, workflowRunId: item.preparation.workflowRunId,
        preparationRowCount: 0, exactPreparationRow: false,
        completion: Object.freeze({ kind: "read_error", name: error instanceof Error ? error.name : typeof error,
          message: error instanceof Error ? error.message : String(error) }) });
    }
  };
  const captureWorkEntry = async (tx: Db, scope: QaCorrectionExecutionScope, context: QaRemediationAdmissionContext,
    execution: ObservedExecution): Promise<CapturedWorkEntry> => {
    const source = pair!.sourceUnit, target = pair!.targetUnit;
    const token = context.replacementSourcePreservation;
    const sourcePending = context.pending.filter(item => item.preparation.workflowRunId === source.runId);
    const targetPending = context.pending.filter(item => item.preparation.workflowRunId === pair!.targetRun.id);
    const unresolved = await captureProbe(() => unresolvedQaRemediationAdmissionPending(tx, context,
      scope.primaryWorkflowRunId ?? undefined));
    const notRun: ProbeObservation = Object.freeze({ kind: "not_run", reason: "replacement_source_token_absent" });
    const wrongDatabase = token ? await captureProbe(() => unresolvedQaRemediationAdmissionPending(
      harness!.db, context, pair!.targetRun.id)) : notRun;
    const wrongTarget = token ? await captureProbe(() => unresolvedQaRemediationAdmissionPending(
      tx, context, source.runId)) : notRun;
    let wake: CapturedWorkEntry["wake"] = Object.freeze({ kind: "missing" });
    try {
      const [row] = execution.identity.wakeupRequestId
        ? await tx.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, execution.identity.wakeupRequestId)) : [];
      if (row) {
        try {
          const attempt = readWorkflowAttemptProof(row);
          wake = Object.freeze({ kind: "found", id: row.id, companyId: row.companyId, agentId: row.agentId,
            issueId: row.issueId, missionId: row.missionId, runId: row.runId, workflowRunId: row.workflowRunId,
            workflowStepRunId: row.workflowStepRunId, workflowExecutionGeneration: row.workflowExecutionGeneration,
            status: row.status, attempt });
        } catch (error) {
          wake = Object.freeze({ kind: "invalid", message: error instanceof Error ? error.message : String(error) });
        }
      }
    } catch (error) {
      wake = Object.freeze({ kind: "invalid", message: error instanceof Error ? error.message : String(error) });
    }
    const sourcePreparations = await Promise.all(sourcePending.map(item => captureSourcePreparation(tx, item)));
    const replacementAuthorities = scope.kind === "linked" ? scope.replacementAuthorities.map(item => Object.freeze({
      sourceRunId: item.sourceRunId, targetRunId: item.targetRunId, authorityId: item.authority.id,
    })) : [];
    const ownerTargets = [...new Set(ownerObservations.filter(item => item.phase === execution.phase
      && item.heartbeatRunId === execution.identity.heartbeatRunId).flatMap(item => item.targets))].sort();
    return Object.freeze({
      phase: execution.phase,
      identity: Object.freeze({ heartbeatRunId: execution.identity.heartbeatRunId,
        companyId: execution.identity.companyId, agentId: execution.identity.agentId, issueId: execution.identity.issueId,
        wakeupRequestId: execution.identity.wakeupRequestId, workflowStepRunId: execution.identity.workflowStepRunId,
        workflowExecutionGeneration: execution.identity.workflowExecutionGeneration,
        retryOfRunId: execution.identity.retryOfRunId, executionScopeKind: execution.identity.executionScopeKind,
        executionEpoch: execution.identity.executionEpoch, executionTokenPresent: Boolean(execution.identity.executionToken),
        executorOwnerId: execution.identity.executorOwnerId, executorOwnerLeaseEpoch: execution.identity.executorOwnerLeaseEpoch,
        ownerLeaseTokenPresent: Boolean(execution.identity.executorOwnerLeaseToken),
        executorOwnerLeaseExpiresAt: execution.identity.executorOwnerLeaseExpiresAt?.toISOString() ?? null,
        executorOwnerAcknowledgedAt: execution.identity.executorOwnerAcknowledgedAt?.toISOString() ?? null,
        executorOwnerReleasedAt: execution.identity.executorOwnerReleasedAt?.toISOString() ?? null,
        processLossRetryCount: execution.identity.processLossRetryCount }),
      wake,
      scope: Object.freeze({ kind: scope.kind, primaryRunId: scope.primaryWorkflowRunId,
        workflowRunIds: Object.freeze([...scope.workflowRunIds].sort()),
        replacementAuthorities: Object.freeze(replacementAuthorities) }),
      pending: Object.freeze(context.pending.map(item => Object.freeze({ eventId: item.eventId,
        workflowRunId: item.preparation.workflowRunId })).sort((a, b) => a.eventId.localeCompare(b.eventId))),
      sourcePendingEventIds: Object.freeze(sourcePending.map(item => item.eventId).sort()),
      targetPendingEventIds: Object.freeze(targetPending.map(item => item.eventId).sort()),
      replacementSourcePreservation: Object.freeze({ present: Boolean(token), sourceRunId: token?.sourceRunId ?? null,
        targetRunId: token?.targetRunId ?? null, authorityId: token?.authorityId ?? null,
        sourceEventIds: Object.freeze([...(token?.sourceEventIds ?? [])].sort()) }),
      unresolved, wrongDatabase, wrongTarget, sourcePreparations: Object.freeze(sourcePreparations),
      ownerTargets: Object.freeze(ownerTargets),
    });
  };

  const captureSourceState = async () => {
    const source = pair!.sourceUnit;
    const [sourceRun] = await harness!.peer.select().from(workflowRuns).where(eq(workflowRuns.id, source.runId));
    const [producerStep] = await harness!.peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, source.producer.id));
    const [qaStep] = await harness!.peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, source.qa.id));
    const [producerHeartbeat] = await harness!.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source.producerHeartbeatRunId));
    const [qaHeartbeat] = await harness!.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source.automaticQaHeartbeatRunId));
    const [producerWake] = await harness!.peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, source.producerWakeupRequestId));
    const [qaWake] = await harness!.peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, source.automaticQaWakeupRequestId));
    const [product] = await harness!.peer.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, source.producerProduct.id));
    const [preparation] = await harness!.peer.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, source.preparationEventId!));
    return { sourceRun, producerStep, qaStep, producerHeartbeat, qaHeartbeat, producerWake, qaWake, product, preparation,
      fileBytes: await readFile(source.file, "utf8") };
  };
  const heartbeatOwnerIdentity = (heartbeat: typeof heartbeatRuns.$inferSelect) => ({
    id: heartbeat.id, createdAt: heartbeat.createdAt, companyId: heartbeat.companyId,
    agentId: heartbeat.agentId, issueId: heartbeat.issueId, wakeupRequestId: heartbeat.wakeupRequestId,
    workflowStepRunId: heartbeat.workflowStepRunId, workflowExecutionGeneration: heartbeat.workflowExecutionGeneration,
    contextSnapshot: heartbeat.contextSnapshot,
    executionScopeKind: heartbeat.executionScopeKind, executionEpoch: heartbeat.executionEpoch,
    executionToken: heartbeat.executionToken, executorOwnerId: heartbeat.executorOwnerId,
    executorOwnerLeaseEpoch: heartbeat.executorOwnerLeaseEpoch, executorOwnerLeaseToken: heartbeat.executorOwnerLeaseToken,
    executorOwnerLeaseExpiresAt: heartbeat.executorOwnerLeaseExpiresAt, retryOfRunId: heartbeat.retryOfRunId,
    processLossRetryCount: heartbeat.processLossRetryCount, sessionIdAfter: heartbeat.sessionIdAfter,
  });
  const heartbeatContextString = (heartbeat: typeof heartbeatRuns.$inferSelect, key: string) => {
    const value = heartbeat.contextSnapshot?.[key];
    return typeof value === "string" ? value : null;
  };
  const assertFinishedQaPreservation = async (
    unit: NonNullable<typeof pair>["sourceUnit"],
    beforeHeartbeat: typeof heartbeatRuns.$inferSelect,
    beforeWake: typeof agentWakeupRequests.$inferSelect,
    beforeAttempt: ReturnType<typeof readWorkflowAttemptProof>,
    adapterResult: AdapterExecutionResult,
  ) => {
    if (!beforeAttempt) throw new Error("original QA full attempt was missing before its verified finish");
    const [heartbeat] = await harness!.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, beforeHeartbeat.id));
    const [wake] = await harness!.peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, beforeWake.id));
    const [step] = await harness!.peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, unit.qa.id));
    if (!heartbeat || !wake || !step) throw new Error("original QA heartbeat, wake, or step disappeared after verified finish");
    const officialVerdicts = await harness!.peer.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.id, unit.verdictEventId), eq(workflowTransitionEvents.companyId, unit.companyId),
      eq(workflowTransitionEvents.missionId, unit.missionId), eq(workflowTransitionEvents.workflowRunId, unit.runId),
      eq(workflowTransitionEvents.workflowStepRunId, unit.qa.id), eq(workflowTransitionEvents.issueId, unit.qaIssue.id),
      eq(workflowTransitionEvents.heartbeatRunId, unit.verdictHeartbeatId),
      eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
      eq(workflowTransitionEvents.verdict, "request_changes"), eq(workflowTransitionEvents.decision, "request_changes"),
      eq(workflowTransitionEvents.reason, "workflow_api")));
    expect(officialVerdicts).toHaveLength(1);
    const officialVerdict = officialVerdicts[0];
    if (!officialVerdict) throw new Error("original QA request_changes verdict was missing after verified finish");
    expect(unit.verdictHeartbeatId).toBe(beforeHeartbeat.id);
    expect(officialVerdict).toMatchObject({ id: unit.verdictEventId, companyId: unit.companyId,
      missionId: unit.missionId, workflowRunId: unit.runId, workflowStepRunId: unit.qa.id,
      issueId: unit.qaIssue.id, heartbeatRunId: beforeHeartbeat.id, eventType: "workflow_validation_verdict",
      verdict: "request_changes", decision: "request_changes", reason: "workflow_api" });
    const verdictPayload = officialVerdict.payload as { kind?: unknown; verdict?: unknown;
      workflowRunId?: unknown; stepRunId?: unknown; issueId?: unknown; remediations?: { items?: unknown[] } };
    expect(verdictPayload).toMatchObject({ kind: "workflow_validation_verdict", verdict: "request_changes",
      workflowRunId: unit.runId, stepRunId: unit.qa.id, issueId: unit.qaIssue.id });
    expect(Array.isArray(verdictPayload.remediations?.items)).toBe(true);
    expect(hashQaCorrectionPayload(verdictPayload.remediations?.items)).toBe(unit.verdictRemediationsHash);
    const expectedStatus = adapterResult.exitCode === 0 && !adapterResult.timedOut ? "succeeded" : "failed";
    expect(heartbeatOwnerIdentity(heartbeat)).toEqual(heartbeatOwnerIdentity(beforeHeartbeat));
    expect(heartbeat).toMatchObject({ id: beforeHeartbeat.id, companyId: unit.companyId, agentId: unit.verifierId,
      issueId: unit.qaIssue.id, wakeupRequestId: beforeWake.id,
      workflowStepRunId: unit.qa.id, workflowExecutionGeneration: unit.qa.executionGeneration,
      finalizationVersion: 1, status: expectedStatus, finishedAt: expect.any(Date), settledAt: expect.any(Date),
      exitCode: adapterResult.exitCode, signal: adapterResult.signal, resultJson: adapterResult.resultJson,
      usageJson: adapterResult.usage });
    expect(heartbeatContextString(heartbeat, "missionId")).toBe(unit.missionId);
    expect(heartbeatContextString(heartbeat, "workflowRunId")).toBe(unit.runId);
    expect(wake).toMatchObject({ id: beforeWake.id, companyId: unit.companyId, agentId: unit.verifierId,
      issueId: unit.qaIssue.id, missionId: unit.missionId, workflowRunId: unit.runId,
      workflowStepRunId: unit.qa.id, workflowExecutionGeneration: unit.qa.executionGeneration });
    expect(readWorkflowAttemptProof(wake)).toEqual(beforeAttempt);
    expect(step).toMatchObject({ id: unit.qa.id, workflowRunId: unit.runId, stepId: unit.qa.stepId,
      issueId: unit.qaIssue.id, executionGeneration: unit.qa.executionGeneration, retryCount: unit.qa.retryCount,
      iterationIndex: unit.qa.iterationIndex, status: "failed" });
  };

  try {
    harness = await createAdmissionHarness();
    const storageRoot = path.join(harness.root, "storage");
    process.env.PAPERCLIP_STORAGE_PROVIDER = "local_disk";
    process.env.PAPERCLIP_STORAGE_LOCAL_DIR = storageRoot;
    process.env.PAPERCLIP_WORKFLOW_INSTANT_ADVANCE = "0";
    process.env.PAPERCLIP_QA_FILE_OWNER_LOCK_ROOT = harness.lockRoot;
    process.env.PAPERCLIP_QA_FILE_OWNER_PYTHON = PYTHON!;
    await mkdir(storageRoot, { recursive: true });
    await harness.db.insert(instanceSettings).values({ singletonKey: "default", experimental: { enableHeartbeatFinalizationV1: true } })
      .onConflictDoUpdate({ target: instanceSettings.singletonKey, set: { experimental: { enableHeartbeatFinalizationV1: true } } });
    adapter.mockImplementation(executeAdmissionFixtureAdapter);
    const realAdmission = admissionRootModule.withQaRemediationSharedAdmission;
    admissionSpy = vi.spyOn(admissionRootModule, "withQaRemediationSharedAdmission").mockImplementation(((rawInput: unknown) => {
      const input = rawInput as ObservedRootInput;
      const observedExecution = input.execution;
      const phase = observedExecution?.phase ?? null;
      const heartbeatRunId = observedExecution?.identity.heartbeatRunId ?? null;
      const ownerRuntime: QaFileOwnerRuntime = {
        ...input.ownerRuntime,
        begin: async (targets, options) => {
          const owner = await input.ownerRuntime.begin(targets, options);
          const observation: OwnerObservation = { phase, heartbeatRunId, targets: [...owner.targets()] };
          ownerObservations.push(observation);
          return {
            targets: () => owner.targets(),
            close: async () => {
              const exit = await owner.close();
              observation.exit = exit;
              return exit;
            },
            awaitExit: async () => {
              const exit = await owner.awaitExit();
              observation.exit = exit;
              return exit;
            },
          } as Awaited<ReturnType<QaFileOwnerRuntime["begin"]>>;
        },
      };
      if (!observedExecution) return realAdmission({ ...input, ownerRuntime } as never) as never;
      rootCalls++;
      const execution: ObservedExecution = {
        ...observedExecution,
        admit: async (tx, scope, context) => {
          admissionObservations.push({ phase, heartbeatRunId: observedExecution.identity.heartbeatRunId,
            primaryRunId: scope.primaryWorkflowRunId, pendingEventIds: context.pending.map(item => item.eventId).sort(),
            scopeRunIds: scope.workflowRunIds });
          return observedExecution.admit(tx, scope, context);
        },
        work: async (tx, scope, context, invokeOnce) => {
          const heartbeatRunId = observedExecution.identity.heartbeatRunId;
          workCalls.push({ phase, heartbeatRunId });
          let observedTarget = false;
          try {
            const identity = observedExecution.identity;
            let observedStepRunId = identity.workflowStepRunId;
            if (!observedStepRunId && identity.wakeupRequestId) {
              const [wake] = await tx.select().from(agentWakeupRequests).where(and(
                eq(agentWakeupRequests.id, identity.wakeupRequestId),
                eq(agentWakeupRequests.companyId, identity.companyId)));
              if (wake?.runId === identity.heartbeatRunId && wake.agentId === identity.agentId
                && wake.issueId === identity.issueId && wake.workflowRunId === scope.primaryWorkflowRunId) {
                observedStepRunId = wake.workflowStepRunId;
              }
            }
            observedTarget = Boolean(pair && scope.primaryWorkflowRunId === pair.targetRun.id
              && observedStepRunId === pair.targetUnit.qa.id);
          } catch (error) {
            workObservations.push(Object.freeze({ kind: "capture_error", heartbeatRunId, phase,
              name: error instanceof Error ? error.name : typeof error,
              message: error instanceof Error ? error.message : String(error) }));
          }
          if (observedTarget) {
            try {
              workObservations.push(Object.freeze({ kind: "captured", heartbeatRunId,
                entry: await captureWorkEntry(tx, scope, context, observedExecution) }));
            } catch (error) {
              workObservations.push(Object.freeze({ kind: "capture_error", heartbeatRunId, phase,
                name: error instanceof Error ? error.name : typeof error,
                message: error instanceof Error ? error.message : String(error) }));
            }
          }
          return observedExecution.work(tx, scope, context, invokeOnce);
        },
      };
      return realAdmission({ ...input, ownerRuntime, execution } as never) as never;
    }) as never);

    pair = await createReplacementAdmissionPair(harness);
    const sourceProducer = pair.sourceUnit;
    const [sourceProducerRun] = await harness.peer.select().from(workflowRuns).where(eq(workflowRuns.id, sourceProducer.runId));
    const [sourceProducerStep] = await harness.peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, sourceProducer.producer.id));
    const [sourceProducerHeartbeat] = await harness.peer.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, sourceProducer.producerHeartbeatRunId));
    const [sourceProducerWake] = await harness.peer.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, sourceProducer.producerWakeupRequestId));
    const [finalizationSetting] = await harness.peer.select().from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, "default"));
    const sourceProducerAttempt = sourceProducerWake ? readWorkflowAttemptProof(sourceProducerWake) : null;
    const settingExperimental = finalizationSetting?.experimental as Record<string, unknown> | null | undefined;
    const ownerCapabilityProof = {
      finalizationV1Enabled: settingExperimental?.enableHeartbeatFinalizationV1 === true,
      exactSourceRun: Boolean(sourceProducerRun && sourceProducerRun.id === sourceProducer.runId
        && sourceProducerRun.companyId === sourceProducer.companyId && sourceProducerRun.missionId === sourceProducer.missionId),
      exactHeartbeatWakeStepJoin: Boolean(sourceProducerHeartbeat && sourceProducerWake && sourceProducerStep
        && sourceProducerHeartbeat.id === sourceProducer.producerHeartbeatRunId
        && sourceProducerHeartbeat.companyId === sourceProducer.companyId
        && sourceProducerHeartbeat.agentId === sourceProducer.authorId
        && sourceProducerHeartbeat.issueId === sourceProducer.producerIssueId
        && sourceProducerHeartbeat.wakeupRequestId === sourceProducerWake.id
        && sourceProducerHeartbeat.workflowStepRunId === sourceProducer.producer.id
        && sourceProducerHeartbeat.workflowExecutionGeneration === sourceProducer.producer.executionGeneration
        && sourceProducerWake.id === sourceProducer.producerWakeupRequestId
        && sourceProducerWake.runId === sourceProducerHeartbeat.id
        && sourceProducerWake.companyId === sourceProducer.companyId
        && sourceProducerWake.agentId === sourceProducer.authorId
        && sourceProducerWake.issueId === sourceProducer.producerIssueId
        && sourceProducerWake.missionId === sourceProducer.missionId
        && sourceProducerWake.workflowRunId === sourceProducer.runId
        && sourceProducerWake.workflowStepRunId === sourceProducer.producer.id
        && sourceProducerStep.id === sourceProducer.producer.id
        && sourceProducerStep.workflowRunId === sourceProducer.runId
        && sourceProducerStep.issueId === sourceProducer.producerIssueId),
      exactFullAttempt: Boolean(sourceProducerAttempt
        && sourceProducerAttempt.companyId === sourceProducer.companyId
        && sourceProducerAttempt.agentId === sourceProducer.authorId
        && sourceProducerAttempt.issueId === sourceProducer.producerIssueId
        && sourceProducerAttempt.missionId === sourceProducer.missionId
        && sourceProducerAttempt.workflowRunId === sourceProducer.runId
        && sourceProducerAttempt.stepRunId === sourceProducer.producer.id
        && sourceProducerAttempt.executionGeneration === sourceProducer.producer.executionGeneration
        && sourceProducerAttempt.retryCount === sourceProducer.producer.retryCount
        && sourceProducerAttempt.iterationIndex === sourceProducer.producer.iterationIndex
        && sourceProducerAttempt.wakeupRequestId === sourceProducer.producerWakeupRequestId
        && sourceProducerStep?.executionGeneration === sourceProducer.producer.executionGeneration
        && sourceProducerStep?.retryCount === sourceProducer.producer.retryCount
        && sourceProducerStep?.iterationIndex === sourceProducer.producer.iterationIndex),
      finalizationVersionOne: sourceProducerHeartbeat?.finalizationVersion === 1,
      ownerCapabilityFieldsPresent: Boolean(sourceProducerHeartbeat?.executionScopeKind === "workflow_step"
        && sourceProducerHeartbeat.executionEpoch !== null && sourceProducerHeartbeat.executionToken
        && sourceProducerHeartbeat.executorOwnerId && sourceProducerHeartbeat.executorOwnerLeaseEpoch !== null
        && sourceProducerHeartbeat.executorOwnerLeaseToken && sourceProducerHeartbeat.executorOwnerLeaseExpiresAt),
      dispatchOwnerHeartbeatMatches: Boolean(sourceProducerHeartbeat && sourceProducerStep
        && sourceProducerStep.dispatchOwnerHeartbeatRunId === sourceProducerHeartbeat.id),
      dispatchOwnerWakeMatches: Boolean(sourceProducerWake && sourceProducerStep
        && sourceProducerStep.dispatchOwnerWakeupRequestId === sourceProducerWake.id),
    };
    expect(ownerCapabilityProof).toEqual({ finalizationV1Enabled: true, exactSourceRun: true,
      exactHeartbeatWakeStepJoin: true, exactFullAttempt: true, finalizationVersionOne: true,
      ownerCapabilityFieldsPresent: true, dispatchOwnerHeartbeatMatches: true, dispatchOwnerWakeMatches: true });
    const sourceBefore = await captureSourceState();
    const sourceRunSnapshot = { companyId: pair.sourceUnit.companyId, missionId: pair.sourceUnit.missionId,
      workflowId: pair.sourceUnit.workflowId, runId: pair.sourceUnit.runId };
    const targetRunSnapshot = { companyId: pair.targetUnit.companyId, missionId: pair.targetUnit.missionId,
      workflowId: pair.targetUnit.workflowId, runId: pair.targetRun.id };
    const ownerRuntime = createQaFileOwnerRuntime({ qaFileOwnerLockRoot: harness.lockRoot, qaFileOwnerPython: PYTHON! });
    const unionPaths = [pair.sourceUnit.file, pair.targetUnit.file].sort();
    const pendingIds = [pair.sourceUnit.preparationEventId!, pair.targetUnit.preparationEventId!].sort();

    const targetPending = await addG1BDetachedExecutionCandidate(harness, targetRunSnapshot, "G1-B target pending claim");
    const pendingClaim = await runCandidate(targetPending.heartbeat, "claim", ownerRuntime);
    expect(pendingClaim.kind).toBe("c5_held_not_invoked");
    if (pendingClaim.kind !== "c5_held_not_invoked") throw new Error("G1-B target-pending claim was not held before work");
    const pendingClaimBinding = readC5NotInvokedProof(pendingClaim.proof, harness.db,
      captureQaCorrectionExecutionIdentity(targetPending.heartbeat), "claim");
    expect(pendingClaimBinding.scope).toMatchObject({ kind: "linked", primaryWorkflowRunId: pair.targetRun.id });
    expect(pendingClaimBinding.nativeOwner.targets()).toEqual(unionPaths);
    expect(await pendingClaimBinding.nativeOwner.awaitExit()).toMatchObject({ code: 0, signal: null });
    const pendingClaimObservation = admissionObservations.find(item => item.heartbeatRunId === targetPending.heartbeat.id
      && item.phase === "claim");
    expect(pendingClaimObservation?.pendingEventIds).toEqual(pendingIds);
    expect(pendingClaimObservation?.scopeRunIds).toEqual(expect.arrayContaining([pair.sourceUnit.runId, pair.targetRun.id]));

    const targetPendingStarted = await claimExecutionCandidate(harness, targetPending.heartbeat);
    const pendingStart = await runCandidate(targetPendingStarted, "adapter_start", ownerRuntime);
    expect(pendingStart.kind).toBe("c5_held_not_invoked");
    if (pendingStart.kind !== "c5_held_not_invoked") throw new Error("G1-B target-pending adapter start was not held before invocation");
    const pendingStartBinding = readC5NotInvokedProof(pendingStart.proof, harness.db,
      captureQaCorrectionExecutionIdentity(targetPendingStarted), "adapter_start");
    expect(pendingStartBinding.scope).toMatchObject({ kind: "linked", primaryWorkflowRunId: pair.targetRun.id });
    expect(pendingStartBinding.nativeOwner.targets()).toEqual(unionPaths);
    expect(await pendingStartBinding.nativeOwner.awaitExit()).toMatchObject({ code: 0, signal: null });
    const pendingStartObservation = admissionObservations.find(item => item.heartbeatRunId === targetPendingStarted.id
      && item.phase === "adapter_start");
    expect(pendingStartObservation?.pendingEventIds).toEqual(pendingIds);
    expect(workCalls.filter(item => item.heartbeatRunId === targetPendingStarted.id)).toEqual([]);

    const metadataBeforeMismatch = pair.targetRun.metadata;
    const wrongMarkerCandidate = await addG1BDetachedExecutionCandidate(harness, targetRunSnapshot,
      "G1-B invalid replacement marker claim");
    let markerResult: unknown;
    try {
      await harness.db.update(workflowRuns).set({ metadata: { ...metadataBeforeMismatch, replacementAuthorityId: randomUUID() } })
        .where(eq(workflowRuns.id, pair.targetRun.id));
      markerResult = await runCandidate(wrongMarkerCandidate.heartbeat, "claim", ownerRuntime).then(value => value,
        error => error);
      expect(markerResult).toBeInstanceOf(QaRemediationAdmissionHold);
      expect(markerResult).toMatchObject({ reason: "replacement_authority_binding" });
      expect(workCalls.filter(item => item.heartbeatRunId === wrongMarkerCandidate.heartbeat.id)).toEqual([]);
    } finally {
      await harness.db.update(workflowRuns).set({ metadata: metadataBeforeMismatch }).where(eq(workflowRuns.id, pair.targetRun.id));
    }
    const [restoredTargetRun] = await harness.peer.select().from(workflowRuns).where(eq(workflowRuns.id, pair.targetRun.id));
    expect(restoredTargetRun?.metadata).toEqual(metadataBeforeMismatch);

    const sourcePrimary = await addG1BDetachedExecutionCandidate(harness, sourceRunSnapshot, "G1-B source-primary held claim");
    const sourcePrimaryResult = await runCandidate(sourcePrimary.heartbeat, "claim", ownerRuntime).then(value => value,
      error => error);
    expect(sourcePrimaryResult).toBeInstanceOf(HttpError);
    expect(sourcePrimaryResult).toMatchObject({ status: 409, message: "workflow_run_replaced" });
    expect(workCalls.filter(item => item.heartbeatRunId === sourcePrimary.heartbeat.id)).toEqual([]);

    const targetBeforeBytes = await readFile(pair.targetUnit.file, "utf8");
    await expect(syncWorkflowRunStateWithOutcome(harness.db, pair.targetRun.id)).resolves.toMatchObject({ kind: "synced" });
    const targetPreparation = pair.targetUnit.preparation ?? null;
    const targetCompletionKey = targetPreparation ? qaRemediationCompletionKey(targetPreparation) : null;
    const targetCompletions = await harness.peer.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.workflowRunId, pair.targetRun.id),
      eq(workflowTransitionEvents.eventType, QA_REMEDIATION_COMPLETION_EVENT_TYPE)));
    const exactTargetCompletions = targetCompletionKey
      ? targetCompletions.filter(row => row.idempotencyKey === targetCompletionKey) : [];
    const targetCompletionValidation = targetPreparation && exactTargetCompletions.length === 1
      ? await validateQaRemediationCompletionEvidence(harness.peer, exactTargetCompletions[0]!, targetPreparation) : null;
    const targetVerdict = targetPreparation?.verdicts.find(row => row.eventId === pair.targetUnit.verdictEventId
      && row.qa.stepRunId === pair.targetUnit.qa.id && row.qa.issueId === pair.targetUnit.qaIssue.id) ?? null;
    const targetV2Receipts = targetCompletionValidation?.ok && targetVerdict
      ? targetCompletionValidation.completion.wakes.filter(row => row.kind === "v2_refire"
        && row.stepRunId === pair.targetUnit.qa.id && row.sourceVerdictEventId === targetVerdict.eventId) : [];
    const targetV2Receipt = targetV2Receipts.length === 1 ? targetV2Receipts[0]! : null;
    const targetV2WakeKey = targetPreparation && targetVerdict
      ? qaRemediationRefireV2WakeKey(targetPreparation, pair.targetUnit.qa.id, targetVerdict.eventId) : null;
    const targetV2WakesByKey = targetV2WakeKey ? await harness.peer.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, pair.targetUnit.companyId),
      eq(agentWakeupRequests.idempotencyKey, targetV2WakeKey))) : [];
    const [targetV2ReceiptWake] = targetV2Receipt
      ? await harness.peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, targetV2Receipt.wakeupRequestId)) : [];
    const captureAttempt = (wake: typeof agentWakeupRequests.$inferSelect | undefined) => {
      if (!wake) return { kind: "missing" as const };
      try {
        const proof = readWorkflowAttemptProof(wake);
        return proof ? { kind: "parsed" as const, proof }
          : { kind: "invalid" as const, reason: "workflow_attempt_proof_missing" };
      } catch (error) {
        return { kind: "invalid" as const, reason: error instanceof Error ? error.message : String(error) };
      }
    };
    const targetV2AttemptCapture = captureAttempt(targetV2ReceiptWake);
    const targetV2Attempt = targetV2AttemptCapture.kind === "parsed" ? targetV2AttemptCapture.proof : null;
    const targetV2StepRows = targetV2Attempt
      ? await harness.peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, targetV2Attempt.stepRunId)) : [];
    const targetV2Step = targetV2StepRows[0];

    const targetOriginalQaHeartbeatId = pair.targetUnit.automaticQaHeartbeatRunId;
    const targetOriginalQaWakeId = pair.targetUnit.automaticQaWakeupRequestId;
    const [targetOriginalQaHeartbeat] = await harness.peer.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, targetOriginalQaHeartbeatId));
    const [targetOriginalQaWake] = await harness.peer.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, targetOriginalQaWakeId));
    const [targetOriginalQaStep] = await harness.peer.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.id, pair.targetUnit.qa.id));
    const targetOriginalQaAttemptCapture = captureAttempt(targetOriginalQaWake);
    const targetOriginalQaAttempt = targetOriginalQaAttemptCapture.kind === "parsed"
      ? targetOriginalQaAttemptCapture.proof : null;
    const targetOriginalQaBarrier = pair.scenario.qaCompletion.barrierSnapshot()
      .find(item => item.issueId === pair.targetUnit.qaIssue.id) ?? null;

    const inFlightClause = await lifecycleInFlightClause(harness.peer);
    const sameAgentMissionInFlight = await harness.peer.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.agentId, pair.targetUnit.verifierId), inFlightClause,
      sql`heartbeat_runs.context_snapshot ->> 'missionId' = ${pair.targetUnit.missionId}`,
      missionDedupExemptOversightReviewClause));
    const blockerStepIds = [...new Set(sameAgentMissionInFlight.flatMap(row => row.workflowStepRunId ? [row.workflowStepRunId] : []))];
    const blockerWakeIds = [...new Set(sameAgentMissionInFlight.flatMap(row => row.wakeupRequestId ? [row.wakeupRequestId] : []))];
    const blockerSteps = blockerStepIds.length ? await harness.peer.select().from(workflowStepRuns)
      .where(inArray(workflowStepRuns.id, blockerStepIds)) : [];
    const blockerWakes = blockerWakeIds.length ? await harness.peer.select().from(agentWakeupRequests)
      .where(inArray(agentWakeupRequests.id, blockerWakeIds)) : [];
    const blockerEvidence = sameAgentMissionInFlight.map(row => {
      const step = blockerSteps.find(item => item.id === row.workflowStepRunId);
      const wake = blockerWakes.find(item => item.id === row.wakeupRequestId);
      const contextMissionId = heartbeatContextString(row, "missionId");
      const contextWorkflowRunId = heartbeatContextString(row, "workflowRunId");
      const wakeJoinMatches = Boolean(wake && wake.id === row.wakeupRequestId && wake.runId === row.id
        && wake.companyId === row.companyId && wake.agentId === row.agentId && wake.issueId === row.issueId
        && wake.missionId === contextMissionId && wake.workflowRunId === contextWorkflowRunId
        && wake.workflowStepRunId === row.workflowStepRunId
        && wake.workflowExecutionGeneration === row.workflowExecutionGeneration);
      const stepJoinMatches = Boolean(step && wake && step.id === row.workflowStepRunId
        && step.workflowRunId === wake.workflowRunId && step.issueId === wake.issueId
        && step.executionGeneration === wake.workflowExecutionGeneration);
      return { heartbeatRunId: row.id, agentId: row.agentId, contextMissionId, contextWorkflowRunId, issueId: row.issueId,
        status: row.status, finalizationVersion: row.finalizationVersion, settledAt: row.settledAt,
        stepRunId: row.workflowStepRunId, step: step ? { id: step.id, stepId: step.stepId, status: step.status } : null,
        wakeupRequestId: row.wakeupRequestId, wake: wake ? { id: wake.id, status: wake.status, runId: wake.runId,
          workflowRunId: wake.workflowRunId, workflowStepRunId: wake.workflowStepRunId } : null,
        wakeJoinMatches, stepJoinMatches };
    });
    const targetOriginalQaMatchesBlocker = blockerEvidence.some(row => row.heartbeatRunId === targetOriginalQaHeartbeatId
      && row.wakeJoinMatches && row.stepJoinMatches);
    const targetOriginalQaJoinMatches = Boolean(targetOriginalQaHeartbeat && targetOriginalQaWake && targetOriginalQaStep
      && targetOriginalQaHeartbeat.id === targetOriginalQaHeartbeatId
      && targetOriginalQaHeartbeat.companyId === pair.targetUnit.companyId
      && targetOriginalQaHeartbeat.agentId === pair.targetUnit.verifierId
      && heartbeatContextString(targetOriginalQaHeartbeat, "missionId") === pair.targetUnit.missionId
      && heartbeatContextString(targetOriginalQaHeartbeat, "workflowRunId") === pair.targetRun.id
      && targetOriginalQaHeartbeat.issueId === pair.targetUnit.qaIssue.id
      && targetOriginalQaHeartbeat.wakeupRequestId === targetOriginalQaWake.id
      && targetOriginalQaHeartbeat.workflowStepRunId === pair.targetUnit.qa.id
      && targetOriginalQaHeartbeat.workflowExecutionGeneration === pair.targetUnit.qa.executionGeneration
      && targetOriginalQaWake.id === targetOriginalQaWakeId
      && targetOriginalQaWake.runId === targetOriginalQaHeartbeat.id
      && targetOriginalQaWake.companyId === pair.targetUnit.companyId
      && targetOriginalQaWake.agentId === pair.targetUnit.verifierId
      && targetOriginalQaWake.missionId === pair.targetUnit.missionId
      && targetOriginalQaWake.workflowRunId === pair.targetRun.id
      && targetOriginalQaWake.workflowStepRunId === pair.targetUnit.qa.id
      && targetOriginalQaWake.workflowExecutionGeneration === pair.targetUnit.qa.executionGeneration
      && targetOriginalQaStep.id === pair.targetUnit.qa.id
      && targetOriginalQaStep.workflowRunId === pair.targetRun.id
      && targetOriginalQaStep.stepId === pair.targetUnit.qa.stepId
      && targetOriginalQaStep.issueId === pair.targetUnit.qaIssue.id
      && targetOriginalQaStep.executionGeneration === pair.targetUnit.qa.executionGeneration
      && targetOriginalQaStep.retryCount === pair.targetUnit.qa.retryCount
      && targetOriginalQaStep.iterationIndex === pair.targetUnit.qa.iterationIndex
      && targetOriginalQaAttempt?.companyId === pair.targetUnit.companyId
      && targetOriginalQaAttempt?.agentId === pair.targetUnit.verifierId
      && targetOriginalQaAttempt?.missionId === pair.targetUnit.missionId
      && targetOriginalQaAttempt?.workflowRunId === pair.targetRun.id
      && targetOriginalQaAttempt?.issueId === pair.targetUnit.qaIssue.id
      && targetOriginalQaAttempt?.stepRunId === pair.targetUnit.qa.id
      && targetOriginalQaAttempt?.executionGeneration === pair.targetUnit.qa.executionGeneration
      && targetOriginalQaAttempt?.retryCount === pair.targetUnit.qa.retryCount
      && targetOriginalQaAttempt?.iterationIndex === pair.targetUnit.qa.iterationIndex
      && targetOriginalQaAttempt?.wakeupRequestId === targetOriginalQaWakeId);
    const probeEvidence = (name: string, heartbeatIds: string[], agentId: string, result: unknown) => ({
      name, heartbeatIds, agentId,
      phaseObservations: admissionObservations.filter(item => heartbeatIds.includes(item.heartbeatRunId)),
      ownerObservations: ownerObservations.filter(item => item.heartbeatRunId !== null && heartbeatIds.includes(item.heartbeatRunId)),
      workCalls: workCalls.filter(item => heartbeatIds.includes(item.heartbeatRunId)), result,
    });
    const markerResultEvidence = markerResult instanceof QaRemediationAdmissionHold
      ? { kind: "admission_hold", reason: markerResult.reason }
      : { kind: markerResult instanceof Error ? "error" : typeof markerResult };
    const sourcePrimaryResultEvidence = sourcePrimaryResult instanceof HttpError
      ? { kind: "http_error", status: sourcePrimaryResult.status, message: sourcePrimaryResult.message }
      : { kind: sourcePrimaryResult instanceof Error ? "error" : typeof sourcePrimaryResult };
    const targetDiagnostic = {
      schemaVersion: "papercompany.c5.g1b-held-refire-diagnostic.v1",
      eventType: "g1b_public_fixture_held_qa_diagnostic",
      phase: "after_target_sync_before_original_qa_release",
      identity: { companyId: pair.targetUnit.companyId, missionId: pair.targetUnit.missionId,
        sourceRunId: pair.sourceUnit.runId, targetRunId: pair.targetRun.id,
        sourcePreparationEventId: pair.sourceUnit.preparationEventId ?? null,
        targetPreparationEventId: pair.targetUnit.preparationEventId ?? null },
      targetCompletion: { completionKey: targetCompletionKey,
        rowIds: exactTargetCompletions.map(row => row.id), allTargetCompletionIds: targetCompletions.map(row => row.id),
        validation: targetCompletionValidation ? (targetCompletionValidation.ok
          ? { kind: "valid", completionId: targetCompletionValidation.completion.completionId }
          : { kind: "invalid", reason: targetCompletionValidation.reason }) : { kind: "missing_or_nonunique" } },
      targetV2Wake: { receiptCount: targetV2Receipts.length, wakeKey: targetV2WakeKey,
        receiptWakeId: targetV2Receipt?.wakeupRequestId ?? null, wakeByKeyIds: targetV2WakesByKey.map(row => row.id),
        wake: targetV2ReceiptWake ? { id: targetV2ReceiptWake.id, agentId: targetV2ReceiptWake.agentId,
          missionId: targetV2ReceiptWake.missionId, workflowRunId: targetV2ReceiptWake.workflowRunId,
          issueId: targetV2ReceiptWake.issueId, workflowStepRunId: targetV2ReceiptWake.workflowStepRunId,
          workflowExecutionGeneration: targetV2ReceiptWake.workflowExecutionGeneration,
          status: targetV2ReceiptWake.status, runId: targetV2ReceiptWake.runId } : null,
        attempt: targetV2AttemptCapture },
      originalTargetQa: { heartbeatRunId: targetOriginalQaHeartbeat?.id ?? targetOriginalQaHeartbeatId,
        wakeupRequestId: targetOriginalQaWake?.id ?? targetOriginalQaWakeId,
        join: targetOriginalQaJoinMatches ? "matched" : "missing_or_mismatched",
        heartbeat: targetOriginalQaHeartbeat ? { agentId: targetOriginalQaHeartbeat.agentId,
          contextMissionId: heartbeatContextString(targetOriginalQaHeartbeat, "missionId"),
          contextWorkflowRunId: heartbeatContextString(targetOriginalQaHeartbeat, "workflowRunId"),
          issueId: targetOriginalQaHeartbeat.issueId,
          status: targetOriginalQaHeartbeat.status, finalizationVersion: targetOriginalQaHeartbeat.finalizationVersion,
          settledAt: targetOriginalQaHeartbeat.settledAt, workflowStepRunId: targetOriginalQaHeartbeat.workflowStepRunId,
          wakeupRequestId: targetOriginalQaHeartbeat.wakeupRequestId } : null,
        wake: targetOriginalQaWake ? { id: targetOriginalQaWake.id, status: targetOriginalQaWake.status,
          runId: targetOriginalQaWake.runId, workflowRunId: targetOriginalQaWake.workflowRunId,
          workflowStepRunId: targetOriginalQaWake.workflowStepRunId,
          workflowExecutionGeneration: targetOriginalQaWake.workflowExecutionGeneration } : null,
        step: targetOriginalQaStep ? { id: targetOriginalQaStep.id, stepId: targetOriginalQaStep.stepId,
          status: targetOriginalQaStep.status, executionGeneration: targetOriginalQaStep.executionGeneration,
          retryCount: targetOriginalQaStep.retryCount, iterationIndex: targetOriginalQaStep.iterationIndex } : null,
        attempt: targetOriginalQaAttemptCapture, barrier: targetOriginalQaBarrier },
      sameAgentMissionInFlight: blockerEvidence,
      originalQaIsInFlightBlocker: targetOriginalQaMatchesBlocker,
      probes: [
        probeEvidence("target_pending_claim_and_start", [...new Set([targetPending.heartbeat.id, targetPendingStarted.id])],
          targetPending.heartbeat.agentId, { kind: "held_before_work" }),
        probeEvidence("invalid_replacement_marker", [wrongMarkerCandidate.heartbeat.id], wrongMarkerCandidate.heartbeat.agentId,
          markerResultEvidence),
        probeEvidence("source_primary_claim", [sourcePrimary.heartbeat.id], sourcePrimary.heartbeat.agentId,
          sourcePrimaryResultEvidence),
      ],
    };
    process.stdout.write(JSON.stringify(targetDiagnostic) + "\n");
    expect(targetPreparation).toBeTruthy();
    expect(targetCompletionKey).toBeTruthy();
    expect(targetCompletions).toHaveLength(1);
    expect(exactTargetCompletions).toHaveLength(1);
    if (!targetPreparation || !targetCompletionValidation || !targetCompletionValidation.ok || !targetV2Receipt
      || !targetV2WakeKey || !targetV2ReceiptWake || !targetV2Attempt || !targetV2Step) {
      throw new Error("G1-B exact validated target completion, queued v2 wake, or full attempt was missing");
    }
    expect(targetCompletionValidation.completion.completionId).toBe(exactTargetCompletions[0]!.id);
    expect(targetV2Receipt).toMatchObject({ idempotencyKey: targetV2WakeKey, agentId: pair.targetUnit.verifierId,
      issueId: pair.targetUnit.qaIssue.id, stepRunId: pair.targetUnit.qa.id, stepId: pair.targetUnit.qa.stepId,
      executionGeneration: pair.targetUnit.qa.executionGeneration, sourceVerdictEventId: targetVerdict?.eventId,
      statusAtCommit: "queued" });
    expect(targetV2WakesByKey).toHaveLength(1);
    expect(targetV2WakesByKey[0]?.id).toBe(targetV2Receipt.wakeupRequestId);
    expect(targetV2ReceiptWake).toMatchObject({ id: targetV2Receipt.wakeupRequestId, companyId: pair.targetUnit.companyId,
      agentId: pair.targetUnit.verifierId, issueId: pair.targetUnit.qaIssue.id, missionId: pair.targetUnit.missionId,
      workflowRunId: pair.targetRun.id, workflowStepRunId: pair.targetUnit.qa.id,
      workflowExecutionGeneration: pair.targetUnit.qa.executionGeneration, reason: "workflow_step_runnable",
      requestKind: "workflow_resume", idempotencyKey: targetV2WakeKey, status: "queued", runId: null });
    expect((targetV2ReceiptWake.payload as Record<string, unknown>)).toMatchObject({ mutation: "workflow_resume",
      qaRemediationCompletion: { preparationEventId: targetPreparation.preparationId,
        sourceVerdictEventId: targetVerdict?.eventId } });
    expect(targetV2Attempt).toMatchObject({ companyId: pair.targetUnit.companyId, agentId: pair.targetUnit.verifierId,
      missionId: pair.targetUnit.missionId, workflowRunId: pair.targetRun.id, issueId: pair.targetUnit.qaIssue.id,
      stepRunId: pair.targetUnit.qa.id, executionGeneration: pair.targetUnit.qa.executionGeneration,
      retryCount: pair.targetUnit.qa.retryCount, iterationIndex: pair.targetUnit.qa.iterationIndex,
      wakeupRequestId: targetV2ReceiptWake.id });
    expect(targetV2Step).toMatchObject({ id: pair.targetUnit.qa.id, workflowRunId: pair.targetRun.id,
      stepId: pair.targetUnit.qa.stepId, issueId: pair.targetUnit.qaIssue.id,
      executionGeneration: pair.targetUnit.qa.executionGeneration, retryCount: pair.targetUnit.qa.retryCount,
      iterationIndex: pair.targetUnit.qa.iterationIndex });
    expect(targetOriginalQaJoinMatches).toBe(true);
    expect(targetOriginalQaHeartbeat).toMatchObject({ id: targetOriginalQaHeartbeatId, companyId: pair.targetUnit.companyId,
      agentId: pair.targetUnit.verifierId, issueId: pair.targetUnit.qaIssue.id,
      contextSnapshot: { missionId: pair.targetUnit.missionId, workflowRunId: pair.targetRun.id },
      status: "running", finalizationVersion: 1, settledAt: null,
      workflowStepRunId: pair.targetUnit.qa.id, wakeupRequestId: targetOriginalQaWakeId });
    expect(targetOriginalQaAttempt).toMatchObject({ companyId: pair.targetUnit.companyId,
      agentId: pair.targetUnit.verifierId, missionId: pair.targetUnit.missionId, workflowRunId: pair.targetRun.id,
      issueId: pair.targetUnit.qaIssue.id, stepRunId: pair.targetUnit.qa.id,
      executionGeneration: pair.targetUnit.qa.executionGeneration, retryCount: pair.targetUnit.qa.retryCount,
      iterationIndex: pair.targetUnit.qa.iterationIndex, wakeupRequestId: targetOriginalQaWakeId });
    expect(targetOriginalQaBarrier).toEqual({ issueId: pair.targetUnit.qaIssue.id, hits: 1, released: false });
    expect(targetOriginalQaMatchesBlocker).toBe(true);

    expect(await readFile(pair.targetUnit.file, "utf8")).toBe(targetBeforeBytes.replace("before", "after"));
    expect(await readFile(pair.sourceUnit.file, "utf8")).toBe(sourceBefore.fileBytes);
    const sourceWhileHeld = await captureSourceState();
    expect(sourceWhileHeld).toEqual(sourceBefore);
    const sourceCompletionsWhileHeld = await harness.peer.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.workflowRunId, pair.sourceUnit.runId),
      eq(workflowTransitionEvents.eventType, QA_REMEDIATION_COMPLETION_EVENT_TYPE)));
    const sourceV2WakesWhileHeld = await harness.peer.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.workflowRunId, pair.sourceUnit.runId));
    expect(sourceCompletionsWhileHeld).toEqual([]);
    expect(sourceV2WakesWhileHeld.filter(wake => wake.idempotencyKey?.startsWith("qa-remediation-refire-v2:"))).toEqual([]);

    const targetDownstream = pair.targetScenario.downstreamProgress;
    const targetDownstreamActual = await waitForAdmissionDownstreamActual(harness.peer, targetDownstream);
    expect(targetDownstream.actual).toBeDefined();
    const { heartbeat: downstreamHeartbeat, wakeup: downstreamWake } = targetDownstreamActual;
    expect(readWorkflowAttemptProof(downstreamWake!)).toMatchObject({ workflowRunId: pair.targetRun.id,
      issueId: targetDownstream.issueId, stepRunId: targetDownstream.stepRun.id,
      executionGeneration: targetDownstream.stepRun.executionGeneration, wakeupRequestId: downstreamWake!.id });
    expect(downstreamHeartbeat).toMatchObject({ status: "succeeded", resultJson: expect.any(Object),
      workflowStepRunId: targetDownstream.stepRun.id });

    finishCalled = true;
    const originalQaFinishResults = await pair.scenario.qaCompletion.finish();
    const sourceQaFinish = originalQaFinishResults.find(result => result.kind === "completed"
      && result.issue.id === pair!.sourceUnit.qaIssue.id);
    const targetQaFinish = originalQaFinishResults.find(result => result.kind === "completed"
      && result.issue.id === pair!.targetUnit.qaIssue.id);
    if (!sourceQaFinish || sourceQaFinish.kind !== "completed" || !targetQaFinish || targetQaFinish.kind !== "completed") {
      throw new Error("verified original QA finish did not return both exact issue and adapter results");
    }
    await assertFinishedQaPreservation(pair.sourceUnit, sourceBefore.qaHeartbeat!, sourceBefore.qaWake!,
      readWorkflowAttemptProof(sourceBefore.qaWake!), sourceQaFinish.adapterResult);
    await assertFinishedQaPreservation(pair.targetUnit, targetOriginalQaHeartbeat!, targetOriginalQaWake!,
      targetOriginalQaAttempt, targetQaFinish.adapterResult);

    await heartbeatService(harness.db).resumeQueuedRuns(pair.targetUnit.verifierId);
    await waitForHeartbeatExecutionsToDrain(harness.db, 60_000);

    const targetV2Actual = await within(vi.waitFor(async () => {
      expect(pair!.targetUnit.adapterEntries.validatedV2Refires).toBe(1);
      expect(pair!.targetUnit.adapterEntries.v2RefireWakeIds).toHaveLength(1);
      const refireWakeId = pair!.targetUnit.adapterEntries.v2RefireWakeIds[0];
      if (!refireWakeId) throw new Error("G1-B target replacement completion did not register its v2 refire wake");
      const runWakes = await harness!.peer.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.workflowRunId, pair!.targetRun.id));
      const v2Wakes = runWakes.filter(wake => wake.idempotencyKey?.startsWith("qa-remediation-refire-v2:"));
      expect(v2Wakes.map(wake => wake.id)).toEqual([refireWakeId]);
      const [refireWake] = await harness!.peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, refireWakeId));
      const [refireHeartbeat] = refireWake?.runId
        ? await harness!.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, refireWake.runId)) : [];
      expect(refireWake?.runId).toBeTruthy();
      expect(refireHeartbeat).toMatchObject({ id: refireWake?.runId, status: "succeeded",
        finishedAt: expect.any(Date), resultJson: expect.any(Object) });
      return { wake: refireWake!, heartbeat: refireHeartbeat! };
    }, { timeout: 30_000, interval: 20 }), "G1-B exact target v2 refire actual finished", 30_000);
    expect(pair.targetUnit.adapterEntries.validatedV2Refires).toBe(1);
    expect(pair.targetScenario.downstreamProgress.adapterEntries).toBe(1);
    const refireWake = targetV2Actual.wake;
    const refireHeartbeat = targetV2Actual.heartbeat;
    expect(refireWake.id).toBe(targetV2ReceiptWake?.id);
    const refireAttempt = readWorkflowAttemptProof(refireWake);
    expect(refireAttempt).toMatchObject({ companyId: pair.targetUnit.companyId, missionId: pair.targetUnit.missionId,
      workflowRunId: pair.targetRun.id, issueId: pair.targetUnit.qaIssue.id, stepRunId: pair.targetUnit.qa.id,
      executionGeneration: pair.targetUnit.qa.executionGeneration, retryCount: pair.targetUnit.qa.retryCount,
      iterationIndex: pair.targetUnit.qa.iterationIndex, wakeupRequestId: refireWake.id });
    expect(refireHeartbeat).toMatchObject({ id: refireWake.runId, status: "succeeded", resultJson: expect.any(Object),
      workflowStepRunId: pair.targetUnit.qa.id, workflowExecutionGeneration: pair.targetUnit.qa.executionGeneration });
    const targetRefirePhases = admissionObservations.filter(item => item.heartbeatRunId === refireHeartbeat.id)
      .map(item => item.phase).sort();
    expect(targetRefirePhases).toEqual(["adapter_start", "claim"]);
    const targetRefireWork = workObservations.filter(item => item.heartbeatRunId === refireHeartbeat.id);
    expect(targetRefireWork.map(item => item.kind === "captured" ? item.entry.phase : item.phase).sort())
      .toEqual(["adapter_start", "claim"]);
    expect(workCalls.filter(item => item.heartbeatRunId === refireHeartbeat.id).map(item => item.phase).sort())
      .toEqual(["adapter_start", "claim"]);
    for (const observation of targetRefireWork) {
      if (observation.kind !== "captured") {
        throw new Error(`G1-B work observation failed: ${observation.name}: ${observation.message}`);
      }
      const entry = observation.entry;
      if (entry.phase === "claim") {
        expect(entry.identity).toMatchObject({ heartbeatRunId: refireHeartbeat.id, companyId: pair.targetUnit.companyId,
          agentId: pair.targetUnit.verifierId, issueId: pair.targetUnit.qaIssue.id, wakeupRequestId: refireWake.id,
          executorOwnerId: null, executorOwnerLeaseEpoch: null, executionTokenPresent: false, ownerLeaseTokenPresent: false });
        expect([null, pair.targetUnit.qa.id]).toContain(entry.identity.workflowStepRunId);
        expect([null, pair.targetUnit.qa.executionGeneration]).toContain(entry.identity.workflowExecutionGeneration);
      } else {
      expect(entry.identity).toMatchObject({ heartbeatRunId: refireHeartbeat.id, companyId: pair.targetUnit.companyId,
        agentId: pair.targetUnit.verifierId, issueId: pair.targetUnit.qaIssue.id, wakeupRequestId: refireWake.id,
        workflowStepRunId: pair.targetUnit.qa.id, workflowExecutionGeneration: pair.targetUnit.qa.executionGeneration,
        executorOwnerId: refireHeartbeat.executorOwnerId,
        executorOwnerLeaseEpoch: refireHeartbeat.executorOwnerLeaseEpoch, executionTokenPresent: true,
        ownerLeaseTokenPresent: true });
      }
      if (entry.wake.kind !== "found") throw new Error("G1-B work observation did not find the exact wake attempt");
      expect(entry.wake).toMatchObject({ id: refireWake.id, companyId: pair.targetUnit.companyId,
        agentId: pair.targetUnit.verifierId, issueId: pair.targetUnit.qaIssue.id, missionId: pair.targetUnit.missionId,
        runId: refireHeartbeat.id, workflowRunId: pair.targetRun.id, workflowStepRunId: pair.targetUnit.qa.id,
        workflowExecutionGeneration: pair.targetUnit.qa.executionGeneration,
        attempt: { companyId: pair.targetUnit.companyId, agentId: pair.targetUnit.verifierId,
          missionId: pair.targetUnit.missionId, workflowRunId: pair.targetRun.id, issueId: pair.targetUnit.qaIssue.id,
          stepRunId: pair.targetUnit.qa.id, executionGeneration: pair.targetUnit.qa.executionGeneration,
          retryCount: pair.targetUnit.qa.retryCount, iterationIndex: pair.targetUnit.qa.iterationIndex,
          wakeupRequestId: refireWake.id } });
      expect(entry.scope).toMatchObject({ kind: "linked", primaryRunId: pair.targetRun.id });
      expect(entry.scope.workflowRunIds).toEqual(expect.arrayContaining([pair.sourceUnit.runId, pair.targetRun.id]));
      expect(entry.scope.replacementAuthorities).toContainEqual(expect.objectContaining({
        sourceRunId: pair.sourceUnit.runId, targetRunId: pair.targetRun.id }));
      expect(entry.targetPendingEventIds).toEqual([]);
      expect(entry.pending.some(item => item.workflowRunId === pair.targetRun.id
        || item.eventId === pair.targetUnit.preparationEventId)).toBe(false);
      expect(entry.unresolved).toEqual({ kind: "returned", eventIds: [] });
      if (entry.sourcePendingEventIds.length) {
        expect(entry.sourcePendingEventIds).toContain(pair.sourceUnit.preparationEventId);
        expect(entry.replacementSourcePreservation).toMatchObject({ present: true,
          sourceRunId: pair.sourceUnit.runId, targetRunId: pair.targetRun.id,
          sourceEventIds: [...entry.sourcePendingEventIds].sort() });
        expect(entry.wrongDatabase).toMatchObject({ kind: "typed_hold", name: "QaRemediationAdmissionHold",
          reason: "replacement_preservation_binding_unproven" });
        expect(entry.wrongTarget).toMatchObject({ kind: "typed_hold", name: "QaRemediationAdmissionHold",
          reason: "replacement_preservation_binding_unproven" });
        expect(entry.sourcePreparations.map(item => item.eventId).sort()).toEqual([...entry.sourcePendingEventIds].sort());
        expect(entry.sourcePreparations.every(item => item.preparationRowCount === 1 && item.exactPreparationRow)).toBe(true);
      } else {
        expect(entry.replacementSourcePreservation).toMatchObject({ present: false, sourceEventIds: [] });
        expect(entry.unresolved).toEqual({ kind: "returned", eventIds: [] });
        expect(entry.wrongDatabase.kind).toBe("not_run");
        expect(entry.wrongTarget.kind).toBe("not_run");
        expect(entry.sourcePreparations).toEqual([]);
      }
    }
    console.log("G1B_BRANCH_PROOF", JSON.stringify(targetRefireWork.map(item => item.kind === "captured" ? { phase: item.entry.phase, sourcePendingCount: item.entry.sourcePendingEventIds.length } : { phase: item.phase, error: item.message })));
    const refireOwners = ownerObservations.filter(item => item.heartbeatRunId === refireHeartbeat.id);
    expect(refireOwners.map(item => item.phase).sort()).toEqual(["adapter_start", "claim"]);
    for (const owner of refireOwners) {
      expect([...owner.targets].sort()).toEqual(unionPaths);
      expect(owner.exit).toMatchObject({ code: 0, signal: null });
    }
    expect(await readFile(pair.targetUnit.file, "utf8")).toBe(targetBeforeBytes.replace("before", "after"));
    expect(await readFile(pair.sourceUnit.file, "utf8")).toBe(sourceBefore.fileBytes);
    const targetCompletionsAfterActual = await harness.peer.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.workflowRunId, pair.targetRun.id),
      eq(workflowTransitionEvents.eventType, QA_REMEDIATION_COMPLETION_EVENT_TYPE)));
    expect(targetCompletionsAfterActual).toHaveLength(1);
    expect(targetCompletionsAfterActual[0]?.workflowStepRunId).toBe(pair.targetUnit.producer.id);
    const sourceCompletions = await harness.peer.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.workflowRunId, pair.sourceUnit.runId),
      eq(workflowTransitionEvents.eventType, QA_REMEDIATION_COMPLETION_EVENT_TYPE)));
    expect(sourceCompletions).toEqual([]);

    const sourceAfter = await captureSourceState();
    expect(sourceAfter.sourceRun).toMatchObject({ id: sourceBefore.sourceRun?.id,
      companyId: pair.sourceUnit.companyId, missionId: pair.sourceUnit.missionId,
      workflowId: pair.sourceUnit.workflowId });
    expect(sourceAfter.producerStep).toEqual(sourceBefore.producerStep);
    expect(sourceAfter.producerHeartbeat).toEqual(sourceBefore.producerHeartbeat);
    expect(sourceAfter.producerWake).toEqual(sourceBefore.producerWake);
    expect(sourceAfter.product).toEqual(sourceBefore.product);
    expect(sourceAfter.preparation).toEqual(sourceBefore.preparation);
    expect(sourceAfter.fileBytes).toBe(sourceBefore.fileBytes);
    expect(sourceAfter.qaStep).toMatchObject({ id: sourceBefore.qaStep?.id, workflowRunId: pair.sourceUnit.runId,
      stepId: pair.sourceUnit.qa.stepId, issueId: pair.sourceUnit.qaIssue.id,
      executionGeneration: pair.sourceUnit.qa.executionGeneration, retryCount: pair.sourceUnit.qa.retryCount,
      iterationIndex: pair.sourceUnit.qa.iterationIndex, status: "failed" });
    expect(readWorkflowAttemptProof(sourceAfter.qaWake!)).toEqual(readWorkflowAttemptProof(sourceBefore.qaWake!));
    expect(sourceAfter.qaWake).toMatchObject({ id: pair.sourceUnit.automaticQaWakeupRequestId,
      companyId: pair.sourceUnit.companyId, agentId: pair.sourceUnit.verifierId,
      missionId: pair.sourceUnit.missionId, workflowRunId: pair.sourceUnit.runId,
      workflowStepRunId: pair.sourceUnit.qa.id,
      workflowExecutionGeneration: pair.sourceUnit.qa.executionGeneration });
    const sourceV2Wakes = await harness.peer.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.workflowRunId, pair.sourceUnit.runId));
    expect(sourceV2Wakes.filter(wake => wake.idempotencyKey?.startsWith("qa-remediation-refire-v2:"))).toEqual([]);
    expect(pair.sourceUnit.adapterEntries).toMatchObject({ producer: 1, automaticQa: 1, validatedV2Refires: 0,
      v2RefireWakeIds: [] });
  } catch (error) {
    primaryFailure = error;
  } finally {
    try { pair?.scenario.qaCompletion.restore(); } catch (error) { cleanupFailures.push(error); }
    try { pair?.scenario.qaCompletion.releaseAll(); } catch (error) { cleanupFailures.push(error); }
    if (admissionSpy) { try { admissionSpy.mockRestore(); } catch (error) { cleanupFailures.push(error); } }
    try { await waitForHeartbeatExecutionsToDrain(harness?.db ?? db, 60_000); }
    catch (error) { cleanupFailures.push(error); }
    if (pair && !finishCalled) {
      finishCalled = true;
      try { await pair.scenario.qaCompletion.finish(); } catch (error) { cleanupFailures.push(error); }
    }
    if (harness) {
      try { await drainAdmissionFixtureAdapters(harness.db, "G1-B replacement claim and adapter start"); }
      catch (error) { cleanupFailures.push(error); }
      try { await harness.close(); } catch (error) { cleanupFailures.push(error); }
    }
    for (const [key, value] of priorHarnessEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  if (primaryFailure !== undefined) {
    if (cleanupFailures.length) throw new AggregateError([primaryFailure, ...cleanupFailures], "G1-B behavior and cleanup failed", { cause: primaryFailure });
    throw primaryFailure;
  }
  if (cleanupFailures.length === 1) throw cleanupFailures[0];
  if (cleanupFailures.length > 1) throw new AggregateError(cleanupFailures, "G1-B cleanup failed");
}, 240_000);
