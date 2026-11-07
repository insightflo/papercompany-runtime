// QA remediation revocation cases moved out of qa-remediation-revocation-integration.test.ts
// (T16d, file <=1000 lines).
// Slice: started-actuals hold/recheck/cancel and transaction-owned pause-head cases (1-2).
// Case bodies are moved verbatim: the describe-scoped db connection, service handle and fixture
// helpers are injected by the caller so the suite lifecycle stays in one place.
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { agentWakeupRequests, agents, companies, heartbeatRuns, issueWorkProducts, issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents, workflowRecoveryAuthorities, type Db } from "@paperclipai/db";
import { runningProcesses } from "../../adapters/index.js";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../../adapters/types.js";
import { heartbeatService } from "../../services/heartbeat.js";
import { readPauseControls } from "../../services/heartbeat-pause-delivery.js";
import { freezeHeartbeatActualDrainIdentity, readQaRemediationActualDrain } from "../../services/heartbeat-actual-drain.js";
import { readWorkflowAttemptProof } from "../../services/heartbeat-finalization/workflow-attempt-proof.js";
import { registeredProducer } from "../../services/work-products/producer-provenance.js";
import { QaRemediationAdmissionHold } from "../../services/workflow/control-flow/qa-remediation-admission-root.js";
import { QaRemediationWorkflowHoldError } from "../../services/workflow/control-flow/qa-correction-followup-reconcile.js";
import { createQaFileOwnerRuntime } from "../../services/workflow/control-flow/qa-remediation-runtime.js";
import { parseQaRemediationPreparation, QA_REMEDIATION_PREPARATION_EVENT_TYPE } from "../../services/workflow/control-flow/qa-remediation-preparation-contract.js";
import { QaRemediationFileOwner } from "../../services/workflow/control-flow/qa-remediation-file-owner.js";
import { completeWorkflowIssue, registerWorkflowArtifact, submitWorkflowVerdict } from "../../services/workflow/agent-api.js";
import { workflowService } from "../../services/workflow/engine.js";
import { seedQualityFixture } from "./quality-fixture.js";
import { deferred, NATIVE_HELPER, PYTHON, within } from "./qa-remediation-parent-death-harness.js";
import { waitForHeartbeatExecutionsToDrain } from "../../services/heartbeat-execution-tracker.js";

