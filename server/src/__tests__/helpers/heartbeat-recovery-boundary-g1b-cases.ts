// Heartbeat recovery-boundary cases moved out of heartbeat-recovery-boundary.test.ts
// (T16d, file <=1000 lines).
// Slice: G1-B replacement target claim and adapter-start source-authority case.
// Case bodies are moved verbatim: the describe-scoped db connection, service handle and fixture
// helpers are injected by the caller so the suite lifecycle stays in one place.
import { expect, it, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { heartbeatRuns, agentWakeupRequests, issueWorkProducts, instanceSettings, workflowStepRuns, workflowRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { HttpError } from "../../errors.js";
import type { AdapterExecutionResult } from "../../adapters/types.js";
import { syncWorkflowRunStateWithOutcome } from "../../services/workflow/dag-engine.js";
import { heartbeatService } from "../../services/heartbeat.js";
import { waitForHeartbeatExecutionsToDrain } from "../../services/heartbeat-execution-tracker.js";
import { QA_REMEDIATION_PREPARATION_EVENT_TYPE } from "../../services/workflow/control-flow/qa-remediation-preparation-contract.js";
import { QA_REMEDIATION_COMPLETION_EVENT_TYPE } from "../../services/workflow/control-flow/qa-remediation-completion.js";
import { qaRemediationCompletionKey, qaRemediationRefireV2WakeKey, validateQaRemediationCompletionEvidence } from "../../services/workflow/control-flow/qa-remediation-completion-evidence.js";
import { readWorkflowAttemptProof } from "../../services/heartbeat-finalization/workflow-attempt-proof.js";
import { lifecycleInFlightClause } from "../../services/heartbeat-finalization/lifecycle-active.js";
import { missionDedupExemptOversightReviewClause } from "../../services/heartbeat-mission-dedup.js";
import { readC5NotInvokedProof, QaRemediationAdmissionHold } from "../../services/workflow/control-flow/qa-remediation-admission-root.js";
import * as admissionRootModule from "../../services/workflow/control-flow/qa-remediation-admission-root.js";
import { unresolvedQaRemediationAdmissionPending } from "../../services/workflow/control-flow/qa-remediation-admission-root.js";
import type { QaRemediationAdmissionContext } from "../../services/workflow/control-flow/qa-remediation-admission-root.js";
import { captureQaCorrectionExecutionIdentity, withQaCorrectionExecutionRoot } from "../../services/workflow/control-flow/qa-correction-claim-root.js";
import type { QaCorrectionExecutionIdentity, QaCorrectionExecutionInvokeOnce, QaCorrectionExecutionScope } from "../../services/workflow/control-flow/qa-correction-claim-root.js";
import { assertHeartbeatRecoveryAdmission } from "../../services/heartbeat-recovery-guard.js";
import { createQaFileOwnerRuntime, type QaFileOwnerRuntime } from "../../services/workflow/control-flow/qa-remediation-runtime.js";
import { hashQaCorrectionPayload } from "../../services/workflow/control-flow/qa-correction-contract.js";
import { createAdmissionHarness, createReplacementAdmissionPair, drainAdmissionFixtureAdapters, executeAdmissionFixtureAdapter, type AdmissionHarness, waitForAdmissionDownstreamActual } from "./qa-remediation-admission-public-fixture.js";
import { PYTHON, within } from "./qa-remediation-parent-death-harness.js";
import { addG1BDetachedExecutionCandidate, claimExecutionCandidate, executionAdmission } from "./heartbeat-recovery-boundary-fixtures.js";

export function registerHeartbeatRecoveryBoundaryG1BCases(deps: {
  adapter: ReturnType<typeof vi.fn>;
  getDb: () => Db;
}) {
  const { adapter, getDb } = deps;

  // Late-bound: the caller assigns these describe-scoped values in its own beforeAll, which
  // is registered before this hook, so every case sees the live connection and service.
  let db!: Db;
  beforeAll(() => {
    db = getDb();
  });

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
    const expectedStatus = adapterResult.exitCode === 0 && !adapterResult.timedOut ? "succeeded" : "failed";
    // finish() 는 adapter 결과·terminal status 까지만 보장하고 settledAt(정산 표식)은 뒤늦게 쓴다.
    // 1회성 read 는 정산과 경쟁하므로 settled 상태를 관측할 때까지 폴링하고, 그 뒤 값은 아래
    // 기존 단언으로 그대로 검사한다(완화 없음).
    await vi.waitFor(async () => {
      const [heartbeat] = await harness!.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, beforeHeartbeat.id));
      if (!heartbeat) throw new Error("original QA heartbeat disappeared after verified finish");
      expect(heartbeat).toMatchObject({ status: expectedStatus, finalizationVersion: 1, settledAt: expect.any(Date) });
    }, { timeout: 30_000, interval: 100 });
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
}
