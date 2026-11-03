import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { vi } from "vitest";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../../adapters/types.js";
import {
  agentWakeupRequests, agents, approvals, companies, heartbeatRuns, issueWorkProducts, issues, missions,
  toolDefinitions, workflowDefinitions, workflowRecoveryAuthorities, workflowRuns, workflowStepRuns,
  workflowTerminalDecisions, workflowTransitionEvents, type Db,
} from "@paperclipai/db";
import { replacementApprovalPayloadSchema } from "@paperclipai/shared/validators/workflow-replacement";
import { freezeHeartbeatActualDrainIdentity, readQaRemediationActualDrain,
  type HeartbeatActualDrainIdentity } from "../../services/heartbeat-actual-drain.js";
import { waitForHeartbeatExecutionsToDrain } from "../../services/heartbeat-execution-tracker.js";
import { completeWorkflowIssue, registerWorkflowArtifact } from "../../services/workflow/agent-api.js";
import { wakeExistingWorkflowStepIssue } from "../../services/workflow/workflow-step-wake.js";
import { normalizeWorkflowStepsForExecution } from "../../services/workflow/execution-steps.js";
import { recordWorkflowValidationVerdict } from "../../services/workflow/validation-verdict-ledger.js";
import { registeredProducer } from "../../services/work-products/producer-provenance.js";
import { QaRemediationFileOwner, type FileOwnerBeginInput, type FileOwnerExit } from "../../services/workflow/control-flow/qa-remediation-file-owner.js";
import type { QaFileOwnerRuntime } from "../../services/workflow/control-flow/qa-remediation-runtime.js";
import { buildQaRemediationPreparationCandidate, prepareQaRemediationReservation,
  type QaRemediationPreparationRequest } from "../../services/workflow/control-flow/qa-remediation-prepare.js";
import { writeQaRemediationPreparation, type QaRemediationPreparationTransaction } from "../../services/workflow/control-flow/qa-remediation-preparation-writer.js";
import { QA_REMEDIATION_PREPARATION_EVENT_TYPE, type QaRemediationPreparation }
  from "../../services/workflow/control-flow/qa-remediation-preparation-contract.js";
import { classifyQaRemediationPreparationRow, parseQaRemediationPreparation,
  type QaRemediationEventRow, type QaRemediationPreparationScope } from "../../services/workflow/control-flow/qa-remediation-preparation-contract.js";
import { hashQaCorrectionPayload } from "../../services/workflow/control-flow/qa-correction-contract.js";
import { hashStructuredValue } from "../../services/issue-execution-cards/hash.js";
import { replacementDefinitionHash } from "../../services/workflow/replacement-definition.js";
import { normalizeWorkflowRunInputs } from "../../services/workflow/run-input-normalization.js";
import { qaRemediationCompletionKey, qaRemediationRefireV2WakeKey,
  validateQaRemediationCompletionEvidence } from "../../services/workflow/control-flow/qa-remediation-completion-evidence.js";
import { readWorkflowAttemptProof } from "../../services/heartbeat-finalization/workflow-attempt-proof.js";
import { readTerminalReleaseAcknowledgment, readTerminalReleaseManifestForSource } from "../../services/heartbeat-terminal-release-continuation.js";
import { createQaCorrectionTestDb } from "./qa-correction-fixture.js";
import { deferred, within } from "./qa-remediation-parent-death-harness.js";

const beforeText = "before\n";
const afterText = "after\n";

export type AdmissionHarness = Awaited<ReturnType<typeof createAdmissionHarness>>;
export type AdmissionUnit = {
  readonly companyId: string;
  readonly missionId: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly authorId: string;
  readonly verifierId: string;
  readonly producer: typeof workflowStepRuns.$inferSelect;
  readonly qa: typeof workflowStepRuns.$inferSelect;
  readonly qaIssue: typeof issues.$inferSelect;
  readonly producerWakeupRequestId: string;
  readonly producerHeartbeatRunId: string;
  readonly producerHeartbeat: typeof heartbeatRuns.$inferSelect;
  readonly producerWakeup: typeof agentWakeupRequests.$inferSelect;
  readonly producerProduct: typeof issueWorkProducts.$inferSelect;
  readonly producerIssueId: string;
  readonly producerDrainIdentity: HeartbeatActualDrainIdentity;
  readonly automaticQaHeartbeatRunId: string;
  readonly automaticQaWakeupRequestId: string;
  readonly adapterEntries: { producer: number; automaticQa: number; validatedV2Refires: number; v2RefireWakeIds: string[] };
  readonly file: string;
  readonly verdictEventId: string;
  readonly verdictHeartbeatId: string;
  readonly verdictRemediationsHash: string;
  readonly preparationEventId?: string;
  readonly preparation?: import("../../services/workflow/control-flow/qa-remediation-preparation-contract.js").QaRemediationPreparation;
};
export type AdmissionDownstreamProgress = {
  readonly companyId: string;
  readonly missionId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly issueId: string;
  readonly stepRun: typeof workflowStepRuns.$inferSelect;
  adapterEntries: number;
  actual?: {
    readonly heartbeatRunId: string;
    readonly wakeupRequestId: string;
    readonly attempt: ReturnType<typeof attemptTuple>;
    readonly stdout: string;
  };
};
type AdmissionQaCompletionResult =
  | { readonly kind: "completed"; readonly issue: typeof issues.$inferSelect; readonly adapterResult: AdapterExecutionResult }
  | { readonly kind: "failed"; readonly error: string; readonly adapterResult: AdapterExecutionResult };
export type AdmissionQaCompletionControl = {
  readonly waitForAllCommitReturns: () => Promise<void>;
  readonly restore: () => void;
  readonly releaseAll: () => void;
  readonly barrierSnapshot: () => readonly { issueId: string; hits: number; released: boolean }[];
  readonly finish: () => Promise<readonly AdmissionQaCompletionResult[]>;
};
export type AdmissionScenario = {
  readonly companyId: string;
  readonly missionId: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly authorId: string;
  readonly verifierId: string;
  readonly units: AdmissionUnit[];
  readonly downstreamProgress: AdmissionDownstreamProgress;
  readonly qaCompletion: AdmissionQaCompletionControl;
};

type AdmissionAdapterHandler = (context: AdapterExecutionContext) => Promise<AdapterExecutionResult>;
type AdmissionQaOwnerOverride = {
  readonly companyId: string;
  readonly missionId: string;
  readonly targetRunId: string;
  readonly targetQaStepRunId: string;
  readonly targetQaIssueId: string;
  readonly definitionVerifierId: string;
  readonly targetIssueAssigneeAgentId: string;
  readonly sourceRunId: string;
  readonly sourceQaStepRunId: string;
  readonly sourceQaIssueId: string;
  readonly sourceVerifierId: string;
};
type AdmissionUnitState = {
  readonly scenario: AdmissionScenarioState;
  readonly companyId: string;
  readonly missionId: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly authorId: string;
  readonly verifierId: string;
  producer: typeof workflowStepRuns.$inferSelect;
  qa: typeof workflowStepRuns.$inferSelect;
  qaIssue: typeof issues.$inferSelect;
  readonly qaOwnerOverride?: AdmissionQaOwnerOverride;
  readonly producerIssueId: string;
  readonly file: string;
  readonly adapterEntries: AdmissionUnit["adapterEntries"];
  readonly producerEntered: ReturnType<typeof deferred<string>>;
  readonly allowProduction: ReturnType<typeof deferred<void>>;
  readonly producerCompleted: ReturnType<typeof deferred<string>>;
  readonly releaseActual: ReturnType<typeof deferred<void>>;
  readonly automaticQaEntered: ReturnType<typeof deferred<string>>;
  readonly allowQaVerdict: ReturnType<typeof deferred<void>>;
  readonly automaticQaReturned: ReturnType<typeof deferred<string>>;
  readonly qaCompletionSettled: ReturnType<typeof deferred<AdmissionQaCompletionResult>>;
  operationPhase: string;
  readonly actualResult: AdapterExecutionResult;
  readonly sessionId: string;
  readonly provider: string;
  readonly model: string;
  producerHeartbeatRunId?: string;
  producerWakeupRequestId?: string;
  producerHeartbeat?: typeof heartbeatRuns.$inferSelect;
  producerWakeup?: typeof agentWakeupRequests.$inferSelect;
  producerProduct?: typeof issueWorkProducts.$inferSelect;
  producerDrainIdentity?: HeartbeatActualDrainIdentity;
  automaticQaHeartbeatRunId?: string;
  automaticQaWakeupRequestId?: string;
  automaticQaHeartbeat?: typeof heartbeatRuns.$inferSelect;
  automaticQaWakeup?: typeof agentWakeupRequests.$inferSelect;
  automaticQaDrainIdentity?: HeartbeatActualDrainIdentity;
  verdictEventId?: string;
  verdictHeartbeatId?: string;
  verdictRemediationsHash?: string;
  preparation?: QaRemediationPreparation;
};
export type ReplacementLifecycleCheckpoint = {
  readonly eventType: "replacement_lifecycle_checkpoint";
  readonly awaitName: string;
  readonly phase: "enter" | "complete" | "error";
  readonly observedAt: string;
  readonly sourceRunId: string;
  readonly targetRunId: string;
  readonly companyId: string;
  readonly missionId: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly producerStepRunId: string;
  readonly producerIssueId: string;
  readonly producerAttempt: ReturnType<typeof attemptTuple>;
  readonly qaStepRunId: string;
  readonly qaIssueId: string;
  readonly qaAttempt: ReturnType<typeof attemptTuple>;
  readonly error?: { readonly name: string; readonly message: string };
};
export type ReplacementAdmissionObserver = {
  readonly onCheckpoint: (checkpoint: ReplacementLifecycleCheckpoint) => void;
  readonly onFailureSnapshot?: (snapshot: unknown) => void;
};
type AdmissionScenarioState = Omit<AdmissionScenario, "units" | "downstreamProgress" | "qaCompletion"> & {
  readonly units: AdmissionUnitState[];
  readonly dispatchAuthorityVersion: number;
  downstreamProgress?: AdmissionDownstreamProgress;
};
type AdmissionAdapterRegistration = {
  readonly kind: "producer" | "qa" | "downstream";
  readonly state?: AdmissionUnitState;
  readonly downstream?: AdmissionDownstreamProgress;
  readonly execute: (context: AdapterExecutionContext, observation: AdmissionAdapterObservation) => Promise<AdapterExecutionResult>;
};
type AdmissionAdapterObservation = {
  readonly diagnostic: Record<string, unknown>;
  readonly heartbeat?: typeof heartbeatRuns.$inferSelect;
  readonly wakeup?: typeof agentWakeupRequests.$inferSelect;
  readonly issue?: typeof issues.$inferSelect;
  readonly step?: typeof workflowStepRuns.$inferSelect;
};
type AdmissionDrainEvidence = {
  schemaVersion?: unknown;
  actual?: { outcome?: unknown };
  cleanup?: {
    runtimeServicesRelease?: { succeeded?: unknown };
    heartbeatSettlement?: { succeeded?: unknown };
    resources?: { workspaceOperationsSettled?: unknown; runtimeServicesStopped?: unknown; missionRuntimeIdle?: unknown };
  };
};
const admissionAdapterHandlers = new Map<string, AdmissionAdapterRegistration>();
const registeredAdmissionIssueIds = new Set<string>();
const adapterEntryDiagnostics: Array<Record<string, unknown>> = [];
const unhandledAdapterEntries: Array<Record<string, unknown>> = [];
const MAX_ADAPTER_DIAGNOSTICS = 20;
let droppedAdapterDiagnostics = 0;
let droppedUnhandledAdapterEntries = 0;
let activeAdmissionDb: Db | undefined;

function pushBoundedDiagnostic(target: Array<Record<string, unknown>>, value: Record<string, unknown>, unhandled = false) {
  if (target.length < MAX_ADAPTER_DIAGNOSTICS) target.push(value);
  else if (unhandled) droppedUnhandledAdapterEntries++;
  else droppedAdapterDiagnostics++;
}

async function observeAdmissionAdapterEntry(context: AdapterExecutionContext): Promise<AdmissionAdapterObservation> {
  const db = activeAdmissionDb;
  const contextIssueId = typeof context.context.issueId === "string" ? context.context.issueId : null;
  const [heartbeat] = db ? await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, context.runId)) : [];
  const [wakeup] = db && heartbeat?.wakeupRequestId
    ? await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, heartbeat.wakeupRequestId)) : [];
  const issueId = wakeup?.issueId ?? heartbeat?.issueId ?? contextIssueId;
  const [issue] = db && issueId ? await db.select().from(issues).where(eq(issues.id, issueId)) : [];
  const stepRunId = heartbeat?.workflowStepRunId ?? wakeup?.workflowStepRunId ?? null;
  const [step] = db && stepRunId ? await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId)) : [];
  const diagnostic = {
    heartbeatId: context.runId,
    contextAgentId: context.agent.id,
    contextIssueId,
    persistedHeartbeat: heartbeat ? {
      id: heartbeat.id, companyId: heartbeat.companyId, agentId: heartbeat.agentId, issueId: heartbeat.issueId,
      workflowStepRunId: heartbeat.workflowStepRunId, workflowExecutionGeneration: heartbeat.workflowExecutionGeneration,
      wakeupRequestId: heartbeat.wakeupRequestId, status: heartbeat.status,
    } : null,
    persistedWakeup: wakeup ? {
      id: wakeup.id, companyId: wakeup.companyId, agentId: wakeup.agentId, issueId: wakeup.issueId,
      missionId: wakeup.missionId, workflowRunId: wakeup.workflowRunId, workflowStepRunId: wakeup.workflowStepRunId,
      workflowExecutionGeneration: wakeup.workflowExecutionGeneration, reason: wakeup.reason, source: wakeup.source,
      requestKind: wakeup.requestKind, status: wakeup.status, idempotencyKey: wakeup.idempotencyKey,
    } : null,
    persistedIssue: issue ? { id: issue.id, companyId: issue.companyId, missionId: issue.missionId,
      originRunId: issue.originRunId, status: issue.status } : null,
    persistedStep: step ? { id: step.id, workflowRunId: step.workflowRunId, stepId: step.stepId,
      issueId: step.issueId, executionGeneration: step.executionGeneration,
      retryCount: step.retryCount, iterationIndex: step.iterationIndex, status: step.status } : null,
  };
  return { diagnostic, heartbeat, wakeup, issue, step };
}

export async function executeAdmissionFixtureAdapter(context: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const observation = await observeAdmissionAdapterEntry(context);
  pushBoundedDiagnostic(adapterEntryDiagnostics, observation.diagnostic);
  const issueId = typeof context.context.issueId === "string" ? context.context.issueId : "";
  const registration = admissionAdapterHandlers.get(issueId);
  if (!registration) {
    const failure = { reason: "no_registered_handler", diagnostic: observation.diagnostic };
    pushBoundedDiagnostic(unhandledAdapterEntries, failure, true);
    throw new Error(`Unexpected admission fixture adapter entry ${JSON.stringify(failure)}`);
  }
  try {
    return await registration.execute(context, observation);
  } catch (error) {
    const failure = { reason: error instanceof Error ? error.message : String(error), kind: registration.kind,
      diagnostic: observation.diagnostic };
    pushBoundedDiagnostic(unhandledAdapterEntries, failure, true);
    throw error;
  }
}

export async function drainAdmissionFixtureAdapters(db: Db, caseName: string) {
  await waitForHeartbeatExecutionsToDrain(db, 60_000);
  const failures = [...unhandledAdapterEntries];
  const diagnostics = [...adapterEntryDiagnostics];
  const dropped = { successfulEntries: droppedAdapterDiagnostics, unhandledEntries: droppedUnhandledAdapterEntries };
  for (const issueId of registeredAdmissionIssueIds) admissionAdapterHandlers.delete(issueId);
  registeredAdmissionIssueIds.clear();
  unhandledAdapterEntries.length = 0;
  adapterEntryDiagnostics.length = 0;
  droppedAdapterDiagnostics = 0;
  droppedUnhandledAdapterEntries = 0;
  if (failures.length || dropped.unhandledEntries) {
    throw new Error(`admission adapter entries failed after exact DB drain for ${caseName}: ${JSON.stringify({ failures, diagnostics, dropped })}`);
  }
  return diagnostics;
}

export type NativeOwnerRecord = {
  readonly targets: string[];
  readonly beginSequence: number;
  readonly sourceOnEvent: FileOwnerBeginInput["onEvent"];
  acquired: boolean;
  nativeLockWaits?: Array<{ target: string; sequence: number; acquiredAtObservation: boolean }>;
  acquiredSequence?: number;
  exitSequence?: number;
  exit?: FileOwnerExit | null;
  exitPromise?: Promise<FileOwnerExit | null>;
};

