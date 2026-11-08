// Heartbeat recovery-boundary cases moved out of heartbeat-recovery-boundary.test.ts
// (T16d, file <=1000 lines).
// Slice: P1 execution-root C5 hold and boxed adapter work case.
// Case bodies are moved verbatim: the describe-scoped db connection, service handle and fixture
// helpers are injected by the caller so the suite lifecycle stays in one place.
import { expect, it, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { and, asc, eq } from "drizzle-orm";
import { missions, issues, heartbeatRuns, agentWakeupRequests, instanceSettings, workflowStepRuns, workflowRuns, workflowTransitionEvents } from "@paperclipai/db";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../../adapters/types.js";
import { heartbeatService } from "../../services/heartbeat.js";
import { waitForHeartbeatExecutionsToDrain } from "../../services/heartbeat-execution-tracker.js";
import { registerWorkflowArtifact, completeWorkflowIssue, submitWorkflowVerdict } from "../../services/workflow/agent-api.js";
import { registeredProducer } from "../../services/work-products/producer-provenance.js";
import { recordWorkflowValidationVerdict } from "../../services/workflow/validation-verdict-ledger.js";
import { prepareQaRemediationReservation } from "../../services/workflow/control-flow/qa-remediation-prepare.js";
import { QA_REMEDIATION_PREPARATION_EVENT_TYPE } from "../../services/workflow/control-flow/qa-remediation-preparation-contract.js";
import { parseQaRemediationCompletion, QA_REMEDIATION_COMPLETION_EVENT_TYPE } from "../../services/workflow/control-flow/qa-remediation-completion.js";
import { freezeHeartbeatActualDrainIdentity, readQaRemediationActualDrain } from "../../services/heartbeat-actual-drain.js";
import { readWorkflowAttemptProof } from "../../services/heartbeat-finalization/workflow-attempt-proof.js";
import { isC5NotInvokedProof, readC5NotInvokedProof, QaRemediationAdmissionHold } from "../../services/workflow/control-flow/qa-remediation-admission-root.js";
import { captureQaCorrectionExecutionIdentity, withQaCorrectionExecutionRoot } from "../../services/workflow/control-flow/qa-correction-claim-root.js";
import { assertHeartbeatRecoveryAdmission } from "../../services/heartbeat-recovery-guard.js";
import { createQaFileOwnerRuntime, type QaFileOwnerRuntime } from "../../services/workflow/control-flow/qa-remediation-runtime.js";
import { createAdmissionHarness, type AdmissionHarness } from "./qa-remediation-admission-public-fixture.js";
import { PYTHON, deferred, within } from "./qa-remediation-parent-death-harness.js";
import { createP1LifecycleScenario, createP1NoHistoryScenario, addExecutionCandidateAgent, addExecutionCandidateStep, addExecutionCandidate, claimExecutionCandidate, executionAdmission, assertP1AdapterAttempt, waitForP1ProducerDrain } from "./heartbeat-recovery-boundary-fixtures.js";

export function registerHeartbeatRecoveryBoundaryP1Cases(deps: {
  adapter: ReturnType<typeof vi.fn>;
}) {
  const { adapter } = deps;

  // Late-bound: the caller assigns these describe-scoped values in its own beforeAll, which
  // is registered before this hook, so every case sees the live connection and service.
  beforeAll(() => {
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
    // C3-β(§6-b): 무관 step 의 pre-invocation hold 관측을 adapter_start 로 이동(단언 삭제 없음, 관측 지점만 교체).
    // claim 은 이제 정상 경로(claimExecutionCandidate)로 승격되고, lock_wait·DB row lock 미보유·typed proof
    // 행 불변은 adapter_start 오너 대기에서 동일하게 관측한다(phase 문자열만 claim→adapter_start).
    const queuedStarted = await claimExecutionCandidate(harness, queued);
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
    const c5Work = withQaCorrectionExecutionRoot(harness.db, queuedStarted, {
      phase: "adapter_start",
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
    const expectedIdentity = captureQaCorrectionExecutionIdentity(queuedStarted);
    const proofBinding = readC5NotInvokedProof(c5Result.proof, harness.db, expectedIdentity, "adapter_start");
    expect(Object.isFrozen(proofBinding)).toBe(true);
    expect(proofBinding.scope).toMatchObject({ kind: "linked", primaryWorkflowRunId: scenario.runId });
    expect(() => readC5NotInvokedProof(c5Result.proof, harness.peer, expectedIdentity, "adapter_start"))
      .toThrow(QaRemediationAdmissionHold);
    expect(() => readC5NotInvokedProof(c5Result.proof, harness.db,
      { ...expectedIdentity, heartbeatRunId: randomUUID() }, "adapter_start")).toThrow(QaRemediationAdmissionHold);
    expect(() => readC5NotInvokedProof(c5Result.proof, harness.db, expectedIdentity, "claim"))
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

    // C3-β(§6-d): 시험 약화 방지 증거 — pending 의 대상 step 이 실행 단위와 정확 일치하는 claim 은
    // 여전히 claim 단계에서 typed hold 된다(승격 대상만 좁혔을 뿐 hold 계약은 유지).
    const relatedRetry = await addExecutionCandidate(harness, scenario, scenario.authorId,
      { issueId: scenario.producerIssueId, stepRun: scenario.producer });
    let relatedWorkCalls = 0;
    const relatedClaim = await withQaCorrectionExecutionRoot(harness.db, relatedRetry, {
      phase: "claim",
      admit: (tx, run) => assertHeartbeatRecoveryAdmission(tx, run),
      work: async () => { relatedWorkCalls++; throw new Error("unit-related pending must hold at claim"); },
      sharedAdmission: executionAdmission(realRuntime),
    });
    expect(relatedClaim.kind).toBe("c5_held_not_invoked");
    if (relatedClaim.kind !== "c5_held_not_invoked") throw new Error("C3-β §6-d unit-related claim was not held");
    const relatedBinding = readC5NotInvokedProof(relatedClaim.proof, harness.db,
      captureQaCorrectionExecutionIdentity(relatedRetry), "claim");
    expect(relatedBinding.scope).toMatchObject({ kind: "linked", primaryWorkflowRunId: scenario.runId });
    // claim 오너 대상은 단위 관련 pending 파일로 좁혀졌다(전체 allTargets 가 아님).
    expect(relatedBinding.nativeOwner.targets()).toEqual([scenario.file]);
    expect(await relatedBinding.nativeOwner.awaitExit()).toMatchObject({ code: 0, signal: null });
    expect(relatedWorkCalls).toBe(0);
    const [relatedRow] = await harness.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, relatedRetry.id));
    expect(relatedRow).toMatchObject({ id: relatedRetry.id, status: "queued" });

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
}
