import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { assets, issueAttachments, heartbeatRuns, issues, qualityEvidenceRefs, qualityOccurrences, qualityReviewItems, qualityActions, activityLog, missionPlanArtifacts } from "@paperclipai/db";
import type { OutputCorrectionScope, PlanQaScope, SourceAttempt } from "@paperclipai/shared";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { seedQualityFixture, type QualityFixture } from "./helpers/quality-fixture.js";
import { getStorageService } from "../storage/index.js";
import { uploadEvidence, linkEvidence, readEvidence } from "../services/quality/evidence-store.js";
import { writeOccurrence } from "../services/quality/occurrences.js";
import { hashContract } from "../services/quality/contract.js";

describeQualityDb("Quality real DB and StorageService evidence", () => {
  let owned: QualityTestDb;
  let f: QualityFixture;
  let root: string;
  let source: SourceAttempt;
  let scope: OutputCorrectionScope;
  let reviewItemId: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "quality-t2-storage-"));
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", root);
    owned = await createQualityTestDb();
    f = await seedQualityFixture(owned.db);
    const [issue] = await owned.db.insert(issues).values({ companyId: f.companyId, title: "source", missionId: f.sourceMissionId }).returning();
    const [run] = await owned.db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.authorAgentId, issueId: issue.id, executionEpoch: 1 }).returning();
    const [verifier] = await owned.db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.verifierAgentId, issueId: issue.id, executionEpoch: 1 }).returning();
    source = { companyId: f.companyId, issueId: issue.id, heartbeatRunId: run.id, executionEpoch: 1, inputHash: "ab".repeat(32), mission: { kind: "mission", id: f.sourceMissionId }, workflow: { kind: "not_applicable", reason: "not_a_workflow_source" } };
    scope = { kind: "output_correction", companyId: f.companyId, actionId: f.actionId, source, verifierRunId: verifier.id, verifierEpoch: 1 };
    const target = { kind: "current_output" as const, source };
    const effect = { kind: "repair_supported_output" as const, target };
    await owned.db.update(qualityActions).set({ kind: "current_output", target, targetHash: hashContract(target), effect, effectHash: hashContract(effect) }).where(eq(qualityActions.id, f.actionId));
    const [review] = await owned.db.insert(qualityReviewItems).values({ companyId: f.companyId, title: "review", targetType: "current_output", triggerSource: "test", failureType: "test" }).returning();
    reviewItemId = review.id;
  }, 120_000);
  afterAll(async () => { await owned?.close(); vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true }); });
  async function upload() {
    return uploadEvidence(getStorageService(), { companyId: f.companyId, body: Buffer.from("verified bytes"), contentType: "text/plain", originalFilename: "evidence.txt" });
  }
  async function stored() {
    const uploaded = await upload();
    const result = await owned.db.transaction((tx) => linkEvidence(tx, { companyId: f.companyId, reviewItemId, source, scope, kind: "input", uploaded, expiresAt: new Date(Date.now() + 60_000).toISOString(), issuedBy: "quality-test" }));
    return { ...result, uploaded };
  }
  it("links asset, attachment and verified receipt together; reads real bytes and preserves refs across occurrences", async () => {
    const first = await stored();
    expect(await readEvidence(owned.db, { companyId: f.companyId, ref: first.ref, scope, maxBytes: 100 })).toEqual(Buffer.from("verified bytes"));
    const a = await writeOccurrence(owned.db, { companyId: f.companyId, reviewItemId, producerRunId: source.heartbeatRunId, submissionKey: "first", source, evidence: [first.ref] });
    const replay = await writeOccurrence(owned.db, { companyId: f.companyId, reviewItemId, producerRunId: source.heartbeatRunId, submissionKey: "first", source, evidence: [first.ref] });
    expect(replay).toEqual({ occurrenceId: a.occurrenceId, replayed: true });
    const second = await stored();
    await expect(writeOccurrence(owned.db, { companyId: f.companyId, reviewItemId, producerRunId: source.heartbeatRunId, submissionKey: "first", source, evidence: [second.ref] })).rejects.toMatchObject({ status: 409 });
    const b = await writeOccurrence(owned.db, { companyId: f.companyId, reviewItemId, producerRunId: source.heartbeatRunId, submissionKey: "second", source, evidence: [second.ref] });
    expect(a.occurrenceId).not.toBe(b.occurrenceId);
    const rows = await owned.db.select().from(qualityOccurrences).where(eq(qualityOccurrences.reviewItemId, reviewItemId));
    expect(rows.map((r) => r.evidenceRefIds)).toContainEqual([first.evidenceRefId]);
    expect(rows.map((r) => r.evidenceRefIds)).toContainEqual([second.evidenceRefId]);
  });
  it("captures source-bound input without an action ID; null scope never authorizes execution", async () => {
    const uploaded = await upload();
    const item = await owned.db.transaction((tx) => linkEvidence(tx, { companyId: f.companyId, reviewItemId, source, scope: null, kind: "input", uploaded, expiresAt: null, issuedBy: "quality-test" }));
    const occurrence = await writeOccurrence(owned.db, { companyId: f.companyId, reviewItemId, producerRunId: source.heartbeatRunId, submissionKey: "pre-action", source, evidence: [item.ref] });
    expect(occurrence.replayed).toBe(false);
    expect(await readEvidence(owned.db, { companyId: f.companyId, ref: item.ref, scope, maxBytes: 100 })).toEqual(Buffer.from("verified bytes"));
    await expect(readEvidence(owned.db, { companyId: f.companyId, ref: item.ref, scope: { ...scope, source: { ...source, inputHash: "bc".repeat(32) } }, maxBytes: 100 })).rejects.toMatchObject({ message: "quality_evidence_scope_mismatch" });
    await expect(owned.db.transaction((tx) => linkEvidence(tx, { companyId: f.companyId, reviewItemId, source, scope: null, kind: "evaluation", uploaded, expiresAt: null, issuedBy: "quality-test" }))).rejects.toMatchObject({ message: "quality_evidence_invalid_contract" });
  });
  it("reads PLAN-QA evidence only for the exact manifest and review generation", async () => {
    const manifest = await stored();
    const [plan] = await owned.db.insert(missionPlanArtifacts).values({ companyId: f.companyId, missionId: f.sourceMissionId, ownerAgentId: f.authorAgentId, missionGoal: "fixture" }).returning();
    const planScope: PlanQaScope = { kind: "plan_qa", companyId: f.companyId, missionId: f.sourceMissionId, planArtifactId: plan.id, issueId: source.issueId, decisionHash: "ef".repeat(32), manifestRef: manifest.ref, reviewGeneration: 2, heartbeatRunId: source.heartbeatRunId, executionEpoch: 1, workflow: { kind: "not_applicable", reason: "mission_plan_qa_issue" } };
    const uploaded = await upload();
    const item = await owned.db.transaction((tx) => linkEvidence(tx, { companyId: f.companyId, reviewItemId, source, scope: planScope, kind: "submission", uploaded, expiresAt: null, issuedBy: "quality-test" }));
    expect(await readEvidence(owned.db, { companyId: f.companyId, ref: item.ref, scope: planScope, maxBytes: 100 })).toEqual(Buffer.from("verified bytes"));
    for (const change of [{ reviewGeneration: 3 }, { manifestRef: { ...manifest.ref, sha256: "ff".repeat(32) } }, { decisionHash: "ee".repeat(32) }]) {
      await expect(readEvidence(owned.db, { companyId: f.companyId, ref: item.ref, scope: { ...planScope, ...change }, maxBytes: 100 })).rejects.toMatchObject({ message: "quality_evidence_scope_mismatch" });
    }
    await owned.db.update(missionPlanArtifacts).set({ status: "archived" }).where(eq(missionPlanArtifacts.id, plan.id));
    await expect(readEvidence(owned.db, { companyId: f.companyId, ref: item.ref, scope: planScope, maxBytes: 100 })).rejects.toMatchObject({ message: "quality_evidence_archived" });
  });
  it("links a smaller read receipt to its verified original without confusing their size limits", async () => {
    const original = await stored();
    const uploaded = await uploadEvidence(getStorageService(), { companyId: f.companyId, body: Buffer.from("x"), contentType: "text/plain", originalFilename: "read.txt" });
    const linked = await owned.db.transaction((tx) => linkEvidence(tx, { companyId: f.companyId, reviewItemId, source, scope, kind: "read", uploaded, expiresAt: null, issuedBy: "quality-test", originalRef: original.ref }));
    const [receipt] = await owned.db.select().from(qualityEvidenceRefs).where(eq(qualityEvidenceRefs.id, linked.evidenceRefId));
    expect(receipt.qualityContract?.originalRef).toEqual(original.ref);
    expect(await readEvidence(owned.db, { companyId: f.companyId, ref: linked.ref, scope, maxBytes: 1 })).toEqual(Buffer.from("x"));
  });
  it("records evidence-link audit in the same transaction", async () => {
    const item = await stored();
    const entries = await owned.db.select().from(activityLog).where(eq(activityLog.entityId, item.evidenceRefId));
    expect(entries).toMatchObject([{ companyId: f.companyId, action: "quality.evidence_linked", entityType: "quality_evidence_ref" }]);
  });
  it("leaves an upload unlinked on caller rollback and never treats it as successful evidence", async () => {
    const before = { assets: await owned.db.select().from(assets), attachments: await owned.db.select().from(issueAttachments), receipts: await owned.db.select().from(qualityEvidenceRefs) };
    const uploaded = await upload();
    await expect(owned.db.transaction(async (tx) => {
      await linkEvidence(tx, { companyId: f.companyId, reviewItemId, source, scope, kind: "input", uploaded, expiresAt: null, issuedBy: "quality-test" });
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(await owned.db.select().from(assets)).toEqual(before.assets);
    expect(await owned.db.select().from(issueAttachments)).toEqual(before.attachments);
    expect(await owned.db.select().from(qualityEvidenceRefs)).toEqual(before.receipts);
    expect((await getStorageService().headObject(f.companyId, uploaded.objectKey)).exists).toBe(true);
  });
  it.each(["tamper", "delete", "oversize", "foreign", "attempt", "expired", "archived"] as const)("fails closed for %s without changing durable evidence", async (fault) => {
    const item = await stored();
    let requestedScope = scope;
    let companyId = f.companyId;
    let maxBytes = 100;
    const codes = { tamper: "quality_evidence_hash_mismatch", delete: "quality_evidence_missing", oversize: "quality_evidence_too_large", foreign: "quality_scope_company_mismatch", attempt: "quality_evidence_scope_mismatch", expired: "quality_evidence_expired", archived: "quality_evidence_archived" };
    if (fault === "tamper") await writeFile(path.join(root, item.uploaded.objectKey), "Verified bytes");
    if (fault === "delete") await unlink(path.join(root, item.uploaded.objectKey));
    if (fault === "oversize") maxBytes = 2;
    if (fault === "foreign") companyId = f.otherCompanyId;
    if (fault === "attempt") requestedScope = { ...scope, verifierEpoch: 2 };
    if (fault === "expired") await owned.db.update(qualityEvidenceRefs).set({ freshnessExpiresAt: new Date(0) }).where(eq(qualityEvidenceRefs.id, item.evidenceRefId));
    if (fault === "archived") await owned.db.update(qualityEvidenceRefs).set({ status: "archived" }).where(eq(qualityEvidenceRefs.id, item.evidenceRefId));
    const before = await owned.db.select().from(qualityEvidenceRefs);
    await expect(readEvidence(owned.db, { companyId, ref: item.ref, scope: requestedScope, maxBytes })).rejects.toMatchObject({ message: codes[fault], details: { code: codes[fault] } });
    expect(await owned.db.select().from(qualityEvidenceRefs)).toEqual(before);
  });
  it("enforces streaming size limits even when stored length is smaller than the object", async () => {
    const item = await stored();
    await writeFile(path.join(root, item.uploaded.objectKey), Buffer.alloc(200));
    await expect(readEvidence(owned.db, { companyId: f.companyId, ref: item.ref, scope, maxBytes: 100 })).rejects.toMatchObject({ message: "quality_evidence_too_large" });
  });
  it.each(["attachment", "asset_company", "receipt_scope", "source_epoch"] as const)("checks stored %s relations, not just the submitted hash", async (fault) => {
    const item = await stored();
    const [receipt] = await owned.db.select().from(qualityEvidenceRefs).where(eq(qualityEvidenceRefs.id, item.evidenceRefId));
    if (fault === "attachment") await owned.db.delete(issueAttachments).where(eq(issueAttachments.id, item.ref.attachmentId));
    if (fault === "asset_company") {
      const [attachment] = await owned.db.select().from(issueAttachments).where(eq(issueAttachments.id, item.ref.attachmentId));
      await owned.db.update(assets).set({ companyId: f.otherCompanyId }).where(eq(assets.id, attachment.assetId));
    }
    if (fault === "receipt_scope") await owned.db.update(qualityEvidenceRefs).set({ qualityContract: { ...receipt.qualityContract!, scope: { ...scope, verifierEpoch: 7 } } }).where(eq(qualityEvidenceRefs.id, item.evidenceRefId));
    if (fault === "source_epoch") await owned.db.update(heartbeatRuns).set({ executionEpoch: 8 }).where(eq(heartbeatRuns.id, source.heartbeatRunId));
    const before = await owned.db.select().from(qualityOccurrences);
    try {
      await expect(readEvidence(owned.db, { companyId: f.companyId, ref: item.ref, scope, maxBytes: 100 })).rejects.toMatchObject({ status: 422 });
      await expect(writeOccurrence(owned.db, { companyId: f.companyId, reviewItemId, producerRunId: source.heartbeatRunId, submissionKey: randomUUID(), source, evidence: [item.ref] })).rejects.toMatchObject({ status: 422 });
      expect(await owned.db.select().from(qualityOccurrences)).toEqual(before);
    } finally {
      if (fault === "source_epoch") await owned.db.update(heartbeatRuns).set({ executionEpoch: 1 }).where(eq(heartbeatRuns.id, source.heartbeatRunId));
    }
  });
  it("does not accept arbitrary URL/path fields or unattached artifact identities", async () => {
    const item = await stored();
    await expect(readEvidence(owned.db, { companyId: f.companyId, ref: { ...item.ref, url: "file:///etc/passwd" } as typeof item.ref, scope, maxBytes: 100 })).rejects.toMatchObject({ message: "quality_evidence_invalid_contract" });
    await expect(readEvidence(owned.db, { companyId: f.companyId, ref: { attachmentId: randomUUID(), sha256: item.ref.sha256 }, scope, maxBytes: 100 })).rejects.toMatchObject({ message: "quality_evidence_missing" });
  });
});
