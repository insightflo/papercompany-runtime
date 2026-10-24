import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, agentWakeupRequests, heartbeatRuns, issues, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { producerAttempt } from "../services/work-products/producer-attempt.js";
import { qaCorrectionWakeKey, readQaCorrectionWakeRef } from "../services/work-products/qa-correction-producer-attempt.js";
import { insertWorkflowWakeRequest } from "../services/heartbeat-workflow-wake.js";
import { WORKFLOW_ATTEMPT_PROOF_KEY, readWorkflowAttemptProof } from "../services/heartbeat-finalization/workflow-attempt-proof.js";
import { enqueueAdapterFallbackRun, enqueueProcessLossRetry } from "../services/heartbeat-retry-enqueue.js";
import * as historyReader from "../services/workflow/control-flow/qa-correction-reader.js";
import { readIssuedQaCorrectionFollowup } from "../services/workflow/control-flow/qa-correction-followup.js";
import { QaCorrectionReadError, type QaCorrectionDb } from "../services/workflow/control-flow/qa-correction-authority.js";
import { beginQaCorrection } from "../services/workflow/control-flow/qa-correction-prepare.js";
import { measureQaCorrectionSources } from "../services/workflow/control-flow/qa-correction-measure.js";
import { storeQaCorrection } from "../services/workflow/control-flow/qa-correction-storage.js";
import { commitQaCorrection } from "../services/workflow/control-flow/qa-correction-commit.js";
import { hashQaCorrectionPayload } from "../services/workflow/control-flow/qa-correction-contract.js";
import { recordWorkflowValidationVerdict } from "../services/workflow/validation-verdict-ledger.js";
import { claimHeartbeatWithRecoveryGuard } from "../services/heartbeat-recovery-guard.js";
import { createClaimFixture } from "./helpers/c02-claim-race-fixture.js";
import { correctionRows } from "./helpers/c02-delivery-fixture.js";
import { seedV2Consumption } from "./helpers/c02-consumption-fixture.js";
import { commitDbState } from "./qa-correction-commit-fixture.js";
import { commitBuffers, commitFacts, createCommitSourceHarness, issueC02 } from "./helpers/c02-fixture.js";

