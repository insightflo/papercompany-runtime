import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { and, eq } from "drizzle-orm";
import { agents, agentWakeupRequests, companies, heartbeatRuns, issueWorkProducts, issues, missions,
  workflowDefinitions, workflowRuns, workflowStepOutputBindings, workflowStepRuns, workflowTransitionEvents,
  type Db } from "@paperclipai/db";
import { workProductProducerSchema, type WorkflowVerdictFinding } from "@paperclipai/shared";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../../adapters/types.js";
import { heartbeatService } from "../../services/heartbeat.js";
import type { WorkflowStep } from "../../services/workflow/dag-engine.js";
import { waitForHeartbeatExecutionsToDrain } from "../../services/heartbeat-execution-tracker.js";
import { readWorkflowAttemptProof } from "../../services/heartbeat-finalization/workflow-attempt-proof.js";
import { createReplacementRootNotifications, withReplacementRootNotificationDb } from "../../services/issue-assignment-wakeup.js";
import { registerWorkflowArtifact, completeWorkflowIssue, submitWorkflowVerdict } from "../../services/workflow/agent-api.js";
import { registeredProducer } from "../../services/work-products/producer-provenance.js";
import { sealProducerWrite } from "../../services/work-products/producer-seal.js";
import { readQaCorrectionWakeRef } from "../../services/work-products/qa-correction-producer-attempt.js";
import { wakeExistingWorkflowStepIssue } from "../../services/workflow/workflow-step-wake.js";
import { findAcceptedWorkflowResumeWakeForStep } from "../../services/workflow-resume-wake.js";
import { loadExecutionDefinition } from "../../services/workflow/execution-definition.js";
import { loadPriorRejectedFindings, loadWorkflowApiFindings } from "../../services/workflow/validation-verdict-ledger.js";
import { applyRecurrencePromotion } from "../../services/workflow/control-flow/rework-contract.js";
import { hashQaCorrectionPayload, qaCorrectionPreparationSchema,
  type QaCorrectionPreparation } from "../../services/workflow/control-flow/qa-correction-contract.js";
import { beginQaCorrection } from "../../services/workflow/control-flow/qa-correction-prepare.js";
import { measureQaCorrectionSources } from "../../services/workflow/control-flow/qa-correction-measure.js";
import { storeQaCorrection } from "../../services/workflow/control-flow/qa-correction-storage.js";
import { commitQaCorrection } from "../../services/workflow/control-flow/qa-correction-commit.js";
import { discoverQaCorrection, queueIssued } from "../../services/workflow/control-flow/qa-correction-followup-reconcile.js";
import { prepareQaRemediationReservation } from "../../services/workflow/control-flow/qa-remediation-prepare.js";
import { parseQaRemediationCompletion, QA_REMEDIATION_COMPLETION_EVENT_TYPE } from "../../services/workflow/control-flow/qa-remediation-completion.js";
import { QA_REMEDIATION_PREPARATION_EVENT_TYPE } from "../../services/workflow/control-flow/qa-remediation-preparation-contract.js";
import { freezeHeartbeatActualDrainIdentity, readQaRemediationActualDrain } from "../../services/heartbeat-actual-drain.js";
import { readTerminalReleaseAcknowledgment, readTerminalReleaseManifestForSource,
  readReadyTerminalReleaseContinuation } from "../../services/heartbeat-terminal-release-continuation.js";
import { createQaFileOwnerRuntime, type QaFileOwnerRuntime } from "../../services/workflow/control-flow/qa-remediation-runtime.js";
import { reconcileQaRemediationReservation } from "../../services/workflow/control-flow/qa-remediation-reconcile.js";
import { PYTHON, deferred, within } from "./qa-remediation-parent-death-harness.js";
import type { HeartbeatC5PublicFixture } from "./heartbeat-c5-public-fixture.js";

const successfulActual = (label: string): AdapterExecutionResult => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  usage: null,
  provider: `c5-public-${label}`,
  model: "fixture",
  resultJson: { stdout: `c5-public-${label}`, stderr: "" },
  runtimeServices: [],
});

const digest = (value: string | null | undefined) => value == null
  ? null : createHash("sha256").update(value).digest("hex");

type RegisteredProducerProvenance = NonNullable<Awaited<ReturnType<typeof registeredProducer>>>;

async function validateRegisteredProducerSeal(product: Parameters<typeof sealProducerWrite>[0],
  identity: RegisteredProducerProvenance) {
  const stored = workProductProducerSchema.safeParse(product.metadata?.workflowProducer);
  const measured = await sealProducerWrite(product, identity);
  const expected = workProductProducerSchema.safeParse(measured.metadata.workflowProducer);
  if (!stored.success || !expected.success || !stored.data.sha256 || !expected.data.sha256
    || stored.data.byteSize === undefined || expected.data.byteSize === undefined
    || !Number.isSafeInteger(stored.data.byteSize) || !Number.isSafeInteger(expected.data.byteSize)
    || !isDeepStrictEqual(stored.data, expected.data)) {
    throw new Error("C5 C02 producer provenance does not match the registered identity and measured artifact seal");
  }
  return stored.data;
}

type FieldPathDifference = { path: string; expected: unknown; actual: unknown;
  expectedPresent: boolean; actualPresent: boolean };

function isFieldRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fieldPathDifferences(expected: unknown, actual: unknown, path = "$",
  expectedPresent = true, actualPresent = true): FieldPathDifference[] {
  if (expectedPresent && actualPresent && isDeepStrictEqual(expected, actual)) return [];
  if (isFieldRecord(expected) && isFieldRecord(actual)) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    return keys.flatMap(key => fieldPathDifferences(expected[key], actual[key], `${path}.${key}`,
      Object.hasOwn(expected, key), Object.hasOwn(actual, key)));
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const length = Math.max(expected.length, actual.length);
    return Array.from({ length }, (_, index) => fieldPathDifferences(expected[index], actual[index], `${path}[${index}]`,
      index < expected.length, index < actual.length)).flat();
  }
  return [{ path, expected: expectedPresent ? expected : null, actual: actualPresent ? actual : null,
    expectedPresent, actualPresent }];
}

function qaCorrectionFrozenBody(preparation: QaCorrectionPreparation) {
  const { correctionId: _correctionId, preparedAt: _preparedAt, ...body } = preparation;
  return body;
}

function qaCorrectionFrozenBodyHash(preparation: QaCorrectionPreparation) {
  return hashQaCorrectionPayload(qaCorrectionFrozenBody(preparation));
}

type HeartbeatC5PublicLifecycleOptions = { c02NotificationInput?: boolean };

