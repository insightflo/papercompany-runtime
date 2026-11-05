import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { and, desc, eq } from "drizzle-orm";
import { agents, companies, heartbeatRuns, issues, missions, toolDefinitions, workflowStepRuns } from "@paperclipai/db";
import { secretService } from "../../services/secrets.js";
import { missionService } from "../../services/missions.js";
import { issueService } from "../../services/issues.js";
import { heartbeatService } from "../../services/heartbeat.js";
import { waitForHeartbeatExecutionsToDrain } from "../../services/heartbeat-execution-tracker.js";
import { workflowService } from "../../services/workflow/engine.js";
import { registerWorkflowArtifactWithStorage } from "../../services/workflow/registered-artifact-storage.js";
import { completeWorkflowIssue } from "../../services/workflow/agent-api.js";
import { resolveMissionWorkProductPaths } from "../../services/work-products/output-paths.js";
import { runningProcesses } from "../../adapters/index.js";
import { legacyHtmlManualContract } from "./legacy-html-manual.js";
import { seedSupervisionLifecycle } from "./mission-supervision-lifecycle.js";
import { recordingToolPath, startRuntimeShutdownProcessFixture } from "./runtime-shutdown-process-fixture.js";

export const producerToolPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "runtime-shutdown-producer-tool.mjs");

type ProcessFixture = Awaited<ReturnType<typeof startRuntimeShutdownProcessFixture>>;

export async function runtimeShutdownScenario(f: ProcessFixture, name: string, withSecret = false) {
  const seeded = await seedSupervisionLifecycle(f.db, "active", null);
  // [P6 producer isolation] Paused blocks real agent-run admission (heartbeat start/enqueue, main-verified);
  // user-actor manual completion and the child server's real QA tool dispatch stay on existing paths.
  await f.db.update(agents).set({ status: "paused" }).where(eq(agents.id, seeded.agentId));
  await f.db.update(companies).set({ workProductRoot: f.root }).where(eq(companies.id, seeded.companyId));
  const eventsFile = path.join(f.root, name + ".jsonl"), gateFile = path.join(f.root, name + ".gate");
  const cancelFile = path.join(f.root, name + ".cancel");
  await writeFile(eventsFile, "");
  let secretId: string | null = null;
  if (withSecret) {
    secretId = (await secretService(f.db).create(seeded.companyId, {
      name: name + "-secret", provider: "local_encrypted", value: "shutdown-proof-secret",
    })).id;
  }
  const toolName = "recorder-" + name;
  await f.db.insert(toolDefinitions).values({ companyId: seeded.companyId, name: toolName, adapterType: "builtin",
    adapterConfig: {
      command: JSON.stringify(process.execPath) + " " + JSON.stringify(recordingToolPath),
      workingDirectory: path.dirname(recordingToolPath), artifactContract: legacyHtmlManualContract(path.basename(recordingToolPath)),
      env: { RUNTIME_SHUTDOWN_RECORD_FILE: { type: "plain", value: eventsFile },
        RUNTIME_SHUTDOWN_GATE_FILE: { type: "plain", value: gateFile },
        RUNTIME_SHUTDOWN_CANCEL_FILE: { type: "plain", value: cancelFile },
        RUNTIME_SHUTDOWN_NONCE: { type: "plain", value: name },
        ...(secretId ? { RUNTIME_SHUTDOWN_SECRET: { type: "secret_ref", secretId, version: "latest" } } : {}) },
    } });
  // Distinct paused producer agent: only this agent is ever resumed (bounded, no owner wake).
  const producerSeed = await seedNativeProducerAgent(f, seeded.companyId, name);
  const definition = await workflowService.createDefinition(f.db, { companyId: seeded.companyId, name: name + " workflow",
    executionMode: "static_dag", steps: [
      { id: "producer", name: "Producer", type: "agent", agentId: producerSeed.agentId, dependencies: [] },
      { id: "qa", name: "QA", type: "tool", agentId: "", dependencies: ["producer"], toolNames: [toolName], qaType: "content",
        workProductSelectors: { producer: { type: "document", title: "content.json" } },
        toolArtifactContract: { schemaVersion: "manual-onboarding.qa.v1", role: "qa", inputStepId: "producer" },
        toolArgs: { content: "{$steps.producer.workProductPath}", assetsDir: "{$steps.producer.siblingAssetsDir}" }, maxRetries: 0 },
    ] });
  const created = await workflowService.trigger(f.db, { workflowId: definition.id, companyId: seeded.companyId,
    missionId: seeded.missionId, triggeredBy: "board" });
  const producerRun = created.stepRuns.find((row) => row.stepId === "producer")!;
  const issue = (await f.db.select().from(issues).where(eq(issues.id, producerRun.issueId!)))[0]!;
  const paths = await resolveMissionWorkProductPaths(f.db, { companyId: seeded.companyId, missionId: seeded.missionId,
    workflowRunId: created.runId });
  const content = path.join(paths!.missionOutputDir, "content.json"), assets = path.join(paths!.missionOutputDir, "assets");
  await mkdir(assets, { recursive: true });
  // Native production settles entirely inside scenario() (before any test-held DB lock, e.g. case C's
  // company_secret_versions ACCESS EXCLUSIVE): configure → parent-only bounded resume → verify process
  // identity → register with the real run → release gate → drain. The heartbeat finalizer then
  // legitimately auto-completes the producer step/issue and queues QA (requestId set, acceptedAt
  // null — no tool child yet); settle() asserts that exact state and completeProducer() re-runs the
  // native completion idempotently.
  const qaRun = created.stepRuns.find((row) => row.stepId === "qa")!;
  const nativeProducer = createNativeProducerLifecycle(f, producerSeed,
    { content, issueId: issue.id, producerStepRunId: producerRun.id, qaStepRunId: qaRun.id });
  await nativeProducer.configure();
  let producerRunId = "";
  let nativeFailure: unknown = null;
  try {
    await heartbeatService(f.db).resumeQueuedRuns(producerSeed.agentId);
    const run = await nativeProducer.waitStarted();
    producerRunId = run.id;
    const produced = await nativeProducer.waitProduced();
    nativeProducer.verify(run, produced);
    const product = await nativeProducer.register(run.id);
    await nativeProducer.release();
    await nativeProducer.settle(run.id, product.id);
  } catch (error) {
    nativeFailure = error;
    throw error;
  } finally {
    // No orphan gated child and no un-drained execution, even on failure: release the gate and
    // drain the exact DB; surface both the original failure and cleanup failures (no swallowing).
    try {
      await nativeProducer.release();
      await waitForHeartbeatExecutionsToDrain(f.db);
    } catch (cleanupError) {
      if (nativeFailure === null) throw cleanupError;
      throw new Error("native producer cleanup failed after scenario failure: " + String(cleanupError), { cause: nativeFailure });
    }
  }
  const readIssue = async () => (await f.db.select().from(issues).where(eq(issues.id, issue.id)))[0]!;
  const completeProducer = async () => {
    await completeWorkflowIssue({ db: f.db, issue: await readIssue(), actor: nativeProducer.actor(producerRunId), data: {} });
  };
  const qaStep = async () => (await f.db.select().from(workflowStepRuns).where(and(
    eq(workflowStepRuns.workflowRunId, created.runId), eq(workflowStepRuns.stepId, "qa"))))[0]!;
  const finishMission = async () => missionService(f.db).runActiveMissionOwnerSupervision({
    companyId: seeded.companyId, missionIds: [seeded.missionId], applySafeActions: true,
  });
  return { ...seeded, runId: created.runId, definitionId: definition.id, producerIssueId: issue.id,
    eventsFile, gateFile, cancelFile, content, toolName, maxRetries: 0, completeProducer, qaStep, finishMission,
    nativeProducer };
}
export type RuntimeShutdownScenarioResult = Awaited<ReturnType<typeof runtimeShutdownScenario>>;

