import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agentWakeupRequests, agents, assets, heartbeatRuns, issues, issueAttachments, qualityActions, qualityActionGroups, qualityEvidenceRefs, qualityPolicyVersions, workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { hashContract } from "../services/quality/contract.js";
import { readVerifiedEvidenceUpload } from "../services/quality/evidence-store.js";
import { QA_REMEDIATION_PREPARATION_EVENT_TYPE, QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3, parseQaRemediationPreparation } from "../services/workflow/control-flow/qa-remediation-preparation-contract.js";
import { QA_REMEDIATION_COMPLETION_EVENT_TYPE, qaRemediationCompletionKey, qaRemediationRefireV2WakeKey } from "../services/workflow/control-flow/qa-remediation-completion.js";
import { createQaFileOwnerRuntime } from "../services/workflow/control-flow/qa-remediation-runtime.js";
import { reconcileQaRemediationReservation } from "../services/workflow/control-flow/qa-remediation-reconcile.js";
import type { QaFileOwnerRuntime } from "../services/workflow/control-flow/qa-remediation-runtime.js";
import type { FileOwnerPublishItem, QaRemediationFileOwner } from "../services/workflow/control-flow/qa-remediation-file-owner.js";
import { createReplacementRootNotifications, withReplacementRootNotificationDb } from "../services/issue-assignment-wakeup.js";
import { drainReplacementRootNotifications } from "../services/workflow/replacement-agent-delivery.js";
import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";
import { scheduleWorkflowStepRetry } from "../services/workflow/step-retry-scheduler.js";
import { submitWorkflowVerdict } from "../services/workflow/agent-api.js";
import { createQaCorrectionTestDb } from "./helpers/qa-correction-fixture.js";
import { seedQualityFixture } from "./helpers/quality-fixture.js";
import { reviewItemForAction } from "./helpers/quality-proofs.js";
import { deferred, within, PYTHON } from "./helpers/qa-remediation-parent-death-harness.js";

