import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { agentWakeupRequests, agents, assets, heartbeatRuns, issues, issueAttachments, qualityActions, qualityEvidenceRefs, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { hashContract } from "../services/quality/contract.js";
import { uploadEvidence, readVerifiedEvidenceUpload } from "../services/quality/evidence-store.js";
import { getStorageService } from "../storage/index.js";
import { QA_REMEDIATION_PREPARATION_EVENT_TYPE, QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3, parseQaRemediationPreparation } from "../services/workflow/control-flow/qa-remediation-preparation-contract.js";
import { buildQaRemediationPreparationCandidate } from "../services/workflow/control-flow/qa-remediation-prepare.js";
import { prepareQaRemediationQualityReservation } from "../services/workflow/control-flow/qa-remediation-quality-root.js";
import { writeQaRemediationPreparation } from "../services/workflow/control-flow/qa-remediation-preparation-writer.js";
import { qaRemediationQualityBindingHash } from "../services/workflow/control-flow/qa-remediation-quality-binding.js";
import { completeQaRemediationReservation, QA_REMEDIATION_COMPLETION_EVENT_TYPE,
  QA_REMEDIATION_COMPLETION_SCHEMA_VERSION, qaRemediationCompletionKey, qaRemediationRefireV2WakeKey } from "../services/workflow/control-flow/qa-remediation-completion.js";
import { publishQaRemediationPreparation } from "../services/workflow/control-flow/qa-remediation-publication.js";
import { createQaFileOwnerRuntime } from "../services/workflow/control-flow/qa-remediation-runtime.js";
import { reconcileQaRemediationReservation } from "../services/workflow/control-flow/qa-remediation-reconcile.js";
import { createReplacementRootNotifications, withReplacementRootNotificationDb } from "../services/issue-assignment-wakeup.js";
import { drainReplacementRootNotifications } from "../services/workflow/replacement-agent-delivery.js";
import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";
import { submitWorkflowVerdict } from "../services/workflow/agent-api.js";
import { createQaCorrectionTestDb } from "./helpers/qa-correction-fixture.js";
import { seedQualityFixture } from "./helpers/quality-fixture.js";
import { reviewItemForAction } from "./helpers/quality-proofs.js";
import { PYTHON } from "./helpers/qa-remediation-parent-death-harness.js";

import { seedInternalQualityWorld, executeAdmissionFixtureAdapter } from "./helpers/qa-remediation-admission-public-fixture.js";
vi.mock("../adapters/index.js", async original => {
  const actual = await original<typeof import("../adapters/index.js")>();
  return { ...actual, getServerAdapter: (kind: string) => kind === "codex_local"
    ? { supportsLocalAgentJwt: false, execute: executeAdmissionFixtureAdapter } : actual.getServerAdapter(kind) };
});
const fixtureClosers = new Set<() => Promise<void>>();
afterEach(async () => { await Promise.all([...fixtureClosers].map(close => close())); fixtureClosers.clear(); });
const before = "old flawed draft\n", after = "old polished draft\n", uploadBytes = Buffer.from("{\"proof\":\"frozen\"}");
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
let owned: Awaited<ReturnType<typeof createQaCorrectionTestDb>>;
let quality: Awaited<ReturnType<typeof seedQualityFixture>>;
let root = "", storageRoot = "";

async function prepared(withQuality: boolean) {
  const dir = await realpath(await mkdtemp(path.join(root, "world-")));
  let file = path.join(dir, "report.md");
  await writeFile(file, before);
  const world = await seedInternalQualityWorld(owned.db, dir, dir, { file,
    bytes: Buffer.from(before), find: "flawed", replace: "polished",
    existing: { companyId: quality.companyId, authorId: quality.authorAgentId, verifierId: quality.verifierAgentId } });
  file = world.file; fixtureClosers.add(world.close);
  let binding: import("../services/workflow/control-flow/qa-remediation-quality-binding.js").QaRemediationQualityBinding | undefined;
  let scope: { actionId: string; bindingHash: string } | undefined;
  if (withQuality) {
    const actionId = randomUUID(), intentKey = `settle-${actionId.slice(0, 8)}`;
    const target = { kind: "current_output" as const, source: world.source };
    const effect = { kind: "repair_supported_output" as const, target };
    const { reviewItemId, occurrenceId } = await reviewItemForAction(owned.db, quality.companyId, world.source, world.source.heartbeatRunId);
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    const retryEnvelope = { intentKey, targetHash: hashContract(target), effectHash: hashContract(effect), maxExecutorAttempts: 2,
      deadlineAt: expiresAt, groupId: quality.groupId, policyVersionId: quality.policyVersionId, maxCumulativeCostCents: 100 };
    const canonicalBinding = { companyId: quality.companyId, actionId, missionId: world.missionId,
      workflowRunId: world.workflowRunId, stepRunId: world.qaStepRunId, issueId: world.qaIssueId };
    await owned.db.insert(qualityActions).values({ id: actionId, companyId: quality.companyId,
      groupId: quality.groupId, kind: "current_output", occurrenceSetHash: hashContract([occurrenceId]), occurrenceIds: [occurrenceId],
      policyVersionId: quality.policyVersionId, scopeVersion: 1, target, targetHash: hashContract(target), effect, effectHash: hashContract(effect),
      retryEnvelope, revision: 1, state: "created", intentKey, canonicalBinding });
    const uploaded = await uploadEvidence(getStorageService(), { companyId: quality.companyId, body: uploadBytes,
      contentType: "application/json", originalFilename: "proof.json" });
    binding = { kind: "quality_current_output", actionId, groupId: quality.groupId, policyVersionId: quality.policyVersionId,
      intentKey, targetHash: hashContract(target), effectHash: hashContract(effect), retryEnvelopeHash: hashContract(retryEnvelope),
      source: world.source, sourceAttemptHash: hashContract(world.source), canonicalBinding, reviewItemId,
      verifierRunId: world.verdictHeartbeatId, verifierEpoch: world.verifierEpoch,
      fileHashes: [{ file, before: sha(before), after: sha(after) }], uploadedEvidence: uploaded, expiresAt };
    scope = { actionId, bindingHash: qaRemediationQualityBindingHash(binding) };
  }
  const request = { companyId: quality.companyId, missionId: world.missionId, workflowRunId: world.workflowRunId,
    producerStepRunId: world.producerStepRunId, qaStepRunIds: [world.qaStepRunId], ...(scope ? { qualityActionId: scope.actionId } : {}) };
  const candidate = await owned.db.transaction(tx => buildQaRemediationPreparationCandidate(tx, request, scope));
  if (candidate.outcome !== "candidate") throw new Error(`preparation candidate ${candidate.outcome}: ${candidate.detail}`);
  const preparation = binding ? parseQaRemediationPreparation({ ...candidate.preparation,
    schemaVersion: QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3, qualityBinding: binding }) : candidate.preparation;
  const stored = await owned.db.transaction(tx => writeQaRemediationPreparation(tx, preparation, candidate.scope));
  if (stored.outcome !== "prepared") throw new Error(`preparation write ${stored.outcome}: ${stored.detail}`);
  return { preparation: stored.preparation, file, dir, binding };
}

async function qualityRootWorld() {
  const dir = await realpath(await mkdtemp(path.join(root, "root-world-")));
  let file = path.join(dir, "report.md");
  const beforeBytes = Buffer.concat([Buffer.from([0xff]), Buffer.from(before)]), beforeText = beforeBytes.toString("utf8");
  const afterText = beforeText.replace("flawed", "polished");
  await writeFile(file, beforeBytes);
  const world = await seedInternalQualityWorld(owned.db, dir, dir, { file,
    bytes: beforeBytes, find: "flawed", replace: "polished",
    existing: { companyId: quality.companyId, authorId: quality.authorAgentId, verifierId: quality.verifierAgentId } });
  file = world.file; fixtureClosers.add(world.close);
  await owned.db.update(issues).set({ originKind: "workflow_execution", originId: world.workflowRunId, originRunId: world.workflowRunId }).where(eq(issues.id, world.qaIssueId));
  const actionId = randomUUID(), intentKey = `root-${actionId.slice(0, 8)}`;
  const target = { kind: "current_output" as const, source: world.source }, effect = { kind: "repair_supported_output" as const, target };
  const { occurrenceId } = await reviewItemForAction(owned.db, quality.companyId, world.source, world.source.heartbeatRunId);
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  const retryEnvelope = { intentKey, targetHash: hashContract(target), effectHash: hashContract(effect), maxExecutorAttempts: 2,
    deadlineAt: expiresAt, groupId: quality.groupId, policyVersionId: quality.policyVersionId, maxCumulativeCostCents: 100 };
  const canonicalBinding = { companyId: quality.companyId, actionId, missionId: world.missionId,
    workflowRunId: world.workflowRunId, stepRunId: world.qaStepRunId, issueId: world.qaIssueId };
  await owned.db.insert(qualityActions).values({ id: actionId, companyId: quality.companyId, groupId: quality.groupId,
    kind: "current_output", occurrenceSetHash: hashContract([occurrenceId]), occurrenceIds: [occurrenceId],
    policyVersionId: quality.policyVersionId, scopeVersion: 1, target, targetHash: hashContract(target), effect,
    effectHash: hashContract(effect), retryEnvelope, revision: 1, state: "created", intentKey, canonicalBinding });
  const qaProgram = `const fs=require('node:fs'),v=fs.readFileSync(${JSON.stringify(file)},'utf8');console.log(JSON.stringify({verdict:v===${JSON.stringify(afterText)}?'pass':'request_changes',observed:v}));`;
  await owned.db.update(agents).set({ adapterType: "process", adapterConfig: { command: process.execPath, args: ["-e", qaProgram], cwd: root } })
    .where(eq(agents.id, quality.verifierAgentId));
  return { dir, file, actionId, world, request: { companyId: quality.companyId, missionId: world.missionId,
    workflowRunId: world.workflowRunId, producerStepRunId: world.producerStepRunId,
    qaStepRunIds: [world.qaStepRunId], qualityActionId: actionId }, beforeBytes, beforeText, afterText, expiresAt };
}
async function publicRoot(request: Parameters<typeof reconcileQaRemediationReservation>[1], dir: string, notifications = createReplacementRootNotifications()) {
  const lockRoot = await realpath(await mkdtemp(path.join(dir, ".root-lock-")));
  await chmod(lockRoot, 0o700);
  const runtime = createQaFileOwnerRuntime({ qaFileOwnerLockRoot: lockRoot, qaFileOwnerPython: PYTHON! });
  try { return await withReplacementRootNotificationDb(owned.db, notifications,
    () => reconcileQaRemediationReservation(owned.db, request, runtime)); }
  finally { await rm(lockRoot, { recursive: true, force: true }); }
}

async function continueFromCompletionWake(w: Awaited<ReturnType<typeof qualityRootWorld>>, completion: { wakes: readonly { wakeupRequestId: string; agentId: string; issueId: string; stepRunId: string }[] }, notifications: ReturnType<typeof createReplacementRootNotifications>) {
  const wake = completion.wakes[0]!, [wakeRow] = await owned.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.wakeupRequestId));
  expect(wakeRow).toMatchObject({ id: wake.wakeupRequestId, requestKind: "workflow_resume", agentId: wake.agentId, issueId: wake.issueId, workflowRunId: w.world.workflowRunId, workflowStepRunId: wake.stepRunId });
  await drainReplacementRootNotifications(owned.db, notifications); await w.world.close(); await waitForHeartbeatExecutionsToDrain(owned.db);
  const [run] = await owned.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, wake.wakeupRequestId)); if (!run?.workflowStepRunId) throw new Error("queued workflow-resume heartbeat lacks its exact issue/step-run binding");
  expect(run).toMatchObject({ wakeupRequestId: wake.wakeupRequestId, agentId: wake.agentId, issueId: wake.issueId, workflowStepRunId: wake.stepRunId });
  const output = JSON.parse((run.resultJson as { stdout: string }).stdout) as { verdict: "pass" | "request_changes"; observed: string }; expect(run.status).toBe("succeeded"); expect(output).toMatchObject({ verdict: "pass", observed: w.afterText });
  const [issue] = await owned.db.select().from(issues).where(eq(issues.id, run.issueId)), [stepRun] = await owned.db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, run.workflowStepRunId));
  expect(issue).toMatchObject({ id: run.issueId, originKind: "workflow_execution", originId: w.world.workflowRunId, originRunId: w.world.workflowRunId }); expect(stepRun).toMatchObject({ id: run.workflowStepRunId, workflowRunId: w.world.workflowRunId, issueId: run.issueId });
  await submitWorkflowVerdict({ db: owned.db, issue: issue!, actor: { actorType: "agent", actorId: wake.agentId, agentId: wake.agentId, runId: run!.id }, data: { verdict: output.verdict } });
}

