import path from "node:path";
import { readFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, issues, missions, qualityActions,
  workflowTransitionEvents } from "@paperclipai/db";
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
