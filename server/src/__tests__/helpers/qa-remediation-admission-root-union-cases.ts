// QA remediation admission-root cases moved out of qa-remediation-admission-root.test.ts
// (T16d, file <=1000 lines).
// Slice: locked pending-union publish case + public-sync C02 deferral case.
// Case bodies are moved verbatim: the describe-scoped db connection, service handle and fixture
// helpers are injected by the caller so the suite lifecycle stays in one place.
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray, is, sql } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { expect, it, beforeAll } from "vitest";
import { agentWakeupRequests, workflowDefinitions, workflowRecoveryAuthorities, workflowRuns, workflowTransitionEvents } from "@paperclipai/db";
import { withQaRemediationSharedAdmission } from "../../services/workflow/control-flow/qa-remediation-admission-root.js";
import { createQaFileOwnerRuntime } from "../../services/workflow/control-flow/qa-remediation-runtime.js";
import { QA_REMEDIATION_COMPLETION_EVENT_TYPE, qaRemediationCompletionKey, legacyQaRemediationRefireWakeKey } from "../../services/workflow/control-flow/qa-remediation-completion.js";
import { QA_REMEDIATION_PREPARATION_EVENT_TYPE, parseQaRemediationPreparation, qaRemediationPreparationKey } from "../../services/workflow/control-flow/qa-remediation-preparation-contract.js";
import { hashQaCorrectionPayload } from "../../services/workflow/control-flow/qa-correction-contract.js";
import { qaRemediationRefireV2WakeKey } from "../../services/workflow/control-flow/qa-remediation-completion-evidence.js";
import { discoverQaRemediationWorkflowScope } from "../../services/workflow/control-flow/qa-remediation-admission-root.js";
import { syncWorkflowRunStateWithOutcome } from "../../services/workflow/dag-engine.js";
import { normalizeWorkflowStepsForExecution } from "../../services/workflow/execution-steps.js";
import { deferred, within } from "./qa-remediation-parent-death-harness.js";
import { assertBlockedRootWaitingForMissionTransaction, type AdmissionHarness, type ReplacementAdmissionObserver, type ReplacementLifecycleCheckpoint, captureReplacementAdmissionFailureSnapshot, createAdmissionScenario, createReplacementAdmissionPair, createUnrelatedPublicRoot, listPreparationIds, prepareAdmissionUnit, admissionFileBytes, backendPid, dbRows, beginMissionBlock, observeNativeLockWait, traceNativeOwnerBegins, waitForBackendGone, waitForBackendQuery, waitForBlockedBy } from "./qa-remediation-admission-public-fixture.js";
import { traceMeasuredPublicSyncRoot, nativeOwnerEvidence, rootErrorEvidence, snapshotAttempt, expectAdmissionActualStable, expectExactV2Refire, expectScopedDownstreamProgress } from "./qa-remediation-admission-root-fixtures.js";

