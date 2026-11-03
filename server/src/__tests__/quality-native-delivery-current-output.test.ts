// F1 public-entry proof: E completion is the only non-C03 correction owner, and
// ordinary Quality delivery cannot replace its exact workflow-resume wake.

import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { watch } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { and, eq, exists, like, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  agents,
  companies,
  heartbeatRuns,
  heartbeatRunFinalizationSteps,
  instanceSettings,
  issues,
  issueWorkProducts,
  missions,
  qualityActions,
  qualityEvidenceRefs,
  workflowRuns,
  workflowTransitionEvents,
  workflowStepInvocations,
  workflowStepRuns,
} from "@paperclipai/db";
import { uploadEvidence, linkEvidence } from "../services/quality/evidence-store.js";
import { hashContract } from "../services/quality/contract.js";
import { cancelQualityIntent, deliverQualityIntent, readQualityCancellation } from "../services/quality/native-delivery.js";
import { applyCurrentOutputCorrection } from "../services/quality/current-output.js";
import { ensureCanonicalQualityExecution } from "../services/quality/native-records.js";
import { createQaFileOwnerRuntime } from "../services/workflow/control-flow/qa-remediation-runtime.js";
import { parseQaRemediationCompletion } from "../services/workflow/control-flow/qa-remediation-completion-evidence.js";
import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";
import {
  freezeHeartbeatActualDrainIdentity,
  HEARTBEAT_ACTUAL_DRAIN_EVENT_TYPE,
  HEARTBEAT_ACTUAL_DRAIN_SCHEMA,
  readQaRemediationActualDrain,
  type HeartbeatActualDrainIdentity,
} from "../services/heartbeat-actual-drain.js";
import { readWorkflowAttemptProof } from "../services/heartbeat-finalization/workflow-attempt-proof.js";
import {
  createTerminalReleaseManifest,
  readTerminalReleaseAcknowledgment,
  readTerminalReleaseManifest,
  readTerminalReleaseManifestForSource,
  readReadyTerminalReleaseContinuation,
  terminalReleaseMatchesRun,
  TERMINAL_RELEASE_ACK_EVENT_TYPE,
  TERMINAL_RELEASE_EVENT_TYPE,
} from "../services/heartbeat-terminal-release-continuation.js";
import { completeWorkflowIssue, registerWorkflowArtifact, submitWorkflowVerdict } from "../services/workflow/agent-api.js";
import { workflowService } from "../services/workflow/engine.js";
import { recordWorkflowValidationVerdict } from "../services/workflow/validation-verdict-ledger.js";
import { heartbeatService } from "../services/heartbeat.js";
import { missionService } from "../services/missions.js";
import { getStorageService } from "../storage/index.js";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { seedQualityFixture, type QualityFixture } from "./helpers/quality-fixture.js";
import { reviewItemForAction, seedCurrentOutputScenario, type CurrentOutputSeed } from "./helpers/quality-proofs.js";
import { PYTHON } from "./helpers/qa-remediation-parent-death-harness.js";
import { runningProcesses } from "../adapters/index.js";
import {
  QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3,
  parseQaRemediationPreparation,
} from "../services/workflow/control-flow/qa-remediation-preparation-contract.js";

type TestAction = {
  seeded: QualityFixture;
  seed: CurrentOutputSeed;
  actionId: string;
  intentKey: string;
  files: { file: string; before: string; after: string }[];
  producerReleasePath: string;
  qaReleasePath: string;
  binding: Awaited<ReturnType<typeof ensureCanonicalQualityExecution>>;
};

type SetupActualDrain = { label: "producer" | "initial_qa" | "verifier"; identity: HeartbeatActualDrainIdentity };
const verifierReceiptIdentitySchema = z.object({
  companyId: z.string().uuid(), missionId: z.string().uuid(), workflowRunId: z.string().uuid(),
  dispatchAuthorityVersion: z.number().int().safe().nonnegative(), workflowStepRunId: z.string().uuid(),
  stepId: z.string().min(1), issueId: z.string().uuid(), heartbeatRunId: z.string().uuid(), wakeupRequestId: z.string().uuid(),
  executionGeneration: z.number().int().safe().nonnegative(), retryCount: z.number().int().safe().nonnegative(),
  iterationIndex: z.number().int().safe().nonnegative(), executionScopeKind: z.string().min(1),
  executionEpoch: z.number().int().safe().nonnegative(), executionToken: z.string().min(1),
  executorOwnerId: z.string().min(1), ownerLeaseEpoch: z.number().int().safe().nonnegative(), ownerLeaseToken: z.string().min(1),
  retryOfRunId: z.string().uuid().nullable(), processLossRetryCount: z.number().int().safe().nonnegative(),
  ancestry: z.object({ rootHeartbeatRunId: z.string().uuid(), rootWakeupRequestId: z.string().uuid() }).strict(),
}).strict();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typedHoldDiagnostic(error: unknown): { outcome: string; reason?: string } | undefined {
  if (!isRecord(error) || !isRecord(error.result)) return undefined;
  const safe = (value: unknown) => typeof value === "string" && /^[a-z0-9_:-]{1,96}$/.test(value) ? value : undefined;
  const outcome = safe(error.result.outcome), reason = safe(error.result.reason);
  return outcome ? { outcome, ...(reason ? { reason } : {}) } : undefined;
}

function emitStage(stage: string, phase: "before" | "after" | "error", details: Record<string, unknown>, error?: unknown): void {
  const errorName = error instanceof Error ? error.name : error === undefined ? undefined : "unknown";
  const postgres = error instanceof Error ? error as Error & { code?: unknown; position?: unknown; query?: unknown } : null;
  process.stderr.write(`[c5-f-scoped-drain] ${JSON.stringify({ stage, phase, at: new Date().toISOString(), ...details,
    ...(errorName ? { errorName } : {}),
    ...(typeof postgres?.code === "string" ? { postgresCode: postgres.code } : {}),
    ...(typeof postgres?.position === "string" || typeof postgres?.position === "number"
      ? { postgresPosition: postgres.position } : {}),
    ...(typeof postgres?.query === "string" ? { postgresQuery: postgres.query.slice(0, 2000) } : {}),
    ...(error ? { typedHoldResult: typedHoldDiagnostic(error) } : {}) })}\n`);
}

async function traceStage<T>(stage: string, details: Record<string, unknown>, run: () => Promise<T>,
  completedDetails?: (result: T) => Record<string, unknown>): Promise<T> {
  emitStage(stage, "before", details);
  try {
    const result = await run();
    emitStage(stage, "after", { ...details, ...(completedDetails?.(result) ?? {}) });
    return result;
  } catch (error) {
    emitStage(stage, "error", details, error);
    throw error;
  }
}

function scenarioTraceIds(label: string, scenario: TestAction): Record<string, unknown> {
  return { label, companyId: scenario.seeded.companyId, actionId: scenario.actionId,
    missionId: scenario.seed.missionId, workflowRunId: scenario.seed.workflowRunId,
    producerIssueId: scenario.seed.producerIssueId, initialQaIssueId: scenario.seed.qaIssueId,
    producerStepRunId: scenario.seed.producerStepRunId, initialQaStepRunId: scenario.seed.qaStepRunId,
    producerHeartbeatRunId: scenario.seed.source.heartbeatRunId,
    initialQaHeartbeatRunId: scenario.seed.verdictHeartbeatId };
}

function armOneShotReleaseRunReadFailure(db: QualityTestDb["db"], heartbeatRunId: string) {
  type PostgresClient = { unsafe: (query: string, params?: unknown[]) => unknown };
  type QueryDb = { select: (...args: unknown[]) => unknown };
  const client = db.$client as unknown as PostgresClient;
  const queryDb = db as unknown as QueryDb;
  const originalSelectDescriptor = Object.getOwnPropertyDescriptor(queryDb, "select");
  const originalSelect = queryDb.select;
  const originalDescriptor = Object.getOwnPropertyDescriptor(client, "unsafe");
  const originalUnsafe = client.unsafe;
  let armed = false;
  let consumed = false;
  let releaseGetRunCallerCaptured = false;
  let releaseGetRunCallerWasCaptured = false;
  queryDb.select = function (...args) {
    const stack = new Error().stack ?? "";
    if (armed && stack.includes("releaseFinishedRun") && stack.includes("getRun")) {
      releaseGetRunCallerCaptured = true;
      releaseGetRunCallerWasCaptured = true;
    }
    return originalSelect.apply(queryDb, args);
  };
  client.unsafe = function (query, params) {
    const isExactRunRead = query.trimStart().toUpperCase().startsWith("SELECT")
      && query.includes('from "heartbeat_runs"')
      && query.includes('"heartbeat_runs"."id" = $1')
      && params?.[0] === heartbeatRunId;
    const releaseGetRunRead = releaseGetRunCallerCaptured;
    releaseGetRunCallerCaptured = false;
    if (armed && releaseGetRunRead && isExactRunRead) {
      armed = false;
      consumed = true;
      process.stderr.write(`[c5-held-settlement-fault] ${JSON.stringify({
        fault: "one_shot_exact_release_run_read",
        heartbeatRunId,
        caller: "releaseFinishedRun.getRun",
        querySha256: createHash("sha256").update(query).digest("hex"),
      })}\n`);
      throw new Error("c5_transient_exact_release_run_read_failure");
    }
    return originalUnsafe.call(client, query, params);
  };
  return {
    arm: () => { armed = true; },
    get consumed() { return consumed; },
    get callerCaptured() { return releaseGetRunCallerWasCaptured; },
    restore: () => {
      if (originalSelectDescriptor) Object.defineProperty(queryDb, "select", originalSelectDescriptor);
      else Reflect.deleteProperty(queryDb, "select");
      if (originalDescriptor) Object.defineProperty(client, "unsafe", originalDescriptor);
      else Reflect.deleteProperty(client, "unsafe");
    },
  };
}

