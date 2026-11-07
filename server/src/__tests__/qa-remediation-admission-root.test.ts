import { randomUUID } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { agentToolGrants, agentWakeupRequests, companies, heartbeatRuns, instanceSettings, issueWorkProducts, issues, missions, workflowDefinitions, workflowRuns, workflowStepOutputBindings, workflowStepRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { currentReplacementRootNotifications } from "../services/issue-assignment-wakeup.js";
import { withQaCorrectionFollowupReconcile } from "../services/workflow/control-flow/qa-correction-followup-reconcile.js";
import { QaRemediationAdmissionHold, withQaRemediationSharedAdmission } from "../services/workflow/control-flow/qa-remediation-admission-root.js";
import { createQaFileOwnerRuntime } from "../services/workflow/control-flow/qa-remediation-runtime.js";
import { QA_REMEDIATION_COMPLETION_EVENT_TYPE, qaRemediationCompletionKey } from "../services/workflow/control-flow/qa-remediation-completion.js";
import { resolveMissionWorkProductPaths } from "../services/work-products/output-paths.js";
import { beginQaCorrection } from "../services/workflow/control-flow/qa-correction-prepare.js";
import { measureQaCorrectionSources } from "../services/workflow/control-flow/qa-correction-measure.js";
import { storeQaCorrection } from "../services/workflow/control-flow/qa-correction-storage.js";
import { commitQaCorrection } from "../services/workflow/control-flow/qa-correction-commit.js";
import { createNativeWorkflowScheduler } from "../services/workflow/native-scheduler.js";
import { getWorkflowExecutionResultSnapshot, syncWorkflowRunStateWithOutcome, setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";
import { normalizeWorkflowStepsForExecution } from "../services/workflow/execution-steps.js";
import { prepareQaArtifactRequest } from "../services/workflow/qa-artifact-request.js";
import { digest } from "../services/workflow/artifact-files.js";
import { commitBuffers } from "./helpers/c02-fixture.js";
import { PYTHON, deferred, within } from "./helpers/qa-remediation-parent-death-harness.js";
import { addStructuralRejection, assertBlockedRootWaitingForMissionTransaction, type AdmissionHarness, type AdmissionUnit, executeAdmissionFixtureAdapter, createAdmissionHarness, createAdmissionScenario, createUnrelatedPublicRoot, insertToolArtifactDefinition, listPreparationIds, prepareAdmissionUnit, writeAdmissionPreparationInTransaction, drainAdmissionFixtureAdapters, admissionFileBytes, backendPid, dbRows, beginMissionBlock, observeNativeLockWait, traceNativeOwnerBegins, waitForBlockedBy, waitForNativeOwnerAcquired, waitForNativeOwnerBegin, waitForNativeOwnerLockWait, type NativeOwnerRecord } from "./helpers/qa-remediation-admission-public-fixture.js";
import { createCommitSourceHarness, makeCommitSource } from "./qa-correction-commit-fixture.js";
import { registerQaRemediationAdmissionRootUnionCases } from "./helpers/qa-remediation-admission-root-union-cases.js";
import { traceMeasuredPublicSyncRoot, nativeOwnerEvidence, rootErrorEvidence, snapshotAttempt, expectAdmissionActualStable, expectFreshAdmissionBeforeWriter, expectExactV2Refire, expectScopedDownstreamProgress } from "./helpers/qa-remediation-admission-root-fixtures.js";

const admissionAdapter = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", async original => ({
  ...await original<typeof import("../adapters/index.js")>(),
  getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute: admissionAdapter }),
}));

let harness: AdmissionHarness;
let priorLockRoot: string | undefined;
let priorPython: string | undefined;
let priorStorageProvider: string | undefined;
let priorStorageLocalDir: string | undefined;
let priorInstantAdvance: string | undefined;


beforeAll(async () => {
  priorLockRoot = process.env.PAPERCLIP_QA_FILE_OWNER_LOCK_ROOT;
  priorPython = process.env.PAPERCLIP_QA_FILE_OWNER_PYTHON;
  priorStorageProvider = process.env.PAPERCLIP_STORAGE_PROVIDER;
  priorStorageLocalDir = process.env.PAPERCLIP_STORAGE_LOCAL_DIR;
  priorInstantAdvance = process.env.PAPERCLIP_WORKFLOW_INSTANT_ADVANCE;
  harness = await createAdmissionHarness();
  process.env.PAPERCLIP_QA_FILE_OWNER_LOCK_ROOT = harness.lockRoot;
  process.env.PAPERCLIP_QA_FILE_OWNER_PYTHON = PYTHON!;
  process.env.PAPERCLIP_STORAGE_PROVIDER = "local_disk";
  process.env.PAPERCLIP_STORAGE_LOCAL_DIR = path.join(harness.root, "storage");
  process.env.PAPERCLIP_WORKFLOW_INSTANT_ADVANCE = "0";
  admissionAdapter.mockImplementation(executeAdmissionFixtureAdapter);
  await harness.db.insert(instanceSettings).values({ singletonKey: "default", experimental: { enableHeartbeatFinalizationV1: true } })
    .onConflictDoUpdate({ target: instanceSettings.singletonKey, set: { experimental: { enableHeartbeatFinalizationV1: true } } });
}, 120_000);

afterAll(async () => {
  setWorkflowToolStepExecutor(null);
  if (harness) await harness.close();
  if (priorLockRoot === undefined) delete process.env.PAPERCLIP_QA_FILE_OWNER_LOCK_ROOT;
  else process.env.PAPERCLIP_QA_FILE_OWNER_LOCK_ROOT = priorLockRoot;
  if (priorPython === undefined) delete process.env.PAPERCLIP_QA_FILE_OWNER_PYTHON;
  else process.env.PAPERCLIP_QA_FILE_OWNER_PYTHON = priorPython;
  if (priorStorageProvider === undefined) delete process.env.PAPERCLIP_STORAGE_PROVIDER;
  else process.env.PAPERCLIP_STORAGE_PROVIDER = priorStorageProvider;
  if (priorStorageLocalDir === undefined) delete process.env.PAPERCLIP_STORAGE_LOCAL_DIR;
  else process.env.PAPERCLIP_STORAGE_LOCAL_DIR = priorStorageLocalDir;
  if (priorInstantAdvance === undefined) delete process.env.PAPERCLIP_WORKFLOW_INSTANT_ADVANCE;
  else process.env.PAPERCLIP_WORKFLOW_INSTANT_ADVANCE = priorInstantAdvance;
  admissionAdapter.mockReset();
}, 120_000);

afterEach(async () => {
  if (harness) await drainAdmissionFixtureAdapters(harness.db, expect.getState().currentTestName ?? "admission");
});

