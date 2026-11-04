import { randomUUID } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray, is, sql } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  agentToolGrants, agentWakeupRequests, companies, heartbeatRuns, instanceSettings, issueWorkProducts, issues, missions, workflowDefinitions,
  workflowRecoveryAuthorities, workflowRuns, workflowStepOutputBindings, workflowStepRuns, workflowTransitionEvents, type Db,
} from "@paperclipai/db";
import { currentReplacementRootNotifications } from "../services/issue-assignment-wakeup.js";
import { withQaCorrectionFollowupReconcile } from "../services/workflow/control-flow/qa-correction-followup-reconcile.js";
import * as followupReconcileModule from "../services/workflow/control-flow/qa-correction-followup-reconcile.js";
import { QaRemediationAdmissionHold, withQaRemediationSharedAdmission } from "../services/workflow/control-flow/qa-remediation-admission-root.js";
import * as admissionRootModule from "../services/workflow/control-flow/qa-remediation-admission-root.js";
import { createQaFileOwnerRuntime } from "../services/workflow/control-flow/qa-remediation-runtime.js";
import { QA_REMEDIATION_COMPLETION_EVENT_TYPE, qaRemediationCompletionKey,
  legacyQaRemediationRefireWakeKey } from "../services/workflow/control-flow/qa-remediation-completion.js";
import { QA_REMEDIATION_PREPARATION_EVENT_TYPE, parseQaRemediationPreparation,
  qaRemediationPreparationKey } from "../services/workflow/control-flow/qa-remediation-preparation-contract.js";
import { hashQaCorrectionPayload } from "../services/workflow/control-flow/qa-correction-contract.js";
import { qaRemediationRefireV2WakeKey, validateQaRemediationCompletionEvidence }
  from "../services/workflow/control-flow/qa-remediation-completion-evidence.js";
import { readWorkflowAttemptProof } from "../services/heartbeat-finalization/workflow-attempt-proof.js";
import { resolveMissionWorkProductPaths } from "../services/work-products/output-paths.js";
import { beginQaCorrection } from "../services/workflow/control-flow/qa-correction-prepare.js";
import { measureQaCorrectionSources } from "../services/workflow/control-flow/qa-correction-measure.js";
import { storeQaCorrection } from "../services/workflow/control-flow/qa-correction-storage.js";
import { commitQaCorrection } from "../services/workflow/control-flow/qa-correction-commit.js";
import { createNativeWorkflowScheduler } from "../services/workflow/native-scheduler.js";
import { discoverQaRemediationWorkflowScope } from "../services/workflow/control-flow/qa-remediation-admission-root.js";
import { getWorkflowExecutionResultSnapshot, syncWorkflowRunStateWithOutcome, setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";
import { normalizeWorkflowStepsForExecution } from "../services/workflow/execution-steps.js";
import { prepareQaArtifactRequest } from "../services/workflow/qa-artifact-request.js";
import { digest } from "../services/workflow/artifact-files.js";
import { commitBuffers } from "./helpers/c02-fixture.js";
import { PYTHON, deferred, within } from "./helpers/qa-remediation-parent-death-harness.js";
import {
  addStructuralRejection, assertAdmissionActualDrained, assertBlockedRootWaitingForMissionTransaction,
  type AdmissionHarness, type AdmissionUnit, type ReplacementAdmissionObserver, type ReplacementLifecycleCheckpoint,
  executeAdmissionFixtureAdapter, captureReplacementAdmissionFailureSnapshot,
  createAdmissionHarness, createAdmissionScenario, createReplacementAdmissionPair, createUnrelatedPublicRoot, insertToolArtifactDefinition,
  listPreparationIds,
  prepareAdmissionUnit, writeAdmissionPreparationInTransaction, drainAdmissionFixtureAdapters, admissionFileBytes, backendPid, dbRows,
  beginMissionBlock, observeNativeLockWait, traceNativeOwnerBegins, waitForBackendGone, waitForBackendQuery,
  waitForAdmissionDownstreamActual, waitForBlockedBy, waitForNativeOwnerAcquired, waitForNativeOwnerBegin,
  waitForNativeOwnerLockWait, type NativeOwnerRecord,
} from "./helpers/qa-remediation-admission-public-fixture.js";
import { createCommitSourceHarness, makeCommitSource } from "./qa-correction-commit-fixture.js";

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

function traceMeasuredPublicSyncRoot(runId: string, nativeTrace: ReturnType<typeof traceNativeOwnerBegins>) {
  const scopedCallbacks = new WeakSet<object>(), transactionPids: number[] = [];
  let measuredWork: unknown, sharedAdmissionCalls = 0;
  const realFollowup = followupReconcileModule.withQaCorrectionFollowupReconcile;
  const followupSpy = vi.spyOn(followupReconcileModule, "withQaCorrectionFollowupReconcile").mockImplementation((db, candidateRunId, sync) => {
    if (candidateRunId === runId && measuredWork === undefined) measuredWork = sync;
    return realFollowup(db, candidateRunId, sync);
  });
  const realAdmission = admissionRootModule.withQaRemediationSharedAdmission;
  const admissionSpy = vi.spyOn(admissionRootModule, "withQaRemediationSharedAdmission").mockImplementation(input => {
    if (input.runId !== runId || input.work !== measuredWork || measuredWork === undefined) return realAdmission(input);
    sharedAdmissionCalls++;
    const originalDb = input.db;
    const scopedDb = new Proxy(originalDb, { get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "transaction" && typeof value === "function") {
        const transaction = value.bind(target) as typeof originalDb.transaction;
        return ((...args: Parameters<typeof transaction>) => {
          const [callback, ...config] = args;
          return transaction(async tx => {
            transactionPids.push(await backendPid(tx as unknown as Db));
            return callback(tx);
          }, ...config);
        }) as typeof originalDb.transaction;
      }
      return typeof value === "function" ? value.bind(target) : value;
    } });
    type OwnerEventHandler = NonNullable<NonNullable<Parameters<typeof input.ownerRuntime.begin>[1]>["onEvent"]>;
    const ownerRuntime = { ...input.ownerRuntime, begin: (targets: readonly string[], options?: Parameters<typeof input.ownerRuntime.begin>[1]) => {
      const onEvent: OwnerEventHandler = event => options?.onEvent?.(event);
      scopedCallbacks.add(onEvent);
      return input.ownerRuntime.begin(targets, { ...options, onEvent });
    } };
    return realAdmission({ ...input, db: scopedDb, ownerRuntime });
  });
  return {
    records: () => nativeTrace.records.filter(record => record.sourceOnEvent && scopedCallbacks.has(record.sourceOnEvent)),
    transactionPids: () => [...transactionPids],
    sharedAdmissionCalls: () => sharedAdmissionCalls,
    workCaptured: () => measuredWork !== undefined,
    restore: () => { admissionSpy.mockRestore(); followupSpy.mockRestore(); },
  };
}