export function registerQaRemediationRevocationLinkedCases(deps: {
  getDb: () => Db;
  getPeer: () => Db;
  getQuality: () => Awaited<ReturnType<typeof seedQualityFixture>>;
  getRoot: () => string;
  getLockRoot: () => string;
  getAdapter: () => ReturnType<typeof vi.fn>;
  getFinished: () => AdapterExecutionResult;
}) {
  const { getDb, getPeer, getQuality, getRoot, getLockRoot, getAdapter, getFinished } = deps;

  // The moved cases set up and release their own producer/actual gates. Keeping those handles in
  // this module lets the module release them in its own afterAll, so the caller's afterAll keeps
  // owning only the state its remaining cases touch.
  let releaseProducer: (() => void) | null = null;
  let releaseQaActual: (() => void) | null = null;

  // Late-bound: the caller assigns these describe-scoped values in its own beforeAll, which
  // is registered before this hook, so every case sees the live connection and service.
  let db!: Db;
  let peer!: Db;
  let quality!: Awaited<ReturnType<typeof seedQualityFixture>>;
  let root!: string;
  let lockRoot!: string;
  let adapter!: ReturnType<typeof vi.fn>;
  let finished!: AdapterExecutionResult;
  beforeAll(() => {
    db = getDb();
    peer = getPeer();
    quality = getQuality();
    root = getRoot();
    lockRoot = getLockRoot();
    adapter = getAdapter();
    finished = getFinished();
  });

it("holds started actuals, waits on the native owner, rechecks scope, then cancels once", async () => {
  const missionId = randomUUID(), workflowId = randomUUID(), runId = randomUUID();
  const producerIssueId = randomUUID(), qaIssueId = randomUUID(), producerStepId = randomUUID(), qaStepId = randomUUID();
  const file = path.join(root, "missions", missionId, "runs", runId, "steps", "produce", "report.md");
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, "flawed draft\n", "utf8");
  await db.insert(missions).values({ id: missionId, companyId: quality.companyId, ownerAgentId: quality.authorAgentId,
    title: "C5 cancel proof", status: "active" });
  await db.insert(workflowDefinitions).values({ id: workflowId, companyId: quality.companyId, missionId, name: "C5 cancel",
    stepsJson: [{ id: "produce", name: "Produce", agentId: quality.authorAgentId, dependencies: [],
      conditionalDependencies: [{ stepId: "qa-check", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 }] },
    { id: "qa-check", name: "QA", agentId: quality.verifierAgentId, type: "qa", dependencies: ["produce"] }] });
  await db.insert(workflowRuns).values({ id: runId, companyId: quality.companyId, missionId, workflowId,
    status: "running", triggeredBy: "test", dispatchAuthorityVersion: 1 });
  await db.insert(issues).values([
    { id: producerIssueId, companyId: quality.companyId, missionId, title: "Produce report", status: "todo",
      assigneeAgentId: quality.authorAgentId, originKind: "workflow_execution", originRunId: runId },
    { id: qaIssueId, companyId: quality.companyId, missionId, title: "[QA] Validate report", status: "todo",
      assigneeAgentId: quality.verifierAgentId, originKind: "workflow_execution", originRunId: runId },
  ]);
  await db.insert(workflowStepRuns).values([
    { id: producerStepId, workflowRunId: runId, stepId: "produce", issueId: producerIssueId, status: "pending" },
    { id: qaStepId, workflowRunId: runId, stepId: "qa-check", issueId: qaIssueId, status: "pending" },
  ]);
  const producerEntered = deferred<void>(), producerIssueDone = deferred<void>(), allowProducer = deferred<void>();
  const qaHeld = deferred<unknown>(), qaEntered = deferred<void>(), qaActualRelease = deferred<void>(), uEntered = deferred<void>();
  const uAgentId = randomUUID(), g11UAgentId = randomUUID(), g11UEntered = deferred<void>();
  let producerHeartbeatId = "", qaHeartbeatId = "", qaCalls = 0, g11UCalls = 0;
  releaseProducer = () => allowProducer.resolve();
  releaseQaActual = () => qaActualRelease.resolve();
  const actual: AdapterExecutionResult = { ...finished, usage: { inputTokens: 9, outputTokens: 4 },
    provider: "actual-provider", model: "actual-model", costUsd: 0.25,
    resultJson: { stdout: "preserved actual result", stderr: "" }, sessionId: "c5-actual-session" };
  const actor = (agentId: string, runId: string) => ({ actorType: "agent" as const, actorId: agentId, agentId, runId });
  adapter.mockImplementation(async (context: AdapterExecutionContext) => {
    if (context.agent.id === quality.authorAgentId) {
      producerHeartbeatId = context.runId; producerEntered.resolve();
      await context.onSessionUpdate?.({ sessionId: "c5-actual-session", sessionDisplayId: "c5-actual-session" });
      const [issue] = await db.select().from(issues).where(eq(issues.id, producerIssueId));
      await registerWorkflowArtifact({ db, issue: issue!, actor: actor(quality.authorAgentId, context.runId),
        data: { path: file, type: "document", isPrimary: true } });
      if (!(await registeredProducer(db, quality.companyId, producerIssueId, context.runId))) {
        throw new Error("producer artifact lacks its actual-bound provenance");
      }
      await completeWorkflowIssue({ db, issue: issue!, actor: actor(quality.authorAgentId, context.runId), data: {} });
      producerIssueDone.resolve(); await allowProducer.promise; return actual;
    }
    if (context.agent.id === quality.verifierAgentId) {
      qaHeartbeatId = context.runId;
      qaCalls++; if (qaCalls !== 1) throw new Error("unexpected duplicate QA actual");
      qaEntered.resolve();
      const [issue] = await db.select().from(issues).where(eq(issues.id, qaIssueId));
      await submitWorkflowVerdict({ db, issue: issue!, actor: actor(quality.verifierAgentId, context.runId),
        data: { verdict: "request_changes", findings: [{ id: "draft", summary: "Draft needs repair", layer: "artifact" }],
          remediations: { items: [{ op: "string_replace", file, find: "flawed", replace: "polished" }] } } });
      try {
        await completeWorkflowIssue({ db, issue: issue!, actor: actor(quality.verifierAgentId, context.runId), data: {} });
        throw new Error("QA completion unexpectedly bypassed the active actual drain");
      } catch (error) {
        if (!(error instanceof QaRemediationWorkflowHoldError)) throw error;
        qaHeld.resolve(error);
      }
      await qaActualRelease.promise;
      return { ...finished, resultJson: { stdout: "QA request changes" } };
    }
    if (context.agent.id === uAgentId) { uEntered.resolve(); return finished; }
    if (context.agent.id === g11UAgentId) { g11UCalls++; g11UEntered.resolve(); return finished; }
    throw new Error(`unexpected adapter ${context.agent.id}`);
  });

  const producerWake = await heartbeatService(db).wakeup(quality.authorAgentId, {
    source: "assignment", triggerDetail: "system", reason: "workflow_step_runnable",
    payload: { issueId: producerIssueId, missionId, workflowRunId: runId, workflowStepRunId: producerStepId },
    contextSnapshot: { issueId: producerIssueId, missionId, workflowRunId: runId, workflowStepRunId: producerStepId },
  });
  expect(producerWake).toBeTruthy(); await within(producerEntered.promise, "producer actual entry");
  await within(producerIssueDone.promise, "producer issue completion"); await within(qaEntered.promise, "QA adapter entry");
  const qaError = await within(qaHeld.promise, "pending reservation from official QA request changes");
  expect(qaError).toBeInstanceOf(QaRemediationWorkflowHoldError);
  expect((qaError as QaRemediationWorkflowHoldError).result).toMatchObject({ outcome: "held", reason: "actual_drain_unproven" });
  const [prepRow] = await peer.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, quality.companyId), eq(workflowTransitionEvents.workflowRunId, runId),
    eq(workflowTransitionEvents.eventType, QA_REMEDIATION_PREPARATION_EVENT_TYPE),
  ));
  expect(prepRow).toBeTruthy();
  const prep = parseQaRemediationPreparation(prepRow!.payload);
  const [producerStep] = await peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, producerStepId));
  expect((await readQaRemediationActualDrain(peer, prep, producerStep!)).kind).toBe("held");
  const [runningActual] = await peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, producerHeartbeatId));
  const frozenIdentity = await freezeHeartbeatActualDrainIdentity(peer, runningActual!, { workflowRunId: runId });
  expect(frozenIdentity).toBeTruthy();
  expect(frozenIdentity).toMatchObject({ companyId: quality.companyId, missionId, workflowRunId: runId,
    workflowStepRunId: producerStepId, issueId: producerIssueId, heartbeatRunId: producerWake!.id,
    wakeupRequestId: producerWake!.wakeupRequestId, executionGeneration: runningActual!.workflowExecutionGeneration,
    retryCount: 0, iterationIndex: 0 });
  const [originalWake] = await peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, frozenIdentity!.wakeupRequestId));
  expect(readWorkflowAttemptProof(originalWake!)).toMatchObject({ companyId: quality.companyId,
    agentId: quality.authorAgentId, issueId: producerIssueId, missionId, workflowRunId: runId, stepRunId: producerStepId,
    executionGeneration: runningActual!.workflowExecutionGeneration, retryCount: 0, iterationIndex: 0,
    wakeupRequestId: producerWake!.wakeupRequestId, parentHeartbeatRunId: null });
  const frozenActual = { id: runningActual!.id, issueId: runningActual!.issueId, workflowStepRunId: runningActual!.workflowStepRunId,
    workflowExecutionGeneration: runningActual!.workflowExecutionGeneration, retryOfRunId: runningActual!.retryOfRunId,
    executionToken: runningActual!.executionToken, executorOwnerId: runningActual!.executorOwnerId,
    executorOwnerLeaseEpoch: runningActual!.executorOwnerLeaseEpoch, executorOwnerLeaseToken: runningActual!.executorOwnerLeaseToken };
  const [qaIssueBeforeHold] = await peer.select({ status: issues.status }).from(issues).where(eq(issues.id, qaIssueId));
  expect(qaIssueBeforeHold?.status).toBe("done");
  await expect(workflowService.cancelRun(db, { runId, companyId: quality.otherCompanyId })).resolves.toBe(false);
  await expect(workflowService.cancelRun(db, { runId, companyId: quality.companyId }))
    .rejects.toMatchObject({ name: "QaRemediationAdmissionHold", reason: "cancel_actual_drain_unproven" });
  expect((await peer.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, runId)))[0]?.status).toBe("running");
  expect((await peer.select({ status: issues.status }).from(issues).where(eq(issues.id, qaIssueId)))[0]?.status).toBe(qaIssueBeforeHold?.status);
  expect(await readFile(file, "utf8")).toBe("flawed draft\n");

  const wrongPrepPayload = { ...(prepRow!.payload as Record<string, unknown>), workflowRunId: randomUUID() };
  await peer.update(workflowTransitionEvents).set({ payload: wrongPrepPayload }).where(eq(workflowTransitionEvents.id, prepRow!.id));
  await expect(workflowService.cancelRun(db, { runId, companyId: quality.companyId }))
    .rejects.toMatchObject({ name: "QaRemediationAdmissionHold", reason: "preparation_binding" });
  await peer.update(workflowTransitionEvents).set({ payload: prepRow!.payload }).where(eq(workflowTransitionEvents.id, prepRow!.id));

  await db.insert(agents).values({ id: g11UAgentId, companyId: quality.otherCompanyId, name: "G11 independent U",
    status: "active", adapterType: "codex_local", adapterConfig: { cwd: root },
    runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 1 } } });
  const g11OwnerRuntime = createQaFileOwnerRuntime({ qaFileOwnerLockRoot: lockRoot, qaFileOwnerPython: PYTHON! });
  const [product] = await peer.select().from(issueWorkProducts).where(and(
    eq(issueWorkProducts.companyId, quality.companyId), eq(issueWorkProducts.issueId, producerIssueId), eq(issueWorkProducts.status, "active"),
  ));
  expect(product).toBeTruthy();
  const productMetadata = product!.metadata;
  const g11Blocker = await g11OwnerRuntime.begin([file]);
  let lockWaiting = deferred<void>();
  const signalReady = deferred<void>(), signalSeen = deferred<void>();
  const signalExited = deferred<{ code: number | null; signal: NodeJS.Signals | null }>();
  let signalText = "", nativeOwnerClosed = false, signalAfterOwnerClose = false;
  const signalChild = spawn(process.execPath, ["-e",
    "process.on('SIGTERM', () => { process.stdout.write('SIGTERM\\n'); process.exit(0); }); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);"],
  { stdio: ["ignore", "pipe", "inherit"] });
  signalChild.stdout?.on("data", chunk => {
    signalText += String(chunk);
    if (signalText.includes("ready\n")) signalReady.resolve();
    if (signalText.includes("SIGTERM\n")) {
      signalAfterOwnerClose = nativeOwnerClosed;
      signalSeen.resolve();
    }
  });
  signalChild.once("exit", (code, signal) => signalExited.resolve({ code, signal }));
  await within(signalReady.promise, "G11 signal witness readiness");
  runningProcesses.set(producerHeartbeatId, { child: signalChild, graceSec: 1 });
  const realBegin = QaRemediationFileOwner.begin.bind(QaRemediationFileOwner);
  let revocationOwner: Awaited<ReturnType<typeof realBegin>> | undefined;
  const nativeSpy = vi.spyOn(QaRemediationFileOwner, "begin").mockImplementation(async input => {
    if (!input.targets.includes(file)) return realBegin(input);
    expect(input.helperPath).toBe(NATIVE_HELPER);
    const owner = await realBegin({ ...input, onEvent: event => {
      if (event.type === "lock_wait" && event.target === file) lockWaiting.resolve();
      input.onEvent?.(event);
    } });
    const close = owner.close.bind(owner);
    vi.spyOn(owner, "close").mockImplementation(async () => {
      const exit = await close();
      nativeOwnerClosed = exit?.code === 0 && exit.signal === null;
      return exit;
    });
    revocationOwner = owner;
    return owner;
  });
  let g11Cancellation = heartbeatService(db).cancelRun(producerHeartbeatId).then(
    value => ({ value }), error => ({ error }),
  );
  let g11BlockerReleased = false;
  try {
    await within(lockWaiting.promise, "public heartbeat cancel native lock_wait");
    await within(peer.transaction(async tx => {
      expect(await tx.select({ id: missions.id }).from(missions).where(eq(missions.id, missionId)).for("no key update"))
        .toHaveLength(1);
      expect(await tx.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.id, runId)).for("no key update"))
        .toHaveLength(1);
      expect(await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, quality.companyId)).for("share"))
        .toHaveLength(1);
      expect(await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, quality.authorAgentId)).for("no key update"))
        .toHaveLength(1);
      expect(await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.id, producerHeartbeatId)).for("update"))
        .toHaveLength(1);
      expect(await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, producerIssueId)).for("update"))
        .toHaveLength(1);
      expect(await tx.select({ id: workflowStepRuns.id }).from(workflowStepRuns).where(eq(workflowStepRuns.id, producerStepId)).for("update"))
        .toHaveLength(1);
      expect(await tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, producerWake!.wakeupRequestId)).for("update")).toHaveLength(1);
    }), "peer commits heartbeat revocation domain prefix during native wait");
    const unrelated = await heartbeatService(db).wakeup(g11UAgentId, {
      source: "on_demand", triggerDetail: "manual", reason: "g11-unrelated-U",
    });
    expect(unrelated).toBeTruthy();
    await within(g11UEntered.promise, "G11 unrelated U actual entry");
    await vi.waitFor(async () => expect((await peer.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, unrelated!.id)))[0]?.status).toBe("succeeded"), { timeout: 20_000, interval: 10 });
    expect(g11UCalls).toBe(1);
    expect(await peer.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, g11UAgentId))).toHaveLength(1);
    expect((await peer.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, producerHeartbeatId)))[0]?.status).toBe("running");
    expect((await readQaRemediationActualDrain(peer, prep, producerStep!)).kind).toBe("held");
    expect(await readFile(file, "utf8")).toBe("flawed draft\n");

    await peer.update(issueWorkProducts).set({ metadata: { ...productMetadata, workflowProducer: null } })
      .where(eq(issueWorkProducts.id, product!.id));
    expect(await g11Blocker.close()).toEqual({ code: 0, signal: null });
    g11BlockerReleased = true;
    const sourceRebind = await within(g11Cancellation, "source rebind is rechecked after native acquisition");
    expect("error" in sourceRebind ? sourceRebind.error : null).toMatchObject({
      message: "heartbeat_pause_revocation_scope_unproven", status: 409,
    });
    expect(nativeOwnerClosed).toBe(true);
    expect(revocationOwner).toBeTruthy();
    expect(await within(revocationOwner!.awaitExit(), "source rebind owner exits positively")).toEqual({ code: 0, signal: null });
    expect(signalText).not.toContain("SIGTERM\n");
    expect((await peer.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, producerHeartbeatId)))[0]?.status).toBe("running");
    await peer.update(issueWorkProducts).set({ metadata: productMetadata }).where(eq(issueWorkProducts.id, product!.id));

    nativeOwnerClosed = false;
    signalAfterOwnerClose = false;
    revocationOwner = undefined;
    g11Cancellation = heartbeatService(db).cancelRun(producerHeartbeatId).then(
      value => ({ value }), error => ({ error }),
    );
    const cancellation = await within(g11Cancellation, "heartbeat cancellation commits before actual release");
    expect("value" in cancellation && cancellation.value).toMatchObject({ id: producerHeartbeatId, status: "cancelled" });
    expect(nativeOwnerClosed).toBe(true);
    expect(revocationOwner).toBeTruthy();
    expect(await within(revocationOwner!.awaitExit(), "revocation owner exits positively")).toEqual({ code: 0, signal: null });
    await within(signalSeen.promise, "authorized SIGTERM before producer actual release");
    expect(signalAfterOwnerClose).toBe(true);
    expect(await within(signalExited.promise, "signal witness exits")).toEqual({ code: 0, signal: null });
    expect((await peer.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, producerHeartbeatId)))[0]?.status).toBe("cancelled");
    expect(await peer.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.workflowRunId, runId), eq(workflowTransitionEvents.workflowStepRunId, producerStepId),
      eq(workflowTransitionEvents.eventType, "heartbeat_actual_drained_v1"),
    ))).toHaveLength(0);
    expect((await readQaRemediationActualDrain(peer, prep, producerStep!)).kind).toBe("held");
    expect(await peer.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.workflowRunId, runId),
      eq(workflowTransitionEvents.eventType, "qa_remediation_completed"),
    ))).toHaveLength(0);
    expect(await readFile(file, "utf8")).toBe("flawed draft\n");
  } finally {
    if (!g11BlockerReleased) await g11Blocker.close();
    nativeSpy.mockRestore();
    await g11Cancellation;
    runningProcesses.delete(producerHeartbeatId);
    if (signalChild.exitCode === null && signalChild.signalCode === null) {
      signalChild.kill("SIGKILL");
      await within(signalExited.promise, "G11 signal witness cleanup");
    }
  }

  const qaBlocker = await g11OwnerRuntime.begin([file]);
  const qaLockWaiting = deferred<void>(), realQaBegin = QaRemediationFileOwner.begin.bind(QaRemediationFileOwner);
  let qaRevocationOwner: Awaited<ReturnType<typeof realQaBegin>> | undefined, qaBlockerReleased = false;
  const qaNativeSpy = vi.spyOn(QaRemediationFileOwner, "begin").mockImplementation(async input => {
    if (!input.targets.includes(file)) return realQaBegin(input);
    return realQaBegin({ ...input, onEvent: event => {
      if (event.type === "lock_wait" && event.target === file) qaLockWaiting.resolve();
      input.onEvent?.(event);
    } }).then(owner => { qaRevocationOwner = owner; return owner; });
  });
  const qaCancellation = heartbeatService(db).cancelRun(qaHeartbeatId).then(
    value => ({ value }), error => ({ error }),
  );
  try {
    await within(qaLockWaiting.promise, "QA-subject heartbeat cancellation native lock_wait");
    expect((await peer.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, qaHeartbeatId)))[0]?.status).toBe("running");
    expect((await peer.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, producerHeartbeatId)))[0]?.status).toBe("cancelled");
    expect(await peer.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.workflowRunId, runId),
      eq(workflowTransitionEvents.eventType, "qa_remediation_completed"),
    ))).toHaveLength(0);
    expect(await qaBlocker.close()).toEqual({ code: 0, signal: null });
    qaBlockerReleased = true;
    const qaRevoked = await within(qaCancellation, "QA-subject heartbeat cancellation commits before actual release");
    expect("value" in qaRevoked && qaRevoked.value).toMatchObject({ id: qaHeartbeatId, status: "cancelled" });
    expect(qaRevocationOwner).toBeTruthy();
    expect(await within(qaRevocationOwner!.awaitExit(), "QA-subject revocation owner exits positively"))
      .toEqual({ code: 0, signal: null });
    expect(qaCalls).toBe(1);
    expect(await peer.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.workflowRunId, runId),
      eq(workflowTransitionEvents.eventType, "qa_remediation_completed"),
    ))).toHaveLength(0);
  } finally {
    if (!qaBlockerReleased) await qaBlocker.close();
    qaNativeSpy.mockRestore();
    await qaCancellation;
    releaseQaActual?.();
    releaseQaActual = null;
  }

  await peer.update(issueWorkProducts).set({ metadata: { ...productMetadata, workflowProducer: null } })
    .where(eq(issueWorkProducts.id, product!.id));
  allowProducer.resolve(); releaseProducer = null; await waitForHeartbeatExecutionsToDrain(db, 60_000);
  const [settledActual] = await peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, producerHeartbeatId));
  expect({ id: settledActual!.id, issueId: settledActual!.issueId, workflowStepRunId: settledActual!.workflowStepRunId,
    workflowExecutionGeneration: settledActual!.workflowExecutionGeneration, retryOfRunId: settledActual!.retryOfRunId,
    executionToken: settledActual!.executionToken, executorOwnerId: settledActual!.executorOwnerId,
    executorOwnerLeaseEpoch: settledActual!.executorOwnerLeaseEpoch, executorOwnerLeaseToken: settledActual!.executorOwnerLeaseToken }).toEqual(frozenActual);
  expect(settledActual!.resultJson).toEqual(actual.resultJson);
  expect(settledActual!.sessionIdAfter).toBe("c5-actual-session");
  expect(settledActual!.usageJson).toMatchObject({ inputTokens: 9, outputTokens: 4, provider: "actual-provider", model: "actual-model", costUsd: 0.25 });
  expect((await peer.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.workflowRunId, runId), eq(workflowTransitionEvents.workflowStepRunId, producerStepId),
    eq(workflowTransitionEvents.eventType, "heartbeat_actual_drained_v1"),
  ))).length).toBe(1);
  const [drainedStep] = await peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, producerStepId));
  expect((await readQaRemediationActualDrain(peer, prep, drainedStep!)).kind).toBe("held");
  await expect(workflowService.cancelRun(db, { runId, companyId: quality.companyId }))
    .rejects.toMatchObject({ name: "QaRemediationAdmissionHold", reason: "cancel_actual_drain_unproven" });
  await peer.update(issueWorkProducts).set({ metadata: productMetadata }).where(eq(issueWorkProducts.id, product!.id));
  expect((await readQaRemediationActualDrain(peer, prep, drainedStep!)).kind).toBe("proven");

  await db.insert(agents).values({ id: uAgentId, companyId: quality.otherCompanyId, name: "Independent U", status: "active",
    adapterType: "codex_local", adapterConfig: { cwd: root }, runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 1 } } });
  const ownerRuntime = createQaFileOwnerRuntime({ qaFileOwnerLockRoot: lockRoot, qaFileOwnerPython: PYTHON! });
  const blockedCancel = async (duringWait: () => Promise<void>, expectedHold: string | null) => {
    const waiting = deferred<void>(), realBegin = QaRemediationFileOwner.begin.bind(QaRemediationFileOwner);
    let cancelOwner: Awaited<ReturnType<typeof realBegin>> | undefined, released = false;
    const spy = vi.spyOn(QaRemediationFileOwner, "begin").mockImplementation(async input => {
      if (input.targets.includes(file)) {
        expect(input.helperPath).toBe(NATIVE_HELPER);
        return realBegin({ ...input, onEvent: event => {
          if (event.type === "lock_wait" && event.target === file) waiting.resolve();
          input.onEvent?.(event);
        } }).then(owner => { cancelOwner = owner; return owner; });
      }
      return realBegin(input);
    });
    const result = workflowService.cancelRun(db, { runId, companyId: quality.companyId })
      .then(value => ({ value }), error => ({ error }));
    try {
      await within(waiting.promise, `public cancel native lock_wait ${file}`); await duringWait();
      released = true; expect(await blocker.close()).toEqual({ code: 0, signal: null });
      const outcome = await within(result, "guarded public cancellation");
      if (expectedHold === null) expect("value" in outcome && outcome.value).toBe(true);
      else expect("error" in outcome ? outcome.error : null).toMatchObject({ name: "QaRemediationAdmissionHold", reason: expectedHold });
      expect(cancelOwner).toBeTruthy();
      expect(await within(cancelOwner!.awaitExit(), "cancel owner clean exit")).toEqual({ code: 0, signal: null });
      return "error" in outcome ? outcome.error : outcome.value;
    } finally {
      if (!released) await blocker.close(); spy.mockRestore(); await result;
    }
  };
  let blocker = await ownerRuntime.begin([file]);
  const authorityError = await blockedCancel(async () => {
    await peer.transaction(async tx => {
      expect(await tx.select({ id: missions.id }).from(missions).where(and(
        eq(missions.id, missionId), eq(missions.companyId, quality.companyId),
      )).for("update")).toHaveLength(1);
    });
    const u = await heartbeatService(db).wakeup(uAgentId, { source: "on_demand", triggerDetail: "manual", reason: "unrelated-U" });
    expect(u).toBeTruthy(); await within(uEntered.promise, "independent U adapter entry");
    await vi.waitFor(async () => expect((await peer.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, u!.id)))[0]?.status).toBe("succeeded"), { timeout: 20_000, interval: 10 });
    await peer.update(workflowRuns).set({ dispatchAuthorityVersion: 2 }).where(eq(workflowRuns.id, runId));
  }, "cancel_pending_scope_unproven");
  expect(authorityError).toMatchObject({ reason: "cancel_pending_scope_unproven" });
  expect((await peer.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, runId)))[0]?.status).toBe("running");
  await peer.update(workflowRuns).set({ dispatchAuthorityVersion: 1 }).where(eq(workflowRuns.id, runId));

  blocker = await ownerRuntime.begin([file]);
  const childError = await blockedCancel(async () => {
    await peer.update(workflowRuns).set({ triggeredBy: "workflow-step" }).where(eq(workflowRuns.id, runId));
  }, "cancel_child_scope_changed");
  expect(childError).toMatchObject({ reason: "cancel_child_scope_changed" });
  expect((await peer.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, runId)))[0]?.status).toBe("running");
  await peer.update(workflowRuns).set({ triggeredBy: "test" }).where(eq(workflowRuns.id, runId));
  await expect(db.transaction(tx => workflowService.cancelRun(tx as unknown as Db, { runId, companyId: quality.companyId })))
    .rejects.toBeInstanceOf(QaRemediationAdmissionHold);

  const preparationsBefore = await peer.select({ id: workflowTransitionEvents.id, key: workflowTransitionEvents.idempotencyKey })
    .from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.workflowRunId, runId),
      eq(workflowTransitionEvents.eventType, QA_REMEDIATION_PREPARATION_EVENT_TYPE)));
  const qaWakesBefore = await peer.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, quality.companyId), eq(agentWakeupRequests.workflowRunId, runId),
    eq(agentWakeupRequests.workflowStepRunId, qaStepId), eq(agentWakeupRequests.issueId, qaIssueId),
  ));
  blocker = await ownerRuntime.begin([file]);
  const cancelled = await blockedCancel(async () => {}, null);
  expect(cancelled).toBe(true);
  expect((await peer.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, runId)))[0]?.status).toBe("cancelled");
  expect(await workflowService.cancelRun(db, { runId, companyId: quality.companyId })).toBe(false);
  expect(await peer.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.workflowRunId, runId), eq(workflowTransitionEvents.eventType, "qa_remediation_completed"),
  ))).toHaveLength(0);
  expect(await peer.select({ id: workflowTransitionEvents.id, key: workflowTransitionEvents.idempotencyKey })
    .from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.workflowRunId, runId),
      eq(workflowTransitionEvents.eventType, QA_REMEDIATION_PREPARATION_EVENT_TYPE)))).toEqual(preparationsBefore);
  expect(await peer.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, quality.companyId), eq(agentWakeupRequests.workflowRunId, runId),
    eq(agentWakeupRequests.workflowStepRunId, qaStepId), eq(agentWakeupRequests.issueId, qaIssueId),
  ))).toEqual(qaWakesBefore);
  expect(await peer.select({ id: workflowRecoveryAuthorities.id }).from(workflowRecoveryAuthorities)
    .where(eq(workflowRecoveryAuthorities.replacementRunId, runId))).toHaveLength(0);
  expect((await peer.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, quality.companyId), eq(heartbeatRuns.issueId, producerIssueId),
    eq(heartbeatRuns.workflowStepRunId, producerStepId),
  )))).toHaveLength(1);
  expect(await readFile(file, "utf8")).toBe("flawed draft\n");
  expect((await peer.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.workflowRunId, runId), eq(workflowTransitionEvents.workflowStepRunId, producerStepId),
    eq(workflowTransitionEvents.eventType, "heartbeat_actual_drained_v1"),
  )))).toHaveLength(1);
  const [finalActual] = await peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, producerHeartbeatId));
  expect(finalActual!.resultJson).toEqual(actual.resultJson);
  expect({ id: finalActual!.id, issueId: finalActual!.issueId, workflowStepRunId: finalActual!.workflowStepRunId,
    workflowExecutionGeneration: finalActual!.workflowExecutionGeneration, retryOfRunId: finalActual!.retryOfRunId,
    executionToken: finalActual!.executionToken, executorOwnerId: finalActual!.executorOwnerId,
    executorOwnerLeaseEpoch: finalActual!.executorOwnerLeaseEpoch, executorOwnerLeaseToken: finalActual!.executorOwnerLeaseToken }).toEqual(frozenActual);
  const makeMissionlessRun = async (withHistory: boolean) => {
    const id = randomUUID(), wf = randomUUID();
    await db.insert(workflowDefinitions).values({ id: wf, companyId: quality.companyId, name: "Missionless cancel", stepsJson: [] });
    await db.insert(workflowRuns).values({ id, workflowId: wf, companyId: quality.companyId, status: "running", triggeredBy: "test" });
    if (withHistory) await db.insert(workflowTransitionEvents).values({ companyId: quality.companyId, workflowRunId: id,
      eventType: QA_REMEDIATION_PREPARATION_EVENT_TYPE, layer: "workflow_validation", payload: {} });
    return id;
  };
  const missionlessWithHistory = await makeMissionlessRun(true);
  await expect(workflowService.cancelRun(db, { runId: missionlessWithHistory, companyId: quality.companyId }))
    .rejects.toMatchObject({ name: "QaRemediationAdmissionHold", reason: "invalid_preparation" });
  expect((await peer.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, missionlessWithHistory)))[0]?.status).toBe("running");
  const ordinaryMissionless = await makeMissionlessRun(false);
  expect(await workflowService.cancelRun(db, { runId: ordinaryMissionless, companyId: quality.companyId })).toBe(true);
  expect(await workflowService.cancelRun(db, { runId: ordinaryMissionless, companyId: quality.companyId })).toBe(false);
});

it("accepts transaction-owned first pause-head initialization for pause and terminate", async () => {
  const pausedAgentId = randomUUID(), terminatedAgentId = randomUUID();
  const makeAgent = (id: string, name: string) => ({ id, companyId: quality.companyId, name, status: "active",
    adapterType: "codex_local", adapterConfig: { cwd: root },
    runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 1 } } });
  await db.insert(agents).values([makeAgent(pausedAgentId, "G11 fresh pause"), makeAgent(terminatedAgentId, "G11 fresh terminate")]);

  const paused = await heartbeatService(db).pauseAgent(pausedAgentId);
  expect(paused).toMatchObject({ id: pausedAgentId, status: "paused" });
  const pauseControls = await readPauseControls(db, pausedAgentId);
  expect(pauseControls.filter(record => record.kind === "head")).toHaveLength(1);

  const terminated = await heartbeatService(db).terminateAgent(terminatedAgentId);
  expect(terminated).toMatchObject({ id: terminatedAgentId, status: "terminated" });
  const terminateControls = await readPauseControls(db, terminatedAgentId);
  expect(terminateControls.filter(record => record.kind === "head")).toHaveLength(1);
});

  afterAll(() => {
    releaseProducer?.();
    releaseQaActual?.();
  });
}
