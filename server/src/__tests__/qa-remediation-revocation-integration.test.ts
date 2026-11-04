import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { agentWakeupRequests, agents, companies, heartbeatRuns, instanceSettings, issueWorkProducts, issues, missionAgentRuntimes, missions,
  workflowDefinitions, workflowRuns, workflowStepInvocations, workflowStepRuns, workflowTransitionEvents, workflowRecoveryAuthorities, type Db } from "@paperclipai/db";
import { runningProcesses } from "../adapters/index.js";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../adapters/types.js";
import { heartbeatService } from "../services/heartbeat.js";
import { readPauseControls } from "../services/heartbeat-pause-delivery.js";
import { freezeHeartbeatActualDrainIdentity, readQaRemediationActualDrain } from "../services/heartbeat-actual-drain.js";
import { readWorkflowAttemptProof } from "../services/heartbeat-finalization/workflow-attempt-proof.js";
import { registeredProducer } from "../services/work-products/producer-provenance.js";
import { resolveWorkProductLocalFilePath } from "../services/work-products.js";
import { QaRemediationAdmissionHold, unresolvedQaRemediationAdmissionPending } from "../services/workflow/control-flow/qa-remediation-admission-root.js";
import { QaRemediationWorkflowHoldError } from "../services/workflow/control-flow/qa-correction-followup-reconcile.js";
import { createQaFileOwnerRuntime } from "../services/workflow/control-flow/qa-remediation-runtime.js";
import { parseQaRemediationPreparation, QA_REMEDIATION_PREPARATION_EVENT_TYPE } from "../services/workflow/control-flow/qa-remediation-preparation-contract.js";
import { QaRemediationFileOwner } from "../services/workflow/control-flow/qa-remediation-file-owner.js";
import { completeWorkflowIssue, registerWorkflowArtifact, submitWorkflowVerdict } from "../services/workflow/agent-api.js";
import { workflowService } from "../services/workflow/engine.js";
import { cancelWorkflowRunWithCleanup } from "../services/workflow/dag-engine.js";
import { createQaCorrectionTestDb } from "./helpers/qa-correction-fixture.js";
import { seedQualityFixture } from "./helpers/quality-fixture.js";
import { childStep, configureWorkflowChildFixtures, insertDefinition, insertRunWithWorkflowStepRun } from "./helpers/workflow-child-fixtures.js";
import { insertMaterializedChildRun } from "./helpers/workflow-child-invocation-fixtures.js";
import { deferred, NATIVE_HELPER, PYTHON, within } from "./helpers/qa-remediation-parent-death-harness.js";
import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";

const adapter = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", async original => ({
  ...await original<typeof import("../adapters/index.js")>(),
  getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute: adapter }),
}));
const finished: AdapterExecutionResult = { exitCode: 0, signal: null, timedOut: false, usage: null,
  provider: "test", model: "test", resultJson: { stdout: "", stderr: "" }, runtimeServices: [] };
let owned: Awaited<ReturnType<typeof createQaCorrectionTestDb>>, db: Db, peer: Db;
let quality: Awaited<ReturnType<typeof seedQualityFixture>>, root = "", lockRoot = "";
let releaseProducer: (() => void) | null = null;
let releaseQaActual: (() => void) | null = null;
let linkedDiagnosticTimer: ReturnType<typeof setTimeout> | null = null;
let linkedDiagnosticCapture: Promise<void> | null = null;
let linkedNativeCleanup: (() => Promise<void>) | null = null;

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "c5-revocation-")));
  lockRoot = await realpath(await mkdtemp(path.join(root, "locks-"))); await chmod(lockRoot, 0o700);
  vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
  vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", path.join(root, "storage"));
  vi.stubEnv("PAPERCLIP_WORKFLOW_INSTANT_ADVANCE", "0");
  vi.stubEnv("PAPERCLIP_QA_FILE_OWNER_LOCK_ROOT", lockRoot);
  vi.stubEnv("PAPERCLIP_QA_FILE_OWNER_PYTHON", PYTHON!);
  owned = await createQaCorrectionTestDb(); db = owned.db; peer = owned.connect(); quality = await seedQualityFixture(db);
  configureWorkflowChildFixtures(db);
  await db.insert(instanceSettings).values({ singletonKey: "default", experimental: { enableHeartbeatFinalizationV1: true } })
    .onConflictDoUpdate({ target: instanceSettings.singletonKey, set: { experimental: { enableHeartbeatFinalizationV1: true } } });
  expect((await db.select({ experimental: instanceSettings.experimental }).from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, "default")))[0]?.experimental).toMatchObject({ enableHeartbeatFinalizationV1: true });
  await db.update(companies).set({ workProductRoot: root }).where(eq(companies.id, quality.companyId));
  await db.update(agents).set({ status: "active", adapterType: "codex_local", adapterConfig: { cwd: root },
    runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 2 } } })
    .where(and(eq(agents.companyId, quality.companyId), eq(agents.id, quality.authorAgentId)));
  await db.update(agents).set({ status: "active", adapterType: "codex_local", adapterConfig: { cwd: root },
    runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 2 } } })
    .where(and(eq(agents.companyId, quality.companyId), eq(agents.id, quality.verifierAgentId)));
}, 120_000);

afterAll(async () => {
  if (linkedDiagnosticTimer) clearTimeout(linkedDiagnosticTimer);
  linkedDiagnosticTimer = null;
  releaseProducer?.();
  releaseQaActual?.();
  await linkedNativeCleanup?.();
  if (linkedDiagnosticCapture) await linkedDiagnosticCapture;
  if (db) await waitForHeartbeatExecutionsToDrain(db, 60_000);
  await owned?.close(); vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true });
}, 120_000);

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

