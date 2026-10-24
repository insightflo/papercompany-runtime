import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issues, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { producerAttempt, producerAttemptDetail, type ProducerAttemptIdentity } from "../services/work-products/producer-attempt.js";
import { claimHeartbeatWithRecoveryGuard } from "../services/heartbeat-recovery-guard.js";
import { insertWorkflowWakeRequest } from "../services/heartbeat-workflow-wake.js";
import { WORKFLOW_ATTEMPT_PROOF_KEY, readWorkflowAttemptProof } from "../services/heartbeat-finalization/workflow-attempt-proof.js";
import * as historyReader from "../services/workflow/control-flow/qa-correction-reader.js";
import { readIssuedQaCorrectionFollowup, readQaCorrectionFollowupConsumption } from "../services/workflow/control-flow/qa-correction-followup.js";
import { createQaCorrectionHistorySession } from "../services/workflow/control-flow/qa-correction-history-session.js";
import { QaCorrectionReadError, type QaCorrectionDb } from "../services/workflow/control-flow/qa-correction-authority.js";
import { beginQaCorrection } from "../services/workflow/control-flow/qa-correction-prepare.js";
import { measureQaCorrectionSources } from "../services/workflow/control-flow/qa-correction-measure.js";
import { storeQaCorrection } from "../services/workflow/control-flow/qa-correction-storage.js";
import { commitQaCorrection } from "../services/workflow/control-flow/qa-correction-commit.js";
import { hashQaCorrectionPayload } from "../services/workflow/control-flow/qa-correction-contract.js";
import { submitWorkflowVerdict } from "../services/workflow/agent-api.js";
import { commitDbState, commitBuffers, commitFacts } from "./qa-correction-commit-fixture.js";
import { createCommitSourceHarness, issueC02, correctionRows } from "./helpers/c02-delivery-fixture.js";
import { createClaimFixture } from "./helpers/c02-claim-race-fixture.js";
import { qualityProducerFixture } from "./helpers/quality-producer-fixture.js";

// C02 revision78: the original admission and issued B target, not current metadata, define the oracle.
// Real isolated PG, issuance, delivery, retry and public claim; no adapter/provider execution is asserted.
let owned: Awaited<ReturnType<typeof createCommitSourceHarness>>;
let fixtures: ReturnType<typeof createClaimFixture>;
beforeAll(async () => {
  owned = await createCommitSourceHarness();
  fixtures = createClaimFixture(owned, db => db, [], []);
  vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
  vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", path.join(owned.root, "detail-storage"));
}, 120000);
afterAll(async () => { try { await owned?.close(); } finally { vi.unstubAllEnvs(); } }, 120000);

type World = Awaited<ReturnType<typeof fixtures.world>>;
type Heartbeat = typeof heartbeatRuns.$inferSelect;
const readRun = async (id: string) => (await owned.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;
const readStep = async (id: string) => (await owned.db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, id)))[0]!;
function frozen(step: ProducerAttemptIdentity): ProducerAttemptIdentity {
  return { id: step.id, workflowRunId: step.workflowRunId, stepId: step.stepId, issueId: step.issueId,
    executionGeneration: step.executionGeneration, retryCount: step.retryCount, iterationIndex: step.iterationIndex };
}
async function claimed(w: World) {
  const queued = (await correctionRows(w.c)).heartbeats[0]!;
  const heartbeat = await claimHeartbeatWithRecoveryGuard(owned.db, queued, new Date());
  if (!heartbeat) throw Error("real correction claim required");
  expect(heartbeat).toMatchObject({ status: "running", startedAt: expect.any(Date) });
  return heartbeat;
}
const state = (w: World) => commitDbState({ ...w.c.s, db: w.c.peer });