const ownerRuntime = () => createQaFileOwnerRuntime({ qaFileOwnerLockRoot: harness.lockRoot, qaFileOwnerPython: PYTHON! });


it("keeps the transaction-scoped root notification object and callback rollback outcome", async () => {
  const scenario = await createAdmissionScenario(harness);
  try {
  const runId = await createUnrelatedPublicRoot(harness, scenario.companyId);
  const markerId = randomUUID(), rollback = new Error("caller rolls back");
  const result = { outcome: "root-result" };
  const returned = await withQaCorrectionFollowupReconcile(harness.db, runId, async rootDb => {
    expect(rootDb).toBe(harness.db);
    expect(currentReplacementRootNotifications(rootDb)).not.toBeNull();
    return result;
  });
  expect(returned).toBe(result);
  expect(currentReplacementRootNotifications(harness.db)).toBeNull();
  const callbackError = new Error("root callback error");
  await expect(withQaCorrectionFollowupReconcile(harness.db, runId, async () => { throw callbackError; }))
    .rejects.toBe(callbackError);
  expect(currentReplacementRootNotifications(harness.db)).toBeNull();
  await expect(harness.db.transaction(async tx => withQaCorrectionFollowupReconcile(tx as unknown as Db, runId, async rootDb => {
    expect(rootDb).toBe(tx);
    await rootDb.insert(companies).values({ id: markerId, name: "Admission rollback marker",
      issuePrefix: `AM${markerId.slice(0, 8)}` });
    throw rollback;
  }))).rejects.toBe(rollback);
  expect(await harness.peer.select({ id: companies.id }).from(companies).where(eq(companies.id, markerId))).toEqual([]);
  expect(runId).toBeTruthy();
  } finally {
    await scenario.qaCompletion.finish();
  }
});

it("uses statement-fresh READ COMMITTED inventory after a production writer commits while the public root waits", async () => {
  const scenario = await createAdmissionScenario(harness, { count: 2 });
  let preparedUnits: Awaited<ReturnType<typeof writeAdmissionPreparationInTransaction>>[] = [];
  try {
  await expectFreshAdmissionBeforeWriter(harness.peer, scenario);
  const actualBefore = await Promise.all(scenario.units.map(unit => snapshotAttempt(harness.peer, unit)));
  const sortedPaths = scenario.units.map(unit => unit.file).sort();
  const nativeTrace = traceNativeOwnerBegins({ observeLockWait: true });
  let writerOwner: Awaited<ReturnType<ReturnType<typeof ownerRuntime>["begin"]>> | undefined;
  let writerOwnerRecord: NativeOwnerRecord | undefined;
  let publicOwnerRecord: NativeOwnerRecord | undefined;
  try {
    writerOwner = await ownerRuntime().begin(sortedPaths);
    writerOwnerRecord = nativeTrace.records[0];
  } catch (error) {
    nativeTrace.restore();
    throw error;
  }
  const locked = deferred<number>(), write = deferred<void>();
  const writer = harness.db.transaction(async tx => {
    await tx.select({ id: missions.id }).from(missions).where(eq(missions.id, scenario.missionId)).for("update");
    await tx.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.id, scenario.runId)).for("update");
    locked.resolve(await backendPid(tx as unknown as Db));
    await write.promise;
    const stored = [];
    for (const unit of [...scenario.units].reverse()) stored.push(await writeAdmissionPreparationInTransaction(tx, unit));
    return stored;
  });
  const blockerPid = await locked.promise;
  const measuredRoot = traceMeasuredPublicSyncRoot(scenario.runId, nativeTrace);
  const sync = syncWorkflowRunStateWithOutcome(harness.db, scenario.runId);
  const syncAtSettlement = sync.then(outcome => ({ kind: "fulfilled" as const, outcome,
    owners: nativeOwnerEvidence(measuredRoot.records()) }), error => ({ kind: "rejected" as const, error,
    errorEvidence: rootErrorEvidence(error), owners: nativeOwnerEvidence(measuredRoot.records()) }));
  let prepared!: Awaited<typeof writer>;
  let outcome!: Awaited<typeof sync>;
  let blockedRootPid = 0;
  try {
    blockedRootPid = await waitForBlockedBy(harness.peer, blockerPid);
    expect(measuredRoot.transactionPids()).toContain(blockedRootPid);
    await assertBlockedRootWaitingForMissionTransaction(harness.peer, blockedRootPid, blockerPid);

    const unrelated = await createUnrelatedPublicRoot(harness, scenario.companyId);
    await expect(syncWorkflowRunStateWithOutcome(harness.db, unrelated)).resolves.toMatchObject({ kind: "synced" });

    write.resolve();
    prepared = await writer;
    preparedUnits = prepared;
    publicOwnerRecord = await waitForNativeOwnerBegin(nativeTrace.records, sortedPaths, 2);
    expect(writerOwnerRecord?.acquired).toBe(true);
    expect(publicOwnerRecord.acquired).toBe(false);
    expect(publicOwnerRecord.targets).toEqual(sortedPaths);
    expect(publicOwnerRecord.beginSequence).toBeGreaterThan(writerOwnerRecord!.acquiredSequence!);
    const nativeWait = await waitForNativeOwnerLockWait(publicOwnerRecord, sortedPaths[0]!);
    const assertNativeWaitRetainsOnlyTheNativeHolder = () => {
      expect(writerOwnerRecord).toMatchObject({ acquired: true });
      expect(writerOwnerRecord?.exitSequence).toBeUndefined();
      expect(publicOwnerRecord).toMatchObject({ acquired: false });
      expect(publicOwnerRecord?.nativeLockWaits).toContainEqual(nativeWait);
      expect(nativeWait).toMatchObject({ target: sortedPaths[0], acquiredAtObservation: false });
    };
    assertNativeWaitRetainsOnlyTheNativeHolder();
    await harness.peer.transaction(async tx => {
      const missionRows = dbRows<{ id: string }>(await tx.execute(sql`SELECT id FROM missions
        WHERE id = ${scenario.missionId} AND company_id = ${scenario.companyId} FOR UPDATE NOWAIT`));
      const runRows = dbRows<{ id: string }>(await tx.execute(sql`SELECT id FROM workflow_runs
        WHERE id = ${scenario.runId} AND company_id = ${scenario.companyId} AND mission_id = ${scenario.missionId}
        FOR UPDATE NOWAIT`));
      expect(missionRows.map(row => row.id)).toEqual([scenario.missionId]);
      expect(runRows.map(row => row.id)).toEqual([scenario.runId]);
    });
    assertNativeWaitRetainsOnlyTheNativeHolder();
    expect(writerOwner).toBeDefined();
    expect(await writerOwner!.close()).toEqual({ code: 0, signal: null });
    writerOwner = undefined;
    expect(await writerOwnerRecord!.exitPromise).toEqual({ code: 0, signal: null });
    await waitForNativeOwnerAcquired(publicOwnerRecord);
    expect(measuredRoot.records()).toContain(publicOwnerRecord);
    const settled = await syncAtSettlement;
    if (settled.kind === "rejected") throw settled.error;
    outcome = settled.outcome;
    expect(measuredRoot.workCaptured()).toBe(true);
    expect(measuredRoot.sharedAdmissionCalls()).toBeGreaterThan(0);
    expect(settled.owners.omitted).toBe(0);
    expect(settled.owners.records.map(record => record.beginSequence)).toContain(publicOwnerRecord.beginSequence);
    expect(settled.owners.records.length).toBeGreaterThan(0);
    for (const record of settled.owners.records) {
      expect(record.acquired).toBe(true);
      expect(record.exitSequence).not.toBeNull();
      expect(record.exit).toEqual({ code: 0, signal: null });
    }
  } finally {
    write.resolve();
    await writer.catch(() => undefined);
    if (writerOwner) await writerOwner.close().catch(() => undefined);
    await sync.catch(() => undefined);
    measuredRoot.restore();
    nativeTrace.restore();
  }
  await Promise.all(nativeTrace.records.map(record => record.exitPromise).filter(Boolean));
  const successfulOwners = nativeTrace.records.filter(record => record.acquired);
  expect(writerOwnerRecord?.targets).toEqual(sortedPaths);
  expect(publicOwnerRecord?.targets).toEqual(sortedPaths);
  expect(publicOwnerRecord?.acquired).toBe(true);
  const measuredFileOwners = successfulOwners.filter(record => record !== writerOwnerRecord
    && record !== publicOwnerRecord && record.targets.length === 1);
  for (const file of sortedPaths) expect(measuredFileOwners.some(record => record.targets[0] === file)).toBe(true);
  expect(successfulOwners.map(record => record.exit)).toEqual(successfulOwners.map(() => ({ code: 0, signal: null })));
  expect(outcome.kind).toBe("synced");
  expect(prepared.map(unit => unit.preparation!.files.map(file => file.path))).toEqual(
    [...scenario.units].reverse().map(unit => [unit.file]));
  for (const unit of prepared) expect(await readFile(unit.file, "utf8")).toBe(admissionFileBytes.after);
  const actualAfter = await Promise.all(scenario.units.map(unit => snapshotAttempt(harness.peer, unit)));
  scenario.units.forEach((unit, index) => expectAdmissionActualStable(unit, actualBefore[index]!, actualAfter[index]!));

  const completionRows = await harness.peer.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.workflowRunId, scenario.runId),
    eq(workflowTransitionEvents.eventType, QA_REMEDIATION_COMPLETION_EVENT_TYPE)));
  expect(completionRows).toHaveLength(2);
  expect(await listPreparationIds(harness.peer, scenario.runId)).toEqual(prepared.map(unit => unit.preparationEventId!).sort());
  for (const unit of prepared) {
    expect(completionRows.filter(row => row.idempotencyKey === qaRemediationCompletionKey(unit.preparation))).toHaveLength(1);
    await expectExactV2Refire(harness.peer, unit);
  }
  await expectScopedDownstreamProgress(harness.peer, scenario);
  } finally {
    await scenario.qaCompletion.finish();
  }
  const finalCompletions = await harness.peer.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.workflowRunId, scenario.runId),
    eq(workflowTransitionEvents.eventType, QA_REMEDIATION_COMPLETION_EVENT_TYPE)));
  expect(finalCompletions).toHaveLength(2);
  for (const unit of preparedUnits) {
    expect(finalCompletions.filter(row => row.idempotencyKey === qaRemediationCompletionKey(unit.preparation))).toHaveLength(1);
    expect(unit.adapterEntries.validatedV2Refires).toBe(1);
    await expectExactV2Refire(harness.peer, unit);
    expect(await readFile(unit.file, "utf8")).toBe(admissionFileBytes.after);
  }
  expect(await harness.peer.select().from(agentWakeupRequests)
    .where(eq(agentWakeupRequests.workflowStepRunId, scenario.downstreamProgress.stepRun.id))).toHaveLength(1);
});