export function traceNativeOwnerBegins(options: { observeLockWait?: boolean } = {}) {
  const records: NativeOwnerRecord[] = [];
  let sequence = 0;
  const realBegin = QaRemediationFileOwner.begin.bind(QaRemediationFileOwner);
  const spy = vi.spyOn(QaRemediationFileOwner, "begin").mockImplementation(async input => {
    const record: NativeOwnerRecord = { targets: [...input.targets], beginSequence: ++sequence,
      sourceOnEvent: input.onEvent, acquired: false,
      ...(options.observeLockWait ? { nativeLockWaits: [] } : {}) };
    records.push(record);
    const beginInput: FileOwnerBeginInput = options.observeLockWait ? { ...input, onEvent: event => {
      input.onEvent?.(event);
      if (event.type === "lock_wait" && record.targets.includes(event.target)) {
        record.nativeLockWaits!.push({ target: event.target, sequence: ++sequence, acquiredAtObservation: record.acquired });
      }
    } } : input;
    const owner = await realBegin(beginInput);
    record.acquired = true;
    record.acquiredSequence = ++sequence;
    record.exitPromise = owner.awaitExit().then(exit => {
      record.exit = exit;
      record.exitSequence = ++sequence;
      return exit;
    });
    return owner;
  });
  return { records, restore: () => spy.mockRestore() };
}

function returnedIssueRow(value: unknown): Pick<typeof issues.$inferSelect, "id" | "companyId" | "missionId" | "status"> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.companyId !== "string" || typeof row.status !== "string") return null;
  return { id: row.id, companyId: row.companyId, missionId: typeof row.missionId === "string" ? row.missionId : null,
    status: row.status } as Pick<typeof issues.$inferSelect, "id" | "companyId" | "missionId" | "status">;
}

async function verifyCommittedQaIssue(harness: AdmissionHarness, state: AdmissionUnitState,
  returned: Pick<typeof issues.$inferSelect, "id" | "companyId" | "missionId" | "status">) {
  if (returned.id !== state.qaIssue.id || returned.companyId !== state.companyId
    || returned.missionId !== state.missionId || returned.status !== "done"
    || !state.verdictEventId || !state.verdictHeartbeatId || !state.automaticQaHeartbeatRunId
    || state.verdictHeartbeatId !== state.automaticQaHeartbeatRunId
    || !state.automaticQaWakeupRequestId || !state.automaticQaDrainIdentity) {
    throw new Error(`QA completion transaction return does not bind the exact declared issue ${state.qaIssue.id}`);
  }
  const [issue] = await harness.peer.select().from(issues).where(and(
    eq(issues.id, state.qaIssue.id), eq(issues.companyId, state.companyId), eq(issues.missionId, state.missionId)));
  const [step] = await harness.peer.select().from(workflowStepRuns).where(and(
    eq(workflowStepRuns.id, state.qa.id), eq(workflowStepRuns.workflowRunId, state.runId),
    eq(workflowStepRuns.issueId, state.qaIssue.id)));
  const [heartbeat] = await harness.peer.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, state.automaticQaHeartbeatRunId), eq(heartbeatRuns.companyId, state.companyId),
    eq(heartbeatRuns.issueId, state.qaIssue.id), eq(heartbeatRuns.workflowStepRunId, state.qa.id)));
  const [wakeup] = await harness.peer.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.id, state.automaticQaWakeupRequestId), eq(agentWakeupRequests.companyId, state.companyId),
    eq(agentWakeupRequests.issueId, state.qaIssue.id), eq(agentWakeupRequests.workflowStepRunId, state.qa.id)));
  const [verdict] = await harness.peer.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.id, state.verdictEventId), eq(workflowTransitionEvents.companyId, state.companyId),
    eq(workflowTransitionEvents.missionId, state.missionId), eq(workflowTransitionEvents.workflowRunId, state.runId),
    eq(workflowTransitionEvents.workflowStepRunId, state.qa.id), eq(workflowTransitionEvents.issueId, state.qaIssue.id),
    eq(workflowTransitionEvents.heartbeatRunId, state.verdictHeartbeatId),
    eq(workflowTransitionEvents.eventType, "workflow_validation_verdict")));
  const transitions = await harness.peer.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, state.companyId), eq(workflowTransitionEvents.workflowRunId, state.runId),
    eq(workflowTransitionEvents.workflowStepRunId, state.qa.id), eq(workflowTransitionEvents.issueId, state.qaIssue.id),
    eq(workflowTransitionEvents.eventType, "workflow_step_status_transition"),
    eq(workflowTransitionEvents.toStatus, "completed"), eq(workflowTransitionEvents.reasonCode, "workflow_agent_api")));
  const proof = wakeup ? readWorkflowAttemptProof(wakeup) : null;
  const verdictPayload = verdict?.payload as { remediations?: { items?: unknown[] } } | undefined;
  const remediationItems = verdictPayload?.remediations?.items;
  if (!issue || issue.status !== "done" || !issue.completedAt
    || !step || step.stepId !== state.qa.stepId || !sameAttempt(attemptTuple(step), attemptTuple(state.qa))
    || step.status !== "completed" || !step.completedAt
    || step.completedAt.getTime() !== issue.completedAt.getTime()
    || !heartbeat || heartbeat.agentId !== state.verifierId || heartbeat.wakeupRequestId !== state.automaticQaWakeupRequestId
    || heartbeat.workflowExecutionGeneration !== state.qa.executionGeneration
    || !wakeup || wakeup.agentId !== state.verifierId || wakeup.missionId !== state.missionId
    || wakeup.workflowRunId !== state.runId || wakeup.workflowExecutionGeneration !== state.qa.executionGeneration
    || wakeup.reason !== "workflow_step_runnable" || !proof || !sameStoredAttemptProof(proof, attemptTuple(state.qa))
    || proof.companyId !== state.companyId || proof.agentId !== state.verifierId || proof.missionId !== state.missionId
    || proof.workflowRunId !== state.runId || proof.wakeupRequestId !== wakeup.id
    || !verdict || verdict.verdict !== "request_changes" || verdict.decision !== "request_changes"
    || verdict.reason !== "workflow_api" || !Array.isArray(remediationItems)
    || hashQaCorrectionPayload(remediationItems) !== state.verdictRemediationsHash
    || transitions.length !== 1 || transitions[0]!.fromStatus === transitions[0]!.toStatus
    || transitions[0]!.idempotencyKey !== `wf-step-status:${state.qa.id}:completed:${step.statusTransitionVersion}`) {
    throw new Error(`QA completion commit lacks its exact issue, official verdict, attempt, or linked-step transition for ${state.qa.id}`);
  }
}

function createQaCompletionCommitReturnBarrier(harness: AdmissionHarness, units: readonly AdmissionUnitState[]) {
  type Gate = { readonly state: AdmissionUnitState; readonly arrived: ReturnType<typeof deferred<{ error?: unknown }>>;
    readonly release: ReturnType<typeof deferred<void>>; hits: number; released: boolean };
  const gates = new Map<string, Gate>();
  for (const state of units) {
    if (gates.has(state.qaIssue.id)) throw new Error(`duplicate declared QA issue in completion barrier ${state.qaIssue.id}`);
    gates.set(state.qaIssue.id, { state, arrived: deferred<{ error?: unknown }>(), release: deferred<void>(), hits: 0, released: false });
  }
  const originalTransaction = harness.db.transaction.bind(harness.db);
  const transactionSpy = vi.spyOn(harness.db, "transaction");
  let restored = false;
  let finished: Promise<readonly AdmissionQaCompletionResult[]> | undefined;
  const implementation = async (...args: Parameters<Db["transaction"]>) => {
    const result = await originalTransaction(...args);
    const returned = returnedIssueRow(result);
    const gate = returned?.status === "done" ? gates.get(returned.id) : undefined;
    if (gate && returned?.companyId === gate.state.companyId && returned.missionId === gate.state.missionId) {
      gate.hits++;
      if (gate.hits === 1) {
        let error: unknown;
        try { await verifyCommittedQaIssue(harness, gate.state, returned); }
        catch (caught) { error = caught; }
        gate.arrived.resolve({ ...(error === undefined ? {} : { error }) });
      }
      await gate.release.promise;
    }
    return result;
  };
  transactionSpy.mockImplementation(implementation as Db["transaction"]);

  const restore = () => {
    if (restored) return;
    transactionSpy.mockRestore();
    restored = true;
  };
  const releaseAll = () => { for (const gate of gates.values()) { gate.released = true; gate.release.resolve(); } };
  const barrierSnapshot = () => [...gates.values()].map(gate => ({ issueId: gate.state.qaIssue.id,
    hits: gate.hits, released: gate.released }));
  const waitForAllCommitReturns = async () => {
    const observations = await within(Promise.all([...gates.values()].map(gate => gate.arrived.promise)),
      "all exact QA transaction COMMIT return barriers");
    for (const [index, gate] of [...gates.values()].entries()) {
      if (gate.hits !== 1) throw new Error(`QA issue ${gate.state.qaIssue.id} reached its commit-return barrier ${gate.hits} times`);
      if (observations[index]?.error !== undefined) throw observations[index]!.error;
    }
  };
  const finish = () => finished ??= (async () => {
    restore();
    releaseAll();
    const outcomes = await within(Promise.all(units.map(state => state.qaCompletionSettled.promise)),
      "original QA completion API and adapter results");
    await waitForHeartbeatExecutionsToDrain(harness.db, 60_000);
    for (const [index, state] of units.entries()) {
      const outcome = outcomes[index]!;
      const [heartbeat] = await harness.peer.select().from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, state.automaticQaHeartbeatRunId!));
      const [wakeup] = await harness.peer.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, state.automaticQaWakeupRequestId!));
      const [issue] = await harness.peer.select().from(issues).where(eq(issues.id, state.qaIssue.id));
      const [step] = await harness.peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, state.qa.id));
      const proof = wakeup ? readWorkflowAttemptProof(wakeup) : null;
      const resultJson = heartbeat?.resultJson as { stdout?: unknown; stderr?: unknown } | null;
      const expectedAttempt = attemptTuple(state.qa);
      const expectedStatus = outcome.adapterResult.exitCode === 0 && !outcome.adapterResult.timedOut ? "succeeded" : "failed";
      const originalQaHeartbeat = state.automaticQaHeartbeat;
      const official = await harness.peer.select().from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.companyId, state.companyId), eq(workflowTransitionEvents.workflowRunId, state.runId),
        eq(workflowTransitionEvents.workflowStepRunId, state.qa.id), eq(workflowTransitionEvents.issueId, state.qaIssue.id),
        eq(workflowTransitionEvents.eventType, "workflow_validation_verdict")));
      const release = state.automaticQaDrainIdentity
        ? await readTerminalReleaseManifestForSource(harness.peer, state.automaticQaDrainIdentity, state.verifierId)
        : { kind: "absent" as const };
      if (state.adapterEntries.automaticQa !== 1 || official.length !== 1 || !heartbeat || !heartbeat.finishedAt
        || heartbeat.status !== expectedStatus || !resultJson
        || !isDeepStrictEqual(heartbeat.resultJson, outcome.adapterResult.resultJson)
        || !originalQaHeartbeat || heartbeat.createdAt.getTime() !== originalQaHeartbeat.createdAt.getTime()
        || heartbeat.executionScopeKind !== originalQaHeartbeat.executionScopeKind
        || heartbeat.executionEpoch !== originalQaHeartbeat.executionEpoch
        || heartbeat.executionToken !== originalQaHeartbeat.executionToken
        || heartbeat.executorOwnerId !== originalQaHeartbeat.executorOwnerId
        || heartbeat.executorOwnerLeaseEpoch !== originalQaHeartbeat.executorOwnerLeaseEpoch
        || heartbeat.executorOwnerLeaseToken !== originalQaHeartbeat.executorOwnerLeaseToken
        || heartbeat.retryOfRunId !== originalQaHeartbeat.retryOfRunId
        || heartbeat.processLossRetryCount !== originalQaHeartbeat.processLossRetryCount
        || heartbeat.sessionIdAfter !== originalQaHeartbeat.sessionIdAfter
        || heartbeat.exitCode !== outcome.adapterResult.exitCode || heartbeat.signal !== outcome.adapterResult.signal
        || !isDeepStrictEqual(heartbeat.usageJson, outcome.adapterResult.usage)
        || !wakeup || wakeup.id !== state.automaticQaWakeupRequestId || !proof
        || !sameStoredAttemptProof(proof, expectedAttempt) || proof.companyId !== state.companyId
        || proof.agentId !== state.verifierId || proof.missionId !== state.missionId || proof.workflowRunId !== state.runId
        || proof.wakeupRequestId !== wakeup.id || !issue || issue.id !== state.qaIssue.id
        || issue.companyId !== state.companyId || issue.missionId !== state.missionId || !step
        || step.stepId !== expectedAttempt.stepId || !sameAttempt(attemptTuple(step), expectedAttempt)
        || step.executionGeneration !== expectedAttempt.executionGeneration || step.retryCount !== expectedAttempt.retryCount
        || step.iterationIndex !== expectedAttempt.iterationIndex || release.kind !== "found") {
        throw new Error(`original QA actual/result/owner/attempt was not preserved through completion for ${state.qa.id}`);
      }
    }
    return outcomes;
  })();
  return { waitForAllCommitReturns, restore, releaseAll, barrierSnapshot, finish } satisfies AdmissionQaCompletionControl;
}

function admissionDrainRows(db: Db, identity: HeartbeatActualDrainIdentity) {
  return db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, identity.companyId), eq(workflowTransitionEvents.missionId, identity.missionId),
    eq(workflowTransitionEvents.workflowRunId, identity.workflowRunId), eq(workflowTransitionEvents.workflowStepRunId, identity.workflowStepRunId),
    eq(workflowTransitionEvents.issueId, identity.issueId), eq(workflowTransitionEvents.heartbeatRunId, identity.heartbeatRunId),
    eq(workflowTransitionEvents.dispatchOwnerHeartbeatRunId, identity.heartbeatRunId),
    eq(workflowTransitionEvents.executionGeneration, identity.executionGeneration),
    eq(workflowTransitionEvents.executorOwnerId, identity.executorOwnerId),
    eq(workflowTransitionEvents.eventType, "heartbeat_actual_drained_v1")));
}

async function waitForAdmissionProducerDrain(db: Db, identity: HeartbeatActualDrainIdentity) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const rows = await admissionDrainRows(db, identity);
    if (rows.length === 1) return rows[0]!;
    if (rows.length > 1) throw new Error(`producer actual ${identity.heartbeatRunId} has ${rows.length} drain records`);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error(`producer actual ${identity.heartbeatRunId} did not persist its exact drain record`);
}

async function waitForAdmissionProducerWorkflowFollowups(db: Db, identity: HeartbeatActualDrainIdentity, agentId: string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const read = await readTerminalReleaseManifestForSource(db, identity, agentId);
    if (read.kind === "held") throw new Error(`producer terminal-release manifest is held: ${read.reason}`);
    if (read.kind === "found") {
      const source = read.manifest.source;
      if (source.companyId !== identity.companyId || source.missionId !== identity.missionId
        || source.workflowRunId !== identity.workflowRunId || source.workflowStepRunId !== identity.workflowStepRunId
        || source.stepId !== identity.stepId || source.issueId !== identity.issueId
        || source.heartbeatRunId !== identity.heartbeatRunId || source.wakeupRequestId !== identity.wakeupRequestId
        || source.executionGeneration !== identity.executionGeneration || source.retryCount !== identity.retryCount
        || source.iterationIndex !== identity.iterationIndex || source.agentId !== agentId) {
        throw new Error(`producer terminal-release manifest is not joined to exact attempt ${identity.workflowStepRunId}`);
      }
      const acknowledgments = await Promise.all(read.manifest.obligations.map(obligation =>
        readTerminalReleaseAcknowledgment(db, read.eventId, obligation.effectKey)));
      const held = acknowledgments.find(result => result.kind === "held");
      if (held?.kind === "held") throw new Error(`producer terminal-release acknowledgment is held: ${held.reason}`);
      if (acknowledgments.every(result => result.kind === "acknowledged")) return read;
    }
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error(`producer terminal-release workflow followups were not all acknowledged for ${identity.workflowStepRunId}`);
}

async function assertAdmissionActualDrain(db: Db, unit: AdmissionUnit, preparation: QaRemediationPreparation) {
  const rows = await admissionDrainRows(db, unit.producerDrainIdentity);
  const evidence = rows[0]?.payload as AdmissionDrainEvidence | undefined;
  if (rows.length !== 1 || evidence?.schemaVersion !== "workflow.heartbeat-actual-drain.v1"
    || evidence.actual?.outcome !== "fulfilled"
    || evidence.cleanup?.runtimeServicesRelease?.succeeded !== true
    || evidence.cleanup?.heartbeatSettlement?.succeeded !== true
    || evidence.cleanup?.resources?.workspaceOperationsSettled !== true
    || evidence.cleanup?.resources?.runtimeServicesStopped !== true
    || evidence.cleanup?.resources?.missionRuntimeIdle !== true) {
    throw new Error("admission fixture did not persist one fulfilled heartbeat actual drain");
  }
  const [producer] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, unit.producer.id));
  if (!producer || (await readQaRemediationActualDrain(db, preparation, producer)).kind !== "proven") {
    throw new Error("admission fixture producer actual drain is not proven for its preparation");
  }
}

export async function waitForNativeOwnerBegin(records: readonly NativeOwnerRecord[], targets: readonly string[], occurrence: number) {
  const expected = [...targets];
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const matching = records.filter(record => record.targets.length === expected.length
      && record.targets.every((target, index) => target === expected[index]));
    if (matching.length >= occurrence) return matching[occurrence - 1]!;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error(`No native owner begin observed for ${JSON.stringify(expected)} occurrence ${occurrence}`);
}

