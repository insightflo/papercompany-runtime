import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, heartbeatRuns, instanceSettings,
  issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../adapters/types.js";
import { registeredProducer } from "../services/work-products/producer-provenance.js";
import { createHeartbeatActualObservation, freezeHeartbeatActualDrainIdentity,
  readQaRemediationActualDrain, writeHeartbeatActualDrain, type HeartbeatActualDrainIdentity } from "../services/heartbeat-actual-drain.js";
import { QaRemediationWorkflowHoldError } from "../services/workflow/control-flow/qa-correction-followup-reconcile.js";
import { reconcileQaRemediationReservation } from "../services/workflow/control-flow/qa-remediation-reconcile.js";
import { parseQaRemediationPreparation, QA_REMEDIATION_PREPARATION_EVENT_TYPE } from "../services/workflow/control-flow/qa-remediation-preparation-contract.js";
import { createQaFileOwnerRuntime } from "../services/workflow/control-flow/qa-remediation-runtime.js";
import { createReplacementRootNotifications, withReplacementRootNotificationDb } from "../services/issue-assignment-wakeup.js";
import { drainReplacementRootNotifications } from "../services/workflow/replacement-agent-delivery.js";
import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";
import { completeWorkflowIssue, registerWorkflowArtifact, submitWorkflowVerdict } from "../services/workflow/agent-api.js";
import { readWorkflowAttemptProof } from "../services/heartbeat-finalization/workflow-attempt-proof.js";
import { createQaCorrectionTestDb } from "./helpers/qa-correction-fixture.js";
import { seedQualityFixture } from "./helpers/quality-fixture.js";
import { PYTHON, deferred, within } from "./helpers/qa-remediation-parent-death-harness.js";

const adapter = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", async original => ({
  ...await original<typeof import("../adapters/index.js")>(),
  getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute: adapter }),
}));
const before = "old flawed draft\n", after = "old polished draft\n";
const completed: AdapterExecutionResult = { exitCode: 0, signal: null, timedOut: false, usage: null,
  provider: "test", model: "test", resultJson: { stdout: "{\"verdict\":\"pass\"}", stderr: "" }, runtimeServices: [] };
let owned: Awaited<ReturnType<typeof createQaCorrectionTestDb>>, db: Db, peer: Db;
let quality: Awaited<ReturnType<typeof seedQualityFixture>>, root = "", lockRoot = "";

async function publicRoot(request: Parameters<typeof reconcileQaRemediationReservation>[1]) {
  const notifications = createReplacementRootNotifications();
  const outcome = await withReplacementRootNotificationDb(db, notifications, () => reconcileQaRemediationReservation(
    db, request, createQaFileOwnerRuntime({ qaFileOwnerLockRoot: lockRoot, qaFileOwnerPython: PYTHON! })));
  await drainReplacementRootNotifications(db, notifications);
  return outcome;
}
const readRun = async (id: string) => (await peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;
const readStep = async (id: string) => (await peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, id)))[0]!;
const readDrainEvents = (identity: HeartbeatActualDrainIdentity) => peer.select().from(workflowTransitionEvents).where(and(
  eq(workflowTransitionEvents.companyId, identity.companyId), eq(workflowTransitionEvents.missionId, identity.missionId),
  eq(workflowTransitionEvents.workflowRunId, identity.workflowRunId), eq(workflowTransitionEvents.workflowStepRunId, identity.workflowStepRunId),
  eq(workflowTransitionEvents.issueId, identity.issueId), eq(workflowTransitionEvents.heartbeatRunId, identity.heartbeatRunId),
  eq(workflowTransitionEvents.dispatchOwnerHeartbeatRunId, identity.heartbeatRunId),
  eq(workflowTransitionEvents.executionGeneration, identity.executionGeneration),
  eq(workflowTransitionEvents.executorOwnerId, identity.executorOwnerId),
  eq(workflowTransitionEvents.eventType, "heartbeat_actual_drained_v1")));