it("reconciles exact current B1 preparations under the union owner before the same public sync advances a dependent step", async () => {
  const scenario = await createAdmissionScenario(harness, { count: 2 });
  let preparedUnits: AdmissionUnit[] = [];
  try {
  const downstream = scenario.downstreamProgress;
  expect(downstream.stepRun).toMatchObject({ workflowRunId: scenario.runId, status: "pending", issueId: downstream.issueId });
  const [downstreamIssue] = await harness.peer.select().from(issues).where(eq(issues.id, downstream.issueId));
  expect(downstreamIssue).toMatchObject({ companyId: scenario.companyId, missionId: scenario.missionId,
    assigneeAgentId: scenario.authorId, originKind: "workflow_execution", originRunId: scenario.runId, status: "todo" });
  await expectFreshAdmissionBeforeWriter(harness.peer, scenario);
  expect(await harness.peer.select().from(agentWakeupRequests)
    .where(eq(agentWakeupRequests.workflowStepRunId, downstream.stepRun.id))).toEqual([]);
  const units: AdmissionUnit[] = [];
  for (const unit of scenario.units) units.push(await prepareAdmissionUnit(harness, unit));
  preparedUnits = units;
  const actualBefore = await Promise.all(units.map(unit => snapshotAttempt(harness.peer, unit)));
  const sortedPaths = units.map(unit => unit.file).sort();
  const blocker = await beginMissionBlock(harness.db, scenario.companyId, scenario.missionId);
  const nativeTrace = traceNativeOwnerBegins();
  const sync = syncWorkflowRunStateWithOutcome(harness.db, scenario.runId);
  let outcome!: Awaited<typeof sync>;
  let unionOwner: NativeOwnerRecord | undefined;
  let blockedRootPid = 0;
  try {
    try {
      unionOwner = await waitForNativeOwnerBegin(nativeTrace.records, sortedPaths, 1);
      await waitForNativeOwnerAcquired(unionOwner);
      expect(unionOwner.acquired).toBe(true);
      blockedRootPid = await waitForBlockedBy(harness.peer, blocker.pid);
      await assertBlockedRootWaitingForMissionTransaction(harness.peer, blockedRootPid, blocker.pid);
      await observeNativeLockWait(ownerRuntime(), units[0]!.file);
      await observeNativeLockWait(ownerRuntime(), units[1]!.file);
      const unrelated = await createUnrelatedPublicRoot(harness, scenario.companyId);
      await expect(syncWorkflowRunStateWithOutcome(harness.db, unrelated)).resolves.toMatchObject({ kind: "synced" });
    } finally {
      blocker.release();
      await blocker.done;
    }
    outcome = await sync;
  } finally {
    await sync.catch(() => undefined);
    nativeTrace.restore();
  }

  const successfulOwners = nativeTrace.records.filter(record => record.acquired);
  await Promise.all(successfulOwners.map(record => record.exitPromise));
  expect(outcome.kind).toBe("synced");
  expect(unionOwner?.targets).toEqual(sortedPaths);
  expect(unionOwner?.acquired).toBe(true);
  const measuredFileOwners = successfulOwners.filter(record => record !== unionOwner && record.targets.length === 1);
  for (const file of sortedPaths) expect(measuredFileOwners.some(record => record.targets[0] === file)).toBe(true);
  expect(successfulOwners.every(record => JSON.stringify(record.targets) === JSON.stringify([...record.targets].sort()))).toBe(true);
  expect(successfulOwners.map(record => record.exit)).toEqual(successfulOwners.map(() => ({ code: 0, signal: null })));
  for (const record of measuredFileOwners) expect(unionOwner!.exitSequence).toBeLessThan(record.beginSequence);

  const actualAfter = await Promise.all(units.map(unit => snapshotAttempt(harness.peer, unit)));
  units.forEach((unit, index) => expectAdmissionActualStable(unit, actualBefore[index]!, actualAfter[index]!));
  const completions = await harness.peer.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.workflowRunId, scenario.runId),
    eq(workflowTransitionEvents.eventType, QA_REMEDIATION_COMPLETION_EVENT_TYPE)));
  expect(completions).toHaveLength(2);
  for (const unit of units) {
    const matching = completions.filter(row => row.idempotencyKey === qaRemediationCompletionKey(unit.preparation!));
    expect(matching).toHaveLength(1);
    expect((matching[0]!.payload as { files: Array<{ file: string; status: string }> }).files).toEqual([
      expect.objectContaining({ file: unit.file, status: "applied" }),
    ]);
    expect(await readFile(unit.file, "utf8")).toBe(admissionFileBytes.after);
    await expectExactV2Refire(harness.peer, unit);
  }
  await expectScopedDownstreamProgress(harness.peer, scenario);
  } finally {
    await scenario.qaCompletion.finish();
  }
  const finalCompletions = await harness.peer.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.workflowRunId, scenario.runId),
    eq(workflowTransitionEvents.eventType, QA_REMEDIATION_COMPLETION_EVENT_TYPE)));
  expect(finalCompletions).toHaveLength(2);
  const downstreamWakes = await harness.peer.select().from(agentWakeupRequests)
    .where(eq(agentWakeupRequests.workflowStepRunId, scenario.downstreamProgress.stepRun.id));
  expect(downstreamWakes).toHaveLength(1);
  expect(scenario.downstreamProgress.adapterEntries).toBe(1);
  for (const unit of preparedUnits) {
    expect(finalCompletions.filter(row => row.idempotencyKey === qaRemediationCompletionKey(unit.preparation!))).toHaveLength(1);
    await expectExactV2Refire(harness.peer, unit);
  }
});