export async function waitForNativeOwnerAcquired(record: NativeOwnerRecord) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (record.acquired) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error(`Native owner did not acquire ${JSON.stringify(record.targets)}`);
}

export async function waitForNativeOwnerLockWait(record: NativeOwnerRecord, target: string) {
  if (!record.nativeLockWaits) throw new Error("Native lock-wait tracing was not enabled for this owner");
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const wait = record.nativeLockWaits.find(event => event.target === target);
    if (wait) return wait;
    if (record.acquired) throw new Error(`Native owner acquired before reporting lock_wait for ${target}`);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error(`Native owner did not report its exact lock_wait for ${target}`);
}

export function dbRows<T>(result: unknown): T[] {
  const value = result as { rows?: T[] } | T[];
  return Array.isArray(value) ? value : value.rows ?? [];
}

export async function backendPid(tx: Db): Promise<number> {
  const result = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
  const row = dbRows<{ pid: number | string }>(result)[0];
  if (!row) throw new Error("PostgreSQL did not return the transaction backend PID");
  return Number(row.pid);
}

export async function waitForBlockedBy(db: Db, blockerPid: number, signal?: AbortSignal) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error(`Stopped observing PostgreSQL wait after its owner settled (blocker ${blockerPid})`);
    const result = await db.execute(sql`SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND ${blockerPid} = ANY(pg_blocking_pids(pid)) AND wait_event_type = 'Lock'`);
    const rows = dbRows<{ pid: number | string }>(result);
    const pids = [...new Set(rows.map(row => Number(row.pid)))];
    if (pids.length > 1 || rows.length !== pids.length) {
      throw new Error(`Multiple PostgreSQL candidates wait on blocker ${blockerPid}: ${JSON.stringify(rows)}`);
    }
    if (pids.length === 1) return pids[0]!;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error(`No PostgreSQL backend became lock-blocked by ${blockerPid}`);
}

export async function assertBlockedRootWaitingForMissionTransaction(db: Db, pid: number, blockerPid: number) {
  const activityResult = await db.execute(sql`SELECT pid, datname, current_database() AS observer_database,
    state, wait_event_type, wait_event, query,
    ${blockerPid} = ANY(pg_blocking_pids(pid)) AS blocked_by_expected
    FROM pg_stat_activity WHERE pid = ${pid} AND datname = current_database()`);
  const activities = dbRows<{ pid: number | string; datname: string; observer_database: string; state: string;
    wait_event_type: string | null; wait_event: string | null; query: string; blocked_by_expected: boolean }>(activityResult);
  const activity = activities[0];
  const blockerResult = await db.execute(sql`SELECT pid, datname, current_database() AS observer_database,
    backend_xid::text AS expected_blocking_transaction_id
    FROM pg_stat_activity WHERE pid = ${blockerPid} AND datname = current_database()`);
  const blockers = dbRows<{ pid: number | string; datname: string; observer_database: string;
    expected_blocking_transaction_id: string | null }>(blockerResult);
  const blocker = blockers[0];
  const expectedBlockingTransactionId = blocker?.expected_blocking_transaction_id ?? null;
  const queryText = activity?.query.toLowerCase().replaceAll('"', "").replace(/\s+/g, " ") ?? "";
  const exactMissionSelect = /^select\b/.test(queryText) && /\bfrom\s+(?:[a-z_][\w]*\.)?missions\b/.test(queryText)
    && /\bwhere\b/.test(queryText) && /\bid\s*=\s*\$\d+/.test(queryText)
    && /\bcompany_id\s*=\s*\$\d+/.test(queryText) && /\bfor update\b/.test(queryText);
  const waitLockResult = await db.execute(sql`SELECT waiting.transactionid::text AS transaction_id,
    waiting.mode AS waiting_mode, waiting.granted AS waiting_granted,
    blocker.backend_xid::text AS blocker_backend_xid, held.mode AS blocker_lock_mode, held.granted AS blocker_lock_granted
    FROM pg_locks AS waiting
    JOIN pg_stat_activity AS blocked ON blocked.pid = waiting.pid AND blocked.datname = current_database()
    JOIN pg_stat_activity AS blocker ON blocker.pid = ${blockerPid} AND blocker.datname = current_database()
    JOIN pg_locks AS held ON held.pid = blocker.pid AND held.locktype = 'transactionid'
      AND held.transactionid = waiting.transactionid AND held.granted = TRUE
    WHERE blocked.pid = ${pid} AND ${blockerPid} = ANY(pg_blocking_pids(blocked.pid))
      AND waiting.locktype = 'transactionid' AND waiting.mode = 'ShareLock' AND waiting.granted = FALSE
      AND blocker.backend_xid = waiting.transactionid`);
  const waitLocks = dbRows<{ transaction_id: string; waiting_mode: string; waiting_granted: boolean;
    blocker_backend_xid: string | null; blocker_lock_mode: string; blocker_lock_granted: boolean }>(waitLockResult);
  const tupleResult = await db.execute(sql`SELECT locktype, relation::regclass::text AS relation, page, tuple, mode, granted
    FROM pg_locks WHERE pid = ${pid} AND locktype = 'tuple'
      AND relation IN ('missions'::regclass, 'workflow_runs'::regclass)`);
  const tupleLockDiagnostics = dbRows<{ locktype: string; relation: string; page: number | null;
    tuple: number | null; mode: string; granted: boolean }>(tupleResult);
  if (activities.length !== 1 || !activity || Number(activity.pid) !== pid || activity.datname !== activity.observer_database
    || blockers.length !== 1 || !blocker || Number(blocker.pid) !== blockerPid || blocker.datname !== blocker.observer_database
    || !expectedBlockingTransactionId || activity.state !== "active"
    || activity.wait_event_type !== "Lock" || activity.wait_event !== "transactionid" || !activity.blocked_by_expected
    || !exactMissionSelect || waitLocks.length !== 1 || waitLocks[0]!.waiting_mode !== "ShareLock"
    || waitLocks[0]!.transaction_id !== expectedBlockingTransactionId
    || waitLocks[0]!.waiting_granted || waitLocks[0]!.blocker_backend_xid !== waitLocks[0]!.transaction_id
    || waitLocks[0]!.blocker_lock_mode !== "ExclusiveLock" || !waitLocks[0]!.blocker_lock_granted) {
    throw new Error(`public root ${pid} lacks the exact mission transaction-wait proof: ${JSON.stringify({
      activity, activities, blocker, expectedBlockingTransactionId, exactMissionSelect, waitLocks, tupleLockDiagnostics })}`);
  }
  return { pid, database: activity.datname, blockerPid, expectedBlockingTransactionId, state: activity.state,
    waitEventType: activity.wait_event_type, waitEvent: activity.wait_event, query: activity.query,
    transactionWait: waitLocks[0], tupleLockDiagnostics };
}

export async function waitForBackendGone(db: Db, pid: number) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const result = await db.execute(sql`SELECT pid FROM pg_stat_activity WHERE pid = ${pid}`);
    if (dbRows(result).length === 0) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error(`PostgreSQL backend ${pid} did not close after pg_terminate_backend`);
}

export async function waitForBackendQuery(db: Db, pid: number, fragment: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const result = await db.execute(sql`SELECT query FROM pg_stat_activity WHERE pid = ${pid} AND state = 'active'`);
    const query = dbRows<{ query: string }>(result)[0]?.query;
    if (query?.toLowerCase().includes(fragment.toLowerCase())) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error(`PostgreSQL backend ${pid} did not run ${fragment}`);
}

export async function beginMissionBlock(db: Db, companyId: string, missionId: string) {
  const locked = deferred<number>(), release = deferred<void>();
  const done = db.transaction(async tx => {
    const rows = await tx.select({ id: missions.id }).from(missions).where(and(
      eq(missions.id, missionId), eq(missions.companyId, companyId))).for("update");
    if (!rows.length) throw new Error("mission lock fixture disappeared");
    locked.resolve(await backendPid(tx as unknown as Db));
    await release.promise;
  });
  const pid = await locked.promise;
  return { pid, done, release: () => release.resolve() };
}

export async function observeNativeLockWait(runtime: QaFileOwnerRuntime, file: string) {
  const waiting = deferred<void>(), controller = new AbortController();
  const begin = runtime.begin([file], { signal: controller.signal, onEvent: event => {
    if (event.type === "lock_wait" && event.target === file) waiting.resolve();
  } });
  let waitFailure: unknown;
  try { await within(waiting.promise, `native lock wait for ${file}`); }
  catch (error) { waitFailure = error; }
  controller.abort();
  await begin.catch(() => undefined);
  if (waitFailure) throw waitFailure;
}

export async function createAdmissionHarness() {
  const owned = await createQaCorrectionTestDb();
  activeAdmissionDb = owned.db;
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "qa-remediation-admission-public-")));
  const lockRoot = path.join(root, "locks");
  await mkdir(lockRoot, { mode: 0o700 });
  await chmod(lockRoot, 0o700);
  return {
    db: owned.db,
    peer: owned.connect(),
    root,
    lockRoot: await realpath(lockRoot),
    close: async () => {
      try { await owned.close(); } finally {
        if (activeAdmissionDb === owned.db) activeAdmissionDb = undefined;
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}

function stepPair(suffix: string, authorId: string, verifierId: string) {
  const producerStepId = `produce-${suffix}`;
  const qaStepId = `qa-${suffix}`;
  return {
    producerStepId,
    qaStepId,
    steps: [
      { id: producerStepId, name: `Producer ${suffix}`, agentId: authorId, dependencies: [],
        conditionalDependencies: [{ stepId: qaStepId, when: "qa_request_changes", isBackEdge: true, maxIterations: 3 }] },
      { id: qaStepId, name: `QA ${suffix}`, type: "qa", agentId: verifierId, dependencies: [producerStepId] },
    ],
  };
}

function attemptTuple(step: typeof workflowStepRuns.$inferSelect) {
  if (!step.issueId || !Number.isSafeInteger(step.executionGeneration)
    || !Number.isSafeInteger(step.retryCount) || !Number.isSafeInteger(step.iterationIndex)) {
    throw new Error(`admission fixture attempt is incomplete for ${step.id}`);
  }
  return { stepRunId: step.id, stepId: step.stepId, issueId: step.issueId,
    executionGeneration: step.executionGeneration!, retryCount: step.retryCount!, iterationIndex: step.iterationIndex! };
}

function sameAttempt(a: ReturnType<typeof attemptTuple>, b: ReturnType<typeof attemptTuple>) {
  return a.stepRunId === b.stepRunId && a.stepId === b.stepId && a.issueId === b.issueId
    && a.executionGeneration === b.executionGeneration && a.retryCount === b.retryCount && a.iterationIndex === b.iterationIndex;
}

function sameStoredAttemptProof(proof: ReturnType<typeof readWorkflowAttemptProof>, attempt: ReturnType<typeof attemptTuple>) {
  return proof.stepRunId === attempt.stepRunId && proof.issueId === attempt.issueId
    && proof.executionGeneration === attempt.executionGeneration && proof.retryCount === attempt.retryCount
    && proof.iterationIndex === attempt.iterationIndex;
}

function admissionRemediations(state: AdmissionUnitState) {
  return { items: [{ op: "string_replace" as const, file: state.file, find: "before", replace: "after" }] };
}

async function classifyScenarioPreparations(db: Db, scenario: AdmissionScenarioState) {
  const rows = await db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, scenario.companyId), eq(workflowTransitionEvents.missionId, scenario.missionId),
    eq(workflowTransitionEvents.workflowRunId, scenario.runId),
    eq(workflowTransitionEvents.eventType, QA_REMEDIATION_PREPARATION_EVENT_TYPE)));
  const classified: Array<{ eventId: string; preparation: QaRemediationPreparation; state: AdmissionUnitState }> = [];
  for (const row of rows) {
    let preparation: QaRemediationPreparation;
    try { preparation = parseQaRemediationPreparation(row.payload); }
    catch (error) { throw new Error(`unassignable admission preparation ${row.id}: ${String(error)}`); }
    const state = scenario.units.find(candidate => sameAttempt(preparation.producer, attemptTuple(candidate.producer)));
    if (!state) throw new Error(`admission preparation ${row.id} has no known exact producer attempt`);
    if (!state.verdictEventId || !state.verdictHeartbeatId || !state.verdictRemediationsHash) {
      throw new Error(`admission preparation ${row.id} appeared before its known unit verdict was finalized`);
    }
    if (preparation.verdicts.length !== 1) throw new Error(`admission preparation ${row.id} has an unassignable verdict set`);
    const [verdict] = preparation.verdicts;
    const [official] = await db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.id, state.verdictEventId), eq(workflowTransitionEvents.companyId, state.companyId),
      eq(workflowTransitionEvents.missionId, state.missionId), eq(workflowTransitionEvents.workflowRunId, state.runId),
      eq(workflowTransitionEvents.workflowStepRunId, state.qa.id), eq(workflowTransitionEvents.issueId, state.qaIssue.id),
      eq(workflowTransitionEvents.heartbeatRunId, state.verdictHeartbeatId),
      eq(workflowTransitionEvents.eventType, "workflow_validation_verdict")));
    const payload = official?.payload as { remediations?: { items?: unknown[] } } | undefined;
    const items = payload?.remediations?.items;
    const remediationsHash = Array.isArray(items) ? hashQaCorrectionPayload(items) : null;
    if (!official || official.verdict !== "request_changes" || official.decision !== "request_changes"
      || official.reason !== "workflow_api" || !Array.isArray(items)
      || official.id !== verdict.eventId || official.heartbeatRunId !== verdict.heartbeatRunId
      || !sameAttempt(verdict.qa, attemptTuple(state.qa)) || remediationsHash !== verdict.remediationsHash
      || remediationsHash !== state.verdictRemediationsHash) {
      throw new Error(`admission preparation ${row.id} does not positively bind the known official QA verdict and full attempt`);
    }
    const scope: QaRemediationPreparationScope = {
      companyId: state.companyId, missionId: state.missionId, workflowRunId: state.runId,
      dispatchAuthorityVersion: scenario.dispatchAuthorityVersion, producer: attemptTuple(state.producer),
      verdicts: [{ eventId: state.verdictEventId, heartbeatRunId: state.verdictHeartbeatId,
        qa: attemptTuple(state.qa), remediationsHash: state.verdictRemediationsHash }],
    };
    const result = classifyQaRemediationPreparationRow(row as QaRemediationEventRow, scope);
    if (result.kind !== "prepared") {
      throw new Error(`admission preparation ${row.id} failed exact envelope/attempt classification: ${JSON.stringify(result)}`);
    }
    classified.push({ eventId: result.eventId, preparation: result.preparation, state });
  }
  return classified;
}

async function assertNoAutomaticQaPreparation(db: Db, state: AdmissionUnitState) {
  const classified = await classifyScenarioPreparations(db, state.scenario);
  const automaticQa = attemptTuple(state.qa);
  const matching = classified.filter(({ preparation }) => preparation.verdicts.some(verdict => sameAttempt(verdict.qa, automaticQa)));
  if (matching.length) {
    throw new Error(`automatic QA ${automaticQa.stepRunId}/${automaticQa.issueId}/${automaticQa.executionGeneration}/${automaticQa.retryCount}/${automaticQa.iterationIndex} has preparation ${matching.map(row => row.eventId).join(",")}`);
  }
  return classified.map(row => row.eventId).sort();
}

async function assertScenarioRunActive(db: Db, scenario: AdmissionScenarioState) {
  const [run] = await db.select().from(workflowRuns).where(and(
    eq(workflowRuns.id, scenario.runId), eq(workflowRuns.companyId, scenario.companyId)));
  if (!run || ["completed", "failed", "cancelled"].includes(run.status)) {
    throw new Error(`admission setup terminalized workflow run ${scenario.runId}: ${run?.status ?? "missing"}`);
  }
}

function toAdmissionUnit(state: AdmissionUnitState): AdmissionUnit {
  if (!state.producerHeartbeatRunId || !state.producerWakeupRequestId || !state.producerHeartbeat
    || !state.producerWakeup || !state.producerProduct || !state.producerDrainIdentity
    || !state.automaticQaHeartbeatRunId || !state.automaticQaWakeupRequestId
    || !state.verdictEventId || !state.verdictHeartbeatId || !state.verdictRemediationsHash) {
    throw new Error(`admission unit ${state.producer.id} did not finish its actual and official-verdict setup`);
  }
  return {
    companyId: state.companyId, missionId: state.missionId, workflowId: state.workflowId, runId: state.runId,
    authorId: state.authorId, verifierId: state.verifierId, producer: state.producer, qa: state.qa, qaIssue: state.qaIssue,
    producerWakeupRequestId: state.producerWakeupRequestId, producerHeartbeatRunId: state.producerHeartbeatRunId,
    producerHeartbeat: state.producerHeartbeat, producerWakeup: state.producerWakeup, producerProduct: state.producerProduct,
    producerIssueId: state.producerIssueId, producerDrainIdentity: state.producerDrainIdentity,
    automaticQaHeartbeatRunId: state.automaticQaHeartbeatRunId, automaticQaWakeupRequestId: state.automaticQaWakeupRequestId,
    adapterEntries: state.adapterEntries, file: state.file, verdictEventId: state.verdictEventId,
    verdictHeartbeatId: state.verdictHeartbeatId, verdictRemediationsHash: state.verdictRemediationsHash,
    ...(state.preparation ? { preparationEventId: state.preparation.preparationId, preparation: state.preparation } : {}),
  };
}