const ioHooks = vi.hoisted(() => ({ putFile: null as null | { entered: () => void; release: Promise<void> }, uploadCalls: 0 }));
vi.mock("../storage/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../storage/index.js")>();
  return { ...actual, getStorageService: () => new Proxy(actual.getStorageService(), {
    get(target, property, receiver) {
      if (property === "putFile") return async (input: Parameters<typeof target.putFile>[0]) => {
        ioHooks.uploadCalls += 1;
        const gate = ioHooks.putFile;
        if (gate) { gate.entered(); await gate.release; }
        return target.putFile(input);
      };
      return Reflect.get(target, property, receiver);
    },
  }) };
});
import { seedInternalQualityWorld, executeAdmissionFixtureAdapter } from "./helpers/qa-remediation-admission-public-fixture.js";
vi.mock("../adapters/index.js", async original => {
  const actual = await original<typeof import("../adapters/index.js")>();
  return { ...actual, getServerAdapter: (kind: string) => kind === "codex_local"
    ? { supportsLocalAgentJwt: false, execute: executeAdmissionFixtureAdapter } : actual.getServerAdapter(kind) };
});
const fixtureClosers = new Set<() => Promise<void>>();
afterEach(async () => { await Promise.all([...fixtureClosers].map(close => close())); fixtureClosers.clear(); });
const before = "old flawed draft\n", sha = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
type Owned = Awaited<ReturnType<typeof createQaCorrectionTestDb>>;
type Quality = Awaited<ReturnType<typeof seedQualityFixture>>;
type World = Awaited<ReturnType<typeof qualityRootWorld>>;
let owned: Owned, quality: Quality, root = "", storageRoot = "";
async function qualityRootWorld(withRetryBranch = false) {
  const dir = await realpath(await mkdtemp(path.join(root, "root-world-")));
  let file = path.join(dir, "report.md");
  const beforeBytes = Buffer.concat([Buffer.from([0xff]), Buffer.from(before)]);
  const beforeText = beforeBytes.toString("utf8"), afterText = beforeText.replace("flawed", "polished");
  await writeFile(file, beforeBytes);
  const world = await seedInternalQualityWorld(owned.db, dir, dir, { file,
    bytes: beforeBytes, find: "flawed", replace: "polished",
    existing: { companyId: quality.companyId, authorId: quality.authorAgentId, verifierId: quality.verifierAgentId } });
  file = world.file; fixtureClosers.add(world.close);
  await owned.db.update(issues).set({ originKind: "workflow_execution", originId: world.workflowRunId, originRunId: world.workflowRunId }).where(eq(issues.id, world.qaIssueId));
  let retryBranchStepId: string | undefined, retryBranchIssueId: string | undefined, retryBranchStepRunId: string | undefined;
  if (withRetryBranch) {
    const [run] = await owned.db.select({ workflowId: workflowRuns.workflowId }).from(workflowRuns).where(eq(workflowRuns.id, world.workflowRunId));
    const [definition] = await owned.db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, run!.workflowId));
    retryBranchStepId = `independent-${randomUUID().slice(0, 8)}`; retryBranchIssueId = randomUUID();
    const step = { id: retryBranchStepId, name: "Independent failed branch", agentId: quality.authorAgentId, dependencies: [] };
    await owned.db.update(workflowDefinitions).set({ stepsJson: [...(definition!.stepsJson as Array<Record<string, unknown>>), step] }).where(eq(workflowDefinitions.id, run!.workflowId));
    await owned.db.insert(issues).values({ id: retryBranchIssueId, companyId: quality.companyId, missionId: world.missionId, title: "independent-failed-branch",
      description: "Existing failed branch for a legitimate retry transition.", status: "todo", assigneeAgentId: quality.authorAgentId, originKind: "workflow_execution", originId: world.workflowRunId, originRunId: world.workflowRunId });
    const [branch] = await owned.db.insert(workflowStepRuns).values({ workflowRunId: world.workflowRunId, stepId: retryBranchStepId, issueId: retryBranchIssueId,
      status: "failed", completedAt: new Date(Date.now() - 20_000), executionGeneration: 1 }).returning(); retryBranchStepRunId = branch!.id;
  }
  const actionId = randomUUID(), intentKey = `root-${actionId.slice(0, 8)}`;
  const target = { kind: "current_output" as const, source: world.source }, effect = { kind: "repair_supported_output" as const, target };
  const { occurrenceId } = await reviewItemForAction(owned.db, quality.companyId, world.source, world.source.heartbeatRunId);
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  const retryEnvelope = { intentKey, targetHash: hashContract(target), effectHash: hashContract(effect), maxExecutorAttempts: 2,
    deadlineAt: expiresAt, groupId: quality.groupId, policyVersionId: quality.policyVersionId, maxCumulativeCostCents: 100 };
  const canonicalBinding = { companyId: quality.companyId, actionId, missionId: world.missionId, workflowRunId: world.workflowRunId,
    stepRunId: world.qaStepRunId, issueId: world.qaIssueId };
  await owned.db.insert(qualityActions).values({ id: actionId, companyId: quality.companyId, groupId: quality.groupId, kind: "current_output",
    occurrenceSetHash: hashContract([occurrenceId]), occurrenceIds: [occurrenceId], policyVersionId: quality.policyVersionId,
    scopeVersion: 1, target, targetHash: hashContract(target), effect, effectHash: hashContract(effect), retryEnvelope,
    revision: 1, state: "created", intentKey, canonicalBinding });
  const qaProgram = `const fs=require('node:fs'),v=fs.readFileSync(${JSON.stringify(file)},'utf8');console.log(JSON.stringify({verdict:v===${JSON.stringify(afterText)}?'pass':'request_changes',observed:v}));`;
  await owned.db.update(agents).set({ adapterType: "process", adapterConfig: { command: process.execPath, args: ["-e", qaProgram], cwd: root } })
    .where(eq(agents.id, quality.verifierAgentId));
  return { dir, file, actionId, world, request: { companyId: quality.companyId, missionId: world.missionId, workflowRunId: world.workflowRunId,
    producerStepRunId: world.producerStepRunId, qaStepRunIds: [world.qaStepRunId], qualityActionId: actionId }, beforeBytes, beforeText, afterText,
    retryBranchStepId, retryBranchIssueId, retryBranchStepRunId };
}
async function rootCall(w: World, runtime?: QaFileOwnerRuntime, notifications = createReplacementRootNotifications()) {
  const result = await withReplacementRootNotificationDb(owned.db, notifications, () => reconcileQaRemediationReservation(owned.db, w.request, runtime));
  return { result, notifications };
}
async function nativeRoot(w: World) {
  const lockRoot = await realpath(await mkdtemp(path.join(w.dir, ".lock-"))); await chmod(lockRoot, 0o700);
  return { lockRoot, runtime: createQaFileOwnerRuntime({ qaFileOwnerLockRoot: lockRoot, qaFileOwnerPython: PYTHON! }),
    cleanup: () => rm(lockRoot, { recursive: true, force: true }) };
}
async function effects(w: World) {
  const [uses, companyAssets, attachments, activities, completions, preparations, wakes, heartbeatRows] = await Promise.all([
    owned.db.select().from(qualityEvidenceRefs).where(eq(qualityEvidenceRefs.qualityActionId, w.actionId)), owned.db.select().from(assets).where(eq(assets.companyId, quality.companyId)),
    owned.db.select().from(issueAttachments).where(and(eq(issueAttachments.companyId, quality.companyId), eq(issueAttachments.issueId, w.world.qaIssueId))), owned.db.select().from(activityLog).where(eq(activityLog.companyId, quality.companyId)),
    owned.db.select().from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.workflowRunId, w.world.workflowRunId), eq(workflowTransitionEvents.eventType, QA_REMEDIATION_COMPLETION_EVENT_TYPE))),
    owned.db.select().from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.workflowRunId, w.world.workflowRunId), eq(workflowTransitionEvents.eventType, QA_REMEDIATION_PREPARATION_EVENT_TYPE))),
    owned.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.workflowRunId, w.world.workflowRunId)), owned.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, quality.companyId)),
  ]);
  return { uses: uses.length, assets: companyAssets.length, attachments: attachments.length, activities: activities.length, completions: completions.length,
    preparations: preparations.length, wakes: wakes.length, heartbeatIds: heartbeatRows.map(row => row.id).sort() };
}
async function failUseLink() {
  await owned.db.execute(sql.raw("CREATE FUNCTION c5_e_root_extra_fail_use() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'c5_e_root_extra_link_fault'; END $$"));
  await owned.db.execute(sql.raw("CREATE TRIGGER c5_e_root_extra_fail_use BEFORE INSERT ON quality_evidence_refs FOR EACH ROW EXECUTE FUNCTION c5_e_root_extra_fail_use()"));
}
async function clearUseLinkFault() {
  await owned.db.execute(sql.raw("DROP TRIGGER IF EXISTS c5_e_root_extra_fail_use ON quality_evidence_refs"));
  await owned.db.execute(sql.raw("DROP FUNCTION IF EXISTS c5_e_root_extra_fail_use()"));
}