it("holds an unresolved old preparation before a real structural rejection can restart its producer, while unrelated roots progress", async () => {
  const scenario = await createAdmissionScenario(harness);
  try {
  await expectFreshAdmissionBeforeWriter(harness.peer, scenario);
  const unit = await prepareAdmissionUnit(harness, scenario.units[0]!);
  const { gate, requestId, producerToken } = await addStructuralRejection(harness, unit);
  const [currentDefinition] = await harness.peer.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, unit.workflowId));
  if (!currentDefinition) throw new Error("structural fixture current definition missing after graph transition");
  const currentSteps = currentDefinition.stepsJson as Array<Record<string, unknown> & { id: string }>;
  const currentProducerStep = currentSteps.find(step => step.id === unit.producer.stepId);
  const currentQaStep = currentSteps.find(step => step.id === unit.qa.stepId);
  const currentProducerEdges = Array.isArray(currentProducerStep?.conditionalDependencies)
    ? currentProducerStep.conditionalDependencies as Array<Record<string, unknown>> : [];
  const [gateLedger] = await harness.peer.select().from(workflowTransitionEvents).where(eq(
    workflowTransitionEvents.idempotencyKey, `structural-gate-verdict:${unit.companyId}:${gate.id}:${requestId}`));
  expect(currentProducerStep).toBeDefined();
  expect(currentProducerEdges).not.toContainEqual({ stepId: unit.qa.stepId, when: "qa_request_changes", isBackEdge: true, maxIterations: 3 });
  expect(currentQaStep?.dependencies).toEqual([gate.stepId]);
  const before = await snapshotAttempt(harness.peer, unit);
  const [gateBefore] = await harness.peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, gate.id));
  const resultBefore = await getWorkflowExecutionResultSnapshot(harness.peer, scenario.runId);
  expect(gateBefore).toMatchObject({ status: "failed", lastDispatchRequestId: requestId,
    metadata: { structuralGateProducerToken: producerToken, structuralGateProducerGeneration: unit.producer.executionGeneration } });
  expect(gateLedger).toMatchObject({ companyId: unit.companyId, missionId: unit.missionId,
    workflowRunId: unit.runId, workflowStepRunId: gate.id, eventType: "workflow_validation_verdict",
    verdict: "request_changes", decision: "request_changes", reasonCode: "workflow_tool_result",
    idempotencyKey: `structural-gate-verdict:${unit.companyId}:${gate.id}:${requestId}`,
    payload: { workflowRunId: unit.runId, workflowStepRunId: gate.id, requestId, producerToken } });
  const blocker = await beginMissionBlock(harness.db, scenario.companyId, scenario.missionId);
  let syncError: unknown;
  const sync = syncWorkflowRunStateWithOutcome(harness.db, scenario.runId).catch(error => { syncError = error; });
  try {
    await waitForBlockedBy(harness.peer, blocker.pid);
    await observeNativeLockWait(ownerRuntime(), unit.file);
    const unrelated = await createUnrelatedPublicRoot(harness, scenario.companyId);
    await expect(syncWorkflowRunStateWithOutcome(harness.db, unrelated)).resolves.toMatchObject({ kind: "synced" });
  } finally {
    blocker.release();
    await blocker.done;
  }
  await sync;
  expect(syncError).toBeInstanceOf(QaRemediationAdmissionHold);
  expect(syncError).toMatchObject({ reason: "unresolved_after_back_edge_rework", eventIds: [unit.preparationEventId] });
  expect(await snapshotAttempt(harness.peer, unit)).toEqual(before);
  expectAdmissionActualStable(unit, before, await snapshotAttempt(harness.peer, unit));
  const [gateAfter] = await harness.peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, gate.id));
  expect(gateAfter).toEqual(gateBefore);
  expect(await getWorkflowExecutionResultSnapshot(harness.peer, scenario.runId)).toEqual(resultBefore);
  expect(await harness.peer.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.workflowRunId, scenario.runId),
    eq(workflowTransitionEvents.idempotencyKey, qaRemediationCompletionKey(unit.preparation!))))).toHaveLength(0);
  expect(await readFile(unit.file, "utf8")).toBe(admissionFileBytes.before);
  } finally {
    await scenario.qaCompletion.finish();
  }
  expect(await harness.peer.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.workflowRunId, scenario.runId),
    eq(workflowTransitionEvents.eventType, QA_REMEDIATION_COMPLETION_EVENT_TYPE)))).toHaveLength(0);
});

  registerQaRemediationAdmissionRootUnionCases({
    getHarness: () => harness,
    ownerRuntime,
  });