export function registerQaRemediationAdmissionRootUnionCases(deps: {
  getHarness: () => AdmissionHarness;
  ownerRuntime: () => ReturnType<typeof createQaFileOwnerRuntime>;
}) {
  const { getHarness, ownerRuntime } = deps;

  // Late-bound: the caller assigns these describe-scoped values in its own beforeAll, which
  // is registered before this hook, so every case sees the live connection and service.
  let harness!: AdmissionHarness;
  beforeAll(() => {
    harness = getHarness();
  });

it("keeps the replacement source in the locked pending union while the target makes only its exact publish", async () => {
  let pair: Awaited<ReturnType<typeof createReplacementAdmissionPair>> | undefined;
  let qaFinishPromise: Promise<unknown> | undefined;
  const finishOriginalQa = () => {
    if (!pair) return Promise.reject(new Error("replacement pair missing before original QA cleanup"));
    qaFinishPromise ??= pair.scenario.qaCompletion.finish();
    return qaFinishPromise;
  };
  let replacementPhase = "await_create_replacement_pair";
  let callerAwaitLabel = "createReplacementAdmissionPair:enter";
  type SyncSettlement = { kind: "not_started" | "pending" } | { kind: "fulfilled"; outcome: unknown }
    | { kind: "rejected"; error: unknown };
  type SettledRoot = Exclude<SyncSettlement, { kind: "not_started" | "pending" }>;
  let syncSettlement: SyncSettlement = { kind: "not_started" };
  let syncSettlementPromise: Promise<SettledRoot> | undefined;
  let originalSyncPromise: Promise<unknown> | undefined;
  let expectedBlockerPid: number | null = null, expectedBlockingTransactionId: string | null = null, measuredRootPid: number | null = null;
  let failureSnapshot: unknown;
  let measuredPublicRoot: ReturnType<typeof traceMeasuredPublicSyncRoot> | undefined;
  let replacementPreflightEvidence: unknown = null, replacementDbWaitProof: unknown = null, replacementBarrierEvidence: unknown = null;
  let syncOwnerEvidenceAtSettlement: ReturnType<typeof nativeOwnerEvidence> | null = null;
  let blocker: Awaited<ReturnType<typeof beginMissionBlock>> | undefined;
  let nativeTrace: ReturnType<typeof traceNativeOwnerBegins> | undefined;
  let waitController: AbortController | undefined;
  let blockerReleased = false;
  const lifecycleCheckpoints: ReplacementLifecycleCheckpoint[] = [];
  const observer: ReplacementAdmissionObserver = {
    onCheckpoint: checkpoint => {
      callerAwaitLabel = `${checkpoint.awaitName}:${checkpoint.phase}`;
      if (lifecycleCheckpoints.length < 64) lifecycleCheckpoints.push(checkpoint);
      process.stdout.write(`${JSON.stringify(checkpoint)}\n`);
    },
    onFailureSnapshot: snapshot => {
      failureSnapshot = snapshot;
      process.stdout.write(`${JSON.stringify({ eventType: "replacement_pre_cleanup_snapshot", callerAwaitLabel, snapshot })}\n`);
    },
  };
  let primaryFailed = false, primaryError: unknown;
  const cleanupErrors: Array<{ phase: string; error: string }> = [];
  const settlementRecord = (settlement: SyncSettlement): unknown => settlement.kind === "rejected"
    ? { kind: settlement.kind, error: rootErrorEvidence(settlement.error) }
    : settlement;
  const publicSyncCheckpoint = (phase: "enter" | "complete" | "error", error?: unknown) => {
    callerAwaitLabel = `syncWorkflowRunStateWithOutcome:${phase}`;
    if (phase !== "enter") syncOwnerEvidenceAtSettlement = nativeOwnerEvidence(measuredPublicRoot?.records() ?? []);
    process.stdout.write(`${JSON.stringify({ eventType: "replacement_public_sync_checkpoint",
      awaitName: "syncWorkflowRunStateWithOutcome", phase, observedAt: new Date().toISOString(), callerAwaitLabel,
      replacementPhase, error: phase === "error" ? rootErrorEvidence(error) : null,
      nativeOwnerRecords: nativeOwnerEvidence(nativeTrace?.records ?? []),
      measuredRootRecords: syncOwnerEvidenceAtSettlement ?? nativeOwnerEvidence(measuredPublicRoot?.records() ?? []),
      measuredRootTransactionPids: measuredPublicRoot?.transactionPids() ?? [],
      sourceRunId: pair?.sourceUnit.runId ?? null, targetRunId: pair?.targetRun.id ?? null,
      targetProducerAttempt: pair ? { stepRunId: pair.targetUnit.producer.id, issueId: pair.targetUnit.producer.issueId,
        executionGeneration: pair.targetUnit.producer.executionGeneration, retryCount: pair.targetUnit.producer.retryCount,
        iterationIndex: pair.targetUnit.producer.iterationIndex } : null,
      targetQaAttempt: pair ? { stepRunId: pair.targetUnit.qa.id, issueId: pair.targetUnit.qa.issueId,
        executionGeneration: pair.targetUnit.qa.executionGeneration, retryCount: pair.targetUnit.qa.retryCount,
        iterationIndex: pair.targetUnit.qa.iterationIndex } : null })}\n`);
  };
  try {
  process.stdout.write(`${JSON.stringify({ eventType: "replacement_pair_await", phase: "enter", callerAwaitLabel })}\n`);
  pair = await createReplacementAdmissionPair(harness, observer);
  if (!pair) throw new Error("replacement pair construction returned without a pair");
  callerAwaitLabel = "createReplacementAdmissionPair:complete";
  process.stdout.write(`${JSON.stringify({ eventType: "replacement_pair_await", phase: "complete", callerAwaitLabel })}\n`);
  replacementPhase = "pair_created";
  replacementPhase = "snapshot_source_target_attempts";
  expect(pair.sourceUnit.producerHeartbeatRunId).not.toBe(pair.targetUnit.producerHeartbeatRunId);
  expect(pair.sourceUnit.producerDrainIdentity.executionToken).not.toBe(pair.targetUnit.producerDrainIdentity.executionToken);
  const actualBefore = await Promise.all([pair.sourceUnit, pair.targetUnit].map(unit => snapshotAttempt(harness.peer, unit)));
  replacementPhase = "preflight_exact_replacement_scope";
  callerAwaitLabel = "discoverQaRemediationWorkflowScope:enter";
  const sourceRuns = await harness.peer.select().from(workflowRuns).where(eq(workflowRuns.id, pair.sourceUnit.runId));
  const targetRuns = await harness.peer.select().from(workflowRuns).where(eq(workflowRuns.id, pair.targetRun.id));
  const authorityRows = await harness.peer.select().from(workflowRecoveryAuthorities)
    .where(eq(workflowRecoveryAuthorities.replacementRunId, pair.targetRun.id));
  expect(sourceRuns).toHaveLength(1);
  expect(targetRuns).toHaveLength(1);
  expect(authorityRows).toEqual([pair.authority]);
  const sourceRun = sourceRuns[0]!, targetRun = targetRuns[0]!, authority = authorityRows[0]!;
  expect(sourceRun).toMatchObject({ id: pair.sourceUnit.runId, companyId: pair.sourceUnit.companyId,
    missionId: pair.sourceUnit.missionId, workflowId: pair.sourceUnit.workflowId, status: "completed", dispatchAuthorityVersion: 1 });
  expect(targetRun).toMatchObject({ id: pair.targetRun.id, companyId: sourceRun.companyId,
    missionId: sourceRun.missionId, workflowId: sourceRun.workflowId, status: "running", dispatchAuthorityVersion: 1 });
  expect(pair.targetUnit.workflowId).toBe(pair.sourceUnit.workflowId);
  expect(authority).toMatchObject({ id: pair.authority.id, companyId: sourceRun.companyId,
    workflowRunId: sourceRun.id, targetAuthorityVersion: 1, resultingAuthorityVersion: 1,
    recoveryKind: "replacement_from_start_v1", replacementRunId: targetRun.id, status: "consumed" });
  const discoveredScope = await discoverQaRemediationWorkflowScope(harness.peer, targetRun.id);
  expect(discoveredScope.source).toEqual(sourceRun);
  expect(discoveredScope.target).toEqual(targetRun);
  expect(discoveredScope.authority).toEqual(authority);
  const [definition] = await harness.peer.select().from(workflowDefinitions).where(and(
    eq(workflowDefinitions.id, sourceRun.workflowId), eq(workflowDefinitions.companyId, sourceRun.companyId)));
  const sourceQaDefinition = definition && normalizeWorkflowStepsForExecution(definition.stepsJson)
    .find(step => step.id === pair.sourceUnit.qa.stepId);
  expect(sourceQaDefinition?.agentId).toBe(pair.sourceUnit.verifierId);
  expect(pair.sourceUnit.qaIssue.assigneeAgentId).toBe(pair.sourceUnit.verifierId);
  expect(pair.targetUnit.qaIssue.assigneeAgentId).toBe(pair.targetUnit.verifierId);
  expect(pair.targetUnit.verifierId).not.toBe(pair.sourceUnit.verifierId);
  const sourcePreparation = pair.sourceUnit.preparation, targetPreparation = pair.targetUnit.preparation;
  const sourcePreparationId = pair.sourceUnit.preparationEventId, targetPreparationId = pair.targetUnit.preparationEventId;
  if (!sourcePreparation || !targetPreparation || !sourcePreparationId || !targetPreparationId) {
    throw new Error("replacement fixture lacks its exact source and target preparation references");
  }
  const preparationSpecs = [
    { unit: pair.sourceUnit, run: sourceRun, preparation: sourcePreparation, eventId: sourcePreparationId, role: "source" },
    { unit: pair.targetUnit, run: targetRun, preparation: targetPreparation, eventId: targetPreparationId, role: "target" },
  ];
  const preparationIds = preparationSpecs.map(spec => spec.eventId).sort();
  const preparationRows = await harness.peer.select().from(workflowTransitionEvents).where(and(
    inArray(workflowTransitionEvents.id, preparationIds), eq(workflowTransitionEvents.companyId, sourceRun.companyId),
    eq(workflowTransitionEvents.missionId, sourceRun.missionId),
    eq(workflowTransitionEvents.eventType, QA_REMEDIATION_PREPARATION_EVENT_TYPE)));
  const declaredPaths = [pair.sourceUnit.file, pair.targetUnit.file].sort();
  replacementPreflightEvidence = { preparationIds, observedPreparationIds: preparationRows.map(row => row.id).sort(), declaredPaths };
  expect(preparationRows.map(row => row.id).sort()).toEqual(preparationIds);
  expect(await listPreparationIds(harness.peer, sourceRun.id)).toEqual([sourcePreparationId]);
  expect(await listPreparationIds(harness.peer, targetRun.id)).toEqual([targetPreparationId]);
  const preparationEvidence: Array<{ role: string; eventId: string; runId: string; pending: boolean; files: string[] }> = [];
  const fullPreparationPaths: string[] = [];
  for (const spec of preparationSpecs) {
    const row = preparationRows.find(candidate => candidate.id === spec.eventId);
    expect(row).toBeDefined();
    const preparation = parseQaRemediationPreparation(row!.payload);
    expect(row).toMatchObject({ id: spec.eventId, companyId: spec.unit.companyId, missionId: spec.unit.missionId,
      workflowRunId: spec.run.id, workflowStepRunId: spec.unit.producer.id, issueId: spec.unit.producer.issueId,
      executionGeneration: spec.unit.producer.executionGeneration, eventType: QA_REMEDIATION_PREPARATION_EVENT_TYPE,
      layer: "workflow_validation", idempotencyKey: qaRemediationPreparationKey(preparation) });
    expect(preparation).toEqual(spec.preparation);
    const completionRows = await harness.peer.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.workflowRunId, spec.run.id),
      eq(workflowTransitionEvents.eventType, QA_REMEDIATION_COMPLETION_EVENT_TYPE),
      eq(workflowTransitionEvents.idempotencyKey, qaRemediationCompletionKey(preparation))));
    expect(completionRows).toEqual([]);
    const files = preparation.files.map(file => file.path).sort();
    expect(files).toContain(spec.unit.file);
    fullPreparationPaths.push(...files);
    preparationEvidence.push({ role: spec.role, eventId: spec.eventId, runId: spec.run.id, pending: true, files });
    replacementPreflightEvidence = { preparationIds, observedPreparationIds: preparationRows.map(item => item.id).sort(),
      declaredPaths, preparations: [...preparationEvidence] };
  }
  expect(new Set(declaredPaths).size).toBe(2);
  const replacementPaths = [...new Set(fullPreparationPaths)].sort();
  for (const declaredPath of declaredPaths) expect(replacementPaths).toContain(declaredPath);
  replacementPreflightEvidence = { preparationIds, observedPreparationIds: preparationRows.map(row => row.id).sort(),
    declaredPaths, preparations: preparationEvidence, pending: true, replacementPaths };

  const adapterEntriesBefore = [pair.sourceUnit, pair.targetUnit].map(unit => ({ ...unit.adapterEntries,
    v2RefireWakeIds: [...unit.adapterEntries.v2RefireWakeIds] }));
  const assertNoReplacementEffects = async () => {
    const actualAfterNegative = await Promise.all([pair!.sourceUnit, pair!.targetUnit].map(unit => snapshotAttempt(harness.peer, unit)));
    [pair!.sourceUnit, pair!.targetUnit].forEach((unit, index) =>
      expectAdmissionActualStable(unit, actualBefore[index]!, actualAfterNegative[index]!));
    expect([pair!.sourceUnit, pair!.targetUnit].map(unit => ({ ...unit.adapterEntries,
      v2RefireWakeIds: [...unit.adapterEntries.v2RefireWakeIds] }))).toEqual(adapterEntriesBefore);
    expect(await readFile(pair!.sourceUnit.file, "utf8")).toBe(admissionFileBytes.before);
    expect(await readFile(pair!.targetUnit.file, "utf8")).toBe(admissionFileBytes.before);
    for (const unit of [pair!.sourceUnit, pair!.targetUnit]) {
      expect(await harness.peer.select().from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.workflowRunId, unit.runId),
        eq(workflowTransitionEvents.eventType, QA_REMEDIATION_COMPLETION_EVENT_TYPE)))).toEqual([]);
      expect(await harness.peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey,
        qaRemediationRefireV2WakeKey(unit.preparation!, unit.qa.id, unit.verdictEventId)))).toEqual([]);
      expect(await harness.peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey,
        legacyQaRemediationRefireWakeKey(unit.runId, unit.qa.id)))).toEqual([]);
    }
    expect(await harness.peer.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.workflowStepRunId, pair!.targetScenario.downstreamProgress.stepRun.id))).toEqual([]);
  };

  replacementPhase = "reject_source_authority_version_mismatch";
  await harness.db.update(workflowRecoveryAuthorities).set({
    targetAuthorityVersion: authority.targetAuthorityVersion + 1,
    resultingAuthorityVersion: authority.resultingAuthorityVersion + 1,
  }).where(eq(workflowRecoveryAuthorities.id, authority.id));
  await expect(syncWorkflowRunStateWithOutcome(harness.db, targetRun.id)).rejects.toMatchObject({
    reason: "replacement_authority_binding",
  });
  await assertNoReplacementEffects();
  await harness.db.update(workflowRecoveryAuthorities).set({
    targetAuthorityVersion: authority.targetAuthorityVersion,
    resultingAuthorityVersion: authority.resultingAuthorityVersion,
  }).where(eq(workflowRecoveryAuthorities.id, authority.id));
  const [restoredAuthority] = await harness.peer.select().from(workflowRecoveryAuthorities)
    .where(eq(workflowRecoveryAuthorities.id, authority.id));
  expect(restoredAuthority).toEqual(authority);

  replacementPhase = "reject_overlapping_source_target_paths";
  const overlappingTargetPreparation = parseQaRemediationPreparation({
    ...targetPreparation,
    verdicts: targetPreparation.verdicts.map(verdict => {
      const items = verdict.items.map(item => ({ ...item, file: pair!.sourceUnit.file }));
      return { ...verdict, items, remediationsHash: hashQaCorrectionPayload(items) };
    }),
    files: targetPreparation.files.map(file => ({ ...file, path: pair!.sourceUnit.file })),
  });
  try {
    await harness.db.update(workflowTransitionEvents).set({
      payload: overlappingTargetPreparation as unknown as Record<string, unknown>,
    }).where(eq(workflowTransitionEvents.id, targetPreparationId));
    await expect(syncWorkflowRunStateWithOutcome(harness.db, targetRun.id)).rejects.toMatchObject({
      reason: "replacement_preparation_path_overlap",
    });
    await assertNoReplacementEffects();
  } finally {
    await harness.db.update(workflowTransitionEvents).set({
      payload: targetPreparation as unknown as Record<string, unknown>,
    }).where(eq(workflowTransitionEvents.id, targetPreparationId));
  }

  callerAwaitLabel = "discoverQaRemediationWorkflowScope:complete";
  replacementPhase = "begin_mission_block";
  blocker = await beginMissionBlock(harness.db, pair.scenario.companyId, pair.scenario.missionId);
  expectedBlockerPid = blocker.pid;
  nativeTrace = traceNativeOwnerBegins();
  expect(await harness.peer.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.workflowRunId, pair.targetRun.id),
    eq(workflowTransitionEvents.eventType, QA_REMEDIATION_COMPLETION_EVENT_TYPE)))).toEqual([]);
  expect(await harness.peer.select().from(agentWakeupRequests)
    .where(eq(agentWakeupRequests.workflowStepRunId, pair.targetScenario.downstreamProgress.stepRun.id))).toEqual([]);
  replacementPhase = "start_target_public_sync";
  const publicRootTrace = traceMeasuredPublicSyncRoot(pair.targetRun.id, nativeTrace);
  measuredPublicRoot = publicRootTrace;
  syncSettlement = { kind: "pending" };
  publicSyncCheckpoint("enter");
  const originalSync = syncWorkflowRunStateWithOutcome(harness.db, pair.targetRun.id);
  originalSyncPromise = originalSync;
  const observedSync = originalSync.then(outcome => {
    syncSettlement = { kind: "fulfilled", outcome };
    publicSyncCheckpoint("complete");
    return syncSettlement as SettledRoot;
  }, error => {
    syncSettlement = { kind: "rejected", error };
    publicSyncCheckpoint("error", error);
    return syncSettlement as SettledRoot;
  });
  syncSettlementPromise = observedSync;
  replacementPhase = "race_original_sync_settlement_with_mission_wait";
  callerAwaitLabel = "waitForBlockedBy:enter";
  waitController = new AbortController();
  const blockedObservation = waitForBlockedBy(harness.peer, blocker.pid, waitController.signal).then(
    pid => ({ kind: "blocked" as const, pid }), error => ({ kind: "observer_error" as const, error }));
  const firstRootObservation = await Promise.race([
    blockedObservation,
    observedSync.then(settlement => ({ kind: "settled" as const, settlement })),
  ]);
  if (firstRootObservation.kind === "settled") {
    waitController?.abort();
    throw new Error(`original target public sync settled before the exact mission DB wait: ${JSON.stringify({
      settlement: settlementRecord(firstRootObservation.settlement), targetRunId: pair.targetRun.id })}`);
  }
  if (firstRootObservation.kind === "observer_error") throw firstRootObservation.error;
  measuredRootPid = firstRootObservation.pid;
  callerAwaitLabel = "waitForBlockedBy:complete";
  replacementPhase = "verify_blocked_root_transaction_wait";
  if (syncSettlement.kind !== "pending") throw new Error(`original target sync settled before DB-wait proof: ${JSON.stringify({
    settlement: settlementRecord(syncSettlement), measuredRootPid, expectedBlockerPid })}`);
  const missionWaitProof = await assertBlockedRootWaitingForMissionTransaction(harness.peer, measuredRootPid, blocker.pid);
  expectedBlockingTransactionId = missionWaitProof.expectedBlockingTransactionId;
  const boundTransactionPids = publicRootTrace.transactionPids();
  const exactRootBound = publicRootTrace.workCaptured() && publicRootTrace.sharedAdmissionCalls() > 0
    && boundTransactionPids.filter(pid => pid === measuredRootPid).length === 1;
  replacementDbWaitProof = { missionWaitProof, measuredRootPid, expectedBlockerPid,
    expectedBlockingTransactionId, boundTransactionPids, exactRootBound };
  process.stdout.write(`${JSON.stringify({ eventType: "replacement_db_wait_observed", phase: replacementPhase,
    callerAwaitLabel, ...replacementDbWaitProof })}\n`);
  if (!exactRootBound) throw new Error(`observed mission DB wait is not bound to the original target sync: ${JSON.stringify({
    measuredRootPid, boundTransactionPids, workCaptured: publicRootTrace.workCaptured(),
    sharedAdmissionCalls: publicRootTrace.sharedAdmissionCalls(), settlement: settlementRecord(syncSettlement) })}`);
  if (syncSettlement.kind !== "pending") throw new Error(`original target sync settled before the replacement barrier: ${JSON.stringify({
    settlement: settlementRecord(syncSettlement), measuredRootPid, replacementDbWaitProof })}`);
  replacementPhase = "observe_replacement_union_owner";
  const allOwnerRecordsAtBarrier = [...nativeTrace.records];
  const measuredOwnerRecordsAtBarrier = [...publicRootTrace.records()];
  const activeMeasuredOwners = measuredOwnerRecordsAtBarrier.filter(record => record.acquired
    && record.exitSequence === undefined && record.exit === undefined);
  replacementBarrierEvidence = { phase: replacementPhase, callerAwaitLabel,
    expectedTargets: replacementPaths, allOwners: nativeOwnerEvidence(allOwnerRecordsAtBarrier),
    measuredOwners: nativeOwnerEvidence(measuredOwnerRecordsAtBarrier), activeMeasuredCount: activeMeasuredOwners.length,
    measuredRootTransactionPids: boundTransactionPids, measuredRootPid, syncSettlement: settlementRecord(syncSettlement) };
  process.stdout.write(`${JSON.stringify({ eventType: "replacement_union_barrier_evidence", ...replacementBarrierEvidence })}\n`);
  if (syncSettlement.kind !== "pending") throw new Error(`original target sync settled before replacement union snapshot: ${JSON.stringify({
    settlement: settlementRecord(syncSettlement), replacementBarrierEvidence })}`);
  if (activeMeasuredOwners.length !== 1 || !isDeepStrictEqual(activeMeasuredOwners[0]?.targets, replacementPaths)) {
    throw new Error(`replacement union owner was not acquired and unexited at the positive DB wait: ${JSON.stringify(replacementBarrierEvidence)}`);
  }
  const unionOwner = activeMeasuredOwners[0]!;
  expect(unionOwner.acquired).toBe(true);
  for (const target of replacementPaths) {
    replacementPhase = target === pair.sourceUnit.file ? "observe_source_owner_wait"
      : target === pair.targetUnit.file ? "observe_target_owner_wait" : "observe_additional_owner_wait";
    await observeNativeLockWait(ownerRuntime(), target);
  }
  replacementPhase = "prove_unrelated_public_progress";
  const unrelated = await createUnrelatedPublicRoot(harness, pair.scenario.companyId);
  await expect(syncWorkflowRunStateWithOutcome(harness.db, unrelated)).resolves.toMatchObject({ kind: "synced" });
  replacementPhase = "release_mission_block";
  blocker.release();
  blockerReleased = true;
  await blocker.done;
  replacementPhase = "await_target_public_sync";
  callerAwaitLabel = "syncWorkflowRunStateWithOutcome:settlement";
  const syncResult = await observedSync;
  if (syncResult.kind !== "fulfilled") throw new Error(`target public sync did not fulfill: ${JSON.stringify(settlementRecord(syncResult))}`);
  expect(syncResult.outcome).toMatchObject({ kind: "synced" });
  const settledUnionOwner = syncOwnerEvidenceAtSettlement?.records.find(record => record.beginSequence === unionOwner.beginSequence);
  expect(settledUnionOwner).toMatchObject({ acquired: true, exit: { code: 0, signal: null } });
  expect(settledUnionOwner?.targets).toEqual(replacementPaths);
  expect(settledUnionOwner?.exitSequence).not.toBeNull();
  await Promise.all(nativeTrace.records.map(record => record.exitPromise).filter((promise): promise is Promise<unknown> => !!promise));
  expect(unionOwner?.targets).toEqual(replacementPaths);
  expect(unionOwner?.acquired).toBe(true);
  expect(unionOwner?.exit).toEqual({ code: 0, signal: null });
  process.stdout.write(`${JSON.stringify({ eventType: "replacement_target_completion_refire_evidence",
    phase: "before", sourcePreparationEventId: pair.sourceUnit.preparationEventId,
    targetPreparationEventId: pair.targetUnit.preparationEventId, targetRunId: pair.targetRun.id })}\n`);
  replacementPhase = "prove_exact_target_publish";
  const firstTargetEvidence = await expectExactV2Refire(harness.peer, pair.targetUnit);
  expect(await readFile(pair.targetUnit.file, "utf8")).toBe(admissionFileBytes.after);
  expect(await readFile(pair.sourceUnit.file, "utf8")).toBe(admissionFileBytes.before);
  const targetCompletions = await harness.peer.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.workflowRunId, pair.targetRun.id),
    eq(workflowTransitionEvents.eventType, QA_REMEDIATION_COMPLETION_EVENT_TYPE)));
  expect(targetCompletions.filter(row => row.idempotencyKey === qaRemediationCompletionKey(pair.targetUnit.preparation!))).toHaveLength(1);
  expect(await harness.peer.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.idempotencyKey,
    qaRemediationCompletionKey(pair.sourceUnit.preparation!)))).toHaveLength(0);
  const sourceV2Key = qaRemediationRefireV2WakeKey(pair.sourceUnit.preparation!, pair.sourceUnit.qa.id,
    pair.sourceUnit.verdictEventId);
  expect(await harness.peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, sourceV2Key))).toEqual([]);
  expect(await harness.peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey,
    legacyQaRemediationRefireWakeKey(pair.sourceUnit.runId, pair.sourceUnit.qa.id)))).toEqual([]);
  expect(pair.authority.replacementRunId).toBe(pair.targetRun.id);
  process.stdout.write(`${JSON.stringify({ eventType: "replacement_target_completion_refire_evidence",
    phase: "after", targetCompletionId: firstTargetEvidence.completion.id,
    targetWakeId: firstTargetEvidence.wake.id, sourcePreparationEventId: pair.sourceUnit.preparationEventId })}\n`);

  replacementPhase = "prove_idempotent_reentry";
  const [sourcePreparationBefore] = await harness.peer.select().from(workflowTransitionEvents)
    .where(eq(workflowTransitionEvents.id, pair.sourceUnit.preparationEventId!));
  await expect(syncWorkflowRunStateWithOutcome(harness.db, pair.targetRun.id)).resolves.toMatchObject({ kind: "synced" });
  const repeatedTargetEvidence = await expectExactV2Refire(harness.peer, pair.targetUnit);
  expect(repeatedTargetEvidence.completion.id).toBe(firstTargetEvidence.completion.id);
  expect(repeatedTargetEvidence.receipt).toEqual(firstTargetEvidence.receipt);
  expect(repeatedTargetEvidence.wake.id).toBe(firstTargetEvidence.wake.id);
  expect(await harness.peer.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.workflowRunId, pair.targetRun.id),
    eq(workflowTransitionEvents.eventType, QA_REMEDIATION_COMPLETION_EVENT_TYPE)))).toHaveLength(1);
  expect(await harness.peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey,
    firstTargetEvidence.wake.idempotencyKey!))).toHaveLength(1);
  const [sourcePreparationAfter] = await harness.peer.select().from(workflowTransitionEvents)
    .where(eq(workflowTransitionEvents.id, pair.sourceUnit.preparationEventId!));
  expect(sourcePreparationAfter).toEqual(sourcePreparationBefore);
  expect(await harness.peer.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.idempotencyKey,
    qaRemediationCompletionKey(pair.sourceUnit.preparation!)))).toHaveLength(0);
  expect(await harness.peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, sourceV2Key))).toEqual([]);
  const actualAfter = await Promise.all([pair.sourceUnit, pair.targetUnit].map(unit => snapshotAttempt(harness.peer, unit)));
  [pair.sourceUnit, pair.targetUnit].forEach((unit, index) => expectAdmissionActualStable(unit, actualBefore[index]!, actualAfter[index]!));
  expect(await readFile(pair.targetUnit.file, "utf8")).toBe(admissionFileBytes.after);
  expect(await readFile(pair.sourceUnit.file, "utf8")).toBe(admissionFileBytes.before);
  replacementPhase = "prove_scoped_downstream_progress";
  process.stdout.write(`${JSON.stringify({ eventType: "replacement_downstream_actual_evidence",
    phase: "before", targetRunId: pair.targetRun.id,
    downstreamStepRunId: pair.targetScenario.downstreamProgress.stepRun.id })}\n`);
  await expectScopedDownstreamProgress(harness.peer, pair.targetScenario);
  process.stdout.write(`${JSON.stringify({ eventType: "replacement_downstream_actual_evidence",
    phase: "after", targetRunId: pair.targetRun.id,
    downstreamStepRunId: pair.targetScenario.downstreamProgress.stepRun.id,
    downstreamAdapterEntries: pair.targetScenario.downstreamProgress.adapterEntries })}\n`);
  replacementPhase = "finish_original_qa_commit_barriers";
  await finishOriginalQa();
  const settledTargetCompletions = await harness.peer.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.workflowRunId, pair.targetRun.id),
    eq(workflowTransitionEvents.eventType, QA_REMEDIATION_COMPLETION_EVENT_TYPE)));
  expect(settledTargetCompletions).toHaveLength(1);
  expect(settledTargetCompletions.filter(row => row.idempotencyKey === qaRemediationCompletionKey(pair.targetUnit.preparation!)))
    .toHaveLength(1);
  expect(pair.targetUnit.adapterEntries.validatedV2Refires).toBe(1);
  expect(pair.targetScenario.downstreamProgress.adapterEntries).toBe(1);
  } catch (error) {
    primaryFailed = true;
    primaryError = error;
    process.stdout.write(`${JSON.stringify({ eventType: "replacement_primary_failure", phase: replacementPhase,
      callerAwaitLabel, error: rootErrorEvidence(error), syncSettlement: settlementRecord(syncSettlement),
      preparationPreflight: replacementPreflightEvidence, dbWaitProof: replacementDbWaitProof,
      unionBarrier: replacementBarrierEvidence, syncOwnerEvidenceAtSettlement,
      measuredRootTransactionPids: measuredPublicRoot?.transactionPids() ?? [],
      measuredRootOwners: nativeOwnerEvidence(measuredPublicRoot?.records() ?? []),
      allNativeOwnerRecords: nativeOwnerEvidence(nativeTrace?.records ?? []),
      pair: pair ? { sourceRunId: pair.sourceUnit.runId, targetRunId: pair.targetRun.id,
        sourcePreparationEventId: pair.sourceUnit.preparationEventId, targetPreparationEventId: pair.targetUnit.preparationEventId } : null })}\n`);
  } finally {
    if (pair) {
      try { pair.scenario.qaCompletion.restore(); }
      catch (error) { cleanupErrors.push({ phase: "qa_barrier_restore", error: error instanceof Error ? error.message : String(error) }); }
      try { pair.scenario.qaCompletion.releaseAll(); }
      catch (error) { cleanupErrors.push({ phase: "qa_barrier_release", error: error instanceof Error ? error.message : String(error) }); }
    }
    waitController?.abort();
    if (blocker && !blockerReleased) {
      try { blocker.release(); blockerReleased = true; }
      catch (error) { cleanupErrors.push({ phase: "mission_block_release", error: error instanceof Error ? error.message : String(error) }); }
    }
    if (originalSyncPromise) {
      try { await originalSyncPromise; }
      catch (error) { cleanupErrors.push({ phase: "original_sync_settlement", error: error instanceof Error ? error.message : String(error) }); }
    }
    if (syncSettlementPromise) {
      try { await syncSettlementPromise; }
      catch (error) { cleanupErrors.push({ phase: "observed_sync_settlement", error: error instanceof Error ? error.message : String(error) }); }
    }
    if (blocker) {
      try { await blocker.done; }
      catch (error) { cleanupErrors.push({ phase: "mission_block_done", error: error instanceof Error ? error.message : String(error) }); }
    }
    if (nativeTrace) {
      try { await Promise.all(nativeTrace.records.map(record => record.exitPromise)
        .filter((promise): promise is Promise<unknown> => !!promise)); }
      catch (error) { cleanupErrors.push({ phase: "native_owner_exit", error: error instanceof Error ? error.message : String(error) }); }
    }
    try { measuredPublicRoot?.restore(); }
    catch (error) { cleanupErrors.push({ phase: "measured_public_root_restore", error: error instanceof Error ? error.message : String(error) }); }
    try { nativeTrace?.restore(); }
    catch (error) { cleanupErrors.push({ phase: "native_trace_restore", error: error instanceof Error ? error.message : String(error) }); }
    if (pair) {
      try { await finishOriginalQa(); }
      catch (error) { cleanupErrors.push({ phase: "qa_completion_finish", error: error instanceof Error ? error.message : String(error) }); }
    }
  }
  if (primaryFailed) {
    const primary = primaryError instanceof Error ? primaryError.message : String(primaryError);
    throw new Error(`${primary}\nReplacement primary failure captured before cleanup: ${JSON.stringify({
      phase: replacementPhase, callerAwaitLabel, syncSettlement: settlementRecord(syncSettlement),
      preparationPreflight: replacementPreflightEvidence, dbWaitProof: replacementDbWaitProof,
      unionBarrier: replacementBarrierEvidence, syncOwnerEvidenceAtSettlement, failureSnapshot,
      cleanupErrors })}`, { cause: primaryError });
  }
  if (cleanupErrors.length) throw new Error(`Replacement cleanup failed after primary execution: ${JSON.stringify(cleanupErrors)}`);

  const malformed = await createReplacementAdmissionPair(harness);
  let malformedPhase = "malformed_pair_created";
  const malformedUnits = [malformed.sourceUnit, malformed.targetUnit];
  const malformedActualBefore = await Promise.all(malformedUnits.map(unit => snapshotAttempt(harness.peer, unit)));
  const malformedAdapterBefore = malformedUnits.map(unit => ({ ...unit.adapterEntries,
    v2RefireWakeIds: [...unit.adapterEntries.v2RefireWakeIds] }));
  let malformedPrimaryError: unknown;
  let malformedSnapshot: unknown;
  let malformedSnapshotError: unknown;
  const malformedCleanupErrors: Array<{ phase: string; error: string }> = [];
  try {
    malformedPhase = "tamper_source_preparation";
    await harness.db.update(workflowTransitionEvents).set({ payload: { schemaVersion: "unknown-source-preparation" } })
      .where(eq(workflowTransitionEvents.id, malformed.sourceUnit.preparationEventId!));
    malformedPhase = "assert_invalid_preparation_hold";
    await expect(syncWorkflowRunStateWithOutcome(harness.db, malformed.targetRun.id)).rejects.toMatchObject({
      reason: "invalid_preparation", eventIds: [malformed.sourceUnit.preparationEventId],
    });
    expect(await readFile(malformed.sourceUnit.file, "utf8")).toBe(admissionFileBytes.before);
    expect(await readFile(malformed.targetUnit.file, "utf8")).toBe(admissionFileBytes.before);
    const malformedActualAfter = await Promise.all(malformedUnits.map(unit => snapshotAttempt(harness.peer, unit)));
    malformedUnits.forEach((unit, index) => expectAdmissionActualStable(unit,
      malformedActualBefore[index]!, malformedActualAfter[index]!));
    expect(malformedUnits.map(unit => ({ ...unit.adapterEntries,
      v2RefireWakeIds: [...unit.adapterEntries.v2RefireWakeIds] }))).toEqual(malformedAdapterBefore);
    for (const unit of malformedUnits) {
      expect(await harness.peer.select().from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.workflowRunId, unit.runId),
        eq(workflowTransitionEvents.eventType, QA_REMEDIATION_COMPLETION_EVENT_TYPE)))).toEqual([]);
      expect(await harness.peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey,
        qaRemediationRefireV2WakeKey(unit.preparation!, unit.qa.id, unit.verdictEventId)))).toEqual([]);
      expect(await harness.peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey,
        legacyQaRemediationRefireWakeKey(unit.runId, unit.qa.id)))).toEqual([]);
    }
    expect(await harness.peer.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.workflowStepRunId, malformed.targetScenario.downstreamProgress.stepRun.id))).toEqual([]);
  } catch (error) {
    malformedPrimaryError = error;
    try { malformed.scenario.qaCompletion.restore(); }
    catch (cleanupError) { malformedCleanupErrors.push({ phase: "malformed_qa_barrier_restore", error: String(cleanupError) }); }
    try { malformed.scenario.qaCompletion.releaseAll(); }
    catch (cleanupError) { malformedCleanupErrors.push({ phase: "malformed_qa_barrier_release", error: String(cleanupError) }); }
    process.stdout.write(`${JSON.stringify({ eventType: "replacement_malformed_primary_failure", phase: malformedPhase,
      error: rootErrorEvidence(error), sourcePreparationEventId: malformed.sourceUnit.preparationEventId,
      targetPreparationEventId: malformed.targetUnit.preparationEventId })}\n`);
    try { malformedSnapshot = await captureReplacementAdmissionFailureSnapshot(harness,
      malformedUnits, malformedPhase, malformed.scenario.qaCompletion); }
    catch (caught) { malformedSnapshotError = caught; }
  } finally {
    try { malformed.scenario.qaCompletion.restore(); }
    catch (error) { malformedCleanupErrors.push({ phase: "malformed_qa_barrier_restore", error: String(error) }); }
    try { malformed.scenario.qaCompletion.releaseAll(); }
    catch (error) { malformedCleanupErrors.push({ phase: "malformed_qa_barrier_release", error: String(error) }); }
    try { await malformed.scenario.qaCompletion.finish(); }
    catch (error) { malformedCleanupErrors.push({ phase: "malformed_qa_completion_finish",
      error: error instanceof Error ? error.message : String(error) }); }
  }
  if (malformedPrimaryError !== undefined || malformedCleanupErrors.length) {
    throw new Error(`Malformed replacement source case failed: ${JSON.stringify({ phase: malformedPhase,
      primary: malformedPrimaryError === undefined ? null : rootErrorEvidence(malformedPrimaryError),
      snapshot: malformedSnapshot ?? null,
      snapshotError: malformedSnapshotError instanceof Error ? malformedSnapshotError.message
        : malformedSnapshotError === undefined ? null : String(malformedSnapshotError),
      cleanupErrors: malformedCleanupErrors })}`, { cause: malformedPrimaryError });
  }
  expect(await readFile(malformed.sourceUnit.file, "utf8")).toBe(admissionFileBytes.before);
  expect(await readFile(malformed.targetUnit.file, "utf8")).toBe(admissionFileBytes.before);
}, 120_000);