function toAdmissionScenario(state: AdmissionScenarioState, qaCompletion: AdmissionQaCompletionControl): AdmissionScenario {
  if (!state.downstreamProgress) throw new Error(`admission scenario ${state.runId} lost its declared downstream progress step`);
  return { companyId: state.companyId, missionId: state.missionId, workflowId: state.workflowId,
    runId: state.runId, authorId: state.authorId, verifierId: state.verifierId,
    units: state.units.map(toAdmissionUnit), downstreamProgress: state.downstreamProgress, qaCompletion };
}

async function createAdmissionScenarioState(harness: AdmissionHarness, count: number): Promise<AdmissionScenarioState> {
  const companyId = randomUUID(), missionId = randomUUID(), workflowId = randomUUID(), runId = randomUUID();
  const authorId = randomUUID(), verifierId = randomUUID();
  await harness.db.insert(companies).values({ id: companyId, name: "Admission public fixture",
    issuePrefix: `AP${companyId.slice(0, 8)}`, workProductRoot: harness.root });
  await harness.db.insert(agents).values([
    { id: authorId, companyId, name: "Admission producer", status: "active", adapterType: "codex_local",
      adapterConfig: { cwd: harness.root, promptTemplate: "admission producer" },
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 2 } } },
    { id: verifierId, companyId, name: "Admission verifier", status: "active", adapterType: "codex_local",
      adapterConfig: { cwd: harness.root, promptTemplate: "admission QA" },
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 2 } } },
  ]);
  await harness.db.insert(missions).values({ id: missionId, companyId, title: "Admission public mission",
    ownerAgentId: authorId, status: "active" });
  await harness.db.insert(workflowDefinitions).values({ id: workflowId, companyId, missionId,
    name: "Admission public workflow", stepsJson: [] });
  await harness.db.insert(workflowRuns).values({ id: runId, companyId, missionId, workflowId,
    status: "running", triggeredBy: "test", dispatchAuthorityVersion: 1 });
  const scenario: AdmissionScenarioState = { companyId, missionId, workflowId, runId, authorId, verifierId,
    dispatchAuthorityVersion: 1, units: [] };
  for (let index = 0; index < count; index++) {
    const suffix = String.fromCharCode(65 + index);
    await createAdmissionUnit(harness, scenario, suffix);
  }
  if (scenario.units.length !== count || new Set(scenario.units.map(unit => unit.producer.id)).size !== count
    || new Set(scenario.units.map(unit => unit.qa.id)).size !== count
    || new Set(scenario.units.map(unit => unit.qaIssue.id)).size !== count) {
    throw new Error(`admission scenario registered ${scenario.units.length} units for ${count} unique producer/QA rows`);
  }
  const first = scenario.units[0];
  if (!first) throw new Error("admission scenario requires a producer and QA step before its downstream work");
  scenario.downstreamProgress = await addDownstreamProgressStep(harness, scenario, first.producer.stepId, first.qa.stepId);
  return scenario;
}

async function validateAdapterAttempt(context: AdapterExecutionContext, observation: AdmissionAdapterObservation,
  state: AdmissionUnitState, expected: typeof workflowStepRuns.$inferSelect) {
  const { heartbeat, wakeup, issue, step } = observation;
  if (!heartbeat || !wakeup || !issue || !step) throw new Error(`adapter entry ${context.runId} is missing persisted heartbeat/wake/issue/step joins`);
  const attempt = attemptTuple(expected);
  const proof = readWorkflowAttemptProof(wakeup);
  const expectedAgentId = expected.id === state.producer.id ? state.authorId : state.verifierId;
  if (context.agent.id !== expectedAgentId) {
    throw new Error(`adapter context agent differs from attempt ${attempt.stepRunId}`);
  }
  if (context.context.issueId !== attempt.issueId || heartbeat.id !== context.runId
    || heartbeat.companyId !== state.companyId || heartbeat.agentId !== context.agent.id
    || heartbeat.issueId !== attempt.issueId || heartbeat.workflowStepRunId !== attempt.stepRunId
    || heartbeat.workflowExecutionGeneration !== attempt.executionGeneration || heartbeat.wakeupRequestId !== wakeup.id
    || wakeup.companyId !== state.companyId || wakeup.agentId !== context.agent.id || wakeup.issueId !== attempt.issueId
    || wakeup.missionId !== state.missionId || wakeup.workflowRunId !== state.runId
    || wakeup.workflowStepRunId !== attempt.stepRunId || wakeup.workflowExecutionGeneration !== attempt.executionGeneration
    || wakeup.reason !== "workflow_step_runnable" || issue.companyId !== state.companyId
    || issue.missionId !== state.missionId || issue.id !== attempt.issueId
    || step.workflowRunId !== state.runId || step.id !== attempt.stepRunId || step.stepId !== attempt.stepId || step.issueId !== attempt.issueId
    || !sameAttempt(attemptTuple(step), attempt)
    || proof.companyId !== state.companyId || proof.agentId !== context.agent.id || proof.missionId !== state.missionId
    || proof.workflowRunId !== state.runId || proof.wakeupRequestId !== wakeup.id
    || !sameStoredAttemptProof(proof, attempt)) {
    throw new Error(`adapter entry ${context.runId} does not bind exact persisted attempt ${JSON.stringify(attempt)}`);
  }
  return { heartbeat, wakeup, proof };
}

async function provePreviouslyIssuedProducerWake(harness: AdmissionHarness, state: AdmissionUnitState) {
  const attempt = attemptTuple(state.producer);
  const [issue] = await harness.peer.select().from(issues).where(and(
    eq(issues.id, state.producerIssueId), eq(issues.companyId, state.companyId),
    eq(issues.missionId, state.missionId), eq(issues.originRunId, state.runId)));
  const wakes = await harness.peer.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, state.companyId), eq(agentWakeupRequests.agentId, state.authorId),
    eq(agentWakeupRequests.issueId, state.producerIssueId), eq(agentWakeupRequests.missionId, state.missionId),
    eq(agentWakeupRequests.workflowRunId, state.runId), eq(agentWakeupRequests.workflowStepRunId, state.producer.id),
    eq(agentWakeupRequests.workflowExecutionGeneration, attempt.executionGeneration),
    eq(agentWakeupRequests.reason, "workflow_step_runnable")));
  if (!issue || issue.assigneeAgentId !== state.authorId || wakes.length !== 1) {
    throw new Error(`unaccepted producer wake has no unique exact owner/attempt admission for ${attempt.stepRunId}: ${JSON.stringify({
      issueFound: Boolean(issue), issueAssigneeId: issue?.assigneeAgentId ?? null, issueOriginRunId: issue?.originRunId ?? null,
      wakeIds: wakes.map(row => row.id), attempt,
    })}`);
  }
  const wake = wakes[0]!;
  const payload = wake.payload as Record<string, unknown> | null;
  if (!payload || wake.requestKind !== "workflow_resume" || payload.mutation !== "workflow_resume"
    || payload.issueId !== state.producerIssueId || payload.missionId !== state.missionId
    || payload.workflowRunId !== state.runId || payload.workflowDefinitionId !== state.workflowId
    || payload.workflowStepRunId !== state.producer.id || payload.stepId !== state.producer.stepId) {
    throw new Error(`producer wake ${wake.id} does not satisfy the official workflow-resume payload contract for ${attempt.stepRunId}`);
  }
  let proof: ReturnType<typeof readWorkflowAttemptProof>;
  try { proof = readWorkflowAttemptProof(wake); }
  catch (error) { throw new Error(`previous producer wake ${wake.id} has no valid full-attempt proof for ${attempt.stepRunId}: ${String(error)}`); }
  const [proofStep] = await harness.peer.select().from(workflowStepRuns).where(and(
    eq(workflowStepRuns.id, proof.stepRunId), eq(workflowStepRuns.workflowRunId, state.runId),
    eq(workflowStepRuns.issueId, state.producerIssueId)));
  if (!proofStep || proofStep.stepId !== attempt.stepId || !sameAttempt(attemptTuple(proofStep), attempt)
    || proof.companyId !== state.companyId || proof.agentId !== state.authorId || proof.issueId !== state.producerIssueId
    || proof.missionId !== state.missionId || proof.workflowRunId !== state.runId || proof.stepRunId !== state.producer.id
    || proof.wakeupRequestId !== wake.id || !sameStoredAttemptProof(proof, attempt)) {
    throw new Error(`previous producer wake ${wake.id} does not prove the exact authorized attempt ${attempt.stepRunId}`);
  }
  const heartbeats = await harness.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, wake.id));
  if (heartbeats.length !== 1) throw new Error(`previous producer wake ${wake.id} has ${heartbeats.length} heartbeat bindings for ${attempt.stepRunId}`);
  const heartbeat = heartbeats[0]!;
  if (heartbeat.companyId !== state.companyId || heartbeat.agentId !== state.authorId
    || heartbeat.issueId !== state.producerIssueId || heartbeat.workflowStepRunId !== state.producer.id
    || heartbeat.workflowExecutionGeneration !== attempt.executionGeneration || heartbeat.wakeupRequestId !== wake.id
    || !sameStoredAttemptProof(proof, attempt)) {
    throw new Error(`previous producer wake ${wake.id} is not bound to its exact heartbeat/attempt ${attempt.stepRunId}`);
  }
  const heartbeatContext = heartbeat.contextSnapshot;
  const contextSnapshot = heartbeatContext !== null && typeof heartbeatContext === "object" && !Array.isArray(heartbeatContext)
    ? heartbeatContext as Record<string, unknown> : null;
  if (!contextSnapshot || wake.source !== "assignment" || wake.triggerDetail !== "system"
    || contextSnapshot.issueId !== state.producerIssueId || contextSnapshot.taskId !== state.producerIssueId
    || contextSnapshot.workflowRunId !== state.runId || contextSnapshot.workflowDefinitionId !== state.workflowId
    || contextSnapshot.workflowStepRunId !== state.producer.id || contextSnapshot.workflowStepId !== state.producer.stepId
    || contextSnapshot.stepId !== state.producer.stepId || contextSnapshot.source !== "workflow.resume"
    || contextSnapshot.wakeReason !== "workflow_step_runnable") {
    throw new Error(`producer wake ${wake.id} does not satisfy the official workflow-resume payload contract for ${attempt.stepRunId}`);
  }
  return { wake, heartbeat };
}

async function executeValidatedV2QaRefire(context: AdapterExecutionContext, observation: AdmissionAdapterObservation,
  state: AdmissionUnitState): Promise<AdapterExecutionResult> {
  const { wakeup } = await validateAdapterAttempt(context, observation, state, state.qa);
  const completionPointer = (wakeup.payload as Record<string, unknown> | null)?.qaRemediationCompletion;
  if (!completionPointer || typeof completionPointer !== "object" || Array.isArray(completionPointer)) {
    throw new Error(`QA refire ${context.runId} wake ${wakeup.id} has no stored completion pointer`);
  }
  const pointer = completionPointer as Record<string, unknown>;
  const preparationEventId = pointer.preparationEventId;
  const sourceVerdictEventId = pointer.sourceVerdictEventId;
  if (typeof preparationEventId !== "string" || !preparationEventId
    || typeof sourceVerdictEventId !== "string" || !sourceVerdictEventId
    || !state.verdictEventId || !state.verdictHeartbeatId) {
    throw new Error(`QA refire ${context.runId} wake ${wakeup.id} has an incomplete scenario-bound completion pointer`);
  }
  const classifiedPreparations = await classifyScenarioPreparations(activeAdmissionDb!, state.scenario);
  const sourcePreparations = classifiedPreparations.filter(candidate => candidate.state === state
    && candidate.preparation.verdicts.some(verdict => verdict.eventId === sourceVerdictEventId
      && verdict.heartbeatRunId === state.verdictHeartbeatId && verdict.qa.stepRunId === state.qa.id
      && verdict.qa.issueId === state.qaIssue.id));
  const exactPreparations = sourcePreparations.filter(candidate => candidate.eventId === preparationEventId
    && candidate.preparation.preparationId === preparationEventId);
  if (sourcePreparations.length !== 1 || exactPreparations.length !== 1) {
    throw new Error(`QA refire ${context.runId} wake ${wakeup.id} does not identify one committed scenario preparation/source verdict: ${JSON.stringify({
      preparationEventId, sourceVerdictEventId, sourcePreparationEventIds: sourcePreparations.map(row => row.eventId),
      exactPreparationEventIds: exactPreparations.map(row => row.eventId),
    })}`);
  }
  const preparation = exactPreparations[0]!.preparation;
  if (state.preparation && !isDeepStrictEqual(state.preparation, preparation)) {
    throw new Error(`QA refire ${context.runId} committed preparation differs from its prior scenario registration`);
  }
  state.preparation = preparation;
  const verdict = preparation.verdicts.find(row => row.eventId === state.verdictEventId && row.qa.stepRunId === state.qa.id);
  if (!verdict || verdict.eventId !== sourceVerdictEventId || verdict.qa.issueId !== state.qaIssue.id || wakeup.agentId !== state.verifierId
    || wakeup.idempotencyKey !== qaRemediationRefireV2WakeKey(preparation, state.qa.id, state.verdictEventId)) {
    throw new Error(`QA refire ${context.runId} does not bind its exact source verdict and intended verifier`);
  }
  const completionRows = await activeAdmissionDb!.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, state.companyId),
    eq(workflowTransitionEvents.eventType, "qa_remediation_completed"),
    eq(workflowTransitionEvents.idempotencyKey, qaRemediationCompletionKey(preparation))));
  if (completionRows.length !== 1) throw new Error(`QA refire ${context.runId} has no unique completion receipt`);
  const validated = await validateQaRemediationCompletionEvidence(activeAdmissionDb!, completionRows[0]!, preparation);
  if (!validated.ok) throw new Error(`QA refire ${context.runId} completion receipt rejected: ${validated.reason}`);
  const wakeReceipts = validated.completion.wakes.filter(row => row.kind === "v2_refire"
    && row.stepRunId === state.qa.id && row.sourceVerdictEventId === state.verdictEventId);
  if (wakeReceipts.length !== 1 || wakeReceipts[0]!.wakeupRequestId !== wakeup.id
    || wakeReceipts[0]!.idempotencyKey !== wakeup.idempotencyKey
    || wakeReceipts[0]!.issueId !== state.qaIssue.id || wakeReceipts[0]!.stepId !== state.qa.stepId
    || wakeReceipts[0]!.executionGeneration !== attemptTuple(state.qa).executionGeneration) {
    throw new Error(`QA refire ${context.runId} is not the exact wake in its validated receipt`);
  }
  const matchingWakes = await activeAdmissionDb!.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, state.companyId), eq(agentWakeupRequests.idempotencyKey, wakeup.idempotencyKey)));
  if (matchingWakes.length !== 1 || matchingWakes[0]!.id !== wakeup.id) {
    throw new Error(`QA refire ${context.runId} has ambiguous or duplicate durable wake identity`);
  }
  if (state.adapterEntries.v2RefireWakeIds.includes(wakeup.id)) {
    throw new Error(`QA refire wake ${wakeup.id} entered the fixture adapter more than once`);
  }
  state.adapterEntries.validatedV2Refires++;
  state.adapterEntries.v2RefireWakeIds.push(wakeup.id);
  return { exitCode: 0, signal: null, timedOut: false, usage: null, provider: "fixture", model: "fixture",
    resultJson: { stdout: "validated v2 QA refire; no additional QA verdict submitted", stderr: "" }, runtimeServices: [] };
}