// Same B heartbeat officially rejects B. This real C issuer also replaces the current tool metadata.
async function issueC(w: World, heartbeat: Heartbeat) {
  const c = w.c, r = c.stored.revisions[0]!, files = commitBuffers("content-only", "new");
  const main = commitFacts(files).find(f => f.role === "main")!, request = structuredClone(c.s.request);
  request.input.workProductId = r.workProductId;
  request.input.path = path.join(r.root, r.mainRelativePath);
  request.input.sha256 = main.sha256;
  request.input.byteSize = main.byteSize;
  request.input.assetsRoot = "";
  await c.peer.update(workflowStepRuns).set({ metadata: {
    artifactExecution: request.artifactExecution, toolArtifactRequest: request,
  } }).where(eq(workflowStepRuns.id, c.followup.target.stepRunId));
  const remediations = { items: [{ op: "string_replace" as const, file: request.input.path, find: "new", replace: "final" }] };
  // The fixture's producer is already done; preserve its actual completion across public API sync.
  const producer = await readStep(c.s.p.producer.stepRunId);
  expect(producer).toMatchObject({ status: "completed", completedAt: expect.any(Date) });
  await c.peer.update(issues).set({ completedAt: producer.completedAt }).where(eq(issues.id, producer.issueId!));
  const [issue] = await c.peer.select().from(issues).where(eq(issues.id, c.followup.target.issueId));
  expect((await submitWorkflowVerdict({ db: c.peer, issue: issue!,
    actor: { actorType: "agent", actorId: heartbeat.agentId, agentId: heartbeat.agentId, runId: heartbeat.id },
    data: { verdict: "request_changes", remediations } })).satisfied).toBe(true);
  const relation = await readQaCorrectionFollowupConsumption(c.peer, c.ref, createQaCorrectionHistorySession(c.peer, c.ref));
  if (!relation || relation.consumed.evidence.kind !== "workflow_verdict") throw Error("official B consumption required");
  const target = relation.consumed.followup.target, current = await readStep(target.stepRunId);
  expect(frozen(current)).toEqual({ id: target.stepRunId, workflowRunId: c.ref.workflowRunId,
    stepId: target.stepId, issueId: target.issueId, executionGeneration: target.executionGeneration,
    retryCount: target.retryCount, iterationIndex: target.iterationIndex });
  const [event] = await c.peer.select().from(workflowTransitionEvents)
    .where(eq(workflowTransitionEvents.id, relation.consumed.evidence.eventId));
  expect(event).toMatchObject({ heartbeatRunId: heartbeat.id, wakeupRequestId: heartbeat.wakeupRequestId,
    workflowStepRunId: target.stepRunId, executionGeneration: target.executionGeneration, verdict: "request_changes" });
  if (!event?.heartbeatRunId) throw Error("same-H official rejection required");
  const p = structuredClone(c.s.p);
  p.correctionId = randomUUID();
  p.preparedAt = new Date().toISOString();
  p.authority.verdicts = [{ eventId: event.id, heartbeatRunId: event.heartbeatRunId,
    qa: target, remediationsHash: hashQaCorrectionPayload(remediations.items) }];
  p.sources = [{ productId: r.workProductId, provenance: { kind: "prior_correction", appliedEventId: c.ref.appliedEventId } }];
  p.bindings.forEach(binding => { binding.consumer = target; binding.expectedProductId = r.workProductId; });
  const prepared = await beginQaCorrection(c.peer, p);
  if (prepared.status !== "prepared") throw Error("real C preparation required: " + prepared.status);
  const measured = await measureQaCorrectionSources(c.peer, {
    preparationEventId: prepared.preparationEventId, preparationHash: prepared.preparationHash });
  const stored = await storeQaCorrection(c.peer, measured);
  expect((await commitQaCorrection(c.peer, stored)).status).toBe("committed");
  expect(await readFile(path.join(stored.revisions[0]!.root, "report.html")))
    .toEqual(commitBuffers("content-only", "final").get("report.html"));
}

it("returns the normal original root from exactly seven fields and keeps the fullrow two-field result", async () => {
  const c = await issueC02(owned, { mode: "content-only" }), heartbeat = await readRun(c.s.f.producerHeartbeatId);
  const step = await readStep(c.s.f.producer.id), identity = frozen(step);
  expect(Object.keys(identity)).toHaveLength(7);
  await expect(producerAttemptDetail(c.peer, heartbeat, identity)).resolves.toEqual({
    retryCount: 0, iterationIndex: 0, rootHeartbeatRunId: heartbeat.id, rootWakeupRequestId: heartbeat.wakeupRequestId,
  });
  await expect(producerAttempt(c.peer, heartbeat, step)).resolves.toEqual({ retryCount: 0, iterationIndex: 0 });
}, 30000);