type NativeProducerSeed = { agentId: string; companyId: string; nonce: string; recordFile: string; gateFile: string };
export type NativeProducerRecord = {
  event: string; nonce: string; pid: number; agentId: string; companyId: string; content?: string;
};

/** Distinct paused producer agent; adapter config and resume happen only after the native trigger. */
async function seedNativeProducerAgent(f: ProcessFixture, companyId: string, nonce: string): Promise<NativeProducerSeed> {
  const agentId = randomUUID();
  const recordFile = path.join(f.root, nonce + ".producer.jsonl");
  const gateFile = path.join(f.root, nonce + ".producer.gate");
  await writeFile(recordFile, "");
  await f.db.insert(agents).values({ id: agentId, companyId, name: "Native Producer " + nonce,
    status: "paused", adapterType: "process", adapterConfig: {} });
  return { agentId, companyId, nonce, recordFile, gateFile };
}

/** Real process-adapter producer lifecycle: configure → resume → verify → register → release → settle. */
export function createNativeProducerLifecycle(f: ProcessFixture, seed: NativeProducerSeed,
  bound: { content: string; issueId: string; producerStepRunId: string; qaStepRunId: string }) {
  const proof: { processIdentity?: { recordPid: number; trackedChildPid: number }; productId?: string } = {};
  const currentIssue = async () => (await f.db.select().from(issues).where(eq(issues.id, bound.issueId)))[0]!;
  const configure = async () => {
    // Set after the native trigger created the issue and the mission output path is known.
    // Plain-string env only (adapters/process/execute.ts keeps string values).
    // Exact producer only (scoped by id): idle so the bounded resume can claim it
    // (resumeQueuedRuns refuses paused agents, heartbeat.ts:5941); the owner stays paused.
    await f.db.update(agents).set({ status: "idle", adapterType: "process", adapterConfig: {
      command: process.execPath, args: [producerToolPath], cwd: f.root,
      env: {
        RUNTIME_SHUTDOWN_PRODUCER_OUT: path.dirname(bound.content),
        RUNTIME_SHUTDOWN_PRODUCER_FILE: path.basename(bound.content),
        RUNTIME_SHUTDOWN_PRODUCER_RECORD: seed.recordFile,
        RUNTIME_SHUTDOWN_PRODUCER_GATE: seed.gateFile,
        RUNTIME_SHUTDOWN_PRODUCER_NONCE: seed.nonce,
      },
      timeoutSec: 300, graceSec: 15,
    } }).where(eq(agents.id, seed.agentId));
  };
  const heartbeatRun = async () => (await f.db.select().from(heartbeatRuns)
    .where(eq(heartbeatRuns.workflowStepRunId, bound.producerStepRunId))
    .orderBy(desc(heartbeatRuns.createdAt)).limit(1))[0] ?? null;
  const waitStarted = () => f.waitFor(async () => {
    const row = await heartbeatRun();
    return row?.status === "running" && row.startedAt ? row : null;
  }, "native producer heartbeat start");
  const records = async (): Promise<NativeProducerRecord[]> => (await readFile(seed.recordFile, "utf8"))
    .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as NativeProducerRecord);
  const waitProduced = () => f.waitFor(async () =>
    (await records()).find((row) => row.event === "produced") ?? null, "native producer process output");
  const verify = (run: typeof heartbeatRuns.$inferSelect, produced: NativeProducerRecord) => {
    // node:assert/strict (not vitest) so a parent-only tsx probe can import this helper.
    assert.equal(produced.nonce, seed.nonce);
    assert.equal(produced.agentId, seed.agentId);
    assert.equal(produced.companyId, seed.companyId);
    assert.equal(produced.content, bound.content);
    assert.equal(run.agentId, seed.agentId);
    assert.equal(run.issueId, bound.issueId);
    // Exact native identity: the adapter registry's tracked child PID for this run equals the
    // producer marker PID recorded by the real process (runningProcesses: runId -> { child }).
    const tracked = runningProcesses.get(run.id);
    if (!tracked) throw new Error("native producer adapter process not tracked for run " + run.id);
    if (tracked.child.pid !== produced.pid) {
      throw new Error(`native producer PID mismatch: tracked ${tracked.child.pid} vs record ${produced.pid}`);
    }
    process.kill(produced.pid, 0);
    proof.processIdentity = { recordPid: produced.pid, trackedChildPid: tracked.child.pid };
  };
  const actor = (runId: string) => ({ actorType: "agent" as const, actorId: seed.agentId, agentId: seed.agentId, runId });
  const register = async (runId: string) => {
    // Native checkout so the agent actor holds this run's issue execution lock, then register with
    // the real heartbeat run: this stamps the workflowProducer provenance the QA selector demands.
    await issueService(f.db).checkout(bound.issueId, seed.agentId, ["todo", "in_progress"], runId);
    const product = await registerWorkflowArtifactWithStorage({ db: f.db, issue: await currentIssue(),
      actor: actor(runId), data: { path: bound.content, type: "document", title: "content.json", isPrimary: true } });
    proof.productId = product.id;
    return product;
  };
  let released = false;
  const release = async () => { if (released) return; released = true; await writeFile(seed.gateFile, "release\n"); };
  const settle = async (runId: string, productId: string) => {
    await waitForHeartbeatExecutionsToDrain(f.db);
    const row = await heartbeatRun();
    if (row?.id !== runId || row.status !== "succeeded") {
      throw new Error("native producer run not succeeded after gate release: " + (row?.status ?? "missing"));
    }
    // Parent-only native probe (p6-native-producer-parent-probe-2004, exit 1 on the old guard) proved
    // the real chain — process writes, PID identity, native registration, run succeeded — after which
    // the heartbeat finalizer legitimately auto-completes the producer step/issue and queues QA.
    // Assert that exact settled state instead of rejecting the automatic completion.
    const step = (await f.db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, bound.producerStepRunId)))[0]!;
    if (step.status !== "completed") throw new Error("native producer step not finalized: " + step.status);
    const issue = await currentIssue();
    if (issue.status !== "done") throw new Error("native producer issue not finalized: " + issue.status);
    const qa = await f.waitFor(async () => {
      const candidate = (await f.db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, bound.qaStepRunId)))[0]!;
      const queue = candidate.metadata.toolQueue;
      const status = queue && typeof queue === "object" ? (queue as Record<string, unknown>).status : undefined;
      return status === "queued" && candidate.lastDispatchRequestId && candidate.lastDispatchAcceptedAt === null
        ? candidate : null;
    }, "native producer QA queued unaccepted after finalization");
    if (!proof.processIdentity || proof.productId !== productId || !qa) throw new Error("native producer proof incomplete");
  };
  return { seed, proof, configure, heartbeatRun, waitStarted, records, waitProduced, verify, actor,
    register, release, settle };
}