async function createAdmissionUnit(harness: AdmissionHarness, scenario: AdmissionScenarioState, suffix: string,
  options: { addDefinition?: boolean; runId?: string; verifierId?: string; qaOwnerOverride?: AdmissionQaOwnerOverride } = {}): Promise<AdmissionUnitState> {
  const { db } = harness;
  const runId = options.runId ?? scenario.runId;
  const verifierId = options.verifierId ?? (scenario.units.length === 0 ? scenario.verifierId : randomUUID());
  const qaOwnerOverride = options.qaOwnerOverride;
  if (qaOwnerOverride && (qaOwnerOverride.companyId !== scenario.companyId || qaOwnerOverride.missionId !== scenario.missionId
    || qaOwnerOverride.targetRunId !== runId || qaOwnerOverride.targetIssueAssigneeAgentId !== verifierId)) {
    throw new Error(`replacement QA owner contract does not bind the exact pre-execution target ${runId}/${verifierId}`);
  }
  if (verifierId !== scenario.verifierId) {
    await db.insert(agents).values({ id: verifierId, companyId: scenario.companyId,
      name: `Admission verifier ${suffix}`, status: "active", adapterType: "codex_local",
      adapterConfig: { cwd: harness.root, promptTemplate: "admission QA" },
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 2 } } });
  }
  const { producerStepId, qaStepId, steps } = stepPair(suffix, scenario.authorId, verifierId);
  if (options.addDefinition !== false) {
    const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, scenario.workflowId));
    if (!definition) throw new Error("admission fixture workflow definition missing");
    await db.update(workflowDefinitions).set({ stepsJson: [
      ...(definition.stepsJson as Record<string, unknown>[]), ...steps,
    ] }).where(eq(workflowDefinitions.id, scenario.workflowId));
  }
  const producerIssueId = randomUUID(), qaIssueId = qaOwnerOverride?.targetQaIssueId ?? randomUUID();
  await db.insert(issues).values([
    { id: producerIssueId, companyId: scenario.companyId, missionId: scenario.missionId,
      title: `Producer ${suffix}`, status: "todo", assigneeAgentId: scenario.authorId, originKind: "workflow_execution", originRunId: runId },
    { id: qaIssueId, companyId: scenario.companyId, missionId: scenario.missionId,
      title: `QA ${suffix}`, status: "todo", assigneeAgentId: qaOwnerOverride?.targetIssueAssigneeAgentId ?? verifierId,
      originKind: "workflow_execution", originRunId: runId },
  ]);
  const [producer] = await db.insert(workflowStepRuns).values({ workflowRunId: runId, stepId: producerStepId,
    issueId: producerIssueId, status: "pending" }).returning();
  const [qa] = await db.insert(workflowStepRuns).values({
    ...(qaOwnerOverride ? { id: qaOwnerOverride.targetQaStepRunId } : {}), workflowRunId: runId, stepId: qaStepId,
    issueId: qaIssueId, status: "pending" }).returning();
  const [qaIssue] = await db.select().from(issues).where(eq(issues.id, qaIssueId));
  if (!producer || !qa || !qaIssue) throw new Error("admission fixture step/QA issue rows missing");
  const file = path.join(harness.root, "missions", scenario.missionId, "runs", runId, "steps", producerStepId, "report.md");
  const sessionId = `admission-${runId}-${suffix}`;
  const provider = `admission-provider-${runId}-${suffix}`;
  const model = `admission-model-${runId}-${suffix}`;
  const adapterEntries: AdmissionUnit["adapterEntries"] = { producer: 0, automaticQa: 0,
    validatedV2Refires: 0, v2RefireWakeIds: [] };
  const state: AdmissionUnitState = { scenario, companyId: scenario.companyId, missionId: scenario.missionId,
    workflowId: scenario.workflowId, runId, authorId: scenario.authorId, verifierId,
    producer, qa, qaIssue, ...(qaOwnerOverride ? { qaOwnerOverride } : {}), producerIssueId, file, adapterEntries, producerEntered: deferred<string>(),
    allowProduction: deferred<void>(), producerCompleted: deferred<string>(), releaseActual: deferred<void>(),
    automaticQaEntered: deferred<string>(), allowQaVerdict: deferred<void>(),
    automaticQaReturned: deferred<string>(), qaCompletionSettled: deferred<AdmissionQaCompletionResult>(), sessionId, provider, model,
    operationPhase: "registered",
    actualResult: { exitCode: 0, signal: null, timedOut: false,
      usage: { inputTokens: 90, cachedInputTokens: 30, outputTokens: 40 }, provider, model, costUsd: 0.25,
      resultJson: { stdout: `admission producer actual ${runId}/${suffix}`, stderr: "" }, sessionId, runtimeServices: [] } };
  scenario.units.push(state);
  const producerRegistration: AdmissionAdapterRegistration = { kind: "producer", state,
    execute: async (context, observation) => {
      state.adapterEntries.producer++;
      if (state.adapterEntries.producer !== 1) throw new Error(`duplicate admission producer adapter ${producerIssueId}`);
      const { heartbeat, wakeup } = await validateAdapterAttempt(context, observation, state, state.producer);
      state.producerHeartbeatRunId = heartbeat.id;
      state.producerWakeupRequestId = wakeup.id;
      state.producerEntered.resolve(context.runId);
      await state.allowProduction.promise;
      await context.onSessionUpdate?.({ sessionId, sessionDisplayId: sessionId });
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, beforeText, "utf8");
      const [issue] = await db.select().from(issues).where(eq(issues.id, producerIssueId));
      if (!issue) throw new Error("admission producer issue disappeared");
      const actor = { actorType: "agent" as const, actorId: scenario.authorId, agentId: scenario.authorId, runId: context.runId };
      await registerWorkflowArtifact({ db, issue, actor, data: { path: file, type: "document", isPrimary: true } });
      if (!(await registeredProducer(db, scenario.companyId, producerIssueId, context.runId))) {
        throw new Error("admission registered producer proof missing");
      }
      await completeWorkflowIssue({ db, issue, actor, data: {} });
      state.producerCompleted.resolve(context.runId);
      await state.releaseActual.promise;
      return state.actualResult;
    } };
  const qaRegistration: AdmissionAdapterRegistration = { kind: "qa", state,
    execute: async (context, observation) => {
      const wakeup = observation.wakeup;
      const v2Candidate = wakeup?.idempotencyKey?.startsWith("qa-remediation-refire-v2:")
        || Object.hasOwn((wakeup?.payload ?? {}) as Record<string, unknown>, "qaRemediationCompletion");
      if (v2Candidate) return executeValidatedV2QaRefire(context, observation, state);
      state.adapterEntries.automaticQa++;
      if (state.adapterEntries.automaticQa !== 1) throw new Error(`duplicate automatic QA adapter ${qaIssueId}`);
      const { heartbeat, wakeup: initialWakeup } = await validateAdapterAttempt(context, observation, state, state.qa);
      const issue = observation.issue;
      if (!issue || issue.id !== state.qaIssue.id || issue.companyId !== state.companyId
        || issue.missionId !== state.missionId) {
        throw new Error(`automatic QA ${qaIssueId} lost its exact persisted issue row`);
      }
      if (state.verdictEventId || state.preparation) throw new Error(`automatic QA ${qaIssueId} entered after deliberate verdict/preparation`);
      const prepIdsBefore = await assertNoAutomaticQaPreparation(db, state);
      const existingVerdicts = await db.select().from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.companyId, state.companyId), eq(workflowTransitionEvents.workflowRunId, state.runId),
        eq(workflowTransitionEvents.workflowStepRunId, state.qa.id), eq(workflowTransitionEvents.issueId, state.qaIssue.id),
        eq(workflowTransitionEvents.eventType, "workflow_validation_verdict")));
      if (existingVerdicts.length) throw new Error(`automatic QA ${qaIssueId} has a pre-existing official verdict`);
      state.automaticQaHeartbeatRunId = heartbeat.id;
      state.automaticQaWakeupRequestId = initialWakeup.id;
      state.automaticQaHeartbeat = heartbeat;
      state.automaticQaWakeup = initialWakeup;
      if (JSON.stringify(await assertNoAutomaticQaPreparation(db, state)) !== JSON.stringify(prepIdsBefore)) {
        throw new Error(`automatic QA ${qaIssueId} preparation identities changed during its actual`);
      }
      const drainIdentity = await freezeHeartbeatActualDrainIdentity(harness.peer, heartbeat, { workflowRunId: state.runId });
      if (!drainIdentity) throw new Error(`automatic QA actual drain identity could not be frozen for ${state.qa.id}`);
      state.automaticQaDrainIdentity = drainIdentity;
      const remediations = admissionRemediations(state);
      try {
        state.operationPhase = "waiting_for_official_verdict_release";
        state.automaticQaEntered.resolve(context.runId);
        await state.allowQaVerdict.promise;
        state.operationPhase = "recording_official_verdict";
        await recordWorkflowValidationVerdict({ db, issue, source: "workflow_api", verdict: "request_changes",
          heartbeatRunId: heartbeat.id, remediations });
        const [verdict] = await harness.peer.select().from(workflowTransitionEvents).where(and(
          eq(workflowTransitionEvents.companyId, state.companyId), eq(workflowTransitionEvents.missionId, state.missionId),
          eq(workflowTransitionEvents.workflowRunId, state.runId), eq(workflowTransitionEvents.workflowStepRunId, state.qa.id),
          eq(workflowTransitionEvents.issueId, state.qaIssue.id), eq(workflowTransitionEvents.heartbeatRunId, heartbeat.id),
          eq(workflowTransitionEvents.eventType, "workflow_validation_verdict")));
        const payload = verdict?.payload as { remediations?: { items?: unknown[] } } | undefined;
        const items = payload?.remediations?.items;
        if (!verdict || verdict.verdict !== "request_changes" || verdict.decision !== "request_changes"
          || verdict.reason !== "workflow_api" || !Array.isArray(items)) {
          throw new Error(`real automatic QA verdict missing or not bound to heartbeat ${heartbeat.id}`);
        }
        state.verdictEventId = verdict.id;
        state.verdictHeartbeatId = heartbeat.id;
        state.verdictRemediationsHash = hashQaCorrectionPayload(items);
        state.automaticQaReturned.resolve(context.runId);
        const actor = { actorType: "agent" as const, actorId: context.agent.id, agentId: context.agent.id, runId: context.runId };
        const returnedIssue = await completeWorkflowIssue({ db, issue, actor, data: {} });
        const adapterResult: AdapterExecutionResult = { exitCode: 0, signal: null, timedOut: false, usage: null,
          provider: "fixture", model: "fixture",
          resultJson: { stdout: `admission automatic QA request_changes actual ${runId}/${suffix}`, stderr: "" }, runtimeServices: [] };
        state.qaIssue = returnedIssue;
        state.qaCompletionSettled.resolve({ kind: "completed", issue: returnedIssue, adapterResult });
        return adapterResult;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const adapterResult: AdapterExecutionResult = { exitCode: 1, signal: null, timedOut: false, usage: null,
          provider: "fixture", model: "fixture", errorCode: "ADMISSION_FIXTURE_QA_COMPLETION_FAILED",
          resultJson: { stdout: "", stderr: message }, runtimeServices: [] };
        state.qaCompletionSettled.resolve({ kind: "failed", error: message, adapterResult });
        return adapterResult;
      }
    } };
  for (const [issueId, registration] of [[producerIssueId, producerRegistration], [qaIssueId, qaRegistration]] as const) {
    if (admissionAdapterHandlers.has(issueId)) throw new Error(`duplicate admission fixture handler registration ${issueId}`);
    admissionAdapterHandlers.set(issueId, registration);
    registeredAdmissionIssueIds.add(issueId);
  }
  return state;
}