it("holds supplied linked-child cancellation through actual drain and native owner exit", async () => {
  const diagnosticStartedAt = Date.now();
  let diagnosticPhase = "test_enter";
  let qaCalls = 0;
  let lastNativeEvent: unknown = null;
  let cancelOutcome: Record<string, unknown> = { kind: "not_started" };
  const qaAttemptIdentities: Array<Record<string, unknown>> = [];
  const diagnostic = (event: string, details: Record<string, unknown> = {}) => {
    console.error(`[C5-G10B-DIAG] ${JSON.stringify({ elapsedMs: Date.now() - diagnosticStartedAt,
      event, phase: diagnosticPhase, qaCalls, ...details })}`);
  };
  const phase = (name: string, edge: "enter" | "exit", details: Record<string, unknown> = {}) => {
    diagnosticPhase = edge === "enter" ? name : `${name}:done`;
    diagnostic(`${name}.${edge}`, details);
  };
  let captureDiagnosticSnapshot: ((reason: string) => Promise<void>) | null = null;
  linkedDiagnosticCapture = null;
  linkedDiagnosticTimer = setTimeout(() => {
    const capture = captureDiagnosticSnapshot
      ? captureDiagnosticSnapshot("6s_pre_outer_deadline")
      : Promise.resolve().then(() => diagnostic("snapshot_not_ready", { reason: "6s_pre_outer_deadline" }));
    linkedDiagnosticCapture = capture.catch(error => {
      diagnostic("snapshot_failed", { reason: String(error) });
    });
  }, 6_000);
  const missionId = randomUUID(), childWorkflowId = randomUUID(), producerIssueId = randomUUID(), qaIssueId = randomUUID();
  const file = path.join(root, "missions", missionId, "runs", "linked-child", "steps", "produce", "report.md");
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, "flawed draft\n", "utf8");
  await db.insert(missions).values({ id: missionId, companyId: quality.companyId, ownerAgentId: quality.authorAgentId,
    title: "C5 linked-child cancel proof", status: "active" });
  await db.insert(workflowDefinitions).values({ id: childWorkflowId, companyId: quality.companyId, missionId,
    name: "C5 linked child", stepsJson: [{ id: "produce", name: "Produce", agentId: quality.authorAgentId, dependencies: [],
      conditionalDependencies: [{ stepId: "qa-check", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 }] },
    { id: "qa-check", name: "QA", agentId: quality.verifierAgentId, type: "qa", dependencies: ["produce"] }] });
  const parentWorkflowId = await insertDefinition({ companyId: quality.companyId, name: "C5 linked parent",
    steps: [childStep(childWorkflowId)] });
  await db.update(workflowDefinitions).set({ missionId }).where(eq(workflowDefinitions.id, parentWorkflowId));
  const parent = await insertRunWithWorkflowStepRun({ companyId: quality.companyId, workflowId: parentWorkflowId });
  await db.update(workflowRuns).set({ missionId }).where(eq(workflowRuns.id, parent.runId));
  const child = await insertMaterializedChildRun(db, { companyId: quality.companyId, parentRunId: parent.runId,
    parentStepRunId: parent.stepRunId, childWorkflowId, stepIds: ["produce", "qa-check"], childStatus: "running" });
  const runId = child.childRunId;
  await db.update(workflowRuns).set({ missionId, dispatchAuthorityVersion: 1 }).where(eq(workflowRuns.id, runId));
  const [producerStep] = await db.select().from(workflowStepRuns).where(and(
    eq(workflowStepRuns.workflowRunId, runId), eq(workflowStepRuns.stepId, "produce"),
  ));
  const [qaStep] = await db.select().from(workflowStepRuns).where(and(
    eq(workflowStepRuns.workflowRunId, runId), eq(workflowStepRuns.stepId, "qa-check"),
  ));
  expect(producerStep).toBeTruthy(); expect(qaStep).toBeTruthy();
  await db.insert(issues).values([
    { id: producerIssueId, companyId: quality.companyId, missionId, title: "Produce linked report", status: "todo",
      assigneeAgentId: quality.authorAgentId, originKind: "workflow_execution", originRunId: runId },
    { id: qaIssueId, companyId: quality.companyId, missionId, title: "[QA] Validate linked report", status: "todo",
      assigneeAgentId: quality.verifierAgentId, originKind: "workflow_execution", originRunId: runId },
  ]);
  await db.update(workflowStepRuns).set({ issueId: producerIssueId }).where(eq(workflowStepRuns.id, producerStep!.id));
  await db.update(workflowStepRuns).set({ issueId: qaIssueId }).where(eq(workflowStepRuns.id, qaStep!.id));

  const childParentFence = { invocationId: child.invocationId, generation: child.generation,
    parentRunId: child.parentRunId, parentStepRunId: child.parentStepRunId };
  const producerEntered = deferred<void>(), producerIssueDone = deferred<void>(), allowProducer = deferred<void>();
  const qaHeld = deferred<unknown>(), qaEntered = deferred<void>(), uEntered = deferred<void>();
  const uAgentId = randomUUID();
  let producerHeartbeatId = "", qaHeartbeatId = "";
  releaseProducer = () => allowProducer.resolve();
  const actual: AdapterExecutionResult = { ...finished, usage: { inputTokens: 9, outputTokens: 4 },
    provider: "actual-provider", model: "actual-model", costUsd: 0.25,
    resultJson: { stdout: "preserved linked actual result", stderr: "" }, sessionId: "c5-linked-actual-session" };
  const actor = (agentId: string, runId: string) => ({ actorType: "agent" as const, actorId: agentId, agentId, runId });
  const readAdapterIdentity = async (context: AdapterExecutionContext) => {
    const [heartbeat] = await peer.select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId,
      status: heartbeatRuns.status, issueId: heartbeatRuns.issueId, wakeupRequestId: heartbeatRuns.wakeupRequestId,
      workflowStepRunId: heartbeatRuns.workflowStepRunId, workflowExecutionGeneration: heartbeatRuns.workflowExecutionGeneration })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, context.runId));
    const [wake] = heartbeat?.wakeupRequestId ? await peer.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, heartbeat.wakeupRequestId)) : [];
    const [issue] = heartbeat?.issueId ? await peer.select({ id: issues.id, status: issues.status,
      missionId: issues.missionId, originRunId: issues.originRunId }).from(issues).where(eq(issues.id, heartbeat.issueId)) : [];
    const [step] = heartbeat?.workflowStepRunId ? await peer.select({ id: workflowStepRuns.id, workflowRunId: workflowStepRuns.workflowRunId,
      stepId: workflowStepRuns.stepId, issueId: workflowStepRuns.issueId, status: workflowStepRuns.status })
      .from(workflowStepRuns).where(eq(workflowStepRuns.id, heartbeat.workflowStepRunId)) : [];
    return { agentId: context.agent.id, heartbeatRunId: context.runId, heartbeatStatus: heartbeat?.status ?? null,
      wakeupRequestId: heartbeat?.wakeupRequestId ?? null, wakeupStatus: wake?.status ?? null,
      issueId: heartbeat?.issueId ?? wake?.issueId ?? null, issueStatus: issue?.status ?? null,
      workflowRunId: wake?.workflowRunId ?? issue?.originRunId ?? null,
      workflowStepRunId: heartbeat?.workflowStepRunId ?? wake?.workflowStepRunId ?? null,
      stepId: step?.stepId ?? null, stepStatus: step?.status ?? null,
      workflowExecutionGeneration: heartbeat?.workflowExecutionGeneration ?? null };
  };
  captureDiagnosticSnapshot = async (reason: string) => {
    const [childRun] = await peer.select({ id: workflowRuns.id, status: workflowRuns.status,
      dispatchAuthorityVersion: workflowRuns.dispatchAuthorityVersion }).from(workflowRuns).where(eq(workflowRuns.id, runId));
    const [producerActual] = producerHeartbeatId ? await peer.select({ id: heartbeatRuns.id, status: heartbeatRuns.status,
      issueId: heartbeatRuns.issueId, wakeupRequestId: heartbeatRuns.wakeupRequestId,
      workflowStepRunId: heartbeatRuns.workflowStepRunId, workflowExecutionGeneration: heartbeatRuns.workflowExecutionGeneration })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, producerHeartbeatId)) : [];
    const [qaActual] = qaHeartbeatId ? await peer.select({ id: heartbeatRuns.id, status: heartbeatRuns.status,
      issueId: heartbeatRuns.issueId, wakeupRequestId: heartbeatRuns.wakeupRequestId,
      workflowStepRunId: heartbeatRuns.workflowStepRunId, workflowExecutionGeneration: heartbeatRuns.workflowExecutionGeneration })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, qaHeartbeatId)) : [];
    const childSteps = await peer.select({ id: workflowStepRuns.id, stepId: workflowStepRuns.stepId,
      issueId: workflowStepRuns.issueId, status: workflowStepRuns.status }).from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId)).orderBy(workflowStepRuns.id);
    const receipts = await peer.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, quality.companyId), eq(workflowTransitionEvents.missionId, missionId),
      eq(workflowTransitionEvents.workflowRunId, runId), eq(workflowTransitionEvents.eventType, "heartbeat_actual_drained_v1"),
    ));
    const actualQaReceipts = receipts.filter(event => event.workflowStepRunId === qaStep!.id || event.heartbeatRunId === qaHeartbeatId)
      .map(event => ({ eventId: event.id, companyId: event.companyId, missionId: event.missionId,
        workflowRunId: event.workflowRunId, workflowStepRunId: event.workflowStepRunId, issueId: event.issueId,
        heartbeatRunId: event.heartbeatRunId,
        identity: (event.payload as { identity?: unknown } | null)?.identity ?? null }));
    let dbLockEvidence: unknown = "not queried; phase is not the peer P/I/S/C lock barrier";
    if (diagnosticPhase === "peer_pisc_locks") {
      try {
        dbLockEvidence = await peer.execute(sql`select pid, state, wait_event_type, wait_event, pg_blocking_pids(pid) as blocking_pids
          from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()
          and (wait_event_type = 'Lock' or cardinality(pg_blocking_pids(pid)) > 0)`);
      } catch (error) { dbLockEvidence = { unavailable: String(error) }; }
    }
    diagnostic("snapshot", { reason, expectedQaReceipt: { companyId: quality.companyId, missionId, workflowRunId: runId,
      workflowStepRunId: qaStep!.id, stepId: qaStep!.stepId, issueId: qaIssueId, heartbeatRunId: qaHeartbeatId || null,
      wakeupRequestId: qaActual?.wakeupRequestId ?? null }, actualQaReceipts,
      child: childRun ?? null, childSteps, producerActual: producerActual ?? null, qaActual: qaActual ?? null,
      qaAttempts: qaAttemptIdentities, qaCalls, lastNativeEvent, cancelOutcome, dbLockEvidence });
  };
  adapter.mockImplementation(async (context: AdapterExecutionContext) => {
    if (context.agent.id === quality.authorAgentId) {
      producerHeartbeatId = context.runId; producerEntered.resolve();
      await context.onSessionUpdate?.({ sessionId: "c5-linked-actual-session", sessionDisplayId: "c5-linked-actual-session" });
      const [issue] = await db.select().from(issues).where(eq(issues.id, producerIssueId));
      await registerWorkflowArtifact({ db, issue: issue!, actor: actor(quality.authorAgentId, context.runId),
        data: { path: file, type: "document", isPrimary: true } });
      if (!(await registeredProducer(db, quality.companyId, producerIssueId, context.runId))) {
        throw new Error("linked producer artifact lacks its actual-bound provenance");
      }
      await completeWorkflowIssue({ db, issue: issue!, actor: actor(quality.authorAgentId, context.runId), data: {} });
      producerIssueDone.resolve(); await allowProducer.promise; return actual;
    }
    if (context.agent.id === quality.verifierAgentId) {
      qaCalls++;
      if (qaCalls === 1) qaHeartbeatId = context.runId;
      const identity = await readAdapterIdentity(context);
      qaAttemptIdentities.push({ call: qaCalls, ...identity });
      diagnostic("qa_actual_entry", { attempt: qaAttemptIdentities[qaAttemptIdentities.length - 1] });
      if (qaCalls !== 1) throw new Error(`unexpected duplicate linked QA actual ${JSON.stringify(identity)}`);
      qaEntered.resolve();
      const [issue] = await db.select().from(issues).where(eq(issues.id, qaIssueId));
      await submitWorkflowVerdict({ db, issue: issue!, actor: actor(quality.verifierAgentId, context.runId),
        data: { verdict: "request_changes", findings: [{ id: "linked-draft", summary: "Draft needs repair", layer: "artifact" }],
          remediations: { items: [{ op: "string_replace", file, find: "flawed", replace: "polished" }] } } });
      try {
        await completeWorkflowIssue({ db, issue: issue!, actor: actor(quality.verifierAgentId, context.runId), data: {} });
        throw new Error("linked QA completion unexpectedly bypassed the active actual drain");
      } catch (error) {
        if (!(error instanceof QaRemediationWorkflowHoldError)) throw error;
        qaHeld.resolve(error);
      }
      return { ...finished, resultJson: { stdout: "QA request changes" } };
    }
    if (context.agent.id === uAgentId) { uEntered.resolve(); return finished; }
    throw new Error(`unexpected linked cancellation adapter ${context.agent.id}`);
  });

  phase("producer_wakeup", "enter");
  const producerWake = await heartbeatService(db).wakeup(quality.authorAgentId, {
    source: "assignment", triggerDetail: "system", reason: "workflow_step_runnable",
    payload: { issueId: producerIssueId, missionId, workflowRunId: runId, workflowStepRunId: producerStep!.id },
    contextSnapshot: { issueId: producerIssueId, missionId, workflowRunId: runId, workflowStepRunId: producerStep!.id },
  });
  expect(producerWake).toBeTruthy(); phase("producer_wakeup", "exit", { wakeupRequestId: producerWake!.wakeupRequestId, heartbeatRunId: producerWake!.id });
  phase("producer_and_qa_entry", "enter");
  await within(producerEntered.promise, "linked producer actual entry");
  await within(producerIssueDone.promise, "linked producer issue completion"); await within(qaEntered.promise, "linked QA actual entry");
  phase("producer_and_qa_entry", "exit", { producerHeartbeatId, qaHeartbeatId, qaCalls });
  phase("qa_held_status", "enter");
  const qaError = await within(qaHeld.promise, "linked QA reservation while producer is started");
  expect(qaError).toBeInstanceOf(QaRemediationWorkflowHoldError);
  expect((qaError as QaRemediationWorkflowHoldError).result).toMatchObject({ outcome: "held", reason: "actual_drain_unproven" });
  phase("qa_held_status", "exit", { reason: (qaError as QaRemediationWorkflowHoldError).result.reason });
  phase("qa_status_poll", "enter");
  await vi.waitFor(async () => {
    const [qaActual] = await peer.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, qaHeartbeatId));
    expect(qaActual?.status).toBe("succeeded");
  }, { timeout: 20_000, interval: 10 });
  phase("qa_status_poll", "exit");
  phase("qa_receipt_poll", "enter");
  await vi.waitFor(async () => {
    const qaDrain = await peer.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, quality.companyId), eq(workflowTransitionEvents.missionId, missionId),
      eq(workflowTransitionEvents.workflowRunId, runId), eq(workflowTransitionEvents.workflowStepRunId, qaStep!.id),
      eq(workflowTransitionEvents.issueId, qaIssueId), eq(workflowTransitionEvents.heartbeatRunId, qaHeartbeatId),
      eq(workflowTransitionEvents.eventType, "heartbeat_actual_drained_v1"),
    ));
    expect(qaDrain).toHaveLength(1);
  }, { timeout: 20_000, interval: 10 });
  phase("qa_receipt_poll", "exit");
  const [prepRow] = await peer.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, quality.companyId), eq(workflowTransitionEvents.workflowRunId, runId),
    eq(workflowTransitionEvents.eventType, QA_REMEDIATION_PREPARATION_EVENT_TYPE),
  ));
  expect(prepRow).toBeTruthy();
  const prep = parseQaRemediationPreparation(prepRow!.payload);
  const [runningActual] = await peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, producerHeartbeatId));
  const frozenIdentity = await freezeHeartbeatActualDrainIdentity(peer, runningActual!, { workflowRunId: runId });
  expect(frozenIdentity).toBeTruthy();
  expect(frozenIdentity).toMatchObject({ companyId: quality.companyId, missionId, workflowRunId: runId,
    workflowStepRunId: producerStep!.id, issueId: producerIssueId, heartbeatRunId: producerWake!.id,
    wakeupRequestId: producerWake!.wakeupRequestId, executionGeneration: runningActual!.workflowExecutionGeneration,
    retryCount: 0, iterationIndex: 0 });
  const [originalWake] = await peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, frozenIdentity!.wakeupRequestId));
  const attemptProof = readWorkflowAttemptProof(originalWake!);
  expect(attemptProof).toMatchObject({ companyId: quality.companyId, agentId: quality.authorAgentId, issueId: producerIssueId,
    missionId, workflowRunId: runId, stepRunId: producerStep!.id, executionGeneration: runningActual!.workflowExecutionGeneration,
    retryCount: 0, iterationIndex: 0, wakeupRequestId: producerWake!.wakeupRequestId, parentHeartbeatRunId: null });
  const frozenActual = { id: runningActual!.id, issueId: runningActual!.issueId, workflowStepRunId: runningActual!.workflowStepRunId,
    workflowExecutionGeneration: runningActual!.workflowExecutionGeneration, retryOfRunId: runningActual!.retryOfRunId,
    executionToken: runningActual!.executionToken, executorOwnerId: runningActual!.executorOwnerId,
    executorOwnerLeaseEpoch: runningActual!.executorOwnerLeaseEpoch, executorOwnerLeaseToken: runningActual!.executorOwnerLeaseToken };
  await peer.update(workflowRuns).set({ status: "completed", completedAt: new Date() }).where(eq(workflowRuns.id, parent.runId));
  const identityRows = async () => ({
    parent: (await peer.select({ id: workflowRuns.id, companyId: workflowRuns.companyId, missionId: workflowRuns.missionId,
      status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, parent.runId)))[0],
    invocation: (await peer.select({ id: workflowStepInvocations.id, companyId: workflowStepInvocations.companyId,
      parentStepRunId: workflowStepInvocations.parentStepRunId, childRunId: workflowStepInvocations.childRunId,
      generation: workflowStepInvocations.generation, state: workflowStepInvocations.state })
      .from(workflowStepInvocations).where(eq(workflowStepInvocations.id, child.invocationId)))[0],
    parentStep: (await peer.select({ id: workflowStepRuns.id, workflowRunId: workflowStepRuns.workflowRunId,
      stepId: workflowStepRuns.stepId }).from(workflowStepRuns).where(eq(workflowStepRuns.id, parent.stepRunId)))[0],
    child: (await peer.select({ id: workflowRuns.id, companyId: workflowRuns.companyId, missionId: workflowRuns.missionId,
      workflowId: workflowRuns.workflowId, status: workflowRuns.status, parentRunId: workflowRuns.parentRunId,
      parentStepRunId: workflowRuns.parentStepRunId, dispatchAuthorityVersion: workflowRuns.dispatchAuthorityVersion,
      childStartToken: workflowRuns.childStartToken, childStartLeaseExpiresAt: workflowRuns.childStartLeaseExpiresAt })
      .from(workflowRuns).where(eq(workflowRuns.id, runId)))[0],
    childSteps: await peer.select({ id: workflowStepRuns.id, workflowRunId: workflowStepRuns.workflowRunId,
      stepId: workflowStepRuns.stepId, issueId: workflowStepRuns.issueId, status: workflowStepRuns.status })
      .from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId)).orderBy(workflowStepRuns.id),
    issues: await peer.select({ id: issues.id, companyId: issues.companyId, missionId: issues.missionId,
      originKind: issues.originKind, originRunId: issues.originRunId, status: issues.status,
      assigneeAgentId: issues.assigneeAgentId }).from(issues).where(eq(issues.originRunId, runId)).orderBy(issues.id),
    runtimes: await peer.select().from(missionAgentRuntimes).where(and(
      eq(missionAgentRuntimes.companyId, quality.companyId), eq(missionAgentRuntimes.missionId, missionId),
    )).orderBy(missionAgentRuntimes.id),
    actual: (await peer.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, issueId: heartbeatRuns.issueId,
      workflowStepRunId: heartbeatRuns.workflowStepRunId, workflowExecutionGeneration: heartbeatRuns.workflowExecutionGeneration,
      retryOfRunId: heartbeatRuns.retryOfRunId, executionToken: heartbeatRuns.executionToken,
      executorOwnerId: heartbeatRuns.executorOwnerId, executorOwnerLeaseEpoch: heartbeatRuns.executorOwnerLeaseEpoch,
      executorOwnerLeaseToken: heartbeatRuns.executorOwnerLeaseToken, resultJson: heartbeatRuns.resultJson,
      sessionIdAfter: heartbeatRuns.sessionIdAfter, usageJson: heartbeatRuns.usageJson })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, producerHeartbeatId)))[0],
    attemptProof: readWorkflowAttemptProof((await peer.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, producerWake!.wakeupRequestId)))[0]!),
    events: await peer.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowRunId, runId))
      .orderBy(workflowTransitionEvents.id),
    wakes: await peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.workflowRunId, runId))
      .orderBy(agentWakeupRequests.id),
    authorities: await peer.select().from(workflowRecoveryAuthorities).where(eq(workflowRecoveryAuthorities.replacementRunId, runId))
      .orderBy(workflowRecoveryAuthorities.id),
    bytes: await readFile(file, "utf8"),
  });
  const beforeHold = await identityRows();
  phase("started_actual_public_hold", "enter");
  const startedActualCancel = cancelWorkflowRunWithCleanup(db, runId, quality.companyId, { childParentFence }).then(value => {
    cancelOutcome = { kind: "resolved", value, stage: "started_actual_hold" };
    diagnostic("public_cancel_settled", cancelOutcome); return value;
  }, error => {
    cancelOutcome = { kind: "rejected", name: error?.name, reason: error?.reason, message: error?.message, stage: "started_actual_hold" };
    diagnostic("public_cancel_settled", cancelOutcome); throw error;
  });
  await expect(startedActualCancel)
    .rejects.toMatchObject({ name: "QaRemediationAdmissionHold", reason: "cancel_actual_drain_unproven" });
  phase("started_actual_public_hold", "exit", { outcome: cancelOutcome });
  expect(await identityRows()).toEqual(beforeHold);
  expect(beforeHold.parent?.status).toBe("completed");
  expect(beforeHold.child?.status).toBe("running");
  expect(beforeHold.actual?.status).toBe("running");
  expect(beforeHold.actual?.resultJson).not.toEqual(actual.resultJson);
  expect(beforeHold.bytes).toBe("flawed draft\n");

  const linkedProducts = await peer.select().from(issueWorkProducts).where(and(
    eq(issueWorkProducts.companyId, quality.companyId), eq(issueWorkProducts.issueId, producerIssueId), eq(issueWorkProducts.status, "active"),
  ));
  const matchingProducts = linkedProducts.filter(product => resolveWorkProductLocalFilePath(product) === file);
  expect(matchingProducts).toHaveLength(1);
  const linkedProduct = matchingProducts[0]!;
  const linkedProductMetadata = linkedProduct!.metadata;
  expect(linkedProductMetadata?.workflowProducer).toBeTruthy();
  await peer.update(issueWorkProducts).set({ metadata: { ...linkedProductMetadata, workflowProducer: null } })
    .where(eq(issueWorkProducts.id, linkedProduct!.id));
  phase("producer_natural_release_and_drain", "enter");
  allowProducer.resolve(); releaseProducer = null;
  await waitForHeartbeatExecutionsToDrain(db, 60_000);
  phase("producer_natural_release_and_drain", "exit", { producerHeartbeatId });
  const [settledActual] = await peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, producerHeartbeatId));
  expect({ id: settledActual!.id, issueId: settledActual!.issueId, workflowStepRunId: settledActual!.workflowStepRunId,
    workflowExecutionGeneration: settledActual!.workflowExecutionGeneration, retryOfRunId: settledActual!.retryOfRunId,
    executionToken: settledActual!.executionToken, executorOwnerId: settledActual!.executorOwnerId,
    executorOwnerLeaseEpoch: settledActual!.executorOwnerLeaseEpoch, executorOwnerLeaseToken: settledActual!.executorOwnerLeaseToken }).toEqual(frozenActual);
  expect(settledActual!.resultJson).toEqual(actual.resultJson);
  expect(settledActual!.sessionIdAfter).toBe("c5-linked-actual-session");
  expect(settledActual!.usageJson).toMatchObject({ inputTokens: 9, outputTokens: 4, provider: "actual-provider", model: "actual-model", costUsd: 0.25 });
  const producerReceipts = await peer.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.workflowRunId, runId), eq(workflowTransitionEvents.workflowStepRunId, producerStep!.id),
    eq(workflowTransitionEvents.eventType, "heartbeat_actual_drained_v1"),
  ));
  expect(producerReceipts).toHaveLength(1);
  const [drainedStep] = await peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, producerStep!.id));
  expect((await readQaRemediationActualDrain(peer, prep, drainedStep!)).kind).toBe("held");
  await peer.update(issueWorkProducts).set({ metadata: linkedProductMetadata }).where(eq(issueWorkProducts.id, linkedProduct!.id));
  expect(await unresolvedQaRemediationAdmissionPending(peer, { pending: [{ eventId: prepRow!.id, preparation: prep }] }))
    .toEqual([prepRow!.id]);
  expect(prep.files.map(item => item.path)).toEqual([file]);
  expect((await readQaRemediationActualDrain(peer, prep, drainedStep!)).kind).toBe("proven");

  await db.insert(agents).values({ id: uAgentId, companyId: quality.otherCompanyId, name: "Independent linked U", status: "active",
    adapterType: "codex_local", adapterConfig: { cwd: root }, runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 1 } } });
  const ownerRuntime = createQaFileOwnerRuntime({ qaFileOwnerLockRoot: lockRoot, qaFileOwnerPython: PYTHON! });
  const blocker = await ownerRuntime.begin([file]);
  const waiting = deferred<void>(), realBegin = QaRemediationFileOwner.begin.bind(QaRemediationFileOwner);
  let cancelOwner: Awaited<ReturnType<typeof realBegin>> | undefined, blockerReleased = false;
  let ownerExitObserved = false;
  let blockerClosePromise: ReturnType<typeof blocker.close> | null = null;
  const closeBlocker = () => blockerClosePromise ??= blocker.close();
  const spy = vi.spyOn(QaRemediationFileOwner, "begin").mockImplementation(async input => {
    if (!input.targets.includes(file)) return realBegin(input);
    expect(input.helperPath).toBe(NATIVE_HELPER);
    return realBegin({ ...input, onEvent: event => {
      lastNativeEvent = { observedAt: new Date().toISOString(), ...event };
      diagnostic("native_event", { nativeEvent: lastNativeEvent });
      if (event.type === "lock_wait" && event.target === file) waiting.resolve();
      input.onEvent?.(event);
    } }).then(owner => { cancelOwner = owner; return owner; });
  });
  const cancellation = cancelWorkflowRunWithCleanup(db, runId, quality.companyId, { childParentFence })
    .then(value => {
      cancelOutcome = { kind: "resolved", value, stage: "positive_supplied_cancel" };
      diagnostic("public_cancel_settled", cancelOutcome); return { value };
    }, error => {
      cancelOutcome = { kind: "rejected", name: error?.name, reason: error?.reason, message: error?.message,
        stage: "positive_supplied_cancel" };
      diagnostic("public_cancel_settled", cancelOutcome); return { error };
    });
  let nativeCleanupPromise: Promise<void> | null = null;
  const settleNative = () => nativeCleanupPromise ??= (async () => {
    if (!blockerReleased) {
      phase("native_blocker_close", "enter", { reason: "positive_cleanup" });
      const closeResult = await closeBlocker();
      blockerReleased = true;
      phase("native_blocker_close", "exit", { closeResult });
      if (closeResult.code !== 0 || closeResult.signal !== null) throw new Error("linked native blocker did not exit positively");
    }
    spy.mockRestore();
    const outcome = await cancellation;
    if ("error" in outcome) throw outcome.error;
    if (cancelOwner && !ownerExitObserved) {
      phase("native_owner_exit", "enter");
      const ownerExit = await cancelOwner.awaitExit();
      ownerExitObserved = true;
      phase("native_owner_exit", "exit", { ownerExit });
      if (ownerExit.code !== 0 || ownerExit.signal !== null) throw new Error("linked cancellation native owner did not exit positively");
    }
  })();
  linkedNativeCleanup = settleNative;
  try {
    phase("native_lock_wait", "enter", { target: file });
    const waitOrSettlement = await Promise.race([
      waiting.promise.then(() => ({ kind: "lock_wait" as const })),
      cancellation.then(outcome => ({ kind: "cancel_settled" as const, outcome })),
    ]);
    if (waitOrSettlement.kind === "cancel_settled") {
      phase("native_lock_wait", "exit", { outcome: "cancel settled before lock_wait", cancelOutcome });
      expect(waitOrSettlement.kind, `cancel settled before native lock_wait: ${JSON.stringify(cancelOutcome)}`).toBe("lock_wait");
    }
    phase("native_lock_wait", "exit", { nativeEvent: lastNativeEvent });
    phase("peer_pisc_locks", "enter");
    await peer.transaction(async tx => {
      expect(await tx.execute(sql`select id from missions where id = ${missionId} and company_id = ${quality.companyId} for update nowait`)).toHaveLength(1);
      expect(await tx.execute(sql`select id from workflow_runs where id = ${parent.runId} and company_id = ${quality.companyId} for update nowait`)).toHaveLength(1);
      expect(await tx.execute(sql`select id from workflow_step_invocations where id = ${child.invocationId} and company_id = ${quality.companyId} for update nowait`)).toHaveLength(1);
      expect(await tx.execute(sql`select id from workflow_step_runs where id = ${parent.stepRunId} and workflow_run_id = ${parent.runId} for update nowait`)).toHaveLength(1);
      expect(await tx.execute(sql`select id from workflow_runs where id = ${runId} and company_id = ${quality.companyId} for update nowait`)).toHaveLength(1);
    });
    phase("peer_pisc_locks", "exit");
    phase("unrelated_u_progress", "enter");
    const unrelated = await heartbeatService(db).wakeup(uAgentId, { source: "on_demand", triggerDetail: "manual", reason: "linked-cancel-U" });
    expect(unrelated).toBeTruthy(); await within(uEntered.promise, "independent U actual entry");
    await waitForHeartbeatExecutionsToDrain(db, 60_000);
    const [unrelatedActual] = await peer.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, unrelated!.id));
    expect(unrelatedActual?.status).toBe("succeeded");
    phase("unrelated_u_progress", "exit", { heartbeatRunId: unrelated!.id, status: unrelatedActual?.status });

    phase("native_blocker_close", "enter", { reason: "release_after_independent_progress" });
    const closeResult = await closeBlocker();
    expect(closeResult).toEqual({ code: 0, signal: null });
    blockerReleased = true;
    phase("native_blocker_close", "exit", { closeResult });
    phase("public_cancel_settlement", "enter");
    const outcome = await within(cancellation, "supplied linked cancellation and awaited cleanup");
    expect("value" in outcome && outcome.value).toBe(true);
    phase("public_cancel_settlement", "exit", { outcome: cancelOutcome });
    expect(cancelOwner).toBeTruthy();
    phase("native_owner_exit", "enter");
    const ownerExit = await within(cancelOwner!.awaitExit(), "positive native owner exit");
    ownerExitObserved = true;
    expect(ownerExit).toEqual({ code: 0, signal: null });
    phase("native_owner_exit", "exit", { ownerExit });
  } finally {
    await settleNative();
    linkedNativeCleanup = null;
  }
  expect((await peer.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, runId)))[0]?.status).toBe("cancelled");
  expect(await cancelWorkflowRunWithCleanup(db, runId, quality.companyId, { childParentFence })).toBe(false);
  const countSnapshot = async () => {
    const events = await peer.select({ eventType: workflowTransitionEvents.eventType }).from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.workflowRunId, runId));
    return {
      preparations: events.filter(event => event.eventType === QA_REMEDIATION_PREPARATION_EVENT_TYPE).length,
      qaWakes: (await peer.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, quality.companyId), eq(agentWakeupRequests.workflowRunId, runId),
        eq(agentWakeupRequests.workflowStepRunId, qaStep!.id), eq(agentWakeupRequests.issueId, qaIssueId),
      ))).length,
      recoveryEvents: events.filter(event => event.eventType.includes("recovery")).length,
      recoveryAuthorities: (await peer.select({ id: workflowRecoveryAuthorities.id }).from(workflowRecoveryAuthorities)
        .where(eq(workflowRecoveryAuthorities.replacementRunId, runId))).length,
    };
  };
  const settledCounts = await countSnapshot();
  const prepCount = (await peer.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.workflowRunId, runId), eq(workflowTransitionEvents.eventType, QA_REMEDIATION_PREPARATION_EVENT_TYPE),
  ))).length;
  expect(settledCounts.preparations).toBe(prepCount);
  expect(settledCounts).toMatchObject({ preparations: 1, qaWakes: 1, recoveryEvents: 0, recoveryAuthorities: 0 });
  expect((await peer.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, quality.companyId), eq(heartbeatRuns.issueId, producerIssueId),
    eq(heartbeatRuns.workflowStepRunId, producerStep!.id),
  )))).toHaveLength(1);
  const [finalActual] = await peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, producerHeartbeatId));
  expect(finalActual!.resultJson).toEqual(actual.resultJson);
  expect(finalActual!.sessionIdAfter).toBe("c5-linked-actual-session");
  expect(finalActual!.usageJson).toMatchObject({ inputTokens: 9, outputTokens: 4, provider: "actual-provider", model: "actual-model", costUsd: 0.25 });
  expect({ id: finalActual!.id, issueId: finalActual!.issueId, workflowStepRunId: finalActual!.workflowStepRunId,
    workflowExecutionGeneration: finalActual!.workflowExecutionGeneration, retryOfRunId: finalActual!.retryOfRunId,
    executionToken: finalActual!.executionToken, executorOwnerId: finalActual!.executorOwnerId,
    executorOwnerLeaseEpoch: finalActual!.executorOwnerLeaseEpoch, executorOwnerLeaseToken: finalActual!.executorOwnerLeaseToken }).toEqual(frozenActual);
  expect(readWorkflowAttemptProof((await peer.select().from(agentWakeupRequests)
    .where(eq(agentWakeupRequests.id, producerWake!.wakeupRequestId)))[0]!)).toEqual(attemptProof);
  expect((await peer.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.workflowRunId, runId), eq(workflowTransitionEvents.workflowStepRunId, producerStep!.id),
    eq(workflowTransitionEvents.eventType, "heartbeat_actual_drained_v1"),
  )))).toHaveLength(1);
  expect(await readFile(file, "utf8")).toBe("flawed draft\n");
});

