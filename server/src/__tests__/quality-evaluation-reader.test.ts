// server/src/__tests__/quality-evaluation-reader.test.ts
//
// [purpose] T6 open/read: 고정 manifest 재독해·입력 영수증, bounded JSON Pointer,
// 검증자 binding(run/checkout/세대/epoch 매번 확인), 작성자·변조·잘못된 시도 차단.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { issues } from "@paperclipai/db";import type { QualityAgentActor } from "@paperclipai/shared";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { checkInVerifier, seedEvaluationFixture, type EvaluationFixture } from "./helpers/quality-evaluation-fixture.js";
import { openQualityCase, readQualityCheck } from "../services/quality/evaluation-reader.js";
import { submitQualityCandidate } from "../services/quality/evaluation-candidates.js";

describeQualityDb("Quality evaluation case open/read", () => {
  let owned: QualityTestDb;
  let f: EvaluationFixture;
  let root: string;
  let verifier: QualityAgentActor;
  let verifierRunId: string;
  let evaluationId: string;
  let verifierIssueId: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "quality-t6-reader-"));
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", root);
    owned = await createQualityTestDb();
    f = await seedEvaluationFixture(owned.db);
    const candidate = await submitQualityCandidate(owned.db, author(), {
      issueId: f.authorIssueId, schemaVersion: 1,
      checks: [{ checkId: "add-check-1", requirementRefs: [f.requirementRefs[0]!], applicability: { op: "always" }, expectedEvidenceKinds: ["plan_document"], instructions: "실패 사례를 잡는 추가 검사" }],
    });
    evaluationId = candidate.evaluationId;
    verifierIssueId = candidate.verifierIssueId;
    verifierRunId = await checkInVerifier(owned.db, f, verifierIssueId, candidate.verifierStepRunId, 0);
    verifier = verifierActor();
  }, 240_000);
  afterAll(async () => { await owned?.close(); vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); });

  function author(): QualityAgentActor {
    return { agentId: f.authorAgentId, companyId: f.companyId, heartbeatRunId: f.authorRunId, executionEpoch: f.authorEpoch };
  }
  function verifierActor(): QualityAgentActor {
    return { agentId: f.verifierAgentId, companyId: f.companyId, heartbeatRunId: verifierRunId, executionEpoch: 1 };
  }

  it("opens a case by re-reading the fixed manifest and stores a scoped input receipt", async () => {
    const opened = await openQualityCase(owned.db, verifier, { issueId: verifierIssueId, evaluationId, caseId: f.caseIds.failure, variant: "baseline" });
    expect(opened.invocationId).toBeTruthy();
    expect(opened.inputRef.sha256).toMatch(/^[0-9a-f]{64}$/);
    const again = await openQualityCase(owned.db, verifier, { issueId: verifierIssueId, evaluationId, caseId: f.caseIds.failure, variant: "baseline" });
    expect(again.invocationId).toBe(opened.invocationId);
    expect(again.inputRef).toEqual(opened.inputRef);
  });

  it("rejects unknown case, invalid variant, wrong issue and foreign company", async () => {
    await expect(openQualityCase(owned.db, verifier, { issueId: verifierIssueId, evaluationId, caseId: "no-such-case", variant: "baseline" })).rejects.toMatchObject({ status: 404 });
    await expect(openQualityCase(owned.db, verifier, { issueId: verifierIssueId, evaluationId, caseId: f.caseIds.failure, variant: "challenger" as "baseline" })).rejects.toMatchObject({ status: 422 });
    await expect(openQualityCase(owned.db, verifier, { issueId: f.authorIssueId, evaluationId, caseId: f.caseIds.failure, variant: "baseline" })).rejects.toMatchObject({ status: 404 });
    await expect(openQualityCase(owned.db, { ...verifier, companyId: f.otherCompanyId }, { issueId: verifierIssueId, evaluationId, caseId: f.caseIds.failure, variant: "baseline" })).rejects.toMatchObject({ status: 404 });
  });

  it("refuses candidate authors and non-policy agents as verifiers", async () => {
    await expect(openQualityCase(owned.db, author(), { issueId: verifierIssueId, evaluationId, caseId: f.caseIds.failure, variant: "baseline" })).rejects.toMatchObject({ status: 403, message: "quality_verifier_role_required" });
    const third = { agentId: f.thirdAgentId, companyId: f.companyId, heartbeatRunId: verifierRunId, executionEpoch: 1 };
    await expect(openQualityCase(owned.db, third, { issueId: verifierIssueId, evaluationId, caseId: f.caseIds.failure, variant: "baseline" })).rejects.toMatchObject({ status: 403, message: "quality_verifier_role_required" });
  });

  it("re-checks the live run/checkout binding on every call (wrong attempt rejected)", async () => {
    const wrongRun = { ...verifier, heartbeatRunId: f.authorRunId };
    await expect(openQualityCase(owned.db, wrongRun, { issueId: verifierIssueId, evaluationId, caseId: f.caseIds.failure, variant: "candidate" })).rejects.toMatchObject({ status: 422, message: "quality_attempt_binding_mismatch" });
    const wrongEpoch = { ...verifier, executionEpoch: 2 };
    await expect(openQualityCase(owned.db, wrongEpoch, { issueId: verifierIssueId, evaluationId, caseId: f.caseIds.failure, variant: "candidate" })).rejects.toMatchObject({ status: 422, message: "quality_attempt_binding_mismatch" });
    // 체크아웃이 풀린 이슈(다른 run 이 checkout) 도 매번 확인에서 거부된다.
    await owned.db.update(issues).set({ checkoutRunId: f.authorRunId }).where(eq(issues.id, verifierIssueId));
    await expect(openQualityCase(owned.db, verifier, { issueId: verifierIssueId, evaluationId, caseId: f.caseIds.normal[0]!, variant: "candidate" })).rejects.toMatchObject({ status: 409, message: "quality_verifier_checkout_required" });
    await owned.db.update(issues).set({ checkoutRunId: verifierRunId }).where(eq(issues.id, verifierIssueId));
  });

  it("reads only bounded JSON pointers of that input and records values with a read receipt", async () => {
    const opened = await openQualityCase(owned.db, verifier, { issueId: verifierIssueId, evaluationId, caseId: f.caseIds.failure, variant: "baseline" });
    const read = await readQualityCheck(owned.db, verifier, {
      invocationId: opened.invocationId, checkId: f.baseCheckId,
      pointers: ["/plan/goal", "/plan/steps/0/title", "/checks/0/checkId"],
    });
    expect(read.values).toEqual(["실패 재현 계획", "작성", f.baseCheckId]);
    expect(read.readRef.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects url/path/expression-like and unbounded pointers", async () => {
    const opened = await openQualityCase(owned.db, verifier, { issueId: verifierIssueId, evaluationId, caseId: f.caseIds.normal[0]!, variant: "baseline" });
    for (const pointers of [
      ["http://example.com/plan"],
      ["file:///etc/passwd"],
      ["plan.goal"],
      ["/plan/steps/-"],
      [`/plan/${"deep/".repeat(12)}goal`],
      ["/" + "a".repeat(250)],
      Array.from({ length: 17 }, () => "/plan/goal"),
    ]) {
      await expect(readQualityCheck(owned.db, verifier, { invocationId: opened.invocationId, checkId: f.baseCheckId, pointers })).rejects.toMatchObject({ status: 422, message: "quality_pointer_invalid" });
    }
  });

  it("rejects missing pointer targets and unknown invocations", async () => {
    const opened = await openQualityCase(owned.db, verifier, { issueId: verifierIssueId, evaluationId, caseId: f.caseIds.normal[1]!, variant: "baseline" });
    await expect(readQualityCheck(owned.db, verifier, { invocationId: opened.invocationId, checkId: f.baseCheckId, pointers: ["/plan/missing-key"] })).rejects.toMatchObject({ status: 422, message: "quality_pointer_missing" });
    await expect(readQualityCheck(owned.db, verifier, { invocationId: crypto.randomUUID(), checkId: f.baseCheckId, pointers: ["/plan/goal"] })).rejects.toMatchObject({ status: 404 });
  });

  it("fails closed when stored input bytes are tampered after opening", async () => {
    const opened = await openQualityCase(owned.db, verifier, { issueId: verifierIssueId, evaluationId, caseId: f.caseIds.failure, variant: "candidate" });
    const { assets, issueAttachments } = await import("@paperclipai/db");
    const [attachment] = await owned.db.select({ objectKey: assets.objectKey }).from(issueAttachments).innerJoin(assets, eq(assets.id, issueAttachments.assetId)).where(eq(issueAttachments.id, opened.inputRef.attachmentId));
    await writeFile(path.join(root, attachment!.objectKey), Buffer.from("{\"tampered\":true}"));
    await expect(readQualityCheck(owned.db, verifier, { invocationId: opened.invocationId, checkId: f.baseCheckId, pointers: ["/plan/goal"] })).rejects.toMatchObject({ message: "quality_evidence_hash_mismatch" });
  });
});