const readCompletions = (workflowRunId: string) => peer.select().from(workflowTransitionEvents).where(and(
  eq(workflowTransitionEvents.workflowRunId, workflowRunId), eq(workflowTransitionEvents.eventType, "qa_remediation_completed")));

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "qa-actual-drain-")));
  lockRoot = await realpath(await mkdtemp(path.join(root, "native-lock-"))); await chmod(lockRoot, 0o700);
  vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk"); vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", path.join(root, "storage"));
  vi.stubEnv("PAPERCLIP_WORKFLOW_INSTANT_ADVANCE", "0");
  vi.stubEnv("PAPERCLIP_QA_FILE_OWNER_LOCK_ROOT", lockRoot); vi.stubEnv("PAPERCLIP_QA_FILE_OWNER_PYTHON", PYTHON!);
  owned = await createQaCorrectionTestDb(); db = owned.db; peer = owned.connect(); quality = await seedQualityFixture(db);
  await db.insert(instanceSettings).values({ singletonKey: "default", experimental: { enableHeartbeatFinalizationV1: true } })
    .onConflictDoUpdate({ target: instanceSettings.singletonKey, set: { experimental: { enableHeartbeatFinalizationV1: true } } });
  await db.update(companies).set({ workProductRoot: root }).where(eq(companies.id, quality.companyId));
  await db.update(agents).set({ status: "active", adapterType: "codex_local", adapterConfig: { cwd: root, promptTemplate: "producer" },
    runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 2 } } })
    .where(and(eq(agents.companyId, quality.companyId), eq(agents.id, quality.authorAgentId)));
  await db.update(agents).set({ status: "active", adapterType: "codex_local", adapterConfig: { cwd: root, promptTemplate: "QA" },
    runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 2 } } })
    .where(and(eq(agents.companyId, quality.companyId), eq(agents.id, quality.verifierAgentId)));
}, 120_000);

afterAll(async () => {
  if (db) await waitForHeartbeatExecutionsToDrain(db, 60_000);
  await owned?.close(); vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true });
}, 120_000);