async function publish(preparation: Awaited<ReturnType<typeof prepared>>["preparation"], allowedDir: string) {
  const lockRoot = await realpath(await mkdtemp(path.join(root, "lock-")));
  await chmod(lockRoot, 0o700);
  const runtime = createQaFileOwnerRuntime({ qaFileOwnerLockRoot: lockRoot, qaFileOwnerPython: PYTHON! });
  const owner = await runtime.begin(preparation.files.map(file => file.path));
  try {
    const result = await publishQaRemediationPreparation(preparation, { reservationEventId: preparation.preparationId,
      dispatchAuthorityVersion: preparation.dispatchAuthorityVersion, allowedFiles: new Set(), allowedDirs: [allowedDir] }, owner);
    if (result.outcome !== "published") throw new Error(`publication ${result.outcome}: ${result.detail}`);
    return result;
  } finally {
    expect(await owner.close()).toEqual({ code: 0, signal: null });
    await rm(lockRoot, { recursive: true, force: true });
  }
}

async function settle(preparation: Awaited<ReturnType<typeof prepared>>["preparation"], publication: Awaited<ReturnType<typeof publish>>) {
  return owned.db.transaction(tx => withReplacementRootNotificationDb(tx, createReplacementRootNotifications(), () =>
    completeQaRemediationReservation(tx, { preparation, publication })));
}