async function runAdmissionUnitsActuals(harness: AdmissionHarness, units: readonly AdmissionUnitState[],
  qaCompletion: AdmissionQaCompletionControl, replacement?: {
    readonly observer: ReplacementAdmissionObserver; readonly sourceRunId: string; readonly targetRunId: string;
  }) {
  if (!units.length) return;
  const lifecycleCheckpoints: ReplacementLifecycleCheckpoint[] = [];
  let currentAwaitLabel = "pre_execution_qa_owner_preflight";
  const awaitLifecycle = <T>(state: AdmissionUnitState, awaitName: string, wait: () => Promise<T>): Promise<T> => {
    if (!replacement) return wait();
    const emit = (phase: ReplacementLifecycleCheckpoint["phase"], error?: unknown) => {
      currentAwaitLabel = `${awaitName}:${phase}`;
      const checkpoint: ReplacementLifecycleCheckpoint = {
        eventType: "replacement_lifecycle_checkpoint", awaitName, phase, observedAt: new Date().toISOString(),
        sourceRunId: replacement.sourceRunId, targetRunId: replacement.targetRunId,
        companyId: state.companyId, missionId: state.missionId, workflowId: state.workflowId, runId: state.runId,
        producerStepRunId: state.producer.id, producerIssueId: state.producerIssueId,
        producerAttempt: attemptTuple(state.producer), qaStepRunId: state.qa.id, qaIssueId: state.qaIssue.id,
        qaAttempt: attemptTuple(state.qa),
        ...(error === undefined ? {} : { error: { name: error instanceof Error ? error.name : "Error",
          message: (error instanceof Error ? error.message : String(error)).slice(0, 400) } }),
      };
      if (lifecycleCheckpoints.length < 64) lifecycleCheckpoints.push(checkpoint);
      replacement.observer.onCheckpoint(checkpoint);
    };
    emit("enter");
    try { return wait().then(result => { emit("complete"); return result; }, error => { emit("error", error); throw error; }); }
    catch (error) { emit("error", error); return Promise.reject(error); }
  };
  for (const state of units) {
    const [issue] = await harness.peer.select().from(issues).where(and(
      eq(issues.id, state.qaIssue.id), eq(issues.companyId, state.companyId), eq(issues.missionId, state.missionId)));
    const [definition] = await harness.peer.select().from(workflowDefinitions).where(and(
      eq(workflowDefinitions.id, state.workflowId), eq(workflowDefinitions.companyId, state.companyId)));
    const qaDefinition = definition && normalizeWorkflowStepsForExecution(definition.stepsJson)
      .find(step => step.id === state.qa.stepId);
    const handler = admissionAdapterHandlers.get(state.qaIssue.id);
    const ownerOverride = state.qaOwnerOverride;
    const sourceState = ownerOverride && units.find(candidate => candidate.runId === ownerOverride.sourceRunId
      && candidate.qa.id === ownerOverride.sourceQaStepRunId && candidate.qaIssue.id === ownerOverride.sourceQaIssueId);
    const exactOwner = ownerOverride
      ? !!sourceState && ownerOverride.companyId === state.companyId && ownerOverride.missionId === state.missionId
        && ownerOverride.targetRunId === state.runId && ownerOverride.targetQaStepRunId === state.qa.id
        && ownerOverride.targetQaIssueId === state.qaIssue.id
        && ownerOverride.definitionVerifierId === qaDefinition?.agentId
        && ownerOverride.targetIssueAssigneeAgentId === issue?.assigneeAgentId
        && ownerOverride.targetIssueAssigneeAgentId === state.qaIssue.assigneeAgentId
        && ownerOverride.targetIssueAssigneeAgentId === state.verifierId
        && ownerOverride.sourceVerifierId === ownerOverride.definitionVerifierId
        && ownerOverride.sourceVerifierId !== state.verifierId
        && ownerOverride.sourceRunId !== state.runId && sourceState.workflowId === state.workflowId
        && sourceState.companyId === state.companyId && sourceState.missionId === state.missionId
        && sourceState.verifierId === ownerOverride.sourceVerifierId
      : issue?.assigneeAgentId === state.verifierId && state.qaIssue.assigneeAgentId === state.verifierId
        && qaDefinition?.agentId === state.verifierId;
    if (!issue || !qaDefinition || !exactOwner
      || handler?.kind !== "qa" || handler.state !== state || handler.state.verifierId !== state.verifierId) {
      throw new Error(`QA identity mismatch before admission units start ${state.qa.id}: ${JSON.stringify({
        verifierId: state.verifierId, issueAssigneeAgentId: issue?.assigneeAgentId ?? null,
        issueSnapshotAssigneeAgentId: state.qaIssue.assigneeAgentId,
        definitionQaAgentId: qaDefinition?.agentId ?? null, handlerKind: handler?.kind ?? null,
        handlerVerifierId: handler?.state?.verifierId ?? null, ownerOverride: ownerOverride ?? null,
      })}`);
    }
  }
  const scenarios = [...new Set(units.map(state => state.scenario))];
  const beforePreparationIds = new Map<AdmissionScenarioState, string[]>();
  for (const scenario of scenarios) {
    const classified = await classifyScenarioPreparations(harness.peer, scenario);
    beforePreparationIds.set(scenario, classified.map(row => row.eventId).sort());
  }
  let setupComplete = false;
  let replacementSetupFailed = false, replacementPrimaryError: unknown;
  const replacementCleanupErrors: unknown[] = [];
  let replacementSnapshot: unknown, replacementSnapshotError: unknown;
  try {
    for (const state of units) {
      const beforeVerdicts = await harness.peer.select().from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.companyId, state.companyId), eq(workflowTransitionEvents.workflowRunId, state.runId),
        eq(workflowTransitionEvents.workflowStepRunId, state.qa.id), eq(workflowTransitionEvents.issueId, state.qaIssue.id),
        eq(workflowTransitionEvents.eventType, "workflow_validation_verdict")));
      if (beforeVerdicts.length || (await assertNoAutomaticQaPreparation(harness.peer, state)).length) {
        throw new Error(`admission actual started after an official QA verdict or preparation for ${state.qa.id}`);
      }
      let requestedWakeId: string | undefined;
      if (state.producerHeartbeatRunId || state.producerWakeupRequestId) {
        if (!state.producerHeartbeatRunId || !state.producerWakeupRequestId) {
          throw new Error(`producer ${state.producer.id} has a partial pre-existing heartbeat/wake identity`);
        }
        const existing = await provePreviouslyIssuedProducerWake(harness, state);
        if (existing.heartbeat.id !== state.producerHeartbeatRunId || existing.wake.id !== state.producerWakeupRequestId) {
          throw new Error(`producer ${state.producer.id} pre-existing identity differs from its durable heartbeat/wake proof`);
        }
        requestedWakeId = existing.heartbeat.id;
      } else {
        state.operationPhase = "public_workflow_resume";
        const [run] = await harness.peer.select().from(workflowRuns).where(and(
          eq(workflowRuns.id, state.runId), eq(workflowRuns.companyId, state.companyId),
          eq(workflowRuns.missionId, state.missionId), eq(workflowRuns.workflowId, state.workflowId)));
        const [definition] = await harness.peer.select().from(workflowDefinitions).where(and(
          eq(workflowDefinitions.id, state.workflowId), eq(workflowDefinitions.companyId, state.companyId)));
        const step = definition && normalizeWorkflowStepsForExecution(definition.stepsJson)
          .find(candidate => candidate.id === state.producer.stepId);
        if (!run || !definition || !step || step.agentId !== state.authorId) {
          throw new Error(`producer ${state.producer.id} lacks its exact current workflow run/definition/owner`);
        }
        const accepted = await wakeExistingWorkflowStepIssue({ db: harness.db, run, definition, step,
          stepRunId: state.producer.id, stepRunMetadata: state.producer.metadata, issueId: state.producerIssueId });
        if (!accepted) {
          requestedWakeId = await within(state.producerEntered.promise,
            `existing official workflow-resume adapter entry after public admission declined ${state.producer.id}`);
        }
      }
      state.operationPhase = "producer_entry";
      const heartbeatId = await awaitLifecycle(state, "producer_entry",
        () => within(state.producerEntered.promise, `real admission producer adapter entry ${state.producer.id}`));
      if (requestedWakeId && requestedWakeId !== heartbeatId) throw new Error("admission producer wake changed heartbeat identity");
      if (state.producerHeartbeatRunId !== heartbeatId || !state.producerWakeupRequestId) {
        throw new Error(`admission producer adapter entry ${heartbeatId} did not preserve its original wake identity`);
      }
      const persisted = await provePreviouslyIssuedProducerWake(harness, state);
      if (persisted.heartbeat.id !== heartbeatId || persisted.wake.id !== state.producerWakeupRequestId) {
        throw new Error(`admission producer entry ${heartbeatId} lost its exact durable wake/heartbeat binding`);
      }
      state.producerHeartbeat = persisted.heartbeat;
      state.producerWakeup = persisted.wake;
      state.producerDrainIdentity = await freezeHeartbeatActualDrainIdentity(harness.peer, persisted.heartbeat,
        { workflowRunId: state.runId }) ?? undefined;
      if (!state.producerDrainIdentity) throw new Error("admission producer actual drain identity could not be frozen");
      state.operationPhase = "producer_completion";
      state.allowProduction.resolve();
      const completedHeartbeatId = await awaitLifecycle(state, "official_producer_completion",
        () => within(state.producerCompleted.promise, `official admission producer completion ${state.producer.id}`));
      if (completedHeartbeatId !== state.producerHeartbeatRunId) throw new Error("admission producer completion changed heartbeat identity");
      state.operationPhase = "qa_entry_before_verdict";
      const qaHeartbeatId = await awaitLifecycle(state, "original_qa_entry",
        () => within(state.automaticQaEntered.promise, `real automatic QA entry before verdict ${state.qa.id}`));
      if (qaHeartbeatId !== state.automaticQaHeartbeatRunId) throw new Error("automatic QA actual changed heartbeat identity before verdict");
      const heldVerdicts = await harness.peer.select().from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.companyId, state.companyId), eq(workflowTransitionEvents.workflowRunId, state.runId),
        eq(workflowTransitionEvents.workflowStepRunId, state.qa.id), eq(workflowTransitionEvents.issueId, state.qaIssue.id),
        eq(workflowTransitionEvents.eventType, "workflow_validation_verdict")));
      if (heldVerdicts.length || (await assertNoAutomaticQaPreparation(harness.peer, state)).length) {
        throw new Error(`automatic QA ${state.qa.id} was not held before official verdict/preparation`);
      }

      state.operationPhase = "producer_actual_drain";
      state.releaseActual.resolve();
      await awaitLifecycle(state, "exact_producer_drain",
        () => waitForAdmissionProducerDrain(harness.peer, state.producerDrainIdentity!));
      state.operationPhase = "producer_workflow_followup_acknowledgments";
      await awaitLifecycle(state, "producer_obligation_acknowledgments",
        () => waitForAdmissionProducerWorkflowFollowups(harness.peer, state.producerDrainIdentity!, state.authorId));

      const heartbeatIdAfterDrain = state.producerHeartbeatRunId;
      const [producerHeartbeat] = await harness.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, heartbeatIdAfterDrain));
      const [producerWakeup] = await harness.peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, state.producerWakeupRequestId));
      const [producerProduct] = await harness.peer.select().from(issueWorkProducts).where(and(
        eq(issueWorkProducts.issueId, state.producerIssueId), eq(issueWorkProducts.createdByRunId, heartbeatIdAfterDrain)));
      const [automaticQaHeartbeat] = await harness.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, state.automaticQaHeartbeatRunId!));
      const [automaticQaWakeup] = await harness.peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, state.automaticQaWakeupRequestId!));
      const usage = producerHeartbeat?.usageJson as Record<string, unknown> | null | undefined;
      const producerUsageMatches = usage !== null && typeof usage === "object"
        && usage.inputTokens === 90 && usage.cachedInputTokens === 30 && usage.outputTokens === 40
        && usage.rawInputTokens === 90 && usage.rawCachedInputTokens === 30 && usage.rawOutputTokens === 40
        && usage.provider === state.provider && usage.model === state.model && usage.costUsd === 0.25
        && usage.persistedSessionId === state.sessionId;
      const proof = producerWakeup ? readWorkflowAttemptProof(producerWakeup) : null;
      const qaProof = automaticQaWakeup ? readWorkflowAttemptProof(automaticQaWakeup) : null;
      const producerAttempt = attemptTuple(state.producer);
      const qaAttempt = attemptTuple(state.qa);
      const [producerProofStep] = proof ? await harness.peer.select().from(workflowStepRuns).where(and(
        eq(workflowStepRuns.id, proof.stepRunId), eq(workflowStepRuns.workflowRunId, state.runId),
        eq(workflowStepRuns.issueId, state.producerIssueId))) : [];
      const [qaProofStep] = qaProof ? await harness.peer.select().from(workflowStepRuns).where(and(
        eq(workflowStepRuns.id, qaProof.stepRunId), eq(workflowStepRuns.workflowRunId, state.runId),
        eq(workflowStepRuns.issueId, state.qaIssue.id))) : [];
      const exactProducerWakes = await harness.peer.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, state.companyId), eq(agentWakeupRequests.agentId, state.authorId),
        eq(agentWakeupRequests.issueId, state.producerIssueId), eq(agentWakeupRequests.missionId, state.missionId),
        eq(agentWakeupRequests.workflowRunId, state.runId), eq(agentWakeupRequests.workflowStepRunId, state.producer.id),
        eq(agentWakeupRequests.workflowExecutionGeneration, producerAttempt.executionGeneration),
        eq(agentWakeupRequests.reason, "workflow_step_runnable")));
      const producerDrain = await admissionDrainRows(harness.peer, state.producerDrainIdentity);
      const producerDrainPayload = producerDrain[0]?.payload as AdmissionDrainEvidence | undefined;
      if (exactProducerWakes.length !== 1 || exactProducerWakes[0]!.id !== state.producerWakeupRequestId
        || state.adapterEntries.producer !== 1 || state.adapterEntries.automaticQa !== 1
        || state.adapterEntries.validatedV2Refires !== 0 || !producerWakeup || !producerProduct || !producerHeartbeat
        || state.producerDrainIdentity.heartbeatRunId !== heartbeatIdAfterDrain || proof?.wakeupRequestId !== producerWakeup.id
        || !sameStoredAttemptProof(proof!, producerAttempt) || !producerProofStep
        || producerProofStep.stepId !== producerAttempt.stepId || !sameAttempt(attemptTuple(producerProofStep), producerAttempt)
        || producerHeartbeat.status !== "succeeded" || !producerHeartbeat.finishedAt
        || producerHeartbeat.sessionIdAfter !== state.sessionId
        || producerHeartbeat.exitCode !== state.actualResult.exitCode || producerHeartbeat.signal !== state.actualResult.signal
        || !isDeepStrictEqual(producerHeartbeat.resultJson, state.actualResult.resultJson)
        || !producerUsageMatches
        || producerDrain.length !== 1 || producerDrainPayload?.schemaVersion !== "workflow.heartbeat-actual-drain.v1"
        || producerDrainPayload.actual?.outcome !== "fulfilled"
        || producerDrainPayload.cleanup?.runtimeServicesRelease?.succeeded !== true
        || producerDrainPayload.cleanup?.heartbeatSettlement?.succeeded !== true
        || producerDrainPayload.cleanup?.resources?.workspaceOperationsSettled !== true
        || producerDrainPayload.cleanup?.resources?.runtimeServicesStopped !== true
        || producerDrainPayload.cleanup?.resources?.missionRuntimeIdle !== true
        || !automaticQaHeartbeat || automaticQaHeartbeat.companyId !== state.companyId
        || automaticQaHeartbeat.agentId !== state.verifierId || automaticQaHeartbeat.issueId !== state.qaIssue.id
        || automaticQaHeartbeat.workflowStepRunId !== state.qa.id
        || automaticQaHeartbeat.workflowExecutionGeneration !== qaAttempt.executionGeneration
        || automaticQaHeartbeat.status !== "running" || automaticQaHeartbeat.finishedAt
        || !automaticQaWakeup || automaticQaWakeup.id !== state.automaticQaWakeupRequestId
        || !qaProof || qaProof.companyId !== state.companyId || qaProof.agentId !== state.verifierId
        || qaProof.missionId !== state.missionId || qaProof.workflowRunId !== state.runId
        || qaProof.wakeupRequestId !== automaticQaWakeup.id || !sameStoredAttemptProof(qaProof, qaAttempt)
        || !qaProofStep || qaProofStep.stepId !== qaAttempt.stepId || !sameAttempt(attemptTuple(qaProofStep), qaAttempt)) {
        throw new Error(`real producer/QA actual, attempt, wake, drain, or registered product was not preserved for ${state.producer.id}`);
      }
      state.producerHeartbeat = producerHeartbeat;
      state.producerWakeup = producerWakeup;
      state.producerProduct = producerProduct;
      state.producer = (await harness.peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, state.producer.id)))[0]!;
    }

    for (const state of units) {
      state.operationPhase = "qa_official_verdict_release";
      state.allowQaVerdict.resolve();
    }
    for (const state of units) {
      state.operationPhase = "qa_official_verdict";
      const qaHeartbeatId = await awaitLifecycle(state, "official_verdict",
        () => within(state.automaticQaReturned.promise, `real automatic QA verdict ${state.qa.id}`));
      if (qaHeartbeatId !== state.automaticQaHeartbeatRunId) throw new Error("automatic QA actual changed heartbeat identity");
      const verdictRows = await harness.peer.select().from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.companyId, state.companyId), eq(workflowTransitionEvents.missionId, state.missionId),
        eq(workflowTransitionEvents.workflowRunId, state.runId), eq(workflowTransitionEvents.workflowStepRunId, state.qa.id),
        eq(workflowTransitionEvents.issueId, state.qaIssue.id), eq(workflowTransitionEvents.eventType, "workflow_validation_verdict")));
      const [verdict] = verdictRows;
      const verdictPayload = verdict?.payload as { remediations?: { items?: unknown[] } } | undefined;
      if (verdictRows.length !== 1 || !verdict || verdict.id !== state.verdictEventId
        || verdict.heartbeatRunId !== state.automaticQaHeartbeatRunId || verdict.verdict !== "request_changes"
        || verdict.decision !== "request_changes" || verdict.reason !== "workflow_api"
        || !Array.isArray(verdictPayload?.remediations?.items)
        || hashQaCorrectionPayload(verdictPayload.remediations.items) !== state.verdictRemediationsHash
        || (await assertNoAutomaticQaPreparation(harness.peer, state)).length) {
        throw new Error(`real automatic QA verdict did not bind its actual or remained preparation-free for ${state.qa.id}`);
      }
    }
    for (const state of units) state.operationPhase = "qa_commit_return";
    const commitReturns = qaCompletion.waitForAllCommitReturns();
    await Promise.all(units.map(state => awaitLifecycle(state, "qa_commit_return", () => commitReturns)));
    qaCompletion.restore();
    for (const scenario of scenarios) {
      const after = (await classifyScenarioPreparations(harness.peer, scenario)).map(row => row.eventId).sort();
      if (JSON.stringify(after) !== JSON.stringify(beforePreparationIds.get(scenario))) {
        throw new Error(`admission preparation identities changed before public-root action for run ${scenario.runId}`);
      }
      await assertScenarioRunActive(harness.peer, scenario);
    }
    for (const state of units) {
      state.producer = (await harness.peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, state.producer.id)))[0]!;
      state.qa = (await harness.peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, state.qa.id)))[0]!;
      state.qaIssue = (await harness.peer.select().from(issues).where(eq(issues.id, state.qaIssue.id)))[0]!;
    }
    setupComplete = true;
  } catch (error) {
    if (!replacement) throw error;
    replacementSetupFailed = true;
    replacementPrimaryError = error;
    try { qaCompletion.restore(); } catch (cleanupError) { replacementCleanupErrors.push(cleanupError); }
    try { qaCompletion.releaseAll(); } catch (cleanupError) { replacementCleanupErrors.push(cleanupError); }
    for (const state of units) {
      try { state.allowProduction.resolve(); } catch (cleanupError) { replacementCleanupErrors.push(cleanupError); }
      try { state.releaseActual.resolve(); } catch (cleanupError) { replacementCleanupErrors.push(cleanupError); }
      try { state.allowQaVerdict.resolve(); } catch (cleanupError) { replacementCleanupErrors.push(cleanupError); }
    }
    process.stdout.write(`${JSON.stringify({ eventType: "replacement_actual_setup_primary_failure",
      callerAwaitLabel: currentAwaitLabel,
      error: error instanceof Error ? { name: error.name, message: error.message.slice(0, 600) }
        : { name: "Error", message: String(error).slice(0, 600) },
      lifecycleCheckpoints: lifecycleCheckpoints.slice(-16) })}\n`);
    try {
      replacementSnapshot = await captureReplacementAdmissionFailureSnapshot(harness, units, currentAwaitLabel, qaCompletion, {
        sourceRunId: replacement.sourceRunId, targetRunId: replacement.targetRunId,
        callerAwaitLabel: currentAwaitLabel, syncSettlement: { kind: "not_started" }, expectedBlockerPid: null,
        rootPid: null, nativeUnionRecord: null, lifecycleCheckpoints,
      });
      replacement.observer.onFailureSnapshot?.(replacementSnapshot);
    } catch (snapshotError) { replacementSnapshotError = snapshotError; }
  } finally {
    for (const state of units) {
      state.allowProduction.resolve();
      state.releaseActual.resolve();
      state.allowQaVerdict.resolve();
    }
    if (!setupComplete) {
      try { qaCompletion.restore(); } catch (cleanupError) { replacementCleanupErrors.push(cleanupError); }
      try { qaCompletion.releaseAll(); } catch (cleanupError) { replacementCleanupErrors.push(cleanupError); }
      if (!replacement) await waitForHeartbeatExecutionsToDrain(harness.db, 60_000);
    }
  }
  if (replacementSetupFailed) {
    const primary = replacementPrimaryError instanceof Error ? replacementPrimaryError.message : String(replacementPrimaryError);
    const cleanupErrors = replacementCleanupErrors.map(error => error instanceof Error ? error.message : String(error));
    const snapshotFailure = replacementSnapshotError instanceof Error ? replacementSnapshotError.message
      : replacementSnapshotError === undefined ? null : String(replacementSnapshotError);
    throw new Error(`${primary}\nReplacement setup failure captured before cleanup: ${JSON.stringify({
      callerAwaitLabel: currentAwaitLabel, snapshot: replacementSnapshot, snapshotFailure, cleanupErrors })}`,
    { cause: replacementPrimaryError });
  }
}

type ReplacementDiagnosticUnit = Pick<AdmissionUnit,
  "companyId" | "missionId" | "workflowId" | "runId" | "producer" | "qa" | "qaIssue" | "producerIssueId" | "verifierId">;
type ReplacementSyncSettlement = { readonly kind: "not_started" | "pending" }
  | { readonly kind: "fulfilled"; readonly outcome: unknown }
  | { readonly kind: "rejected"; readonly error: unknown };
type ReplacementFailureSnapshotDetails = {
  readonly sourceRunId?: string;
  readonly targetRunId?: string;
  readonly callerAwaitLabel?: string | null;
  readonly syncSettlement?: ReplacementSyncSettlement;
  readonly expectedBlockerPid?: number | null;
  readonly expectedBlockingTransactionId?: string | null;
  readonly rootPid?: number | null;
  readonly nativeUnionRecord?: NativeOwnerRecord | null;
  readonly lifecycleCheckpoints?: readonly ReplacementLifecycleCheckpoint[];
};