it("returns claimed delivery H0/W0 through a genuinely enqueued and claimed H1 without another quality use", async () => {
  const w = await fixtures.world(true), root = await claimed(w), step = await readStep(w.c.followup.target.stepRunId);
  const identity = frozen(step), before = await state(w);
  expect(w.c.followup.target).toMatchObject({ retryCount: 1, iterationIndex: 2 });
  const expected = { retryCount: 1, iterationIndex: 2, rootHeartbeatRunId: root.id, rootWakeupRequestId: root.wakeupRequestId };
  await expect(producerAttemptDetail(w.c.peer, root, identity)).resolves.toEqual(expected);
  await expect(producerAttempt(w.c.peer, root, step)).resolves.toEqual({ retryCount: 1, iterationIndex: 2 });
  const queued = await fixtures.retry(w, root, "process_lost_retry");
  await expect(producerAttemptDetail(w.c.peer, queued, identity)).rejects.toThrow("workproduct_producer_attempt_unproven");
  const child = await claimHeartbeatWithRecoveryGuard(owned.db, queued, new Date());
  if (!child) throw Error("real technical child claim required");
  expect(child).toMatchObject({ status: "running", startedAt: expect.any(Date), retryOfRunId: root.id });
  const [wake] = await w.c.peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, child.wakeupRequestId!));
  expect(wake!.payload).not.toHaveProperty("qaCorrectionFollowup");
  expect(readWorkflowAttemptProof(wake!)).toMatchObject({ retryCount: 1, iterationIndex: 2, parentHeartbeatRunId: root.id });
  await expect(producerAttemptDetail(w.c.peer, child, identity)).resolves.toEqual(expected);
  expect(child.wakeupRequestId).not.toBe(root.wakeupRequestId);
  const after = await state(w);
  expect(before.receipts.filter(r => r.qualityContract?.kind === "use")).toHaveLength(1);
  expect(before.usage.reduce((sum, row) => sum + row.executionAttempts, 0)).toBe(1);
  const corrections = (s: typeof before) => s.events.filter(e => e.eventType.startsWith("qa_correction_")
    || e.eventType === "qa_remediation_applied");
  expect([after.receipts, after.usage, after.groups, corrections(after)])
    .toEqual([before.receipts, before.usage, before.groups, corrections(before)]);
}, 60000);

it("keeps real quality fullrow admission valid but refuses the historical quality-null path", async () => {
  const f = await qualityProducerFixture(owned.db, owned.root);
  expect((await f.schedule()).result).toBe("scheduled");
  const { heartbeatId } = await f.admit(), heartbeat = await readRun(heartbeatId), step = await f.readStep();
  await expect(producerAttempt(owned.db, heartbeat, step)).resolves.toEqual({ retryCount: 1, iterationIndex: 0 });
  await expect(producerAttemptDetail(owned.db, heartbeat, frozen(step))).rejects.toThrow("workproduct_producer_attempt_unproven");
}, 30000);

it("reads frozen B after actual C issuance, rejects cross-API history reentry and permits independent parallel reads", async () => {
  const w = await fixtures.world(), heartbeat = await claimed(w), step = await readStep(w.c.followup.target.stepRunId);
  const identity = frozen(step), expected = { retryCount: 1, iterationIndex: 2,
    rootHeartbeatRunId: heartbeat.id, rootWakeupRequestId: heartbeat.wakeupRequestId };
  await issueC(w, heartbeat);
  expect((await readStep(step.id)).metadata).not.toEqual(step.metadata);
  const before = await state(w);
  const detail = () => producerAttemptDetail(w.c.peer, heartbeat, identity);
  // Real true-history call-through reenters the existing fullrow API on this same heartbeat.
  // No permission, issuance, proof or DB transaction is replaced by the spy.
  const spy = vi.spyOn(historyReader, "readIssuedQaCorrectionFollowupForAttempt").mockImplementationOnce(
    (db, ref) => readIssuedQaCorrectionFollowup(db as QaCorrectionDb, ref, historyReader.readIssuedQaCorrection));
  try {
    const failure = await detail().then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(QaCorrectionReadError);
    expect(failure).toMatchObject({ reason: "heartbeat" });
    expect(spy).toHaveBeenCalledTimes(1);
  } finally { spy.mockRestore(); }
  await expect(Promise.all([detail(), detail(), producerAttempt(w.c.peer, heartbeat, step)]))
    .resolves.toEqual([expected, expected, { retryCount: 1, iterationIndex: 2 }]);
  expect(await state(w)).toEqual(before);
}, 60000);

