import path from "node:path";
import { readFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, heartbeatRuns, issues, missions, qualityActions,
  workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { createConsumptionHarness } from "./helpers/c02-consumption-fixture.js";
import { commitBuffers, commitDbState, makeCommitSource, type CommitSourceCase } from "./qa-correction-commit-fixture.js";
import { correctionRows, deliver, deliveryInput } from "./helpers/c02-delivery-fixture.js";
import type { C02Case } from "./helpers/c02-fixture.js";
import { applyCurrentOutputCorrection } from "../services/quality/current-output.js";
import { hashContract } from "../services/quality/contract.js";
import { beginQaCorrection } from "../services/workflow/control-flow/qa-correction-prepare.js";
import { parseQaCorrectionEventPayload, qaCorrectionAppliedKey } from "../services/workflow/control-flow/qa-correction-contract.js";
import { readIssuedQaCorrection } from "../services/workflow/control-flow/qa-correction-reader.js";
import { readQaCorrectionFollowupConsumption } from "../services/workflow/control-flow/qa-correction-followup.js";
import { captureArtifactRoot } from "../services/workflow/artifact-files.js";
import { claimHeartbeatWithRecoveryGuard } from "../services/heartbeat-recovery-guard.js";
import { submitWorkflowVerdict } from "../services/workflow/agent-api.js";
import { hasWorkflowValidationCompletionLedger } from "../services/workflow/validation-verdict-ledger.js";
import { cancelQualityIntent, deliverQualityIntent, readQualityCancellation } from "../services/quality/native-delivery.js";
import { reconcileQualityIntents } from "../services/quality/native-reconcile.js";
import { finalizeRunTerminal } from "../services/workflow/run-terminal-boundary.js";
import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";

// Only the external model is replaced; public delivery, queue, claim and official verdict writes stay real.
const adapter = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", async original => ({
  ...await original<typeof import("../adapters/index.js")>(),
  getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute: adapter }),
}));