it("commits public-sync C02 deferral and captures the corrected request through the active default tool queue", async () => {
  const source = await createCommitSourceHarness();
  const started = deferred<{ requestId: string; stepRunId: string;
    capture: NonNullable<Awaited<ReturnType<typeof prepareQaArtifactRequest>>> }>(), release = deferred<void>();
  const intervalMs = 812_347;
  let scheduledQueueCallback: (() => void) | undefined;
  const realSetInterval = globalThis.setInterval.bind(globalThis);
  const intervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(((handler: TimerHandler, timeout?: number) => {
    const timer = realSetInterval(handler, timeout);
    if (timeout === intervalMs && typeof handler === "function") scheduledQueueCallback = handler as () => void;
    return timer;
  }) as typeof globalThis.setInterval);
  let scheduler: ReturnType<typeof createNativeWorkflowScheduler> | undefined;
  const executorEntries: Array<{ requestId: string; stepRunId: string }> = [];
  try {
    const s = await makeCommitSource(source.db, source.root, "html");
    if (!s.f.producer.issueId) throw new Error("C02 producer issue identity missing before correction");
    const [sourceProductBaseline] = await source.db.select().from(issueWorkProducts).where(and(
      eq(issueWorkProducts.id, s.productId), eq(issueWorkProducts.companyId, s.p.companyId),
      eq(issueWorkProducts.issueId, s.f.producer.issueId)));
    const [bindingBaseline] = await source.db.select().from(workflowStepOutputBindings).where(and(
      eq(workflowStepOutputBindings.id, s.f.bindingId), eq(workflowStepOutputBindings.companyId, s.p.companyId),
      eq(workflowStepOutputBindings.workflowRunId, s.p.workflowRunId),
      eq(workflowStepOutputBindings.consumerStepRunId, s.f.qa.id),
      eq(workflowStepOutputBindings.referencedStepId, s.f.producer.stepId),
      eq(workflowStepOutputBindings.workProductId, s.productId)));
    if (!sourceProductBaseline || !bindingBaseline) throw new Error("C02 original source product/binding baseline missing");
    const toolName = `admission-c02-${randomUUID()}`;
    const [run] = await source.db.select().from(workflowRuns).where(eq(workflowRuns.id, s.p.workflowRunId));
    const [definition] = await source.db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, run!.workflowId));
    if (!definition) throw new Error("C02 workflow definition missing");
    await source.db.update(workflowDefinitions).set({ stepsJson:
      (definition.stepsJson as Array<Record<string, unknown> & { id: string }>).map(step => step.id === s.f.qa.stepId
        ? { ...step, type: "tool", qaType: "semantic", toolNames: [toolName],
          toolArgs: { html: "{$steps.produce.workProductPath}", manifest: "{$steps.produce.workProductDir}/bundle-index.json" } }
        : step) })
      .where(eq(workflowDefinitions.id, definition.id));
    const tool = await insertToolArtifactDefinition(source.db, s.p.companyId, toolName, s.request.artifactExecution.contract);
    const [verdictHeartbeat] = await source.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, s.f.verdictHeartbeatId));
    await source.db.insert(agentToolGrants).values({ companyId: s.p.companyId, agentId: verdictHeartbeat!.agentId,
      toolId: tool.id, grantedBy: "test" });

    s.f.qa.retryCount = 1;
    s.f.qa.iterationIndex = 2;
    for (const verdict of s.p.authority.verdicts) { verdict.qa.retryCount = 1; verdict.qa.iterationIndex = 2; }
    for (const binding of s.p.bindings) { binding.consumer.retryCount = 1; binding.consumer.iterationIndex = 2; }
    s.request.retryCount = 1;
    s.request.iterationIndex = 2;
    await source.db.update(workflowStepRuns).set({ retryCount: 1, iterationIndex: 2,
      metadata: { artifactExecution: s.request.artifactExecution, toolArtifactRequest: s.request } })
      .where(eq(workflowStepRuns.id, s.f.qa.id));

    const prepared = await beginQaCorrection(source.db, s.p);
    if (prepared.status !== "prepared") throw new Error(`C02 issuance preparation was ${prepared.status}`);
    const measured = await measureQaCorrectionSources(source.db, {
      preparationEventId: prepared.preparationEventId, preparationHash: prepared.preparationHash,
    });
    const stored = await storeQaCorrection(source.db, measured);
    const committed = await commitQaCorrection(source.db, stored);
    if (committed.status !== "committed") throw new Error(`C02 issuance was ${committed.status}`);
    const revision = committed.proof.applied.revisions.find(item => item.sourceProductId === s.productId);
    if (!revision?.bundleManifestRelativePath) throw new Error("C02 correction omitted its issued HTML bundle manifest");
    if (revision.sourceProductId !== s.productId || revision.workProductId === s.productId) {
      throw new Error("C02 correction revision does not preserve its original source-product link");
    }
    expect(committed.proof.applied.bindingChanges).toEqual([{ bindingId: s.f.bindingId,
      fromProductId: s.productId, toProductId: revision.workProductId }]);
    const expectedFiles = commitBuffers("html", "new");
    const expectedHtml = expectedFiles.get(revision.mainRelativePath);
    const expectedManifest = expectedFiles.get(revision.bundleManifestRelativePath);
    if (!expectedHtml || !expectedManifest) throw new Error("C02 corrected HTML fixture bytes are missing");
    const expectedPath = path.join(revision.root, revision.mainRelativePath);
    const expectedManifestPath = path.join(revision.root, revision.bundleManifestRelativePath);

    const legacyRows = await source.db.select().from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.workflowRunId, s.p.workflowRunId));
    const legacyCompanion = legacyRows.find(row => row.id !== committed.appliedEventId
      && row.eventType === "qa_remediation_applied"
      && (row.payload as Record<string, unknown>)?.kind === "qa_remediation_applied");
    if (!legacyCompanion) throw new Error("C02 commit omitted its compatibility audit row");
    const originalCompanionPayload = legacyCompanion.payload as Record<string, unknown>;
    const originalItems = originalCompanionPayload.items;
    if (!Array.isArray(originalItems) || !originalItems.length
      || typeof (originalItems[0] as Record<string, unknown>).replace !== "string") {
      throw new Error("C02 compatibility audit row has no tamperable issued item");
    }
    const firstItem = originalItems[0] as Record<string, unknown>;
    const tamperedPayload = { ...originalCompanionPayload,
      items: [{ ...firstItem, replace: `${firstItem.replace} tampered` }, ...originalItems.slice(1)] };
    await source.db.update(workflowTransitionEvents).set({ payload: tamperedPayload })
      .where(eq(workflowTransitionEvents.id, legacyCompanion.id));
    const negativeNotifications = { agentIds: new Set<string>(), correctionWakeupRequestIds: new Set<string>() };
    let negativeWorkCalls = 0;
    await expect(withQaRemediationSharedAdmission({
      db: source.db, runId: s.p.workflowRunId, ownerRuntime: ownerRuntime(),
      outerNotifications: negativeNotifications, resolutionMap: new Map(), bindResolutionMap: () => undefined,
      driftBudget: { corrections: 0 },
      work: async () => { negativeWorkCalls++; return null; },
    })).rejects.toMatchObject({ reason: "unresolved_legacy_effect" });
    expect(negativeWorkCalls).toBe(0);
    expect(negativeNotifications.agentIds.size).toBe(0);
    expect(negativeNotifications.correctionWakeupRequestIds.size).toBe(0);
    await source.db.update(workflowTransitionEvents).set({ payload: originalCompanionPayload })
      .where(eq(workflowTransitionEvents.id, legacyCompanion.id));

    const followup = committed.proof.followups.find(item => item.target.stepRunId === s.f.qa.id);
    if (!followup) throw new Error("C02 producer did not issue a followup for its exact QA attempt");
    expect(committed.proof.followups.filter(item => item.target.stepRunId === s.f.qa.id)).toHaveLength(1);
    const ref = { companyId: s.p.companyId, workflowRunId: s.p.workflowRunId,
      appliedEventId: committed.appliedEventId, requestId: followup.requestId };
    expect(ref.requestId).not.toBe(s.request.requestId);
    const [issuedAttempt] = await source.db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, s.f.qa.id));
    const originalARequest = issuedAttempt!.metadata?.toolArtifactRequest;
    expect((originalARequest as Record<string, unknown>).qaCorrectionFollowup).toBeUndefined();
    const originalAttemptState = { status: issuedAttempt!.status, executionGeneration: issuedAttempt!.executionGeneration,
      retryCount: issuedAttempt!.retryCount, iterationIndex: issuedAttempt!.iterationIndex,
      lastDispatchRequestId: issuedAttempt!.lastDispatchRequestId, lastDispatchAcceptedAt: issuedAttempt!.lastDispatchAcceptedAt };
    const [producerBefore] = await source.db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, s.f.producer.id));
    const producerIssueId = producerBefore?.issueId;
    const [producerRunBefore] = await source.db.select().from(workflowRuns).where(and(
      eq(workflowRuns.id, s.p.workflowRunId), eq(workflowRuns.companyId, s.p.companyId),
      eq(workflowRuns.missionId, s.p.missionId)));
    if (!producerBefore || typeof producerIssueId !== "string" || !producerIssueId.trim()
      || producerBefore.workflowRunId !== s.p.workflowRunId || producerBefore.id !== s.f.producer.id
      || producerBefore.stepId !== s.f.producer.stepId || producerIssueId !== s.f.producer.issueId
      || producerBefore.executionGeneration !== s.f.producer.executionGeneration
      || producerBefore.retryCount !== s.f.producer.retryCount || producerBefore.iterationIndex !== s.f.producer.iterationIndex
      || !producerRunBefore) {
      throw new Error("C02 producer row lacks its exact company-scoped run and full source attempt");
    }
    const [sourceProductAtCommit] = await source.db.select().from(issueWorkProducts).where(and(
      eq(issueWorkProducts.id, s.productId), eq(issueWorkProducts.companyId, s.p.companyId),
      eq(issueWorkProducts.issueId, producerIssueId)));
    const [bindingAtCommit] = await source.db.select().from(workflowStepOutputBindings).where(and(
      eq(workflowStepOutputBindings.id, s.f.bindingId), eq(workflowStepOutputBindings.companyId, s.p.companyId),
      eq(workflowStepOutputBindings.workflowRunId, s.p.workflowRunId),
      eq(workflowStepOutputBindings.consumerStepRunId, s.f.qa.id),
      eq(workflowStepOutputBindings.referencedStepId, producerBefore.stepId)));
    const appliedAt = new Date(committed.proof.applied.appliedAt);
    const expectedSourceProductAtCommit = { ...sourceProductBaseline, status: "archived", isPrimary: false, updatedAt: appliedAt };
    const expectedBindingAtCommit = { ...bindingBaseline, workProductId: revision.workProductId, resolvedAt: appliedAt };
    if (!sourceProductAtCommit || !isDeepStrictEqual(sourceProductAtCommit, expectedSourceProductAtCommit)
      || !bindingAtCommit || !isDeepStrictEqual(bindingAtCommit, expectedBindingAtCommit)) {
      throw new Error("C02 original source product changed or exact consumer binding did not advance to its correction revision");
    }
    const sourceProductBefore = sourceProductAtCommit;
    const bindingBefore = bindingAtCommit;
    const [producerIssueBefore] = await source.db.select().from(issues).where(and(
      eq(issues.id, producerIssueId), eq(issues.companyId, s.p.companyId), eq(issues.missionId, s.p.missionId)));
    if (!producerIssueBefore) throw new Error("C02 exact company/mission-scoped producer issue snapshot is missing");
    const producerDefinitionStep = normalizeWorkflowStepsForExecution(definition.stepsJson)
      .find(step => step.id === producerBefore.stepId);
    if (!producerDefinitionStep) throw new Error("C02 producer is absent from the normalized source workflow definition");
    const expectedGraphWorkProductRequired = producerDefinitionStep.graphWorkProductRequired === true;
    const [producerHeartbeatBefore] = await source.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, s.f.producerHeartbeatId));
    const producerWakesBefore = await source.db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.workflowStepRunId, s.f.producer.id));
    let executorStarted = false;
    setWorkflowToolStepExecutor(async request => {
      executorStarted = true;
      executorEntries.push({ requestId: request.requestId, stepRunId: request.stepRunId });
      const capture = await prepareQaArtifactRequest({ db: source.db, companyId: request.companyId,
        workflowRunId: request.workflowRunId, stepRunId: request.stepRunId, stepId: request.stepId,
        requestId: request.requestId, parameters: request.args });
      if (!capture) throw new Error("real C02 corrected artifact request capture was not produced");
      started.resolve({ requestId: request.requestId, stepRunId: request.stepRunId, capture });
      await release.promise;
      return { accepted: true };
    });
    const peer = source.connect();
    const wakesBeforeSync = await peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.workflowRunId, s.p.workflowRunId));
    const publicSyncStartedAt = new Date();
    const publicResult = await syncWorkflowRunStateWithOutcome(source.db, s.p.workflowRunId);
    const publicSyncFinishedAt = new Date();
    expect(publicResult.kind).toBe("synced");
    const [deferredAttempt] = await peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, s.f.qa.id));
    const deferredRequest = deferredAttempt!.metadata?.toolArtifactRequest as Record<string, unknown>;
    expect(deferredRequest).toEqual(originalARequest);
    expect(deferredRequest.qaCorrectionFollowup).toBeUndefined();
    expect(deferredAttempt).toMatchObject(originalAttemptState);
    const [deferredRun] = await peer.select().from(workflowRuns).where(eq(workflowRuns.id, s.p.workflowRunId));
    expect(deferredRun!.status).toBe("running");
    expect(executorStarted).toBe(false);
    expect(executorEntries).toEqual([]);
    expect(await peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.workflowRunId, s.p.workflowRunId)))
      .toEqual(wakesBeforeSync);
    expect(await peer.select().from(workflowTransitionEvents).where(eq(
      workflowTransitionEvents.id, committed.appliedEventId))).toHaveLength(1);

    scheduler = createNativeWorkflowScheduler({ db: source.db, mode: "active", tickIntervalMs: intervalMs + 1,
      toolStepQueueIntervalMs: intervalMs, resumeDispatchIntervalMs: intervalMs + 2,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined } });
    scheduler.start();
    expect(scheduledQueueCallback).toBeTypeOf("function");
    const dispatched = await within(started.promise, "active default tool queue request capture");
    expect(dispatched).toMatchObject({ requestId: ref.requestId, stepRunId: s.f.qa.id });
    expect(executorStarted).toBe(true);
    expect(executorEntries).toEqual([{ requestId: ref.requestId, stepRunId: s.f.qa.id }]);
    const captured = dispatched.capture;
    const artifactExecution = captured.snapshot.artifactExecution;
    if (!artifactExecution) throw new Error("C02 request capture omitted the frozen artifact contract");
    const outputPaths = await resolveMissionWorkProductPaths(peer, { companyId: s.p.companyId,
      missionId: s.p.missionId, workflowRunId: s.p.workflowRunId, stepId: s.f.qa.stepId });
    if (!outputPaths?.stepOutputDir) throw new Error("C02 request capture lost its exact step output root");
    const requestRoot = path.join(outputPaths.stepOutputDir, "attempts", String(captured.snapshot.executionGeneration), digest(ref.requestId));
    expect(path.dirname(captured.snapshot.outputRoot)).toBe(requestRoot);
    expect(path.basename(captured.snapshot.outputRoot)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(captured.snapshot.root.path).toBe(captured.snapshot.outputRoot);
    expect(captured.snapshot.outputRootHash).toBe(digest(JSON.stringify({ path: captured.snapshot.root.path,
      dev: captured.snapshot.root.dev, ino: captured.snapshot.root.ino })));
    const capturedHtmlPath = path.join(captured.snapshot.outputRoot, "input", path.basename(expectedPath));
    const capturedManifestPath = path.join(captured.snapshot.outputRoot, "input", path.basename(expectedManifestPath));
    const capturedOutPath = path.join(captured.snapshot.outputRoot, artifactExecution.contract.resultFileName);
    expect(captured.parameters).toEqual({ html: capturedHtmlPath, manifest: capturedManifestPath, out: capturedOutPath });
    expect(captured.snapshot.input).toMatchObject({ workProductId: revision.workProductId, path: expectedPath,
      sha256: digest(expectedHtml), byteSize: expectedHtml.length, mode: "html",
      htmlManifest: { path: expectedManifestPath, sha256: digest(expectedManifest), byteSize: expectedManifest.length } });
    const expectedAsset = expectedFiles.get("assets/nested/pixel.svg");
    const expectedAncillary = expectedFiles.get("source-notes.txt");
    if (!expectedAsset || !expectedAncillary) throw new Error("C02 independent HTML bundle fixture omitted issued assets or ancillary bytes");
    expect(captured.snapshot.input.assetManifest).toEqual([{ fileName: "nested/pixel.svg",
      sha256: digest(expectedAsset), byteSize: expectedAsset.length }]);
    expect(captured.snapshot.input.ancillaryManifest).toEqual([{ fileName: "research",
      sha256: digest(expectedAncillary), byteSize: expectedAncillary.length }]);
    expect(captured.snapshot.qaCorrectionFollowup).toEqual(ref);
    expect(captured.snapshot.requestId).toBe(dispatched.requestId);
    expect(captured.snapshot.requestId).toBe(ref.requestId);
    const capturedHtml = await readFile(capturedHtmlPath);
    const capturedManifest = await readFile(capturedManifestPath);
    const capturedAsset = await readFile(path.join(captured.snapshot.outputRoot, "input", "assets", "nested", "pixel.svg"));
    const capturedAncillary = await readFile(path.join(captured.snapshot.outputRoot, "input", "ancillary", "research"));
    expect(capturedHtml).toEqual(expectedHtml);
    expect(digest(capturedHtml)).toBe(digest(expectedHtml));
    expect(capturedManifest).toEqual(expectedManifest);
    expect(digest(capturedManifest)).toBe(digest(expectedManifest));
    expect(capturedAsset).toEqual(expectedAsset);
    expect(digest(capturedAsset)).toBe(digest(expectedAsset));
    expect(capturedAncillary).toEqual(expectedAncillary);
    expect(digest(capturedAncillary)).toBe(digest(expectedAncillary));

    const [acceptedWhileExecuting] = await peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, s.f.qa.id));
    expect(acceptedWhileExecuting).toMatchObject({ status: "running", lastDispatchRequestId: dispatched.requestId,
      retryCount: originalAttemptState.retryCount, iterationIndex: originalAttemptState.iterationIndex,
      executionGeneration: originalAttemptState.executionGeneration });
    expect(acceptedWhileExecuting!.lastDispatchAcceptedAt).toBeInstanceOf(Date);
    expect((acceptedWhileExecuting!.metadata?.toolInvocation as Record<string, unknown>).requestId).toBe(dispatched.requestId);
    expect((acceptedWhileExecuting!.metadata?.toolArtifactRequest as Record<string, unknown>)).toEqual(captured.snapshot);
    expect((acceptedWhileExecuting!.metadata?.toolQueue as Record<string, unknown>).status).toBe("claimed");
    const [correctedProduct] = await peer.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, revision.workProductId));
    expect(correctedProduct).toMatchObject({ id: revision.workProductId, companyId: s.p.companyId,
      issueId: producerIssueId, provider: "local_file",
      status: "active", externalId: expectedPath,
      metadata: { path: expectedPath, qaCorrection: { appliedEventId: committed.appliedEventId, revisionId: revision.revisionId } } });
    expect(correctedProduct!.createdByRunId).toBeNull();
    expect(correctedProduct!.sourceExecutionGeneration).toBeNull();
    const [correctedBinding] = await peer.select().from(workflowStepOutputBindings).where(and(
      eq(workflowStepOutputBindings.id, s.f.bindingId), eq(workflowStepOutputBindings.companyId, s.p.companyId),
      eq(workflowStepOutputBindings.workflowRunId, s.p.workflowRunId),
      eq(workflowStepOutputBindings.consumerStepRunId, s.f.qa.id),
      eq(workflowStepOutputBindings.referencedStepId, producerBefore.stepId)));
    expect(correctedBinding).toEqual(bindingBefore);
    expect(correctedBinding).toMatchObject({ workProductId: revision.workProductId,
      sourceExecutionGeneration: bindingBefore.sourceExecutionGeneration });

    release.resolve();
    const waitForQueueCount = async (expected: number) => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const state = scheduler!.getState();
        if (state.lastToolStepExecutedCount === expected && state.lastToolStepFailedCount === 0) return state;
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      throw new Error(`active default queue did not report executedCount=${expected}`);
    };
    const acceptedState = await waitForQueueCount(1);
    expect(acceptedState.lastToolStepClaimedCount).toBe(1);
    const acceptedAt = acceptedWhileExecuting!.lastDispatchAcceptedAt;
    scheduledQueueCallback!();
    const duplicateState = await waitForQueueCount(0);
    expect(duplicateState.lastToolStepClaimedCount).toBe(0);
    expect(executorEntries).toEqual([{ requestId: ref.requestId, stepRunId: s.f.qa.id }]);
    const [accepted] = await peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, s.f.qa.id));
    expect(accepted).toMatchObject({ status: "running", lastDispatchRequestId: ref.requestId, retryCount: 1,
      iterationIndex: 2, executionGeneration: s.f.qa.executionGeneration, lastDispatchAcceptedAt: acceptedAt });
    expect((accepted!.metadata?.toolInvocation as Record<string, unknown>).requestId).toBe(ref.requestId);
    expect((accepted!.metadata?.toolArtifactRequest as Record<string, unknown>)).toEqual(captured.snapshot);
    expect(await peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.workflowRunId, s.p.workflowRunId)))
      .toEqual(wakesBeforeSync);
    const [producerAfter] = await peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, s.f.producer.id));
    const [producerHeartbeatAfter] = await peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, s.f.producerHeartbeatId));
    const producerWakesAfter = await peer.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.workflowStepRunId, s.f.producer.id));
    const [sourceProductAfter] = await peer.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, s.productId));
    const [bindingAfter] = await peer.select().from(workflowStepOutputBindings).where(eq(workflowStepOutputBindings.id, s.f.bindingId));
    const producerPreservationView = (step: typeof workflowStepRuns.$inferSelect) => ({ ...step,
      startedAt: null, completedAt: null, dispatchReadyAt: null,
      metadata: Object.fromEntries(Object.entries(step.metadata ?? {}).filter(([key]) => key !== "graphWorkProductRequired")) });
    expect(producerPreservationView(producerAfter!)).toEqual(producerPreservationView(producerBefore));
    expect(producerAfter!.metadata?.graphWorkProductRequired).toBe(expectedGraphWorkProductRequired);
    const sourceStartedAt = producerBefore.startedAt ?? producerIssueBefore.startedAt;
    if (sourceStartedAt) expect(producerAfter!.startedAt?.getTime()).toBe(sourceStartedAt.getTime());
    else {
      expect(producerAfter!.startedAt).toBeInstanceOf(Date);
      expect(producerAfter!.startedAt!.getTime()).toBeGreaterThanOrEqual(publicSyncStartedAt.getTime());
      expect(producerAfter!.startedAt!.getTime()).toBeLessThanOrEqual(publicSyncFinishedAt.getTime());
    }
    if (producerIssueBefore.completedAt) expect(producerAfter!.completedAt?.getTime()).toBe(producerIssueBefore.completedAt.getTime());
    else {
      expect(producerAfter!.completedAt).toBeInstanceOf(Date);
      expect(producerAfter!.completedAt!.getTime()).toBeGreaterThanOrEqual(publicSyncStartedAt.getTime());
      expect(producerAfter!.completedAt!.getTime()).toBeLessThanOrEqual(publicSyncFinishedAt.getTime());
    }
    if (producerBefore.dispatchReadyAt) {
      expect(producerAfter!.dispatchReadyAt?.getTime()).toBe(producerBefore.dispatchReadyAt.getTime());
    } else {
      expect(producerAfter!.dispatchReadyAt).toBeInstanceOf(Date);
      expect(producerAfter!.dispatchReadyAt!.getTime()).toBeGreaterThanOrEqual(publicSyncStartedAt.getTime());
      expect(producerAfter!.dispatchReadyAt!.getTime()).toBeLessThanOrEqual(publicSyncFinishedAt.getTime());
    }
    expect(producerHeartbeatAfter).toEqual(producerHeartbeatBefore);
    expect(producerWakesAfter).toEqual(producerWakesBefore);
    expect(sourceProductAfter).toEqual(sourceProductBefore);
    expect(bindingAfter).toEqual(correctedBinding);
  } finally {
    release.resolve();
    scheduler?.stop();
    intervalSpy.mockRestore();
    setWorkflowToolStepExecutor(null);
    await source.close();
  }
}, 120_000);
