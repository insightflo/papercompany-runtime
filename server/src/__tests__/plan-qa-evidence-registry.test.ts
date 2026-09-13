import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { issueAttachments, missionPlanQaVerdicts, qualityEvidenceRefs, qualityReviewItems, type Db } from "@paperclipai/db";
import { planQaVerdictStateSchema } from "@paperclipai/shared";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { checkoutReviewer, GATE_CHECK_ID, readAndVerify, seedGateWorld } from "./helpers/plan-qa-addendum.js";
import { buildPlanQaScope, readVerifiedPlanQaGate } from "../services/missions/plan-qa-addendum-gate.js";
import { evidenceContractSchema, hashContract } from "../services/quality/contract.js";

describeQualityDb("PLAN-QA shared evidence registry", () => {
  let owned: QualityTestDb;
  let db: Db;
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "quality-t8-registry-"));
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", root);
    owned = await createQualityTestDb(); db = owned.db;
  }, 120_000);
  afterAll(async () => { await owned?.close(); vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); });

  async function finalized(base: "pass" | "request_changes" = "pass") {
    const w = await seedGateWorld(db);
    const result = await readAndVerify(w, base, { [GATE_CHECK_ID]: "satisfied" });
    if (result.status === "missing_evidence") throw new Error("fixture did not finalize");
    const scope = await buildPlanQaScope(db, { companyId: w.companyId, issueId: w.planQaIssueId, heartbeatRunId: w.runId, executionEpoch: 1 });
    const [row] = await db.select().from(missionPlanQaVerdicts).where(eq(missionPlanQaVerdicts.planQaIssueId, w.planQaIssueId));
    const state = planQaVerdictStateSchema.parse(row.qualityContract);
    return { w, result, scope, state, row };
  }

  it.each(["pass", "request_changes"] as const)("returns a durable scoped registry ID for %s and replays without new records", async (base) => {
    const { w, result, scope, state } = await finalized(base);
    const [receipt] = await db.select().from(qualityEvidenceRefs).where(eq(qualityEvidenceRefs.id, result.evidenceRefId));
    expect(receipt).toBeDefined();
    expect(result.evidenceRefId).not.toBe(state.verdict!.receiptRef.attachmentId);
    const contract = evidenceContractSchema.parse(receipt.qualityContract);
    expect(contract).toMatchObject({ kind: "evaluation", scope, ref: state.verdict!.receiptRef, originalRef: state.verdict!.submissionRef,
      source: { companyId: w.companyId, issueId: w.planQaIssueId, heartbeatRunId: w.runId, executionEpoch: 1, mission: { kind: "mission", id: w.missionId }, workflow: { kind: "not_applicable", reason: "not_a_workflow_source" } } });
    const [review] = await db.select().from(qualityReviewItems).where(eq(qualityReviewItems.id, receipt.reviewItemId));
    expect(review).toMatchObject({ companyId: w.companyId, missionId: w.missionId, targetType: "other", targetId: w.planQaIssueId,
      triggerSource: "plan_qa_review", status: "closed", failureType: null });
    expect(review.triggerMetadata).toMatchObject({ schemaVersion: 1, kind: "plan_qa_evidence_review", scope, inputHash: contract.source.inputHash });
    const before = await db.select().from(qualityEvidenceRefs).where(eq(qualityEvidenceRefs.companyId, w.companyId));
    expect(before).toHaveLength(2);
    expect(await readAndVerify(w, base, { [GATE_CHECK_ID]: "satisfied" })).toEqual(result);
    expect(await db.select().from(qualityEvidenceRefs).where(eq(qualityEvidenceRefs.companyId, w.companyId))).toEqual(before);
    expect(await readVerifiedPlanQaGate(db, scope)).toEqual({ verdict: base, evidenceRefId: result.evidenceRefId });
  });

  it("refuses a deleted registry row even when both attachments still exist, including replay", async () => {
    const { w, result, scope, state } = await finalized();
    await db.delete(qualityEvidenceRefs).where(eq(qualityEvidenceRefs.id, result.evidenceRefId));
    expect(await db.select().from(issueAttachments).where(eq(issueAttachments.id, state.verdict!.receiptRef.attachmentId))).toHaveLength(1);
    expect(await readVerifiedPlanQaGate(db, scope)).toBeNull();
    await expect(readAndVerify(w, "pass", { [GATE_CHECK_ID]: "satisfied" })).rejects.toMatchObject({ status: 409 });
  });

  it.each(["absent", "attachment", "foreign"])("rejects %s evidenceRefId in the verdict index", async (kind) => {
    const { scope, state, row } = await finalized();
    const foreign = kind === "foreign" ? await finalized() : null;
    const evidenceRefId = foreign?.result.evidenceRefId ?? (kind === "attachment" ? state.verdict!.receiptRef.attachmentId : randomUUID());
    await db.update(missionPlanQaVerdicts).set({ qualityContract: { ...state, verdict: { ...state.verdict!, evidenceRefId } } })
      .where(eq(missionPlanQaVerdicts.id, row.id));
    expect(await readVerifiedPlanQaGate(db, scope)).toBeNull();
  });

  it.each(["status", "sourceRun", "contractKind", "sourceHash", "scopeEpoch", "originalRef", "issuer", "expiry"])("rejects tampered registry %s", async (kind) => {
    const { result, scope } = await finalized();
    const [receipt] = await db.select().from(qualityEvidenceRefs).where(eq(qualityEvidenceRefs.id, result.evidenceRefId));
    expect(receipt).toBeDefined();
    const contract = evidenceContractSchema.parse(receipt.qualityContract);
    const foreign = kind === "sourceRun" ? await seedGateWorld(db) : null;
    const mutation = kind === "status" ? { status: "pending" }
      : kind === "sourceRun" ? { sourceRunId: foreign!.runId }
      : kind === "issuer" ? { collectedByActorId: "other" }
      : kind === "expiry" ? { freshnessExpiresAt: new Date(0) }
      : { qualityContract: { ...contract, ...(kind === "contractKind" ? { kind: "read" }
        : kind === "sourceHash" ? { source: { ...contract.source, inputHash: "0".repeat(64) } }
        : kind === "scopeEpoch" ? { scope: { ...scope, executionEpoch: scope.executionEpoch + 1 } }
        : { originalRef: null }) } };
    await db.update(qualityEvidenceRefs).set(mutation).where(eq(qualityEvidenceRefs.id, result.evidenceRefId));
    expect(await readVerifiedPlanQaGate(db, scope)).toBeNull();
  });

  it.each(["company", "mission", "issue", "metadata", "reviewSwap"])("rejects out-of-scope review ownership: %s", async (kind) => {
    const { w, result, scope } = await finalized();
    const foreign = await seedGateWorld(db);
    const [receipt] = await db.select().from(qualityEvidenceRefs).where(eq(qualityEvidenceRefs.id, result.evidenceRefId));
    expect(receipt).toBeDefined();
    if (kind === "reviewSwap") {
      const [unrelated] = await db.insert(qualityReviewItems).values({ companyId: w.companyId, missionId: w.missionId,
        title: "unrelated", targetType: "other", targetId: w.planningIssueId, triggerSource: "manual" }).returning();
      await db.update(qualityEvidenceRefs).set({ reviewItemId: unrelated.id }).where(eq(qualityEvidenceRefs.id, receipt.id));
    } else {
      await db.update(qualityReviewItems).set(kind === "company" ? { companyId: foreign.companyId }
        : kind === "mission" ? { missionId: foreign.missionId }
        : kind === "issue" ? { targetId: w.planningIssueId } : { triggerMetadata: {} })
        .where(eq(qualityReviewItems.id, receipt.reviewItemId));
    }
    expect(await readVerifiedPlanQaGate(db, scope)).toBeNull();
  });

  it.each(["receipt", "submission"])("rejects %s attachments moved to another issue", async (kind) => {
    const { w, scope, state } = await finalized();
    const ref = kind === "receipt" ? state.verdict!.receiptRef : state.verdict!.submissionRef;
    await db.update(issueAttachments).set({ issueId: w.planningIssueId }).where(eq(issueAttachments.id, ref.attachmentId));
    expect(await readVerifiedPlanQaGate(db, scope)).toBeNull();
  });

  it("rejects an old attachment-only verdict without a registry ID", async () => {
    const { scope, state, row } = await finalized();
    const { evidenceRefId: _discarded, ...verdict } = state.verdict!;
    await db.update(missionPlanQaVerdicts).set({ qualityContract: { ...state, verdict } }).where(eq(missionPlanQaVerdicts.id, row.id));
    expect(await readVerifiedPlanQaGate(db, scope)).toBeNull();
  });

  it("requires the original submission registry record, not only its bytes", async () => {
    const { w, result, scope } = await finalized();
    const receipts = await db.select().from(qualityEvidenceRefs).where(eq(qualityEvidenceRefs.companyId, w.companyId));
    const original = receipts.find((r) => r.id !== result.evidenceRefId);
    expect(original).toBeDefined();
    await db.delete(qualityEvidenceRefs).where(eq(qualityEvidenceRefs.id, original!.id));
    expect(await readVerifiedPlanQaGate(db, scope)).toBeNull();
  });

  it("preserves prior-attempt registry records without authorizing a newer attempt", async () => {
    const { w, result, scope } = await finalized();
    const before = await db.select().from(qualityEvidenceRefs).where(eq(qualityEvidenceRefs.companyId, w.companyId));
    const runId = await checkoutReviewer(db, { companyId: w.companyId, issueId: w.planQaIssueId, reviewerAgentId: w.reviewerAgentId, executionEpoch: 2 });
    expect(await readVerifiedPlanQaGate(db, scope)).toBeNull();
    const next = await readAndVerify(w, "pass", { [GATE_CHECK_ID]: "satisfied" }, { runId, executionEpoch: 2 });
    expect(next).toMatchObject({ status: "pass" });
    expect("evidenceRefId" in next && next.evidenceRefId).not.toBe(result.evidenceRefId);
    for (const receipt of before) {
      const [after] = await db.select().from(qualityEvidenceRefs).where(eq(qualityEvidenceRefs.id, receipt.id));
      expect(hashContract(after.qualityContract)).toBe(hashContract(receipt.qualityContract));
    }
  });

  it("does not register missing evidence as a completed review", async () => {
    const w = await seedGateWorld(db);
    expect(await readAndVerify(w, "pass", { [GATE_CHECK_ID]: "insufficient_evidence" })).toMatchObject({ status: "missing_evidence" });
    expect(await db.select().from(qualityEvidenceRefs).where(eq(qualityEvidenceRefs.companyId, w.companyId))).toHaveLength(0);
    expect(await db.select().from(qualityReviewItems).where(eq(qualityReviewItems.companyId, w.companyId))).toHaveLength(0);
  });
});
