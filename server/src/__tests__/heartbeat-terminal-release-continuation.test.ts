import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, assets, companies, createDb, heartbeatRunFinalizationSteps, heartbeatRuns,
  instanceSettings, issueAttachments, issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { attemptFullSettlement } from "../services/heartbeat-finalization/settlement.js";
import {
  acknowledgeTerminalReleaseObligation, createTerminalReleaseManifest, readReadyTerminalReleaseContinuation,
  readTerminalReleaseAcknowledgment, readTerminalReleaseManifest, readTerminalReleaseManifestForSource,
  writeTerminalReleaseManifest, TERMINAL_RELEASE_ACK_EVENT_TYPE, type TerminalReleaseManifest,
} from "../services/heartbeat-terminal-release-continuation.js";
import type { HeartbeatActualDrainIdentity } from "../services/heartbeat-actual-drain.js";
import { WORKFLOW_ATTEMPT_PROOF_KEY } from "../services/heartbeat-finalization/workflow-attempt-proof.js";
import { readTerminalContinuationSource, settleTerminalContinuationFromQaSuccessor } from "../services/heartbeat-terminal-successor-settlement.js";
import { hashQaCorrectionPayload } from "../services/workflow/control-flow/qa-correction-contract.js";
import {
  QA_REMEDIATION_COMPLETION_EVENT_TYPE, QA_REMEDIATION_COMPLETION_SCHEMA_VERSION,
  qaRemediationCompletionKey, qaRemediationRefireV2WakeKey,
} from "../services/workflow/control-flow/qa-remediation-completion.js";
import {
  QA_REMEDIATION_PREPARATION_EVENT_TYPE, QA_REMEDIATION_PREPARATION_SCHEMA_VERSION,
  qaRemediationPreparationKey,
} from "../services/workflow/control-flow/qa-remediation-preparation-contract.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip terminal continuation tests: ${support.reason ?? "unsupported"}`);