it.each(["id", "workflowRunId", "stepId", "issueId", "generation", "retry", "iteration", "wake-link", "proof"] as const)(
  "rejects a mismatched frozen tuple or broken original relationship: %s", async kind => {
    const w = await fixtures.world(), heartbeat = await claimed(w), identity = frozen(await readStep(w.c.followup.target.stepRunId));
    if (kind === "id") identity.id = randomUUID();
    if (kind === "workflowRunId") identity.workflowRunId = randomUUID();
    if (kind === "stepId") identity.stepId = "wrong-step";
    if (kind === "issueId") identity.issueId = randomUUID();
    if (kind === "generation") identity.executionGeneration++;
    if (kind === "retry") identity.retryCount++;
    if (kind === "iteration") identity.iterationIndex++;
    if (kind === "wake-link") await w.c.peer.update(agentWakeupRequests).set({ runId: randomUUID() })
      .where(eq(agentWakeupRequests.id, heartbeat.wakeupRequestId!));
    if (kind === "proof") {
      const [wake] = await w.c.peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, heartbeat.wakeupRequestId!));
      const proof = readWorkflowAttemptProof(wake!);
      await w.c.peer.update(agentWakeupRequests).set({ payload: { ...wake!.payload,
        [WORKFLOW_ATTEMPT_PROOF_KEY]: { ...proof, retryCount: proof.retryCount + 1 },
      } }).where(eq(agentWakeupRequests.id, wake!.id));
    }
    await expect(producerAttemptDetail(w.c.peer, heartbeat, identity)).rejects.toThrow("workproduct_producer_attempt_unproven");
  }, 30000);

it("directly allows 32 technical nodes, refuses 33 and a consistent stored cycle rather than an unstarted input", async () => {
  const c = await issueC02(owned, { mode: "content-only" }), step = await readStep(c.s.f.producer.id);
  const root = await readRun(c.s.f.producerHeartbeatId), identity = frozen(step), chain = [root];
  // Depth-only stored topology with real admission proofs. These inserted rows do not claim actual execution.
  for (let n = 1; n < 33; n++) {
    const parent = chain[n - 1]!;
    const [wake] = await insertWorkflowWakeRequest(c.peer, {
      companyId: root.companyId, agentId: root.agentId, issueId: root.issueId, missionId: c.s.p.missionId,
      workflowRunId: step.workflowRunId, workflowStepRunId: step.id, workflowExecutionGeneration: step.executionGeneration,
      source: "automation", status: "admitted", idempotencyKey: null, requestKind: "process_lost_retry",
      reason: "process_lost_retry", requestedByActorType: "system",
    }, parent.id);
    const startedAt = new Date(Math.max(Date.now(), wake!.requestedAt.getTime(), parent.startedAt!.getTime()));
    const [child] = await c.peer.insert(heartbeatRuns).values({
      companyId: root.companyId, agentId: root.agentId, issueId: root.issueId, wakeupRequestId: wake!.id,
      workflowStepRunId: step.id, workflowExecutionGeneration: step.executionGeneration, retryOfRunId: parent.id,
      status: "running", startedAt, createdAt: startedAt,
    }).returning();
    await c.peer.update(agentWakeupRequests).set({ runId: child!.id }).where(eq(agentWakeupRequests.id, wake!.id));
    chain.push(child!);
  }
  const expected = { retryCount: 0, iterationIndex: 0, rootHeartbeatRunId: root.id, rootWakeupRequestId: root.wakeupRequestId };
  await expect(producerAttemptDetail(c.peer, chain[31]!, identity)).resolves.toEqual(expected);
  const over = chain[32]!;
  await expect(producerAttemptDetail(c.peer, over, identity)).rejects.toThrow("workproduct_producer_attempt_unproven");
  const [wake] = await c.peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, over.wakeupRequestId!));
  const proof = readWorkflowAttemptProof(wake!);
  expect(proof).toMatchObject({ parentHeartbeatRunId: chain[31]!.id, retryCount: 0, iterationIndex: 0 });
  // Change ONLY the stored parent edge and its matching proof: this same started leaf now has depth two.
  for (const parentId of [root.id, over.id]) {
    await c.peer.update(agentWakeupRequests).set({ payload: { ...wake!.payload,
      [WORKFLOW_ATTEMPT_PROOF_KEY]: { ...proof, parentHeartbeatRunId: parentId },
    } }).where(eq(agentWakeupRequests.id, wake!.id));
    await c.peer.update(heartbeatRuns).set({ retryOfRunId: parentId }).where(eq(heartbeatRuns.id, over.id));
    const current = await readRun(over.id), result = producerAttemptDetail(c.peer, current, identity);
    if (parentId === root.id) await expect(result).resolves.toEqual(expected);
    else await expect(result).rejects.toThrow("workproduct_producer_attempt_unproven");
  }
}, 120000);