export async function createHeartbeatC5PublicLifecycle(
  fixture: HeartbeatC5PublicFixture,
  options: HeartbeatC5PublicLifecycleOptions = {},
) {
  const companyId = randomUUID();
  const missionId = randomUUID();
  const workflowId = randomUUID();
  const runId = randomUUID();
  const producerAgentId = randomUUID();
  const qaAgentId = randomUUID();
  const downstreamAgentId = randomUUID();
  const unrelatedAgentId = randomUUID();
  const producerIssueId = randomUUID();
  const qaIssueId = randomUUID();
  const downstreamIssueId = randomUUID();
  const claimConsumerIssueId = randomUUID();
  const producerStepId = "c5-producer";
  const qaStepId = "c5-quality";
  const downstreamStepId = "c5-downstream";
  const claimConsumerStepId = "c5-claim-consumer";
  const artifactPath = join(fixture.root, "missions", missionId, "runs", runId, "steps", producerStepId, "report.md");
  const producerEntered = deferred<string>();
  const producerWorkCompleted = deferred<string>();
  const producerActualRelease = deferred<void>();
  const qaVerdictSubmitted = deferred<string>();
  const qaActualRelease = deferred<void>();
  const slotBlockerEntered = deferred<string>();
  const slotBlockerRelease = deferred<void>();
  const sameAgentUEntered = deferred<string>();
  const separateAgentUEntered = deferred<string>();
  const downstreamEntered = deferred<string>();
  const timerActualEntered = deferred<string>();
  const claimConsumerEntered = deferred<string>();
  let qaEntries = 0;
  let producerRunId: string | null = null;
  let qaRequestChangesRunId: string | null = null;
  let qaRequestChangesEventId: string | null = null;
  let qaPassRunId: string | null = null;
  let qaRefireRunId: string | null = null;
  let preparedReservation: Awaited<ReturnType<typeof prepareQaRemediationReservation>> | null = null;
  let completionEventId: string | null = null;
  let v2RefireWakeupRequestIds: string[] = [];
  let c02SourceProductId: string | null = null;
  let c02BindingId: string | null = null;

  await fixture.db.insert(companies).values({ id: companyId, name: "C5 public activation", issuePrefix: `C5${companyId.slice(0, 8)}`,
    workProductRoot: fixture.root });
  await fixture.db.insert(agents).values([
    { id: producerAgentId, companyId, name: "C5 producer", status: "active", adapterType: "codex_local",
      adapterConfig: { cwd: fixture.root, promptTemplate: "C5 producer" },
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 2 } } },
    { id: qaAgentId, companyId, name: "C5 QA", status: "active", adapterType: "codex_local",
      adapterConfig: { cwd: fixture.root, promptTemplate: "C5 QA" },
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 2 } } },
    { id: downstreamAgentId, companyId, name: "C5 downstream", status: "active", adapterType: "codex_local",
      adapterConfig: { cwd: fixture.root, promptTemplate: "C5 downstream" },
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 1 } } },
    { id: unrelatedAgentId, companyId, name: "C5 unrelated", status: "active", adapterType: "codex_local",
      adapterConfig: { cwd: fixture.root, promptTemplate: "C5 unrelated" },
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 1 } } },
  ]);
  await fixture.db.insert(missions).values({ id: missionId, companyId, title: "C5 public lifecycle",
    ownerAgentId: producerAgentId, status: "active" });
  await fixture.db.insert(workflowDefinitions).values({ id: workflowId, companyId, missionId,
    name: "C5 producer, QA, and downstream", stepsJson: [
      { id: producerStepId, name: "C5 producer", agentId: producerAgentId, dependencies: [],
        conditionalDependencies: [{ stepId: qaStepId, when: "qa_request_changes", isBackEdge: true, maxIterations: 2 }] },
      { id: qaStepId, name: "C5 QA", type: "qa", agentId: qaAgentId, dependencies: [producerStepId] },
      { id: downstreamStepId, name: "C5 downstream", agentId: downstreamAgentId, dependencies: [qaStepId] },
      // Keep the synthetic claim candidate behind the QA-gated downstream step so DAG sync cannot auto-launch it.
      { id: claimConsumerStepId, name: "C5 claim consumer", agentId: downstreamAgentId, dependencies: [downstreamStepId] },
    ] });
  await fixture.db.insert(workflowRuns).values({ id: runId, companyId, missionId, workflowId,
    status: "running", triggeredBy: "test", dispatchAuthorityVersion: 1 });
  await fixture.db.insert(issues).values([
    { id: producerIssueId, companyId, missionId, title: "C5 producer report", status: "todo",
      assigneeAgentId: producerAgentId, originKind: "workflow_execution", originRunId: runId },
    { id: qaIssueId, companyId, missionId, title: "[QA] C5 producer report", status: "todo",
      assigneeAgentId: qaAgentId, originKind: "workflow_execution", originRunId: runId },
    { id: downstreamIssueId, companyId, missionId, title: "C5 legitimate downstream", status: "todo",
      assigneeAgentId: downstreamAgentId, originKind: "workflow_execution", originRunId: runId },
    { id: claimConsumerIssueId, companyId, missionId, title: "C5 claim consumer", status: "todo",
      assigneeAgentId: downstreamAgentId, originKind: "workflow_execution", originRunId: runId },
  ]);
  const [producerStep] = await fixture.db.insert(workflowStepRuns).values({ workflowRunId: runId,
    stepId: producerStepId, issueId: producerIssueId, status: "pending" }).returning();
  const [qaStep] = await fixture.db.insert(workflowStepRuns).values({ workflowRunId: runId,
    stepId: qaStepId, issueId: qaIssueId, status: "pending" }).returning();
  const [downstreamStep] = await fixture.db.insert(workflowStepRuns).values({ workflowRunId: runId,
    stepId: downstreamStepId, issueId: downstreamIssueId, status: "pending" }).returning();
  const [claimConsumerStep] = await fixture.db.insert(workflowStepRuns).values({ workflowRunId: runId,
    stepId: claimConsumerStepId, issueId: claimConsumerIssueId, status: "pending" }).returning();
  if (!producerStep || !qaStep || !downstreamStep || !claimConsumerStep) throw new Error("C5 public workflow step declarations were not created");

  const readWorkflowAttempt = async (context: AdapterExecutionContext, expected: {
    agentId: string; issueId: string; stepRun: typeof producerStep; workflowRunId?: string;
  }) => {
    const [heartbeat] = await fixture.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, context.runId));
    const [wake] = heartbeat?.wakeupRequestId
      ? await fixture.peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, heartbeat.wakeupRequestId)) : [];
    const expectedWorkflowRunId = expected.workflowRunId ?? runId;
    if (!heartbeat || !wake || wake.runId !== context.runId || heartbeat.status !== "running"
      || heartbeat.companyId !== companyId || heartbeat.agentId !== expected.agentId || heartbeat.issueId !== expected.issueId
      || heartbeat.wakeupRequestId !== wake.id || heartbeat.workflowStepRunId !== expected.stepRun.id
      || heartbeat.workflowExecutionGeneration !== expected.stepRun.executionGeneration
      || wake.companyId !== companyId || wake.agentId !== expected.agentId || wake.issueId !== expected.issueId
      || wake.missionId !== missionId || wake.workflowRunId !== expectedWorkflowRunId
      || wake.workflowStepRunId !== expected.stepRun.id || wake.workflowExecutionGeneration !== expected.stepRun.executionGeneration
      || wake.requestKind !== "workflow_resume") {
      throw new Error("C5 public adapter has no exact admitted workflow-step wake for " + context.runId);
    }
    const proof = readWorkflowAttemptProof(wake);
    if (proof.companyId !== companyId || proof.agentId !== expected.agentId || proof.missionId !== missionId
      || proof.workflowRunId !== expectedWorkflowRunId || proof.issueId !== expected.issueId
      || proof.stepRunId !== expected.stepRun.id || proof.executionGeneration !== expected.stepRun.executionGeneration
      || proof.retryCount !== expected.stepRun.retryCount || proof.iterationIndex !== expected.stepRun.iterationIndex
      || proof.wakeupRequestId !== wake.id) {
      throw new Error("C5 public adapter attempt proof does not match the exact step for " + context.runId);
    }
    return { heartbeat, wake, proof };
  };

  const assertAuthorizedQaRefire = async (context: AdapterExecutionContext) => {
    if (!preparedReservation || preparedReservation.outcome !== "prepared" || !qaRequestChangesRunId || !qaRequestChangesEventId) {
      throw new Error("C5 QA refire lacks the committed preparation and original request-changes binding");
    }
    const identity = await readWorkflowAttempt(context, { agentId: qaAgentId, issueId: qaIssueId, stepRun: qaStep });
    const ref = identity.wake.payload?.qaRemediationCompletion;
    if (!ref || typeof ref !== "object" || Array.isArray(ref)
      || (ref as Record<string, unknown>).preparationEventId !== preparedReservation.preparationEventId
      || (ref as Record<string, unknown>).sourceVerdictEventId !== qaRequestChangesEventId) {
      throw new Error("C5 QA refire wake does not cite the exact preparation and source verdict");
    }
    const [preparations, completions, sourceVerdicts] = await Promise.all([
      fixture.peer.select().from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.id, preparedReservation.preparationEventId),
        eq(workflowTransitionEvents.companyId, companyId), eq(workflowTransitionEvents.missionId, missionId),
        eq(workflowTransitionEvents.workflowRunId, runId), eq(workflowTransitionEvents.workflowStepRunId, producerStep.id),
        eq(workflowTransitionEvents.issueId, producerIssueId),
        eq(workflowTransitionEvents.eventType, QA_REMEDIATION_PREPARATION_EVENT_TYPE))),
      fixture.peer.select().from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.companyId, companyId), eq(workflowTransitionEvents.missionId, missionId),
        eq(workflowTransitionEvents.workflowRunId, runId), eq(workflowTransitionEvents.workflowStepRunId, producerStep.id),
        eq(workflowTransitionEvents.issueId, producerIssueId),
        eq(workflowTransitionEvents.eventType, QA_REMEDIATION_COMPLETION_EVENT_TYPE))),
      fixture.peer.select().from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.id, qaRequestChangesEventId),
        eq(workflowTransitionEvents.companyId, companyId), eq(workflowTransitionEvents.missionId, missionId),
        eq(workflowTransitionEvents.workflowRunId, runId), eq(workflowTransitionEvents.workflowStepRunId, qaStep.id),
        eq(workflowTransitionEvents.issueId, qaIssueId), eq(workflowTransitionEvents.heartbeatRunId, qaRequestChangesRunId),
        eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
        eq(workflowTransitionEvents.verdict, "request_changes"))),
    ]);
    if (preparations.length !== 1 || completions.length !== 1 || sourceVerdicts.length !== 1
      || !isDeepStrictEqual(preparations[0]!.payload, preparedReservation.preparation)) {
      throw new Error("C5 QA refire requires one exact committed preparation, completion, and source verdict");
    }
    const completion = parseQaRemediationCompletion(completions[0]!.payload);
    const completionEvent = completions[0]!;
    if (completionEvent.id !== completion.completionId || !isDeepStrictEqual(completionEvent.payload, completion)
      || completion.preparationId !== preparedReservation.preparationEventId
      || completion.companyId !== companyId || completion.missionId !== missionId || completion.workflowRunId !== runId
      || completion.producer.stepRunId !== producerStep.id || completion.producer.issueId !== producerIssueId
      || completion.producer.executionGeneration !== producerStep.executionGeneration
      || completion.verdicts.length !== 1 || completion.files.length !== 1 || completion.files[0]!.file !== artifactPath
      || completion.files[0]!.status !== "applied" || completion.wakes.length !== 1) {
      throw new Error("C5 QA refire completion does not match the exact producer preparation");
    }
    const sourceVerdict = completion.verdicts[0]!;
    if (sourceVerdict.eventId !== qaRequestChangesEventId || sourceVerdict.heartbeatRunId !== qaRequestChangesRunId
      || sourceVerdict.qa.stepRunId !== qaStep.id || sourceVerdict.qa.stepId !== qaStep.stepId
      || sourceVerdict.qa.issueId !== qaIssueId || sourceVerdict.qa.executionGeneration !== qaStep.executionGeneration
      || sourceVerdict.qa.retryCount !== qaStep.retryCount || sourceVerdict.qa.iterationIndex !== qaStep.iterationIndex
      || sourceVerdicts[0]!.heartbeatRunId !== qaRequestChangesRunId) {
      throw new Error("C5 QA refire completion does not reference the exact original QA attempt");
    }
    const completionWake = completion.wakes[0]!;
    if (completionWake.kind !== "v2_refire" || completionWake.sourceVerdictEventId !== qaRequestChangesEventId
      || completionWake.agentId !== qaAgentId || completionWake.issueId !== qaIssueId
      || completionWake.stepRunId !== qaStep.id || completionWake.stepId !== qaStep.stepId
      || completionWake.executionGeneration !== qaStep.executionGeneration
      || completionWake.wakeupRequestId !== identity.wake.id
      || completionWake.idempotencyKey !== identity.wake.idempotencyKey || completionWake.statusAtCommit !== "queued") {
      throw new Error("C5 QA refire wake does not match the exact committed completion receipt");
    }
    return identity;
  };

  const wakeWorkflowStep = async (agentId: string, issueId: string, stepRunId: string) => {
    const [workflowRun] = await fixture.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    const [definition] = await fixture.db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, workflowId));
    const [stepRun] = await fixture.db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    if (!workflowRun || !definition || !stepRun || stepRun.workflowRunId !== runId || stepRun.issueId !== issueId) {
      throw new Error("C5 public workflow step lacks its exact stored run, definition, issue, or step identity");
    }
    const step = Array.isArray(definition.stepsJson)
      ? definition.stepsJson.find((candidate: unknown): candidate is WorkflowStep =>
        !!candidate && typeof candidate === "object" && !Array.isArray(candidate)
        && (candidate as Record<string, unknown>).id === stepRun.stepId)
      : undefined;
    if (!step || step.agentId !== agentId) throw new Error("C5 public workflow step is absent from its stored definition");
    const before = await findAcceptedWorkflowResumeWakeForStep(fixture.db, {
      companyId, issueId, workflowRunId: runId, workflowStepRunId: stepRun.id,
      workflowExecutionGeneration: stepRun.executionGeneration, agentId, resumeCompatibleOnly: true,
    });
    if (before.length) throw new Error("C5 public workflow step already has an accepted wake before its public start");
    const accepted = await wakeExistingWorkflowStepIssue({
      db: fixture.db, run: workflowRun, definition,
      step,
      stepRunId: stepRun.id, issueId, requireOwnWake: true,
    });
    if (!accepted) throw new Error("C5 public workflow step wake was not admitted");
    const wakes = await findAcceptedWorkflowResumeWakeForStep(fixture.db, {
      companyId, issueId, workflowRunId: runId, workflowStepRunId: stepRun.id,
      workflowExecutionGeneration: stepRun.executionGeneration, agentId, resumeCompatibleOnly: true,
    });
    if (wakes.length !== 1) throw new Error("C5 public workflow step has no unique admitted durable wake");
    const [wake] = await fixture.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakes[0]!.id));
    if (!wake || wake.requestKind !== "workflow_resume" || wake.reason !== "workflow_step_runnable"
      || wake.companyId !== companyId || wake.agentId !== agentId || wake.issueId !== issueId
      || wake.missionId !== missionId || wake.workflowRunId !== runId || wake.workflowStepRunId !== stepRun.id
      || wake.workflowExecutionGeneration !== stepRun.executionGeneration || !wake.runId) {
      throw new Error("C5 public workflow step wake is not the exact admitted workflow_resume row");
    }
    const proof = readWorkflowAttemptProof(wake);
    if (proof.companyId !== companyId || proof.agentId !== agentId || proof.missionId !== missionId
      || proof.workflowRunId !== runId || proof.issueId !== issueId || proof.stepRunId !== stepRun.id
      || proof.executionGeneration !== stepRun.executionGeneration || proof.retryCount !== stepRun.retryCount
      || proof.iterationIndex !== stepRun.iterationIndex || proof.wakeupRequestId !== wake.id) {
      throw new Error("C5 public workflow step wake does not prove the exact stored attempt");
    }
    const [heartbeat] = await fixture.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake.runId));
    if (!heartbeat || heartbeat.wakeupRequestId !== wake.id || heartbeat.agentId !== agentId || heartbeat.issueId !== issueId) {
      throw new Error("C5 public workflow step wake is not bound to its exact heartbeat run");
    }
    return { id: heartbeat.id, wakeupRequestId: wake.id };
  };

  const ensureWorkflowStepRun = async (agentId: string, issueId: string, stepRunId: string) => {
    const [workflowRun] = await fixture.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    const [definition] = await fixture.db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, workflowId));
    const [issue] = await fixture.db.select().from(issues).where(eq(issues.id, issueId));
    const [stepRun] = await fixture.db.select().from(workflowStepRuns).where(and(
      eq(workflowStepRuns.id, stepRunId), eq(workflowStepRuns.workflowRunId, runId)));
    if (!workflowRun || workflowRun.companyId !== companyId || workflowRun.missionId !== missionId
      || workflowRun.workflowId !== workflowId || !definition || !issue || issue.companyId !== companyId
      || issue.missionId !== missionId || !stepRun || stepRun.issueId !== issueId) {
      throw new Error("C5 public workflow step has no exact stored run, issue, or attempt");
    }
    const step = Array.isArray(definition.stepsJson)
      ? definition.stepsJson.find((candidate: unknown): candidate is WorkflowStep =>
        !!candidate && typeof candidate === "object" && !Array.isArray(candidate)
        && (candidate as Record<string, unknown>).id === stepRun.stepId)
      : undefined;
    if (!step || step.agentId !== agentId) throw new Error("C5 public workflow step is absent from its stored definition");
    const [stepWakes, issueWakes] = await Promise.all([
      fixture.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.workflowStepRunId, stepRunId)),
      fixture.db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.issueId, issueId))),
    ]);
    const wakeById = new Map<string, typeof stepWakes[number]>();
    for (const wake of stepWakes) wakeById.set(wake.id, wake);
    for (const wake of issueWakes) wakeById.set(wake.id, wake);
    const wakes = [...wakeById.values()];
    if (wakes.length === 0) {
      const issueHeartbeats = await fixture.db.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.issueId, issueId)));
      if (issueHeartbeats.length !== 0 || workflowRun.status !== "running" || stepRun.status !== "pending"
        || issue.status !== "todo" || stepRun.dispatchOwnerHeartbeatRunId !== null
        || stepRun.dispatchOwnerWakeupRequestId !== null) {
        throw new Error("C5 public workflow step has no wake but its stored attempt is not eligible for dispatch");
      }
      return wakeWorkflowStep(agentId, issueId, stepRunId);
    }
    if (wakes.length !== 1) throw new Error("C5 public workflow step has ambiguous durable wakes");
    const wake = wakes[0]!;
    if (wake.requestKind !== "workflow_resume" || wake.reason !== "workflow_step_runnable"
      || !["queued", "claimed", "deferred_issue_execution", "coalesced", "running", "completed"].includes(wake.status)
      || wake.runId === null || wake.companyId !== companyId || wake.agentId !== agentId
      || wake.issueId !== issueId || wake.missionId !== missionId || wake.workflowRunId !== runId
      || wake.workflowStepRunId !== stepRunId || wake.workflowExecutionGeneration !== stepRun.executionGeneration) {
      throw new Error("C5 public workflow step existing wake lost its exact stored attempt binding");
    }
    const [matchingRuns, stepRuns] = await Promise.all([
      fixture.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, wake.id)),
      fixture.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.workflowStepRunId, stepRunId)),
    ]);
    if (matchingRuns.length !== 1 || stepRuns.some(run => run.id !== matchingRuns[0]!.id)) {
      throw new Error("C5 public workflow step wake has missing, duplicate, or mismatched heartbeat bindings");
    }
    const heartbeat = matchingRuns[0]!;
    const queued = heartbeat.status === "queued" && ["pending", "running"].includes(stepRun.status)
      && (stepRun.status === "pending"
        ? (heartbeat.workflowStepRunId === null || heartbeat.workflowStepRunId === stepRunId)
          && (heartbeat.workflowExecutionGeneration === null
            || heartbeat.workflowExecutionGeneration === stepRun.executionGeneration)
        : heartbeat.workflowStepRunId === stepRunId
          && heartbeat.workflowExecutionGeneration === stepRun.executionGeneration);
    const running = heartbeat.status === "running" && ["pending", "running"].includes(stepRun.status)
      && heartbeat.workflowStepRunId === stepRunId
      && heartbeat.workflowExecutionGeneration === stepRun.executionGeneration;
    const completed = heartbeat.status === "succeeded" && stepRun.status === "completed"
      && wake.status === "completed" && heartbeat.workflowStepRunId === stepRunId
      && heartbeat.workflowExecutionGeneration === stepRun.executionGeneration;
    const ownerMatches = stepRun.status === "pending"
      ? (stepRun.dispatchOwnerHeartbeatRunId === null || stepRun.dispatchOwnerHeartbeatRunId === heartbeat.id)
        && (stepRun.dispatchOwnerWakeupRequestId === null || stepRun.dispatchOwnerWakeupRequestId === wake.id)
      : stepRun.dispatchOwnerHeartbeatRunId === heartbeat.id && stepRun.dispatchOwnerWakeupRequestId === wake.id;
    if (wake.runId !== heartbeat.id || heartbeat.companyId !== companyId || heartbeat.agentId !== agentId
      || heartbeat.issueId !== issueId || heartbeat.wakeupRequestId !== wake.id
      || !(queued || running || completed) || !ownerMatches) {
      throw new Error("C5 public workflow step existing heartbeat lost its exact durable wake binding");
    }
    const proof = readWorkflowAttemptProof(wake);
    if (proof.schemaVersion !== 1 || proof.companyId !== companyId || proof.agentId !== agentId
      || proof.missionId !== missionId || proof.workflowRunId !== runId || proof.issueId !== issueId
      || proof.stepRunId !== stepRunId || proof.executionGeneration !== stepRun.executionGeneration
      || proof.retryCount !== stepRun.retryCount || proof.iterationIndex !== stepRun.iterationIndex
      || proof.wakeupRequestId !== wake.id || proof.parentHeartbeatRunId !== null) {
      throw new Error("C5 public workflow step wake does not prove the exact stored attempt");
    }
    return { id: heartbeat.id, wakeupRequestId: wake.id };
  };

  const invokeMarker = async (service: ReturnType<typeof heartbeatService>, agentId: string, marker: string) => {
    const queued = await service.invoke(agentId, "on_demand", {
      c5PublicActual: marker,
      taskKey: `c5-public:${runId}:${marker}`,
    }, "manual");
    if (!queued?.id || !queued.wakeupRequestId) throw new Error(`C5 public ${marker} invocation lacks its durable run/wake`);
    return queued;
  };

  const execution = async (context: AdapterExecutionContext): Promise<AdapterExecutionResult> => {
    const marker = typeof context.context.c5PublicActual === "string" ? context.context.c5PublicActual : null;
    if (marker === "slot-blocker" && context.agent.id === downstreamAgentId) {
      slotBlockerEntered.resolve(context.runId);
      await slotBlockerRelease.promise;
      return successfulActual("slot-blocker");
    }
    if (marker === "same-agent-u" && context.agent.id === downstreamAgentId) {
      sameAgentUEntered.resolve(context.runId);
      return successfulActual("same-agent-u");
    }
    if (marker === "separate-agent-u" && context.agent.id === unrelatedAgentId) {
      separateAgentUEntered.resolve(context.runId);
      return successfulActual("separate-agent-u");
    }
    if (context.agent.id === unrelatedAgentId && context.context.source === "scheduler"
      && context.context.reason === "interval_elapsed") {
      timerActualEntered.resolve(context.runId);
      return successfulActual("timer");
    }
    const issueId = typeof context.context.issueId === "string" ? context.context.issueId : null;
    if (!issueId) throw new Error(`C5 public adapter lacks an issue binding for ${context.runId}`);
    const [issue] = await fixture.db.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
    if (!issue) throw new Error(`C5 public adapter issue is outside the fixture: ${issueId}`);
    const actor = { actorType: "agent" as const, actorId: context.agent.id, agentId: context.agent.id, runId: context.runId };

    if (issue.id === producerIssueId && context.agent.id === producerAgentId) {
      await readWorkflowAttempt(context, { agentId: producerAgentId, issueId: producerIssueId, stepRun: producerStep });
      producerRunId = context.runId;
      producerEntered.resolve(context.runId);
      await mkdir(dirname(artifactPath), { recursive: true });
      await writeFile(artifactPath, "before\n", "utf8");
      const product = await registerWorkflowArtifact({ db: fixture.db, issue, actor,
        data: { path: artifactPath, type: "document", isPrimary: true } });
      const provenance = await registeredProducer(fixture.db, companyId, producerIssueId, context.runId);
      if (!provenance) {
        throw new Error("C5 public producer actual has no official registered provenance");
      }
      if (options.c02NotificationInput) {
        await validateRegisteredProducerSeal(product, provenance);
        const bindingScope = and(eq(workflowStepOutputBindings.companyId, companyId),
          eq(workflowStepOutputBindings.workflowRunId, runId),
          eq(workflowStepOutputBindings.consumerStepRunId, qaStep.id),
          eq(workflowStepOutputBindings.referencedStepId, producerStepId));
        const existingBindings = await fixture.db.select().from(workflowStepOutputBindings).where(bindingScope);
        if (existingBindings.length > 1 || (existingBindings[0]
          && (existingBindings[0].workProductId !== product.id
            || existingBindings[0].sourceExecutionGeneration !== producerStep.executionGeneration))) {
          throw new Error("C5 C02 fixture binding is not the exact registered producer-to-QA input");
        }
        const [binding] = existingBindings.length ? existingBindings : await fixture.db.insert(workflowStepOutputBindings)
          .values({ companyId, workflowRunId: runId, consumerStepRunId: qaStep.id,
            referencedStepId: producerStepId, workProductId: product.id,
            sourceExecutionGeneration: producerStep.executionGeneration }).returning();
        if (!binding) throw new Error("C5 C02 fixture binding was not recorded");
        c02SourceProductId = product.id;
        c02BindingId = binding.id;
      }
      await completeWorkflowIssue({ db: fixture.db, issue, actor, data: {} });
      producerWorkCompleted.resolve(context.runId);
      await producerActualRelease.promise;
      return successfulActual("producer");
    }

    if (issue.id === qaIssueId && context.agent.id === qaAgentId) {
      if (qaPassRunId) throw new Error("C5 QA adapter received an extra actual after the official PASS");
      const bytes = await readFile(artifactPath, "utf8");
      if (qaRequestChangesRunId === null) {
        const identity = await readWorkflowAttempt(context, { agentId: qaAgentId, issueId: qaIssueId, stepRun: qaStep });
        if (identity.wake.payload?.qaRemediationCompletion != null) throw new Error("C5 initial QA wake unexpectedly carries refire authority");
        if (bytes !== "before\n") throw new Error("C5 original QA did not read the registered producer bytes");
        qaRequestChangesRunId = context.runId;
        qaEntries++;
        const submitted = await submitWorkflowVerdict({ db: fixture.db, issue, actor, data: {
          verdict: "request_changes",
          findings: [{ id: "c5-public-artifact", summary: "The registered report needs correction", layer: "artifact" }],
          remediations: { items: [{ op: "string_replace", file: artifactPath, find: "before", replace: "after" }] },
        } });
        if (!submitted.satisfied) throw new Error("C5 official request-changes verdict was not satisfied");
        const verdicts = await fixture.peer.select().from(workflowTransitionEvents).where(and(
          eq(workflowTransitionEvents.companyId, companyId), eq(workflowTransitionEvents.missionId, missionId),
          eq(workflowTransitionEvents.workflowRunId, runId), eq(workflowTransitionEvents.workflowStepRunId, qaStep.id),
          eq(workflowTransitionEvents.issueId, qaIssueId), eq(workflowTransitionEvents.heartbeatRunId, context.runId),
          eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
          eq(workflowTransitionEvents.verdict, "request_changes")));
        if (verdicts.length !== 1) throw new Error("C5 request-changes verdict lacks one exact persisted event");
        qaRequestChangesEventId = verdicts[0]!.id;
        qaVerdictSubmitted.resolve(context.runId);
        await qaActualRelease.promise;
        return successfulActual("qa-request-changes");
      }
      if (context.runId === qaRequestChangesRunId || qaRefireRunId) {
        throw new Error("C5 QA adapter received a duplicate or extra actual");
      }
      await assertAuthorizedQaRefire(context);
      if (bytes !== "after\n") throw new Error("C5 QA continuation is not the exact prepared artifact recheck");
      qaRefireRunId = context.runId;
      qaEntries++;
      qaPassRunId = context.runId;
      await submitWorkflowVerdict({ db: fixture.db, issue, actor, data: { verdict: "pass" } });
      await completeWorkflowIssue({ db: fixture.db, issue, actor, data: {} });
      return successfulActual("qa-pass");
    }

    if (issue.id === downstreamIssueId && context.agent.id === downstreamAgentId) {
      await readWorkflowAttempt(context, { agentId: downstreamAgentId, issueId: downstreamIssueId, stepRun: downstreamStep });
      downstreamEntered.resolve(context.runId);
      await completeWorkflowIssue({ db: fixture.db, issue, actor, data: {} });
      return successfulActual("downstream");
    }
    if (issue.id === claimConsumerIssueId && context.agent.id === downstreamAgentId) {
      await readWorkflowAttempt(context, { agentId: downstreamAgentId, issueId: claimConsumerIssueId, stepRun: claimConsumerStep });
      claimConsumerEntered.resolve(context.runId);
      await completeWorkflowIssue({ db: fixture.db, issue, actor, data: {} });
      return successfulActual("claim-consumer");
    }
    throw new Error(`C5 public fixture received an unregistered actual: agent=${context.agent.id} issue=${issue.id}`);
  };

  const ownerRuntime = (onLockWait: () => void): QaFileOwnerRuntime => {
    const runtime = createQaFileOwnerRuntime({ qaFileOwnerLockRoot: fixture.lockRoot, qaFileOwnerPython: PYTHON! });
    return {
      capability: runtime.capability,
      begin: (targets, options = {}) => runtime.begin(targets, { ...options, onEvent: event => {
        if (event.type === "lock_wait") onLockWait();
        options.onEvent?.(event);
      } }),
    };
  };

  const readS3PhaseSnapshot = async () => {
    const [missionRows, workflowRows, stepRows, heartbeatRows, wakeRows, eventRows, issueRows, bindingRows] = await Promise.all([
      fixture.peer.select().from(missions).where(eq(missions.id, missionId)),
      fixture.peer.select().from(workflowRuns).where(eq(workflowRuns.id, runId)),
      fixture.peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId)),
      fixture.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)),
      fixture.peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)),
      fixture.peer.select().from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.companyId, companyId), eq(workflowTransitionEvents.workflowRunId, runId))),
      fixture.peer.select().from(issues).where(eq(issues.companyId, companyId)),
      fixture.peer.select().from(workflowStepOutputBindings).where(and(
        eq(workflowStepOutputBindings.companyId, companyId), eq(workflowStepOutputBindings.workflowRunId, runId))),
    ]);
    const heartbeatSummaries = heartbeatRows.map(heartbeat => ({
      id: heartbeat.id, agentId: heartbeat.agentId, issueId: heartbeat.issueId, status: heartbeat.status,
      wakeupRequestId: heartbeat.wakeupRequestId, workflowStepRunId: heartbeat.workflowStepRunId,
      workflowExecutionGeneration: heartbeat.workflowExecutionGeneration, executionEpoch: heartbeat.executionEpoch,
      executorOwnerId: heartbeat.executorOwnerId, executorOwnerLeaseEpoch: heartbeat.executorOwnerLeaseEpoch,
      executorOwnerLeaseTokenDigest: digest(heartbeat.executorOwnerLeaseToken), executionTokenDigest: digest(heartbeat.executionToken),
      retryOfRunId: heartbeat.retryOfRunId, processLossRetryCount: heartbeat.processLossRetryCount,
      resultJson: heartbeat.resultJson,
    }));
    const wakeSummaries = wakeRows.map(wake => {
      const ref = wake.payload?.qaRemediationCompletion;
      const completionRef = ref && typeof ref === "object" && !Array.isArray(ref)
        ? { preparationEventId: (ref as Record<string, unknown>).preparationEventId ?? null,
          sourceVerdictEventId: (ref as Record<string, unknown>).sourceVerdictEventId ?? null }
        : null;
      return { id: wake.id, status: wake.status, runId: wake.runId, agentId: wake.agentId, issueId: wake.issueId,
        missionId: wake.missionId, workflowRunId: wake.workflowRunId, workflowStepRunId: wake.workflowStepRunId,
        workflowExecutionGeneration: wake.workflowExecutionGeneration, requestKind: wake.requestKind,
        fullAttempt: wake.workflowStepRunId ? readWorkflowAttemptProof(wake) : null,
        reason: wake.reason, hasC02CorrectionRef: readQaCorrectionWakeRef(wake) !== null, completionRef };
    });
    const wakeHeartbeatJoins = wakeRows.map(wake => {
      const linked = heartbeatRows.filter(heartbeat => heartbeat.wakeupRequestId === wake.id);
      return { wakeupRequestId: wake.id, wakeRunId: wake.runId, heartbeatRunIds: linked.map(run => run.id),
        cardinality: linked.length, status: wake.status, workflowStepRunId: wake.workflowStepRunId,
        heartbeatStepRunIds: linked.map(run => run.workflowStepRunId) };
    });
    const issueSummaries = issueRows.map(issue => ({ id: issue.id, status: issue.status, missionId: issue.missionId,
      assignedAgentId: issue.assignedAgentId, executionRunId: issue.executionRunId, checkoutRunId: issue.checkoutRunId }));
    const relevantEvents = eventRows.map(event => ({ id: event.id, eventType: event.eventType,
      workflowStepRunId: event.workflowStepRunId, issueId: event.issueId, heartbeatRunId: event.heartbeatRunId,
      executionGeneration: event.executionGeneration, verdict: event.verdict, reasonCode: event.reasonCode }));
    const actualDrain = preparedReservation?.outcome === "prepared"
      ? await fixture.peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, producerStep.id))
        .then(rows => rows[0]
          ? readQaRemediationActualDrain(fixture.peer, preparedReservation!.preparation, rows[0])
          : { kind: "held" as const, reason: "producer_step_missing", targetPaths: [] })
      : { kind: "not_prepared" as const };
    const terminalReleases = [];
    for (const heartbeat of heartbeatRows.filter(row => row.workflowStepRunId !== null)) {
      const identity = await freezeHeartbeatActualDrainIdentity(fixture.peer, heartbeat, { workflowRunId: runId });
      if (!identity) {
        terminalReleases.push({ heartbeatRunId: heartbeat.id, kind: "identity_unavailable" });
        continue;
      }
      const manifest = await readTerminalReleaseManifestForSource(fixture.peer, identity, heartbeat.agentId);
      if (manifest.kind !== "found") {
        terminalReleases.push({ heartbeatRunId: heartbeat.id, kind: manifest.kind,
          heldReason: manifest.kind === "held" ? manifest.reason : null });
        continue;
      }
      const ready = await readReadyTerminalReleaseContinuation(fixture.peer, manifest.eventId);
      const source = manifest.manifest.source;
      const currentWorkflow = workflowRows.find(row => row.id === source.workflowRunId);
      const currentStep = stepRows.find(row => row.id === source.workflowStepRunId);
      const currentIssue = issueSummaries.find(row => row.id === source.issueId);
      const acknowledgments = await Promise.all(manifest.manifest.obligations.map(async obligation => {
        const ack = await readTerminalReleaseAcknowledgment(fixture.peer, manifest.eventId, obligation.effectKey);
        return { stage: obligation.stage, action: obligation.action, effectKey: obligation.effectKey, kind: ack.kind,
          eventId: ack.kind === "acknowledged" ? ack.eventId : null, reason: ack.kind === "held" ? ack.reason : null };
      }));
      terminalReleases.push({ heartbeatRunId: heartbeat.id, kind: ready.kind, continuationEventId: manifest.eventId,
        identityDigest: source.identityDigest, requiredObligationCount: manifest.manifest.obligations.length,
        authorityAssociation: {
          frozen: source,
          current: {
            heartbeat: heartbeatSummaries.find(row => row.id === source.heartbeatRunId) ?? null,
            workflow: currentWorkflow ? { id: currentWorkflow.id, missionId: currentWorkflow.missionId,
              status: currentWorkflow.status, dispatchAuthorityVersion: currentWorkflow.dispatchAuthorityVersion } : null,
            step: currentStep ? { id: currentStep.id, stepId: currentStep.stepId, issueId: currentStep.issueId,
              executionGeneration: currentStep.executionGeneration, retryCount: currentStep.retryCount,
              iterationIndex: currentStep.iterationIndex, dispatchOwnerHeartbeatRunId: currentStep.dispatchOwnerHeartbeatRunId,
              dispatchOwnerWakeupRequestId: currentStep.dispatchOwnerWakeupRequestId } : null,
            wake: wakeSummaries.find(row => row.id === source.wakeupRequestId) ?? null, issue: currentIssue ?? null,
          },
        },
        actualOutcome: ready.kind === "ready" ? ready.actualOutcome : null,
        heldReason: ready.kind === "held" ? ready.reason : null, acknowledgments });
    }
    return {
      schemaVersion: "c5.p3.s3.wait.v2",
      scope: { companyId, missionId, workflowId, workflowRunId: runId },
      mission: missionRows.map(row => ({ id: row.id, status: row.status, completedAt: row.completedAt })),
      workflowRuns: workflowRows.map(row => ({ id: row.id, status: row.status, completedAt: row.completedAt })),
      steps: stepRows.map(row => ({ id: row.id, stepId: row.stepId, issueId: row.issueId, status: row.status,
        executionGeneration: row.executionGeneration, retryCount: row.retryCount, iterationIndex: row.iterationIndex })),
      heartbeats: heartbeatSummaries, wakes: wakeSummaries, wakeHeartbeatJoins,
      events: relevantEvents, reservationEventIds: eventRows.filter(row => row.eventType === QA_REMEDIATION_PREPARATION_EVENT_TYPE)
        .map(row => row.id),
      completionEventIds: eventRows.filter(row => row.eventType === QA_REMEDIATION_COMPLETION_EVENT_TYPE).map(row => row.id),
      c02: { bindingIds: bindingRows.map(row => row.id), correctionWakeIds: wakeRows
        .filter(wake => readQaCorrectionWakeRef(wake) !== null).map(wake => wake.id) },
      actualDrain, terminalReleases,
    };
  };

  return {
    companyId, missionId, workflowId, runId, producerAgentId, qaAgentId, downstreamAgentId,
    unrelatedAgentId, producerIssueId, qaIssueId, downstreamIssueId, claimConsumerIssueId,
    producerStep, qaStep, downstreamStep, claimConsumerStep, artifactPath,
    producerEntered: producerEntered.promise,
    producerWorkCompleted: producerWorkCompleted.promise,
    releaseProducerActual: () => producerActualRelease.resolve(),
    slotBlockerEntered: slotBlockerEntered.promise,
    releaseSlotBlocker: () => slotBlockerRelease.resolve(),
    sameAgentUEntered: sameAgentUEntered.promise,
    separateAgentUEntered: separateAgentUEntered.promise,
    downstreamEntered: downstreamEntered.promise,
    timerActualEntered: timerActualEntered.promise,
    claimConsumerEntered: claimConsumerEntered.promise,
    qaVerdictSubmitted: qaVerdictSubmitted.promise,
    releaseQaActual: () => qaActualRelease.resolve(),
    executeActual: execution,
    startProducer: () => wakeWorkflowStep(producerAgentId, producerIssueId, producerStep.id),
    startClaimConsumer: () => wakeWorkflowStep(downstreamAgentId, claimConsumerIssueId, claimConsumerStep.id),
    startDownstream: () => wakeWorkflowStep(downstreamAgentId, downstreamIssueId, downstreamStep.id),
    ensureClaimConsumer: () => ensureWorkflowStepRun(downstreamAgentId, claimConsumerIssueId, claimConsumerStep.id),
    ensureDownstream: () => ensureWorkflowStepRun(downstreamAgentId, downstreamIssueId, downstreamStep.id),
    startSlotBlocker: (service: ReturnType<typeof heartbeatService>) => invokeMarker(service, downstreamAgentId, "slot-blocker"),
    startSameAgentU: (service: ReturnType<typeof heartbeatService>) => invokeMarker(service, downstreamAgentId, "same-agent-u"),
    startSeparateAgentU: (service: ReturnType<typeof heartbeatService>) => invokeMarker(service, unrelatedAgentId, "separate-agent-u"),
    prepare: async () => {
      if (!producerRunId || !qaRequestChangesRunId) throw new Error("C5 official producer/QA actuals are not both started");
      const prepared = await prepareQaRemediationReservation(fixture.db, { companyId, missionId,
        workflowRunId: runId, producerStepRunId: producerStep.id, qaStepRunIds: [qaStep.id] });
      if (prepared.outcome === "prepared") {
        preparedReservation = prepared;
        const [currentProducerStep] = await fixture.peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, producerStep.id));
        const drain = await readQaRemediationActualDrain(fixture.peer, prepared.preparation, currentProducerStep!);
        if (drain.kind !== "proven") throw new Error(`C5 producer actual drain is not genuine: ${drain.kind}`);
      }
      return prepared;
    },
    issueC02NotificationInput: async () => {
      if (!options.c02NotificationInput || !c02SourceProductId || !c02BindingId
        || !producerRunId || !qaRequestChangesRunId || !qaRequestChangesEventId) {
        throw new Error("C5 S2 C02 notification input lacks its enabled exact producer, binding, or QA history");
      }
      const [run] = await fixture.db.select().from(workflowRuns).where(and(
        eq(workflowRuns.id, runId), eq(workflowRuns.companyId, companyId)));
      const stepRuns = await fixture.db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
      const producerRun = stepRuns.find(step => step.id === producerStep.id);
      const qaRun = stepRuns.find(step => step.id === qaStep.id);
      if (!run || !producerRun?.issueId || !qaRun?.issueId || qaRun.issueId !== qaIssueId) {
        throw new Error("C5 S2 C02 input lacks the exact persisted run and producer/QA attempt");
      }
      const execution = await loadExecutionDefinition(fixture.db, runId, { requireHistorical: false });
      const producerDefinition = execution.steps.find(step => step.id === producerRun.stepId);
      if (!producerDefinition) throw new Error("C5 S2 C02 input lacks the stored producer step definition");
      const rejectedQas = [{ edge: { stepId: qaRun.stepId }, qaRun }];
      const findingsByQaStepId = new Map<string, readonly WorkflowVerdictFinding[] | null>();
      for (const rejected of rejectedQas) {
        const scope = { db: fixture.db, companyId, issueId: rejected.qaRun.issueId!,
          workflowRunId: runId, workflowStepRunId: rejected.qaRun.id };
        const findings = await loadWorkflowApiFindings(scope);
        const prior = producerRun.completedAt
          ? await loadPriorRejectedFindings({ ...scope, notAfter: producerRun.completedAt }) : null;
        findingsByQaStepId.set(rejected.edge.stepId,
          findings ? applyRecurrencePromotion(findings, prior).findings : null);
      }
      const discovered = await discoverQaCorrection({ db: fixture.db, run, steps: execution.steps,
        producerStep: producerDefinition, producerRun, rejectedQas, findingsByQaStepId });
      if (!discovered) throw new Error("C5 S2 C02 production discovery did not qualify the official source inputs");
      const [sourceProduct] = await fixture.db.select().from(issueWorkProducts)
        .where(eq(issueWorkProducts.id, c02SourceProductId));
      const [binding] = await fixture.db.select().from(workflowStepOutputBindings)
        .where(eq(workflowStepOutputBindings.id, c02BindingId));
      const provenance = await registeredProducer(fixture.db, companyId, producerIssueId, producerRunId);
      const producerAttempt = { stepRunId: producerRun.id, stepId: producerRun.stepId, issueId: producerRun.issueId,
        executionGeneration: producerRun.executionGeneration, retryCount: producerRun.retryCount,
        iterationIndex: producerRun.iterationIndex };
      const qaAttempt = { stepRunId: qaRun.id, stepId: qaRun.stepId, issueId: qaRun.issueId,
        executionGeneration: qaRun.executionGeneration, retryCount: qaRun.retryCount,
        iterationIndex: qaRun.iterationIndex };
      const authority = discovered.p.authority;
      const persistedProducer = sourceProduct && provenance
        ? await validateRegisteredProducerSeal(sourceProduct, provenance) : null;
      const discoveredProducer = discovered.p.sources.length === 1
        && discovered.p.sources[0]!.provenance.kind === "workflow_producer"
        ? discovered.p.sources[0]!.provenance.workflowProducer : null;
      if (!sourceProduct || sourceProduct.status !== "active" || !binding || !provenance || !persistedProducer
        || authority.kind !== "workflow_qa" || authority.verdicts.length !== 1
        || authority.verdicts[0]!.eventId !== qaRequestChangesEventId
        || authority.verdicts[0]!.heartbeatRunId !== qaRequestChangesRunId
        || !isDeepStrictEqual(authority.verdicts[0]!.qa, qaAttempt)
        || !isDeepStrictEqual(discovered.p.producer, producerAttempt)
        || discovered.p.dispatchAuthorityVersion !== run.dispatchAuthorityVersion
        || discovered.p.sources.length !== 1 || discovered.p.sources[0]!.productId !== c02SourceProductId
        || discovered.p.sources[0]!.provenance.kind !== "workflow_producer"
        || !discoveredProducer || !isDeepStrictEqual(discoveredProducer, persistedProducer)
        || discovered.p.bindings.length !== 1 || discovered.p.bindings[0]!.bindingId !== c02BindingId
        || discovered.p.bindings[0]!.expectedProductId !== c02SourceProductId
        || discovered.p.bindings[0]!.referencedStepId !== producerStepId
        || !isDeepStrictEqual(discovered.p.bindings[0]!.consumer, qaAttempt)) {
        throw new Error("C5 S2 C02 production discovery did not preserve exact source provenance, verdict, binding, or attempt");
      }
      const begun = await beginQaCorrection(fixture.db, discovered.p);
      if (begun.status !== "prepared" && begun.status !== "existing") {
        throw new Error(`C5 S2 C02 preparation did not commit exactly: ${JSON.stringify({ status: begun.status,
          result: begun, candidatePreparationFieldPathDiff: fieldPathDifferences(discovered.p, undefined, "$", true, false) })}`);
      }
      const returnedPreparation = qaCorrectionPreparationSchema.safeParse(begun.preparation);
      const [preparationEvent] = await fixture.db.select().from(workflowTransitionEvents)
        .where(eq(workflowTransitionEvents.id, begun.preparationEventId));
      const eventPreparation = preparationEvent
        ? qaCorrectionPreparationSchema.safeParse(preparationEvent.payload) : null;
      const returnedPreparationHash = returnedPreparation.success
        ? hashQaCorrectionPayload(returnedPreparation.data) : null;
      const eventPreparationHash = eventPreparation?.success
        ? hashQaCorrectionPayload(eventPreparation.data) : null;
      const candidateReturnedDiff = fieldPathDifferences(discovered.p, begun.preparation);
      const contractDiff = returnedPreparation.success
        ? begun.status === "prepared"
          ? fieldPathDifferences({ ...discovered.p, preparedAt: returnedPreparation.data.preparedAt }, returnedPreparation.data)
          : fieldPathDifferences(qaCorrectionFrozenBody(discovered.p), qaCorrectionFrozenBody(returnedPreparation.data))
        : candidateReturnedDiff;
      const preparationMatches = returnedPreparation.success && (begun.status === "prepared"
        ? isDeepStrictEqual({ ...discovered.p, preparedAt: returnedPreparation.data.preparedAt }, returnedPreparation.data)
        : qaCorrectionFrozenBodyHash(discovered.p) === qaCorrectionFrozenBodyHash(returnedPreparation.data));
      const eventMatches = returnedPreparation.success && eventPreparation?.success === true
        && preparationEvent?.id === begun.preparationEventId
        && preparationEvent?.eventType === "qa_correction_prepared"
        && preparationEvent?.companyId === companyId && preparationEvent?.missionId === missionId
        && preparationEvent?.workflowRunId === runId && preparationEvent?.workflowStepRunId === producerStep.id
        && preparationEvent?.issueId === producerIssueId
        && begun.preparationEventId === returnedPreparation.data.correctionId
        && isDeepStrictEqual(eventPreparation.data, returnedPreparation.data)
        && returnedPreparationHash === begun.preparationHash && eventPreparationHash === begun.preparationHash;
      if (!preparationMatches || !eventMatches) {
        const diagnostics = {
          status: begun.status,
          preparationSchema: returnedPreparation.success ? { success: true } : { success: false,
            issues: returnedPreparation.error.issues.map(issue => ({ code: issue.code, path: issue.path, message: issue.message })) },
          candidateReturnedFieldPathDiff: candidateReturnedDiff,
          contractFieldPathDiff: contractDiff,
          preparationEvent: preparationEvent ? { id: preparationEvent.id, eventType: preparationEvent.eventType,
            companyId: preparationEvent.companyId, missionId: preparationEvent.missionId,
            workflowRunId: preparationEvent.workflowRunId, workflowStepRunId: preparationEvent.workflowStepRunId,
            issueId: preparationEvent.issueId, schemaValid: eventPreparation?.success ?? false,
            schemaIssues: eventPreparation && !eventPreparation.success
              ? eventPreparation.error.issues.map(issue => ({ code: issue.code, path: issue.path, message: issue.message })) : [],
            returnedPayloadHash: returnedPreparationHash, persistedPayloadHash: eventPreparationHash,
            fieldPathDiff: eventPreparation?.success
              ? fieldPathDifferences(returnedPreparation.success ? returnedPreparation.data : begun.preparation, eventPreparation.data)
              : fieldPathDifferences(returnedPreparation.success ? returnedPreparation.data : begun.preparation,
                preparationEvent.payload) }
            : { missing: true },
          preparationEventId: begun.preparationEventId, preparationHash: begun.preparationHash,
          returnedPreparationHash, eventPreparationHash,
        };
        throw new Error(`C5 S2 C02 preparation did not commit exactly: ${JSON.stringify(diagnostics)}`);
      }
      const authoritativePreparation = returnedPreparation.data;
      const measured = await measureQaCorrectionSources(fixture.db, {
        preparationEventId: begun.preparationEventId, preparationHash: begun.preparationHash,
      });
      const stored = await storeQaCorrection(fixture.db, measured);
      const committed = await commitQaCorrection(fixture.db, stored);
      if (committed.status !== "committed") {
        throw new Error(`C5 S2 C02 source revision did not commit: ${JSON.stringify(committed)}`);
      }
      if (!isDeepStrictEqual(committed.proof.preparation, authoritativePreparation)) {
        throw new Error(`C5 S2 C02 commit proof did not preserve the returned preparation: ${JSON.stringify({
          fieldPathDiff: fieldPathDifferences(authoritativePreparation, committed.proof.preparation),
          returnedPreparationHash: hashQaCorrectionPayload(authoritativePreparation),
          commitProofPreparationHash: hashQaCorrectionPayload(committed.proof.preparation),
        })}`);
      }
      const matchingFollowups = committed.proof.followups.filter(followup => isDeepStrictEqual(followup.target, qaAttempt));
      if (committed.proof.followups.length !== 1 || matchingFollowups.length !== 1) {
        throw new Error("C5 S2 C02 commit does not contain one followup for the current full QA attempt");
      }
      const followup = matchingFollowups[0]!;
      const notifications = createReplacementRootNotifications();
      await fixture.db.transaction(async tx => {
        const [lockedMission] = await tx.select({ id: missions.id }).from(missions).where(eq(missions.id, missionId)).for("no key update");
        const [lockedRun] = await tx.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.id, runId)).for("no key update");
        if (!lockedMission || !lockedRun) throw new Error("C5 S2 C02 queue lacks its root mission/run transaction");
        const txDb = tx as unknown as Db;
        await withReplacementRootNotificationDb(txDb, notifications,
          () => queueIssued(txDb, committed.proof.preparation, committed.appliedEventId));
      });
      if (notifications.correctionWakeupRequestIds.size !== 1) {
        throw new Error("C5 S2 C02 queue did not register exactly one correction notification ID");
      }
      const [correctionWakeupRequestId] = [...notifications.correctionWakeupRequestIds];
      const [wake] = await fixture.peer.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, correctionWakeupRequestId!));
      const ref = { companyId, workflowRunId: runId, appliedEventId: committed.appliedEventId, requestId: followup.requestId };
      if (!wake || wake.companyId !== companyId || wake.agentId !== qaAgentId || wake.issueId !== qaIssueId
        || wake.missionId !== missionId || wake.workflowRunId !== runId || wake.workflowStepRunId !== qaRun.id
        || wake.workflowExecutionGeneration !== qaRun.executionGeneration
        || !["queued", "deferred_issue_execution"].includes(wake.status) || wake.runId !== null
        || !isDeepStrictEqual(readQaCorrectionWakeRef(wake), ref)) {
        throw new Error("C5 S2 C02 notification ID does not identify its exact strict correction wake");
      }
      notifications.agentIds.add(qaAgentId);
      return { notifications, correctionWakeupRequestId, wake, ref, followup, preparation: authoritativePreparation,
        committed, sourceProductId: c02SourceProductId, bindingId: c02BindingId, producerProvenance: persistedProducer };
    },
    holdArtifact: async () => {
      const runtime = createQaFileOwnerRuntime({ qaFileOwnerLockRoot: fixture.lockRoot, qaFileOwnerPython: PYTHON! });
      const owner = await runtime.begin([artifactPath]);
      const release = fixture.trackNativeOwner(owner);
      return { owner, release };
    },
    ownerRuntime,
    reconcileReservation: async (onLockWait: () => void) => {
      const notifications = createReplacementRootNotifications();
      const result = await withReplacementRootNotificationDb(fixture.db, notifications, () =>
        reconcileQaRemediationReservation(fixture.db, { companyId, missionId, workflowRunId: runId,
          producerStepRunId: producerStep.id, qaStepRunIds: [qaStep.id] }, ownerRuntime(onLockWait)));
      if (result.outcome === "completed") {
        completionEventId = result.completionEventId;
        v2RefireWakeupRequestIds = result.completion.wakes.filter(wake => wake.kind === "v2_refire")
          .map(wake => wake.wakeupRequestId);
      }
      return { result, notifications };
    },
    phaseIds: () => ({
      scope: { companyId, missionId, workflowId, workflowRunId: runId },
      issues: { producer: producerIssueId, qa: qaIssueId, downstream: downstreamIssueId,
        claimConsumer: claimConsumerIssueId },
      steps: { producer: producerStep.id, qa: qaStep.id, downstream: downstreamStep.id,
        claimConsumer: claimConsumerStep.id },
      actuals: { producer: producerRunId, qaRequestChanges: qaRequestChangesRunId,
        qaRefire: qaRefireRunId, qaPass: qaPassRunId },
      sourceVerdictEventId: qaRequestChangesEventId,
      reservation: { preparationEventId: preparedReservation?.outcome === "prepared"
        ? preparedReservation.preparationEventId : null, completionEventId, v2RefireWakeupRequestIds },
      c02: { sourceProductId: c02SourceProductId, bindingId: c02BindingId },
    }),
    readS3PhaseSnapshot,
    drain: async () => waitForHeartbeatExecutionsToDrain(fixture.db, 60_000),
    readIdentity: async (heartbeatRunId: string) => {
      const [heartbeat] = await fixture.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, heartbeatRunId));
      const [wake] = heartbeat?.wakeupRequestId
        ? await fixture.peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, heartbeat.wakeupRequestId)) : [];
      const stepRunId = heartbeat?.workflowStepRunId ?? wake?.workflowStepRunId ?? null;
      const [step] = stepRunId
        ? await fixture.peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId)) : [];
      const [issue] = heartbeat?.issueId
        ? await fixture.peer.select().from(issues).where(eq(issues.id, heartbeat.issueId)) : [];
      return { heartbeat, wake, issue, step };
    },
    currentQaRuns: () => ({ requestChangesRunId: qaRequestChangesRunId, passRunId: qaPassRunId, entries: qaEntries }),
    service: () => heartbeatService(fixture.db),
    waitFor: within,
  };
}