describeDb("heartbeat terminal release continuation contract", () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;

  async function seedRun() {
    const missionId = randomUUID(), issueId = randomUUID(), workflowId = randomUUID();
    const workflowRunId = randomUUID(), stepRunId = randomUUID(), heartbeatRunId = randomUUID();
    const wakeupRequestId = randomUUID(), now = new Date();
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId, title: "Continuation mission", status: "active" });
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "Continuation workflow", stepsJson: [{ id: "step" }] });
    await db.insert(workflowRuns).values({ id: workflowRunId, companyId, workflowId, missionId, status: "running", triggeredBy: "test" });
    await db.insert(issues).values({ id: issueId, companyId, missionId, title: "Continuation issue" });
    await db.insert(workflowStepRuns).values({ id: stepRunId, workflowRunId, issueId, stepId: "step", status: "completed",
      executionGeneration: 0, retryCount: 0, iterationIndex: 0, metadata: {} });
    await db.insert(agentWakeupRequests).values({ id: wakeupRequestId, companyId, agentId, source: "workflow", reason: "test",
      status: "completed", missionId, issueId, workflowRunId, workflowStepRunId: stepRunId, workflowExecutionGeneration: 0,
      runId: heartbeatRunId, payload: {} });
    await db.insert(heartbeatRuns).values({ id: heartbeatRunId, companyId, agentId, issueId, wakeupRequestId,
      invocationSource: "on_demand", status: "succeeded", finalizationVersion: 1, executionScopeKind: "workflow_step",
      workflowStepRunId: stepRunId, workflowExecutionGeneration: 0, executionEpoch: 0, executionToken: randomUUID(),
      executorOwnerId: "default", executorOwnerLeaseEpoch: 1, executorOwnerLeaseToken: randomUUID(),
      executorOwnerReleasedAt: now, terminalOutcome: "succeeded", terminalDecisionSource: "adapter_success",
      processPid: null, startedAt: now, finishedAt: now, resultJson: { retained: heartbeatRunId },
      retryOfRunId: null, processLossRetryCount: 0 });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, heartbeatRunId));
    const identity: HeartbeatActualDrainIdentity = { companyId, missionId, workflowRunId, dispatchAuthorityVersion: 0,
      workflowStepRunId: stepRunId, stepId: "step", issueId, heartbeatRunId, wakeupRequestId,
      executionGeneration: 0, retryCount: 0, iterationIndex: 0, executionScopeKind: "workflow_step", executionEpoch: 0,
      executionToken: run!.executionToken!, executorOwnerId: "default", ownerLeaseEpoch: 1,
      ownerLeaseToken: run!.executorOwnerLeaseToken!, retryOfRunId: null, processLossRetryCount: 0,
      ancestry: { rootHeartbeatRunId: heartbeatRunId, rootWakeupRequestId: wakeupRequestId } };
    return { run: run!, identity, missionId, issueId, workflowRunId, stepRunId, wakeupRequestId, heartbeatRunId };
  }

  function manifestFor(seed: Awaited<ReturnType<typeof seedRun>>): TerminalReleaseManifest {
    return createTerminalReleaseManifest(seed.identity, agentId, [
      { stage: "issue_promotion", action: { kind: "promote_issue_wakes", companyId, issueId: seed.issueId } },
      { stage: "workflow_evidence_sync", action: { kind: "sync_issue", companyId, issueId: seed.issueId } },
      { stage: "issue_promotion", action: { kind: "promote_agent_queue", companyId, agentId } },
      { stage: "workflow_evidence_sync", action: { kind: "reevaluate_source" } },
    ]);
  }

  async function addReceipt(seed: Awaited<ReturnType<typeof seedRun>>, manifest: TerminalReleaseManifest,
    identity = seed.identity, outcome: "fulfilled" | "rejected" = "fulfilled", rowWakeupRequestId: string | null = null) {
    const source = manifest.source;
    await db.insert(workflowTransitionEvents).values({ companyId: source.companyId, missionId: source.missionId,
      workflowRunId: source.workflowRunId, workflowStepRunId: source.workflowStepRunId, issueId: source.issueId,
      wakeupRequestId: rowWakeupRequestId, heartbeatRunId: source.heartbeatRunId,
      dispatchOwnerHeartbeatRunId: source.heartbeatRunId, executorOwnerId: source.executorOwnerId,
      executionGeneration: source.executionGeneration, eventType: "heartbeat_actual_drained_v1", layer: "heartbeat",
      reason: "actual_adapter_settled_and_cleaned", reasonCode: "actual_drain_observed",
      idempotencyKey: `heartbeat-actual-drained:v1:${source.heartbeatRunId}:${source.identityDigest}`,
      payload: { schemaVersion: "workflow.heartbeat-actual-drain.v1", identity,
        actual: { outcome, observedAt: new Date().toISOString() },
        cleanup: { runtimeServicesRelease: { called: true, succeeded: true },
          heartbeatSettlement: { called: true, succeeded: true },
          resources: { workspaceOperationsSettled: true, runtimeServicesStopped: true, missionRuntimeIdle: true } } } });
  }

  async function seedQaSuccessorSettlement() {
    const seed = await seedRun();
    const sourceAttempt = { stepRunId: seed.stepRunId, stepId: "step", issueId: seed.issueId,
      executionGeneration: 0, retryCount: 0, iterationIndex: 0 };
    const sourceProof = { schemaVersion: 1, companyId, agentId, issueId: seed.issueId, missionId: seed.missionId,
      workflowRunId: seed.workflowRunId, stepRunId: seed.stepRunId, executionGeneration: 0, retryCount: 0,
      iterationIndex: 0, wakeupRequestId: seed.wakeupRequestId, parentHeartbeatRunId: null };
    await db.update(agentWakeupRequests).set({ payload: { [WORKFLOW_ATTEMPT_PROOF_KEY]: sourceProof } })
      .where(eq(agentWakeupRequests.id, seed.wakeupRequestId));
    await db.update(workflowStepRuns).set({ dispatchOwnerHeartbeatRunId: seed.heartbeatRunId,
      dispatchOwnerWakeupRequestId: seed.wakeupRequestId }).where(eq(workflowStepRuns.id, seed.stepRunId));

    const sourceManifest = manifestFor(seed);
    const sourceEvent = await db.transaction(tx => writeTerminalReleaseManifest(tx, sourceManifest));
    await addReceipt(seed, sourceManifest);
    if ((await readTerminalContinuationSource(sourceEvent.eventId, db)).kind !== "ready") {
      throw new Error("original terminal source must start with its retained current owner");
    }
    const alreadyHandled = sourceManifest.obligations.find(item => item.action.kind === "promote_issue_wakes")!;
    const firstAck = await acknowledgeTerminalReleaseObligation(db, sourceEvent.eventId, alreadyHandled.effectKey);
    if (firstAck.kind === "held") throw new Error(firstAck.reason);

    const filePath = "/tmp/c5-terminal-successor-settlement-fixture.txt";
    const items = [{ op: "string_replace" as const, file: filePath, find: "old", replace: "new" }];
    const remediationsHash = hashQaCorrectionPayload(items);
    const verdictEventId = randomUUID();
    const preparation = {
      schemaVersion: QA_REMEDIATION_PREPARATION_SCHEMA_VERSION,
      preparationId: randomUUID(), companyId, missionId: seed.missionId, workflowRunId: seed.workflowRunId,
      dispatchAuthorityVersion: 0, producer: sourceAttempt,
      verdicts: [{ eventId: verdictEventId, heartbeatRunId: seed.heartbeatRunId, qa: sourceAttempt, items, remediationsHash }],
      files: [{ path: filePath, beforeSha256: "a".repeat(64), afterSha256: "b".repeat(64), beforeByteSize: 3, afterByteSize: 3 }],
      preparedAt: new Date().toISOString(),
    };
    const verdictKey = `workflow-validation-verdict:${companyId}:${seed.issueId}:${seed.stepRunId}:run:${seed.heartbeatRunId}`;
    await db.insert(workflowTransitionEvents).values({ id: verdictEventId, companyId, missionId: seed.missionId,
      workflowRunId: seed.workflowRunId, workflowStepRunId: seed.stepRunId, issueId: seed.issueId,
      wakeupRequestId: null, heartbeatRunId: seed.heartbeatRunId, executionGeneration: null,
      eventType: "workflow_validation_verdict", layer: "workflow_validation", decision: "request_changes",
      verdict: "request_changes", reason: "workflow_api", reasonCode: "workflow_api", idempotencyKey: verdictKey,
      payload: { kind: "workflow_validation_verdict", workflowRunId: seed.workflowRunId, stepRunId: seed.stepRunId,
        issueId: seed.issueId, verdict: "request_changes", diagnostics: [], remediations: { items } } });
    await db.insert(workflowTransitionEvents).values({ id: preparation.preparationId, companyId,
      missionId: preparation.missionId, workflowRunId: preparation.workflowRunId,
      workflowStepRunId: preparation.producer.stepRunId, issueId: preparation.producer.issueId,
      heartbeatRunId: null, executionGeneration: preparation.producer.executionGeneration,
      eventType: QA_REMEDIATION_PREPARATION_EVENT_TYPE, layer: "workflow_validation", decision: null,
      verdict: null, reason: "workflow_api", reasonCode: "qa_remediation_prepare",
      idempotencyKey: qaRemediationPreparationKey(preparation), payload: preparation });

    const successorWakeId = randomUUID(), successorHeartbeatId = randomUUID();
    const successorWakeKey = qaRemediationRefireV2WakeKey(preparation, seed.stepRunId, verdictEventId);
    const successorProof = { ...sourceProof, wakeupRequestId: successorWakeId };
    await db.insert(agentWakeupRequests).values({ id: successorWakeId, companyId, agentId, source: "assignment",
      triggerDetail: "system", reason: "workflow_step_runnable", requestedByActorType: "system",
      requestedByActorId: "workflow:qa-remediation", requestKind: "workflow_resume", status: "completed",
      idempotencyKey: successorWakeKey, missionId: seed.missionId, issueId: seed.issueId,
      workflowRunId: seed.workflowRunId, workflowStepRunId: seed.stepRunId, workflowExecutionGeneration: 0,
      runId: successorHeartbeatId, payload: { issueId: seed.issueId, mutation: "workflow_resume",
        missionId: seed.missionId, workflowRunId: seed.workflowRunId, workflowStepRunId: seed.stepRunId,
        qaRemediationCompletion: { preparationEventId: preparation.preparationId, sourceVerdictEventId: verdictEventId },
        [WORKFLOW_ATTEMPT_PROOF_KEY]: successorProof } });
    const successorNow = new Date();
    const successorExecutionToken = randomUUID(), successorLeaseToken = randomUUID();
    await db.insert(heartbeatRuns).values({ id: successorHeartbeatId, companyId, agentId, issueId: seed.issueId,
      wakeupRequestId: successorWakeId, invocationSource: "on_demand", status: "succeeded", finalizationVersion: 1,
      executionScopeKind: "workflow_step", workflowStepRunId: seed.stepRunId, workflowExecutionGeneration: 0,
      executionEpoch: 0, executionToken: successorExecutionToken, executorOwnerId: "default",
      executorOwnerLeaseEpoch: 1, executorOwnerLeaseToken: successorLeaseToken, executorOwnerReleasedAt: successorNow,
      terminalOutcome: "succeeded", terminalDecisionSource: "adapter_success", processPid: null,
      startedAt: successorNow, finishedAt: successorNow, resultJson: { retained: successorHeartbeatId },
      retryOfRunId: null, processLossRetryCount: 0 });

    const completionId = randomUUID();
    const completion = {
      schemaVersion: QA_REMEDIATION_COMPLETION_SCHEMA_VERSION, completionId,
      preparationId: preparation.preparationId, companyId, missionId: seed.missionId,
      workflowRunId: seed.workflowRunId, dispatchAuthorityVersion: 0, producer: sourceAttempt,
      verdicts: [{ eventId: verdictEventId, heartbeatRunId: seed.heartbeatRunId, qa: sourceAttempt, remediationsHash }],
      files: [{ file: filePath, status: "applied" as const, detail: "synthetic focused test publication" }],
      wakes: [{ kind: "v2_refire" as const, wakeupRequestId: successorWakeId, idempotencyKey: successorWakeKey,
        agentId, issueId: seed.issueId, stepRunId: seed.stepRunId, stepId: "step", executionGeneration: 0,
        sourceVerdictEventId: verdictEventId, statusAtCommit: "queued" }],
      completedAt: new Date().toISOString(),
    };
    await db.insert(workflowTransitionEvents).values({ id: completionId, companyId, missionId: seed.missionId,
      workflowRunId: seed.workflowRunId, workflowStepRunId: preparation.producer.stepRunId,
      issueId: preparation.producer.issueId, heartbeatRunId: null, executionGeneration: 0,
      eventType: QA_REMEDIATION_COMPLETION_EVENT_TYPE, layer: "workflow_validation", decision: null,
      verdict: null, reason: "workflow_api", reasonCode: "qa_remediation_complete",
      idempotencyKey: qaRemediationCompletionKey(preparation), payload: completion });

    const successorIdentity: HeartbeatActualDrainIdentity = { ...seed.identity,
      heartbeatRunId: successorHeartbeatId, wakeupRequestId: successorWakeId,
      executionToken: successorExecutionToken, ownerLeaseToken: successorLeaseToken };
    const successorSeed = { ...seed, run: { ...seed.run, id: successorHeartbeatId, executionToken: successorExecutionToken,
      executorOwnerLeaseToken: successorLeaseToken } as typeof seed.run, identity: successorIdentity,
      heartbeatRunId: successorHeartbeatId, wakeupRequestId: successorWakeId };
    const successorManifest = createTerminalReleaseManifest(successorIdentity, agentId,
      sourceManifest.obligations.map(({ stage, action }) => ({ stage, action })));
    const successorEvent = await db.transaction(tx => writeTerminalReleaseManifest(tx, successorManifest));
    await addReceipt(successorSeed, successorManifest, successorIdentity);
    const successorAckIds: string[] = [];
    for (const obligation of successorManifest.obligations) {
      const ack = await acknowledgeTerminalReleaseObligation(db, successorEvent.eventId, obligation.effectKey);
      if (ack.kind === "held") throw new Error(ack.reason);
      successorAckIds.push(ack.eventId);
    }
    const passKey = `workflow-validation-verdict:${companyId}:${seed.issueId}:${seed.stepRunId}:run:${successorHeartbeatId}`;
    await db.insert(workflowTransitionEvents).values({ companyId, missionId: seed.missionId,
      workflowRunId: seed.workflowRunId, workflowStepRunId: seed.stepRunId, issueId: seed.issueId,
      wakeupRequestId: successorWakeId, heartbeatRunId: successorHeartbeatId, executionGeneration: 0,
      eventType: "workflow_validation_verdict", layer: "workflow_validation", decision: "pass", verdict: "pass",
      reason: "workflow_api", reasonCode: "workflow_api", idempotencyKey: passKey,
      payload: { kind: "workflow_validation_verdict", workflowRunId: seed.workflowRunId,
        stepRunId: seed.stepRunId, issueId: seed.issueId, verdict: "pass", diagnostics: [] } });
    await db.update(workflowStepRuns).set({ dispatchOwnerHeartbeatRunId: successorHeartbeatId,
      dispatchOwnerWakeupRequestId: successorWakeId }).where(eq(workflowStepRuns.id, seed.stepRunId));

    const actualRows = await db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents)
      .where(and(eq(workflowTransitionEvents.heartbeatRunId, seed.heartbeatRunId),
        eq(workflowTransitionEvents.eventType, "heartbeat_actual_drained_v1")));
    return { seed, sourceManifest, sourceEventId: sourceEvent.eventId, preparation, verdictEventId, completionId,
      successorWakeId, successorHeartbeatId, successorEventId: successorEvent.eventId, successorAckIds,
      originalEvidenceIds: [sourceEvent.eventId, actualRows[0]!.id, verdictEventId, preparation.preparationId, completionId] };
  }

  async function captureSettlementRows(fixture: Awaited<ReturnType<typeof seedQaSuccessorSettlement>>) {
    const [sourceRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.seed.heartbeatRunId));
    const [sourceStep] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, fixture.seed.stepRunId));
    const [sourceWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, fixture.seed.wakeupRequestId));
    const evidence = await db.select().from(workflowTransitionEvents)
      .where(and(eq(workflowTransitionEvents.companyId, companyId),
        eq(workflowTransitionEvents.workflowRunId, fixture.seed.workflowRunId)));
    const companyAssets = await db.select().from(assets).where(eq(assets.companyId, companyId));
    const attachments = await db.select().from(issueAttachments).where(eq(issueAttachments.companyId, companyId));
    const sourceAcks = await db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.correlationId, fixture.sourceEventId),
      eq(workflowTransitionEvents.eventType, TERMINAL_RELEASE_ACK_EVENT_TYPE)));
    const stepHeartbeats = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.workflowStepRunId, fixture.seed.stepRunId));
    const stepWakes = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.workflowStepRunId, fixture.seed.stepRunId));
    return { sourceRun, sourceStep, sourceWake, evidence, companyAssets, attachments, sourceAcks,
      stepHeartbeats, stepWakes };
  }

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("heartbeat-terminal-continuation-");
    db = createDb(temp.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "ContinuationCo", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Continuation agent", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(instanceSettings).values({ singletonKey: "default", general: {},
      experimental: { enableHeartbeatFinalizationV1: true } } as never);
  }, 60_000);

  afterAll(async () => {
    if (db) await db.$client.end({ timeout: 5 });
    await temp?.cleanup();
  });

  it("holds missing or mismatched exact-source receipts and malformed manifests", async () => {
    const seed = await seedRun(), manifest = manifestFor(seed);
    const written = await db.transaction(tx => writeTerminalReleaseManifest(tx, manifest));
    expect((await readReadyTerminalReleaseContinuation(db, written.eventId)).kind).toBe("held");
    await addReceipt(seed, manifest, { ...seed.identity, dispatchAuthorityVersion: 1 });
    expect((await readReadyTerminalReleaseContinuation(db, written.eventId)).kind).toBe("held");
    await db.update(workflowTransitionEvents).set({ payload: { ...manifest, unknown: true } })
      .where(eq(workflowTransitionEvents.id, written.eventId));
    expect(await readTerminalReleaseManifest(db, written.eventId)).toMatchObject({ kind: "held" });
  });

  it("reuses the unique manifest and acknowledges only an exact receipt-backed obligation", async () => {
    const seed = await seedRun(), manifest = manifestFor(seed);
    const first = await db.transaction(tx => writeTerminalReleaseManifest(tx, manifest));
    const second = await db.transaction(tx => writeTerminalReleaseManifest(tx, manifest));
    expect(second).toEqual({ eventId: first.eventId, created: false });
    const changed = createTerminalReleaseManifest(seed.identity, agentId, [
      ...manifest.obligations.map(({ stage, action }) => ({ stage, action })),
      { stage: "workflow_evidence_sync", action: { kind: "unblock_handback", companyId, issueId: seed.issueId, agentId: null } },
    ]);
    await expect(writeTerminalReleaseManifest(db, changed)).rejects.toThrow("terminal_release_manifest_durable_reentry_mismatch");
    expect(await readTerminalReleaseManifestForSource(db, seed.identity, agentId)).toMatchObject({ kind: "found", eventId: first.eventId });
    await addReceipt(seed, manifest, seed.identity, "rejected");
    expect(await readReadyTerminalReleaseContinuation(db, first.eventId)).toMatchObject({ kind: "ready", actualOutcome: "rejected" });
    const effectKey = manifest.obligations[0]!.effectKey;
    expect(await readTerminalReleaseAcknowledgment(db, first.eventId, effectKey)).toMatchObject({ kind: "pending" });
    const ack = await acknowledgeTerminalReleaseObligation(db, first.eventId, effectKey);
    const replay = await acknowledgeTerminalReleaseObligation(db, first.eventId, effectKey);
    expect(ack.kind).toBe("written");
    if (ack.kind === "held") throw new Error(ack.reason);
    expect(replay).toEqual({ kind: "existing", eventId: ack.eventId });
    expect(await readTerminalReleaseAcknowledgment(db, first.eventId, effectKey)).toMatchObject({ kind: "acknowledged" });
    await db.update(workflowTransitionEvents).set({ payload: { schemaVersion: "papercompany.heartbeat-terminal-release-ack.v1",
      continuationEventId: first.eventId, sourceDigest: manifest.source.identityDigest, effectKey, actualOutcome: "fulfilled" } })
      .where(eq(workflowTransitionEvents.id, ack.eventId));
    expect(await readTerminalReleaseAcknowledgment(db, first.eventId, effectKey)).toMatchObject({ kind: "held" });

    const conflict = await seedRun(), conflictManifest = manifestFor(conflict);
    const conflictEvent = await writeTerminalReleaseManifest(db, conflictManifest);
    await addReceipt(conflict, conflictManifest, conflict.identity, "fulfilled", randomUUID());
    expect(await readReadyTerminalReleaseContinuation(db, conflictEvent.eventId)).toMatchObject({ kind: "held",
      reason: "exact_actual_drain_receipt_malformed_or_mismatched" });
    expect(await readTerminalReleaseAcknowledgment(db, conflictEvent.eventId, conflictManifest.obligations[0]!.effectKey))
      .toMatchObject({ kind: "held", reason: "exact_actual_drain_receipt_malformed_or_mismatched" });

    await db.update(heartbeatRuns).set({ executorOwnerId: "replacement-owner" })
      .where(eq(heartbeatRuns.id, seed.heartbeatRunId));
    expect(await readReadyTerminalReleaseContinuation(db, first.eventId)).toMatchObject({ kind: "held" });
  });

  it("keeps default C settlement done and permits equivalent_failed only for exact retained obligations", async () => {
    const normal = await seedRun();
    expect(await attemptFullSettlement(db, normal.run, new Date())).toBe("settled");
    const normalStages = await db.select().from(heartbeatRunFinalizationSteps)
      .where(eq(heartbeatRunFinalizationSteps.heartbeatRunId, normal.heartbeatRunId));
    expect(normalStages.filter(row => row.stageClass === "C").map(row => row.state).sort()).toEqual(["done", "done"]);
    expect(normalStages.filter(row => row.stageClass === "Q").every(row => row.state === "done")).toBe(true);

    const deferred = await seedRun(), manifest = manifestFor(deferred);
    const event = await writeTerminalReleaseManifest(db, manifest);
    expect(await attemptFullSettlement(db, deferred.run, new Date(), event.eventId)).toBe("settled");
    const stages = await db.select().from(heartbeatRunFinalizationSteps)
      .where(eq(heartbeatRunFinalizationSteps.heartbeatRunId, deferred.heartbeatRunId));
    const cStages = stages.filter(row => row.stageClass === "C");
    expect(cStages).toHaveLength(2);
    for (const row of cStages) {
      expect(row.state).toBe("equivalent_failed");
      expect(row.payload).toMatchObject({ source: "terminal_release_continuation", reason: "terminal_followup_deferred_for_actual_drain",
        continuationEventId: event.eventId });
      expect((row.payload as { effectKeys: string[] }).effectKeys).toEqual(
        manifest.obligations.filter(item => item.stage === row.stageKind).map(item => item.effectKey));
    }
    expect(stages.filter(row => row.stageClass === "Q").every(row => row.state === "done")).toBe(true);
    const [retainedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, deferred.heartbeatRunId));
    expect(retainedRun).toMatchObject({ status: "succeeded", resultJson: { retained: deferred.heartbeatRunId },
      terminalOutcome: "succeeded", wakeupRequestId: deferred.wakeupRequestId, workflowStepRunId: deferred.stepRunId,
      workflowExecutionGeneration: 0, executionToken: deferred.run.executionToken,
      executorOwnerId: deferred.run.executorOwnerId, executorOwnerLeaseEpoch: deferred.run.executorOwnerLeaseEpoch,
      executorOwnerLeaseToken: deferred.run.executorOwnerLeaseToken });
    expect(retainedRun?.settledAt).toBeTruthy();

    const malformed = await seedRun(), malformedManifest = manifestFor(malformed);
    const malformedEvent = await writeTerminalReleaseManifest(db, malformedManifest);
    await db.update(workflowTransitionEvents).set({ payload: { ...malformedManifest,
      obligations: malformedManifest.obligations.filter(item => item.action.kind !== "promote_agent_queue") } })
      .where(eq(workflowTransitionEvents.id, malformedEvent.eventId));
    await expect(attemptFullSettlement(db, malformed.run, new Date(), malformedEvent.eventId)).rejects.toThrow();
    expect(await db.select().from(heartbeatRunFinalizationSteps)
      .where(and(eq(heartbeatRunFinalizationSteps.heartbeatRunId, malformed.heartbeatRunId),
        eq(heartbeatRunFinalizationSteps.stageClass, "C")))).toHaveLength(0);
  });

  it("settles only exact fulfilled V2 QA successor effects and keeps reentry and unknowns inert", async () => {
    const fixture = await seedQaSuccessorSettlement();
    expect(await readTerminalContinuationSource(fixture.sourceEventId, db)).toMatchObject({ kind: "held",
      reason: "terminal_continuation_source_or_authority_changed" });
    const before = await captureSettlementRows(fixture);
    let releaseWriter!: () => void, writerReady!: () => void, writerPid = 0;
    const writerGate = new Promise<void>(resolve => { releaseWriter = resolve; });
    const writerLocked = new Promise<void>(resolve => { writerReady = resolve; });
    const writer = db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '3s'`);
      writerPid = Number((await tx.execute(sql`SELECT pg_backend_pid() AS pid`))[0]!.pid);
      await tx.select({ id: missions.id }).from(missions).where(eq(missions.id, fixture.seed.missionId)).for("no key update");
      await tx.select({ id: workflowRuns.id }).from(workflowRuns)
        .where(eq(workflowRuns.id, fixture.seed.workflowRunId)).for("no key update");
      writerReady();
      await writerGate;
      const [preparation] = await tx.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents)
        .where(eq(workflowTransitionEvents.id, fixture.preparation.preparationId)).for("update");
      expect(preparation?.id).toBe(fixture.preparation.preparationId);
    });
    const writerResult = writer.then(() => null, error => error);
    let settlement: ReturnType<typeof settleTerminalContinuationFromQaSuccessor> | null = null;
    let barrierError: unknown;
    try {
      await Promise.race([writerLocked, writerResult.then(error => {
        throw error ?? new Error("existing-order writer exited before reaching its lock barrier");
      })]);
      settlement = settleTerminalContinuationFromQaSuccessor(db, fixture.sourceEventId);
      await vi.waitFor(async () => {
        const waiters = await db.execute(sql`SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND state = 'active' AND wait_event_type = 'Lock'
            AND ${writerPid} = ANY(pg_blocking_pids(pid)) AND pid <> ${writerPid}
            AND query ILIKE '%missions%'`);
        expect(waiters.length).toBeGreaterThan(0);
      }, { timeout: 5_000, interval: 25 });
    } catch (error) {
      barrierError = error;
    } finally {
      releaseWriter();
    }
    const writerError = await writerResult;
    const settled = settlement ? await settlement : null;
    if (barrierError) throw barrierError;
    expect(writerError).toBeNull();
    expect(settled).toEqual({ kind: "complete" });
    const after = await captureSettlementRows(fixture);
    expect(after.sourceRun).toEqual(before.sourceRun);
    expect(after.sourceStep).toEqual(before.sourceStep);
    expect(after.sourceWake).toEqual(before.sourceWake);
    expect(after.evidence.filter(row => fixture.originalEvidenceIds.includes(row.id)))
      .toEqual(before.evidence.filter(row => fixture.originalEvidenceIds.includes(row.id)));
    expect(after.companyAssets).toEqual(before.companyAssets);
    expect(after.attachments).toEqual(before.attachments);
    expect(after.stepHeartbeats).toEqual(before.stepHeartbeats);
    expect(after.stepWakes).toEqual(before.stepWakes);
    const sourceAckPayloads = after.sourceAcks.map(row => (row.payload as { effectKey: string }).effectKey).sort();
    expect(sourceAckPayloads).toEqual(fixture.sourceManifest.obligations.map(item => item.effectKey).sort());
    expect(after.sourceAcks).toHaveLength(4);
    const settledSnapshot = await captureSettlementRows(fixture);
    expect(await settleTerminalContinuationFromQaSuccessor(db, fixture.sourceEventId)).toEqual({ kind: "complete" });
    expect(await captureSettlementRows(fixture)).toEqual(settledSnapshot);

    const negativeCases = [
      { name: "partial-null original request-changes binding", mutate: async (item: Awaited<ReturnType<typeof seedQaSuccessorSettlement>>) => {
        await db.update(workflowTransitionEvents).set({ wakeupRequestId: null, executionGeneration: 0 })
          .where(eq(workflowTransitionEvents.id, item.verdictEventId));
      } },
      { name: "mismatched populated original request-changes binding", mutate: async (item: Awaited<ReturnType<typeof seedQaSuccessorSettlement>>) => {
        await db.update(workflowTransitionEvents).set({ wakeupRequestId: randomUUID(), executionGeneration: 0 })
          .where(eq(workflowTransitionEvents.id, item.verdictEventId));
      } },
      { name: "missing successor ACK", mutate: async (item: Awaited<ReturnType<typeof seedQaSuccessorSettlement>>) => {
        const obligation = item.sourceManifest.obligations.find(value => value.action.kind === "sync_issue")!;
        const read = await readTerminalReleaseManifest(db, item.successorEventId);
        const successorObligation = read.kind === "found" ? read.manifest.obligations.find(value =>
          value.stage === obligation.stage && JSON.stringify(value.action) === JSON.stringify(obligation.action)) : null;
        if (!successorObligation) throw new Error("successor sync_issue obligation missing from fixture");
        const ack = await readTerminalReleaseAcknowledgment(db, item.successorEventId, successorObligation.effectKey);
        if (ack.kind !== "acknowledged") throw new Error("successor sync_issue ACK missing from fixture");
        await db.delete(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, ack.eventId));
      } },
      { name: "malformed preparation", mutate: async (item: Awaited<ReturnType<typeof seedQaSuccessorSettlement>>) => {
        await db.update(workflowTransitionEvents).set({ payload: { ...item.preparation, unknown: true } })
          .where(eq(workflowTransitionEvents.id, item.preparation.preparationId));
      } },
      { name: "changed full attempt", mutate: async (item: Awaited<ReturnType<typeof seedQaSuccessorSettlement>>) => {
        const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, item.successorWakeId));
        const payload = wake!.payload as Record<string, unknown>;
        const proof = payload[WORKFLOW_ATTEMPT_PROOF_KEY] as Record<string, unknown>;
        await db.update(agentWakeupRequests).set({ payload: { ...payload,
          [WORKFLOW_ATTEMPT_PROOF_KEY]: { ...proof, retryCount: 1 } } })
          .where(eq(agentWakeupRequests.id, item.successorWakeId));
      } },
      { name: "replacement marker", mutate: async (item: Awaited<ReturnType<typeof seedQaSuccessorSettlement>>) => {
        const [workflow] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, item.seed.workflowRunId));
        await db.update(workflowRuns).set({ metadata: { ...workflow!.metadata, replacementAuthorityId: randomUUID() } })
          .where(eq(workflowRuns.id, item.seed.workflowRunId));
      } },
      { name: "cancelled mission", mutate: async (item: Awaited<ReturnType<typeof seedQaSuccessorSettlement>>) => {
        await db.update(missions).set({ status: "cancelled" }).where(eq(missions.id, item.seed.missionId));
      } },
      { name: "two heartbeat rows share the successor wake", mutate: async (item: Awaited<ReturnType<typeof seedQaSuccessorSettlement>>) => {
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, item.successorHeartbeatId));
        await db.insert(heartbeatRuns).values({ ...run!, id: randomUUID(), executionToken: randomUUID(),
          executorOwnerLeaseToken: randomUUID() });
      } },
      { name: "two wake rows share the successor run", mutate: async (item: Awaited<ReturnType<typeof seedQaSuccessorSettlement>>) => {
        const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, item.successorWakeId));
        await db.insert(agentWakeupRequests).values({ ...wake!, id: randomUUID(),
          idempotencyKey: `${wake!.idempotencyKey}:duplicate` });
      } },
      { name: "failed current QA step status", mutate: async (item: Awaited<ReturnType<typeof seedQaSuccessorSettlement>>) => {
        await db.update(workflowStepRuns).set({ status: "failed" })
          .where(eq(workflowStepRuns.id, item.seed.stepRunId));
      } },
      { name: "skipped current QA step status", mutate: async (item: Awaited<ReturnType<typeof seedQaSuccessorSettlement>>) => {
        await db.update(workflowStepRuns).set({ status: "skipped" })
          .where(eq(workflowStepRuns.id, item.seed.stepRunId));
      } },
    ];
    for (const scenario of negativeCases) {
      const item = await seedQaSuccessorSettlement();
      await scenario.mutate(item);
      const beforeHeld = await captureSettlementRows(item);
      expect((await settleTerminalContinuationFromQaSuccessor(db, item.sourceEventId)).kind, scenario.name).toBe("held");
      expect(await captureSettlementRows(item), scenario.name).toEqual(beforeHeld);
    }
  }, 120_000);
});
