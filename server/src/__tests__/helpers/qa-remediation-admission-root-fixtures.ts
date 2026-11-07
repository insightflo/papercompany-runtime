// Admission-root evidence and expectation helpers moved out of
// qa-remediation-admission-root.test.ts (T16d, file <=1000 lines). Bodies are verbatim;
// each helper receives the db/unit/scenario it needs and captures no module state.
import { readFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { expect, vi } from "vitest";
import { agentWakeupRequests, heartbeatRuns, issueWorkProducts, issues, workflowStepRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import * as followupReconcileModule from "../../services/workflow/control-flow/qa-correction-followup-reconcile.js";
import * as admissionRootModule from "../../services/workflow/control-flow/qa-remediation-admission-root.js";
import { QA_REMEDIATION_COMPLETION_EVENT_TYPE, qaRemediationCompletionKey, legacyQaRemediationRefireWakeKey } from "../../services/workflow/control-flow/qa-remediation-completion.js";
import { qaRemediationRefireV2WakeKey, validateQaRemediationCompletionEvidence } from "../../services/workflow/control-flow/qa-remediation-completion-evidence.js";
import { readWorkflowAttemptProof } from "../../services/heartbeat-finalization/workflow-attempt-proof.js";
import { assertAdmissionActualDrained, type AdmissionUnit, createAdmissionScenario, listPreparationIds, admissionFileBytes, backendPid, traceNativeOwnerBegins, waitForAdmissionDownstreamActual, type NativeOwnerRecord } from "./qa-remediation-admission-public-fixture.js";

export function traceMeasuredPublicSyncRoot(runId: string, nativeTrace: ReturnType<typeof traceNativeOwnerBegins>) {
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

export function nativeOwnerEvidence(records: readonly NativeOwnerRecord[]) {
  return { records: records.slice(0, 64).map(record => ({ targets: [...record.targets], beginSequence: record.beginSequence,
    acquired: record.acquired, acquiredSequence: record.acquiredSequence ?? null,
    exitSequence: record.exitSequence ?? null, exit: record.exit ?? null,
    nativeLockWaits: [...(record.nativeLockWaits ?? [])] })), omitted: Math.max(0, records.length - 64) };
}

export function rootErrorEvidence(error: unknown) {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : null;
  return { name: error instanceof Error ? error.name : "Error",
    message: (error instanceof Error ? error.message : String(error)).slice(0, 600),
    reason: typeof value?.reason === "string" ? value.reason.slice(0, 200) : null,
    eventIds: Array.isArray(value?.eventIds) ? value.eventIds.filter((id): id is string => typeof id === "string").slice(0, 64) : [] };
}
export async function snapshotAttempt(db: Db, unit: AdmissionUnit) {
  const [producer] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, unit.producer.id));
  const [qa] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, unit.qa.id));
  const [producerHeartbeat] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, unit.producerHeartbeatRunId));
  const [producerWakeup] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, unit.producerWakeupRequestId));
  const [producerProduct] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, unit.producerProduct.id));
  const [automaticQaHeartbeat] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, unit.automaticQaHeartbeatRunId));
  const [automaticQaWakeup] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, unit.automaticQaWakeupRequestId));
  return { producer, qa, producerHeartbeat, producerWakeup, producerProduct, automaticQaHeartbeat, automaticQaWakeup };
}

export function expectAdmissionActualStable(unit: AdmissionUnit, before: Awaited<ReturnType<typeof snapshotAttempt>>,
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

export async function expectFreshAdmissionBeforeWriter(db: Db, scenario: Awaited<ReturnType<typeof createAdmissionScenario>>) {
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

export async function expectExactV2Refire(db: Db, unit: AdmissionUnit) {
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

export async function expectScopedDownstreamProgress(db: Db, scenario: Awaited<ReturnType<typeof createAdmissionScenario>>) {
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