describe.sequential("C5 E-root extra", () => {
  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "c5-e-root-extra-"))); storageRoot = path.join(root, "storage");
    vi.stubEnv("PAPERCLIP_QA_FILE_OWNER_LOCK_ROOT", root);
    vi.stubEnv("PAPERCLIP_QA_FILE_OWNER_PYTHON", PYTHON!);
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk"); vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", storageRoot); owned = await createQaCorrectionTestDb(); quality = await seedQualityFixture(owned.db);
  }, 120_000);
  afterAll(async () => { await owned?.close(); vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); }, 120_000);

  it("observes upload without DB locks and Quality prefix before mission/run locks", async () => {
    const w = await qualityRootWorld(), lock = await nativeRoot(w), observer = owned.connect(), lockProbe = owned.connect();
    const entered = deferred<void>(), releaseUpload = deferred<void>(), holderLocked = deferred<void>(), holderReleased = deferred<void>();
    const actionQuerySent = deferred<{ connection: number; index: number }>(), queries: { connection: number; query: string; parameters: unknown[] }[] = [];
    const notifications = createReplacementRootNotifications();
    ioHooks.uploadCalls = 0; ioHooks.putFile = { entered: () => entered.resolve(undefined), release: releaseUpload.promise };
    const debugClient = owned.db.$client as unknown as { options: { debug: unknown } }, previousDebug = debugClient.options.debug;
    const transactionDepth = new Map<number, number>();
    let watchSecondTx = false, rootPromise: ReturnType<typeof rootCall>, holderPromise: Promise<unknown> | null = null, lockProbeResult = "", transactionDepthAtUpload = -1;
    let transactionStart = 0, blocked: { connection: number; index: number } | undefined;
    debugClient.options.debug = (connection: number, query: string, parameters: unknown[]) => {
      const normalized = query.trim().toLowerCase();
      queries.push({ connection, query: normalized, parameters });
      if (/^begin\b/.test(normalized)) transactionDepth.set(connection, (transactionDepth.get(connection) ?? 0) + 1);
      if (/^(commit|rollback)\b/.test(normalized)) transactionDepth.set(connection, Math.max(0, (transactionDepth.get(connection) ?? 0) - 1));
      if (watchSecondTx && /from "?quality_actions"?/.test(normalized) && /for update/.test(normalized)) actionQuerySent.resolve({ connection, index: queries.length - 1 });
    };
    const originalTransaction = owned.db.transaction, backendPids = new Map<number, number>(); let observedTx = 0;
    owned.db.transaction = ((work, ...options) => originalTransaction.call(owned.db, async tx => {
      const query = `select pg_backend_pid() as pid /* root-observer-${++observedTx} */`;
      const rows = await tx.execute(sql.raw(query)) as unknown as Array<{ pid: number }>;
      const sent = queries.find(entry => entry.query === query);
      if (sent) backendPids.set(sent.connection, rows[0]!.pid);
      return work(tx);
    }, ...options)) as typeof owned.db.transaction;
    rootPromise = rootCall(w, lock.runtime, notifications);
    try {
      await within(entered.promise, "storage upload entry");
      transactionDepthAtUpload = [...transactionDepth.values()].reduce((sum, depth) => sum + depth, 0);
      await lockProbe.$client.begin(async tx => { await tx`select id from quality_action_groups where id=${quality.groupId} for update nowait`;
        await tx`select id from quality_actions where id=${w.actionId} for update nowait`; await tx`select id from quality_policy_versions where id=${quality.policyVersionId} for update nowait`;
        await tx`select id from missions where id=${w.world.missionId} for update nowait`; await tx`select id from workflow_runs where id=${w.world.workflowRunId} for update nowait`; });
      holderPromise = observer.$client.begin(async tx => {
        await tx`select id from quality_actions where id=${w.actionId} for update`;
        holderLocked.resolve(undefined); await holderReleased.promise;
      });
      await within(holderLocked.promise, "Quality action barrier");
      transactionStart = queries.length; watchSecondTx = true; releaseUpload.resolve(undefined);
      blocked = await within(actionQuerySent.promise, "Quality action lock query after upload");
      try {
        await lockProbe.$client.begin(async tx => { await tx`select id from missions where id=${w.world.missionId} for update nowait`;
          await tx`select id from workflow_runs where id=${w.world.workflowRunId} for update nowait`; });
        lockProbeResult = "mission/run locks available while root waits for Quality action";
      } catch (error) { lockProbeResult = error instanceof Error ? error.message : String(error); }
      holderReleased.resolve(undefined); await holderPromise;
    } finally {
      releaseUpload.resolve(undefined); holderReleased.resolve(undefined); ioHooks.putFile = null;
      if (holderPromise) await holderPromise;
      await Promise.allSettled([rootPromise]);
      try { await drainReplacementRootNotifications(owned.db, notifications); await w.world.close(); await waitForHeartbeatExecutionsToDrain(owned.db); }
      finally { owned.db.transaction = originalTransaction; debugClient.options.debug = previousDebug; await lock.cleanup(); }
    }
    const result = await rootPromise;
    expect(transactionDepthAtUpload).toBe(0);
    expect(lockProbeResult).toBe("mission/run locks available while root waits for Quality action");
    expect(blocked).toBeDefined();
    const window = (after: number) => {
      const action = queries.findIndex((e, i) => i >= after && e.query.includes('from "quality_actions"')
        && e.query.includes("for update") && e.parameters.includes(w.actionId));
      const connection = queries[action]?.connection;
      let begin = -1; queries.forEach((e, i) => { if (i < action && e.connection === connection && /^begin\b/.test(e.query)) begin = i; });
      return { begin, connection, backendPid: connection === undefined ? undefined : backendPids.get(connection), actionId: w.actionId,
        end: queries.findIndex((e, i) => i > action && e.connection === connection && /^(commit|rollback)\b/.test(e.query)) };
    };
    const firstTx = window(transactionStart), secondTx = window(firstTx.end + 1);
    const find = (tx: { begin: number; end: number; connection: number | undefined }, table: string, lockMode: string) => queries.findIndex((e, i) => i > tx.begin && i < tx.end
      && e.connection === tx.connection && e.query.includes(`from "${table}"`) && e.query.includes(lockMode));
    const orderFor = (tx: { begin: number; end: number; connection: number | undefined }) => [find(tx, "quality_policy_usage", "for update"), find(tx, "quality_action_groups", "for update"), find(tx, "quality_actions", "for update"), find(tx, "quality_policy_versions", "for share"), find(tx, "missions", "for no key update"), find(tx, "workflow_runs", "for no key update")];
    const firstOrder = orderFor(firstTx), secondOrder = orderFor(secondTx), order = [...firstOrder, ...secondOrder];
    expect(blocked!.index).toBe(firstOrder[2]);
    expect(firstTx.begin).toBeGreaterThanOrEqual(transactionStart); expect(firstTx.end).toBeGreaterThan(blocked!.index); expect(secondTx.begin).toBeGreaterThan(firstTx.end);
    expect(firstTx.end > firstOrder[5]!).toBe(true); expect(secondTx.end > secondOrder[5]!).toBe(true);
    expect(order.every((value, index) => value >= 0 && (index === 0 || index === 6 || value > order[index - 1]!)), JSON.stringify({ firstTx, secondTx, firstOrder, secondOrder })).toBe(true);
    console.info("C5 same-connection lock SQL", JSON.stringify({ firstTx, secondTx, first: firstOrder.map(i => [i, queries[i]?.query]), second: secondOrder.map(i => [i, queries[i]?.query]) }));
    expect(result.result).toMatchObject({ outcome: "completed" }); expect(ioHooks.uploadCalls).toBe(1);
    expect(await readFile(w.file, "utf8")).toBe(w.afterText);
  }, 120_000);

  it("reuses the exact completion after native wait and a real downstream authority bump", async () => {
    const w = await qualityRootWorld(true), native = await nativeRoot(w);
    const ownerAcquired = deferred<void>(), allowBTransaction = deferred<void>(), publishEntered = deferred<void>(), allowPublish = deferred<void>(), committed = deferred<void>(), allowClose = deferred<void>();
    const lockWait = deferred<{ readonly type: "lock_wait"; readonly target: string }>(), base = native.runtime;
    const ownerRuntime: QaFileOwnerRuntime = { capability: base.capability, async begin(targets, options = {}) {
      const owner = await base.begin(targets, options);
      ownerAcquired.resolve(undefined); await allowBTransaction.promise;
      return { targets: () => owner.targets(), publish: async (items: readonly FileOwnerPublishItem[]) => {
        publishEntered.resolve(undefined); await allowPublish.promise; return owner.publish(items);
      }, close: async () => { committed.resolve(undefined); await allowClose.promise; return owner.close(); },
      abort: () => owner.abort(), awaitExit: () => owner.awaitExit() } as QaRemediationFileOwner;
    } };
    const waitingRuntime: QaFileOwnerRuntime = { capability: base.capability, begin: (targets, options = {}) => base.begin(targets, {
      ...options, onEvent: event => { if (event.type === "lock_wait") lockWait.resolve(event); options.onEvent?.(event); },
    }) };
    const bNotifications = createReplacementRootNotifications(), fastNotifications = createReplacementRootNotifications();
    ioHooks.uploadCalls = 0; const bPromise = rootCall(w, ownerRuntime, bNotifications);
    let aPromise: ReturnType<typeof rootCall> | null = null;
    try {
      await within(ownerAcquired.promise, "B actual native owner before final transaction");
      aPromise = rootCall(w, waitingRuntime);
      expect((await within(lockWait.promise, "A actual native lock_wait")).target).toBe(w.file); allowBTransaction.resolve(undefined);
      await within(publishEntered.promise, "B publication barrier after A lock_wait");
      allowPublish.resolve(undefined); await within(committed.promise, "B committed before native close");
      const [prepRow] = await owned.db.select().from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.workflowRunId, w.world.workflowRunId), eq(workflowTransitionEvents.eventType, QA_REMEDIATION_PREPARATION_EVENT_TYPE)));
      const prep = parseQaRemediationPreparation(prepRow!.payload);
      const [completionRow] = await owned.db.select().from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.companyId, quality.companyId),
        eq(workflowTransitionEvents.idempotencyKey, qaRemediationCompletionKey(prep)), eq(workflowTransitionEvents.eventType, QA_REMEDIATION_COMPLETION_EVENT_TYPE)));
      const [wake] = await owned.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, qaRemediationRefireV2WakeKey(prep, prep.verdicts[0]!.qa.stepRunId, prep.verdicts[0]!.eventId)));
      expect(wake).toMatchObject({ status: "queued", requestKind: "workflow_resume", workflowStepRunId: prep.verdicts[0]!.qa.stepRunId });
      const afterStat = await stat(w.file), afterBytes = await readFile(w.file);
      const fast = await rootCall(w, undefined, fastNotifications);
      expect(fast.result).toMatchObject({ outcome: "completed", created: false, completionEventId: completionRow!.id });
      if (fast.result.outcome !== "completed") throw new Error("historical fast path did not reuse completion");
      expect(fast.result.completion.wakes.map(row => row.wakeupRequestId)).toEqual([wake!.id]);
      expect(fastNotifications.agentIds.has(wake!.agentId)).toBe(true);
      expect(fastNotifications.correctionWakeupRequestIds.size).toBe(0);
      await drainReplacementRootNotifications(owned.db, fastNotifications); await w.world.close(); await waitForHeartbeatExecutionsToDrain(owned.db);
      const heartbeatRows = await owned.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, wake!.id));
      const [wakeAfterDrain] = await owned.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake!.id));
      expect(heartbeatRows).toHaveLength(1);
      const heartbeat = heartbeatRows[0]!;
      console.info("C5 original wake before stdout", JSON.stringify({ wake: { id: wakeAfterDrain!.id, status: wakeAfterDrain!.status, agentId: wakeAfterDrain!.agentId,
        issueId: wakeAfterDrain!.issueId, workflowStepRunId: wakeAfterDrain!.workflowStepRunId, workflowExecutionGeneration: wakeAfterDrain!.workflowExecutionGeneration },
        heartbeat: { id: heartbeat.id, status: heartbeat.status, errorCode: heartbeat.errorCode, error: heartbeat.error,
          wakeupRequestId: heartbeat.wakeupRequestId, agentId: heartbeat.agentId, issueId: heartbeat.issueId,
          workflowStepRunId: heartbeat.workflowStepRunId, workflowExecutionGeneration: heartbeat.workflowExecutionGeneration, resultJson: heartbeat.resultJson } }));
      expect(heartbeat.resultJson).not.toBeNull();
      const output = JSON.parse((heartbeat.resultJson as { stdout: string }).stdout) as { verdict: string; observed: string };
      expect(output).toMatchObject({ verdict: "pass", observed: w.afterText });
      const [issue] = await owned.db.select().from(issues).where(eq(issues.id, wake!.issueId));
      await submitWorkflowVerdict({ db: owned.db, issue: issue!, actor: { actorType: "agent", actorId: wake!.agentId, agentId: wake!.agentId, runId: heartbeat.id },
        data: { verdict: output.verdict as "pass" } });
      const [afterVerdict] = await owned.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake!.id)); expect(afterVerdict!.status).not.toBe("queued");
      const [runBefore] = await owned.db.select().from(workflowRuns).where(eq(workflowRuns.id, w.world.workflowRunId)); const [branch] = await owned.db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, w.retryBranchStepRunId!));
      const [branchIssue] = await owned.db.select().from(issues).where(eq(issues.id, w.retryBranchIssueId!)); const [definition] = await owned.db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, runBefore!.workflowId));
      expect(["running", "failed"]).toContain(runBefore!.status); expect(branch).toMatchObject({ workflowRunId: w.world.workflowRunId, stepId: w.retryBranchStepId, issueId: w.retryBranchIssueId, status: "failed", retryCount: 0 });
      expect(branchIssue!.missionId).toBe(w.world.missionId); expect((definition!.stepsJson as Array<{ id: string }>).some(step => step.id === w.retryBranchStepId)).toBe(true);
      const [qaBeforeRetry] = await owned.db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, w.world.qaStepRunId)); const wakeIdsBeforeRetry = (await owned.db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(eq(agentWakeupRequests.workflowRunId, w.world.workflowRunId))).map(row => row.id);
      const retry = await scheduleWorkflowStepRetry(owned.db, { companyId: quality.companyId, workflowRunId: w.world.workflowRunId,
        stepRunId: branch!.id, retryNumber: branch!.retryCount + 1, maxRetries: 2, delaySeconds: 3600, observedStatus: branch!.status,
        observedRetryCount: branch!.retryCount, observedCompletedAt: branch!.completedAt, observedLastDispatchRequestId: branch!.lastDispatchRequestId,
        observedMetadataSnapshot: (branch!.metadata ?? {}) as Record<string, unknown>, observedExecutionGeneration: branch!.executionGeneration,
        errorSummary: "independent pre-existing branch retry" });
      expect(retry.result).toBe("scheduled");
      const [runAfter] = await owned.db.select().from(workflowRuns).where(eq(workflowRuns.id, w.world.workflowRunId)); const [branchAfter] = await owned.db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, branch!.id));
      const [qaAfterRetry] = await owned.db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, w.world.qaStepRunId)); const wakeIdsAfterRetry = (await owned.db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(eq(agentWakeupRequests.workflowRunId, w.world.workflowRunId))).map(row => row.id);
      expect(runAfter).toMatchObject({ status: "running", dispatchAuthorityVersion: runBefore!.dispatchAuthorityVersion + 1 }); expect(branchAfter).toMatchObject({ status: "pending", retryCount: branch!.retryCount + 1 });
      expect(qaAfterRetry).toMatchObject({ status: qaBeforeRetry!.status, retryCount: qaBeforeRetry!.retryCount, executionGeneration: qaBeforeRetry!.executionGeneration });
      expect(wakeIdsAfterRetry).toEqual(wakeIdsBeforeRetry);
      const effectsBeforeA = await effects(w);
      allowClose.resolve(undefined);
      const [b, a] = await Promise.all([within(bPromise, "B clean native exit"), within(aPromise, "A final TX after B")]);
      expect(b.result).toMatchObject({ outcome: "completed", created: true });
      expect(a.result).toMatchObject({ outcome: "completed", created: false, completionEventId: b.result.outcome === "completed" ? b.result.completionEventId : "" });
      if (b.result.outcome !== "completed" || a.result.outcome !== "completed") throw new Error("race root did not return committed completion");
      expect(a.result.completion.qualityUseEvidenceRefId).toBe(b.result.completion.qualityUseEvidenceRefId);
      expect(a.result.completion.wakes.map(row => row.wakeupRequestId)).toEqual(b.result.completion.wakes.map(row => row.wakeupRequestId));
      expect(a.result.notifications.wakeupRequestIds).toContain(wake!.id);
      expect(a.notifications.agentIds.size).toBe(0); expect(a.notifications.correctionWakeupRequestIds.size).toBe(0);
      expect(a.result.publication).toEqual([]);
      expect(await effects(w)).toEqual(effectsBeforeA); expect(ioHooks.uploadCalls).toBe(1);
      expect(await readFile(w.file)).toEqual(afterBytes); expect((await stat(w.file)).ino).toBe(afterStat.ino);
      await drainReplacementRootNotifications(owned.db, bNotifications); await w.world.close(); await waitForHeartbeatExecutionsToDrain(owned.db);
      const afterBothDrains = await owned.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, wake!.id)); expect(afterBothDrains.map(row => row.id)).toEqual([heartbeat.id]);
    } finally {
      allowBTransaction.resolve(undefined); allowPublish.resolve(undefined); allowClose.resolve(undefined);
      await Promise.allSettled(aPromise ? [bPromise, aPromise] : [bPromise]);
      try { await drainReplacementRootNotifications(owned.db, fastNotifications); await drainReplacementRootNotifications(owned.db, bNotifications); await w.world.close(); await waitForHeartbeatExecutionsToDrain(owned.db); }
      finally { await native.cleanup(); }
    }
  }, 180_000);

  it("rolls back link effects but preserves the prepared upload and published after-file", async () => {
    const w = await qualityRootWorld(), native = await nativeRoot(w), notifications = createReplacementRootNotifications();
    const initial = await effects(w), initialWakes = (await owned.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.workflowRunId, w.world.workflowRunId))).map(row => row.id);
    const beforeFile = await stat(w.file); ioHooks.uploadCalls = 0; await failUseLink();
    let failed: Awaited<ReturnType<typeof rootCall>> | undefined;
    try { failed = await rootCall(w, native.runtime, notifications); } finally { await clearUseLinkFault(); await native.cleanup(); }
    expect(failed?.result).toMatchObject({ outcome: "held", reason: "transaction_outcome_unknown" });
    const afterFailure = await effects(w);
    expect(afterFailure).toMatchObject({ uses: initial.uses, assets: initial.assets, attachments: initial.attachments,
      activities: initial.activities, completions: initial.completions, wakes: initial.wakes, preparations: 1, heartbeatIds: initial.heartbeatIds });
    expect(notifications.agentIds.size).toBe(0); expect(notifications.correctionWakeupRequestIds.size).toBe(0);
    const [prepRow] = await owned.db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.workflowRunId, w.world.workflowRunId), eq(workflowTransitionEvents.eventType, QA_REMEDIATION_PREPARATION_EVENT_TYPE)));
    const prep = parseQaRemediationPreparation(prepRow!.payload);
    expect(prep.preparationId).toBe(prepRow!.id);
    expect((await readVerifiedEvidenceUpload(quality.companyId, prep.qualityBinding.uploadedEvidence)).length).toBeGreaterThan(0);
    expect((await owned.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.workflowRunId, w.world.workflowRunId))).map(row => row.id)).toEqual(initialWakes);
    expect(await readFile(w.file)).toEqual(Buffer.from(w.afterText));
    expect((await stat(w.file)).ino).not.toBe(beforeFile.ino);
    await drainReplacementRootNotifications(owned.db, notifications);
    expect(await effects(w)).toEqual(afterFailure); expect(ioHooks.uploadCalls).toBe(1);
  }, 180_000);
});