it("preserves an officially completed producer actual through a rolled-back start commit and auto-publishes one QA pass", async () => {
  const missionId = randomUUID(), workflowId = randomUUID(), workflowRunId = randomUUID();
  const producerIssueId = randomUUID(), qaIssueId = randomUUID(), producerStepRunId = randomUUID(), qaStepRunId = randomUUID();
  const file = path.join(root, "missions", missionId, "runs", workflowRunId, "steps", "produce", "report.md");
  await mkdir(path.dirname(file), { recursive: true });
  await db.insert(missions).values({ id: missionId, companyId: quality.companyId, ownerAgentId: quality.authorAgentId,
    title: "Actual drain producer proof", status: "active" });
  await db.insert(workflowDefinitions).values({ id: workflowId, companyId: quality.companyId, missionId,
    name: "Actual drain graph", stepsJson: [
      { id: "produce", name: "Produce", agentId: quality.authorAgentId, dependencies: [],
        conditionalDependencies: [{ stepId: "qa-check", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 }] },
      { id: "qa-check", name: "QA", agentId: quality.verifierAgentId, type: "qa", dependencies: ["produce"] },
    ] });
  await db.insert(workflowRuns).values({ id: workflowRunId, companyId: quality.companyId, missionId, workflowId,
    status: "running", triggeredBy: "test", dispatchAuthorityVersion: 1 });
  await db.insert(issues).values([
    { id: producerIssueId, companyId: quality.companyId, missionId, title: "Produce report", status: "todo",
      assigneeAgentId: quality.authorAgentId, originKind: "workflow_execution", originRunId: workflowRunId },
    { id: qaIssueId, companyId: quality.companyId, missionId, title: "[QA] Validate report", status: "todo",
      assigneeAgentId: quality.verifierAgentId, originKind: "workflow_execution", originRunId: workflowRunId },
  ]);
  const [producerStep] = await db.insert(workflowStepRuns).values({ id: producerStepRunId, workflowRunId, stepId: "produce",
    issueId: producerIssueId, status: "pending" }).returning();
  const [qaStep] = await db.insert(workflowStepRuns).values({ id: qaStepRunId, workflowRunId, stepId: "qa-check",
    issueId: qaIssueId, status: "pending" }).returning();
  const request = { companyId: quality.companyId, missionId, workflowRunId, producerStepRunId,
    qaStepRunIds: [qaStepRunId] };
  const producerEntered = deferred<string>(), allowProduction = deferred<void>(), producerCompleted = deferred<void>();
  const firstQaVerdict = deferred<void>();
  const releaseActual = deferred<void>(), qaRequestChanges = deferred<string>(), qaPass = deferred<string>();
  const uEntered = deferred<string>(), uAgentId = randomUUID();
  await db.insert(agents).values({ id: uAgentId, companyId: quality.otherCompanyId, name: "Independent U", status: "active",
    adapterType: "codex_local", adapterConfig: { cwd: root }, runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 1 } } });
  let producerRunId = "", startFaulted = false, qaCalls = 0, firstHold: unknown;
  const actualResult: AdapterExecutionResult = { ...completed, usage: { inputTokens: 90, cachedInputTokens: 30, outputTokens: 40 },
    provider: "actual-provider", model: "actual-model", costUsd: 0.25,
    resultJson: { stdout: "actual producer result", stderr: "" }, sessionId: "g0-actual-session" };
  adapter.mockImplementation(async (context: AdapterExecutionContext) => {
    if (context.agent.id === quality.authorAgentId) {
      producerRunId = context.runId; producerEntered.resolve(context.runId); await allowProduction.promise;
      await context.onSessionUpdate?.({ sessionId: "g0-actual-session", sessionDisplayId: "g0-actual-session" });
      await writeFile(file, before, "utf8");
      const [issue] = await db.select().from(issues).where(eq(issues.id, producerIssueId));
      const actor = { actorType: "agent" as const, actorId: quality.authorAgentId, agentId: quality.authorAgentId, runId: context.runId };
      await registerWorkflowArtifact({ db, issue: issue!, actor, data: { path: file, type: "document", isPrimary: true } });
      if (!(await registeredProducer(db, quality.companyId, producerIssueId, context.runId))) throw new Error("official producer proof missing");
      await completeWorkflowIssue({ db, issue: issue!, actor, data: {} });
      expect(await readFile(file, "utf8")).toBe(before);
      expect(await readStep(producerStepRunId)).toMatchObject({ status: "completed", completedAt: expect.any(Date) });
      producerCompleted.resolve(); await releaseActual.promise; return actualResult;
    }
    if (context.agent.id === quality.verifierAgentId) {
      qaCalls += 1;
      const issueId = String(context.context.issueId), [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      const actor = { actorType: "agent" as const, actorId: quality.verifierAgentId, agentId: quality.verifierAgentId, runId: context.runId };
      const bytes = await readFile(file, "utf8");
      if (qaCalls === 1) {
        expect(issueId).toBe(qaIssueId); expect(bytes).toBe(before);
        await firstQaVerdict.promise;
        await submitWorkflowVerdict({ db, issue: issue!, actor, data: { verdict: "request_changes",
          findings: [{ id: "artifact-copy", summary: "Report contains the flawed draft", layer: "artifact" }],
          remediations: { items: [{ op: "string_replace", file, find: "flawed", replace: "polished" }] } } });
        let completionError: unknown;
        try { await completeWorkflowIssue({ db, issue: issue!, actor, data: {} }); }
        catch (error) { completionError = error; }
        expect(completionError).toBeInstanceOf(QaRemediationWorkflowHoldError);
        firstHold = (completionError as QaRemediationWorkflowHoldError).result;
        expect(firstHold).toMatchObject({ outcome: "held", reason: "actual_drain_unproven" });
        qaRequestChanges.resolve(context.runId); return completed;
      }
      if (qaCalls !== 2) throw new Error(`unexpected QA adapter count ${qaCalls}`);
      expect(bytes).toBe(after);
      await submitWorkflowVerdict({ db, issue: issue!, actor, data: { verdict: "pass" } });
      await completeWorkflowIssue({ db, issue: issue!, actor, data: {} });
      qaPass.resolve(context.runId); return { ...completed, resultJson: { stdout: "QA passed" } };
    }
    if (context.agent.id === uAgentId) { uEntered.resolve(context.runId); return completed; }
    throw new Error(`unexpected adapter ${context.agent.id}`);
  });

  const originalTransaction = db.transaction.bind(db), transactionDescriptor = Object.getOwnPropertyDescriptor(db, "transaction");
  const rollbackComplete = deferred<void>();
  Object.defineProperty(db, "transaction", { configurable: true, value: ((callback: (tx: unknown) => Promise<unknown>, config?: unknown) => {
    let injected = false;
    return originalTransaction(async tx => {
      const value = await callback(tx) as { kind?: unknown; value?: { result?: unknown } };
      const pendingActual = value?.kind === "performed" ? value.value?.result : null;
      if (!startFaulted && producerRunId && pendingActual && typeof (pendingActual as Promise<unknown>).then === "function") {
        const [current] = await (tx as Db).select().from(heartbeatRuns).where(eq(heartbeatRuns.id, producerRunId));
        if (current?.workflowStepRunId === producerStepRunId && current.wakeupRequestId
          && current.status === "running" && current.startedAt) {
          startFaulted = true; injected = true; throw new Error("g0 exact adapter-start transaction commit fault");
        }
      }
      return value;
    }, config as never).catch(error => { if (injected) rollbackComplete.resolve(); throw error; });
  }) as typeof db.transaction });
  try {
    const service = heartbeatService(db);
    const h = await service.wakeup(quality.authorAgentId, { source: "assignment", triggerDetail: "system", reason: "workflow_step_runnable",
      payload: { issueId: producerIssueId, missionId, workflowRunId, workflowStepRunId: producerStepRunId },
      contextSnapshot: { issueId: producerIssueId, missionId, workflowRunId, workflowStepRunId: producerStepRunId } });
    expect(h).toBeTruthy(); await within(producerEntered.promise, "producer adapter entry");
    await within(rollbackComplete.promise, "exact adapter-start transaction rollback");
    expect(producerRunId).toBe(h!.id);
    const started = await readRun(h!.id), wake = (await peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, h!.wakeupRequestId!)))[0]!;
    const drainIdentity = await freezeHeartbeatActualDrainIdentity(peer, started, { workflowRunId });
    expect(drainIdentity).toBeTruthy();
    const proof = readWorkflowAttemptProof(wake);
    expect(proof).toMatchObject({ companyId: quality.companyId, agentId: quality.authorAgentId, issueId: producerIssueId,
      missionId, workflowRunId, stepRunId: producerStepRunId, executionGeneration: started.workflowExecutionGeneration,
      retryCount: 0, iterationIndex: 0, wakeupRequestId: h!.wakeupRequestId, parentHeartbeatRunId: null });
    const frozen = { owner: started.executorOwnerId, lease: started.executorOwnerLeaseEpoch, leaseToken: started.executorOwnerLeaseToken,
      epoch: started.executionEpoch, token: started.executionToken, step: started.workflowStepRunId,
      generation: started.workflowExecutionGeneration, retry: started.retryOfRunId };
    expect(started.status).toBe("running"); expect(startFaulted).toBe(true);
    allowProduction.resolve();
    await within(producerCompleted.promise, "official producer completion");
    firstQaVerdict.resolve(); await within(qaRequestChanges.promise, "official first QA completion and pending root hold");
    expect(firstHold).toMatchObject({ outcome: "held", reason: "actual_drain_unproven" });
    expect(await peer.select().from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.workflowRunId, workflowRunId),
      eq(workflowTransitionEvents.eventType, QA_REMEDIATION_PREPARATION_EVENT_TYPE)))).toHaveLength(1);
    expect(await readFile(file, "utf8")).toBe(before); expect(await readDrainEvents(drainIdentity!)).toHaveLength(0);
    expect(await readCompletions(workflowRunId)).toHaveLength(0);
    expect((await readRun(h!.id)).status).toBe("running");

    const u = await service.wakeup(uAgentId, { source: "on_demand", triggerDetail: "manual", reason: "unrelated-positive-U" });
    await within(uEntered.promise, "independent U adapter entry");
    await vi.waitFor(async () => expect((await readRun(u!.id)).status).toBe("succeeded"), { timeout: 20_000, interval: 10 });
    expect((await readRun(h!.id)).status).toBe("running"); expect(await readFile(file, "utf8")).toBe(before);
    expect(await readDrainEvents(drainIdentity!)).toHaveLength(0); expect(await readCompletions(workflowRunId)).toHaveLength(0);

    releaseActual.resolve(); const qaPassRunId = await within(qaPass.promise, "automatic QA follow-up pass");
    await waitForHeartbeatExecutionsToDrain(db, 60_000);
    const ended = await readRun(h!.id), events = await readDrainEvents(drainIdentity!);
    expect(ended).toMatchObject({ status: "failed", errorCode: "heartbeat_recovery_blocked", exitCode: 0,
      sessionIdAfter: "g0-actual-session", resultJson: { stdout: "actual producer result" },
      usageJson: { inputTokens: 90, cachedInputTokens: 30, outputTokens: 40, rawInputTokens: 90,
        rawCachedInputTokens: 30, rawOutputTokens: 40, persistedSessionId: "g0-actual-session",
        provider: "actual-provider", model: "actual-model", costUsd: 0.25 } });
    expect({ owner: ended.executorOwnerId, lease: ended.executorOwnerLeaseEpoch, leaseToken: ended.executorOwnerLeaseToken,
      epoch: ended.executionEpoch, token: ended.executionToken, step: ended.workflowStepRunId,
      generation: ended.workflowExecutionGeneration, retry: ended.retryOfRunId }).toEqual(frozen);
    expect(events).toHaveLength(1);
    const evidence = events[0]!.payload as Record<string, any>;
    expect(evidence).toMatchObject({ schemaVersion: "workflow.heartbeat-actual-drain.v1", actual: { outcome: "fulfilled" },
      cleanup: { runtimeServicesRelease: { called: true, succeeded: true }, heartbeatSettlement: { called: true, succeeded: true },
        resources: { workspaceOperationsSettled: true, runtimeServicesStopped: true, missionRuntimeIdle: true } },
      identity: drainIdentity });
    expect(await readFile(file, "utf8")).toBe(after); expect(qaCalls).toBe(2);
    const [producer] = await peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, producerStepRunId));
    const [reservation] = await peer.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.workflowRunId, workflowRunId), eq(workflowTransitionEvents.eventType, QA_REMEDIATION_PREPARATION_EVENT_TYPE)));
    const preparation = parseQaRemediationPreparation(reservation!.payload);
    expect((await readQaRemediationActualDrain(peer, preparation, producer!)).kind).toBe("proven");

    const actualObservation = createHeartbeatActualObservation<AdapterExecutionResult>();
    actualObservation.invoke(() => Promise.resolve(actualResult)); const fakeActual = await actualObservation.awaitSettled();
    const identity = await freezeHeartbeatActualDrainIdentity(peer, ended, { workflowRunId }); expect(identity).toBeTruthy();
    expect(await writeHeartbeatActualDrain(peer, { ...identity!, executionToken: randomUUID() }, fakeActual, {
      releaseCalled: true, releaseSucceeded: true, settlementCalled: true, settlementSucceeded: true,
      resources: { workspaceOperationsSettled: true, runtimeServicesStopped: true, missionRuntimeIdle: true },
    })).toMatchObject({ outcome: "held" });
    expect(await writeHeartbeatActualDrain(peer, identity, fakeActual, { releaseCalled: true, releaseSucceeded: false,
      settlementCalled: true, settlementSucceeded: true,
      resources: { workspaceOperationsSettled: true, runtimeServicesStopped: true, missionRuntimeIdle: true } })).toMatchObject({ outcome: "held" });
    const event = events[0]!, originalPayload = event.payload as Record<string, any>;
    for (const [field, value] of [["retryCount", 99], ["executionEpoch", frozen.epoch! + 1],
      ["executionToken", randomUUID()], ["executorOwnerId", "foreign-owner"]] as const) {
      await peer.update(workflowTransitionEvents).set({ payload: { ...originalPayload,
        identity: { ...(originalPayload.identity as object), [field]: value } } }).where(eq(workflowTransitionEvents.id, event.id));
      expect((await readQaRemediationActualDrain(peer, preparation, producer!)).kind).toBe("held");
    }
    await peer.update(workflowTransitionEvents).set({ payload: {} }).where(eq(workflowTransitionEvents.id, event.id));
    expect((await readQaRemediationActualDrain(peer, preparation, producer!)).kind).toBe("held");
    await peer.update(workflowTransitionEvents).set({ payload: originalPayload }).where(eq(workflowTransitionEvents.id, event.id));
    const byId = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
    const readReplaySnapshot = async () => ({
      preparations: byId(await peer.select().from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.companyId, quality.companyId), eq(workflowTransitionEvents.missionId, missionId), eq(workflowTransitionEvents.workflowRunId, workflowRunId), eq(workflowTransitionEvents.workflowStepRunId, producerStepRunId), eq(workflowTransitionEvents.issueId, producerIssueId), eq(workflowTransitionEvents.eventType, QA_REMEDIATION_PREPARATION_EVENT_TYPE)))),
      completions: byId(await peer.select().from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.companyId, quality.companyId), eq(workflowTransitionEvents.missionId, missionId), eq(workflowTransitionEvents.workflowRunId, workflowRunId), eq(workflowTransitionEvents.workflowStepRunId, producerStepRunId), eq(workflowTransitionEvents.issueId, producerIssueId), eq(workflowTransitionEvents.eventType, "qa_remediation_completed")))),
      actualDrains: byId(await readDrainEvents(drainIdentity!)),
      qaWakes: byId(await peer.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, quality.companyId), eq(agentWakeupRequests.missionId, missionId), eq(agentWakeupRequests.workflowRunId, workflowRunId), eq(agentWakeupRequests.workflowStepRunId, qaStepRunId), eq(agentWakeupRequests.issueId, qaIssueId), eq(agentWakeupRequests.agentId, quality.verifierAgentId)))),
      producerHeartbeatIds: (await peer.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, quality.companyId), eq(heartbeatRuns.agentId, quality.authorAgentId), eq(heartbeatRuns.issueId, producerIssueId), eq(heartbeatRuns.workflowStepRunId, producerStepRunId)))).map(({ id }) => id).sort(),
      qaHeartbeatIds: (await peer.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, quality.companyId), eq(heartbeatRuns.agentId, quality.verifierAgentId), eq(heartbeatRuns.issueId, qaIssueId), eq(heartbeatRuns.workflowStepRunId, qaStepRunId)))).map(({ id }) => id).sort(),
      officialQaVerdicts: await peer.select().from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.companyId, quality.companyId), eq(workflowTransitionEvents.issueId, qaIssueId), eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"), eq(workflowTransitionEvents.reason, "workflow_api"))).orderBy(desc(workflowTransitionEvents.createdAt), desc(workflowTransitionEvents.id)),
      qaStep: await readStep(qaStepRunId), producerRun: await readRun(h!.id),
    });
    const beforeReplay = await readReplaySnapshot();
    expect(beforeReplay.preparations).toHaveLength(1); expect(beforeReplay.preparations[0]!.id).toBe(preparation.preparationId);
    expect(beforeReplay.completions).toHaveLength(1); expect(beforeReplay.actualDrains).toHaveLength(1); expect(beforeReplay.qaWakes).toHaveLength(2);
    expect(beforeReplay.producerHeartbeatIds).toEqual([h!.id]); expect(beforeReplay.qaHeartbeatIds).toHaveLength(2);
    expect(beforeReplay.qaHeartbeatIds).toContain(qaPassRunId); expect(beforeReplay.officialQaVerdicts).toHaveLength(2);
    expect(beforeReplay.officialQaVerdicts[0]).toMatchObject({ companyId: quality.companyId, missionId, workflowRunId, workflowStepRunId: qaStepRunId, issueId: qaIssueId, heartbeatRunId: qaPassRunId, reason: "workflow_api", verdict: "pass", payload: { kind: "workflow_validation_verdict", workflowRunId, stepRunId: qaStepRunId, issueId: qaIssueId, verdict: "pass" } });
    const completion = beforeReplay.completions[0]!.payload as Record<string, any>;
    expect(completion.files).toHaveLength(1); expect(completion.files[0]).toMatchObject({ file, status: "applied" });
    expect(beforeReplay.qaStep).toMatchObject({ status: "completed", completedAt: expect.any(Date) });
    expect(beforeReplay.producerRun).toMatchObject({ status: ended.status, errorCode: ended.errorCode, exitCode: ended.exitCode,
      resultJson: ended.resultJson, usageJson: ended.usageJson, sessionIdAfter: ended.sessionIdAfter,
      executorOwnerId: ended.executorOwnerId, executorOwnerLeaseEpoch: ended.executorOwnerLeaseEpoch,
      executorOwnerLeaseToken: ended.executorOwnerLeaseToken, executionEpoch: ended.executionEpoch, executionToken: ended.executionToken,
      wakeupRequestId: ended.wakeupRequestId, workflowStepRunId: ended.workflowStepRunId,
      workflowExecutionGeneration: ended.workflowExecutionGeneration, retryOfRunId: ended.retryOfRunId });
    expect(await readFile(file, "utf8")).toBe(after);
    const replay = await publicRoot(request);
    expect(replay).toMatchObject({ outcome: "preparation_held", reason: "unresolved_pending" });
    expect(replay.detail).toContain("qa qa-check has no applicable remediations");
    await waitForHeartbeatExecutionsToDrain(db, 60_000);
    const afterReplay = await readReplaySnapshot(); expect(afterReplay).toEqual(beforeReplay);
    expect(await readFile(file, "utf8")).toBe(after); expect(qaCalls).toBe(2);
    expect(adapter.mock.calls.filter(call => (call[0] as AdapterExecutionContext).agent.id === quality.verifierAgentId)).toHaveLength(2);
    expect(adapter.mock.calls.filter(call => (call[0] as AdapterExecutionContext).agent.id === quality.authorAgentId)).toHaveLength(1);
    expect(adapter.mock.calls.filter(call => (call[0] as AdapterExecutionContext).runId === h!.id)).toHaveLength(1);
  } finally {
    allowProduction.resolve(); firstQaVerdict.resolve(); releaseActual.resolve();
    if (transactionDescriptor) Object.defineProperty(db, "transaction", transactionDescriptor);
    else delete (db as unknown as { transaction?: unknown }).transaction;
    await waitForHeartbeatExecutionsToDrain(db, 60_000); adapter.mockReset();
  }
}, 120_000);