async function failUseLink() {
  await owned.db.execute(sql.raw("CREATE FUNCTION c5_e_fail_use() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'c5_e_link_fault'; END $$"));
  await owned.db.execute(sql.raw("CREATE TRIGGER c5_e_fail_use BEFORE INSERT ON quality_evidence_refs FOR EACH ROW EXECUTE FUNCTION c5_e_fail_use()"));
}
async function clearUseLinkFault() {
  await owned.db.execute(sql.raw("DROP TRIGGER IF EXISTS c5_e_fail_use ON quality_evidence_refs"));
  await owned.db.execute(sql.raw("DROP FUNCTION IF EXISTS c5_e_fail_use()"));
}

describe.sequential("C5 E first settlement stage", () => {
  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "c5-e-settlement-")));
    vi.stubEnv("PAPERCLIP_QA_FILE_OWNER_LOCK_ROOT", root);
    vi.stubEnv("PAPERCLIP_QA_FILE_OWNER_PYTHON", PYTHON!);
    storageRoot = path.join(root, "storage");
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk"); vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", storageRoot);
    owned = await createQaCorrectionTestDb(); quality = await seedQualityFixture(owned.db);
  }, 120_000);
  afterAll(async () => { await owned?.close(); vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); }, 120_000);

  it("rolls back a failed real use link, preserves uploaded bytes/preparation/file, then settles once and reuses the same receipt", async () => {
    const w = await prepared(true), publication = await publish(w.preparation, w.dir), beforeStat = await stat(w.file);
    const binding = w.binding!;
    await failUseLink();
    try {
      await expect(settle(w.preparation, publication)).rejects.toThrow("c5_e_link_fault");
    } finally { await clearUseLinkFault(); }
    expect(await owned.db.select().from(qualityEvidenceRefs).where(eq(qualityEvidenceRefs.qualityActionId, binding.actionId))).toHaveLength(0);
    expect(await owned.db.select().from(issueAttachments).where(eq(issueAttachments.companyId, quality.companyId))).toHaveLength(0);
    expect(await owned.db.select().from(assets).where(eq(assets.companyId, quality.companyId))).toHaveLength(0);
    expect(await owned.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey,
      qaRemediationRefireV2WakeKey(w.preparation, w.preparation.verdicts[0]!.qa.stepRunId, w.preparation.verdicts[0]!.eventId)))).toHaveLength(0);
    expect(await owned.db.select().from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.workflowRunId, w.preparation.workflowRunId),
      eq(workflowTransitionEvents.eventType, QA_REMEDIATION_COMPLETION_EVENT_TYPE)))).toHaveLength(0);
    expect(await readFile(w.file, "utf8")).toBe(after);
    expect(await readVerifiedEvidenceUpload(quality.companyId, binding.uploadedEvidence)).toEqual(uploadBytes);
    const retryPublication = await publish(w.preparation, w.dir);
    expect(retryPublication.files.map(file => file.status)).toEqual(["already_applied"]);
    expect((await stat(w.file)).ino).toBe(beforeStat.ino);
    const first = await settle(w.preparation, retryPublication);
    const second = await settle(w.preparation, retryPublication);
    expect(second).toMatchObject({ created: false, completionEventId: first.completionEventId,
      qualityUseEvidenceRefId: first.qualityUseEvidenceRefId });
    expect(first.completion.schemaVersion).toBe("workflow.qa-remediation.complete.v3");
    expect(await owned.db.select().from(qualityEvidenceRefs).where(eq(qualityEvidenceRefs.qualityActionId, binding.actionId))).toHaveLength(1);
    expect(await owned.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey,
      qaRemediationRefireV2WakeKey(w.preparation, w.preparation.verdicts[0]!.qa.stepRunId, w.preparation.verdicts[0]!.eventId)))).toHaveLength(1);
  }, 120_000);

  it("rolls back use evidence, wake and completion when persisted completion validation fails", async () => {
    const w = await prepared(true), publication = await publish(w.preparation, w.dir), binding = w.binding!;
    await owned.db.execute(sql.raw("CREATE FUNCTION c5_e_corrupt_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type = 'qa_remediation_completed' THEN NEW.payload = '{}'::jsonb; END IF; RETURN NEW; END $$"));
    await owned.db.execute(sql.raw("CREATE TRIGGER c5_e_corrupt_completion BEFORE INSERT ON workflow_transition_events FOR EACH ROW EXECUTE FUNCTION c5_e_corrupt_completion()"));
    try { await expect(settle(w.preparation, publication)).rejects.toThrow("qa_remediation_completion_malformed_completion"); }
    finally {
      await owned.db.execute(sql.raw("DROP TRIGGER IF EXISTS c5_e_corrupt_completion ON workflow_transition_events"));
      await owned.db.execute(sql.raw("DROP FUNCTION IF EXISTS c5_e_corrupt_completion()"));
    }
    expect(await owned.db.select().from(qualityEvidenceRefs).where(eq(qualityEvidenceRefs.qualityActionId, binding.actionId))).toHaveLength(0);
    expect(await owned.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey,
      qaRemediationRefireV2WakeKey(w.preparation, w.preparation.verdicts[0]!.qa.stepRunId, w.preparation.verdicts[0]!.eventId)))).toHaveLength(0);
    expect(await owned.db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.idempotencyKey, qaRemediationCompletionKey(w.preparation)))).toHaveLength(0);
    expect(await readFile(w.file, "utf8")).toBe(after);
    const committed = await settle(w.preparation, publication);
    expect(committed.qualityUseEvidenceRefId).toBeTruthy();
    expect(await owned.db.select().from(qualityEvidenceRefs).where(eq(qualityEvidenceRefs.qualityActionId, binding.actionId))).toHaveLength(1);
  }, 120_000);

  it("uses the public Quality root, rolls back a real link failure, continues after legitimate QA, and reuses completion", async () => {
    const w = await qualityRootWorld();
    await failUseLink();
    let failed;
    try { failed = await publicRoot(w.request, w.dir); } finally { await clearUseLinkFault(); }
    expect(failed).toMatchObject({ outcome: "held", reason: "transaction_outcome_unknown" });
    expect(await readFile(w.file, "utf8")).toBe(w.afterText);
    expect(await owned.db.select().from(qualityEvidenceRefs).where(eq(qualityEvidenceRefs.qualityActionId, w.actionId))).toHaveLength(0);
    expect(await owned.db.select().from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.workflowRunId, w.world.workflowRunId),
      eq(workflowTransitionEvents.eventType, QA_REMEDIATION_COMPLETION_EVENT_TYPE)))).toHaveLength(0);
    const rootNotifications = createReplacementRootNotifications(), first = await publicRoot(w.request, w.dir, rootNotifications);
    expect(first.outcome).toBe("completed");
    if (first.outcome !== "completed") throw new Error(`Quality root did not complete: ${JSON.stringify(first)}`);
    expect(first.created).toBe(true); expect(first.completion.schemaVersion).toBe("workflow.qa-remediation.complete.v3");
    expect(first.publication.map(file => file.status)).toEqual(["already_applied"]);
    expect(await owned.db.select().from(qualityEvidenceRefs).where(eq(qualityEvidenceRefs.qualityActionId, w.actionId))).toHaveLength(1);
    const [reservation] = await owned.db.select().from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.workflowRunId, w.world.workflowRunId), eq(workflowTransitionEvents.eventType, QA_REMEDIATION_PREPARATION_EVENT_TYPE)));
    const prepared = parseQaRemediationPreparation(reservation!.payload);
    if (prepared.schemaVersion !== QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3) throw new Error("Quality root did not persist strict v3");
    expect(prepared.files[0]).toMatchObject({ beforeSha256: sha(w.beforeBytes), beforeByteSize: w.beforeBytes.length });
    expect(prepared.qualityBinding.fileHashes).toEqual([{ file: w.file, before: sha(w.beforeText), after: sha(Buffer.from(w.afterText)) }]);
    const receipt = JSON.parse((await readVerifiedEvidenceUpload(quality.companyId, prepared.qualityBinding.uploadedEvidence)).toString());
    expect(receipt.fileHashes).toEqual(prepared.qualityBinding.fileHashes);
    await continueFromCompletionWake(w, first.completion, rootNotifications);
    const expiry = vi.spyOn(Date, "now").mockReturnValue(Date.parse(w.expiresAt) + 1);
    let replay: Awaited<ReturnType<typeof publicRoot>>; try { replay = await publicRoot(w.request, w.dir); } finally { expiry.mockRestore(); }
    expect(replay).toMatchObject({ outcome: "completed", created: false, completionEventId: first.completionEventId, publication: [] });
    expect(replay.outcome === "completed" ? replay.completion.wakes[0]!.wakeupRequestId : "").toBe(first.completion.wakes[0]!.wakeupRequestId);
    expect(await owned.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, first.completion.wakes[0]!.wakeupRequestId))).toHaveLength(1);
    expect(await owned.db.select().from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.workflowRunId, w.world.workflowRunId),
      eq(workflowTransitionEvents.eventType, QA_REMEDIATION_COMPLETION_EVENT_TYPE)))).toHaveLength(1);
    expect(await owned.db.select().from(qualityEvidenceRefs).where(eq(qualityEvidenceRefs.qualityActionId, w.actionId))).toHaveLength(1);
  }, 120_000);

  it("holds a hash-consistent effect target mismatch and Quality source mismatch before reservation", async () => {
    const w = await qualityRootWorld();
    const [action] = await owned.db.select().from(qualityActions).where(eq(qualityActions.id, w.actionId));
    const assetCount = (await owned.db.select().from(assets).where(eq(assets.companyId, quality.companyId))).length, wakeCount = (await owned.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.workflowRunId, w.world.workflowRunId))).length;
    const validTarget = { kind: "current_output" as const, source: w.world.source };
    const divergentEffect = { kind: "repair_supported_output" as const, target: { ...validTarget, source: { ...validTarget.source, issueId: randomUUID() } } };
    const divergentEnvelope = { ...action!.retryEnvelope, effectHash: hashContract(divergentEffect) };
    await owned.db.update(qualityActions).set({ effect: divergentEffect, effectHash: hashContract(divergentEffect), retryEnvelope: divergentEnvelope }).where(eq(qualityActions.id, w.actionId));
    const effectHeld = await publicRoot(w.request, w.dir);
    expect(effectHeld).toMatchObject({ outcome: "preparation_held", reason: "invalid_history", detail: expect.stringContaining("effect target differs") });
    const target = { kind: "current_output" as const, source: { ...w.world.source, issueId: randomUUID() } }, effect = { kind: "repair_supported_output" as const, target };
    const retryEnvelope = { ...action!.retryEnvelope, targetHash: hashContract(target), effectHash: hashContract(effect) };
    await owned.db.update(qualityActions).set({ target, targetHash: hashContract(target), effect, effectHash: hashContract(effect), retryEnvelope }).where(eq(qualityActions.id, w.actionId));
    const held = await publicRoot(w.request, w.dir);
    expect(held).toMatchObject({ outcome: "preparation_held", reason: "invalid_history",
      detail: "Quality occurrence source/review binding changed" });
    expect(await owned.db.select().from(assets).where(eq(assets.companyId, quality.companyId))).toHaveLength(assetCount); expect(await readFile(w.file)).toEqual(w.beforeBytes);
    expect(await owned.db.select().from(qualityEvidenceRefs).where(eq(qualityEvidenceRefs.qualityActionId, w.actionId))).toHaveLength(0); expect(await owned.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.workflowRunId, w.world.workflowRunId))).toHaveLength(wakeCount);
    expect(await owned.db.select().from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.workflowRunId, w.world.workflowRunId),
      eq(workflowTransitionEvents.eventType, "qa_remediation_prepared")))).toHaveLength(0);
  }, 120_000);

  it("holds malformed same-producer history beside an incomplete v3 reservation", async () => {
    const w = await qualityRootWorld();
    const reservation = await prepareQaRemediationQualityReservation(owned.db, w.request);
    if (reservation.outcome !== "prepared" || reservation.preparation.schemaVersion !== QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3) {
      throw new Error("incomplete Quality v3 reservation was not persisted");
    }
    const wakeCount = (await owned.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.workflowRunId, w.world.workflowRunId))).length;
    await owned.db.insert(workflowTransitionEvents).values({ companyId: quality.companyId, workflowRunId: w.world.workflowRunId,
      workflowStepRunId: w.world.producerStepRunId, eventType: QA_REMEDIATION_PREPARATION_EVENT_TYPE, layer: "workflow_validation", payload: {} });
    const held = await publicRoot(w.request, w.dir);
    expect(held).toMatchObject({ outcome: "preparation_held", reason: "invalid_history" });
    expect(await readFile(w.file, "utf8")).toBe(w.beforeText);
    expect(await owned.db.select().from(qualityEvidenceRefs).where(eq(qualityEvidenceRefs.qualityActionId, w.actionId))).toHaveLength(0); expect(await owned.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.workflowRunId, w.world.workflowRunId))).toHaveLength(wakeCount);
    expect(await owned.db.select().from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.workflowRunId, w.world.workflowRunId), eq(workflowTransitionEvents.eventType, QA_REMEDIATION_COMPLETION_EVENT_TYPE)))).toHaveLength(0);
  }, 120_000);

  it("keeps workflow-only v2 completion schema, wake namespace, and nullable Quality reference", async () => {
    const qualityUseCount = (await owned.db.select().from(qualityEvidenceRefs).where(eq(qualityEvidenceRefs.companyId, quality.companyId))).length;
    const w = await prepared(false);
    const request = { companyId: w.preparation.companyId, missionId: w.preparation.missionId,
      workflowRunId: w.preparation.workflowRunId, producerStepRunId: w.preparation.producer.stepRunId,
      qaStepRunIds: w.preparation.verdicts.map(v => v.qa.stepRunId) };
    const rootResult = await publicRoot(request, w.dir);
    expect(rootResult.outcome).toBe("completed");
    if (rootResult.outcome !== "completed") throw new Error(`workflow v2 root did not complete: ${JSON.stringify(rootResult)}`);
    expect(rootResult.completion.schemaVersion).toBe(QA_REMEDIATION_COMPLETION_SCHEMA_VERSION); expect(rootResult.completion.schemaVersion === QA_REMEDIATION_COMPLETION_SCHEMA_VERSION ? null : rootResult.completion.qualityUseEvidenceRefId).toBeNull();
    expect(rootResult.completion.schemaVersion === QA_REMEDIATION_COMPLETION_SCHEMA_VERSION ? rootResult.completion.wakes[0]!.idempotencyKey : "").toBe(qaRemediationRefireV2WakeKey(w.preparation, w.preparation.verdicts[0]!.qa.stepRunId, w.preparation.verdicts[0]!.eventId));
    expect(await owned.db.select().from(qualityEvidenceRefs).where(eq(qualityEvidenceRefs.companyId, quality.companyId))).toHaveLength(qualityUseCount);
  }, 120_000);
});