function nativeOwnerEvidence(records: readonly NativeOwnerRecord[]) {
  return { records: records.slice(0, 64).map(record => ({ targets: [...record.targets], beginSequence: record.beginSequence,
    acquired: record.acquired, acquiredSequence: record.acquiredSequence ?? null,
    exitSequence: record.exitSequence ?? null, exit: record.exit ?? null,
    nativeLockWaits: [...(record.nativeLockWaits ?? [])] })), omitted: Math.max(0, records.length - 64) };
}

function rootErrorEvidence(error: unknown) {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : null;
  return { name: error instanceof Error ? error.name : "Error",
    message: (error instanceof Error ? error.message : String(error)).slice(0, 600),
    reason: typeof value?.reason === "string" ? value.reason.slice(0, 200) : null,
    eventIds: Array.isArray(value?.eventIds) ? value.eventIds.filter((id): id is string => typeof id === "string").slice(0, 64) : [] };
}

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

async function snapshotAttempt(db: Db, unit: AdmissionUnit) {
  const [producer] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, unit.producer.id));
  const [qa] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, unit.qa.id));
  const [producerHeartbeat] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, unit.producerHeartbeatRunId));
  const [producerWakeup] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, unit.producerWakeupRequestId));
  const [producerProduct] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, unit.producerProduct.id));
  const [automaticQaHeartbeat] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, unit.automaticQaHeartbeatRunId));
  const [automaticQaWakeup] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, unit.automaticQaWakeupRequestId));
  return { producer, qa, producerHeartbeat, producerWakeup, producerProduct, automaticQaHeartbeat, automaticQaWakeup };
}