const support = await getEmbeddedPostgresTestSupport(), describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping C02 quality tests: ${support.reason ?? "unsupported host"}`);

describeEP("C02 15A: quality entry uses C03 issuance and stored consumption", () => {
  let owned: Awaited<ReturnType<typeof createConsumptionHarness>>;
  beforeAll(async () => { owned = await createConsumptionHarness(); }, 60000);
  afterAll(async () => { await owned?.close(); }, 60000);

  async function source() {
    const s = await makeCommitSource(owned.db, owned.root, "content-only", false, true);
    if (s.p.authority.kind !== "quality_current_output") throw Error("quality authority required");
    const a = s.p.authority;
    const [action] = await owned.db.select().from(qualityActions).where(eq(qualityActions.id, a.actionId));
    const retryEnvelope = { ...action!.retryEnvelope, maxExecutorAttempts: 1 };
    a.retryEnvelopeHash = hashContract(retryEnvelope);
    await owned.db.update(qualityActions).set({ retryEnvelope }).where(eq(qualityActions.id, a.actionId));
    // Finished A is not a live queue request competing with the issued B delivery.
    await owned.db.update(agentWakeupRequests).set({ status: "completed" })
      .where(eq(agentWakeupRequests.id, s.f.verdictWakeId));
    return { s, key: { companyId: s.p.companyId, actionId: a.actionId } };
  }

  /** Read actual issuance into the existing delivery fixture's descriptor; no receipt/queue rows are seeded. */
  async function issued(s: CommitSourceCase): Promise<C02Case> {
    const peer = owned.connect(), rows = await peer.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, s.p.companyId), eq(workflowTransitionEvents.eventType, "qa_correction_prepared")));
    expect(rows).toHaveLength(1);
    s.p = parseQaCorrectionEventPayload("qa_correction_prepared", rows[0]!.payload);
    const [appliedRow] = await peer.select().from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.idempotencyKey, qaCorrectionAppliedKey(s.p.correctionId)));
    if (!appliedRow) throw Error("quality entry did not issue B");
    const proof = await readIssuedQaCorrection(peer, {
      companyId: s.p.companyId, workflowRunId: s.p.workflowRunId, appliedEventId: appliedRow.id });
    expect(proof.followups).toHaveLength(1);
    const [followupRow] = await peer.select().from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.id, proof.applied.followupEventIds[0]!));
    if (!followupRow) throw Error("quality entry did not request B QA");
    const revisions = proof.applied.revisions.map(r => {
      if (r.bundleManifestRelativePath === undefined || r.assetsRelativeRoot === undefined) throw Error("issued layout required");
      return { ...r, bundleManifestRelativePath: r.bundleManifestRelativePath, assetsRelativeRoot: r.assetsRelativeRoot };
    });
    const outputs = await Promise.all(revisions.map(async r => ({
      sourceProductId: r.sourceProductId, artifactRoot: await captureArtifactRoot(r.root),
      mainPath: path.join(r.root, r.mainRelativePath),
      assetsRoot: r.assetsRelativeRoot === null ? null : path.resolve(r.root, r.assetsRelativeRoot),
    })));
    // Storage descriptor is reconstructed from committed C03 facts solely to reuse delivery assembly.
    const stored = { status: "stored_uncommitted" as const, revisions, outputs,
      preparationEventId: s.p.correctionId, preparationHash: proof.applied.preparationHash,
      sourceMeasuredEventId: proof.applied.sourceMeasuredEventId, sourceMeasuredHash: proof.applied.sourceMeasuredHash,
      sourceMeasured: proof.sourceMeasured };
    return { s, peer, stored, appliedRow, applied: proof.applied, followupRow, followup: proof.followups[0]!,
      ref: { companyId: s.p.companyId, workflowRunId: s.p.workflowRunId,
        appliedEventId: appliedRow.id, requestId: proof.followups[0]!.requestId } };
  }


  // C02/15B oracle: the public caller preserves A, issues B once, and accepts delivery before B is consumed.
  // Run this unchanged on the baseline native-delivery.ts: its quality wake cannot produce the C03 rows below.
  it("15B public delivery reuses the last slot through queue, claim, official consumption and terminal release", async () => {
    const { s, key } = await source(), peer = owned.connect();
    const agentId = s.f.quality!.verifierAgentId;
    await peer.update(agents).set({ status: "paused", adapterType: "codex_local",
      adapterConfig: { cwd: owned.root }, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } })
      .where(eq(agents.id, agentId));
    await peer.update(issues).set({ completedAt: s.f.producer.completedAt }).where(eq(issues.id, s.p.producer.issueId));
    await peer.update(issues).set({ assigneeAgentId: agentId }).where(eq(issues.id, s.f.qa.issueId!));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "11".repeat(32));
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    adapter.mockReset();
    try {
      const before = await commitDbState({ ...s, db: peer });
      const waiting = await deliverQualityIntent(owned.db, key);
      expect(waiting).toMatchObject({ status: "waiting", receiptId: expect.any(String) });
      const c = await issued(s), revision = c.applied.revisions[0]!;
      const state = () => commitDbState({ ...s, db: peer });
      const queued = await correctionRows(c), issuedState = await state();
      expect([queued.wakes.length, queued.heartbeats.length, queued.receipts.length]).toEqual([1, 0, 0]);
      expect(queued.wakes[0]).toMatchObject({ id: waiting.receiptId, status: "queued",
        idempotencyKey: "qa-correction-wake:" + c.ref.requestId, payload: { qaCorrectionFollowup: c.ref } });
      expect(await readFile(s.file)).toEqual(commitBuffers(s.mode, "old").get("report.html"));
      expect(await readFile(path.join(revision.root, revision.mainRelativePath)))
        .toEqual(commitBuffers(s.mode, "new").get("report.html"));
      expect(issuedState.products.find(p => p.id === s.productId)?.status).toBe("archived");
      expect(issuedState.products.find(p => p.id === revision.workProductId)?.status).toBe("active");
      expect(issuedState.pins.find(b => b.id === s.f.bindingId)?.workProductId).toBe(revision.workProductId);
      expect(issuedState.receipts).toHaveLength(1);
      expect(issuedState.receipts[0]).toMatchObject({ id: c.applied.qualityUseEvidenceRefId, qualityContract: { kind: "use" } });
      expect(issuedState.usage[0]!.executionAttempts).toBe(1);
      expect(issuedState.groups[0]!.usage.executionAttempts).toBe(1);
      expect(issuedState.events.filter(e => e.eventType === "qa_correction_prepared")).toHaveLength(1);
      expect(issuedState.events.filter(e => e.eventType === "qa_correction_followup_requested")).toHaveLength(1);
      expect(await deliverQualityIntent(peer, key)).toEqual(waiting);
      expect(await state()).toEqual(issuedState);
      expect(adapter).not.toHaveBeenCalled();
      const finalize = async () => finalizeRunTerminal(peer, {
        companyId: key.companyId, runId: s.p.workflowRunId, expectedAuthorityVersion: 0, decision: "completed",
        cause: { policy: "outcome_convergence", discovery: "engine_recompute", origin: "dag_engine" },
        gatePolicy: "immediate", now: new Date(),
        stepRuns: await peer.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, s.p.workflowRunId)),
      });
      expect(await finalize()).toMatchObject({ kind: "deferred", gateKind: "open", run: { status: "running" } });
      const executed: Array<{ runId: string; wakeId: string; ref: unknown }> = [];
      adapter.mockImplementation(async (ctx: { runId: string; agent: { id: string } }) => {
        const [run] = await peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, ctx.runId));
        const [wake] = await peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, run!.wakeupRequestId!));
        expect(ctx.agent.id).toBe(agentId);
        expect(run).toMatchObject({ status: "running", workflowStepRunId: c.followup.target.stepRunId,
          workflowExecutionGeneration: c.followup.target.executionGeneration });
        expect(wake).toMatchObject({ id: waiting.receiptId, runId: ctx.runId,
          payload: { qaCorrectionFollowup: c.ref } });
        expect((await correctionRows(c)).receipts[0]).toMatchObject({ heartbeatRunId: ctx.runId, wakeupRequestId: wake!.id });
        executed.push({ runId: ctx.runId, wakeId: wake!.id, ref: wake!.payload?.qaCorrectionFollowup });
        await held;
        return { exitCode: 0, signal: null, timedOut: false, usage: null,
          provider: "test", model: "test", resultJson: null, runtimeServices: [] };
      });
      await peer.update(agents).set({ status: "active" }).where(eq(agents.id, agentId));
      const accepted = await deliverQualityIntent(owned.db, key);
      expect(accepted).toEqual({ status: "accepted", receiptId: waiting.receiptId });
      await vi.waitFor(() => expect(executed).toHaveLength(1), { timeout: 5000 });
      const delivered = await correctionRows(c);
      expect([delivered.wakes.length, delivered.heartbeats.length, delivered.receipts.length]).toEqual([1, 1, 1]);
      expect(executed).toEqual([{ runId: delivered.heartbeats[0]!.id, wakeId: waiting.receiptId, ref: c.ref }]);
      expect(await reconcileQualityIntents(peer, { ownership: "native-active-plugin-disabled", now: new Date() }))
        .toMatchObject({ visited: 1, accepted: 1, blocked: 0 });
      expect(await readQaCorrectionFollowupConsumption(peer, c.ref, readIssuedQaCorrection)).toBeNull();
      expect((await state()).events.filter(e => e.eventType === "workflow_validation_verdict"
        && e.heartbeatRunId === executed[0]!.runId)).toHaveLength(0);
      expect((await peer.select().from(qualityActions).where(eq(qualityActions.id, key.actionId)))[0]!.state).not.toBe("corrected");
      expect(await finalize()).toMatchObject({ kind: "deferred", gateKind: "open", run: { status: "running" } });
      const [issue] = await peer.select().from(issues).where(eq(issues.id, c.followup.target.issueId));
      if (!issue) throw Error("public B issue required");
      expect(await submitWorkflowVerdict({ db: owned.db, issue,
        actor: { actorType: "agent", actorId: agentId, agentId, runId: executed[0]!.runId },
        data: { verdict: "pass", reason: "Publicly delivered B checked" } })).toMatchObject({ satisfied: true, verdict: "pass" });
      const relation = await readQaCorrectionFollowupConsumption(peer, c.ref, readIssuedQaCorrection);
      expect(relation?.consumed).toMatchObject({ ref: c.ref, followupEventId: c.followupRow.id,
        evidence: { kind: "workflow_verdict" } });
      if (relation?.consumed.evidence.kind !== "workflow_verdict") throw Error("public B official consumption required");
      const [verdict] = await peer.select().from(workflowTransitionEvents)
        .where(eq(workflowTransitionEvents.id, relation.consumed.evidence.eventId));
      expect(verdict).toMatchObject({ heartbeatRunId: executed[0]!.runId, verdict: "pass" });
      expect(await hasWorkflowValidationCompletionLedger({ db: peer, issue })).toMatchObject({ satisfied: true, verdict: "pass" });
      expect(await deliverQualityIntent(peer, key)).toEqual(accepted);
      const consumed = await state();
      expect(consumed.receipts).toEqual(issuedState.receipts);
      expect(consumed.usage).toEqual(issuedState.usage);
      expect(consumed.groups).toEqual(issuedState.groups);
      expect(consumed.events.filter(e => e.eventType === "qa_correction_followup_consumed")).toHaveLength(1);
      expect(consumed.wakes).toHaveLength(before.wakes.length + 1);
      expect(consumed.wakes.filter(w => w.idempotencyKey?.startsWith("quality-action-wake:"))).toEqual(
        before.wakes.filter(w => w.idempotencyKey?.startsWith("quality-action-wake:")));
      expect(await finalize()).toMatchObject({ kind: "finalized", run: { status: "completed" } });
      const cancellation = await cancelQualityIntent(peer, key);
      expect(cancellation).toMatchObject({ heartbeatRunId: executed[0]!.runId, runCancellationRequested: true });
      expect(await readQualityCancellation(peer, key)).toMatchObject({
        requested: true, runStatus: "cancelled", cancelledConfirmed: true });
      release();
      await waitForHeartbeatExecutionsToDrain(owned.db);
      await waitForHeartbeatExecutionsToDrain(peer);
      expect(await correctionRows(c)).toMatchObject({ wakes: [expect.objectContaining({ id: waiting.receiptId })],
        heartbeats: [expect.objectContaining({ id: executed[0]!.runId })], receipts: [expect.any(Object)] });
      const settled = await state();
      expect(settled.receipts).toEqual(issuedState.receipts);
      expect(settled.usage).toEqual(issuedState.usage);
      expect(settled.groups).toEqual(issuedState.groups);
      expect(settled.wakes).toHaveLength(before.wakes.length + 1);
      expect(settled.heartbeats).toHaveLength(before.heartbeats.length + 1);
      expect(settled.events.filter(e => e.eventType === "qa_correction_followup_requested")).toHaveLength(1);
      expect(adapter).toHaveBeenCalledTimes(1);
      const cancelled = await state();
      expect(await deliverQualityIntent(peer, key)).toEqual({ status: "blocked", receiptId: null });
      expect(await state()).toEqual(cancelled);
    } finally {
      release();
      await waitForHeartbeatExecutionsToDrain(owned.db);
      await waitForHeartbeatExecutionsToDrain(peer);
      adapter.mockReset();
    }
  }, 60000);

  // Accepted plan :54 supplies the oracle: immutable A -> registered B, one reservation/use, same request on replay.
  // B->C/cancel-first, rollback and concurrent first effects stay in c02-consumption.test.ts:151-299.
  // The baseline's in-place patch/extra use path cannot satisfy these same byte and peer-SQL assertions.
  it("issues B at the last slot, consumes its official verdict, and replays after cancellation", async () => {
    const { s, key } = await source(), before = await commitDbState(s);
    const first = await applyCurrentOutputCorrection(owned.db, key);
    expect(first).toMatchObject({ status: "verification_pending", evidenceRefId: expect.any(String) });
    const c = await issued(s), after = await commitDbState({ ...s, db: c.peer });
    const revision = c.applied.revisions[0]!;
    expect(await readFile(s.file)).toEqual(commitBuffers(s.mode, "old").get("report.html"));
    expect(await readFile(path.join(revision.root, revision.mainRelativePath)))
      .toEqual(commitBuffers(s.mode, "new").get("report.html"));
    expect(after.products.find(p => p.id === s.productId)?.status).toBe("archived");
    expect(after.products.find(p => p.id === revision.workProductId)?.status).toBe("active");
    expect(after.pins.find(b => b.id === s.f.bindingId)?.workProductId).toBe(revision.workProductId);
    expect(after.events.filter(e => e.eventType === "qa_correction_followup_requested")).toHaveLength(1);
    expect(after.events.filter(e => e.eventType === "qa_correction_followup_consumed")).toHaveLength(0);
    expect(first.evidenceRefId).toBe(c.applied.qualityUseEvidenceRefId);
    expect(after.receipts).toHaveLength(1);
    expect(after.receipts[0]).toMatchObject({ id: first.evidenceRefId, qualityContract: { kind: "use" } });
    expect(after.usage).toHaveLength(1);
    expect(after.usage[0]!.executionAttempts).toBe(1);
    expect(after.groups[0]!.usage.executionAttempts).toBe(1);
    expect(after.wakes).toEqual(before.wakes);
    expect(after.heartbeats).toEqual(before.heartbeats);
    const [pending] = await c.peer.select().from(qualityActions).where(eq(qualityActions.id, key.actionId));
    expect(pending!.state).not.toBe("corrected"); // A's succeeded heartbeat is not a PASS for B.
    expect(await applyCurrentOutputCorrection(c.peer, key)).toEqual(first);
    expect(await commitDbState({ ...s, db: c.peer })).toEqual(after);

    const input = await deliveryInput(c);
    expect((await deliver(c, input)).kind).toBe("new_delivery");
    const queued = (await correctionRows(c)).heartbeats[0]!;
    const actor = await claimHeartbeatWithRecoveryGuard(owned.db, queued, new Date());
    if (!actor) throw Error("real B claim required");
    const [issue] = await c.peer.select().from(issues).where(eq(issues.id, c.followup.target.issueId));
    if (!issue) throw Error("real B issue required");
    const submission = { db: owned.db, issue, actor: { actorType: "agent" as const, actorId: actor.agentId,
      agentId: actor.agentId, runId: actor.id }, data: { verdict: "pass" as const, reason: "B checked" } };
    const verdict = await submitWorkflowVerdict(submission);
    expect(verdict).toMatchObject({ satisfied: true, verdict: "pass" });
    const relation = await readQaCorrectionFollowupConsumption(c.peer, c.ref, readIssuedQaCorrection);
    expect(relation?.consumed).toMatchObject({ schemaVersion: "workflow.qa-correction.consumption.v2",
      ref: c.ref, followupEventId: c.followupRow.id, evidence: { kind: "workflow_verdict" } });
    if (relation?.consumed.evidence.kind !== "workflow_verdict") throw Error("official B consumption required");
    const [event] = await c.peer.select().from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.id, relation.consumed.evidence.eventId));
    expect(event).toMatchObject({ heartbeatRunId: actor.id, verdict: "pass",
      workflowStepRunId: c.followup.target.stepRunId, payload: { reason: "B checked" } });
    expect(await hasWorkflowValidationCompletionLedger({ db: c.peer, issue })).toMatchObject({ satisfied: true, verdict: "pass" });
    const consumed = await commitDbState({ ...s, db: c.peer });
    expect(consumed.receipts).toEqual(after.receipts);
    expect(consumed.usage).toEqual(after.usage);
    expect(consumed.groups).toEqual(after.groups);
    expect(await applyCurrentOutputCorrection(c.peer, key)).toEqual(first);
    expect(await commitDbState({ ...s, db: c.peer })).toEqual(consumed);

    await c.peer.update(missions).set({ status: "cancelled" }).where(eq(missions.id, s.p.missionId));
    const cancelled = await commitDbState({ ...s, db: c.peer });
    expect(await submitWorkflowVerdict({ ...submission,
      data: { verdict: "request_changes", reason: "Incoming replay cannot replace first B effect" } })).toEqual(verdict);
    expect(await applyCurrentOutputCorrection(c.peer, key)).toEqual(first);
    expect(await commitDbState({ ...s, db: c.peer })).toEqual(cancelled);
  }, 60000);

  it("resumes the recorded quality preparation without reserving another attempt", async () => {
    const { s, key } = await source();
    const prepared = await beginQaCorrection(owned.db, s.p);
    if (prepared.status !== "prepared") throw Error("real reserved preparation required");
    const preparationEventId = prepared.preparationEventId;
    const before = await commitDbState(s);
    expect(before.usage[0]!.executionAttempts).toBe(1);
    const result = await applyCurrentOutputCorrection(owned.db, key), c = await issued(s);
    expect(result.evidenceRefId).toBe(c.applied.qualityUseEvidenceRefId);
    expect(c.applied.preparationEventId).toBe(preparationEventId);
    const after = await commitDbState({ ...s, db: c.peer });
    expect(after.usage).toEqual(before.usage);
    expect(after.groups).toEqual(before.groups);
    expect(after.events.filter(e => e.eventType === "qa_correction_prepared")).toHaveLength(1);
    expect(after.receipts).toHaveLength(1);
    expect(await applyCurrentOutputCorrection(c.peer, key)).toEqual(result);
    expect(await commitDbState({ ...s, db: c.peer })).toEqual(after);
  }, 60000);
});