// C02 stage10/C12: issued target retry=1/iteration=2 is the oracle, independent of the attempt decoder.
// Controlled H below is NOT atomic claim, queue delivery or current execution permission evidence.
describe("C02 stage10 original correction producer attempt", () => {
  let owned: Awaited<ReturnType<typeof createCommitSourceHarness>>;
  beforeAll(async () => {
    owned = await createCommitSourceHarness();
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", path.join(owned.root, "c02-attempt-storage"));
  }, 120000);
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => { try { await owned?.close(); } finally { vi.unstubAllEnvs(); } }, 120000);

  async function admitted(options: { quality?: boolean; legacy?: boolean } = {}) {
    const c = await issueC02(owned, { ...options, mode: "content-only" });
    const [old] = await c.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, c.s.f.verdictHeartbeatId));
    const [step] = await c.peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, c.s.f.qa.id));
    const [wake] = await insertWorkflowWakeRequest(c.peer, {
      companyId: c.ref.companyId, agentId: old!.agentId, issueId: step!.issueId, missionId: c.s.p.missionId,
      workflowRunId: c.ref.workflowRunId, workflowStepRunId: step!.id, workflowExecutionGeneration: step!.executionGeneration,
      source: "workflow.dispatch", status: "admitted", idempotencyKey: qaCorrectionWakeKey(c.ref),
      payload: { qaCorrectionFollowup: c.ref },
    });
    if (!wake || !step) throw Error("real server wake and QA target required");
    const startedAt = new Date(Math.max(Date.now(), wake.requestedAt.getTime()));
    const [heartbeat] = await c.peer.insert(heartbeatRuns).values({
      companyId: c.ref.companyId, agentId: wake.agentId, issueId: step.issueId, wakeupRequestId: wake.id,
      workflowStepRunId: step.id, workflowExecutionGeneration: step.executionGeneration,
      status: "running", startedAt, createdAt: startedAt,
    }).returning();
    if (!heartbeat) throw Error("controlled heartbeat required");
    const [linkedWake] = await c.peer.update(agentWakeupRequests).set({ runId: heartbeat.id })
      .where(eq(agentWakeupRequests.id, wake.id)).returning();
    return { ...c, heartbeat, step, wake: linkedWake! };
  }
  type Case = Awaited<ReturnType<typeof admitted>>;
  const state = (c: Case) => commitDbState({ ...c.s, db: c.peer });
  const decode = (c: Case) => producerAttempt(c.peer, c.heartbeat, c.step);

  it("proves real issued B through public producerAttempt with original retry=1 iteration=2", async () => {
    const c = await admitted(), before = await state(c);
    expect(c.followup.target).toMatchObject({ retryCount: 1, iterationIndex: 2 });
    expect(readQaCorrectionWakeRef(c.wake)).toEqual(c.ref);
    expect(readWorkflowAttemptProof(c.wake)).toMatchObject({ retryCount: 1, iterationIndex: 2, parentHeartbeatRunId: null });
    const [author] = await c.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, c.s.f.producerHeartbeatId));
    expect(author!.agentId).not.toBe(c.heartbeat.agentId);
    await expect(decode(c)).resolves.toEqual({ retryCount: 1, iterationIndex: 2 });
    expect(await state(c)).toEqual(before);
  }, 20000);

  it("keeps legacy original producer absent while proving the issued QA target", async () => {
    const c = await admitted({ legacy: true });
    const selected = await historyReader.readIssuedQaCorrectionFollowupForAttempt(c.peer, c.ref);
    expect(selected.revisions[0]!.workflowProducer).toBeNull();
    await expect(decode(c)).resolves.toEqual({ retryCount: 1, iterationIndex: 2 });
  }, 20000);

  // Same H officially rejects B; no issueNextC02 helper with a different proof-less heartbeat.
  async function issueC(c: Case) {
    const r = c.stored.revisions[0]!, files = commitBuffers("content-only", "new");
    const main = commitFacts(files).find(f => f.role === "main")!, request = structuredClone(c.s.request);
    request.input.workProductId = r.workProductId;
    request.input.path = path.join(r.root, r.mainRelativePath);
    request.input.sha256 = main.sha256;
    request.input.byteSize = main.byteSize;
    request.input.assetsRoot = "";
    await c.peer.update(workflowStepRuns).set({ metadata: {
      artifactExecution: request.artifactExecution, toolArtifactRequest: request,
    } }).where(eq(workflowStepRuns.id, c.step.id));
    const remediations = { items: [{ op: "string_replace" as const, file: request.input.path, find: "new", replace: "final" }] };
    const [issue] = await c.peer.select().from(issues).where(eq(issues.id, c.step.issueId!));
    const recorded = await recordWorkflowValidationVerdict({ db: c.peer, issue: issue!, source: "workflow_api",
      verdict: "request_changes", heartbeatRunId: c.heartbeat.id, remediations });
    expect(recorded.satisfied).toBe(true);
    const [event] = await c.peer.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.heartbeatRunId, c.heartbeat.id),
      eq(workflowTransitionEvents.eventType, "workflow_validation_verdict")));
    if (!event) throw Error("same-H official rejection required");
    const delivered = (await correctionRows(c)).receipts.find(row =>
      row.heartbeatRunId === c.heartbeat.id && row.wakeupRequestId === c.wake.id);
    if (!delivered) throw Error("same-H actual delivery event required");
    // Reader input only; this does not prove an atomic public verdict/consumption writer.
    await seedV2Consumption(c, { kind: "workflow_verdict", eventId: event.id, deliveryEventId: delivered.id }, c.heartbeat);
    const p = structuredClone(c.s.p);
    p.correctionId = randomUUID();
    p.preparedAt = new Date().toISOString();
    p.authority.verdicts = [{ eventId: event.id, heartbeatRunId: c.heartbeat.id,
      qa: c.followup.target, remediationsHash: hashQaCorrectionPayload(remediations.items) }];
    p.sources = [{ productId: r.workProductId, provenance: { kind: "prior_correction", appliedEventId: c.ref.appliedEventId } }];
    p.bindings.forEach(binding => { binding.expectedProductId = r.workProductId; });
    const prepared = await beginQaCorrection(c.peer, p);
    if (prepared.status !== "prepared") throw Error("real C preparation required: " + prepared.status);
    const measured = await measureQaCorrectionSources(c.peer, {
      preparationEventId: prepared.preparationEventId, preparationHash: prepared.preparationHash });
    const stored = await storeQaCorrection(c.peer, measured);
    expect((await commitQaCorrection(c.peer, stored)).status).toBe("committed");
    expect(await readFile(path.join(stored.revisions[0]!.root, "report.html")))
      .toEqual(commitBuffers("content-only", "final").get("report.html"));
  }

  it("rejects same-H reentry through actual true history after B→C, then proves H with false history", async () => {
    const fixtures = createClaimFixture(owned, db => db, [], []), { c: b } = await fixtures.world();
    const queued = (await correctionRows(b)).heartbeats[0];
    if (!queued) throw Error("actual delivered root required");
    const heartbeat = await claimHeartbeatWithRecoveryGuard(owned.db, queued, new Date());
    if (!heartbeat?.wakeupRequestId) throw Error("actual root public claim required");
    const [step] = await b.peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, b.followup.target.stepRunId));
    const [wake] = await b.peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, heartbeat.wakeupRequestId));
    if (!step || !wake) throw Error("actual claimed QA target and wake required");
    const c = { ...b, heartbeat, step, wake };
    await issueC(c);
    // One pass-through only: without the ALS guard the next real false bridge would succeed, not loop.
    const spy = vi.spyOn(historyReader, "readIssuedQaCorrectionFollowupForAttempt").mockImplementationOnce(
      (db, ref) => readIssuedQaCorrectionFollowup(db as QaCorrectionDb, ref, historyReader.readIssuedQaCorrection));
    try {
      const failure = await decode(c).then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(QaCorrectionReadError);
      expect(failure).toMatchObject({ reason: "heartbeat" });
      expect(spy).toHaveBeenCalledTimes(1); // Also proves producerAttempt's delayed import observes this export.
    } finally { spy.mockRestore(); }
    await expect(decode(c)).resolves.toEqual({ retryCount: 1, iterationIndex: 2 });
    const selected = await historyReader.readIssuedQaCorrectionFollowupForAttempt(c.peer, c.ref);
    expect(selected.revisions[0]!.workflowProducer).toEqual(c.s.producer);
  }, 30000);

  it("refuses direct same-H recursive history but permits independent parallel calls", async () => {
    const c = await admitted();
    const spy = vi.spyOn(historyReader, "readIssuedQaCorrectionFollowupForAttempt").mockImplementationOnce(async () => {
      await decode(c);
      throw Error("same-H reentry was incorrectly accepted");
    });
    try { await expect(decode(c)).rejects.toThrow("workproduct_producer_attempt_unproven"); }
    finally { spy.mockRestore(); }
    await expect(Promise.all([decode(c), decode(c)])).resolves.toEqual([
      { retryCount: 1, iterationIndex: 2 }, { retryCount: 1, iterationIndex: 2 },
    ]);
  }, 20000);

  it.each(["process_lost", "adapter_failed_transient", "fallback"] as const)(
    "keeps real technical child ancestry and zero extra correction usage: %s", async kind => {
      const c = await admitted({ quality: true }), before = await state(c);
      expect(before.receipts.filter(r => r.qualityContract?.kind === "use")).toHaveLength(1);
      expect(before.usage.reduce((n, row) => n + row.executionAttempts, 0)).toBe(1);
      const [agent] = await c.peer.select().from(agents).where(eq(agents.id, c.heartbeat.agentId));
      const deps = { db: c.peer, resolveSessionBeforeForWakeup: async () => null, appendRunEvent: async () => {} };
      const child = kind === "fallback"
        ? await enqueueAdapterFallbackRun(deps, c.heartbeat, agent!, new Date(), {
          fallbackCommand: "test-never-executed", fallbackReason: "test",
        })
        : await enqueueProcessLossRetry(deps, c.heartbeat, agent!, new Date(), { kind });
      const [wake] = await c.peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, child.wakeupRequestId!));
      expect(child).toMatchObject({ status: "queued", retryOfRunId: c.heartbeat.id, startedAt: null });
      expect(wake!.idempotencyKey).toBeNull();
      expect(Object.hasOwn(wake!.payload ?? {}, "qaCorrectionFollowup")).toBe(false);
      expect(readQaCorrectionWakeRef(wake!)).toBeNull();
      expect(readWorkflowAttemptProof(wake!)).toMatchObject({
        retryCount: 1, iterationIndex: 2, parentHeartbeatRunId: c.heartbeat.id,
      });
      // Same typed projection as readAdmittedWorkflowIdentity, without claiming or changing the queued child.
      const claimingChild = { ...child, workflowStepRunId: wake!.workflowStepRunId,
        workflowExecutionGeneration: wake!.workflowExecutionGeneration };
      await expect(producerAttempt(c.peer, claimingChild, c.step, undefined, true))
        .resolves.toEqual({ retryCount: 1, iterationIndex: 2 });
      const [parentWake] = await c.peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, c.wake.id));
      expect(readQaCorrectionWakeRef(parentWake!)).toEqual(c.ref);
      const after = await state(c);
      expect(after.receipts).toEqual(before.receipts);
      expect(after.usage).toEqual(before.usage);
      expect(after.groups).toEqual(before.groups);
      const corrections = (rows: typeof before.events) => rows.filter(e => e.eventType.startsWith("qa_correction_")
        || e.eventType === "qa_remediation_applied");
      expect(corrections(after.events)).toEqual(corrections(before.events));
      expect(after.wakes).toHaveLength(before.wakes.length + 1);
      expect(after.heartbeats).toHaveLength(before.heartbeats.length + 1);
      await c.peer.update(agentWakeupRequests).set({ payload: { ...wake!.payload, qaCorrectionFollowup: c.ref } })
        .where(eq(agentWakeupRequests.id, wake!.id));
      await expect(producerAttempt(c.peer, claimingChild, c.step, undefined, true)).rejects.toThrow();
    }, 30000);

  it.each(["ref-request", "ref-company", "ref-run", "ref-applied", "ref-extra", "missing-ref", "null-ref",
    "missing-key", "different-key", "event-key", "generic-key", "quality-key", "missing-proof", "proof-retry",
    "proof-iteration", "proof-parent", "correction-child", "target", "old-iteration", "event-after-wake", "start-before-wake"] as const)(
    "fails closed for malformed correction evidence: %s", async kind => {
      const c = await admitted(), payload = structuredClone(c.wake.payload!);
      const ref = { ...c.ref }, proof = { ...readWorkflowAttemptProof(c.wake) };
      if (kind === "ref-request") ref.requestId = randomUUID();
      if (kind === "ref-company") ref.companyId = c.s.f.otherCompanyId;
      if (kind === "ref-run") ref.workflowRunId = randomUUID();
      if (kind === "ref-applied") ref.appliedEventId = randomUUID();
      payload.qaCorrectionFollowup = kind === "ref-extra" ? { ...ref, extra: true } : ref;
      if (kind === "missing-ref") delete payload.qaCorrectionFollowup;
      if (kind === "null-ref") payload.qaCorrectionFollowup = null;
      if (kind === "proof-retry") proof.retryCount++;
      if (kind === "proof-iteration") proof.iterationIndex++;
      if (kind === "proof-parent" || kind === "correction-child") proof.parentHeartbeatRunId = c.s.f.verdictHeartbeatId;
      payload[WORKFLOW_ATTEMPT_PROOF_KEY] = proof;
      if (kind === "missing-proof") delete payload[WORKFLOW_ATTEMPT_PROOF_KEY];
      let key = c.wake.idempotencyKey;
      if (kind === "missing-key") key = null;
      if (kind === "different-key") key = qaCorrectionWakeKey({ ...c.ref, requestId: randomUUID() });
      if (kind === "event-key") key = c.followupRow.idempotencyKey;
      if (kind === "generic-key") key = `workflow-step-retry:${c.step.id}:1`;
      if (kind === "quality-key") key = `quality-action-wake:${randomUUID()}`;
      await c.peer.update(agentWakeupRequests).set({ payload, idempotencyKey: key }).where(eq(agentWakeupRequests.id, c.wake.id));
      if (kind === "target") await c.peer.update(workflowTransitionEvents).set({
        payload: { ...c.followup, target: c.s.p.producer },
      }).where(eq(workflowTransitionEvents.id, c.followupRow.id));
      if (kind === "old-iteration") await c.peer.update(workflowStepRuns).set({ iterationIndex: 3 })
        .where(eq(workflowStepRuns.id, c.step.id));
      if (kind === "event-after-wake") await c.peer.update(workflowTransitionEvents)
        .set({ createdAt: new Date(c.wake.requestedAt.getTime() + 1000) }).where(eq(workflowTransitionEvents.id, c.followupRow.id));
      if (kind === "correction-child") await c.peer.update(heartbeatRuns).set({ retryOfRunId: c.s.f.verdictHeartbeatId })
        .where(eq(heartbeatRuns.id, c.heartbeat.id));
      if (kind === "start-before-wake") await c.peer.update(heartbeatRuns)
        .set({ startedAt: new Date(c.wake.requestedAt.getTime() - 1) }).where(eq(heartbeatRuns.id, c.heartbeat.id));
      const [heartbeat] = await c.peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, c.heartbeat.id));
      const [step] = await c.peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, c.step.id));
      await expect(producerAttempt(c.peer, heartbeat!, step!)).rejects.toThrow();
    }, 20000);
});