function expectAdmissionActualStable(unit: AdmissionUnit, before: Awaited<ReturnType<typeof snapshotAttempt>>,
  after: Awaited<ReturnType<typeof snapshotAttempt>>) {
  expect(after.producer).toEqual(before.producer);
  expect(after.producerHeartbeat).toEqual(before.producerHeartbeat);
  expect(after.producerWakeup).toEqual(before.producerWakeup);
  expect(after.producerProduct).toEqual(before.producerProduct);
  expect(after.automaticQaHeartbeat).toEqual(before.automaticQaHeartbeat);
  expect(after.automaticQaWakeup).toEqual(before.automaticQaWakeup);
  expect(after.qa).toMatchObject({ id: before.qa.id, executionGeneration: before.qa.executionGeneration,
    retryCount: before.qa.retryCount, iterationIndex: before.qa.iterationIndex });
  expect(unit.adapterEntries).toMatchObject({ producer: 1, automaticQa: 1 });
}

async function expectFreshAdmissionBeforeWriter(db: Db, scenario: Awaited<ReturnType<typeof createAdmissionScenario>>) {
  expect(await listPreparationIds(db, scenario.runId)).toEqual([]);
  expect(await db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, scenario.companyId), eq(workflowTransitionEvents.workflowRunId, scenario.runId),
    eq(workflowTransitionEvents.eventType, QA_REMEDIATION_COMPLETION_EVENT_TYPE)))).toEqual([]);
  const heartbeatIds = new Set<string>();
  for (const unit of scenario.units) {
    expect(await readFile(unit.file, "utf8")).toBe(admissionFileBytes.before);
    expect(unit.preparationEventId).toBeUndefined();
    expect(unit.adapterEntries).toMatchObject({ producer: 1, automaticQa: 1, validatedV2Refires: 0, v2RefireWakeIds: [] });
    expect(await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.workflowStepRunId, scenario.downstreamProgress.stepRun.id))).toEqual([]);
    expect(heartbeatIds.has(unit.producerHeartbeatRunId)).toBe(false);
    heartbeatIds.add(unit.producerHeartbeatRunId);
    await assertAdmissionActualDrained(db, unit);
    const officialVerdicts = await db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, unit.companyId), eq(workflowTransitionEvents.workflowRunId, unit.runId),
      eq(workflowTransitionEvents.workflowStepRunId, unit.qa.id), eq(workflowTransitionEvents.issueId, unit.qaIssue.id),
      eq(workflowTransitionEvents.eventType, "workflow_validation_verdict")));
    const [qaHeartbeat] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, unit.automaticQaHeartbeatRunId));
    const [qaIssue] = await db.select().from(issues).where(eq(issues.id, unit.qaIssue.id));
    expect(officialVerdicts).toHaveLength(1);
    expect(officialVerdicts[0]).toMatchObject({ id: unit.verdictEventId,
      heartbeatRunId: unit.automaticQaHeartbeatRunId, verdict: "request_changes",
      decision: "request_changes", reason: "workflow_api" });
    expect(unit.verdictHeartbeatId).toBe(unit.automaticQaHeartbeatRunId);
    expect(unit.qa.status).toBe("completed");
    expect(qaIssue).toMatchObject({ id: unit.qaIssue.id, status: "done" });
    expect(qaHeartbeat).toMatchObject({ id: unit.automaticQaHeartbeatRunId,
      workflowStepRunId: unit.qa.id, status: "running", finishedAt: null });
    const v2Key = `qa-remediation-refire-v2:${unit.companyId}:${unit.runId}:${unit.producer.id}:${unit.qa.id}:${unit.verdictEventId}`;
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, v2Key))).toEqual([]);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey,
      legacyQaRemediationRefireWakeKey(unit.runId, unit.qa.id)))).toEqual([]);
  }
  expect(heartbeatIds.size).toBe(scenario.units.length);
}