export async function captureReplacementAdmissionFailureSnapshot(harness: AdmissionHarness,
  units: readonly ReplacementDiagnosticUnit[], phase: string, qaCompletion: AdmissionQaCompletionControl,
  details?: ReplacementFailureSnapshotDetails) {
  const unitSnapshots = await Promise.all(units.map(async unit => {
    const state = unit.producer.issueId ? admissionAdapterHandlers.get(unit.producer.issueId)?.state : undefined;
    const stepRows = await Promise.all([unit.producer, unit.qa].map(step => harness.peer.select().from(workflowStepRuns)
      .where(and(eq(workflowStepRuns.id, step.id), eq(workflowStepRuns.workflowRunId, unit.runId), eq(workflowStepRuns.stepId, step.stepId)))));
    const issueRows = await Promise.all([unit.producerIssueId, unit.qaIssue.id].map(issueId => harness.peer.select().from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, unit.companyId), eq(issues.missionId, unit.missionId)))));
    const stepSnapshots = await Promise.all(stepRows.map(async (rows, index) => {
      const step = rows[0];
      const issue = issueRows[index]?.[0];
      const wakes = step ? await harness.peer.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, unit.companyId), eq(agentWakeupRequests.workflowRunId, unit.runId),
        eq(agentWakeupRequests.workflowStepRunId, step.id))) : [];
      const wakeSnapshots = await Promise.all(wakes.map(async wake => {
        const heartbeatRows = await harness.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, wake.id));
        const heartbeat = heartbeatRows.length === 1 ? heartbeatRows[0] : undefined;
        const exactHeartbeat = heartbeat && heartbeat.companyId === wake.companyId && heartbeat.agentId === wake.agentId
          && heartbeat.issueId === wake.issueId && heartbeat.workflowStepRunId === wake.workflowStepRunId
          && heartbeat.workflowExecutionGeneration === wake.workflowExecutionGeneration && heartbeat.wakeupRequestId === wake.id
          ? heartbeat : undefined;
        const heartbeatContext = exactHeartbeat?.contextSnapshot;
        const contextSnapshot = heartbeatContext !== null && typeof heartbeatContext === "object" && !Array.isArray(heartbeatContext)
          ? heartbeatContext as Record<string, unknown> : null;
        let proof: ReturnType<typeof readWorkflowAttemptProof> | null = null;
        try { proof = readWorkflowAttemptProof(wake); } catch { /* diagnostic only; preserve malformed authority as unknown */ }
        return { id: wake.id, requestKind: wake.requestKind, reason: wake.reason, status: wake.status,
          agentId: wake.agentId, issueId: wake.issueId, missionId: wake.missionId, workflowRunId: wake.workflowRunId,
          workflowStepRunId: wake.workflowStepRunId, workflowExecutionGeneration: wake.workflowExecutionGeneration,
          idempotencyKey: wake.idempotencyKey, createdAt: wake.createdAt,
          mutation: (wake.payload as Record<string, unknown> | null)?.mutation ?? null,
          contextSource: contextSnapshot?.source ?? null,
          attemptProof: proof ? { stepRunId: proof.stepRunId, issueId: proof.issueId,
            executionGeneration: proof.executionGeneration, retryCount: proof.retryCount, iterationIndex: proof.iterationIndex } : null,
          heartbeat: heartbeat ? { id: heartbeat.id, status: heartbeat.status, agentId: heartbeat.agentId,
            issueId: heartbeat.issueId, workflowStepRunId: heartbeat.workflowStepRunId,
            workflowExecutionGeneration: heartbeat.workflowExecutionGeneration, executionScopeKind: heartbeat.executionScopeKind,
            executionEpoch: heartbeat.executionEpoch, executorOwnerId: heartbeat.executorOwnerId,
            executorOwnerLeaseEpoch: heartbeat.executorOwnerLeaseEpoch, retryOfRunId: heartbeat.retryOfRunId,
            processLossRetryCount: heartbeat.processLossRetryCount, startedAt: heartbeat.startedAt, finishedAt: heartbeat.finishedAt } : null };
      }));
      return { step: step ? { id: step.id, stepId: step.stepId, issueId: step.issueId,
        attempt: { executionGeneration: step.executionGeneration, retryCount: step.retryCount,
          iterationIndex: step.iterationIndex }, status: step.status, lastDispatchRequestId: step.lastDispatchRequestId,
        startedAt: step.startedAt, completedAt: step.completedAt } : null,
        issue: issue ? { id: issue.id, assigneeAgentId: issue.assigneeAgentId, status: issue.status,
          originRunId: issue.originRunId } : null, wakes: wakeSnapshots };
    }));
    return { companyId: unit.companyId, missionId: unit.missionId, workflowId: unit.workflowId, runId: unit.runId,
      producerIssueId: unit.producerIssueId, qaIssueId: unit.qaIssue.id,
      verifierId: unit.verifierId, operationPhase: state?.operationPhase ?? "unknown", steps: stepSnapshots };
  }));
  const qaCommitBarriers = qaCompletion.barrierSnapshot();
  if (!details) return { phase, units: unitSnapshots, qaCommitBarriers };
  const runIds = [...new Set([...units.map(unit => unit.runId), details.sourceRunId, details.targetRunId]
    .filter((value): value is string => !!value))];
  const runs = await Promise.all(runIds.map(async runId => {
    const [run] = await harness.peer.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    return run ? { id: run.id, companyId: run.companyId, missionId: run.missionId, workflowId: run.workflowId,
      status: run.status, dispatchAuthorityVersion: run.dispatchAuthorityVersion, updatedAt: run.updatedAt } : null;
  }));
  const authorities = details.targetRunId ? await harness.peer.select().from(workflowRecoveryAuthorities)
    .where(eq(workflowRecoveryAuthorities.replacementRunId, details.targetRunId)) : [];
  const observedPids = [...new Set([details.rootPid, details.expectedBlockerPid]
    .filter((pid): pid is number => Number.isSafeInteger(pid) && Number(pid) > 0))];
  const scopedPostgres = await Promise.all(observedPids.map(async pid => {
    const activity = dbRows<Record<string, unknown>>(await harness.peer.execute(sql`SELECT pid, datname, state,
      wait_event_type, wait_event, query, backend_xid::text AS backend_xid FROM pg_stat_activity
      WHERE pid = ${pid} AND datname = current_database()`));
    const locks = dbRows<Record<string, unknown>>(await harness.peer.execute(sql`SELECT locktype,
      relation::regclass::text AS relation, page, tuple, mode, granted, transactionid::text AS transaction_id
      FROM pg_locks WHERE pid = ${pid}`));
    return { pid, activity, locks };
  }));
  const settlement = details.syncSettlement?.kind === "rejected"
    ? { kind: details.syncSettlement.kind, error: details.syncSettlement.error instanceof Error
      ? { name: details.syncSettlement.error.name, message: details.syncSettlement.error.message }
      : String(details.syncSettlement.error) }
    : details.syncSettlement;
  const nativeUnionRecord = details.nativeUnionRecord ? { targets: details.nativeUnionRecord.targets,
    beginSequence: details.nativeUnionRecord.beginSequence, acquired: details.nativeUnionRecord.acquired,
    acquiredSequence: details.nativeUnionRecord.acquiredSequence, exitSequence: details.nativeUnionRecord.exitSequence,
    exit: details.nativeUnionRecord.exit, nativeLockWaits: details.nativeUnionRecord.nativeLockWaits } : null;
  return { phase, callerAwaitLabel: details.callerAwaitLabel ?? null, syncSettlement: settlement,
    expectedBlockerPid: details.expectedBlockerPid ?? null,
    expectedBlockingTransactionId: details.expectedBlockingTransactionId ?? null, rootPid: details.rootPid ?? null,
    units: unitSnapshots, workflowRuns: runs, replacementAuthorities: authorities, scopedPostgres,
    nativeUnionRecord, lifecycleCheckpoints: details.lifecycleCheckpoints?.slice(-64) ?? [], qaCommitBarriers };
}

export async function createAdmissionScenario(harness: AdmissionHarness, options: { count?: number } = {}): Promise<AdmissionScenario> {
  const state = await createAdmissionScenarioState(harness, options.count ?? 1);
  const qaCompletion = createQaCompletionCommitReturnBarrier(harness, state.units);
  try {
    await runAdmissionUnitsActuals(harness, state.units, qaCompletion);
    return toAdmissionScenario(state, qaCompletion);
  } catch (error) {
    qaCompletion.restore();
    qaCompletion.releaseAll();
    await waitForHeartbeatExecutionsToDrain(harness.db, 60_000);
    throw error;
  }
}

export async function writeAdmissionPreparationInTransaction(tx: QaRemediationPreparationTransaction, unit: AdmissionUnit) {
  const request: QaRemediationPreparationRequest = { companyId: unit.companyId, missionId: unit.missionId,
    workflowRunId: unit.runId, producerStepRunId: unit.producer.id, qaStepRunIds: [unit.qa.id] };
  const candidate = await buildQaRemediationPreparationCandidate(tx, request);
  if (candidate.outcome !== "candidate") throw new Error(`production preparation candidate failed: ${candidate.outcome}`);
  const result = await writeQaRemediationPreparation(tx, candidate.preparation, candidate.scope);
  if (result.outcome !== "prepared") {
    throw new Error(`production preparation writer failed: ${result.outcome}`);
  }
  const registration = admissionAdapterHandlers.get(unit.qaIssue.id);
  if (!registration || registration.kind !== "qa" || registration.state?.qa.id !== unit.qa.id) {
    throw new Error(`preparation unit ${unit.qa.id} lost its exact QA adapter registration`);
  }
  const prepared = { ...unit, preparationEventId: result.preparationEventId, preparation: result.preparation };
  await assertAdmissionActualDrain(tx as unknown as Db, prepared, result.preparation);
  return prepared;
}

export async function prepareAdmissionUnit(harness: AdmissionHarness, unit: AdmissionUnit): Promise<AdmissionUnit> {
  const result = await prepareQaRemediationReservation(harness.db, { companyId: unit.companyId,
    missionId: unit.missionId, workflowRunId: unit.runId, producerStepRunId: unit.producer.id,
    qaStepRunIds: [unit.qa.id] });
  if (result.outcome !== "prepared") {
    throw new Error(`production preparation failed: ${result.outcome}${"reason" in result ? `/${result.reason}` : ""}`);
  }
  const registration = admissionAdapterHandlers.get(unit.qaIssue.id);
  if (!registration || registration.kind !== "qa") throw new Error(`preparation unit ${unit.qa.id} lost its QA adapter registration`);
  if (!registration.state) throw new Error(`preparation unit ${unit.qa.id} has no registered QA state`);
  registration.state.preparation = result.preparation;
  const prepared = { ...unit, preparationEventId: result.preparationEventId, preparation: result.preparation };
  await assertAdmissionActualDrain(harness.db, prepared, result.preparation);
  return prepared;
}

export async function assertAdmissionActualDrained(db: Db, unit: AdmissionUnit) {
  const rows = await admissionDrainRows(db, unit.producerDrainIdentity);
  const evidence = rows[0]?.payload as AdmissionDrainEvidence | undefined;
  const [heartbeat] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, unit.producerHeartbeatRunId));
  const [wakeup] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, unit.producerWakeupRequestId));
  const [product] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, unit.producerProduct.id));
  const proof = wakeup ? readWorkflowAttemptProof(wakeup) : null;
  const [proofStep] = proof ? await db.select().from(workflowStepRuns).where(and(
    eq(workflowStepRuns.id, proof.stepRunId), eq(workflowStepRuns.workflowRunId, unit.runId),
    eq(workflowStepRuns.issueId, unit.producerIssueId))) : [];
  if (rows.length !== 1 || evidence?.schemaVersion !== "workflow.heartbeat-actual-drain.v1"
    || evidence.actual?.outcome !== "fulfilled"
    || evidence.cleanup?.runtimeServicesRelease?.succeeded !== true
    || evidence.cleanup?.heartbeatSettlement?.succeeded !== true
    || evidence.cleanup?.resources?.workspaceOperationsSettled !== true
    || evidence.cleanup?.resources?.runtimeServicesStopped !== true
    || evidence.cleanup?.resources?.missionRuntimeIdle !== true
    || !heartbeat || heartbeat.id !== unit.producerHeartbeatRunId || heartbeat.companyId !== unit.companyId
    || heartbeat.agentId !== unit.authorId || heartbeat.issueId !== unit.producerIssueId
    || heartbeat.workflowStepRunId !== unit.producer.id || heartbeat.workflowExecutionGeneration !== unit.producer.executionGeneration
    || !wakeup || wakeup.id !== unit.producerWakeupRequestId || wakeup.companyId !== unit.companyId
    || wakeup.agentId !== unit.authorId || wakeup.workflowRunId !== unit.runId
    || wakeup.workflowStepRunId !== unit.producer.id || !proof || proof.wakeupRequestId !== wakeup.id
    || !sameStoredAttemptProof(proof, attemptTuple(unit.producer)) || !proofStep
    || proofStep.stepId !== unit.producer.stepId || !sameAttempt(attemptTuple(proofStep), attemptTuple(unit.producer))
    || !product || product.id !== unit.producerProduct.id || product.companyId !== unit.companyId
    || product.issueId !== unit.producerIssueId || product.createdByRunId !== unit.producerHeartbeatRunId) {
    throw new Error(`admission fixture producer actual/drain/wake/product identity is not exact for ${unit.producer.id}`);
  }
}

export async function waitForAdmissionDownstreamActual(db: Db, progress: AdmissionDownstreamProgress) {
  const deadline = Date.now() + 30_000;
  while (!progress.actual && Date.now() < deadline) {
    if (progress.adapterEntries > 1) throw new Error(`downstream ${progress.stepRun.id} entered more than once`);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  if (!progress.actual || progress.adapterEntries !== 1) {
    throw new Error(`downstream ${progress.stepRun.id} has no unique public-action adapter entry`);
  }
  let heartbeat: typeof heartbeatRuns.$inferSelect | undefined;
  while (Date.now() < deadline) {
    [heartbeat] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, progress.actual.heartbeatRunId));
    if (heartbeat?.finishedAt && heartbeat.status !== "running") break;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  const [wakeup] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, progress.actual.wakeupRequestId));
  const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, progress.stepRun.id));
  const proof = wakeup ? readWorkflowAttemptProof(wakeup) : null;
  const result = heartbeat?.resultJson as { stdout?: unknown; stderr?: unknown } | null;
  if (!heartbeat || !heartbeat.finishedAt || heartbeat.status !== "succeeded"
    || heartbeat.id !== progress.actual.heartbeatRunId || heartbeat.companyId !== progress.companyId
    || heartbeat.agentId !== progress.agentId || heartbeat.issueId !== progress.issueId
    || heartbeat.workflowStepRunId !== progress.stepRun.id || heartbeat.workflowExecutionGeneration !== progress.actual.attempt.executionGeneration
    || heartbeat.wakeupRequestId !== progress.actual.wakeupRequestId
    || !wakeup || wakeup.companyId !== progress.companyId || wakeup.agentId !== progress.agentId
    || wakeup.issueId !== progress.issueId || wakeup.missionId !== progress.missionId
    || wakeup.workflowRunId !== progress.runId || wakeup.workflowStepRunId !== progress.stepRun.id
    || wakeup.workflowExecutionGeneration !== progress.actual.attempt.executionGeneration
    || wakeup.reason !== "workflow_step_runnable" || !proof || proof.wakeupRequestId !== wakeup.id
    || proof.companyId !== progress.companyId || proof.agentId !== progress.agentId || proof.missionId !== progress.missionId
    || proof.workflowRunId !== progress.runId || !sameStoredAttemptProof(proof, progress.actual.attempt)
    || !step || step.workflowRunId !== progress.runId || step.stepId !== progress.stepRun.stepId
    || step.issueId !== progress.issueId || !sameAttempt(attemptTuple(step), progress.actual.attempt)
    || result?.stdout !== progress.actual.stdout || result?.stderr !== "") {
    throw new Error(`downstream ${progress.stepRun.id} did not preserve its exact joined successful actual`);
  }
  return { heartbeat, wakeup, step, proof, result };
}