it("retains the actual native file guard until the installed Postgres driver callback settles after backend loss", async () => {
  const scenario = await createAdmissionScenario(harness);
  try {
  const unit = await prepareAdmissionUnit(harness, scenario.units[0]!);
  const runtime = ownerRuntime(), entered = deferred<number>(), release = deferred<void>();
  const driverFailure = deferred<unknown>();
  const notifications = { agentIds: new Set<string>(), correctionWakeupRequestIds: new Set<string>() };
  const resolutionMap = new Map<string, unknown>();
  let workCalls = 0, outerSettled = false;
  const execution = withQaRemediationSharedAdmission({ db: harness.db, runId: scenario.runId, ownerRuntime: runtime,
    outerNotifications: notifications, resolutionMap, bindResolutionMap: () => undefined,
    driftBudget: { corrections: 0 }, work: async tx => {
      workCalls++;
      expect(is(tx, PgTransaction)).toBe(true);
      entered.resolve(await backendPid(tx));
      const inFlight = tx.execute(sql`SELECT pg_sleep(30)`);
      void inFlight.catch(error => driverFailure.resolve(error));
      await release.promise;
      return await inFlight;
    } }).catch(error => { outerSettled = true; throw error; });
  const contenderController = new AbortController();
  let contender: ReturnType<typeof runtime.begin> | undefined;
  let contenderOwner: Awaited<ReturnType<typeof runtime.begin>> | undefined;
  try {
    const pid = await entered.promise;
    await waitForBackendQuery(harness.peer, pid, "pg_sleep");
    const terminated = await harness.peer.execute(sql`SELECT pg_terminate_backend(${pid}) AS terminated`);
    expect(dbRows<{ terminated: boolean }>(terminated)[0]?.terminated).toBe(true);
    await waitForBackendGone(harness.peer, pid);
    const driverError = await within(driverFailure.promise, "installed Postgres driver query rejection after backend loss");
    expect(driverError).toBeInstanceOf(Error);
    const waiting = deferred<void>();
    contender = runtime.begin([unit.file], { signal: contenderController.signal, onEvent: event => {
      if (event.type === "lock_wait" && event.target === unit.file) waiting.resolve();
    } });
    await within(waiting.promise, "real native owner retained while transaction callback is unsettled");
    expect(outerSettled).toBe(false);
    expect(workCalls).toBe(1);
    release.resolve();
    await expect(execution).rejects.toMatchObject({ reason: "transaction_outcome_unknown", primaryFailure: driverError });
    contenderOwner = await contender;
    expect(await contenderOwner.close()).toEqual({ code: 0, signal: null });
    contenderOwner = undefined;
  } finally {
    release.resolve();
    contenderController.abort();
    await execution.catch(() => undefined);
    if (contenderOwner) await contenderOwner.close().catch(() => undefined);
    else if (contender) await contender.then(owner => owner.close()).catch(() => undefined);
  }
  expect(workCalls).toBe(1);
  expect(notifications.agentIds.size).toBe(0);
  expect(notifications.correctionWakeupRequestIds.size).toBe(0);
  } finally {
    await scenario.qaCompletion.finish();
  }
});
}