async function expectExactV2Refire(db: Db, unit: AdmissionUnit) {
  if (!unit.preparation) throw new Error(`v2 completion proof missing preparation for ${unit.qa.id}`);
  const key = qaRemediationCompletionKey(unit.preparation);
  const completions = await db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, unit.companyId), eq(workflowTransitionEvents.workflowRunId, unit.runId),
    eq(workflowTransitionEvents.eventType, QA_REMEDIATION_COMPLETION_EVENT_TYPE),
    eq(workflowTransitionEvents.idempotencyKey, key)));
  expect(completions).toHaveLength(1);
  const checked = await validateQaRemediationCompletionEvidence(db, completions[0]!, unit.preparation);
  if (!checked.ok) throw new Error(`v2 completion evidence failed validation: ${checked.reason}`);
  const verdict = unit.preparation.verdicts.find(row => row.eventId === unit.verdictEventId
    && row.qa.stepRunId === unit.qa.id && row.qa.issueId === unit.qaIssue.id);
  if (!verdict) throw new Error(`v2 completion source verdict missing for ${unit.qa.id}`);
  const receipts = checked.completion.wakes.filter(row => row.kind === "v2_refire"
    && row.stepRunId === unit.qa.id && row.sourceVerdictEventId === verdict.eventId);
  expect(receipts).toHaveLength(1);
  const receipt = receipts[0]!;
  const wakeKey = qaRemediationRefireV2WakeKey(unit.preparation, unit.qa.id, verdict.eventId);
  expect(receipt).toMatchObject({ idempotencyKey: wakeKey, agentId: unit.verifierId, issueId: unit.qaIssue.id,
    stepRunId: unit.qa.id, stepId: unit.qa.stepId, executionGeneration: unit.qa.executionGeneration,
    sourceVerdictEventId: verdict.eventId });
  const byKey = await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, unit.companyId), eq(agentWakeupRequests.idempotencyKey, wakeKey)));
  expect(byKey).toHaveLength(1);
  const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.wakeupRequestId));
  expect(wake).toMatchObject({ id: receipt.wakeupRequestId, companyId: unit.companyId, agentId: unit.verifierId,
    issueId: unit.qaIssue.id, missionId: unit.missionId, workflowRunId: unit.runId,
    workflowStepRunId: unit.qa.id, workflowExecutionGeneration: unit.qa.executionGeneration,
    reason: "workflow_step_runnable", requestKind: "workflow_resume", idempotencyKey: wakeKey });
  expect((wake!.payload as Record<string, unknown>)).toMatchObject({ mutation: "workflow_resume",
    qaRemediationCompletion: { preparationEventId: unit.preparation.preparationId, sourceVerdictEventId: verdict.eventId } });
  const proof = readWorkflowAttemptProof(wake!);
  expect(proof).toMatchObject({ companyId: unit.companyId, agentId: unit.verifierId, missionId: unit.missionId,
    workflowRunId: unit.runId, issueId: unit.qaIssue.id, stepRunId: unit.qa.id,
    executionGeneration: unit.qa.executionGeneration, retryCount: unit.qa.retryCount, iterationIndex: unit.qa.iterationIndex,
    wakeupRequestId: wake!.id });
  const [proofStep] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, proof.stepRunId));
  expect(proofStep).toMatchObject({ id: unit.qa.id, workflowRunId: unit.runId, stepId: unit.qa.stepId,
    issueId: unit.qaIssue.id, executionGeneration: unit.qa.executionGeneration,
    retryCount: unit.qa.retryCount, iterationIndex: unit.qa.iterationIndex });
  expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey,
    legacyQaRemediationRefireWakeKey(unit.runId, unit.qa.id)))).toEqual([]);
  return { completion: completions[0]!, receipt, wake: wake! };
}

async function expectScopedDownstreamProgress(db: Db, scenario: Awaited<ReturnType<typeof createAdmissionScenario>>) {
  const progress = scenario.downstreamProgress;
  const actual = await waitForAdmissionDownstreamActual(db, progress);
  expect(progress.adapterEntries).toBe(1);
  expect(progress.actual).toMatchObject({ heartbeatRunId: actual.heartbeat.id, wakeupRequestId: actual.wakeup.id,
    attempt: { stepRunId: progress.stepRun.id, stepId: progress.stepRun.stepId, issueId: progress.issueId },
    stdout: `admission downstream actual ${scenario.runId}/${progress.stepRun.id}` });
  expect(actual.wakeup).toMatchObject({ companyId: scenario.companyId, agentId: scenario.authorId,
    issueId: progress.issueId, missionId: scenario.missionId, reason: "workflow_step_runnable",
    workflowRunId: scenario.runId, workflowStepRunId: progress.stepRun.id,
    workflowExecutionGeneration: actual.step.executionGeneration });
  expect(actual.result).toMatchObject({ stdout: progress.actual!.stdout, stderr: "" });
  const exactWakes = await db.select().from(agentWakeupRequests)
    .where(eq(agentWakeupRequests.workflowStepRunId, progress.stepRun.id));
  expect(exactWakes).toHaveLength(1);
  expect(exactWakes[0]!.id).toBe(actual.wakeup.id);
  return actual;
}

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
});

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