export async function addStructuralRejection(harness: AdmissionHarness, unit: AdmissionUnit) {
  const gateStepId = `structural-${unit.qa.stepId}`;
  const [definition] = await harness.db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, unit.workflowId));
  if (!definition) throw new Error("structural fixture current workflow definition missing");
  const currentSteps = definition.stepsJson as Array<Record<string, unknown> & { id: string }>;
  const producerStep = currentSteps.find(step => step.id === unit.producer.stepId);
  const qaStep = currentSteps.find(step => step.id === unit.qa.stepId);
  const expectedBackEdge = { stepId: unit.qa.stepId, when: "qa_request_changes", isBackEdge: true, maxIterations: 3 };
  const producerEdges = Array.isArray(producerStep?.conditionalDependencies)
    ? producerStep.conditionalDependencies as unknown[] : [];
  const matchingBackEdges = producerEdges.filter(edge => isDeepStrictEqual(edge, expectedBackEdge));
  if (!producerStep || !qaStep || matchingBackEdges.length !== 1 || !unit.producer.completedAt) {
    throw new Error("structural fixture lacks the exact current producer back-edge, semantic QA, or completed producer token");
  }
  const remainingProducerEdges = producerEdges.filter(edge => !isDeepStrictEqual(edge, expectedBackEdge));
  const gateDefinition = { id: gateStepId, name: "Structural gate", agentId: "", type: "tool", qaType: "structural",
    toolNames: ["validate-report"], dependencies: [unit.producer.stepId] };
  const nextSteps = currentSteps.flatMap(step => {
    if (step.id === producerStep.id) return [{ ...step, conditionalDependencies: remainingProducerEdges }];
    if (step.id === qaStep.id) return [gateDefinition, { ...step, dependencies: [gateStepId] }];
    return [step];
  });
  await harness.db.update(workflowDefinitions).set({ stepsJson: nextSteps }).where(eq(workflowDefinitions.id, unit.workflowId));
  const [updatedDefinition] = await harness.peer.select().from(workflowDefinitions).where(and(
    eq(workflowDefinitions.id, unit.workflowId), eq(workflowDefinitions.companyId, unit.companyId)));
  if (!updatedDefinition || !isDeepStrictEqual(updatedDefinition.stepsJson, nextSteps)) {
    throw new Error("structural fixture did not persist only its declared legacy-current graph transition");
  }
  const requestId = `structural-${randomUUID()}`;
  const producerToken = { producerStepId: unit.producer.stepId,
    iterationIndex: unit.producer.iterationIndex ?? 0, completedAt: unit.producer.completedAt!.toISOString() };
  const [gate] = await harness.db.insert(workflowStepRuns).values({ workflowRunId: unit.runId, stepId: gateStepId,
    issueId: null, status: "failed", iterationIndex: unit.producer.iterationIndex,
    completedAt: new Date(), lastDispatchRequestId: requestId,
    metadata: { structuralGateProducerToken: producerToken,
      structuralGateProducerGeneration: unit.producer.executionGeneration } }).returning();
  await harness.db.insert(workflowTransitionEvents).values({ companyId: unit.companyId, missionId: unit.missionId,
    workflowRunId: unit.runId, workflowStepRunId: gate!.id, issueId: null,
    eventType: "workflow_validation_verdict", layer: "workflow_validation", verdict: "request_changes",
    decision: "request_changes", reasonCode: "workflow_tool_result",
    idempotencyKey: `structural-gate-verdict:${unit.companyId}:${gate!.id}:${requestId}`,
    payload: { kind: "structural_gate_verdict", workflowRunId: unit.runId, workflowStepRunId: gate!.id,
      requestId, verdict: "request_changes", diagnostics: [], producerToken },
    createdAt: new Date() });
  return { gate: gate!, requestId, producerToken };
}

export async function createUnrelatedPublicRoot(harness: AdmissionHarness, companyId: string) {
  const workflowId = randomUUID(), runId = randomUUID();
  await harness.db.insert(workflowDefinitions).values({ id: workflowId, companyId,
    name: "Independent public root", stepsJson: [] });
  await harness.db.insert(workflowRuns).values({ id: runId, companyId, workflowId,
    status: "running", triggeredBy: "test" });
  return runId;
}

async function createDownstreamProgressRow(harness: AdmissionHarness, scenario: Pick<AdmissionScenario,
  "companyId" | "missionId" | "runId" | "authorId">, stepId: string) {
  const issueId = randomUUID();
  await harness.db.insert(issues).values({ id: issueId, companyId: scenario.companyId, missionId: scenario.missionId,
    title: "Downstream progress", status: "todo", assigneeAgentId: scenario.authorId,
    originKind: "workflow_execution", originRunId: scenario.runId });
  const [stepRun] = await harness.db.insert(workflowStepRuns).values({ workflowRunId: scenario.runId,
    stepId, issueId, status: "pending" }).returning();
  if (!stepRun) throw new Error("downstream fixture step run missing");
  const progress: AdmissionDownstreamProgress = { companyId: scenario.companyId, missionId: scenario.missionId,
    runId: scenario.runId, agentId: scenario.authorId, issueId, stepRun, adapterEntries: 0 };
  const registration: AdmissionAdapterRegistration = { kind: "downstream", downstream: progress,
    execute: async (context, observation) => {
      const { heartbeat, wakeup, issue, step } = observation;
      if (!heartbeat || !wakeup || !issue || !step) throw new Error(`downstream adapter ${context.runId} is missing persisted joins`);
      const attempt = attemptTuple(step);
      const proof = readWorkflowAttemptProof(wakeup);
      if (context.agent.id !== progress.agentId || context.context.issueId !== progress.issueId
        || heartbeat.id !== context.runId || heartbeat.companyId !== progress.companyId
        || heartbeat.agentId !== progress.agentId || heartbeat.issueId !== progress.issueId
        || heartbeat.workflowStepRunId !== progress.stepRun.id || heartbeat.workflowExecutionGeneration !== attempt.executionGeneration
        || heartbeat.wakeupRequestId !== wakeup.id || wakeup.companyId !== progress.companyId
        || wakeup.agentId !== progress.agentId || wakeup.issueId !== progress.issueId
        || wakeup.missionId !== progress.missionId || wakeup.workflowRunId !== progress.runId
        || wakeup.workflowStepRunId !== progress.stepRun.id || wakeup.workflowExecutionGeneration !== attempt.executionGeneration
        || wakeup.reason !== "workflow_step_runnable" || issue.id !== progress.issueId
        || issue.companyId !== progress.companyId || issue.missionId !== progress.missionId || issue.originRunId !== progress.runId
        || step.id !== progress.stepRun.id || step.workflowRunId !== progress.runId || step.stepId !== progress.stepRun.stepId
        || step.issueId !== progress.issueId || !sameAttempt(attempt, attemptTuple(progress.stepRun))
        || proof.companyId !== progress.companyId || proof.agentId !== progress.agentId || proof.missionId !== progress.missionId
        || proof.workflowRunId !== progress.runId || proof.wakeupRequestId !== wakeup.id
        || !sameStoredAttemptProof(proof, attempt)) {
        throw new Error(`downstream adapter ${context.runId} does not bind the exact declared issue/step attempt`);
      }
      progress.adapterEntries++;
      if (progress.adapterEntries !== 1) throw new Error(`duplicate downstream actual for ${progress.stepRun.id}`);
      const stdout = `admission downstream actual ${progress.runId}/${progress.stepRun.id}`;
      progress.actual = { heartbeatRunId: heartbeat.id, wakeupRequestId: wakeup.id, attempt, stdout };
      return { exitCode: 0, signal: null, timedOut: false, usage: null, provider: "fixture", model: "fixture",
        resultJson: { stdout, stderr: "" }, runtimeServices: [] };
    } };
  if (admissionAdapterHandlers.has(issueId)) throw new Error(`duplicate downstream adapter registration ${issueId}`);
  admissionAdapterHandlers.set(issueId, registration);
  registeredAdmissionIssueIds.add(issueId);
  return progress;
}

async function addDownstreamProgressStep(harness: AdmissionHarness, scenario: Pick<AdmissionScenario,
  "companyId" | "missionId" | "workflowId" | "runId" | "authorId">,
  upstreamStepId: string, qaGateStepId: string) {
  const stepId = `downstream-${randomUUID()}`;
  const [definition] = await harness.db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, scenario.workflowId));
  if (!definition) throw new Error("downstream fixture workflow definition missing");
  await harness.db.update(workflowDefinitions).set({ stepsJson: [
    ...(definition.stepsJson as Record<string, unknown>[]),
    { id: stepId, name: "Downstream progress", agentId: scenario.authorId, dependencies: [],
      conditionalDependencies: [{ stepId: qaGateStepId, when: "qa_request_changes" }] },
  ] }).where(eq(workflowDefinitions.id, scenario.workflowId));
  return createDownstreamProgressRow(harness, scenario, stepId);
}

export async function createReplacementAdmissionPair(harness: AdmissionHarness, observer?: ReplacementAdmissionObserver) {
  const sourceState = await createAdmissionScenarioState(harness, 1);
  const [sourceDefinition] = await harness.db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, sourceState.workflowId));
  if (!sourceDefinition) throw new Error("admission replacement source workflow definition missing");
  const targetVerifierId = randomUUID();
  const sourceSteps = normalizeWorkflowStepsForExecution(sourceDefinition.stepsJson);
  const targetQaStep = sourceSteps.find(step => step.id === sourceState.units[0]!.qa.stepId);
  if (!targetQaStep) throw new Error("admission replacement target QA step missing from source definition");
  const [targetRun] = await harness.db.insert(workflowRuns).values({ companyId: sourceState.companyId,
    missionId: sourceState.missionId, workflowId: sourceState.workflowId, status: "running", triggeredBy: "test",
    dispatchAuthorityVersion: 1, metadata: { replacementStart: { deliveredAt: new Date().toISOString() } } }).returning();
  if (!targetRun) throw new Error("admission replacement target run missing");
  const targetState: AdmissionScenarioState = { ...sourceState, runId: targetRun.id, workflowId: sourceState.workflowId,
    units: [] };
  const qaOwnerOverride: AdmissionQaOwnerOverride = { companyId: sourceState.companyId, missionId: sourceState.missionId,
    targetRunId: targetRun.id, targetQaStepRunId: randomUUID(), targetQaIssueId: randomUUID(),
    definitionVerifierId: targetQaStep.agentId, targetIssueAssigneeAgentId: targetVerifierId,
    sourceRunId: sourceState.runId, sourceQaStepRunId: sourceState.units[0]!.qa.id,
    sourceQaIssueId: sourceState.units[0]!.qaIssue.id, sourceVerifierId: sourceState.verifierId };
  const targetUnitState = await createAdmissionUnit(harness, targetState, "A", {
    addDefinition: false, verifierId: targetVerifierId, qaOwnerOverride });
  targetState.downstreamProgress = await createDownstreamProgressRow(harness, targetState,
    sourceState.downstreamProgress!.stepRun.stepId);
  const allUnits = [...sourceState.units, targetUnitState];
  const qaCompletion = createQaCompletionCommitReturnBarrier(harness, allUnits);
  let setupFailureSnapshot: unknown;
  const setupObserver = observer ? { ...observer, onFailureSnapshot: (snapshot: unknown) => {
    setupFailureSnapshot = snapshot;
    observer.onFailureSnapshot?.(snapshot);
  } } : undefined;
  try {
    await runAdmissionUnitsActuals(harness, allUnits, qaCompletion, setupObserver ? {
      observer: setupObserver, sourceRunId: sourceState.runId, targetRunId: targetRun.id,
    } : undefined);
    const scenario = toAdmissionScenario(sourceState, qaCompletion);
    const targetScenario = toAdmissionScenario(targetState, qaCompletion);
    const sourceUnit = await prepareAdmissionUnit(harness, scenario.units[0]!);
    const targetUnit = await prepareAdmissionUnit(harness, targetScenario.units[0]!);
    const [decision] = await harness.db.insert(workflowTerminalDecisions).values({ companyId: scenario.companyId,
      workflowRunId: scenario.runId, decidedAuthorityVersion: 1, decision: "failed", policyCause: "outcome_convergence",
      discoveryPath: "engine_recompute", origin: "test" }).returning();
    const [decisionEvent] = await harness.db.insert(workflowTransitionEvents).values({ companyId: scenario.companyId,
      missionId: scenario.missionId, workflowRunId: scenario.runId, eventType: "workflow_replacement_decision_v1",
      layer: "workflow_replacement", payload: {} }).returning();
    const [sourceRun] = await harness.peer.select().from(workflowRuns).where(eq(workflowRuns.id, scenario.runId));
    const [currentDefinition] = await harness.peer.select().from(workflowDefinitions).where(and(
      eq(workflowDefinitions.id, scenario.workflowId), eq(workflowDefinitions.companyId, scenario.companyId)));
    if (!sourceRun || !currentDefinition || !decision || !decisionEvent) {
      throw new Error("replacement fixture lost its current source run, workflow definition, terminal decision, or decision event");
    }
    const requesterAgentId = scenario.authorId;
    const idempotencyKey = `admission-replacement:${sourceRun.id}:${targetRun.id}`;
    const approvalId = randomUUID();
    const approverId = randomUUID();
    const metadata = normalizeWorkflowRunInputs(currentDefinition.runInputs as never, {});
    const payload = replacementApprovalPayloadSchema.parse({ schemaVersion: 1, companyId: scenario.companyId,
      missionId: scenario.missionId, workflowId: scenario.workflowId, sourceRunId: sourceRun.id,
      sourceAuthorityVersion: sourceRun.dispatchAuthorityVersion, terminalDecisionId: decision.id,
      decisionEventId: decisionEvent.id, requesterAgentId, targetRunId: targetRun.id,
      requestGeneration: sourceUnit.producer.executionGeneration, stepRunId: sourceUnit.producer.id,
      definitionHash: await replacementDefinitionHash(harness.db, currentDefinition, scenario.missionId, targetRun.id),
      inputHash: hashStructuredValue(metadata), inputContract: currentDefinition.runInputs ?? [], metadata,
      idempotencyKey, externalEffects: "operator_reconciled" });
    const requestHash = hashStructuredValue({ intent: { schemaVersion: 1, sourceRunId: sourceRun.id,
      expectedSourceAuthorityVersion: sourceRun.dispatchAuthorityVersion, decisionEventId: decisionEvent.id,
      approvalId, idempotencyKey }, companyId: scenario.companyId, missionId: scenario.missionId,
      workflowId: scenario.workflowId, metadata: payload.metadata, requester: payload.requesterAgentId });
    const [approval] = await harness.db.insert(approvals).values({ id: approvalId, companyId: scenario.companyId,
      type: "workflow_replacement", status: "approved", requestedByAgentId: requesterAgentId,
      decidedByUserId: approverId, decidedAt: new Date(), payload }).returning();
    if (!approval) throw new Error("replacement fixture approval row missing after insert");
    const [authority] = await harness.db.insert(workflowRecoveryAuthorities).values({ companyId: scenario.companyId,
      workflowRunId: sourceRun.id, targetAuthorityVersion: sourceRun.dispatchAuthorityVersion,
      resultingAuthorityVersion: sourceRun.dispatchAuthorityVersion,
      targetDecisionId: decision.id, recoveryKind: "replacement_from_start_v1", requestedBy: requesterAgentId,
      requestReference: idempotencyKey, ownerDecisionEventId: decisionEvent.id, operatorApprovalId: approval.id,
      replacementRunId: targetRun.id, requestHash, replacementContract: { ...payload, approver: approverId },
      status: "consumed", consumedAt: new Date() }).returning();
    if (!authority) throw new Error("replacement fixture canonical authority row missing after insert");
    await harness.db.update(workflowRuns).set({ status: "completed" }).where(eq(workflowRuns.id, scenario.runId));
    await harness.db.update(workflowRuns).set({ metadata: { ...targetRun.metadata, replacementAuthorityId: authority.id } })
      .where(eq(workflowRuns.id, targetRun.id));
    const [verifiedTarget] = await harness.peer.select().from(workflowRuns).where(eq(workflowRuns.id, targetRun.id));
    if (!verifiedTarget || verifiedTarget.metadata?.replacementAuthorityId !== authority.id) {
      throw new Error("replacement fixture target authority marker did not persist");
    }
    return { scenario, targetScenario, sourceUnit, targetUnit, targetRun: verifiedTarget, authority };
  } catch (error) {
    const cleanupErrors: string[] = [];
    try { qaCompletion.restore(); } catch (cleanupError) { cleanupErrors.push(String(cleanupError)); }
    try { qaCompletion.releaseAll(); } catch (cleanupError) { cleanupErrors.push(String(cleanupError)); }
    for (const unit of allUnits) {
      try { unit.allowProduction.resolve(); } catch (cleanupError) { cleanupErrors.push(String(cleanupError)); }
      try { unit.releaseActual.resolve(); } catch (cleanupError) { cleanupErrors.push(String(cleanupError)); }
      try { unit.allowQaVerdict.resolve(); } catch (cleanupError) { cleanupErrors.push(String(cleanupError)); }
    }
    process.stdout.write(`${JSON.stringify({ eventType: "replacement_pair_primary_failure", phase: "create_replacement_pair",
      error: error instanceof Error ? { name: error.name, message: error.message.slice(0, 600) } : { name: "Error", message: String(error).slice(0, 600) },
      setupFailureSnapshot: setupFailureSnapshot ?? null })}\n`);
    let snapshot = setupFailureSnapshot;
    if (snapshot === undefined) {
      try { snapshot = await captureReplacementAdmissionFailureSnapshot(harness, allUnits, "create_replacement_pair", qaCompletion, {
        sourceRunId: sourceState.runId, targetRunId: targetRun.id, callerAwaitLabel: "create_replacement_pair",
        syncSettlement: { kind: "not_started" }, expectedBlockerPid: null, rootPid: null, nativeUnionRecord: null,
      }); }
      catch (caught) { snapshot = { unavailable: caught instanceof Error ? caught.message : String(caught) }; }
    }
    try { await qaCompletion.finish(); }
    catch (caught) { cleanupErrors.push(String(caught)); }
    const cause = error instanceof Error ? error : new Error(String(error));
    throw new Error(`${cause.message}\nReplacement fixture failure snapshot: ${JSON.stringify({ phase: "create_replacement_pair",
      snapshot, cleanupErrors })}`,
    { cause });
  }
}

export async function insertToolArtifactDefinition(db: Db, companyId: string, name: string, contract: unknown) {
  const [tool] = await db.insert(toolDefinitions).values({ companyId, name, adapterType: "builtin",
    adapterConfig: { artifactContract: contract }, inputSchema: {}, enabled: true }).returning();
  return tool!;
}

export async function listPreparationIds(db: Db, runId: string) {
  return (await db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.workflowRunId, runId), eq(workflowTransitionEvents.eventType, QA_REMEDIATION_PREPARATION_EVENT_TYPE))))
    .map(row => row.id).sort();
}

export const admissionFileBytes = { before: beforeText, after: afterText };