async function waitForMarker(markerPath: string, label: string): Promise<void> {
  const exists = async () => { try { await stat(markerPath); return true; } catch { return false; } };
  if (await exists()) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  const events = watch(path.dirname(markerPath), { signal: controller.signal });
  try {
    if (await exists()) return;
    for await (const _event of events) if (await exists()) return;
    throw new Error(`${label} exited before its start marker`);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`timed out waiting for ${label} start marker`);
    throw error;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

describeQualityDb("Quality native delivery (current_output)", () => {
  let owned: QualityTestDb;
  let home = "";
  let lockRoot = "";
  let storageRoot = "";
  let lockWaitMarker = "";
  let observedPython = "";
  const originalHome = process.env.PAPERCLIP_HOME;
  const originalLockRoot = process.env.PAPERCLIP_QA_FILE_OWNER_LOCK_ROOT;
  const originalPython = process.env.PAPERCLIP_QA_FILE_OWNER_PYTHON;
  const originalStorageProvider = process.env.PAPERCLIP_STORAGE_PROVIDER;
  const originalStorageRoot = process.env.PAPERCLIP_STORAGE_LOCAL_DIR;
  const pendingGatePaths = new Set<string>();
  let finalCleanupScope: Record<string, unknown> = { scope: "quality-native-delivery-current-output" };

  beforeAll(async () => {
    if (!PYTHON) throw new Error("the existing QA file-owner Python test runtime is unavailable");
    home = await realpath(await mkdtemp(path.join(os.tmpdir(), "quality-f1-current-output-")));
    lockRoot = path.join(home, "native-locks");
    storageRoot = path.join(home, "storage");
    lockWaitMarker = path.join(home, "lock-waits.jsonl");
    observedPython = path.join(home, "python-observe-lock-wait");
    const observerPath = path.join(home, "python-observe-lock-wait.py");
    await mkdir(lockRoot);
    await chmod(lockRoot, 0o700);
    await writeFile(lockWaitMarker, "");
    const observer = `import json, os, runpy, sys
marker = ${JSON.stringify(lockWaitMarker)}
class StdoutTap:
    def __init__(self, stream): self.stream = stream
    def write(self, value):
        for line in value.splitlines():
            try: event = json.loads(line)
            except Exception: continue
            if event.get("type") == "lock_wait":
                with open(marker, "a", encoding="utf-8") as out:
                    out.write(json.dumps(event, separators=(",", ":")) + "\\n")
                    out.flush(); os.fsync(out.fileno())
        return self.stream.write(value)
    def flush(self): return self.stream.flush()
sys.stdout = StdoutTap(sys.stdout)
runpy.run_path(sys.argv[1], run_name="__main__")
`;
    const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const launcher = `#!/bin/sh\nexec ${shellQuote(PYTHON)} ${shellQuote(observerPath)} "$@"\n`;
    const retainedRoot = "/tmp/c5-f-launcher-correction-20261102";
    const retainedLauncher = path.join(retainedRoot, "launcher.sh");
    const retainedObserver = path.join(retainedRoot, "observer.py");
    const interpreterIdentity = {
      selectedCommand: PYTHON,
      resolvedPath: await realpath(PYTHON).catch(() => null),
    };
    if (interpreterIdentity.resolvedPath) {
      const interpreterStat = await stat(interpreterIdentity.resolvedPath);
      Object.assign(interpreterIdentity, {
        dev: interpreterStat.dev,
        ino: interpreterStat.ino,
        mode: interpreterStat.mode & 0o777,
        size: interpreterStat.size,
        mtimeMs: interpreterStat.mtimeMs,
      });
    }
    await writeFile(observerPath, observer);
    await writeFile(observedPython, launcher, { mode: 0o700 });
    await chmod(observedPython, 0o700);
    await mkdir(retainedRoot, { recursive: true, mode: 0o700 });
    await chmod(retainedRoot, 0o700);
    await writeFile(retainedObserver, observer, { mode: 0o600 });
    await writeFile(retainedLauncher, launcher, { mode: 0o700 });
    await chmod(retainedLauncher, 0o700);
    await writeFile(path.join(retainedRoot, "interpreter.json"), `${JSON.stringify(interpreterIdentity, null, 2)}\n`, { mode: 0o600 });
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_QA_FILE_OWNER_LOCK_ROOT = lockRoot;
    process.env.PAPERCLIP_QA_FILE_OWNER_PYTHON = observedPython;
    process.env.PAPERCLIP_STORAGE_PROVIDER = "local_disk";
    process.env.PAPERCLIP_STORAGE_LOCAL_DIR = storageRoot;
    owned = await createQualityTestDb();
    await owned.db.insert(instanceSettings).values({ singletonKey: "default", experimental: { enableHeartbeatFinalizationV1: true } })
      .onConflictDoUpdate({ target: instanceSettings.singletonKey, set: { experimental: { enableHeartbeatFinalizationV1: true } } });
  }, 180_000);

  afterAll(async () => {
    let firstFailure: unknown;
    let hasFailure = false;
    const preserveFirstFailure = (error: unknown) => {
      if (!hasFailure) { firstFailure = error; hasFailure = true; }
    };
    const gateResults = await Promise.allSettled([...pendingGatePaths].map(async releasePath => {
      await writeFile(releasePath, "release");
      pendingGatePaths.delete(releasePath);
    }));
    for (const result of gateResults) if (result.status === "rejected") preserveFirstFailure(result.reason);
    try {
      if (owned) await traceStage("final-db-teardown-drain", finalCleanupScope,
        () => waitForHeartbeatExecutionsToDrain(owned.db, 60_000));
    } catch (error) { preserveFirstFailure(error); }
    try { await owned?.close(); } catch (error) { preserveFirstFailure(error); }
    if (originalHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalHome;
    if (originalLockRoot === undefined) delete process.env.PAPERCLIP_QA_FILE_OWNER_LOCK_ROOT;
    else process.env.PAPERCLIP_QA_FILE_OWNER_LOCK_ROOT = originalLockRoot;
    if (originalPython === undefined) delete process.env.PAPERCLIP_QA_FILE_OWNER_PYTHON;
    else process.env.PAPERCLIP_QA_FILE_OWNER_PYTHON = originalPython;
    if (originalStorageProvider === undefined) delete process.env.PAPERCLIP_STORAGE_PROVIDER;
    else process.env.PAPERCLIP_STORAGE_PROVIDER = originalStorageProvider;
    if (originalStorageRoot === undefined) delete process.env.PAPERCLIP_STORAGE_LOCAL_DIR;
    else process.env.PAPERCLIP_STORAGE_LOCAL_DIR = originalStorageRoot;
    if (home) try { await rm(home, { recursive: true, force: true }); } catch (error) { preserveFirstFailure(error); }
    if (hasFailure) throw firstFailure;
  }, 180_000);

  async function seedCurrentOutputAction(fileCount = 1, verifyWriterBoundary = false): Promise<TestAction> {
    const db = owned.db;
    const seeded = await seedQualityFixture(db);
    await db.update(companies).set({ workProductRoot: home }).where(eq(companies.id, seeded.companyId));
    await db.update(agents).set({
      status: "active", adapterType: "codex_local", adapterConfig: { promptTemplate: "Test." },
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 2 } }, permissions: {},
    }).where(eq(agents.companyId, seeded.companyId));
    const actionId = randomUUID();
    const intentKey = `f1-${actionId.slice(0, 8)}`;
    const placeholderDir = path.join(home, "seed-placeholder", actionId);
    const placeholderFiles = Array.from({ length: fileCount }, (_, index) => {
      const label = String.fromCharCode(97 + index);
      return {
        file: path.join(placeholderDir, `${label}.html`),
        before: `draft-${actionId}-${label}\n`,
        after: `fixed-${actionId}-${label}\n`,
      };
    });
    const placeholderRemediations = { items: placeholderFiles.map((file) => ({
      op: "string_replace", file: file.file, find: file.before, replace: file.after,
    })) };
    const seed = await seedCurrentOutputScenario(db, {
      companyId: seeded.companyId, authorAgentId: seeded.authorAgentId, verifierAgentId: seeded.verifierAgentId,
      artifactUrl: placeholderFiles[0]!.file, remediations: placeholderRemediations,
    });
    // The accepted G0 drain requires an actual linked producer heartbeat and
    // registered, owner-stamped outputs. Replace the helper's synthetic source
    // product/verdict paths inside this isolated DB with an actual producer run.
    const dir = path.join(home, "missions", seed.missionId, "runs", seed.workflowRunId, "steps", "produce");
    await mkdir(dir, { recursive: true });
    const files = placeholderFiles.map((file, index) => ({ ...file, file: path.join(
      index === 1 && fileCount === 2 ? path.join(dir, "b") : dir, path.basename(file.file),
    ) }));
    await Promise.all(files.map((file) => mkdir(path.dirname(file.file), { recursive: true })));
    await Promise.all(files.map((file) => writeFile(file.file, file.before)));
    await db.delete(issueWorkProducts).where(and(eq(issueWorkProducts.companyId, seeded.companyId), eq(issueWorkProducts.issueId, seed.producerIssueId)));
    await db.update(issues).set({ status: "todo", originKind: "workflow_execution", originId: seed.workflowRunId, originRunId: seed.workflowRunId })
      .where(eq(issues.id, seed.producerIssueId));
    await db.update(issues).set({ originKind: "workflow_execution", originId: seed.workflowRunId, originRunId: seed.workflowRunId })
      .where(eq(issues.id, seed.qaIssueId));
    await db.update(workflowStepRuns).set({ status: "pending", completedAt: null }).where(eq(workflowStepRuns.id, seed.producerStepRunId));
    await db.delete(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, seed.verdictEventId));
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, seed.verdictHeartbeatId));
    await db.delete(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, seeded.companyId),
      eq(agentWakeupRequests.workflowStepRunId, seed.qaStepRunId)));
    await db.update(workflowStepRuns).set({ status: "pending", completedAt: null }).where(eq(workflowStepRuns.id, seed.qaStepRunId));

    const startedPath = path.join(home, "producer-started", actionId);
    const releasePath = path.join(home, "producer-release", actionId);
    const qaStartedPath = path.join(home, "qa-started", actionId);
    const qaReleasePath = path.join(home, "qa-release", actionId);
    await mkdir(path.dirname(startedPath), { recursive: true });
    await mkdir(path.dirname(releasePath), { recursive: true });
    await mkdir(path.dirname(qaStartedPath), { recursive: true });
    await mkdir(path.dirname(qaReleasePath), { recursive: true });
    pendingGatePaths.add(releasePath);
    pendingGatePaths.add(qaReleasePath);
    const producerProgram = `const fs=require("node:fs");const files=${JSON.stringify(files.map((file) => file.file))};const contents=${JSON.stringify(files.map((file) => file.before))};for(let i=0;i<files.length;i++)fs.writeFileSync(files[i],contents[i]);fs.writeFileSync(${JSON.stringify(startedPath)},"started");const wait=new Int32Array(new SharedArrayBuffer(4));while(!fs.existsSync(${JSON.stringify(releasePath)}))Atomics.wait(wait,0,0,10);console.log(JSON.stringify({produced:true}));`;
    const qaProgram = `const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(qaStartedPath)},"started");const wait=new Int32Array(new SharedArrayBuffer(4));while(!fs.existsSync(${JSON.stringify(qaReleasePath)}))Atomics.wait(wait,0,0,10);console.log(JSON.stringify({heldSetup:true}));`;
    await db.update(agents).set({ adapterType: "process", adapterConfig: { command: process.execPath, args: ["-e", producerProgram], cwd: home } })
      .where(eq(agents.id, seeded.authorAgentId));
    // Install the QA gate before public artifact/issue sync can admit its first actual.
    await db.update(agents).set({ adapterType: "process", adapterConfig: { command: process.execPath, args: ["-e", qaProgram], cwd: home } })
      .where(eq(agents.id, seeded.verifierAgentId));
    const producer = await heartbeatService(db).wakeup(seeded.authorAgentId, {
      source: "assignment", triggerDetail: "system", reason: "workflow_step_runnable",
      payload: { issueId: seed.producerIssueId, missionId: seed.missionId, workflowRunId: seed.workflowRunId,
        workflowStepRunId: seed.producerStepRunId },
      contextSnapshot: { issueId: seed.producerIssueId, missionId: seed.missionId, workflowRunId: seed.workflowRunId,
        workflowStepRunId: seed.producerStepRunId },
    });
    if (!producer) throw new Error("real producer heartbeat was not admitted");
    // Keep the producer actual alive through official QA rejection, canonical
    // binding, and E preparation; never manufacture a post-terminal failed step.
    await waitForMarker(startedPath, "producer process");
    const [producerActual] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, producer.id));
    if (!producerActual || producerActual.executionEpoch === null || producerActual.status !== "running") {
      throw new Error(`producer actual did not remain live: ${JSON.stringify({ producerActual, workflowRunId: seed.workflowRunId })}`);
    }
    const [producerIssue] = await db.select().from(issues).where(eq(issues.id, seed.producerIssueId));
    const producerActor = { actorType: "agent" as const, actorId: seeded.authorAgentId, agentId: seeded.authorAgentId, runId: producer.id };
    for (const file of files) await registerWorkflowArtifact({ db, issue: producerIssue!, actor: producerActor,
      data: { path: file.file, type: "document", isPrimary: file === files[0] } });
    if (verifyWriterBoundary) {
      const exactProducerStepScope = () => and(
        eq(workflowStepRuns.id, seed.producerStepRunId),
        eq(workflowStepRuns.workflowRunId, seed.workflowRunId),
        eq(workflowStepRuns.issueId, seed.producerIssueId),
        exists(db.select({ id: workflowRuns.id }).from(workflowRuns).where(and(
          eq(workflowRuns.id, workflowStepRuns.workflowRunId),
          eq(workflowRuns.id, seed.workflowRunId),
          eq(workflowRuns.companyId, seeded.companyId),
          eq(workflowRuns.missionId, seed.missionId),
        ))),
      );
      const [wake] = await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, seeded.companyId), eq(agentWakeupRequests.id, producer.wakeupRequestId!),
      ));
      const [beforeIssue] = await db.select().from(issues).where(and(
        eq(issues.companyId, seeded.companyId), eq(issues.id, seed.producerIssueId),
      ));
      if (!wake || !beforeIssue || wake.workflowExecutionGeneration === null) {
        throw new Error("missing-proof refusal setup lacks the exact original wake or issue owner");
      }
      const [producerStepBeforeOwnerChecks] = await db.select().from(workflowStepRuns).where(exactProducerStepScope());
      if (!producerStepBeforeOwnerChecks || producerStepBeforeOwnerChecks.dispatchOwnerHeartbeatRunId !== producer.id
        || producerStepBeforeOwnerChecks.dispatchOwnerWakeupRequestId !== wake.id) {
        throw new Error("dispatch-owner refusal setup lacks the exact original heartbeat and wake");
      }
      const readProducerReleaseEvents = () => db.select().from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.companyId, seeded.companyId),
        eq(workflowTransitionEvents.heartbeatRunId, producer.id),
        eq(workflowTransitionEvents.eventType, TERMINAL_RELEASE_EVENT_TYPE),
      ));
      const assertDispatchOwnerRefusal = async (dispatchOwnerHeartbeatRunId: string | null,
        dispatchOwnerWakeupRequestId: string | null) => {
        await db.update(workflowStepRuns).set({ dispatchOwnerHeartbeatRunId, dispatchOwnerWakeupRequestId })
          .where(exactProducerStepScope());
        const [stepBeforeRefusal] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, seed.producerStepRunId));
        const [issueBeforeRefusal] = await db.select().from(issues).where(eq(issues.id, seed.producerIssueId));
        const manifestsBeforeRefusal = await readProducerReleaseEvents();
        expect(manifestsBeforeRefusal).toHaveLength(0);
        let refusal: unknown;
        try { await completeWorkflowIssue({ db, issue: producerIssue!, actor: producerActor, data: {} }); }
        catch (error) { refusal = error; }
        const [issueAfterRefusal] = await db.select().from(issues).where(eq(issues.id, seed.producerIssueId));
        const [stepAfterRefusal] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, seed.producerStepRunId));
        expect(refusal instanceof Error ? refusal.message : "")
          .toContain("terminal_issue_owner_release_unproven:dispatch_owner_changed");
        expect(issueAfterRefusal).toEqual(issueBeforeRefusal);
        expect(stepAfterRefusal).toEqual(stepBeforeRefusal);
        expect(await readProducerReleaseEvents()).toEqual(manifestsBeforeRefusal);
      };
      try {
        await assertDispatchOwnerRefusal(null, null);
        await assertDispatchOwnerRefusal(randomUUID(), randomUUID());
      } finally {
        await db.update(workflowStepRuns).set({
          dispatchOwnerHeartbeatRunId: producerStepBeforeOwnerChecks.dispatchOwnerHeartbeatRunId,
          dispatchOwnerWakeupRequestId: producerStepBeforeOwnerChecks.dispatchOwnerWakeupRequestId,
        }).where(exactProducerStepScope());
      }
      await db.update(agentWakeupRequests).set({ workflowExecutionGeneration: wake.workflowExecutionGeneration + 1 })
        .where(and(eq(agentWakeupRequests.companyId, seeded.companyId), eq(agentWakeupRequests.id, wake.id)));
      let missingProofError: unknown;
      try { await completeWorkflowIssue({ db, issue: producerIssue!, actor: producerActor, data: {} }); }
      catch (error) { missingProofError = error; }
      await db.update(agentWakeupRequests).set({ workflowExecutionGeneration: wake.workflowExecutionGeneration })
        .where(and(eq(agentWakeupRequests.companyId, seeded.companyId), eq(agentWakeupRequests.id, wake.id)));
      const [afterMissingProof] = await db.select().from(issues).where(and(
        eq(issues.companyId, seeded.companyId), eq(issues.id, seed.producerIssueId),
      ));
      expect(missingProofError instanceof Error ? missingProofError.message : "").toContain("terminal_issue_owner_release_unproven");
      expect(afterMissingProof).toEqual(beforeIssue);
    }
    await completeWorkflowIssue({ db, issue: producerIssue!, actor: producerActor, data: {} });
    const [producerAfterPublicCompletion] = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, seeded.companyId), eq(heartbeatRuns.id, producer.id),
    ));
    const [producerOwnerAttemptAfterPublicCompletion] = await db.select({
      status: heartbeatRuns.status, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
      issueId: heartbeatRuns.issueId, wakeupRequestId: heartbeatRuns.wakeupRequestId,
      workflowStepRunId: heartbeatRuns.workflowStepRunId,
      workflowExecutionGeneration: heartbeatRuns.workflowExecutionGeneration,
      executionScopeKind: heartbeatRuns.executionScopeKind, executionEpoch: heartbeatRuns.executionEpoch,
      executorOwnerId: heartbeatRuns.executorOwnerId, executorOwnerLeaseEpoch: heartbeatRuns.executorOwnerLeaseEpoch,
      retryOfRunId: heartbeatRuns.retryOfRunId, processLossRetryCount: heartbeatRuns.processLossRetryCount,
      startedAt: heartbeatRuns.startedAt,
    }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, seeded.companyId), eq(heartbeatRuns.id, producer.id),
    ));
    const [producerIssueAfterPublicCompletion] = await db.select().from(issues).where(and(
      eq(issues.companyId, seeded.companyId), eq(issues.id, seed.producerIssueId),
    ));
    const producerIdentity = producerAfterPublicCompletion
      ? await freezeHeartbeatActualDrainIdentity(db, producerAfterPublicCompletion, { workflowRunId: seed.workflowRunId }) : null;
    const releaseEvidence = producerIdentity
      ? await readTerminalReleaseManifestForSource(db, producerIdentity, seeded.authorAgentId) : null;
    if (releaseEvidence?.kind !== "found") {
      throw new Error(`public completion release evidence missing or held: ${releaseEvidence?.kind === "held" ? releaseEvidence.reason : "missing_record"}`);
    }
    expect(producerAfterPublicCompletion?.status).toBe("running");
    expect(producerOwnerAttemptAfterPublicCompletion).toEqual({ status: producerActual.status,
      companyId: producerActual.companyId, agentId: producerActual.agentId, issueId: producerActual.issueId,
      wakeupRequestId: producerActual.wakeupRequestId, workflowStepRunId: producerActual.workflowStepRunId,
      workflowExecutionGeneration: producerActual.workflowExecutionGeneration,
      executionScopeKind: producerActual.executionScopeKind, executionEpoch: producerActual.executionEpoch,
      executorOwnerId: producerActual.executorOwnerId, executorOwnerLeaseEpoch: producerActual.executorOwnerLeaseEpoch,
      retryOfRunId: producerActual.retryOfRunId, processLossRetryCount: producerActual.processLossRetryCount,
      startedAt: producerActual.startedAt });
    expect(producerAfterPublicCompletion?.resultJson === producerActual.resultJson).toBe(true);
    expect(producerIssueAfterPublicCompletion).toMatchObject({ status: "done", executionRunId: null,
      checkoutRunId: null, executionAgentNameKey: null, executionLockedAt: null });
    expect(releaseEvidence.manifest.source).toMatchObject({ companyId: seeded.companyId, missionId: seed.missionId,
      workflowRunId: seed.workflowRunId, workflowStepRunId: seed.producerStepRunId,
      issueId: seed.producerIssueId, heartbeatRunId: producer.id, wakeupRequestId: producer.wakeupRequestId,
      executionGeneration: producerAfterPublicCompletion!.workflowExecutionGeneration, agentId: seeded.authorAgentId });
    expect(releaseEvidence.manifest.obligations.map(item => [item.stage, item.action.kind])).toEqual([
      ["issue_promotion", "promote_issue_wakes"], ["issue_promotion", "promote_agent_queue"],
      ["workflow_evidence_sync", "sync_issue"], ["workflow_evidence_sync", "reevaluate_source"],
    ]);
    await waitForMarker(qaStartedPath, "controlled QA process");
    const [qaHeartbeat] = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, seeded.companyId), eq(heartbeatRuns.workflowStepRunId, seed.qaStepRunId),
    ));
    if (!qaHeartbeat || qaHeartbeat.executionEpoch === null || qaHeartbeat.status !== "running") {
      throw new Error(`controlled QA actual did not remain live: ${JSON.stringify({ qaHeartbeat, workflowRunId: seed.workflowRunId })}`);
    }
    const [qaIssue] = await db.select().from(issues).where(eq(issues.id, seed.qaIssueId));
    const rejection = await recordWorkflowValidationVerdict({
      db, issue: qaIssue!, source: "workflow_api", verdict: "request_changes",
      actorAgentId: seeded.verifierAgentId, heartbeatRunId: qaHeartbeat.id,
      sourceText: "F1 controlled initial rejection",
      remediations: { items: files.map((file) => ({ op: "string_replace", file: file.file, find: file.before, replace: file.after })) },
    });
    if (!rejection.satisfied || rejection.workflowStepRunId !== seed.qaStepRunId) {
      throw new Error(`structured QA rejection was not recorded for the exact step: ${JSON.stringify(rejection)}`);
    }
    const source = { ...seed.source, heartbeatRunId: producerActual.id, executionEpoch: producerActual.executionEpoch };
    const [verdictEvent] = await db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, seeded.companyId),
      eq(workflowTransitionEvents.workflowStepRunId, seed.qaStepRunId),
      eq(workflowTransitionEvents.heartbeatRunId, qaHeartbeat.id),
      eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
      eq(workflowTransitionEvents.verdict, "request_changes"),
    ));
    if (!verdictEvent) throw new Error("exact structured QA rejection event is missing");
    expect(verdictEvent).toMatchObject({ executionGeneration: null, wakeupRequestId: null });
    const actionSeed = { ...seed, source, verdictEventId: verdictEvent.id, verdictHeartbeatId: qaHeartbeat.id };
    const target = { kind: "current_output" as const, source };
    const effect = { kind: "repair_supported_output" as const, target };
    const { occurrenceId } = await reviewItemForAction(db, seeded.companyId, source, source.heartbeatRunId);
    await db.insert(qualityActions).values({
      id: actionId, companyId: seeded.companyId, groupId: seeded.groupId, kind: "current_output",
      occurrenceSetHash: hashContract([occurrenceId]), occurrenceIds: [occurrenceId],
      policyVersionId: seeded.policyVersionId, scopeVersion: 1,
      target, targetHash: hashContract(target), effect, effectHash: hashContract(effect),
      retryEnvelope: {
        intentKey, effectHash: hashContract(effect), targetHash: hashContract(target),
        maxExecutorAttempts: 2, deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
        groupId: seeded.groupId, policyVersionId: seeded.policyVersionId, maxCumulativeCostCents: 100,
      },
      revision: 1, state: "created", intentKey,
    });
    const binding = await ensureCanonicalQualityExecution(db, { companyId: seeded.companyId, actionId });
    if (binding.stepRunId !== seed.qaStepRunId || binding.issueId !== seed.qaIssueId) {
      throw new Error(`canonical QA binding differs from the controlled actual: ${JSON.stringify({ binding, qaHeartbeatId: qaHeartbeat.id })}`);
    }
    return { seeded, seed: actionSeed, actionId, intentKey, files, producerReleasePath: releasePath, qaReleasePath, binding };
  }

  function verifierStartedPath(scenario: TestAction) { return path.join(home, "e-verifier-started", scenario.actionId); }

  async function useProcessVerifier(scenario: TestAction): Promise<void> {
    const startedPath = verifierStartedPath(scenario);
    await mkdir(path.dirname(startedPath), { recursive: true });
    const program = `const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(startedPath)},"started");const files=${JSON.stringify(scenario.files.map((file) => file.file))};const expected=${JSON.stringify(scenario.files.map((file) => file.after))};const observed=files.map(file=>fs.readFileSync(file,"utf8"));console.log(JSON.stringify({verdict:observed.every((value,index)=>value===expected[index])?"pass":"request_changes",observed}));`;
    await owned.db.update(agents).set({
      adapterType: "process", adapterConfig: { command: process.execPath, args: ["-e", program], cwd: home },
    }).where(eq(agents.id, scenario.seed.verifierAgentId));
  }

  async function useHeldProcessVerifier(scenario: TestAction, startedPath: string, releasePath: string,
    holdAfterSigterm = false, acknowledgementPath?: string): Promise<void> {
    await mkdir(path.dirname(startedPath), { recursive: true });
    await mkdir(path.dirname(releasePath), { recursive: true });
    pendingGatePaths.add(releasePath);
    if (holdAfterSigterm && !acknowledgementPath) throw new Error("held verifier requires its SIGTERM acknowledgement path");
    if (holdAfterSigterm) await mkdir(path.dirname(acknowledgementPath!), { recursive: true });
    const program = holdAfterSigterm
      ? `const fs=require("node:fs");const files=${JSON.stringify(scenario.files.map((file) => file.file))};const expected=${JSON.stringify(scenario.files.map((file) => file.after))};let released=false;let watcher;const finish=()=>{if(released||!fs.existsSync(${JSON.stringify(releasePath)}))return;released=true;watcher.close();const observed=files.map(file=>fs.readFileSync(file,"utf8"));console.log(JSON.stringify({verdict:observed.every((value,index)=>value===expected[index])?"pass":"request_changes",observed}));};watcher=fs.watch(${JSON.stringify(path.dirname(releasePath))},()=>finish());process.on("SIGTERM",()=>{fs.writeFileSync(${JSON.stringify(acknowledgementPath)},String(process.pid));});fs.writeFileSync(${JSON.stringify(startedPath)},"started");finish();`
      : `const fs=require("node:fs");const files=${JSON.stringify(scenario.files.map((file) => file.file))};const expected=${JSON.stringify(scenario.files.map((file) => file.after))};fs.writeFileSync(${JSON.stringify(startedPath)},"started");const wait=new Int32Array(new SharedArrayBuffer(4));while(!fs.existsSync(${JSON.stringify(releasePath)}))Atomics.wait(wait,0,0,10);const observed=files.map(file=>fs.readFileSync(file,"utf8"));console.log(JSON.stringify({verdict:observed.every((value,index)=>value===expected[index])?"pass":"request_changes",observed}));`;
    await owned.db.update(agents).set({
      adapterType: "process", adapterConfig: { command: process.execPath, args: ["-e", program], cwd: home },
    }).where(eq(agents.id, scenario.seed.verifierAgentId));
  }

  async function captureSetupActualDrain(scenario: TestAction, label: SetupActualDrain["label"], heartbeatRunId: string,
    workflowStepRunId: string, issueId: string, agentId: string): Promise<SetupActualDrain> {
    const [actual] = await owned.db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, scenario.seeded.companyId), eq(heartbeatRuns.id, heartbeatRunId),
    ));
    if (!actual || actual.agentId !== agentId || actual.issueId !== issueId || actual.workflowStepRunId !== workflowStepRunId) {
      throw new Error(`original ${label} actual identity missing for ${JSON.stringify(scenarioTraceIds(label, scenario))}`);
    }
    const identity = await freezeHeartbeatActualDrainIdentity(owned.db, actual, { workflowRunId: scenario.seed.workflowRunId });
    if (!identity || identity.companyId !== scenario.seeded.companyId || identity.missionId !== scenario.seed.missionId
      || identity.workflowRunId !== scenario.seed.workflowRunId || identity.workflowStepRunId !== workflowStepRunId
      || identity.issueId !== issueId || identity.heartbeatRunId !== heartbeatRunId) {
      throw new Error(`original ${label} attempt could not be frozen for ${JSON.stringify(scenarioTraceIds(label, scenario))}`);
    }
    return { label, identity };
  }

  async function hasExactSetupActualDrain(proof: SetupActualDrain): Promise<boolean> {
    const { identity } = proof;
    const rows = await owned.db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, identity.companyId),
      eq(workflowTransitionEvents.workflowRunId, identity.workflowRunId),
      eq(workflowTransitionEvents.workflowStepRunId, identity.workflowStepRunId),
      eq(workflowTransitionEvents.issueId, identity.issueId),
      eq(workflowTransitionEvents.heartbeatRunId, identity.heartbeatRunId),
      eq(workflowTransitionEvents.executionGeneration, identity.executionGeneration),
      eq(workflowTransitionEvents.eventType, HEARTBEAT_ACTUAL_DRAIN_EVENT_TYPE),
    ));
    if (rows.length === 0) return false;
    const fail = () => { throw new Error(`exact ${proof.label} actual-drain proof malformed for company ${identity.companyId}, workflow ${identity.workflowRunId}, heartbeat ${identity.heartbeatRunId}`); };
    if (rows.length !== 1) return fail();
    const row = rows[0]!;
    const payload = row.payload;
    const eventIdentity = isRecord(payload) ? payload.identity : undefined;
    const actual = isRecord(payload) && isRecord(payload.actual) ? payload.actual : undefined;
    const cleanup = isRecord(payload) && isRecord(payload.cleanup) ? payload.cleanup : undefined;
    const runtimeServicesRelease = cleanup && isRecord(cleanup.runtimeServicesRelease) ? cleanup.runtimeServicesRelease : undefined;
    const heartbeatSettlement = cleanup && isRecord(cleanup.heartbeatSettlement) ? cleanup.heartbeatSettlement : undefined;
    const resources = cleanup && isRecord(cleanup.resources) ? cleanup.resources : undefined;
    const expectedKey = `heartbeat-actual-drained:v1:${identity.heartbeatRunId}:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
    if (!isRecord(payload) || !isDeepStrictEqual(Object.keys(payload).sort(), ["actual", "cleanup", "identity", "schemaVersion"])
      || payload.schemaVersion !== HEARTBEAT_ACTUAL_DRAIN_SCHEMA
      || row.companyId !== identity.companyId || row.missionId !== identity.missionId
      || row.workflowRunId !== identity.workflowRunId || row.workflowStepRunId !== identity.workflowStepRunId
      || row.issueId !== identity.issueId || row.heartbeatRunId !== identity.heartbeatRunId
      || row.executionGeneration !== identity.executionGeneration || row.dispatchOwnerHeartbeatRunId !== identity.heartbeatRunId
      || row.executorOwnerId !== identity.executorOwnerId || row.eventType !== HEARTBEAT_ACTUAL_DRAIN_EVENT_TYPE
      || row.layer !== "heartbeat" || row.reason !== "actual_adapter_settled_and_cleaned"
      || row.reasonCode !== "actual_drain_observed" || row.idempotencyKey !== expectedKey || row.wakeupRequestId !== null
      || !isDeepStrictEqual(eventIdentity, identity) || !actual
      || !isDeepStrictEqual(Object.keys(actual).sort(), ["observedAt", "outcome"]) || actual.outcome !== "fulfilled"
      || typeof actual.observedAt !== "string" || !Number.isFinite(Date.parse(actual.observedAt))
      || !/(?:Z|[+-]\d{2}:\d{2})$/.test(actual.observedAt)
      || !cleanup || !isDeepStrictEqual(Object.keys(cleanup).sort(), ["heartbeatSettlement", "resources", "runtimeServicesRelease"])
      || !isDeepStrictEqual(runtimeServicesRelease, { called: true, succeeded: true })
      || !isDeepStrictEqual(heartbeatSettlement, { called: true, succeeded: true })
      || !isDeepStrictEqual(resources, { workspaceOperationsSettled: true, runtimeServicesStopped: true, missionRuntimeIdle: true })) return fail();
    return true;
  }

  async function setupActualDrainDiagnostic(proof: SetupActualDrain): Promise<Record<string, unknown>> {
    const { identity } = proof;
    const rows = await owned.db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, identity.companyId),
      eq(workflowTransitionEvents.workflowRunId, identity.workflowRunId),
      eq(workflowTransitionEvents.workflowStepRunId, identity.workflowStepRunId),
      eq(workflowTransitionEvents.issueId, identity.issueId),
      eq(workflowTransitionEvents.heartbeatRunId, identity.heartbeatRunId),
      eq(workflowTransitionEvents.executionGeneration, identity.executionGeneration),
      eq(workflowTransitionEvents.eventType, HEARTBEAT_ACTUAL_DRAIN_EVENT_TYPE),
    ));
    const safe = { label: proof.label, companyId: identity.companyId, missionId: identity.missionId,
      workflowRunId: identity.workflowRunId, workflowStepRunId: identity.workflowStepRunId,
      issueId: identity.issueId, heartbeatRunId: identity.heartbeatRunId, recordCount: rows.length };
    if (!rows.length) return { ...safe, state: "missing_record", reason: "exact_actual_drain_record_missing" };
    if (rows.length !== 1) return { ...safe, state: "held", reason: "exact_actual_drain_record_ambiguous" };
    try {
      return await hasExactSetupActualDrain(proof)
        ? { ...safe, state: "found" }
        : { ...safe, state: "held", reason: "exact_actual_drain_record_malformed_or_mismatched" };
    } catch {
      return { ...safe, state: "held", reason: "exact_actual_drain_record_malformed_or_mismatched" };
    }
  }

  async function deriveVerifierReceipt(scenario: TestAction, wake: typeof agentWakeupRequests.$inferSelect,
    run: typeof heartbeatRuns.$inferSelect): Promise<SetupActualDrain | null> {
    const rows = await owned.db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, scenario.seeded.companyId),
      eq(workflowTransitionEvents.workflowRunId, scenario.seed.workflowRunId),
      eq(workflowTransitionEvents.workflowStepRunId, scenario.seed.qaStepRunId),
      eq(workflowTransitionEvents.issueId, scenario.seed.qaIssueId),
      eq(workflowTransitionEvents.heartbeatRunId, run.id),
      eq(workflowTransitionEvents.eventType, HEARTBEAT_ACTUAL_DRAIN_EVENT_TYPE),
    ));
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw new Error(`ambiguous verifier actual-drain receipt for ${run.id}`);
    const row = rows[0]!, payload = row.payload;
    const rawIdentity = isRecord(payload) && isRecord(payload.identity) ? payload.identity : null;
    const actual = isRecord(payload) && isRecord(payload.actual) ? payload.actual : null;
    const cleanup = isRecord(payload) && isRecord(payload.cleanup) ? payload.cleanup : null;
    const expectedIdentityKeys = ["ancestry", "companyId", "dispatchAuthorityVersion", "executionEpoch",
      "executionGeneration", "executionScopeKind", "executionToken", "executorOwnerId", "heartbeatRunId",
      "issueId", "iterationIndex", "missionId", "ownerLeaseEpoch", "ownerLeaseToken", "processLossRetryCount",
      "retryCount", "retryOfRunId", "stepId", "wakeupRequestId", "workflowRunId", "workflowStepRunId"];
    const identityResult = verifierReceiptIdentitySchema.safeParse(rawIdentity);
    const identity = identityResult.success ? identityResult.data : null;
    const expectedKey = identity
      ? `heartbeat-actual-drained:v1:${run.id}:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}` : "";
    const reservedAttempt = readWorkflowAttemptProof(wake);
    const [step] = await owned.db.select().from(workflowStepRuns).where(and(
      eq(workflowStepRuns.id, scenario.seed.qaStepRunId), eq(workflowStepRuns.workflowRunId, scenario.seed.workflowRunId),
    ));
    const [workflow] = await owned.db.select().from(workflowRuns).where(and(
      eq(workflowRuns.id, scenario.seed.workflowRunId), eq(workflowRuns.companyId, scenario.seeded.companyId),
    ));
    const preparation = parseQaRemediationPreparation((await preparationRows(scenario))[0]!.payload);
    const frozenQa = preparation.verdicts.find(verdict => verdict.qa.stepRunId === scenario.seed.qaStepRunId);
    if (!identity || !isDeepStrictEqual(Object.keys(identity).sort(), expectedIdentityKeys)
      || !isRecord(identity.ancestry) || !isDeepStrictEqual(Object.keys(identity.ancestry).sort(), ["rootHeartbeatRunId", "rootWakeupRequestId"])
      || !isRecord(payload) || !isDeepStrictEqual(Object.keys(payload).sort(), ["actual", "cleanup", "identity", "schemaVersion"])
      || payload.schemaVersion !== HEARTBEAT_ACTUAL_DRAIN_SCHEMA || !actual
      || !isDeepStrictEqual(Object.keys(actual).sort(), ["observedAt", "outcome"])
      || actual.outcome !== "fulfilled" || typeof actual.observedAt !== "string"
      || !Number.isFinite(Date.parse(actual.observedAt)) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(actual.observedAt)
      || !cleanup || !isDeepStrictEqual(Object.keys(cleanup).sort(), ["heartbeatSettlement", "resources", "runtimeServicesRelease"])
      || !isDeepStrictEqual(cleanup.runtimeServicesRelease, { called: true, succeeded: true })
      || !isDeepStrictEqual(cleanup.heartbeatSettlement, { called: true, succeeded: true })
      || !isDeepStrictEqual(cleanup.resources, { workspaceOperationsSettled: true, runtimeServicesStopped: true, missionRuntimeIdle: true })
      || row.companyId !== scenario.seeded.companyId || row.missionId !== scenario.seed.missionId
      || row.workflowRunId !== scenario.seed.workflowRunId || row.workflowStepRunId !== scenario.seed.qaStepRunId
      || row.issueId !== scenario.seed.qaIssueId || row.heartbeatRunId !== run.id || row.dispatchOwnerHeartbeatRunId !== run.id
      || row.executorOwnerId !== run.executorOwnerId || row.executionGeneration !== run.workflowExecutionGeneration
      || row.eventType !== HEARTBEAT_ACTUAL_DRAIN_EVENT_TYPE || row.layer !== "heartbeat"
      || row.reason !== "actual_adapter_settled_and_cleaned" || row.reasonCode !== "actual_drain_observed"
      || row.idempotencyKey !== expectedKey || row.wakeupRequestId !== null
      || identity.companyId !== scenario.seeded.companyId || identity.missionId !== scenario.seed.missionId
      || identity.workflowRunId !== scenario.seed.workflowRunId || identity.workflowStepRunId !== scenario.seed.qaStepRunId
      || identity.issueId !== scenario.seed.qaIssueId
      || identity.heartbeatRunId !== run.id || identity.wakeupRequestId !== wake.id
      || identity.executionGeneration !== wake.workflowExecutionGeneration || identity.executionEpoch !== run.executionEpoch
      || identity.executionScopeKind !== run.executionScopeKind || identity.retryOfRunId !== run.retryOfRunId
      || identity.executionToken !== run.executionToken || identity.executorOwnerId !== run.executorOwnerId
      || identity.ownerLeaseEpoch !== run.executorOwnerLeaseEpoch || identity.ownerLeaseToken !== run.executorOwnerLeaseToken
      || identity.retryOfRunId !== run.retryOfRunId || identity.processLossRetryCount !== run.processLossRetryCount) {
      throw new Error(`verifier actual-drain receipt did not match exact wake/run ${run.id}`);
    }
    if (!step || !workflow || !frozenQa || wake.runId !== run.id || run.wakeupRequestId !== wake.id
      || wake.agentId !== scenario.seed.verifierAgentId || wake.missionId !== scenario.seed.missionId
      || wake.workflowRunId !== scenario.seed.workflowRunId || wake.issueId !== scenario.seed.qaIssueId
      || wake.workflowStepRunId !== step.id || wake.workflowExecutionGeneration !== step.executionGeneration
      || step.issueId !== scenario.seed.qaIssueId || step.stepId !== frozenQa.qa.stepId
      || step.retryCount !== reservedAttempt.retryCount || step.iterationIndex !== reservedAttempt.iterationIndex
      || identity.retryCount !== reservedAttempt.retryCount || identity.iterationIndex !== reservedAttempt.iterationIndex
      || reservedAttempt.retryCount !== frozenQa.qa.retryCount || reservedAttempt.iterationIndex !== frozenQa.qa.iterationIndex
      || reservedAttempt.parentHeartbeatRunId !== run.retryOfRunId
      || identity.dispatchAuthorityVersion !== workflow.dispatchAuthorityVersion || workflow.missionId !== scenario.seed.missionId) {
      throw new Error(`verifier receipt attempt proof or workflow authority differs from exact E ${run.id}`);
    }
    const proof = { label: "verifier" as const, identity: identity as unknown as HeartbeatActualDrainIdentity };
    if (!(await hasExactSetupActualDrain(proof))) throw new Error(`verifier exact actual-drain receipt failed validation for ${run.id}`);
    return proof;
  }

  async function releaseSetupActuals(scenario: TestAction): Promise<SetupActualDrain[]> {
    const proofs = await Promise.all([
      captureSetupActualDrain(scenario, "producer", scenario.seed.source.heartbeatRunId,
        scenario.seed.producerStepRunId, scenario.seed.producerIssueId, scenario.seeded.authorAgentId),
      captureSetupActualDrain(scenario, "initial_qa", scenario.seed.verdictHeartbeatId,
        scenario.seed.qaStepRunId, scenario.seed.qaIssueId, scenario.seeded.verifierAgentId),
    ]);
    await Promise.all([scenario.producerReleasePath, scenario.qaReleasePath].map(async releasePath => {
      await writeFile(releasePath, "release");
      pendingGatePaths.delete(releasePath);
    }));
    const timeoutMs = 60_000;
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const complete = await Promise.all(proofs.map(hasExactSetupActualDrain));
      if (complete.every(Boolean)) return proofs;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        const diagnostics = await Promise.all(proofs.map(setupActualDrainDiagnostic));
        throw new Error(`timed out waiting for exact original setup actual drains after ${timeoutMs}ms: ${JSON.stringify(diagnostics)}`);
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(20, remainingMs)));
    }
  }

  async function assertCurrentOutputSetup(scenario: TestAction, actualsMustBeRunning = true): Promise<{
    producer: typeof heartbeatRuns.$inferSelect;
    qa: typeof heartbeatRuns.$inferSelect;
  }> {
    if (scenario.seed.source.workflow.kind !== "workflow_step" || scenario.seed.source.mission.kind !== "mission") {
      throw new Error(`fixture source is not a workflow mission: ${JSON.stringify(scenario.seed.source)}`);
    }
    const producerWorkflow = scenario.seed.source.workflow;
    const [mission] = await owned.db.select({ status: missions.status }).from(missions)
      .where(and(eq(missions.companyId, scenario.seeded.companyId), eq(missions.id, scenario.seed.missionId)));
    const [workflowRun] = await owned.db.select().from(workflowRuns).where(and(
      eq(workflowRuns.companyId, scenario.seeded.companyId), eq(workflowRuns.id, scenario.seed.workflowRunId),
    ));
    const [producer] = await owned.db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, scenario.seeded.companyId), eq(heartbeatRuns.id, scenario.seed.source.heartbeatRunId),
    ));
    const [qa] = await owned.db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, scenario.seeded.companyId), eq(heartbeatRuns.id, scenario.seed.verdictHeartbeatId),
    ));
    const [producerStep] = await owned.db.select().from(workflowStepRuns).where(and(
      eq(workflowStepRuns.id, scenario.seed.producerStepRunId), eq(workflowStepRuns.workflowRunId, scenario.seed.workflowRunId),
    ));
    const [qaStep] = await owned.db.select().from(workflowStepRuns).where(and(
      eq(workflowStepRuns.id, scenario.seed.qaStepRunId), eq(workflowStepRuns.workflowRunId, scenario.seed.workflowRunId),
    ));
    const products = await owned.db.select().from(issueWorkProducts).where(and(
      eq(issueWorkProducts.companyId, scenario.seeded.companyId), eq(issueWorkProducts.issueId, scenario.seed.producerIssueId),
    ));
    const verdictRows = await owned.db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, scenario.seeded.companyId),
      eq(workflowTransitionEvents.workflowRunId, scenario.seed.workflowRunId),
      eq(workflowTransitionEvents.workflowStepRunId, scenario.seed.qaStepRunId),
      eq(workflowTransitionEvents.issueId, scenario.seed.qaIssueId),
      eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
      eq(workflowTransitionEvents.reasonCode, "workflow_api"),
      eq(workflowTransitionEvents.verdict, "request_changes"),
    ));
    const verdict = verdictRows.length === 1 && verdictRows[0]!.id === scenario.seed.verdictEventId
      ? verdictRows[0] : undefined;
    const [action] = await owned.db.select({ canonicalBinding: qualityActions.canonicalBinding }).from(qualityActions)
      .where(and(eq(qualityActions.companyId, scenario.seeded.companyId), eq(qualityActions.id, scenario.actionId)));
    const diagnostics = { mission, workflowRun: workflowRun && { id: workflowRun.id, status: workflowRun.status },
      producer: producer && { id: producer.id, status: producer.status, epoch: producer.executionEpoch,
        stepRunId: producer.workflowStepRunId, generation: producer.workflowExecutionGeneration },
      qa: qa && { id: qa.id, status: qa.status, epoch: qa.executionEpoch,
        stepRunId: qa.workflowStepRunId, generation: qa.workflowExecutionGeneration },
      producerStep: producerStep && { id: producerStep.id, status: producerStep.status, generation: producerStep.executionGeneration },
      qaStep: qaStep && { id: qaStep.id, status: qaStep.status, generation: qaStep.executionGeneration },
      products: products.map((product) => ({ id: product.id, status: product.status, provider: product.provider,
        createdByRunId: product.createdByRunId, registeredByRunId: product.metadata?.registeredByRunId, url: product.externalId })),
      verdictRows: verdictRows.map((row) => ({ id: row.id, heartbeatRunId: row.heartbeatRunId,
        verdict: row.verdict, reasonCode: row.reasonCode })),
      canonicalBinding: action?.canonicalBinding };
    const terminalMission = new Set(["completed", "cancelled"]);
    const terminalRun = new Set(["completed", "cancelled", "aborted", "failed", "timed-out"]);
    expect(mission && !terminalMission.has(mission.status), `source mission is terminal: ${JSON.stringify(diagnostics)}`).toBe(true);
    expect(workflowRun && !terminalRun.has(workflowRun.status ?? ""), `source workflow run is terminal: ${JSON.stringify(diagnostics)}`).toBe(true);
    expect(producer, `real producer actual missing: ${JSON.stringify(diagnostics)}`).toBeDefined();
    expect(qa, `real controlled QA actual missing: ${JSON.stringify(diagnostics)}`).toBeDefined();
    expect(producer).toMatchObject({ id: scenario.seed.source.heartbeatRunId, companyId: scenario.seeded.companyId,
      agentId: scenario.seeded.authorAgentId, issueId: scenario.seed.producerIssueId,
      workflowStepRunId: scenario.seed.producerStepRunId, workflowExecutionGeneration: producerWorkflow.generation });
    expect(qa).toMatchObject({ id: scenario.seed.verdictHeartbeatId,
      companyId: scenario.seeded.companyId, agentId: scenario.seed.verifierAgentId, issueId: scenario.seed.qaIssueId,
      workflowStepRunId: scenario.seed.qaStepRunId, workflowExecutionGeneration: qaStep!.executionGeneration });
    if (actualsMustBeRunning) {
      expect(producer!.status, `producer actual is not held live before delivery: ${JSON.stringify(diagnostics)}`).toBe("running");
      expect(qa!.status, `controlled QA actual is not held live before delivery: ${JSON.stringify(diagnostics)}`).toBe("running");
    }
    expect(producer!.executionEpoch).toBe(scenario.seed.source.executionEpoch);
    expect(qa!.executionEpoch).not.toBeNull();
    expect(producerStep!.executionGeneration).toBe(producerWorkflow.generation);
    expect(qaStep!.executionGeneration).toBe(qa!.workflowExecutionGeneration);
    expect(products).toHaveLength(scenario.files.length);
    expect(new Set(products.map((product) => product.externalId))).toEqual(new Set(scenario.files.map((file) => file.file)));
    for (const product of products) {
      expect(product, `registered output ${product.id}; expected producer ${producer!.id}`).toMatchObject({
        type: "document",
        provider: "local_file",
        status: "active",
        createdByRunId: producer!.id,
        metadata: { registeredByRunId: producer!.id },
      });
    }
    expect(verdictRows.map((row) => row.id), `official rejection history is not singular and exact: ${JSON.stringify(diagnostics)}`)
      .toEqual([scenario.seed.verdictEventId]);
    expect(verdict, `exact official rejection missing: ${JSON.stringify(diagnostics)}`).toMatchObject({
      heartbeatRunId: scenario.seed.verdictHeartbeatId,
      verdict: "request_changes",
      reasonCode: "workflow_api",
      payload: {
        kind: "workflow_validation_verdict",
        workflowRunId: scenario.seed.workflowRunId,
        stepRunId: scenario.seed.qaStepRunId,
        issueId: scenario.seed.qaIssueId,
        verdict: "request_changes",
      },
    });
    expect(action?.canonicalBinding).toEqual(scenario.binding);
    return { producer: producer!, qa: qa! };
  }

  async function assertCurrentOutputSourceDrain(scenario: TestAction, preparation: ReturnType<typeof parseQaRemediationPreparation>): Promise<void> {
    const [producerStep] = await owned.db.select().from(workflowStepRuns).where(and(
      eq(workflowStepRuns.id, scenario.seed.producerStepRunId),
      eq(workflowStepRuns.workflowRunId, scenario.seed.workflowRunId),
    ));
    expect(producerStep, `source producer step missing after actual release: ${JSON.stringify({
      companyId: scenario.seeded.companyId, missionId: scenario.seed.missionId,
      workflowRunId: scenario.seed.workflowRunId, producerStepRunId: scenario.seed.producerStepRunId,
    })}`).toBeDefined();
    const drain = await readQaRemediationActualDrain(owned.db, preparation, producerStep!);
    expect(drain.kind, `scoped G0 actual drain is not proven: ${JSON.stringify(drain)}`).toBe("proven");
    if (drain.kind !== "proven") throw new Error(`scoped G0 actual drain held: ${JSON.stringify(drain)}`);
    expect(drain.heartbeatIds).toEqual([scenario.seed.source.heartbeatRunId]);
    expect(drain.evidenceIds).toHaveLength(1);

    const [mission] = await owned.db.select({ status: missions.status }).from(missions).where(and(
      eq(missions.companyId, scenario.seeded.companyId), eq(missions.id, scenario.seed.missionId),
    ));
    const [workflowRun] = await owned.db.select().from(workflowRuns).where(and(
      eq(workflowRuns.companyId, scenario.seeded.companyId), eq(workflowRuns.id, scenario.seed.workflowRunId),
    ));
    const terminalMission = new Set(["completed", "cancelled"]);
    const terminalRun = new Set(["completed", "cancelled", "aborted", "failed", "timed-out"]);
    const diagnostics = { companyId: scenario.seeded.companyId, missionId: scenario.seed.missionId,
      missionStatus: mission?.status ?? null, workflowRunId: scenario.seed.workflowRunId,
      workflowRunStatus: workflowRun?.status ?? null, sourceHeartbeatRunId: scenario.seed.source.heartbeatRunId,
      drainHeartbeatIds: drain.heartbeatIds, drainEvidenceIds: drain.evidenceIds };
    expect(mission && !terminalMission.has(mission.status), `source mission became terminal after actual drain: ${JSON.stringify(diagnostics)}`).toBe(true);
    expect(workflowRun && !terminalRun.has(workflowRun.status ?? ""), `source workflow run became terminal after actual drain: ${JSON.stringify(diagnostics)}`).toBe(true);
  }

  async function waitForObservedLockWait(target: string, delivery: Promise<Awaited<ReturnType<typeof deliverQualityIntent>>>): Promise<void> {
    const containsWait = async () => (await readFile(lockWaitMarker, "utf8")).split("\n").filter(Boolean)
      .some((line) => JSON.parse(line).target === target);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    const events = watch(lockWaitMarker, { signal: controller.signal });
    const waitForWaitEvent = async () => {
      if (await containsWait()) return;
      for await (const _event of events) if (await containsWait()) return;
      throw new Error(`native helper exited before reporting lock_wait for ${target}`);
    };
    try {
      const result = await Promise.race([
        waitForWaitEvent().then(() => ({ kind: "lock_wait" as const })),
        delivery.then((value) => ({ kind: "settled" as const, value }), (error: unknown) => ({ kind: "rejected" as const, error })),
      ]);
      if (result.kind === "settled") throw new Error(`delivery settled before native lock_wait for ${target}: ${JSON.stringify(result.value)}`);
      if (result.kind === "rejected") throw new Error(`delivery rejected before native lock_wait for ${target}: ${String(result.error)}`);
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`timed out waiting for the real native lock_wait event for ${target}`);
      throw error;
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }

  async function preparationRows(scenario: TestAction) {
    return owned.db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, scenario.seeded.companyId),
      eq(workflowTransitionEvents.workflowRunId, scenario.seed.workflowRunId),
      eq(workflowTransitionEvents.eventType, "qa_remediation_prepared"),
      sql`${workflowTransitionEvents.payload}->'qualityBinding'->>'actionId' = ${scenario.actionId}`,
    ));
  }

  async function completionRows(scenario: TestAction) {
    return owned.db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, scenario.seeded.companyId),
      eq(workflowTransitionEvents.workflowRunId, scenario.seed.workflowRunId),
      eq(workflowTransitionEvents.eventType, "qa_remediation_completed"),
    ));
  }

  async function readScopedFinalizationSnapshot(scenario: TestAction, wakeupRequestId: string, actualRunId: string,
    options: { includeTerminalSourceObservation?: boolean } = {}) {
    return owned.db.transaction(async (tx) => {
      const [company] = await tx.select({ id: companies.id }).from(companies)
        .where(eq(companies.id, scenario.seeded.companyId));
      const [mission] = await tx.select({ id: missions.id, status: missions.status, completedAt: missions.completedAt })
        .from(missions).where(and(eq(missions.companyId, scenario.seeded.companyId), eq(missions.id, scenario.seed.missionId)));
      const [workflow] = await tx.select({ id: workflowRuns.id, missionId: workflowRuns.missionId,
        status: workflowRuns.status, completedAt: workflowRuns.completedAt,
        dispatchAuthorityVersion: workflowRuns.dispatchAuthorityVersion,
        parentRunId: workflowRuns.parentRunId, parentStepRunId: workflowRuns.parentStepRunId,
        triggeredBy: workflowRuns.triggeredBy })
        .from(workflowRuns).where(and(eq(workflowRuns.companyId, scenario.seeded.companyId),
          eq(workflowRuns.id, scenario.seed.workflowRunId)));
      const issueColumns = { id: issues.id, status: issues.status, completedAt: issues.completedAt,
        missionId: issues.missionId,
        assigneeAgentId: issues.assigneeAgentId, assigneeUserId: issues.assigneeUserId,
        checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId,
        executionAgentNameKey: issues.executionAgentNameKey };
      const [producerIssue] = await tx.select(issueColumns).from(issues).where(and(
        eq(issues.companyId, scenario.seeded.companyId), eq(issues.id, scenario.seed.source.issueId)));
      const [qaIssue] = await tx.select(issueColumns).from(issues).where(and(
        eq(issues.companyId, scenario.seeded.companyId), eq(issues.id, scenario.seed.qaIssueId)));
      const steps = await tx.select({ id: workflowStepRuns.id, stepId: workflowStepRuns.stepId,
        issueId: workflowStepRuns.issueId, status: workflowStepRuns.status,
        executionGeneration: workflowStepRuns.executionGeneration, retryCount: workflowStepRuns.retryCount,
        iterationIndex: workflowStepRuns.iterationIndex,
        dispatchOwnerHeartbeatRunId: workflowStepRuns.dispatchOwnerHeartbeatRunId,
        dispatchOwnerWakeupRequestId: workflowStepRuns.dispatchOwnerWakeupRequestId })
        .from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, scenario.seed.workflowRunId));
      const qaWakes = await tx.select({ id: agentWakeupRequests.id, runId: agentWakeupRequests.runId,
        status: agentWakeupRequests.status, workflowExecutionGeneration: agentWakeupRequests.workflowExecutionGeneration })
        .from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, scenario.seeded.companyId),
          eq(agentWakeupRequests.issueId, scenario.seed.qaIssueId)));
      const [exactWake] = await tx.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, scenario.seeded.companyId), eq(agentWakeupRequests.id, wakeupRequestId)));
      const wakeAttempt = exactWake ? readWorkflowAttemptProof(exactWake) : null;
      const actuals = await tx.select({ id: heartbeatRuns.id, status: heartbeatRuns.status,
        wakeupRequestId: heartbeatRuns.wakeupRequestId, agentId: heartbeatRuns.agentId,
        issueId: heartbeatRuns.issueId, workflowStepRunId: heartbeatRuns.workflowStepRunId,
        workflowExecutionGeneration: heartbeatRuns.workflowExecutionGeneration,
        executionEpoch: heartbeatRuns.executionEpoch, executorOwnerId: heartbeatRuns.executorOwnerId,
        retryOfRunId: heartbeatRuns.retryOfRunId, resultJson: heartbeatRuns.resultJson })
        .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, scenario.seeded.companyId),
          eq(heartbeatRuns.wakeupRequestId, wakeupRequestId)));
      const passes = await tx.select({ id: workflowTransitionEvents.id, eventType: workflowTransitionEvents.eventType,
        verdict: workflowTransitionEvents.verdict, heartbeatRunId: workflowTransitionEvents.heartbeatRunId,
        wakeupRequestId: workflowTransitionEvents.wakeupRequestId,
        executionGeneration: workflowTransitionEvents.executionGeneration,
        idempotencyKey: workflowTransitionEvents.idempotencyKey })
        .from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.companyId, scenario.seeded.companyId),
          eq(workflowTransitionEvents.workflowRunId, scenario.seed.workflowRunId),
          eq(workflowTransitionEvents.workflowStepRunId, scenario.seed.qaStepRunId),
          eq(workflowTransitionEvents.heartbeatRunId, actualRunId),
          eq(workflowTransitionEvents.wakeupRequestId, wakeupRequestId),
          eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
          eq(workflowTransitionEvents.verdict, "pass")));
      const preparations = await tx.select({ id: workflowTransitionEvents.id, payload: workflowTransitionEvents.payload })
        .from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.companyId, scenario.seeded.companyId),
          eq(workflowTransitionEvents.workflowRunId, scenario.seed.workflowRunId),
          eq(workflowTransitionEvents.eventType, "qa_remediation_prepared"),
          sql`${workflowTransitionEvents.payload}->'qualityBinding'->>'actionId' = ${scenario.actionId}`));
      const completions = await tx.select({ id: workflowTransitionEvents.id, payload: workflowTransitionEvents.payload })
        .from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.companyId, scenario.seeded.companyId),
          eq(workflowTransitionEvents.workflowRunId, scenario.seed.workflowRunId),
          eq(workflowTransitionEvents.eventType, "qa_remediation_completed")));
      const [action] = await tx.select({ id: qualityActions.id, state: qualityActions.state })
        .from(qualityActions).where(and(eq(qualityActions.companyId, scenario.seeded.companyId),
          eq(qualityActions.id, scenario.actionId)));
      const observations = await tx.select({ id: qualityEvidenceRefs.id,
        qualityContract: qualityEvidenceRefs.qualityContract }).from(qualityEvidenceRefs).where(and(
        eq(qualityEvidenceRefs.companyId, scenario.seeded.companyId),
        eq(qualityEvidenceRefs.qualityActionId, scenario.actionId),
        sql`${qualityEvidenceRefs.qualityContract}->>'kind' = 'observation'`));
      const continuationRows = await tx.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents)
        .where(and(eq(workflowTransitionEvents.companyId, scenario.seeded.companyId),
          eq(workflowTransitionEvents.heartbeatRunId, actualRunId),
          eq(workflowTransitionEvents.eventType, TERMINAL_RELEASE_EVENT_TYPE)));
      const continuationId = continuationRows.length === 1 ? continuationRows[0]!.id : null;
      const continuation = continuationId ? await readTerminalReleaseManifest(tx, continuationId) : null;
      const readiness = continuationId ? await readReadyTerminalReleaseContinuation(tx, continuationId) : null;
      const acknowledgments = continuation?.kind === "found"
        ? await Promise.all(continuation.manifest.obligations.map(async obligation => ({
          effectKey: obligation.effectKey,
          state: await readTerminalReleaseAcknowledgment(tx, continuationId!, obligation.effectKey),
        })))
        : [];
      let terminalSourceObservation: Record<string, unknown> | null = null;
      if (options.includeTerminalSourceObservation) {
        const source = continuation?.kind === "found" ? continuation.manifest.source : null;
        const [sourceRun] = source ? await tx.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.id, source.heartbeatRunId), eq(heartbeatRuns.companyId, source.companyId))) : [];
        const [sourceWorkflow] = source ? await tx.select({ id: workflowRuns.id, missionId: workflowRuns.missionId,
          status: workflowRuns.status, dispatchAuthorityVersion: workflowRuns.dispatchAuthorityVersion,
          parentRunId: workflowRuns.parentRunId, parentStepRunId: workflowRuns.parentStepRunId,
          triggeredBy: workflowRuns.triggeredBy }).from(workflowRuns).where(and(
          eq(workflowRuns.id, source.workflowRunId), eq(workflowRuns.companyId, source.companyId))) : [];
        const [sourceStep] = source ? await tx.select({ id: workflowStepRuns.id, stepId: workflowStepRuns.stepId,
          issueId: workflowStepRuns.issueId, status: workflowStepRuns.status,
          executionGeneration: workflowStepRuns.executionGeneration, retryCount: workflowStepRuns.retryCount,
          iterationIndex: workflowStepRuns.iterationIndex,
          dispatchOwnerHeartbeatRunId: workflowStepRuns.dispatchOwnerHeartbeatRunId,
          dispatchOwnerWakeupRequestId: workflowStepRuns.dispatchOwnerWakeupRequestId })
          .from(workflowStepRuns).where(and(eq(workflowStepRuns.id, source.workflowStepRunId),
            eq(workflowStepRuns.workflowRunId, source.workflowRunId))) : [];
        const [sourceWake] = source ? await tx.select().from(agentWakeupRequests).where(and(
          eq(agentWakeupRequests.id, source.wakeupRequestId), eq(agentWakeupRequests.companyId, source.companyId))) : [];
        const [sourceIssue] = source ? await tx.select({ id: issues.id, missionId: issues.missionId, status: issues.status })
          .from(issues).where(and(eq(issues.id, source.issueId), eq(issues.companyId, source.companyId))) : [];
        const linkedInvocations = source ? await tx.select({ id: workflowStepInvocations.id })
          .from(workflowStepInvocations).where(eq(workflowStepInvocations.childRunId, source.workflowRunId)).limit(2) : [];
        const [settingsRow] = await tx.select({ experimental: instanceSettings.experimental }).from(instanceSettings)
          .where(eq(instanceSettings.singletonKey, "default"));
        const experimental = isRecord(settingsRow?.experimental) ? settingsRow.experimental : {};
        const sourceWakeProof = sourceWake ? readWorkflowAttemptProof(sourceWake) : null;
        const sourceAttempt = sourceWakeProof ? { companyId: sourceWakeProof.companyId,
          missionId: sourceWakeProof.missionId, workflowRunId: sourceWakeProof.workflowRunId,
          stepRunId: sourceWakeProof.stepRunId, executionGeneration: sourceWakeProof.executionGeneration,
          retryCount: sourceWakeProof.retryCount, iterationIndex: sourceWakeProof.iterationIndex,
          parentHeartbeatRunId: sourceWakeProof.parentHeartbeatRunId } : null;
        const checks = {
          runPresent: Boolean(sourceRun),
          workflowPresent: Boolean(sourceWorkflow),
          stepPresent: Boolean(sourceStep),
          wakePresent: Boolean(sourceWake),
          issuePresent: Boolean(sourceIssue),
          actualMatchesManifest: Boolean(source && sourceRun && terminalReleaseMatchesRun(source, sourceRun)),
          workflowMissionMatchesManifest: Boolean(source && sourceWorkflow?.missionId === source.missionId),
          workflowAuthorityMatchesManifest: Boolean(source
            && sourceWorkflow?.dispatchAuthorityVersion === source.dispatchAuthorityVersion),
          workflowStatusAllowed: Boolean(sourceWorkflow && ["running", "completed"].includes(sourceWorkflow.status)),
          stepIdMatchesManifest: Boolean(source && sourceStep?.stepId === source.stepId),
          stepIssueMatchesManifest: Boolean(source && sourceStep?.issueId === source.issueId),
          stepRetryCountMatchesManifest: Boolean(source && sourceStep?.retryCount === source.retryCount),
          stepIterationIndexMatchesManifest: Boolean(source && sourceStep?.iterationIndex === source.iterationIndex),
          stepGenerationMatchesManifest: Boolean(source && sourceStep?.executionGeneration === source.executionGeneration),
          stepDispatchOwnerHeartbeatMatchesManifest: Boolean(source
            && sourceStep?.dispatchOwnerHeartbeatRunId === source.heartbeatRunId),
          stepDispatchOwnerWakeMatchesManifest: Boolean(source
            && sourceStep?.dispatchOwnerWakeupRequestId === source.wakeupRequestId),
          issueMissionMatchesManifest: Boolean(source && sourceIssue?.missionId === source.missionId),
          wakeRunMatchesManifest: Boolean(source && sourceWake?.runId === source.heartbeatRunId),
          wakeAgentMatchesManifest: Boolean(source && sourceWake?.agentId === source.agentId),
          wakeIssueMatchesManifest: Boolean(source && sourceWake?.issueId === source.issueId),
          wakeMissionMatchesManifest: Boolean(source && sourceWake?.missionId === source.missionId),
          wakeWorkflowRunMatchesManifest: Boolean(source && sourceWake?.workflowRunId === source.workflowRunId),
          wakeWorkflowStepMatchesManifest: Boolean(source && sourceWake?.workflowStepRunId === source.workflowStepRunId),
          wakeGenerationMatchesManifest: Boolean(source
            && sourceWake?.workflowExecutionGeneration === source.executionGeneration),
          wakeStatusIsNotCoalesced: Boolean(sourceWake && sourceWake.status !== "coalesced"),
          actualStatusIsTerminal: Boolean(sourceRun
            && ["succeeded", "failed", "timed_out", "cancelled"].includes(sourceRun.status)),
        };
        terminalSourceObservation = {
          manifestSource: source,
          workflow: sourceWorkflow ? { id: sourceWorkflow.id, status: sourceWorkflow.status,
            dispatchAuthorityVersion: sourceWorkflow.dispatchAuthorityVersion,
            parentRunId: sourceWorkflow.parentRunId, parentStepRunId: sourceWorkflow.parentStepRunId,
            triggeredBy: sourceWorkflow.triggeredBy } : null,
          qaIssue: sourceIssue ?? null,
          step: sourceStep ?? null,
          wake: sourceWake ? { id: sourceWake.id, status: sourceWake.status, runId: sourceWake.runId,
            agentId: sourceWake.agentId, issueId: sourceWake.issueId, missionId: sourceWake.missionId,
            workflowRunId: sourceWake.workflowRunId, workflowStepRunId: sourceWake.workflowStepRunId,
            workflowExecutionGeneration: sourceWake.workflowExecutionGeneration, attempt: sourceAttempt } : null,
          actual: sourceRun ? { id: sourceRun.id, status: sourceRun.status, companyId: sourceRun.companyId,
            agentId: sourceRun.agentId, issueId: sourceRun.issueId, wakeupRequestId: sourceRun.wakeupRequestId,
            workflowStepRunId: sourceRun.workflowStepRunId,
            workflowExecutionGeneration: sourceRun.workflowExecutionGeneration,
            executionScopeKind: sourceRun.executionScopeKind, executionEpoch: sourceRun.executionEpoch,
            executorOwnerId: sourceRun.executorOwnerId, executorOwnerLeaseEpoch: sourceRun.executorOwnerLeaseEpoch,
            retryOfRunId: sourceRun.retryOfRunId, processLossRetryCount: sourceRun.processLossRetryCount } : null,
          actualMatchesRun: checks.actualMatchesManifest,
          checks,
          readiness,
          runIsPlainUnlinked: Boolean(sourceWorkflow && sourceWorkflow.triggeredBy !== "workflow-step"
            && sourceWorkflow.parentRunId === null && sourceWorkflow.parentStepRunId === null
            && linkedInvocations.length === 0),
          linkedInvocationCount: linkedInvocations.length,
          experimentalFlags: {
            settingsRowPresent: Boolean(settingsRow),
            enableRunReopenGuardV1: experimental.enableRunReopenGuardV1 === true,
            enableRunTerminalBoundaryV1: experimental.enableRunTerminalBoundaryV1 === true,
          },
        };
      }
      const payloadHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
      const attempt = wakeAttempt ? { companyId: wakeAttempt.companyId, missionId: wakeAttempt.missionId,
        workflowRunId: wakeAttempt.workflowRunId, stepRunId: wakeAttempt.stepRunId,
        executionGeneration: wakeAttempt.executionGeneration, retryCount: wakeAttempt.retryCount,
        iterationIndex: wakeAttempt.iterationIndex, parentHeartbeatRunId: wakeAttempt.parentHeartbeatRunId } : null;
      return {
        company: company ? { id: company.id } : null,
        mission: mission ?? null,
        workflow: workflow ?? null,
        issues: { producer: producerIssue ?? null, qa: qaIssue ?? null },
        steps,
        qaWakes,
        exactWake: exactWake ? { id: exactWake.id, status: exactWake.status, runId: exactWake.runId,
          agentId: exactWake.agentId, issueId: exactWake.issueId, missionId: exactWake.missionId,
          workflowRunId: exactWake.workflowRunId, workflowStepRunId: exactWake.workflowStepRunId,
          workflowExecutionGeneration: exactWake.workflowExecutionGeneration, attempt } : null,
        actuals: actuals.map(({ resultJson, ...actual }) => ({ ...actual, resultSha256: payloadHash(resultJson) })),
        passes,
        preparations: preparations.map(row => ({ id: row.id, schemaVersion: isRecord(row.payload) ? row.payload.schemaVersion : null,
          payloadSha256: payloadHash(row.payload) })),
        completions: completions.map(row => ({ id: row.id, schemaVersion: isRecord(row.payload) ? row.payload.schemaVersion : null,
          payloadSha256: payloadHash(row.payload) })),
        action: action ?? null,
        observations: observations.map(row => ({ id: row.id,
          contractSha256: payloadHash(row.qualityContract) })),
        continuation: { eventIds: continuationRows.map(row => row.id),
          manifest: continuation?.kind === "found" ? { source: {
            companyId: continuation.manifest.source.companyId, missionId: continuation.manifest.source.missionId,
            workflowRunId: continuation.manifest.source.workflowRunId,
            dispatchAuthorityVersion: continuation.manifest.source.dispatchAuthorityVersion,
            workflowStepRunId: continuation.manifest.source.workflowStepRunId,
            issueId: continuation.manifest.source.issueId, heartbeatRunId: continuation.manifest.source.heartbeatRunId,
            wakeupRequestId: continuation.manifest.source.wakeupRequestId,
            executionGeneration: continuation.manifest.source.executionGeneration,
            retryCount: continuation.manifest.source.retryCount, iterationIndex: continuation.manifest.source.iterationIndex,
            executorOwnerId: continuation.manifest.source.executorOwnerId,
            ownerLeaseEpoch: continuation.manifest.source.ownerLeaseEpoch,
          }, obligations: continuation.manifest.obligations.map(item => ({ effectKey: item.effectKey, action: item.action })) }
            : continuation,
          readiness, acknowledgments },
        ...(terminalSourceObservation ? { terminalSourceObservation } : {}),
      };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  async function waitForTerminalObligationAcks(eventId: string, obligations: readonly { effectKey: string }[]) {
    const timeoutMs = 60_000, deadline = Date.now() + timeoutMs;
    while (true) {
      const states = await Promise.all(obligations.map(item => readTerminalReleaseAcknowledgment(owned.db, eventId, item.effectKey)));
      if (states.every(state => state.kind === "acknowledged")) return;
      const held = states.find(state => state.kind === "held");
      if (held?.kind === "held") throw new Error(`terminal continuation acknowledgement is malformed: ${held.reason}`);
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error(`timed out waiting for exact terminal continuation acknowledgements ${eventId}`);
      await new Promise(resolve => setTimeout(resolve, Math.min(20, remainingMs)));
    }
  }

  async function useRows(scenario: TestAction) {
    return owned.db.select().from(qualityEvidenceRefs).where(and(
      eq(qualityEvidenceRefs.companyId, scenario.seeded.companyId),
      eq(qualityEvidenceRefs.qualityActionId, scenario.actionId),
      sql`${qualityEvidenceRefs.qualityContract}->>'kind' = 'use'`,
    ));
  }

  async function qualityWakes(scenario: TestAction) {
    return owned.db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, scenario.seeded.companyId),
      like(agentWakeupRequests.idempotencyKey, `quality-action-wake:${scenario.actionId}:%`),
    ));
  }

  async function consumeAndSubmitOfficialPass(scenario: TestAction, wakeupRequestId: string,
    frozenVerifier?: SetupActualDrain) {
    const completions = await completionRows(scenario);
    expect(completions).toHaveLength(1);
    const completion = parseQaRemediationCompletion(completions[0]!.payload);
    expect(completion.wakes).toHaveLength(1);
    const canonical = completion.wakes.filter(wake => wake.wakeupRequestId === wakeupRequestId);
    expect(canonical).toHaveLength(1);
    expect(canonical[0]).toMatchObject({ kind: "v2_refire", issueId: scenario.seed.qaIssueId, stepRunId: scenario.seed.qaStepRunId });
    const preparation = parseQaRemediationPreparation((await preparationRows(scenario))[0]!.payload);
    const frozenQa = preparation.verdicts.find(verdict => verdict.qa.stepRunId === scenario.seed.qaStepRunId);
    expect(frozenQa).toBeDefined();
    const timeoutMs = 60_000, deadline = Date.now() + timeoutMs;
    const startedPath = verifierStartedPath(scenario);
    let run: typeof heartbeatRuns.$inferSelect | undefined;
    let exactDrain: SetupActualDrain | null = null;
    while (!exactDrain) {
      const wakes = await owned.db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, scenario.seeded.companyId), eq(agentWakeupRequests.id, wakeupRequestId),
      ));
      if (wakes.length > 1) throw new Error(`ambiguous canonical verifier wake ${wakeupRequestId}`);
      const wake = wakes[0];
      if (wake) {
        if (wake.companyId !== scenario.seeded.companyId || wake.agentId !== scenario.seed.verifierAgentId
          || wake.missionId !== scenario.seed.missionId || wake.workflowRunId !== scenario.seed.workflowRunId
          || wake.issueId !== scenario.seed.qaIssueId || wake.workflowStepRunId !== scenario.seed.qaStepRunId
          || wake.workflowExecutionGeneration !== canonical[0]!.executionGeneration || wake.runId === null) {
          throw new Error(`canonical verifier wake scope or reciprocal run link is unproven: ${wakeupRequestId}`);
        }
        const proof = readWorkflowAttemptProof(wake);
        if (proof.retryCount !== frozenQa!.qa.retryCount || proof.iterationIndex !== frozenQa!.qa.iterationIndex
          || proof.workflowRunId !== scenario.seed.workflowRunId || proof.stepRunId !== scenario.seed.qaStepRunId
          || proof.executionGeneration !== frozenQa!.qa.executionGeneration) {
          throw new Error(`canonical verifier attempt differs from preparation: ${wakeupRequestId}`);
        }
        const runs = await owned.db.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.companyId, scenario.seeded.companyId), eq(heartbeatRuns.id, wake.runId),
        ));
        if (runs.length > 1) throw new Error(`ambiguous canonical verifier run ${wake.runId}`);
        run = runs[0];
        if (run && (run.wakeupRequestId !== wake.id || run.agentId !== scenario.seed.verifierAgentId
          || run.issueId !== scenario.seed.qaIssueId || run.workflowStepRunId !== scenario.seed.qaStepRunId
          || run.workflowExecutionGeneration !== wake.workflowExecutionGeneration || run.retryOfRunId !== proof.parentHeartbeatRunId
          || run.executionEpoch === null)) throw new Error(`canonical verifier run identity changed: ${run.id}`);
        if (frozenVerifier) {
          if (frozenVerifier.label !== "verifier" || frozenVerifier.identity.heartbeatRunId !== run?.id
            || frozenVerifier.identity.wakeupRequestId !== wake.id) throw new Error("pre-frozen verifier proof does not belong to exact E actual");
          exactDrain = frozenVerifier;
        } else if (run?.status === "running") {
          await waitForMarker(startedPath, "exact E verifier process");
          try {
            exactDrain = await captureSetupActualDrain(scenario, "verifier", run.id, scenario.seed.qaStepRunId,
              scenario.seed.qaIssueId, scenario.seed.verifierAgentId);
          } catch (error) {
            const [afterFreezeAttempt] = await owned.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
            if (!afterFreezeAttempt || !["succeeded", "failed", "timed_out", "cancelled"].includes(afterFreezeAttempt.status)) throw error;
            exactDrain = await deriveVerifierReceipt(scenario, wake, afterFreezeAttempt);
          }
          if (exactDrain.identity.retryCount !== proof.retryCount || exactDrain.identity.iterationIndex !== proof.iterationIndex) {
            throw new Error(`frozen E verifier attempt differs from reserved wake proof: ${run.id}`);
          }
        } else if (run && ["succeeded", "failed", "timed_out", "cancelled"].includes(run.status)) {
          exactDrain = await deriveVerifierReceipt(scenario, wake, run);
        }
      }
      if (exactDrain) break;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error(`timed out waiting for exact E actual-drain receipt ${wakeupRequestId} after ${timeoutMs}ms`);
      await new Promise(resolve => setTimeout(resolve, Math.min(20, remainingMs)));
    }
    const receiptDeadline = Date.now() + timeoutMs;
    while (!(await hasExactSetupActualDrain(exactDrain))) {
      const remainingMs = receiptDeadline - Date.now();
      if (remainingMs <= 0) throw new Error(`timed out waiting for exact E actual-drain receipt ${wakeupRequestId} after ${timeoutMs}ms`);
      await new Promise(resolve => setTimeout(resolve, Math.min(20, remainingMs)));
    }
    const [durableRun] = await owned.db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, scenario.seeded.companyId), eq(heartbeatRuns.id, exactDrain.identity.heartbeatRunId),
      eq(heartbeatRuns.wakeupRequestId, wakeupRequestId),
    ));
    run = durableRun;
    expect(run).toMatchObject({ wakeupRequestId, agentId: scenario.seed.verifierAgentId,
      issueId: scenario.seed.qaIssueId, workflowStepRunId: scenario.seed.qaStepRunId, status: "succeeded" });
    const stdout = (run!.resultJson as { stdout: string }).stdout;
    const output = JSON.parse(stdout) as { verdict: string; observed: string[] };
    expect(output).toEqual({ verdict: "pass", observed: scenario.files.map((file) => file.after) });
    const [issue] = await owned.db.select().from(issues).where(eq(issues.id, scenario.seed.qaIssueId));
    await submitWorkflowVerdict({ db: owned.db, issue: issue!, actor: {
      actorType: "agent", actorId: scenario.seed.verifierAgentId, agentId: scenario.seed.verifierAgentId, runId: run!.id,
    }, data: { verdict: "pass" } });
    return run!;
  }

  async function addIndependentObservation(scenario: TestAction, verifier: typeof heartbeatRuns.$inferSelect) {
    const [use] = await useRows(scenario);
    expect(use).toBeDefined();
    const uploaded = await uploadEvidence(getStorageService(), {
      companyId: scenario.seeded.companyId,
      body: Buffer.from(JSON.stringify({ verdict: "pass", wakeupRequestId: verifier.wakeupRequestId })),
      contentType: "application/json", originalFilename: "f1-verification.json",
    });
    await owned.db.transaction((tx) => linkEvidence(tx, {
      companyId: scenario.seeded.companyId, reviewItemId: use!.reviewItemId, source: scenario.seed.source,
      scope: { kind: "output_correction", companyId: scenario.seeded.companyId, actionId: scenario.actionId,
        source: scenario.seed.source, verifierRunId: verifier.id, verifierEpoch: verifier.executionEpoch! },
      kind: "observation", uploaded, expiresAt: null, issuedBy: "quality:f1-test",
    }));
  }

  it("waits on the exact native target while unrelated QA progresses, then reuses E's wake and official verdict", async () => {
    const targetSeedTraceId = randomUUID();
    const target = await traceStage("seed-target", { traceId: targetSeedTraceId },
      () => seedCurrentOutputAction(1, true), scenario => scenarioTraceIds("target", scenario));
    const unrelatedSeedTraceId = randomUUID();
    const unrelated = await traceStage("seed-unrelated", { traceId: unrelatedSeedTraceId },
      () => seedCurrentOutputAction(), scenario => scenarioTraceIds("unrelated", scenario));
    await traceStage("assert-target-setup", scenarioTraceIds("target", target), () => assertCurrentOutputSetup(target));
    await traceStage("assert-unrelated-setup", scenarioTraceIds("unrelated", unrelated), () => assertCurrentOutputSetup(unrelated));
    finalCleanupScope = { scenarios: [scenarioTraceIds("target", target), scenarioTraceIds("unrelated", unrelated)] };
    const targetVerifierStarted = path.join(home, "e-verifier-started", target.actionId);
    const targetVerifierRelease = path.join(home, "e-verifier-release", target.actionId);
    await useHeldProcessVerifier(target, targetVerifierStarted, targetVerifierRelease);
    await useProcessVerifier(unrelated);
    const targetGuardStats = await Promise.all(target.files.map((file) => stat(file.file)));
    let originalProducer: typeof heartbeatRuns.$inferSelect | undefined;
    let originalInitialQa: typeof heartbeatRuns.$inferSelect | undefined;
    const holder = await createQaFileOwnerRuntime({ qaFileOwnerLockRoot: lockRoot, qaFileOwnerPython: PYTHON! })
      .begin(target.files.map((file) => file.file));
    const deliveryPromise = deliverQualityIntent(owned.db, { companyId: target.seeded.companyId, actionId: target.actionId });
    let unrelatedHolder: Awaited<ReturnType<ReturnType<typeof createQaFileOwnerRuntime>["begin"]>> | undefined;
    let unrelatedHolderClosed = false;
    let targetHolderClosed = false;
    let targetSetupProofs: SetupActualDrain[] = [];
    let unrelatedDelivery: Promise<Awaited<ReturnType<typeof deliverQualityIntent>>> | undefined;
    let targetDeliveryResult: Awaited<ReturnType<typeof deliverQualityIntent>> | undefined;
    let firstFailure: unknown;
    let hasFailure = false;
    try {
      await traceStage("target-native-wait", scenarioTraceIds("target", target),
        () => waitForObservedLockWait(target.files[0]!.file, deliveryPromise));
      const targetPreparations = await preparationRows(target);
      expect(targetPreparations).toHaveLength(1);
      const targetPreparation = parseQaRemediationPreparation(targetPreparations[0]!.payload);
      expect(targetPreparation.schemaVersion).toBe(QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3);
      expect(targetPreparation.qualityBinding.canonicalBinding).toEqual(target.binding);
      expect(await readFile(target.files[0]!.file, "utf8")).toBe(target.files[0]!.before);
      const lockedStats = await Promise.all(target.files.map((file) => stat(file.file)));
      expect(lockedStats.map(({ dev, ino, size }) => ({ dev, ino, size })))
        .toEqual(targetGuardStats.map(({ dev, ino, size }) => ({ dev, ino, size })));
      expect(await completionRows(target)).toHaveLength(0);
      targetSetupProofs = await traceStage("target-setup-release", scenarioTraceIds("target", target),
        () => releaseSetupActuals(target));
      await assertCurrentOutputSourceDrain(target, targetPreparation);
      await assertCurrentOutputSetup(target, false);
      [originalProducer] = await owned.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, target.seed.source.heartbeatRunId));
      [originalInitialQa] = await owned.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, target.seed.verdictHeartbeatId));
      expect(originalProducer).toBeDefined();
      expect(originalInitialQa).toBeDefined();

      // F is at the real flock wait; this separate action uses another file and still completes actual QA.
      await traceStage("unrelated-progress", { scenarios: [scenarioTraceIds("target", target), scenarioTraceIds("unrelated", unrelated)] }, async () => {
        unrelatedHolder = await createQaFileOwnerRuntime({ qaFileOwnerLockRoot: lockRoot, qaFileOwnerPython: PYTHON! })
          .begin(unrelated.files.map((file) => file.file));
        unrelatedDelivery = deliverQualityIntent(owned.db, {
          companyId: unrelated.seeded.companyId, actionId: unrelated.actionId,
        });
        await traceStage("unrelated-native-wait", scenarioTraceIds("unrelated", unrelated),
          () => waitForObservedLockWait(unrelated.files[0]!.file, unrelatedDelivery!));
        expect(await preparationRows(unrelated)).toHaveLength(1);
        await traceStage("unrelated-setup-release", scenarioTraceIds("unrelated", unrelated), () => releaseSetupActuals(unrelated));
        await unrelatedHolder.close();
        unrelatedHolderClosed = true;
        const unrelatedResult = await unrelatedDelivery;
        expect(unrelatedResult).toMatchObject({ status: "accepted", receiptId: expect.any(String) });
        const unrelatedWake = (await completionRows(unrelated))[0];
        expect(unrelatedWake).toBeDefined();
        const unrelatedCompletion = parseQaRemediationCompletion(unrelatedWake!.payload);
        const unrelatedRun = await consumeAndSubmitOfficialPass(unrelated, unrelatedCompletion.wakes[0]!.wakeupRequestId);
        expect(unrelatedRun.status).toBe("succeeded");
        expect(await deliverQualityIntent(owned.db, { companyId: unrelated.seeded.companyId, actionId: unrelated.actionId }))
          .toEqual({ status: "accepted", receiptId: unrelatedCompletion.wakes[0]!.wakeupRequestId });
        expect(await readFile(target.files[0]!.file, "utf8")).toBe(target.files[0]!.before);
        expect(await completionRows(target)).toHaveLength(0);
      });
    } catch (error) {
      firstFailure = error;
      hasFailure = true;
    }

    try {
      await traceStage("setup-cleanup", { scenarios: [scenarioTraceIds("target", target), scenarioTraceIds("unrelated", unrelated)] }, async () => {
        const failures: unknown[] = [];
        const setupGatePaths = [target.producerReleasePath, target.qaReleasePath,
          unrelated.producerReleasePath, unrelated.qaReleasePath];
        const gateResults = await Promise.allSettled(setupGatePaths.map(async releasePath => {
          await writeFile(releasePath, "release");
          pendingGatePaths.delete(releasePath);
        }));
        for (const result of gateResults) if (result.status === "rejected") failures.push(result.reason);

        const closeTasks: (() => Promise<void>)[] = [];
        if (!unrelatedHolderClosed && unrelatedHolder) closeTasks.push(async () => {
          await unrelatedHolder!.close();
          unrelatedHolderClosed = true;
        });
        closeTasks.push(async () => {
          if (!targetHolderClosed) {
            await holder.close();
            targetHolderClosed = true;
          }
        });
        const closeResults = await Promise.allSettled(closeTasks.map(close => close()));
        for (const result of closeResults) if (result.status === "rejected") failures.push(result.reason);

        if (failures.length === 0) {
          const pendingDeliveries = await Promise.allSettled([deliveryPromise, ...(unrelatedDelivery ? [unrelatedDelivery] : [])]);
          const targetResult = pendingDeliveries[0]!;
          if (targetResult.status === "fulfilled") targetDeliveryResult = targetResult.value;
          else if (!hasFailure) failures.push(targetResult.reason);
          for (const result of pendingDeliveries.slice(1)) {
            if (result.status === "rejected" && !hasFailure) failures.push(result.reason);
          }
        }
        if (failures.length) throw failures[0];
        return { setupGatesSignalled: setupGatePaths.length, nativeHoldersReleased: closeTasks.length };
      });
    } catch (error) {
      if (!hasFailure) { firstFailure = error; hasFailure = true; }
    }
    if (hasFailure) throw firstFailure;
    expect(targetHolderClosed, "target native file-owner holder must be closed before original receipt recheck").toBe(true);
    const closedHolderDrainDiagnostics = await Promise.all(targetSetupProofs.map(setupActualDrainDiagnostic));
    expect(closedHolderDrainDiagnostics.map(item => item.state)).toEqual(["found", "found"]);

    let targetActualForComparison: typeof heartbeatRuns.$inferSelect | undefined;

    await traceStage("target-final-completion", scenarioTraceIds("target", target), async () => {
    const result = targetDeliveryResult ?? await deliveryPromise;
    expect(result.status).toBe("accepted");
    expect(await readFile(target.files[0]!.file, "utf8")).toBe(target.files[0]!.after);
    const [completionRow] = await completionRows(target);
    expect(completionRow).toBeDefined();
    const completion = parseQaRemediationCompletion(completionRow!.payload);
    expect(completion.schemaVersion).toBe("workflow.qa-remediation.complete.v3");
    expect(completion.qualityUseEvidenceRefId).toBeTruthy();
    expect(completion.wakes).toHaveLength(1);
    const exactWake = completion.wakes[0]!;
    expect(result.receiptId).toBe(exactWake.wakeupRequestId);
    expect(exactWake).toMatchObject({ kind: "v2_refire", issueId: target.seed.qaIssueId, stepRunId: target.seed.qaStepRunId });
    const [exactWakeRow] = await owned.db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, target.seeded.companyId), eq(agentWakeupRequests.id, exactWake.wakeupRequestId)));
    expect(exactWakeRow).toBeDefined();
    expect(exactWakeRow).toMatchObject({ requestKind: "workflow_resume", companyId: target.seeded.companyId,
      missionId: target.seed.missionId, workflowRunId: target.seed.workflowRunId,
      issueId: target.seed.qaIssueId, workflowStepRunId: target.seed.qaStepRunId,
      workflowExecutionGeneration: exactWake.executionGeneration, agentId: exactWake.agentId,
      idempotencyKey: exactWake.idempotencyKey });
    await waitForMarker(targetVerifierStarted, "held E QA process");
    const [targetActualBeforePass] = await owned.db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, target.seeded.companyId), eq(heartbeatRuns.wakeupRequestId, exactWake.wakeupRequestId)));
    expect(targetActualBeforePass).toBeDefined();
    expect(targetActualBeforePass).toMatchObject({ status: "running", wakeupRequestId: exactWake.wakeupRequestId,
      companyId: target.seeded.companyId, agentId: exactWake.agentId, issueId: target.seed.qaIssueId,
      workflowStepRunId: target.seed.qaStepRunId, workflowExecutionGeneration: exactWake.executionGeneration });
    expect(targetActualBeforePass!.executionEpoch).toEqual(expect.any(Number));
    expect(targetActualBeforePass!.startedAt!.getTime()).toBeGreaterThanOrEqual(exactWakeRow!.requestedAt.getTime());
    expect(exactWakeRow!.runId).toBe(targetActualBeforePass!.id);
    expect(targetActualBeforePass!.wakeupRequestId).toBe(exactWakeRow!.id);
    const frozenQa = parseQaRemediationPreparation((await preparationRows(target))[0]!.payload).verdicts
      .find((verdict) => verdict.qa.stepRunId === target.seed.qaStepRunId)!;
    expect(readWorkflowAttemptProof(exactWakeRow!)).toMatchObject({
      companyId: target.seeded.companyId, agentId: exactWake.agentId, issueId: target.seed.qaIssueId,
      missionId: target.seed.missionId, workflowRunId: target.seed.workflowRunId,
      stepRunId: target.seed.qaStepRunId, executionGeneration: frozenQa.qa.executionGeneration,
      retryCount: frozenQa.qa.retryCount, iterationIndex: frozenQa.qa.iterationIndex,
      wakeupRequestId: exactWake.wakeupRequestId, parentHeartbeatRunId: targetActualBeforePass!.retryOfRunId,
    });
    const targetVerifierDrain = await captureSetupActualDrain(target, "verifier", targetActualBeforePass!.id,
      target.seed.qaStepRunId, target.seed.qaIssueId, target.seed.verifierAgentId);
    expect(targetVerifierDrain.identity).toMatchObject({ wakeupRequestId: exactWake.wakeupRequestId,
      executionGeneration: exactWake.executionGeneration, retryCount: frozenQa.qa.retryCount,
      iterationIndex: frozenQa.qa.iterationIndex, executionEpoch: targetActualBeforePass!.executionEpoch });
    const [heldQaIssue] = await owned.db.select().from(issues).where(and(
      eq(issues.companyId, target.seeded.companyId), eq(issues.id, target.seed.qaIssueId)));
    expect(heldQaIssue!.executionRunId).toBe(targetActualBeforePass!.id);
    const originalWakePayload = structuredClone(exactWakeRow!.payload) as Record<string, unknown>;
    const officialPassRowsForHeldActual = () => owned.db.select({ id: workflowTransitionEvents.id })
      .from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.companyId, target.seeded.companyId),
        eq(workflowTransitionEvents.heartbeatRunId, targetActualBeforePass!.id),
        eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
        eq(workflowTransitionEvents.verdict, "pass")));
    const expectRejectedEWriterProbe = async (issue = heldQaIssue!) => {
      await expect(owned.db.transaction(async tx => {
        await recordWorkflowValidationVerdict({ db: tx as Parameters<typeof recordWorkflowValidationVerdict>[0]["db"],
          issue, source: "workflow_api", verdict: "pass",
          actorAgentId: target.seed.verifierAgentId, heartbeatRunId: targetActualBeforePass!.id });
        throw new Error("unexpected_ordinary_verdict_fallback");
      })).rejects.toThrow("workflow_validation_attempt_unproven");
      expect(await officialPassRowsForHeldActual()).toHaveLength(0);
      const actuals = await owned.db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status,
        wakeupRequestId: heartbeatRuns.wakeupRequestId, workflowStepRunId: heartbeatRuns.workflowStepRunId,
        workflowExecutionGeneration: heartbeatRuns.workflowExecutionGeneration, retryOfRunId: heartbeatRuns.retryOfRunId,
        executorOwnerId: heartbeatRuns.executorOwnerId, executorOwnerLeaseEpoch: heartbeatRuns.executorOwnerLeaseEpoch,
        startedAt: heartbeatRuns.startedAt, resultJson: heartbeatRuns.resultJson }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, target.seeded.companyId),
        eq(heartbeatRuns.wakeupRequestId, exactWake.wakeupRequestId)));
      expect(actuals).toEqual([expect.objectContaining({ id: targetActualBeforePass!.id, status: "running",
        wakeupRequestId: exactWake.wakeupRequestId, workflowStepRunId: target.seed.qaStepRunId,
        workflowExecutionGeneration: exactWake.executionGeneration, retryOfRunId: targetActualBeforePass!.retryOfRunId,
        executorOwnerId: targetActualBeforePass!.executorOwnerId,
        executorOwnerLeaseEpoch: targetActualBeforePass!.executorOwnerLeaseEpoch,
        startedAt: targetActualBeforePass!.startedAt, resultJson: targetActualBeforePass!.resultJson })]);
    };
    await expectRejectedEWriterProbe({ ...heldQaIssue!, id: randomUUID() });
    const probeWakeMutation = async (mutate: () => Promise<unknown>, restore: () => Promise<unknown>) => {
      try { await mutate(); await expectRejectedEWriterProbe(); }
      finally { await restore(); }
      const [restored] = await owned.db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, target.seeded.companyId), eq(agentWakeupRequests.id, exactWake.wakeupRequestId)));
      expect(restored).toMatchObject({ companyId: exactWakeRow!.companyId, agentId: exactWakeRow!.agentId,
        requestedByActorId: exactWakeRow!.requestedByActorId, idempotencyKey: exactWakeRow!.idempotencyKey,
        runId: exactWakeRow!.runId, missionId: exactWakeRow!.missionId, workflowRunId: exactWakeRow!.workflowRunId,
        issueId: exactWakeRow!.issueId, workflowStepRunId: exactWakeRow!.workflowStepRunId,
        workflowExecutionGeneration: exactWakeRow!.workflowExecutionGeneration, payload: originalWakePayload });
    };
    const withoutProof = { ...originalWakePayload };
    delete withoutProof.__paperclipWorkflowProducerAttempt;
    const exactWakeScope = and(eq(agentWakeupRequests.companyId, target.seeded.companyId),
      eq(agentWakeupRequests.id, exactWake.wakeupRequestId));
    await probeWakeMutation(
      () => owned.db.update(agentWakeupRequests).set({ payload: withoutProof }).where(exactWakeScope),
      () => owned.db.update(agentWakeupRequests).set({ payload: originalWakePayload }).where(exactWakeScope));
    await probeWakeMutation(
      () => owned.db.update(agentWakeupRequests).set({ payload: { ...originalWakePayload,
        qaRemediationCompletion: { preparationEventId: "not-a-uuid" } } }).where(exactWakeScope),
      () => owned.db.update(agentWakeupRequests).set({ payload: originalWakePayload }).where(exactWakeScope));
    const withoutMarkers = { ...originalWakePayload };
    delete withoutMarkers.qaRemediationCompletion;
    await probeWakeMutation(
      () => owned.db.update(agentWakeupRequests).set({ requestedByActorId: "workflow:manual",
        idempotencyKey: `ordinary-e-probe:${exactWake.wakeupRequestId}`, payload: withoutMarkers })
        .where(exactWakeScope),
      () => owned.db.update(agentWakeupRequests).set({ requestedByActorId: exactWakeRow!.requestedByActorId,
        idempotencyKey: exactWakeRow!.idempotencyKey, payload: originalWakePayload })
        .where(exactWakeScope));
    await probeWakeMutation(
      () => owned.db.update(agentWakeupRequests).set({ missionId: unrelated.seed.missionId,
        workflowRunId: unrelated.seed.workflowRunId }).where(exactWakeScope),
      () => owned.db.update(agentWakeupRequests).set({ missionId: exactWakeRow!.missionId,
        workflowRunId: exactWakeRow!.workflowRunId }).where(exactWakeScope));
    const heldAccepted = await deliverQualityIntent(owned.db, { companyId: target.seeded.companyId, actionId: target.actionId });
    expect(heldAccepted).toEqual({ status: "accepted", receiptId: exactWake.wakeupRequestId });
    const publishedStats = await Promise.all(target.files.map((file) => stat(file.file)));
    expect(await readFile(target.files[0]!.file, "utf8")).toBe(target.files[0]!.after);
    await writeFile(targetVerifierRelease, "release");
    pendingGatePaths.delete(targetVerifierRelease);
    const targetActual = await consumeAndSubmitOfficialPass(target, exactWake.wakeupRequestId, targetVerifierDrain);
    targetActualForComparison = targetActual;
    expect(targetActual.resultJson).toBeDefined();
    const officialPassRows = await owned.db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, target.seeded.companyId),
      eq(workflowTransitionEvents.workflowRunId, target.seed.workflowRunId),
      eq(workflowTransitionEvents.workflowStepRunId, target.seed.qaStepRunId),
      eq(workflowTransitionEvents.issueId, target.seed.qaIssueId),
      eq(workflowTransitionEvents.heartbeatRunId, targetActual.id),
      eq(workflowTransitionEvents.wakeupRequestId, exactWake.wakeupRequestId),
      eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
      eq(workflowTransitionEvents.verdict, "pass"),
    ));
    expect(officialPassRows).toHaveLength(1);
    expect(officialPassRows[0]).toMatchObject({ executionGeneration: exactWake.executionGeneration,
      wakeupRequestId: exactWake.wakeupRequestId,
      idempotencyKey: `workflow-validation-verdict:${target.seeded.companyId}:${target.seed.qaIssueId}:${target.seed.qaStepRunId}:run:${targetActual.id}` });
    const replayed = await recordWorkflowValidationVerdict({ db: owned.db,
      issue: heldQaIssue!, source: "workflow_api", verdict: "pass",
      actorAgentId: target.seed.verifierAgentId, heartbeatRunId: targetActual.id });
    expect(replayed.satisfied).toBe(true);
    expect(await officialPassRowsForHeldActual()).toHaveLength(1);
    const terminalCancellationRead = await readQualityCancellation(owned.db, {
      companyId: target.seeded.companyId, actionId: target.actionId,
    });
    expect(terminalCancellationRead).toMatchObject({ requested: false, cancelRequestedAt: null,
      runStatus: "succeeded", cancelledConfirmed: false });
    expect(await useRows(target)).toHaveLength(1);
    expect(await qualityWakes(target)).toHaveLength(0);
    expect(await preparationRows(target)).toHaveLength(1);
    expect(await completionRows(target)).toHaveLength(1);
    const targetUsesBeforeObservation = await useRows(target);
    const targetPreparationsBeforeObservation = await preparationRows(target);
    const targetCompletionsBeforeObservation = await completionRows(target);
    const targetEActualsBeforeObservation = await owned.db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, target.seeded.companyId), eq(heartbeatRuns.wakeupRequestId, exactWake.wakeupRequestId)));
    expect(targetEActualsBeforeObservation).toHaveLength(1);
    expect(targetEActualsBeforeObservation[0]!.id).toBe(targetActual.id);
    const qaActualsBeforeObservation = await owned.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, target.seeded.companyId), eq(heartbeatRuns.workflowStepRunId, target.seed.qaStepRunId)));
    expect(qaActualsBeforeObservation.map((row) => row.id).sort()).toEqual([target.seed.verdictHeartbeatId, targetActual.id].sort());
    const publishedAfterStats = await Promise.all(target.files.map((file) => stat(file.file)));
    expect(publishedAfterStats.map(({ dev, ino }) => ({ dev, ino })))
      .toEqual(publishedStats.map(({ dev, ino }) => ({ dev, ino })));
    const [beforeObservation] = await owned.db.select().from(qualityActions).where(eq(qualityActions.id, target.actionId));
    expect(beforeObservation!.state).not.toBe("corrected");

    await addIndependentObservation(target, targetActual);
    const reentry = await deliverQualityIntent(owned.db, { companyId: target.seeded.companyId, actionId: target.actionId });
    expect(reentry).toEqual({ status: "accepted", receiptId: exactWake.wakeupRequestId });
    const [afterReentry] = await owned.db.select().from(qualityActions).where(eq(qualityActions.id, target.actionId));
    expect(afterReentry!.state).toBe("corrected");
    expect(await useRows(target)).toEqual(targetUsesBeforeObservation);
    expect(await preparationRows(target)).toEqual(targetPreparationsBeforeObservation);
    expect(await completionRows(target)).toEqual(targetCompletionsBeforeObservation);
    expect(await qualityWakes(target)).toHaveLength(0);
    const targetEActualsAfterReentry = await owned.db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, target.seeded.companyId), eq(heartbeatRuns.wakeupRequestId, exactWake.wakeupRequestId)));
    expect(targetEActualsAfterReentry.map((run) => run.id)).toEqual([targetActual.id]);
    const qaActualsAfterReentry = await owned.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, target.seeded.companyId), eq(heartbeatRuns.workflowStepRunId, target.seed.qaStepRunId)));
    expect(qaActualsAfterReentry.map((row) => row.id).sort()).toEqual([target.seed.verdictHeartbeatId, targetActual.id].sort());
    const [producerAfter] = await owned.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, target.seed.source.heartbeatRunId));
    const [initialQaAfter] = await owned.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, target.seed.verdictHeartbeatId));
    expect(producerAfter).toEqual(originalProducer);
    expect(initialQaAfter).toEqual(originalInitialQa);

    const finalizationBefore = await readScopedFinalizationSnapshot(target, exactWake.wakeupRequestId, targetActual.id);
    const publishedBeforeFinalization = await Promise.all(target.files.map(async file => {
      const fileStat = await stat(file.file);
      return { dev: fileStat.dev, ino: fileStat.ino,
        sha256: createHash("sha256").update(await readFile(file.file)).digest("hex") };
    }));
    emitStage("mission-finalization-before", "after", { companyId: target.seeded.companyId,
      missionId: target.seed.missionId, workflowRunId: target.seed.workflowRunId, snapshot: finalizationBefore,
      publishedFiles: publishedBeforeFinalization });

    const [freshQaIssue] = await owned.db.select().from(issues).where(and(
      eq(issues.companyId, target.seeded.companyId), eq(issues.id, target.seed.qaIssueId)));
    if (!freshQaIssue) throw new Error("exact E QA issue is missing before legitimate completion");
    if (freshQaIssue.status !== "done") {
      if (freshQaIssue.status === "cancelled") throw new Error("exact E QA issue is cancelled; completion remains held");
      await completeWorkflowIssue({ db: owned.db, issue: freshQaIssue, actor: {
        actorType: "agent", actorId: target.seed.verifierAgentId,
        agentId: target.seed.verifierAgentId, runId: targetActual.id,
      }, data: {} });
    }

    const postCompletionSource = await readScopedFinalizationSnapshot(target, exactWake.wakeupRequestId,
      targetActual.id, { includeTerminalSourceObservation: true });
    emitStage("mission-finalization-post-completion-source", "after", {
      companyId: target.seeded.companyId, missionId: target.seed.missionId,
      workflowRunId: target.seed.workflowRunId,
      terminalSourceObservation: postCompletionSource.terminalSourceObservation,
    });

    const terminalSourceObservation = postCompletionSource.terminalSourceObservation;
    if (!isRecord(terminalSourceObservation) || !isRecord(terminalSourceObservation.checks)) {
      throw new Error("post-completion terminal source observation is missing or malformed");
    }
    const sourceCheckEntries = Object.entries(terminalSourceObservation.checks);
    const failedSourcePredicates = sourceCheckEntries
      .filter(([, passed]) => passed !== true).map(([name]) => name);
    const source = terminalSourceObservation.manifestSource;
    const workflowSnapshot = terminalSourceObservation.workflow;
    const qaIssueSnapshot = terminalSourceObservation.qaIssue;
    const stepSnapshot = terminalSourceObservation.step;
    const wakeSnapshot = terminalSourceObservation.wake;
    const actualSnapshot = terminalSourceObservation.actual;
    const readinessSnapshot = terminalSourceObservation.readiness;
    const flagsSnapshot = terminalSourceObservation.experimentalFlags;
    const beforeSource = finalizationBefore.continuation.readiness?.kind === "ready"
      ? finalizationBefore.continuation.readiness.manifest.source : null;
    const beforeQaStep = finalizationBefore.steps.find(step => step.id === target.seed.qaStepRunId);
    const sourceAttempt = isRecord(wakeSnapshot) && isRecord(wakeSnapshot.attempt) ? wakeSnapshot.attempt : null;
    if (!isRecord(source) || !isRecord(workflowSnapshot) || !isRecord(qaIssueSnapshot)
      || !isRecord(stepSnapshot) || !isRecord(wakeSnapshot) || !isRecord(actualSnapshot)
      || !isRecord(readinessSnapshot) || !isRecord(flagsSnapshot) || !sourceAttempt
      || !beforeSource || !beforeQaStep) {
      throw new Error("same-run resume precondition observation is incomplete");
    }
    expect(source).toEqual(beforeSource);
    expect(workflowSnapshot).toMatchObject({ id: target.seed.workflowRunId,
      dispatchAuthorityVersion: source.dispatchAuthorityVersion, parentRunId: null, parentStepRunId: null });
    expect(qaIssueSnapshot).toMatchObject({ id: target.seed.qaIssueId, missionId: target.seed.missionId, status: "done" });
    expect(stepSnapshot).toMatchObject({ id: target.seed.qaStepRunId, stepId: "qa-validate",
      issueId: target.seed.qaIssueId, status: "completed", executionGeneration: source.executionGeneration,
      retryCount: source.retryCount, iterationIndex: source.iterationIndex,
      dispatchOwnerHeartbeatRunId: source.heartbeatRunId,
      dispatchOwnerWakeupRequestId: source.wakeupRequestId });
    expect(stepSnapshot.dispatchOwnerHeartbeatRunId).toBe(beforeQaStep.dispatchOwnerHeartbeatRunId);
    expect(stepSnapshot.dispatchOwnerWakeupRequestId).toBe(beforeQaStep.dispatchOwnerWakeupRequestId);
    expect(wakeSnapshot).toMatchObject({ id: finalizationBefore.exactWake?.id,
      status: "completed", runId: source.heartbeatRunId, agentId: source.agentId, issueId: source.issueId,
      missionId: source.missionId, workflowRunId: source.workflowRunId,
      workflowStepRunId: source.workflowStepRunId, workflowExecutionGeneration: source.executionGeneration,
      attempt: finalizationBefore.exactWake?.attempt });
    expect(sourceAttempt).toMatchObject({ companyId: source.companyId, missionId: source.missionId,
      workflowRunId: source.workflowRunId, stepRunId: source.workflowStepRunId,
      executionGeneration: source.executionGeneration, retryCount: source.retryCount,
      iterationIndex: source.iterationIndex });
    expect(actualSnapshot).toMatchObject({ id: targetActual.id, status: "succeeded",
      companyId: source.companyId, agentId: source.agentId, issueId: source.issueId,
      wakeupRequestId: source.wakeupRequestId, workflowStepRunId: source.workflowStepRunId,
      workflowExecutionGeneration: source.executionGeneration, executionScopeKind: source.executionScopeKind,
      executionEpoch: source.executionEpoch, executorOwnerId: source.executorOwnerId,
      executorOwnerLeaseEpoch: source.ownerLeaseEpoch, retryOfRunId: source.retryOfRunId,
      processLossRetryCount: source.processLossRetryCount });
    expect(terminalSourceObservation.actualMatchesRun).toBe(true);
    expect(readinessSnapshot.kind).toBe("ready");
    expect(terminalSourceObservation.runIsPlainUnlinked).toBe(true);
    expect(terminalSourceObservation.linkedInvocationCount).toBe(0);
    expect(flagsSnapshot).toMatchObject({ settingsRowPresent: true, enableRunReopenGuardV1: false,
      enableRunTerminalBoundaryV1: false });

    const allSourcePredicatesPassed = sourceCheckEntries.length === 26 && failedSourcePredicates.length === 0;
    const exactCompletedWorkflow = allSourcePredicatesPassed && workflowSnapshot.status === "completed";
    const exactFailedWorkflowResume = sourceCheckEntries.length === 26
      && failedSourcePredicates.length === 1 && failedSourcePredicates[0] === "workflowStatusAllowed"
      && terminalSourceObservation.checks.workflowStatusAllowed === false && workflowSnapshot.status === "failed";
    if (!exactCompletedWorkflow && !exactFailedWorkflowResume) {
      emitStage("mission-finalization-workflow-resume", "error", {
        failedSourcePredicates, sourcePredicateCount: sourceCheckEntries.length,
        workflowStatus: workflowSnapshot.status,
      });
      throw new Error(`same-run resume precondition held: ${failedSourcePredicates.join(",") || "predicate_set_changed"}`);
    }
    if (exactFailedWorkflowResume) {
      expect(workflowSnapshot.status).toBe("failed");
      await workflowService.resumeRun(owned.db, {
        companyId: target.seeded.companyId, runId: target.seed.workflowRunId,
      });
    } else {
      expect(workflowSnapshot.status).toBe("completed");
    }
    const [continuedWorkflow] = await owned.db.select({ status: workflowRuns.status,
      dispatchAuthorityVersion: workflowRuns.dispatchAuthorityVersion }).from(workflowRuns).where(and(
      eq(workflowRuns.companyId, target.seeded.companyId), eq(workflowRuns.id, target.seed.workflowRunId)));
    expect(continuedWorkflow).toBeDefined();
    expect(["running", "completed"]).toContain(continuedWorkflow!.status);
    expect(continuedWorkflow!.dispatchAuthorityVersion).toBe(source.dispatchAuthorityVersion);
    emitStage(exactFailedWorkflowResume ? "mission-finalization-workflow-resume" : "mission-finalization-workflow-already-completed",
      "after", { workflowRunId: target.seed.workflowRunId, status: continuedWorkflow!.status,
        dispatchAuthorityVersion: continuedWorkflow!.dispatchAuthorityVersion,
        resumeCalled: exactFailedWorkflowResume });

    const continuationRows = await owned.db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, target.seeded.companyId),
      eq(workflowTransitionEvents.heartbeatRunId, targetActual.id),
      eq(workflowTransitionEvents.eventType, TERMINAL_RELEASE_EVENT_TYPE),
    ));
    expect(continuationRows).toHaveLength(1);
    const continuationId = continuationRows[0]!.id;
    let continuation = await readTerminalReleaseManifest(owned.db, continuationId);
    if (continuation.kind !== "found") throw new Error(`exact E continuation manifest is held: ${continuation.reason}`);
    const pendingAcks = await Promise.all(continuation.manifest.obligations.map(async obligation => ({
      effectKey: obligation.effectKey,
      state: await readTerminalReleaseAcknowledgment(owned.db, continuationId, obligation.effectKey),
    })));
    const heldAck = pendingAcks.find(item => item.state.kind === "held");
    if (heldAck?.state.kind === "held") {
      emitStage("mission-finalization-continuation", "error", { continuationId,
        effectKey: heldAck.effectKey, reason: heldAck.state.reason });
      throw new Error(`exact E continuation acknowledgment is held: ${heldAck.state.reason}`);
    }
    const finalizationHeartbeat = heartbeatService(owned.db);
    let continuationRecovery: { kind: "complete" } | { kind: "not_needed" } | { kind: "held"; reason: string };
    if (pendingAcks.some(item => item.state.kind === "pending")) {
      continuationRecovery = await finalizationHeartbeat.recoverTerminalReleaseContinuation(continuationId);
      emitStage("mission-finalization-continuation", "after", { continuationId, result: continuationRecovery });
      if (continuationRecovery.kind !== "complete") {
        throw new Error(`exact E continuation source validation held: ${continuationRecovery.reason}`);
      }
    } else {
      continuationRecovery = { kind: "not_needed" };
    }
    await waitForTerminalObligationAcks(continuationId, continuation.manifest.obligations);
    continuation = await readTerminalReleaseManifest(owned.db, continuationId);
    if (continuation.kind !== "found") throw new Error(`exact E continuation manifest changed: ${continuation.reason}`);

    const reconciledMission = await missionService(owned.db).reconcileById(target.seed.missionId);
    emitStage("mission-finalization-reconciled", "after", { companyId: target.seeded.companyId,
      missionId: target.seed.missionId, workflowRunId: target.seed.workflowRunId,
      reconciledStatus: reconciledMission.status, continuationRecovery });
    const [completedMission] = await owned.db.select().from(missions).where(and(
      eq(missions.companyId, target.seeded.companyId), eq(missions.id, target.seed.missionId)));
    const [completedWorkflowRun] = await owned.db.select().from(workflowRuns).where(and(
      eq(workflowRuns.companyId, target.seeded.companyId), eq(workflowRuns.id, target.seed.workflowRunId)));
    expect(completedMission?.status).toBe("completed");
    expect(completedWorkflowRun?.status).toBe("completed");
    expect(completedMission?.completedAt).toBeInstanceOf(Date);
    expect(completedWorkflowRun?.completedAt).toBeInstanceOf(Date);

    const finalizationAfter = await readScopedFinalizationSnapshot(target, exactWake.wakeupRequestId, targetActual.id);
    const publishedAfterFinalization = await Promise.all(target.files.map(async file => {
      const fileStat = await stat(file.file);
      return { dev: fileStat.dev, ino: fileStat.ino,
        sha256: createHash("sha256").update(await readFile(file.file)).digest("hex") };
    }));
    const issueOwners = (issue: typeof finalizationBefore.issues.producer) => issue && ({
      assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId,
      checkoutRunId: issue.checkoutRunId, executionRunId: issue.executionRunId,
      executionAgentNameKey: issue.executionAgentNameKey,
    });
    const wakeIdentity = (wake: typeof finalizationBefore.exactWake) => wake && ({ id: wake.id, runId: wake.runId,
      agentId: wake.agentId, issueId: wake.issueId, missionId: wake.missionId, workflowRunId: wake.workflowRunId,
      workflowStepRunId: wake.workflowStepRunId, workflowExecutionGeneration: wake.workflowExecutionGeneration,
      attempt: wake.attempt });
    const stepAttempts = (snapshot: typeof finalizationBefore) => snapshot.steps.map(step => ({
      id: step.id, executionGeneration: step.executionGeneration, retryCount: step.retryCount,
      iterationIndex: step.iterationIndex, dispatchOwnerHeartbeatRunId: step.dispatchOwnerHeartbeatRunId,
      dispatchOwnerWakeupRequestId: step.dispatchOwnerWakeupRequestId,
    })).sort((a, b) => a.id.localeCompare(b.id));
    emitStage("mission-finalization-after", "after", { snapshot: finalizationAfter,
      publishedFiles: publishedAfterFinalization });
    expect(finalizationAfter.company?.id).toBe(target.seeded.companyId);
    expect(finalizationAfter.issues.producer?.id).toBe(finalizationBefore.issues.producer?.id);
    expect(finalizationAfter.issues.qa?.status).toBe("done");
    expect(issueOwners(finalizationAfter.issues.producer)).toEqual(issueOwners(finalizationBefore.issues.producer));
    expect(issueOwners(finalizationAfter.issues.qa)).toEqual(issueOwners(finalizationBefore.issues.qa));
    expect(stepAttempts(finalizationAfter)).toEqual(stepAttempts(finalizationBefore));
    expect(finalizationAfter.qaWakes.map(row => row.id).sort())
      .toEqual(finalizationBefore.qaWakes.map(row => row.id).sort());
    expect(wakeIdentity(finalizationAfter.exactWake)).toEqual(wakeIdentity(finalizationBefore.exactWake));
    expect(finalizationAfter.actuals).toEqual(finalizationBefore.actuals);
    expect(finalizationAfter.passes).toEqual(finalizationBefore.passes);
    expect(finalizationAfter.preparations).toEqual(finalizationBefore.preparations);
    expect(finalizationAfter.completions).toEqual(finalizationBefore.completions);
    expect(finalizationAfter.action).toEqual(finalizationBefore.action);
    expect(finalizationAfter.observations).toEqual(finalizationBefore.observations);
    expect(finalizationAfter.workflow?.dispatchAuthorityVersion).toBe(finalizationBefore.workflow?.dispatchAuthorityVersion);
    expect(publishedAfterFinalization).toEqual(publishedBeforeFinalization);
    expect(await qualityWakes(target)).toHaveLength(0);
    const qaStepAfterFinalization = finalizationAfter.steps.find(step => step.id === target.seed.qaStepRunId);
    expect(qaStepAfterFinalization?.status).toBe("completed");

    // Restart the bounded reaper from durable state and ensure this exact E manifest remains stable.
    await finalizationHeartbeat.reapOrphanedRuns();
    await waitForTerminalObligationAcks(continuationId, continuation.manifest.obligations);
    const replayable = continuation.manifest.obligations.find(item => item.action.kind === "sync_issue");
    expect(replayable).toBeDefined();
    const matchingAcks = await owned.db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, target.seeded.companyId),
      eq(workflowTransitionEvents.eventType, TERMINAL_RELEASE_ACK_EVENT_TYPE),
      eq(workflowTransitionEvents.correlationId, continuationId),
    ));
    const replayAck = matchingAcks.find(row => isRecord(row.payload) && row.payload.effectKey === replayable!.effectKey);
    expect(replayAck).toBeDefined();
    await owned.db.delete(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, replayAck!.id));

    const beforeAuthorityChange = {
      runs: await owned.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, target.seeded.companyId), eq(heartbeatRuns.workflowStepRunId, target.seed.qaStepRunId),
      )),
      wakes: await owned.db.select({ id: agentWakeupRequests.id, runId: agentWakeupRequests.runId }).from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, target.seeded.companyId), eq(agentWakeupRequests.issueId, target.seed.qaIssueId),
      )),
      actuals: await owned.db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.companyId, target.seeded.companyId),
        eq(workflowTransitionEvents.workflowRunId, target.seed.workflowRunId),
        eq(workflowTransitionEvents.workflowStepRunId, target.seed.qaStepRunId),
        eq(workflowTransitionEvents.eventType, HEARTBEAT_ACTUAL_DRAIN_EVENT_TYPE),
      )),
      uses: await useRows(target), preparations: await preparationRows(target), completions: await completionRows(target),
    };
    const replacementOwnerIssueId = continuation.manifest.source.issueId;
    expect(replacementOwnerIssueId).toBe(target.seed.qaIssueId);
    const [issueBeforeForeignOwner] = await owned.db.select({ executionRunId: issues.executionRunId,
      checkoutRunId: issues.checkoutRunId, executionAgentNameKey: issues.executionAgentNameKey,
      executionLockedAt: issues.executionLockedAt }).from(issues).where(and(
      eq(issues.companyId, target.seeded.companyId), eq(issues.id, replacementOwnerIssueId),
    ));
    const foreignOwnerId = unrelated.seed.source.heartbeatRunId;
    await owned.db.update(issues).set({ executionRunId: foreignOwnerId, checkoutRunId: foreignOwnerId,
      executionAgentNameKey: "foreign-owner-proof", executionLockedAt: new Date() }).where(and(
      eq(issues.companyId, target.seeded.companyId), eq(issues.id, replacementOwnerIssueId),
    ));
    const [foreignOwnerSnapshot] = await owned.db.select({ executionRunId: issues.executionRunId,
      checkoutRunId: issues.checkoutRunId, executionAgentNameKey: issues.executionAgentNameKey,
      executionLockedAt: issues.executionLockedAt }).from(issues).where(and(
      eq(issues.companyId, target.seeded.companyId), eq(issues.id, replacementOwnerIssueId),
    ));
    const foreignOwnerReplay = await finalizationHeartbeat.recoverTerminalReleaseContinuation(continuationId);
    expect(foreignOwnerReplay).toMatchObject({ kind: "held", reason: "terminal_continuation_replacement_owner_changed" });
    const [foreignOwnerAfterReplay] = await owned.db.select({ executionRunId: issues.executionRunId,
      checkoutRunId: issues.checkoutRunId, executionAgentNameKey: issues.executionAgentNameKey,
      executionLockedAt: issues.executionLockedAt }).from(issues).where(and(
      eq(issues.companyId, target.seeded.companyId), eq(issues.id, replacementOwnerIssueId),
    ));
    expect(foreignOwnerAfterReplay).toEqual(foreignOwnerSnapshot);
    await owned.db.update(issues).set(issueBeforeForeignOwner!).where(and(
      eq(issues.companyId, target.seeded.companyId), eq(issues.id, replacementOwnerIssueId),
    ));
    const afterForeignOwnerReplay = {
      runs: await owned.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, target.seeded.companyId), eq(heartbeatRuns.workflowStepRunId, target.seed.qaStepRunId),
      )),
      wakes: await owned.db.select({ id: agentWakeupRequests.id, runId: agentWakeupRequests.runId }).from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, target.seeded.companyId), eq(agentWakeupRequests.issueId, target.seed.qaIssueId),
      )),
      actuals: await owned.db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.companyId, target.seeded.companyId),
        eq(workflowTransitionEvents.workflowRunId, target.seed.workflowRunId),
        eq(workflowTransitionEvents.workflowStepRunId, target.seed.qaStepRunId),
        eq(workflowTransitionEvents.eventType, HEARTBEAT_ACTUAL_DRAIN_EVENT_TYPE),
      )),
      uses: await useRows(target), preparations: await preparationRows(target), completions: await completionRows(target),
    };
    expect(afterForeignOwnerReplay).toEqual(beforeAuthorityChange);
    const originalAuthorityVersion = completedWorkflowRun!.dispatchAuthorityVersion;
    await owned.db.update(workflowRuns).set({ dispatchAuthorityVersion: originalAuthorityVersion + 1 })
      .where(and(eq(workflowRuns.companyId, target.seeded.companyId), eq(workflowRuns.id, target.seed.workflowRunId)));
    const changedAuthorityReplay = await finalizationHeartbeat.recoverTerminalReleaseContinuation(continuationId);
    expect(changedAuthorityReplay).toMatchObject({ kind: "held", reason: "terminal_continuation_source_or_authority_changed" });
    const afterHeldReplay = {
      runs: await owned.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, target.seeded.companyId), eq(heartbeatRuns.workflowStepRunId, target.seed.qaStepRunId),
      )),
      wakes: await owned.db.select({ id: agentWakeupRequests.id, runId: agentWakeupRequests.runId }).from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, target.seeded.companyId), eq(agentWakeupRequests.issueId, target.seed.qaIssueId),
      )),
      actuals: await owned.db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.companyId, target.seeded.companyId),
        eq(workflowTransitionEvents.workflowRunId, target.seed.workflowRunId),
        eq(workflowTransitionEvents.workflowStepRunId, target.seed.qaStepRunId),
        eq(workflowTransitionEvents.eventType, HEARTBEAT_ACTUAL_DRAIN_EVENT_TYPE),
      )),
      uses: await useRows(target), preparations: await preparationRows(target), completions: await completionRows(target),
    };
    expect(afterHeldReplay).toEqual(beforeAuthorityChange);
    await owned.db.update(workflowRuns).set({ dispatchAuthorityVersion: originalAuthorityVersion })
      .where(and(eq(workflowRuns.companyId, target.seeded.companyId), eq(workflowRuns.id, target.seed.workflowRunId)));
    expect(await finalizationHeartbeat.recoverTerminalReleaseContinuation(continuationId)).toEqual({ kind: "complete" });
    await waitForTerminalObligationAcks(continuationId, continuation.manifest.obligations);
    const afterContinuationReplay = {
      runs: await owned.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, target.seeded.companyId), eq(heartbeatRuns.workflowStepRunId, target.seed.qaStepRunId),
      )),
      wakes: await owned.db.select({ id: agentWakeupRequests.id, runId: agentWakeupRequests.runId }).from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, target.seeded.companyId), eq(agentWakeupRequests.issueId, target.seed.qaIssueId),
      )),
      actuals: await owned.db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.companyId, target.seeded.companyId),
        eq(workflowTransitionEvents.workflowRunId, target.seed.workflowRunId),
        eq(workflowTransitionEvents.workflowStepRunId, target.seed.qaStepRunId),
        eq(workflowTransitionEvents.eventType, HEARTBEAT_ACTUAL_DRAIN_EVENT_TYPE),
      )),
      uses: await useRows(target), preparations: await preparationRows(target), completions: await completionRows(target),
    };
    expect(afterContinuationReplay).toEqual(beforeAuthorityChange);
    });

    const cancellationSeedTraceId = randomUUID();
    const cancelledScenario = await traceStage("seed-cancellation", { traceId: cancellationSeedTraceId },
      () => seedCurrentOutputAction(), scenario => scenarioTraceIds("cancellation", scenario));
    await traceStage("assert-cancellation-setup", scenarioTraceIds("cancellation", cancelledScenario),
      () => assertCurrentOutputSetup(cancelledScenario));
    const cancelledVerifierStarted = path.join(home, "cancel-e-verifier-started", cancelledScenario.actionId);
    const cancelledVerifierRelease = path.join(home, "cancel-e-verifier-release", cancelledScenario.actionId);
    await useHeldProcessVerifier(cancelledScenario, cancelledVerifierStarted, cancelledVerifierRelease);
    const cancelHolder = await createQaFileOwnerRuntime({ qaFileOwnerLockRoot: lockRoot, qaFileOwnerPython: PYTHON! })
      .begin(cancelledScenario.files.map((file) => file.file));
    const cancelDeliveryPromise = deliverQualityIntent(owned.db, {
      companyId: cancelledScenario.seeded.companyId, actionId: cancelledScenario.actionId,
    });
    let cancelDeliveryResult: Awaited<ReturnType<typeof deliverQualityIntent>> | undefined;
    let cancellationFailure: unknown;
    let hasCancellationFailure = false;
    try {
      await traceStage("cancellation-native-wait", scenarioTraceIds("cancellation", cancelledScenario),
        () => waitForObservedLockWait(cancelledScenario.files[0]!.file, cancelDeliveryPromise));
      const cancelPreparations = await preparationRows(cancelledScenario);
      expect(cancelPreparations).toHaveLength(1);
      const cancelPreparation = parseQaRemediationPreparation(cancelPreparations[0]!.payload);
      await traceStage("cancellation-setup-release", scenarioTraceIds("cancellation", cancelledScenario),
        () => releaseSetupActuals(cancelledScenario));
      await assertCurrentOutputSourceDrain(cancelledScenario, cancelPreparation);
    } catch (error) {
      cancellationFailure = error;
      hasCancellationFailure = true;
    }

    try {
      await traceStage("cancellation-setup-cleanup", scenarioTraceIds("cancellation", cancelledScenario), async () => {
        const failures: unknown[] = [];
        const setupGatePaths = [cancelledScenario.producerReleasePath, cancelledScenario.qaReleasePath];
        const gateResults = await Promise.allSettled(setupGatePaths.map(async releasePath => {
          await writeFile(releasePath, "release");
          pendingGatePaths.delete(releasePath);
        }));
        for (const result of gateResults) if (result.status === "rejected") failures.push(result.reason);
        const holderResult = await Promise.allSettled([cancelHolder.close()]);
        for (const result of holderResult) if (result.status === "rejected") failures.push(result.reason);
        if (failures.length === 0) {
          const deliveryResult = await Promise.allSettled([cancelDeliveryPromise]);
          if (deliveryResult[0]!.status === "fulfilled") cancelDeliveryResult = deliveryResult[0]!.value;
          else if (!hasCancellationFailure) failures.push(deliveryResult[0]!.reason);
        }
        if (failures.length) throw failures[0];
        return { setupGatesSignalled: setupGatePaths.length, nativeHoldersReleased: 1 };
      });
    } catch (error) {
      if (!hasCancellationFailure) { cancellationFailure = error; hasCancellationFailure = true; }
    }
    if (hasCancellationFailure) throw cancellationFailure;
    const cancelDelivery = await traceStage("cancellation-final-completion", scenarioTraceIds("cancellation", cancelledScenario),
      () => cancelDeliveryResult ? Promise.resolve(cancelDeliveryResult) : cancelDeliveryPromise);
    const cancelCompletionRows = await completionRows(cancelledScenario);
    expect(cancelCompletionRows).toHaveLength(1);
    const cancelCompletion = parseQaRemediationCompletion(cancelCompletionRows[0]!.payload);
    expect(cancelCompletion.wakes).toHaveLength(1);
    const cancelWakeId = cancelCompletion.wakes[0]!.wakeupRequestId;
    expect(cancelDelivery.receiptId).toBe(cancelWakeId);
    await waitForMarker(cancelledVerifierStarted, "held cancellation E QA process");
    const cancelActuals = await owned.db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, cancelledScenario.seeded.companyId), eq(heartbeatRuns.wakeupRequestId, cancelWakeId)));
    expect(cancelActuals).toHaveLength(1);
    const cancelActual = cancelActuals[0]!;
    expect(cancelDelivery.status).toBe("accepted");
    expect(cancelActual.status).toBe("running");
    const [cancelIssue] = await owned.db.select().from(issues).where(and(
      eq(issues.companyId, cancelledScenario.seeded.companyId), eq(issues.id, cancelledScenario.seed.qaIssueId)));
    expect(cancelIssue!.executionRunId).toBe(cancelActual.id);
    const beforeLiveCancel = await readQualityCancellation(owned.db, {
      companyId: cancelledScenario.seeded.companyId, actionId: cancelledScenario.actionId,
    });
    expect(beforeLiveCancel).toMatchObject({ requested: false, runStatus: "running", cancelledConfirmed: false });
    const cancelRequest = await cancelQualityIntent(owned.db, {
      companyId: cancelledScenario.seeded.companyId, actionId: cancelledScenario.actionId,
    });
    expect(cancelRequest).toMatchObject({ heartbeatRunId: cancelActual.id, runCancellationRequested: true });
    const [cancelledAction] = await owned.db.select().from(qualityActions).where(and(
      eq(qualityActions.companyId, cancelledScenario.seeded.companyId), eq(qualityActions.id, cancelledScenario.actionId)));
    expect(cancelledAction!.cancelRequestedAt).toBeInstanceOf(Date);
    const repeatedCancelRequest = await cancelQualityIntent(owned.db, {
      companyId: cancelledScenario.seeded.companyId, actionId: cancelledScenario.actionId,
    });
    expect(repeatedCancelRequest).toMatchObject({
      cancelRequestedAt: cancelRequest.cancelRequestedAt,
      heartbeatRunId: null,
      runCancellationRequested: false,
    });
    const heldReaperResult = await traceStage("cancellation-held-owner-reaper",
      { ...scenarioTraceIds("cancellation", cancelledScenario), heartbeatRunId: cancelActual.id },
      () => heartbeatService(owned.db).reapStalledIssueExecutionLocks({ limit: 100 }));
    emitStage("cancellation-held-owner-reaper", "after", { result: heldReaperResult });
    const [issueDuringActual] = await owned.db.select().from(issues).where(and(
      eq(issues.companyId, cancelledScenario.seeded.companyId), eq(issues.id, cancelledScenario.seed.qaIssueId)));
    expect(issueDuringActual).toBeDefined();
    expect(issueDuringActual!.executionRunId).toBe(cancelIssue!.executionRunId);
    expect(issueDuringActual!.checkoutRunId).toBe(cancelIssue!.checkoutRunId);
    expect(issueDuringActual!.status).toBe(cancelIssue!.status);
    const [sameWakeActualsBeforeDrain, terminalEventsBeforeDrain, drainEventsBeforeDrain] = await Promise.all([
      owned.db.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, cancelledScenario.seeded.companyId), eq(heartbeatRuns.wakeupRequestId, cancelWakeId))),
      owned.db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.companyId, cancelledScenario.seeded.companyId),
        eq(workflowTransitionEvents.heartbeatRunId, cancelActual.id),
        eq(workflowTransitionEvents.eventType, TERMINAL_RELEASE_EVENT_TYPE))),
      owned.db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.companyId, cancelledScenario.seeded.companyId),
        eq(workflowTransitionEvents.heartbeatRunId, cancelActual.id),
        eq(workflowTransitionEvents.eventType, HEARTBEAT_ACTUAL_DRAIN_EVENT_TYPE))),
    ]);
    expect(sameWakeActualsBeforeDrain).toHaveLength(1);
    expect(sameWakeActualsBeforeDrain[0]!.id).toBe(cancelActual.id);
    expect(terminalEventsBeforeDrain).toHaveLength(0);
    expect(drainEventsBeforeDrain).toHaveLength(0);
    await writeFile(cancelledVerifierRelease, "release");
    pendingGatePaths.delete(cancelledVerifierRelease);
    await traceStage("cancellation-actual-drain", {
      ...scenarioTraceIds("cancellation", cancelledScenario), heartbeatRunId: cancelActual.id, wakeupRequestId: cancelWakeId,
    },
      () => waitForHeartbeatExecutionsToDrain(owned.db, 60_000));
    const confirmedCancel = await readQualityCancellation(owned.db, {
      companyId: cancelledScenario.seeded.companyId, actionId: cancelledScenario.actionId,
    });
    expect(confirmedCancel).toMatchObject({ requested: true, runStatus: "cancelled", cancelledConfirmed: true });
    const cancelledActualsAfterDrain = await owned.db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, cancelledScenario.seeded.companyId), eq(heartbeatRuns.wakeupRequestId, cancelWakeId)));
    expect(cancelledActualsAfterDrain).toHaveLength(1);
    expect(cancelledActualsAfterDrain[0]).toMatchObject({ id: cancelActual.id, status: "cancelled" });
    const cancelledActual = cancelledActualsAfterDrain[0]!;
    const cancelIdentity = await freezeHeartbeatActualDrainIdentity(owned.db, cancelledActual, {
      workflowRunId: cancelledScenario.seed.workflowRunId,
    });
    const cancellationBindingExact = Boolean(cancelIdentity
      && cancelIdentity.companyId === cancelledScenario.seeded.companyId
      && cancelIdentity.missionId === cancelledScenario.seed.missionId
      && cancelIdentity.workflowRunId === cancelledScenario.seed.workflowRunId
      && cancelIdentity.workflowStepRunId === cancelledScenario.seed.qaStepRunId
      && cancelIdentity.issueId === cancelledScenario.seed.qaIssueId
      && cancelIdentity.heartbeatRunId === cancelActual.id
      && cancelIdentity.wakeupRequestId === cancelWakeId);
    const cancellationDrainRows = cancelIdentity ? await owned.db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, cancelIdentity.companyId),
      eq(workflowTransitionEvents.missionId, cancelIdentity.missionId),
      eq(workflowTransitionEvents.workflowRunId, cancelIdentity.workflowRunId),
      eq(workflowTransitionEvents.workflowStepRunId, cancelIdentity.workflowStepRunId),
      eq(workflowTransitionEvents.issueId, cancelIdentity.issueId),
      eq(workflowTransitionEvents.heartbeatRunId, cancelIdentity.heartbeatRunId),
      eq(workflowTransitionEvents.eventType, HEARTBEAT_ACTUAL_DRAIN_EVENT_TYPE),
    )) : [];
    const cancellationDrainRow = cancellationDrainRows.length === 1 ? cancellationDrainRows[0]! : null;
    const cancellationDrainPayload = isRecord(cancellationDrainRow?.payload) ? cancellationDrainRow.payload : null;
    const cancellationDrainActual = isRecord(cancellationDrainPayload?.actual) ? cancellationDrainPayload.actual : null;
    const cancellationDrainCleanup = isRecord(cancellationDrainPayload?.cleanup) ? cancellationDrainPayload.cleanup : null;
    const cancellationRuntimeRelease = isRecord(cancellationDrainCleanup?.runtimeServicesRelease)
      ? cancellationDrainCleanup.runtimeServicesRelease : null;
    const cancellationHeartbeatSettlement = isRecord(cancellationDrainCleanup?.heartbeatSettlement)
      ? cancellationDrainCleanup.heartbeatSettlement : null;
    const cancellationDrainResources = isRecord(cancellationDrainCleanup?.resources) ? cancellationDrainCleanup.resources : null;
    const cancellationDrainExact = Boolean(cancelIdentity && cancellationDrainRow && cancellationDrainPayload
      && cancellationDrainPayload.schemaVersion === HEARTBEAT_ACTUAL_DRAIN_SCHEMA
      && isDeepStrictEqual(cancellationDrainPayload.identity, cancelIdentity)
      && cancellationDrainRow.companyId === cancelIdentity.companyId
      && cancellationDrainRow.missionId === cancelIdentity.missionId
      && cancellationDrainRow.workflowRunId === cancelIdentity.workflowRunId
      && cancellationDrainRow.workflowStepRunId === cancelIdentity.workflowStepRunId
      && cancellationDrainRow.issueId === cancelIdentity.issueId
      && cancellationDrainRow.heartbeatRunId === cancelIdentity.heartbeatRunId
      && cancellationDrainRow.eventType === HEARTBEAT_ACTUAL_DRAIN_EVENT_TYPE
      && cancellationDrainRow.layer === "heartbeat"
      && cancellationDrainRow.reasonCode === "actual_drain_observed"
      && cancellationDrainRow.reason === "actual_adapter_settled_and_cleaned"
      && typeof cancellationDrainRow.idempotencyKey === "string"
      && cancellationDrainRow.idempotencyKey.startsWith(`heartbeat-actual-drained:v1:${cancelIdentity.heartbeatRunId}:`)
      && (cancellationDrainActual?.outcome === "fulfilled" || cancellationDrainActual?.outcome === "rejected")
      && cancellationRuntimeRelease?.called === true && cancellationRuntimeRelease.succeeded === true
      && cancellationHeartbeatSettlement?.called === true && cancellationHeartbeatSettlement.succeeded === true
      && cancellationDrainResources?.workspaceOperationsSettled === true
      && cancellationDrainResources.runtimeServicesStopped === true
      && cancellationDrainResources.missionRuntimeIdle === true);
    const cancellationManifest = cancelIdentity
      ? await readTerminalReleaseManifestForSource(owned.db, cancelIdentity, cancelledActual.agentId)
      : { kind: "held" as const, reason: "cancellation_source_identity_unavailable" };
    expect(cancellationManifest.kind, `exact cancellation terminal manifest is not committed: ${JSON.stringify(cancellationManifest)}`)
      .toBe("found");
    if (cancellationManifest.kind !== "found") throw new Error(`exact cancellation terminal manifest held: ${cancellationManifest.reason}`);
    if (!cancelIdentity) throw new Error("exact cancellation source identity is unavailable");
    const expectedCancellationSource = createTerminalReleaseManifest(cancelIdentity, cancelledActual.agentId,
      cancellationManifest.manifest.obligations.map(({ stage, action }) => ({ stage, action }))).source;
    expect(isDeepStrictEqual(cancellationManifest.manifest.source, expectedCancellationSource)).toBe(true);
    const cancellationReadiness = cancellationManifest.kind === "found"
      ? await readReadyTerminalReleaseContinuation(owned.db, cancellationManifest.eventId) : null;
    const cancellationAcknowledgments = cancellationManifest.kind === "found"
      ? await Promise.all(cancellationManifest.manifest.obligations.map(obligation =>
        readTerminalReleaseAcknowledgment(owned.db, cancellationManifest.eventId, obligation.effectKey))) : [];
    const cancellationTerminalDisposition = {
      bindingExact: cancellationBindingExact,
      companyId: cancelledScenario.seeded.companyId,
      missionId: cancelledScenario.seed.missionId,
      workflowRunId: cancelledScenario.seed.workflowRunId,
      workflowStepRunId: cancelledScenario.seed.qaStepRunId,
      issueId: cancelledScenario.seed.qaIssueId,
      heartbeatRunId: cancelActual.id,
      wakeupRequestId: cancelWakeId,
      actualStatus: cancelledActual.status,
      cancellationConfirmed: confirmedCancel.cancelledConfirmed,
      trackedExecutionDrain: "completed",
      actualDrain: {
        kind: cancellationDrainExact ? "proven" : "held",
        reason: cancellationDrainRows.length === 0 ? "exact_receipt_missing"
          : cancellationDrainRows.length !== 1 ? "exact_receipt_ambiguous"
            : cancellationDrainExact ? undefined : "exact_receipt_malformed_or_mismatched",
        eventId: cancellationDrainRow?.id,
        outcome: cancellationDrainActual?.outcome,
        runtimeServicesReleaseSucceeded: cancellationRuntimeRelease?.succeeded === true,
        heartbeatSettlementSucceeded: cancellationHeartbeatSettlement?.succeeded === true,
        resourcesSettled: cancellationDrainResources?.workspaceOperationsSettled === true
          && cancellationDrainResources.runtimeServicesStopped === true
          && cancellationDrainResources.missionRuntimeIdle === true,
      },
      terminal: {
        manifest: cancellationManifest.kind,
        manifestEventId: cancellationManifest.kind === "found" ? cancellationManifest.eventId : undefined,
        manifestReason: cancellationManifest.kind === "held" ? cancellationManifest.reason : undefined,
        readiness: cancellationReadiness?.kind ?? "not_evaluated",
        readinessReason: cancellationReadiness?.kind === "held" ? cancellationReadiness.reason : undefined,
        acknowledgments: {
          total: cancellationAcknowledgments.length,
          acknowledged: cancellationAcknowledgments.filter(read => read.kind === "acknowledged").length,
          pending: cancellationAcknowledgments.filter(read => read.kind === "pending").length,
          held: cancellationAcknowledgments.filter(read => read.kind === "held").length,
        },
      },
    };
    emitStage("cancellation-terminal-disposition", "after", cancellationTerminalDisposition);
    expect(cancellationBindingExact).toBe(true);
    expect(cancellationDrainExact).toBe(true);
    expect(await preparationRows(cancelledScenario)).toHaveLength(1);
    expect(await useRows(cancelledScenario)).toHaveLength(1);
    expect(await completionRows(cancelledScenario)).toHaveLength(1);
    expect(await qualityWakes(cancelledScenario)).toHaveLength(0);
    expect(targetActualForComparison, "original target actual must remain available after cancellation probe").toBeDefined();
    const [positiveActualAfterCancelProbe] = await owned.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, targetActualForComparison!.id));
    expect(positiveActualAfterCancelProbe).toEqual(targetActualForComparison);
  }, 180_000);

  it("keeps final settlement held after the exact terminal release run read fails once", async () => {
    const scenario = await seedCurrentOutputAction();
    await assertCurrentOutputSetup(scenario);
    const verifierStarted = path.join(home, "held-settlement-verifier-started", scenario.actionId);
    const verifierRelease = path.join(home, "held-settlement-verifier-release", scenario.actionId);
    const verifierSignalAcknowledgment = path.join(home, "held-settlement-verifier-sigterm", scenario.actionId);
    await useHeldProcessVerifier(scenario, verifierStarted, verifierRelease, true, verifierSignalAcknowledgment);
    const holder = await createQaFileOwnerRuntime({ qaFileOwnerLockRoot: lockRoot, qaFileOwnerPython: PYTHON! })
      .begin(scenario.files.map(file => file.file));
    const deliveryPromise = deliverQualityIntent(owned.db, {
      companyId: scenario.seeded.companyId, actionId: scenario.actionId,
    });
    let deliveryResult: Awaited<ReturnType<typeof deliverQualityIntent>> | undefined;
    let setupFailure: unknown;
    try {
      await waitForObservedLockWait(scenario.files[0]!.file, deliveryPromise);
      const preparations = await preparationRows(scenario);
      expect(preparations).toHaveLength(1);
      const preparation = parseQaRemediationPreparation(preparations[0]!.payload);
      await releaseSetupActuals(scenario);
      await assertCurrentOutputSourceDrain(scenario, preparation);
    } catch (error) {
      setupFailure = error;
    } finally {
      const gatePaths = [scenario.producerReleasePath, scenario.qaReleasePath];
      const cleanup = await Promise.allSettled([
        ...gatePaths.map(async releasePath => {
          await writeFile(releasePath, "release");
          pendingGatePaths.delete(releasePath);
        }),
        holder.close(),
      ]);
      const delivery = await Promise.allSettled([deliveryPromise]);
      if (delivery[0]!.status === "fulfilled") deliveryResult = delivery[0]!.value;
      if (!setupFailure) {
        const cleanupFailure = cleanup.find(result => result.status === "rejected");
        if (cleanupFailure?.status === "rejected") setupFailure = cleanupFailure.reason;
        else if (delivery[0]!.status === "rejected") setupFailure = delivery[0]!.reason;
      }
    }
    if (setupFailure) throw setupFailure;
    const delivery = deliveryResult ?? await deliveryPromise;
    expect(delivery.status).toBe("accepted");
    expect(delivery.receiptId).toBeTruthy();
    await waitForMarker(verifierStarted, "held final-settlement verifier process");
    const wakeupRequestId = delivery.receiptId!;
    const [actualBeforeCancel] = await owned.db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, scenario.seeded.companyId), eq(heartbeatRuns.wakeupRequestId, wakeupRequestId),
    ));
    expect(actualBeforeCancel).toBeDefined();
    expect(actualBeforeCancel!.status).toBe("running");
    expect(actualBeforeCancel!.companyId).toBe(scenario.seeded.companyId);
    expect(actualBeforeCancel!.agentId).toBe(scenario.seed.verifierAgentId);
    expect(actualBeforeCancel!.issueId).toBe(scenario.seed.qaIssueId);
    expect(actualBeforeCancel!.workflowStepRunId).toBe(scenario.seed.qaStepRunId);
    expect(actualBeforeCancel!.wakeupRequestId).toBe(wakeupRequestId);
    const [issueBeforeCancel] = await owned.db.select().from(issues).where(and(
      eq(issues.companyId, scenario.seeded.companyId), eq(issues.id, scenario.seed.qaIssueId),
    ));
    expect(issueBeforeCancel!.executionRunId).toBe(actualBeforeCancel!.id);
    const verifierProcess = runningProcesses.get(actualBeforeCancel!.id);
    const actualChild = verifierProcess?.child;
    expect(actualChild, "exact actual must retain its registered native child before cancellation").toBeDefined();
    const actualChildPid = actualChild?.pid;
    expect(actualChildPid).toEqual(expect.any(Number));
    if (!actualChildPid || actualChildPid <= 0) throw new Error("exact actual native child has no positive PID");
    expect(actualChild!.exitCode).toBeNull();
    expect(actualChild!.signalCode).toBeNull();
    expect(() => process.kill(actualChildPid, 0)).not.toThrow();
    const cancelRequest = await cancelQualityIntent(owned.db, {
      companyId: scenario.seeded.companyId, actionId: scenario.actionId,
    });
    expect(cancelRequest).toMatchObject({ heartbeatRunId: actualBeforeCancel!.id, runCancellationRequested: true });
    await waitForMarker(verifierSignalAcknowledgment, "exact native child SIGTERM acknowledgement");
    expect((await readFile(verifierSignalAcknowledgment, "utf8")).trim()).toBe(String(actualChildPid));
    expect(actualChild!.pid).toBe(actualChildPid);
    expect(actualChild!.exitCode).toBeNull();
    expect(actualChild!.signalCode).toBeNull();
    expect(() => process.kill(actualChildPid, 0)).not.toThrow();
    const [runAfterSigtermAcknowledgment, issueAfterSigtermAcknowledgment] = await Promise.all([
      owned.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, actualBeforeCancel!.id)).then(rows => rows[0]),
      owned.db.select().from(issues).where(eq(issues.id, scenario.seed.qaIssueId)).then(rows => rows[0]),
    ]);
    expect(runAfterSigtermAcknowledgment?.executorOwnerId).toBe(actualBeforeCancel!.executorOwnerId);
    expect(runAfterSigtermAcknowledgment?.executorOwnerLeaseEpoch).toBe(actualBeforeCancel!.executorOwnerLeaseEpoch);
    expect(runAfterSigtermAcknowledgment?.executorOwnerLeaseToken).toBe(actualBeforeCancel!.executorOwnerLeaseToken);
    const terminalCapabilityReleasedAt = runAfterSigtermAcknowledgment?.executorOwnerReleasedAt;
    expect(terminalCapabilityReleasedAt).toBeInstanceOf(Date);
    expect(issueAfterSigtermAcknowledgment?.executionRunId).toBe(actualBeforeCancel!.id);
    const repeatedCancelRequest = await cancelQualityIntent(owned.db, {
      companyId: scenario.seeded.companyId, actionId: scenario.actionId,
    });
    expect(repeatedCancelRequest.heartbeatRunId).toBeNull();
    const reaper = await heartbeatService(owned.db).reapStalledIssueExecutionLocks({ limit: 100 });
    emitStage("held-settlement-owner-reaper", "after", { result: reaper });

    const [runBeforeRelease, issueBeforeRelease, stepBeforeRelease, workflowBeforeRelease] = await Promise.all([
      owned.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, actualBeforeCancel!.id)).then(rows => rows[0]),
      owned.db.select().from(issues).where(eq(issues.id, scenario.seed.qaIssueId)).then(rows => rows[0]),
      owned.db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, scenario.seed.qaStepRunId)).then(rows => rows[0]),
      owned.db.select().from(workflowRuns).where(eq(workflowRuns.id, scenario.seed.workflowRunId)).then(rows => rows[0]),
    ]);
    expect(runBeforeRelease).toBeDefined();
    expect(issueBeforeRelease).toBeDefined();
    expect(stepBeforeRelease).toBeDefined();
    expect(workflowBeforeRelease).toBeDefined();
    expect(runBeforeRelease!.executorOwnerReleasedAt).toEqual(terminalCapabilityReleasedAt);
    expect(issueBeforeRelease!.executionRunId).toBe(actualBeforeCancel!.id);
    const terminalReleasesBefore = await owned.db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, scenario.seeded.companyId),
      eq(workflowTransitionEvents.heartbeatRunId, actualBeforeCancel!.id),
      eq(workflowTransitionEvents.eventType, TERMINAL_RELEASE_EVENT_TYPE),
    ));
    expect(terminalReleasesBefore).toHaveLength(0);
    const wakesBeforeRelease = await owned.db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, scenario.seeded.companyId), eq(agentWakeupRequests.issueId, scenario.seed.qaIssueId),
    ));
    const runIdsBeforeRelease = await owned.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, scenario.seeded.companyId), eq(heartbeatRuns.workflowStepRunId, scenario.seed.qaStepRunId),
    ));
    const transitionsBeforeRelease = await owned.db.select({
      id: workflowTransitionEvents.id, eventType: workflowTransitionEvents.eventType,
      idempotencyKey: workflowTransitionEvents.idempotencyKey,
    }).from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, scenario.seeded.companyId),
      eq(workflowTransitionEvents.workflowRunId, scenario.seed.workflowRunId),
      eq(workflowTransitionEvents.workflowStepRunId, scenario.seed.qaStepRunId),
    ));
    const usesBeforeRelease = await useRows(scenario);
    const preparationsBeforeRelease = await preparationRows(scenario);
    const completionsBeforeRelease = await completionRows(scenario);
    const finalizationStepsBeforeRelease = await owned.db.select().from(heartbeatRunFinalizationSteps).where(and(
      eq(heartbeatRunFinalizationSteps.companyId, scenario.seeded.companyId),
      eq(heartbeatRunFinalizationSteps.heartbeatRunId, actualBeforeCancel!.id),
    ));

    const readFault = armOneShotReleaseRunReadFailure(owned.db, actualBeforeCancel!.id);
    try {
      readFault.arm();
      await writeFile(verifierRelease, "release");
      pendingGatePaths.delete(verifierRelease);
      await traceStage("held-settlement-actual-drain", {
        ...scenarioTraceIds("held-settlement", scenario), heartbeatRunId: actualBeforeCancel!.id, wakeupRequestId,
      }, () => waitForHeartbeatExecutionsToDrain(owned.db, 60_000));
    } finally {
      readFault.restore();
    }
    expect(readFault.callerCaptured, "fault selector must observe releaseFinishedRun calling getRun").toBe(true);
    expect(readFault.consumed, "one-shot fault must hit only the final exact heartbeat-run read").toBe(true);

    const [runAfterRelease, issueAfterRelease, stepAfterRelease, workflowAfterRelease] = await Promise.all([
      owned.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, actualBeforeCancel!.id)).then(rows => rows[0]),
      owned.db.select().from(issues).where(eq(issues.id, scenario.seed.qaIssueId)).then(rows => rows[0]),
      owned.db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, scenario.seed.qaStepRunId)).then(rows => rows[0]),
      owned.db.select().from(workflowRuns).where(eq(workflowRuns.id, scenario.seed.workflowRunId)).then(rows => rows[0]),
    ]);
    const wakesAfterRelease = await owned.db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, scenario.seeded.companyId), eq(agentWakeupRequests.issueId, scenario.seed.qaIssueId),
    ));
    const runIdsAfterRelease = await owned.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, scenario.seeded.companyId), eq(heartbeatRuns.workflowStepRunId, scenario.seed.qaStepRunId),
    ));
    const transitionsAfterRelease = await owned.db.select({
      id: workflowTransitionEvents.id, eventType: workflowTransitionEvents.eventType,
      idempotencyKey: workflowTransitionEvents.idempotencyKey,
    }).from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, scenario.seeded.companyId),
      eq(workflowTransitionEvents.workflowRunId, scenario.seed.workflowRunId),
      eq(workflowTransitionEvents.workflowStepRunId, scenario.seed.qaStepRunId),
    ));
    const usesAfterRelease = await useRows(scenario);
    const preparationsAfterRelease = await preparationRows(scenario);
    const completionsAfterRelease = await completionRows(scenario);
    const finalizationStepsAfterRelease = await owned.db.select().from(heartbeatRunFinalizationSteps).where(and(
      eq(heartbeatRunFinalizationSteps.companyId, scenario.seeded.companyId),
      eq(heartbeatRunFinalizationSteps.heartbeatRunId, actualBeforeCancel!.id),
    ));
    const compensableDoneBeforeRelease = finalizationStepsBeforeRelease
      .filter(step => step.stageClass === "compensable" && step.state === "done");
    const compensableDoneAfterRelease = finalizationStepsAfterRelease
      .filter(step => step.stageClass === "compensable" && step.state === "done");
    const terminalReleasesAfter = await owned.db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, scenario.seeded.companyId),
      eq(workflowTransitionEvents.heartbeatRunId, actualBeforeCancel!.id),
      eq(workflowTransitionEvents.eventType, TERMINAL_RELEASE_EVENT_TYPE),
    ));
    const actualDrainsAfter = await owned.db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, scenario.seeded.companyId),
      eq(workflowTransitionEvents.heartbeatRunId, actualBeforeCancel!.id),
      eq(workflowTransitionEvents.eventType, HEARTBEAT_ACTUAL_DRAIN_EVENT_TYPE),
    ));
    const stableRunIdentity = (run: typeof runBeforeRelease) => run && ({
      id: run.id, companyId: run.companyId, issueId: run.issueId, wakeupRequestId: run.wakeupRequestId,
      workflowStepRunId: run.workflowStepRunId, workflowExecutionGeneration: run.workflowExecutionGeneration,
      executionScopeKind: run.executionScopeKind, executionEpoch: run.executionEpoch, executionToken: run.executionToken,
      executorOwnerId: run.executorOwnerId, executorOwnerLeaseEpoch: run.executorOwnerLeaseEpoch,
      executorOwnerLeaseToken: run.executorOwnerLeaseToken, executorOwnerReleasedAt: run.executorOwnerReleasedAt,
      retryOfRunId: run.retryOfRunId, processLossRetryCount: run.processLossRetryCount,
      finalizationVersion: run.finalizationVersion,
    });
    emitStage("held-settlement-disposition", "after", {
      ...scenarioTraceIds("held-settlement", scenario), heartbeatRunId: actualBeforeCancel!.id, wakeupRequestId,
      faultConsumed: readFault.consumed, finalStatus: runAfterRelease?.status,
      ownerPreserved: runAfterRelease?.executorOwnerId === runBeforeRelease!.executorOwnerId
        && runAfterRelease?.executorOwnerReleasedAt?.getTime() === terminalCapabilityReleasedAt?.getTime(),
      terminalCapabilityReleasedAt: runAfterRelease?.executorOwnerReleasedAt?.toISOString() ?? null,
      settledAt: runAfterRelease?.settledAt?.toISOString() ?? null,
      terminalReleaseRows: terminalReleasesAfter.length, actualDrainRows: actualDrainsAfter.length,
      heartbeatRuns: runIdsAfterRelease.length, wakes: wakesAfterRelease.length,
      compensableDoneFinalizationSteps: finalizationStepsAfterRelease.filter(step => step.stageClass === "compensable" && step.state === "done").length,
      dispatchReadyAt: stepAfterRelease?.dispatchReadyAt?.toISOString() ?? null,
      preparationRows: preparationsAfterRelease.length, useRows: usesAfterRelease.length, completionRows: completionsAfterRelease.length,
    });
    const adapterResultJson = isRecord(runAfterRelease?.resultJson) ? runAfterRelease.resultJson : null;
    expect(adapterResultJson?.stdout).toEqual(expect.any(String));
    expect(JSON.parse(adapterResultJson!.stdout as string)).toEqual({
      verdict: "pass", observed: scenario.files.map(file => file.after),
    });
    expect(runAfterRelease?.status).toBe("cancelled");
    expect(stableRunIdentity(runAfterRelease)).toEqual(stableRunIdentity(runBeforeRelease));
    expect(issueAfterRelease).toEqual(issueBeforeRelease);
    expect(stepAfterRelease).toEqual(stepBeforeRelease);
    expect(workflowAfterRelease).toEqual(workflowBeforeRelease);
    const wakeFieldsWithoutUpdatedAt = (rows: typeof wakesBeforeRelease) => rows
      .map(({ updatedAt: _updatedAt, ...wake }) => wake)
      .sort((left, right) => left.id.localeCompare(right.id));
    expect(wakeFieldsWithoutUpdatedAt(wakesAfterRelease)).toEqual(wakeFieldsWithoutUpdatedAt(wakesBeforeRelease));
    const wakeUpdatedAtBeforeRelease = new Map(wakesBeforeRelease.map(wake => [wake.id, wake.updatedAt] as const));
    for (const wake of wakesAfterRelease) {
      const previousUpdatedAt = wakeUpdatedAtBeforeRelease.get(wake.id);
      expect(previousUpdatedAt).toBeDefined();
      if (previousUpdatedAt !== undefined) {
        expect(wake.updatedAt.getTime()).toBeGreaterThanOrEqual(previousUpdatedAt.getTime());
      }
    }
    expect(runIdsAfterRelease).toEqual(runIdsBeforeRelease);
    expect(transitionsAfterRelease).toEqual(transitionsBeforeRelease);
    expect(runAfterRelease?.settledAt).toBeNull();
    expect(runAfterRelease?.executorOwnerReleasedAt).toEqual(terminalCapabilityReleasedAt);
    expect(stepAfterRelease?.dispatchReadyAt).toEqual(stepBeforeRelease!.dispatchReadyAt);
    expect(compensableDoneAfterRelease).toEqual(compensableDoneBeforeRelease);
    expect(terminalReleasesAfter).toHaveLength(0);
    expect(actualDrainsAfter).toHaveLength(0);
    expect(usesAfterRelease).toEqual(usesBeforeRelease);
    expect(preparationsAfterRelease).toEqual(preparationsBeforeRelease);
    expect(completionsAfterRelease).toEqual(completionsBeforeRelease);
    expect(await qualityWakes(scenario)).toHaveLength(0);
  }, 180_000);

  it("returns blocked on a real partial publication and reuses the already-published prefix", async () => {
    const scenario = await seedCurrentOutputAction(2);
    await assertCurrentOutputSetup(scenario);
    await useProcessVerifier(scenario);
    const secondFileDirectory = path.dirname(scenario.files[1]!.file);
    const holder = await createQaFileOwnerRuntime({ qaFileOwnerLockRoot: lockRoot, qaFileOwnerPython: PYTHON! })
      .begin(scenario.files.map((file) => file.file));
    const deliveryPromise = deliverQualityIntent(owned.db, { companyId: scenario.seeded.companyId, actionId: scenario.actionId });
    let leaveSecondDirectoryReadOnly = false;
    try {
      await waitForObservedLockWait(scenario.files[0]!.file, deliveryPromise);
      const preparations = await preparationRows(scenario);
      expect(preparations).toHaveLength(1);
      expect(parseQaRemediationPreparation(preparations[0]!.payload).schemaVersion)
        .toBe(QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3);
      await releaseSetupActuals(scenario);
      // A real post-preflight filesystem refusal lets the native publisher durably apply only the prefix.
      await chmod(secondFileDirectory, 0o555);
    } finally {
      try {
        await releaseSetupActuals(scenario).catch(() => undefined);
        await holder.close();
        await deliveryPromise.catch(() => undefined);
        leaveSecondDirectoryReadOnly = true;
      } finally {
        if (!leaveSecondDirectoryReadOnly) await chmod(secondFileDirectory, 0o755).catch(() => undefined);
      }
    }
    const firstPublishedStat = await (async () => {
      try {
        expect(await deliveryPromise).toEqual({ status: "blocked", receiptId: null });
        expect(await readFile(scenario.files[0]!.file, "utf8")).toBe(scenario.files[0]!.after);
        expect(await readFile(scenario.files[1]!.file, "utf8")).toBe(scenario.files[1]!.before);
        const partial = await applyCurrentOutputCorrection(owned.db, { companyId: scenario.seeded.companyId, actionId: scenario.actionId });
        expect(partial.remediation).toMatchObject({ outcome: "partial", reason: "publication_io_error" });
        expect(await completionRows(scenario)).toHaveLength(0);
        expect(await useRows(scenario)).toHaveLength(0);
        expect(await qualityWakes(scenario)).toHaveLength(0);
        return await stat(scenario.files[0]!.file);
      } finally {
        await chmod(secondFileDirectory, 0o755).catch(() => undefined);
      }
    })();

    expect(await readFile(scenario.files[1]!.file, "utf8")).toBe(scenario.files[1]!.before);
    const retry = await deliverQualityIntent(owned.db, { companyId: scenario.seeded.companyId, actionId: scenario.actionId });
    const completion = parseQaRemediationCompletion((await completionRows(scenario))[0]!.payload);
    expect(completion.wakes).toHaveLength(1);
    expect(retry).toEqual({ status: "accepted", receiptId: completion.wakes[0]!.wakeupRequestId });
    const actual = await consumeAndSubmitOfficialPass(scenario, completion.wakes[0]!.wakeupRequestId);
    expect(actual.status).toBe("succeeded");
    expect((await stat(scenario.files[0]!.file)).ino).toBe(firstPublishedStat.ino);
    expect(await readFile(scenario.files[1]!.file, "utf8")).toBe(scenario.files[1]!.after);
    expect(await preparationRows(scenario)).toHaveLength(1);
    expect(await completionRows(scenario)).toHaveLength(1);
    expect(await useRows(scenario)).toHaveLength(1);
    expect(await qualityWakes(scenario)).toHaveLength(0);
  }, 180_000);

  it("holds when native ownership is unavailable and resumes from the same reservation", async () => {
    const scenario = await seedCurrentOutputAction();
    await assertCurrentOutputSetup(scenario);
    await useProcessVerifier(scenario);
    process.env.PAPERCLIP_QA_FILE_OWNER_LOCK_ROOT = path.join(home, "missing-lock-root");
    const held = await deliverQualityIntent(owned.db, { companyId: scenario.seeded.companyId, actionId: scenario.actionId });
    expect(held).toEqual({ status: "blocked", receiptId: null });
    expect(await readFile(scenario.files[0]!.file, "utf8")).toBe(scenario.files[0]!.before);
    const preparations = await preparationRows(scenario);
    expect(preparations).toHaveLength(1);
    const preparation = parseQaRemediationPreparation(preparations[0]!.payload);
    expect(preparation.schemaVersion).toBe(QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3);
    expect(preparation.qualityBinding.canonicalBinding).toEqual(scenario.binding);
    expect(await completionRows(scenario)).toHaveLength(0);
    expect(await useRows(scenario)).toHaveLength(0);
    expect(await qualityWakes(scenario)).toHaveLength(0);

    // Retain the real prepared reservation, then settle the original actuals
    // and reread the scoped G0 drain before the resume reaches native flock.
    await releaseSetupActuals(scenario);
    await assertCurrentOutputSourceDrain(scenario, preparation);
    await assertCurrentOutputSetup(scenario, false);

    process.env.PAPERCLIP_QA_FILE_OWNER_LOCK_ROOT = lockRoot;
    const holder = await createQaFileOwnerRuntime({ qaFileOwnerLockRoot: lockRoot, qaFileOwnerPython: PYTHON! })
      .begin(scenario.files.map((file) => file.file));
    const resumedPromise = deliverQualityIntent(owned.db, { companyId: scenario.seeded.companyId, actionId: scenario.actionId });
    try {
      await waitForObservedLockWait(scenario.files[0]!.file, resumedPromise);
    } finally {
      await holder.close();
      await resumedPromise.catch(() => undefined);
    }
    const resumed = await resumedPromise;
    const completion = parseQaRemediationCompletion((await completionRows(scenario))[0]!.payload);
    expect(completion.wakes).toHaveLength(1);
    expect(resumed).toEqual({ status: "accepted", receiptId: completion.wakes[0]!.wakeupRequestId });
    await consumeAndSubmitOfficialPass(scenario, completion.wakes[0]!.wakeupRequestId);
    expect(await preparationRows(scenario)).toHaveLength(1);
    expect(await completionRows(scenario)).toHaveLength(1);
    expect(await useRows(scenario)).toHaveLength(1);
    expect(await qualityWakes(scenario)).toHaveLength(0);
  }, 180_000);

  it("blocks ordinary Quality delivery after completion-transaction uncertainty and recognizes the same bytes on reentry", async () => {
    const scenario = await seedCurrentOutputAction();
    await assertCurrentOutputSetup(scenario);
    await useProcessVerifier(scenario);
    const original = await readFile(scenario.files[0]!.file);
    const faultName = `c5_f1_completion_fault_${scenario.actionId.replaceAll("-", "")}`;
    await owned.db.execute(sql.raw(`CREATE FUNCTION ${faultName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type = 'qa_remediation_completed' AND NEW.workflow_run_id = '${scenario.seed.workflowRunId}'::uuid THEN RAISE EXCEPTION 'c5_f1_completion_fault'; END IF; RETURN NEW; END $$`));
    await owned.db.execute(sql.raw(`CREATE TRIGGER ${faultName} BEFORE INSERT ON workflow_transition_events FOR EACH ROW EXECUTE FUNCTION ${faultName}()`));
    let uncertain: Awaited<ReturnType<typeof deliverQualityIntent>> | undefined;
    const holder = await createQaFileOwnerRuntime({ qaFileOwnerLockRoot: lockRoot, qaFileOwnerPython: PYTHON! })
      .begin(scenario.files.map((file) => file.file));
    try {
      const delivery = deliverQualityIntent(owned.db, { companyId: scenario.seeded.companyId, actionId: scenario.actionId });
      await waitForObservedLockWait(scenario.files[0]!.file, delivery);
      expect(await preparationRows(scenario)).toHaveLength(1);
      await releaseSetupActuals(scenario);
      await holder.close();
      uncertain = await delivery;
    } finally {
      await releaseSetupActuals(scenario).catch(() => undefined);
      await holder.close();
      await owned.db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${faultName} ON workflow_transition_events`));
      await owned.db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${faultName}()`));
    }
    expect(uncertain!).toEqual({ status: "blocked", receiptId: null });
    expect(await readFile(scenario.files[0]!.file, "utf8")).toBe(scenario.files[0]!.after);
    expect(await completionRows(scenario)).toHaveLength(0);
    expect(await useRows(scenario)).toHaveLength(0);
    expect(await qualityWakes(scenario)).toHaveLength(0);
    const afterPublication = await stat(scenario.files[0]!.file);

    const resumed = await deliverQualityIntent(owned.db, { companyId: scenario.seeded.companyId, actionId: scenario.actionId });
    const completion = parseQaRemediationCompletion((await completionRows(scenario))[0]!.payload);
    expect(completion.wakes).toHaveLength(1);
    expect(resumed).toEqual({ status: "accepted", receiptId: completion.wakes[0]!.wakeupRequestId });
    await consumeAndSubmitOfficialPass(scenario, completion.wakes[0]!.wakeupRequestId);
    expect(await readFile(scenario.files[0]!.file)).not.toEqual(original);
    expect((await stat(scenario.files[0]!.file)).ino).toBe(afterPublication.ino);
    expect(await preparationRows(scenario)).toHaveLength(1);
    expect(await completionRows(scenario)).toHaveLength(1);
    expect(await useRows(scenario)).toHaveLength(1);
    expect(await qualityWakes(scenario)).toHaveLength(0);
  }, 180_000);

  it("refuses delivery when the original source attempt changed after binding", async () => {
    const scenario = await seedCurrentOutputAction();
    await assertCurrentOutputSetup(scenario);
    const exactBinding = scenario.binding;
    expect(exactBinding.stepRunId).toBe(scenario.seed.qaStepRunId);
    const [storedBinding] = await owned.db.select({ b: qualityActions.canonicalBinding }).from(qualityActions)
      .where(and(eq(qualityActions.companyId, scenario.seeded.companyId), eq(qualityActions.id, scenario.actionId)));
    const initialQaActuals = await owned.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, scenario.seeded.companyId), eq(heartbeatRuns.workflowStepRunId, scenario.seed.qaStepRunId),
    ));
    await owned.db.update(workflowStepRuns).set({ executionGeneration: 2 })
      .where(eq(workflowStepRuns.id, scenario.seed.producerStepRunId));
    let result: Awaited<ReturnType<typeof deliverQualityIntent>>;
    try {
      result = await deliverQualityIntent(owned.db, { companyId: scenario.seeded.companyId, actionId: scenario.actionId });
    } finally {
      await releaseSetupActuals(scenario).catch(() => undefined);
    }
    expect(result).toEqual({ status: "blocked", receiptId: null });
    expect(await qualityWakes(scenario)).toHaveLength(0);
    const [after] = await owned.db.select({ b: qualityActions.canonicalBinding }).from(qualityActions)
      .where(and(eq(qualityActions.companyId, scenario.seeded.companyId), eq(qualityActions.id, scenario.actionId)));
    expect(after!.b).toEqual(storedBinding!.b);
    const afterQaActuals = await owned.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, scenario.seeded.companyId), eq(heartbeatRuns.workflowStepRunId, scenario.seed.qaStepRunId),
    ));
    expect(afterQaActuals).toEqual(initialQaActuals);
  }, 120_000);
});