it("admits direct linked-child cancellation with a live parent after actual drain", async () => {
  const missionId = randomUUID(), childWorkflowId = randomUUID(), producerIssueId = randomUUID(), qaIssueId = randomUUID();
  const file = path.join(root, "missions", missionId, "runs", "direct-linked-child", "steps", "produce", "report.md");
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, "direct draft\n", "utf8");
  await db.insert(missions).values({ id: missionId, companyId: quality.companyId, ownerAgentId: quality.authorAgentId,
    title: "C5 direct linked-child cancel proof", status: "active" });
  await db.insert(workflowDefinitions).values({ id: childWorkflowId, companyId: quality.companyId, missionId,
    name: "C5 direct linked child", stepsJson: [{ id: "produce", name: "Produce", agentId: quality.authorAgentId, dependencies: [],
      conditionalDependencies: [{ stepId: "qa-check", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 }] },
    { id: "qa-check", name: "QA", agentId: quality.verifierAgentId, type: "qa", dependencies: ["produce"] }] });
  const parentWorkflowId = await insertDefinition({ companyId: quality.companyId, name: "C5 direct linked parent",
    steps: [childStep(childWorkflowId)] });
  await db.update(workflowDefinitions).set({ missionId }).where(eq(workflowDefinitions.id, parentWorkflowId));
  const parent = await insertRunWithWorkflowStepRun({ companyId: quality.companyId, workflowId: parentWorkflowId });
  await db.update(workflowRuns).set({ missionId }).where(eq(workflowRuns.id, parent.runId));
  const child = await insertMaterializedChildRun(db, { companyId: quality.companyId, parentRunId: parent.runId,
    parentStepRunId: parent.stepRunId, childWorkflowId, stepIds: ["produce", "qa-check"], childStatus: "running" });
  const runId = child.childRunId;
  await db.update(workflowRuns).set({ missionId, dispatchAuthorityVersion: 1 }).where(eq(workflowRuns.id, runId));
  const [producerStep] = await db.select().from(workflowStepRuns).where(and(
    eq(workflowStepRuns.workflowRunId, runId), eq(workflowStepRuns.stepId, "produce"),
  ));
  const [qaStep] = await db.select().from(workflowStepRuns).where(and(
    eq(workflowStepRuns.workflowRunId, runId), eq(workflowStepRuns.stepId, "qa-check"),
  ));
  expect(producerStep).toBeTruthy(); expect(qaStep).toBeTruthy();
  await db.insert(issues).values([
    { id: producerIssueId, companyId: quality.companyId, missionId, title: "Produce direct linked report", status: "todo",
      assigneeAgentId: quality.authorAgentId, originKind: "workflow_execution", originRunId: runId },
    { id: qaIssueId, companyId: quality.companyId, missionId, title: "[QA] Validate direct linked report", status: "todo",
      assigneeAgentId: quality.verifierAgentId, originKind: "workflow_execution", originRunId: runId },
  ]);
  await db.update(workflowStepRuns).set({ issueId: producerIssueId }).where(eq(workflowStepRuns.id, producerStep!.id));
  await db.update(workflowStepRuns).set({ issueId: qaIssueId }).where(eq(workflowStepRuns.id, qaStep!.id));

  const producerEntered = deferred<void>(), producerIssueDone = deferred<void>(), allowProducer = deferred<void>();
  const qaHeld = deferred<unknown>(), qaEntered = deferred<void>(), uEntered = deferred<void>();
  const uAgentId = randomUUID();
  let producerHeartbeatId = "", qaHeartbeatId = "", qaCalls = 0;
  releaseProducer = () => allowProducer.resolve();
  const actual: AdapterExecutionResult = { ...finished, usage: { inputTokens: 9, outputTokens: 4 },
    provider: "actual-provider", model: "actual-model", costUsd: 0.25,
    resultJson: { stdout: "preserved direct actual result", stderr: "" }, sessionId: "c5-direct-actual-session" };
  const actor = (agentId: string, runId: string) => ({ actorType: "agent" as const, actorId: agentId, agentId, runId });
  adapter.mockImplementation(async (context: AdapterExecutionContext) => {
    if (context.agent.id === quality.authorAgentId) {
      producerHeartbeatId = context.runId; producerEntered.resolve();
      await context.onSessionUpdate?.({ sessionId: "c5-direct-actual-session", sessionDisplayId: "c5-direct-actual-session" });
      const [issue] = await db.select().from(issues).where(eq(issues.id, producerIssueId));
      await registerWorkflowArtifact({ db, issue: issue!, actor: actor(quality.authorAgentId, context.runId),
        data: { path: file, type: "document", isPrimary: true } });
      if (!(await registeredProducer(db, quality.companyId, producerIssueId, context.runId))) {
        throw new Error("direct producer artifact lacks its actual-bound provenance");
      }
      await completeWorkflowIssue({ db, issue: issue!, actor: actor(quality.authorAgentId, context.runId), data: {} });
      producerIssueDone.resolve(); await allowProducer.promise; return actual;
    }
    if (context.agent.id === quality.verifierAgentId) {
      qaCalls++; qaHeartbeatId = context.runId;
      if (qaCalls !== 1) throw new Error("unexpected duplicate direct QA actual");
      qaEntered.resolve();
      const [issue] = await db.select().from(issues).where(eq(issues.id, qaIssueId));
      await submitWorkflowVerdict({ db, issue: issue!, actor: actor(quality.verifierAgentId, context.runId),
        data: { verdict: "request_changes", findings: [{ id: "direct-draft", summary: "Draft needs repair", layer: "artifact" }],
          remediations: { items: [{ op: "string_replace", file, find: "direct draft", replace: "polished" }] } } });
      try {
        await completeWorkflowIssue({ db, issue: issue!, actor: actor(quality.verifierAgentId, context.runId), data: {} });
        throw new Error("direct QA completion unexpectedly bypassed the active actual drain");
      } catch (error) {
        if (!(error instanceof QaRemediationWorkflowHoldError)) throw error;
        qaHeld.resolve(error);
      }
      return { ...finished, resultJson: { stdout: "QA request changes" } };
    }
    if (context.agent.id === uAgentId) { uEntered.resolve(); return finished; }
    throw new Error(`unexpected direct cancellation adapter ${context.agent.id}`);
  });

  const producerWake = await heartbeatService(db).wakeup(quality.authorAgentId, {
    source: "assignment", triggerDetail: "system", reason: "workflow_step_runnable",
    payload: { issueId: producerIssueId, missionId, workflowRunId: runId, workflowStepRunId: producerStep!.id },
    contextSnapshot: { issueId: producerIssueId, missionId, workflowRunId: runId, workflowStepRunId: producerStep!.id },
  });
  expect(producerWake).toBeTruthy();
  await within(producerEntered.promise, "direct producer actual entry");
  await within(producerIssueDone.promise, "direct producer issue completion");
  await within(qaEntered.promise, "direct QA actual entry");
  const qaError = await within(qaHeld.promise, "direct QA reservation while producer is started");
  expect(qaError).toBeInstanceOf(QaRemediationWorkflowHoldError);
  expect((qaError as QaRemediationWorkflowHoldError).result).toMatchObject({ outcome: "held", reason: "actual_drain_unproven" });
  await vi.waitFor(async () => {
    const [qaActual] = await peer.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, qaHeartbeatId));
    expect(qaActual?.status).toBe("succeeded");
  }, { timeout: 20_000, interval: 10 });
  await vi.waitFor(async () => {
    const receipt = await peer.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, quality.companyId), eq(workflowTransitionEvents.missionId, missionId),
      eq(workflowTransitionEvents.workflowRunId, runId), eq(workflowTransitionEvents.workflowStepRunId, qaStep!.id),
      eq(workflowTransitionEvents.issueId, qaIssueId), eq(workflowTransitionEvents.heartbeatRunId, qaHeartbeatId),
      eq(workflowTransitionEvents.eventType, "heartbeat_actual_drained_v1"),
    ));
    expect(receipt).toHaveLength(1);
  }, { timeout: 20_000, interval: 10 });
  const [prepRow] = await peer.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, quality.companyId), eq(workflowTransitionEvents.workflowRunId, runId),
    eq(workflowTransitionEvents.eventType, QA_REMEDIATION_PREPARATION_EVENT_TYPE),
  ));
  expect(prepRow).toBeTruthy();
  const prep = parseQaRemediationPreparation(prepRow!.payload);
  const [runningActual] = await peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, producerHeartbeatId));
  const frozenIdentity = await freezeHeartbeatActualDrainIdentity(peer, runningActual!, { workflowRunId: runId });
  expect(frozenIdentity).toBeTruthy();
  const [originalWake] = await peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, producerWake!.wakeupRequestId));
  const attemptProof = readWorkflowAttemptProof(originalWake!);
  const frozenActual = { id: runningActual!.id, issueId: runningActual!.issueId,
    workflowStepRunId: runningActual!.workflowStepRunId, workflowExecutionGeneration: runningActual!.workflowExecutionGeneration,
    retryOfRunId: runningActual!.retryOfRunId, executionToken: runningActual!.executionToken,
    executorOwnerId: runningActual!.executorOwnerId, executorOwnerLeaseEpoch: runningActual!.executorOwnerLeaseEpoch,
    executorOwnerLeaseToken: runningActual!.executorOwnerLeaseToken };
  const identityRows = async () => ({
    parent: (await peer.select({ id: workflowRuns.id, companyId: workflowRuns.companyId, status: workflowRuns.status })
      .from(workflowRuns).where(eq(workflowRuns.id, parent.runId)))[0],
    invocation: (await peer.select({ id: workflowStepInvocations.id, parentStepRunId: workflowStepInvocations.parentStepRunId,
      childRunId: workflowStepInvocations.childRunId, generation: workflowStepInvocations.generation, state: workflowStepInvocations.state })
      .from(workflowStepInvocations).where(eq(workflowStepInvocations.id, child.invocationId)))[0],
    parentStep: (await peer.select({ id: workflowStepRuns.id, workflowRunId: workflowStepRuns.workflowRunId,
      stepId: workflowStepRuns.stepId, status: workflowStepRuns.status }).from(workflowStepRuns).where(eq(workflowStepRuns.id, parent.stepRunId)))[0],
    child: (await peer.select({ id: workflowRuns.id, companyId: workflowRuns.companyId, status: workflowRuns.status,
      parentRunId: workflowRuns.parentRunId, parentStepRunId: workflowRuns.parentStepRunId,
      childStartToken: workflowRuns.childStartToken, childStartLeaseExpiresAt: workflowRuns.childStartLeaseExpiresAt })
      .from(workflowRuns).where(eq(workflowRuns.id, runId)))[0],
    childSteps: await peer.select({ id: workflowStepRuns.id, stepId: workflowStepRuns.stepId, issueId: workflowStepRuns.issueId,
      status: workflowStepRuns.status }).from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId)).orderBy(workflowStepRuns.id),
    issues: await peer.select({ id: issues.id, status: issues.status, executionRunId: issues.executionRunId,
      executionLockedAt: issues.executionLockedAt }).from(issues).where(eq(issues.originRunId, runId)).orderBy(issues.id),
    runtimes: await peer.select().from(missionAgentRuntimes).where(and(
      eq(missionAgentRuntimes.companyId, quality.companyId), eq(missionAgentRuntimes.missionId, missionId),
    )).orderBy(missionAgentRuntimes.id),
    actual: (await peer.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, issueId: heartbeatRuns.issueId,
      workflowStepRunId: heartbeatRuns.workflowStepRunId, workflowExecutionGeneration: heartbeatRuns.workflowExecutionGeneration,
      retryOfRunId: heartbeatRuns.retryOfRunId, executionToken: heartbeatRuns.executionToken, executorOwnerId: heartbeatRuns.executorOwnerId,
      executorOwnerLeaseEpoch: heartbeatRuns.executorOwnerLeaseEpoch, executorOwnerLeaseToken: heartbeatRuns.executorOwnerLeaseToken,
      resultJson: heartbeatRuns.resultJson, sessionIdAfter: heartbeatRuns.sessionIdAfter, usageJson: heartbeatRuns.usageJson })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, producerHeartbeatId)))[0],
    attemptProof: readWorkflowAttemptProof((await peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, producerWake!.wakeupRequestId)))[0]!),
    preparations: await peer.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.workflowRunId, runId), eq(workflowTransitionEvents.eventType, QA_REMEDIATION_PREPARATION_EVENT_TYPE),
    )),
    wakes: await peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.workflowRunId, runId)).orderBy(agentWakeupRequests.id),
    authorities: await peer.select().from(workflowRecoveryAuthorities).where(eq(workflowRecoveryAuthorities.replacementRunId, runId))
      .orderBy(workflowRecoveryAuthorities.id),
    products: await peer.select().from(issueWorkProducts).where(and(
      eq(issueWorkProducts.companyId, quality.companyId), eq(issueWorkProducts.issueId, producerIssueId),
      eq(issueWorkProducts.status, "active"),
    )).orderBy(issueWorkProducts.id),
    bytes: await readFile(file, "utf8"),
  });
  const beforeHold = await identityRows();
  expect(beforeHold.parent?.status).toBe("running");
  expect(beforeHold.child?.status).toBe("running");
  expect(beforeHold.actual?.status).toBe("running");
  expect(beforeHold.actual?.resultJson).not.toEqual(actual.resultJson);
  const startedDirectCancel = cancelWorkflowRunWithCleanup(db, runId, quality.companyId);
  await expect(startedDirectCancel)
    .rejects.toMatchObject({ name: "QaRemediationAdmissionHold", reason: "cancel_actual_drain_unproven" });
  expect(await identityRows()).toEqual(beforeHold);

  const linkedProducts = beforeHold.products.filter(product => resolveWorkProductLocalFilePath(product) === file);
  expect(linkedProducts).toHaveLength(1);
  const linkedProduct = linkedProducts[0]!;
  const linkedProductMetadata = linkedProduct.metadata;
  expect(linkedProductMetadata?.workflowProducer).toBeTruthy();
  await peer.update(issueWorkProducts).set({ metadata: { ...linkedProductMetadata, workflowProducer: null } })
    .where(eq(issueWorkProducts.id, linkedProduct.id));
  allowProducer.resolve(); releaseProducer = null;
  await waitForHeartbeatExecutionsToDrain(db, 60_000);
  const [settledActual] = await peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, producerHeartbeatId));
  expect({ id: settledActual!.id, issueId: settledActual!.issueId, workflowStepRunId: settledActual!.workflowStepRunId,
    workflowExecutionGeneration: settledActual!.workflowExecutionGeneration, retryOfRunId: settledActual!.retryOfRunId,
    executionToken: settledActual!.executionToken, executorOwnerId: settledActual!.executorOwnerId,
    executorOwnerLeaseEpoch: settledActual!.executorOwnerLeaseEpoch, executorOwnerLeaseToken: settledActual!.executorOwnerLeaseToken }).toEqual(frozenActual);
  expect(settledActual!.resultJson).toEqual(actual.resultJson);
  expect(settledActual!.sessionIdAfter).toBe("c5-direct-actual-session");
  expect(settledActual!.usageJson).toMatchObject({ inputTokens: 9, outputTokens: 4, provider: "actual-provider", model: "actual-model", costUsd: 0.25 });
  const producerReceipts = await peer.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, quality.companyId), eq(workflowTransitionEvents.missionId, missionId),
    eq(workflowTransitionEvents.workflowRunId, runId), eq(workflowTransitionEvents.workflowStepRunId, producerStep!.id),
    eq(workflowTransitionEvents.issueId, producerIssueId), eq(workflowTransitionEvents.heartbeatRunId, producerHeartbeatId),
    eq(workflowTransitionEvents.eventType, "heartbeat_actual_drained_v1"),
  ));
  expect(producerReceipts).toHaveLength(1);
  const [drainedStep] = await peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, producerStep!.id));
  expect((await readQaRemediationActualDrain(peer, prep, drainedStep!)).kind).toBe("held");
  await peer.update(issueWorkProducts).set({ metadata: linkedProductMetadata }).where(eq(issueWorkProducts.id, linkedProduct.id));
  expect(prep.files.map(item => item.path)).toEqual([file]);
  expect(await unresolvedQaRemediationAdmissionPending(peer, { pending: [{ eventId: prepRow!.id, preparation: prep }] }))
    .toEqual([prepRow!.id]);
  expect((await readQaRemediationActualDrain(peer, prep, drainedStep!)).kind).toBe("proven");

  await db.insert(agents).values({ id: uAgentId, companyId: quality.otherCompanyId, name: "Independent direct U", status: "active",
    adapterType: "codex_local", adapterConfig: { cwd: root }, runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 1 } } });

  const ownerRuntime = createQaFileOwnerRuntime({ qaFileOwnerLockRoot: lockRoot, qaFileOwnerPython: PYTHON! });
  const blocker = await ownerRuntime.begin([file]);
  const waiting = deferred<void>(), realBegin = QaRemediationFileOwner.begin.bind(QaRemediationFileOwner);
  const ownerExit = deferred<{ code: number | null; signal: string | null } | null>();
  let cancelOwner: Awaited<ReturnType<typeof realBegin>> | undefined;
  let ownerExitObserved = false, blockerReleased = false;
  let cleanupPromise: Promise<void> | null = null;
  let releaseBlockerPromise: ReturnType<typeof blocker.close> | null = null;
  const closeBlocker = () => releaseBlockerPromise ??= blocker.close();
  const spy = vi.spyOn(QaRemediationFileOwner, "begin").mockImplementation(async input => {
    if (!input.targets.includes(file)) return realBegin(input);
    expect(input.helperPath).toBe(NATIVE_HELPER);
    const ownedOwner = await realBegin({ ...input, onEvent: event => {
      if (event.type === "lock_wait" && event.target === file) waiting.resolve();
      input.onEvent?.(event);
    } });
    cancelOwner = ownedOwner;
    void ownedOwner.awaitExit().then(exit => { ownerExitObserved = true; ownerExit.resolve(exit); });
    return ownedOwner;
  });
  const cancellation = cancelWorkflowRunWithCleanup(db, runId, quality.companyId).then(
    value => ({ value }), error => ({ error }),
  );
  const settleNative = () => cleanupPromise ??= (async () => {
    if (!blockerReleased) {
      const closeResult = await closeBlocker(); blockerReleased = true;
      if (closeResult.code !== 0 || closeResult.signal !== null) throw new Error("direct native blocker did not exit positively");
    }
    spy.mockRestore();
    await cancellation;
    if (cancelOwner) await cancelOwner.awaitExit();
  })();
  linkedNativeCleanup = settleNative;
  try {
    const waitOrSettlement = await Promise.race([
      waiting.promise.then(() => "lock_wait" as const),
      cancellation.then(() => "cancel_settled" as const),
    ]);
    expect(waitOrSettlement, "direct cancellation must reach the exact native target wait").toBe("lock_wait");
    expect((await peer.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, parent.runId)))[0]?.status)
      .toBe("running");
    await peer.transaction(async tx => {
      expect(await tx.execute(sql`select id from missions where id = ${missionId} and company_id = ${quality.companyId} for update nowait`)).toHaveLength(1);
      expect(await tx.execute(sql`select id from workflow_runs where id = ${parent.runId} and company_id = ${quality.companyId} for update nowait`)).toHaveLength(1);
      expect(await tx.execute(sql`select id from workflow_step_invocations where id = ${child.invocationId} and company_id = ${quality.companyId} for update nowait`)).toHaveLength(1);
      expect(await tx.execute(sql`select id from workflow_step_runs where id = ${parent.stepRunId} and workflow_run_id = ${parent.runId} for update nowait`)).toHaveLength(1);
      expect(await tx.execute(sql`select id from workflow_runs where id = ${runId} and company_id = ${quality.companyId} for update nowait`)).toHaveLength(1);
    });
    const unrelated = await heartbeatService(db).wakeup(uAgentId, { source: "on_demand", triggerDetail: "manual", reason: "direct-linked-cancel-U" });
    expect(unrelated).toBeTruthy(); await within(uEntered.promise, "direct unrelated U actual entry");
    await waitForHeartbeatExecutionsToDrain(db, 60_000);
    expect((await peer.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, unrelated!.id)))[0]?.status)
      .toBe("succeeded");

    expect(await closeBlocker()).toEqual({ code: 0, signal: null }); blockerReleased = true;
    expect(await within(ownerExit.promise, "direct owner exits before cancellation returns to cleanup")).toEqual({ code: 0, signal: null });
    expect(ownerExitObserved).toBe(true);
    const outcome = await within(cancellation, "direct cancellation and downstream cleanup");
    expect("value" in outcome && outcome.value).toBe(true);
  } finally {
    await settleNative();
    linkedNativeCleanup = null;
  }

  expect((await peer.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, runId)))[0]?.status).toBe("cancelled");
  expect(await cancelWorkflowRunWithCleanup(db, runId, quality.companyId)).toBe(false);
  const events = await peer.select({ eventType: workflowTransitionEvents.eventType }).from(workflowTransitionEvents)
    .where(eq(workflowTransitionEvents.workflowRunId, runId));
  const qaWakes = await peer.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, quality.companyId), eq(agentWakeupRequests.workflowRunId, runId),
    eq(agentWakeupRequests.workflowStepRunId, qaStep!.id), eq(agentWakeupRequests.issueId, qaIssueId),
  ));
  const authorities = await peer.select({ id: workflowRecoveryAuthorities.id }).from(workflowRecoveryAuthorities)
    .where(eq(workflowRecoveryAuthorities.replacementRunId, runId));
  expect(events.filter(event => event.eventType === QA_REMEDIATION_PREPARATION_EVENT_TYPE)).toHaveLength(1);
  expect(qaWakes).toHaveLength(1);
  expect(events.filter(event => event.eventType.includes("recovery"))).toHaveLength(0);
  expect(authorities).toHaveLength(0);
  expect(await peer.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, quality.companyId), eq(heartbeatRuns.issueId, producerIssueId),
    eq(heartbeatRuns.workflowStepRunId, producerStep!.id),
  ))).toHaveLength(1);
  const [finalActual] = await peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, producerHeartbeatId));
  expect(finalActual!.resultJson).toEqual(actual.resultJson);
  expect(finalActual!.sessionIdAfter).toBe("c5-direct-actual-session");
  expect(finalActual!.usageJson).toMatchObject({ inputTokens: 9, outputTokens: 4, provider: "actual-provider", model: "actual-model", costUsd: 0.25 });
  expect({ id: finalActual!.id, issueId: finalActual!.issueId, workflowStepRunId: finalActual!.workflowStepRunId,
    workflowExecutionGeneration: finalActual!.workflowExecutionGeneration, retryOfRunId: finalActual!.retryOfRunId,
    executionToken: finalActual!.executionToken, executorOwnerId: finalActual!.executorOwnerId,
    executorOwnerLeaseEpoch: finalActual!.executorOwnerLeaseEpoch, executorOwnerLeaseToken: finalActual!.executorOwnerLeaseToken }).toEqual(frozenActual);
  expect(readWorkflowAttemptProof((await peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, producerWake!.wakeupRequestId)))[0]!))
    .toEqual(attemptProof);
  expect(await peer.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, quality.companyId), eq(workflowTransitionEvents.workflowRunId, runId),
    eq(workflowTransitionEvents.workflowStepRunId, producerStep!.id), eq(workflowTransitionEvents.issueId, producerIssueId),
    eq(workflowTransitionEvents.heartbeatRunId, producerHeartbeatId), eq(workflowTransitionEvents.eventType, "heartbeat_actual_drained_v1"),
  ))).toHaveLength(1);
  expect(await readFile(file, "utf8")).toBe("direct draft\n");
});
