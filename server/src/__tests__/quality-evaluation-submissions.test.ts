// server/src/__tests__/quality-evaluation-submissions.test.ts
//
// [purpose] T6 사례 제출·후보 생산: coverage/read receipt 재독해, MissingEvidence 의
// 정확한 artifact/check/scope·제출 URL·schema·남은 횟수, 후보 누락·중복/다른 본문·타사·
// 작성자 변경·requirement 출처·허용 변경(추가 전용) 검증.

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import {
  activityLog, agentWakeupRequests, evaluatorCandidateRuns, issues, qualityEvidenceRefs, workflowRuns,
} from "@paperclipai/db";
import type { ArtifactRef, CheckResult, QualityAgentActor } from "@paperclipai/shared";
import { qualityWakeKey } from "../services/quality/native-wake.js";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { checkInVerifier, seedEvaluationFixture, type EvaluationFixture } from "./helpers/quality-evaluation-fixture.js";
import { openQualityCase, readQualityCheck } from "../services/quality/evaluation-reader.js";
import { submitQualityCandidate } from "../services/quality/evaluation-candidates.js";
import { submitQualityCase, verifyQualityEvaluation } from "../services/quality/evaluation-submissions.js";

describeQualityDb("Quality evaluation submissions and candidates", () => {
  let owned: QualityTestDb;
  let f: EvaluationFixture;
  let root: string;
  let author: QualityAgentActor;
  let verifier: QualityAgentActor;
  let evaluationId: string;
  let verifierIssueId: string;
  let verifierStepRunId: string;
  let verifierRunId: string;
  let addCheckIds: string[];

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "quality-t6-submit-"));
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", root);
    owned = await createQualityTestDb();
    f = await seedEvaluationFixture(owned.db);
    author = { agentId: f.authorAgentId, companyId: f.companyId, heartbeatRunId: f.authorRunId, executionEpoch: f.authorEpoch };
    addCheckIds = ["add-1", "add-2"];
  }, 240_000);
  afterAll(async () => { await owned?.close(); vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); });

  function candidateChecks(source: EvaluationFixture = f) {
    return addCheckIds.map((checkId) => ({
      checkId, requirementRefs: [source.requirementRefs[0]!], applicability: { op: "always" as const },
      expectedEvidenceKinds: ["plan_document"], instructions: `추가 검사 ${checkId}`,
    }));
  }
  async function submitCandidate(actor: QualityAgentActor = author) {
    return submitQualityCandidate(owned.db, actor, { issueId: f.authorIssueId, schemaVersion: 1, checks: candidateChecks() });
  }
  async function openAndRead(caseId: string, variant: "baseline" | "candidate", checkIds: string[]) {
    const opened = await openQualityCase(owned.db, verifier, { issueId: verifierIssueId, evaluationId, caseId, variant });
    const readRefs: Record<string, ArtifactRef> = {};
    for (const checkId of checkIds) {
      const read = await readQualityCheck(owned.db, verifier, { invocationId: opened.invocationId, checkId, pointers: ["/plan/goal"] });
      readRefs[checkId] = read.readRef;
    }
    return { invocationId: opened.invocationId, readRefs };
  }
  function results(readRefs: Record<string, ArtifactRef>, statuses: Record<string, CheckResult["status"]>): CheckResult[] {
    return Object.entries(statuses).map(([checkId, status]) => ({ checkId, status, readRef: readRefs[checkId]!, evidence: [] }));
  }

  it("rejects third-party authors, unproven requirement provenance and non-additive checks", async () => {
    const third = { agentId: f.thirdAgentId, companyId: f.companyId, heartbeatRunId: f.authorRunId, executionEpoch: f.authorEpoch };
    await expect(submitCandidate(third)).rejects.toMatchObject({ status: 403, message: "quality_author_role_required" });
    await expect(submitQualityCandidate(owned.db, author, {
      issueId: f.authorIssueId, schemaVersion: 1,
      checks: [{ checkId: "add-x", requirementRefs: [{ attachmentId: crypto.randomUUID(), sha256: "cd".repeat(32) }], applicability: { op: "always" }, expectedEvidenceKinds: ["plan_document"], instructions: "출처 없는 검사" }],
    })).rejects.toMatchObject({ status: 422, message: "quality_requirement_source_unapproved" });
    await expect(submitQualityCandidate(owned.db, author, {
      issueId: f.authorIssueId, schemaVersion: 1,
      checks: [{ checkId: f.baseCheckId, requirementRefs: [f.requirementRefs[0]!], applicability: { op: "always" }, expectedEvidenceKinds: ["plan_document"], instructions: "기본 검사 대체" }],
    })).rejects.toMatchObject({ status: 409, message: "quality_candidate_check_conflict" });
  });

  it("stores an immutable candidate body and fixes the evaluation", async () => {
    const candidate = await submitCandidate();
    expect(candidate.candidateVersionId).toBeTruthy();
    expect(candidate.bodyRef.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(candidate.evaluationId).toBeTruthy();
    evaluationId = candidate.evaluationId;
    verifierIssueId = candidate.verifierIssueId;
    verifierStepRunId = candidate.verifierStepRunId;
    const replay = await submitCandidate();
    expect(replay.candidateVersionId).toBe(candidate.candidateVersionId);
    expect(replay.evaluationId).toBe(candidate.evaluationId);
    await expect(submitQualityCandidate(owned.db, author, {
      issueId: f.authorIssueId, schemaVersion: 1,
      checks: [{ checkId: "add-1", requirementRefs: [f.requirementRefs[0]!], applicability: { op: "always" }, expectedEvidenceKinds: ["plan_document"], instructions: "다른 본문" }],
    })).rejects.toMatchObject({ status: 409, message: "quality_candidate_body_immutable" });
  });

  async function verifierStep() {
    const [evaluation] = await owned.db.select().from(evaluatorCandidateRuns).where(eq(evaluatorCandidateRuns.id, evaluationId));
    return (evaluation!.qualityContract as { verifier: { step: { issueId: string; stepRunId: string; workflowRunId: string; generation: number; dispatchAuthorityVersion: number } } }).verifier.step;
  }

  it("re-drives the verifier wake on idempotent replay when the delivery row is gone (same intent key)", async () => {
    const step = await verifierStep();
    const wakeKey = qualityWakeKey({ actionId: f.actionId, stepRunId: step.stepRunId, generation: step.generation, attempt: 1 });
    await owned.db.delete(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.idempotencyKey, wakeKey)));
    const replay = await submitCandidate();
    expect(replay.evaluationId).toBe(evaluationId);
    const delivered = await owned.db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.idempotencyKey, wakeKey)));
    expect(delivered.length).toBe(1);
    const failed = await owned.db.select({ id: activityLog.id }).from(activityLog)
      .where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.action, "quality.verifier_wake_failed")));
    expect(failed.length).toBe(0);
  });

  it("records a structured verifier_wake_failed activity row when the verifier step stays undeliverable", async () => {
    const step = await verifierStep();
    const wakeKey = qualityWakeKey({ actionId: f.actionId, stepRunId: step.stepRunId, generation: step.generation, attempt: 1 });
    await owned.db.delete(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.idempotencyKey, wakeKey)));
    await owned.db.update(issues).set({ status: "done" }).where(eq(issues.id, verifierIssueId));
    const replay = await submitCandidate();
    expect(replay.evaluationId).toBe(evaluationId);
    const failed = await owned.db.select().from(activityLog)
      .where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.action, "quality.verifier_wake_failed")))
      .orderBy(desc(activityLog.createdAt));
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(failed[0]).toMatchObject({ entityType: "evaluator_candidate_run", entityId: evaluationId });
    expect(failed[0]!.details).toMatchObject({ actionId: f.actionId, evaluationId, verifierIssueId, verifierStepRunId, generation: step.generation, idempotencyKey: wakeKey });
    await owned.db.update(issues).set({ status: "todo" }).where(eq(issues.id, verifierIssueId));
  });

  it("rejects author self-submission of case results (B excluded from candidate authors)", async () => {
    verifierRunId = await checkInVerifier(owned.db, f, verifierIssueId, verifierStepRunId, 0);
    verifier = { agentId: f.verifierAgentId, companyId: f.companyId, heartbeatRunId: verifierRunId, executionEpoch: 1 };
    const opened = await openAndRead(f.caseIds.failure, "baseline", [f.baseCheckId]);
    await expect(submitQualityCase(owned.db, author, { invocationId: opened.invocationId, schemaVersion: 1, results: results(opened.readRefs, { [f.baseCheckId]: "satisfied" }) })).rejects.toMatchObject({ status: 403, message: "quality_verifier_role_required" });
  });

  it("returns exact MissingEvidence for missing read receipts and uncovered checks", async () => {
    const opened = await openAndRead(f.caseIds.failure, "baseline", [f.baseCheckId]);
    const bogusRead = { attachmentId: crypto.randomUUID(), sha256: "ef".repeat(32) };
    const missing = await submitQualityCase(owned.db, verifier, { invocationId: opened.invocationId, schemaVersion: 1, results: [{ checkId: f.baseCheckId, status: "satisfied", readRef: bogusRead, evidence: [] }] });
    expect(missing).toMatchObject({ status: "missing_evidence", remainingResubmissions: 1 });
    const value = missing as Extract<typeof missing, { status: "missing_evidence" }>;
    expect(value.reasons[0]).toMatchObject({ checkId: f.baseCheckId, requiredKind: "read" });
    expect(value.submission).toEqual({ method: "POST", path: `/api/issues/${verifierIssueId}/quality/evaluations/${evaluationId}/v1/invocations/${opened.invocationId}/results`, schemaVersion: 1 });
    expect(value.scope).toMatchObject({ kind: "evaluation", evaluationId });
    const partial = await submitQualityCase(owned.db, verifier, { invocationId: opened.invocationId, schemaVersion: 1, results: [] });
    expect((partial as { status: string }).status).toBe("missing_evidence");
  });

  it("rejects duplicate results and non-applicable check ids", async () => {
    const opened = await openAndRead(f.caseIds.normal[0]!, "baseline", [f.baseCheckId]);
    const duplicate = [results(opened.readRefs, { [f.baseCheckId]: "satisfied" })[0]!, results(opened.readRefs, { [f.baseCheckId]: "satisfied" })[0]!];
    await expect(submitQualityCase(owned.db, verifier, { invocationId: opened.invocationId, schemaVersion: 1, results: duplicate })).rejects.toMatchObject({ status: 422 });
    await expect(submitQualityCase(owned.db, verifier, { invocationId: opened.invocationId, schemaVersion: 1, results: [{ checkId: "not-in-suite", status: "satisfied", readRef: opened.readRefs[f.baseCheckId]!, evidence: [] }] })).rejects.toMatchObject({ status: 422, message: "quality_check_not_applicable" });
  });

  it("submits both variants per case and verifies PASS from server-joined evidence only", async () => {
    const f1 = await openAndRead(f.caseIds.failure, "baseline", [f.baseCheckId]);
    const first = await submitQualityCase(owned.db, verifier, { invocationId: f1.invocationId, schemaVersion: 1, results: results(f1.readRefs, { [f.baseCheckId]: "satisfied" }) });
    expect((first as { submissionRef: ArtifactRef }).submissionRef.sha256).toMatch(/^[0-9a-f]{64}$/);
    const f1c = await openAndRead(f.caseIds.failure, "candidate", [f.baseCheckId, "add-1", "add-2"]);
    await submitQualityCase(owned.db, verifier, { invocationId: f1c.invocationId, schemaVersion: 1, results: results(f1c.readRefs, { [f.baseCheckId]: "satisfied", "add-1": "defect", "add-2": "satisfied" }) });
    for (const caseId of f.caseIds.normal) {
      const n = await openAndRead(caseId, "baseline", [f.baseCheckId]);
      await submitQualityCase(owned.db, verifier, { invocationId: n.invocationId, schemaVersion: 1, results: results(n.readRefs, { [f.baseCheckId]: "satisfied" }) });
      const nc = await openAndRead(caseId, "candidate", [f.baseCheckId, "add-1", "add-2"]);
      await submitQualityCase(owned.db, verifier, { invocationId: nc.invocationId, schemaVersion: 1, results: results(nc.readRefs, { [f.baseCheckId]: "satisfied", "add-1": "satisfied", "add-2": "satisfied" }) });
    }
    const verdict = await verifyQualityEvaluation(owned.db, verifier, { companyId: f.companyId, actionId: f.actionId });
    expect(verdict).toMatchObject({ status: "pass" });
    const evidenceRefId = (verdict as { evidenceRefId: string }).evidenceRefId;
    expect(evidenceRefId).toBeTruthy();
    // [리뷰 중요3] 판정 영수증의 dispatchAuthorityVersion 은 생성된 run 의 실제 값이다(숨은 기본값 아님).
    const [receipt] = await owned.db.select().from(qualityEvidenceRefs)
      .where(and(eq(qualityEvidenceRefs.companyId, f.companyId), eq(qualityEvidenceRefs.id, evidenceRefId)));
    const receiptSource = (receipt!.qualityContract as { source: { workflow: { runId: string; dispatchAuthorityVersion: number } } }).source;
    const [runRow] = await owned.db.select({ dispatchAuthorityVersion: workflowRuns.dispatchAuthorityVersion })
      .from(workflowRuns).where(eq(workflowRuns.id, receiptSource.workflow.runId));
    expect(receiptSource.workflow.dispatchAuthorityVersion).toBe(runRow!.dispatchAuthorityVersion);
    expect((await verifierStep()).dispatchAuthorityVersion).toBe(runRow!.dispatchAuthorityVersion);
    const replay = await verifyQualityEvaluation(owned.db, verifier, { companyId: f.companyId, actionId: f.actionId });
    expect(replay).toEqual(verdict);
  });

  it("returns missing evidence before every case of the fixed manifest is joined", async () => {
    const second = await seedEvaluationFixture(owned.db);
    const author2 = { agentId: second.authorAgentId, companyId: second.companyId, heartbeatRunId: second.authorRunId, executionEpoch: second.authorEpoch };
    // 아직 고정된 evaluation 이 없는 404 경로 — actor 는 스키마만 통과하면 된다(binding 검사 전 404).
    const notBound = { agentId: second.verifierAgentId, companyId: second.companyId, heartbeatRunId: crypto.randomUUID(), executionEpoch: 1 };
    await expect(verifyQualityEvaluation(owned.db, notBound, { companyId: second.companyId, actionId: second.actionId })).rejects.toMatchObject({ status: 404 });
    const candidate = await submitQualityCandidate(owned.db, author2, { issueId: second.authorIssueId, schemaVersion: 1, checks: candidateChecks(second) });
    const secondRunId = await checkInVerifier(owned.db, second, candidate.verifierIssueId, candidate.verifierStepRunId, 0);
    const verifier2 = { agentId: second.verifierAgentId, companyId: second.companyId, heartbeatRunId: secondRunId, executionEpoch: 1 };
    const missing = await verifyQualityEvaluation(owned.db, verifier2, { companyId: second.companyId, actionId: second.actionId });
    expect(missing).toMatchObject({ status: "missing_evidence" });
    const value = missing as Extract<typeof missing, { status: "missing_evidence" }>;
    expect(value.reasons.length).toBeGreaterThanOrEqual(second.caseIds.normal.length + 1);
    expect(value.submission.schemaVersion).toBe(1);
    void candidate;
  });

  it("crosschecks the verdict receipt's dispatch authority against the live run (drift rejected)", async () => {
    const drift = await seedEvaluationFixture(owned.db);
    const driftAuthor = { agentId: drift.authorAgentId, companyId: drift.companyId, heartbeatRunId: drift.authorRunId, executionEpoch: drift.authorEpoch };
    const candidate = await submitQualityCandidate(owned.db, driftAuthor, { issueId: drift.authorIssueId, schemaVersion: 1, checks: candidateChecks(drift) });
    const driftRunId = await checkInVerifier(owned.db, drift, candidate.verifierIssueId, candidate.verifierStepRunId, 0);
    const driftVerifier = { agentId: drift.verifierAgentId, companyId: drift.companyId, heartbeatRunId: driftRunId, executionEpoch: 1 };
    const satisfied = (checkIds: string[]) => Object.fromEntries(checkIds.map((checkId) => [checkId, "satisfied" as const]));
    const matrix: Array<[string, "baseline" | "candidate", string[]]> = [
      [drift.caseIds.failure, "baseline", [drift.baseCheckId]],
      [drift.caseIds.failure, "candidate", [drift.baseCheckId, "add-1", "add-2"]],
      [drift.caseIds.normal[0]!, "baseline", [drift.baseCheckId]],
      [drift.caseIds.normal[0]!, "candidate", [drift.baseCheckId, "add-1", "add-2"]],
      [drift.caseIds.normal[1]!, "baseline", [drift.baseCheckId]],
      [drift.caseIds.normal[1]!, "candidate", [drift.baseCheckId, "add-1", "add-2"]],
    ];
    for (const [caseId, variant, checkIds] of matrix) {
      const opened = await openQualityCase(owned.db, driftVerifier, { issueId: candidate.verifierIssueId, evaluationId: candidate.evaluationId, caseId, variant });
      const readRefs: Record<string, ArtifactRef> = {};
      for (const checkId of checkIds) {
        readRefs[checkId] = (await readQualityCheck(owned.db, driftVerifier, { invocationId: opened.invocationId, checkId, pointers: ["/plan/goal"] })).readRef;
      }
      await submitQualityCase(owned.db, driftVerifier, { invocationId: opened.invocationId, schemaVersion: 1, results: results(readRefs, satisfied(checkIds)) });
    }
    const [evaluation] = await owned.db.select().from(evaluatorCandidateRuns).where(eq(evaluatorCandidateRuns.id, candidate.evaluationId));
    const step = (evaluation!.qualityContract as { verifier: { step: { workflowRunId: string; dispatchAuthorityVersion: number } } }).verifier.step;
    const [run] = await owned.db.select({ dispatchAuthorityVersion: workflowRuns.dispatchAuthorityVersion })
      .from(workflowRuns).where(eq(workflowRuns.id, step.workflowRunId));
    expect(step.dispatchAuthorityVersion).toBe(run!.dispatchAuthorityVersion);
    // run 의 실제 권한 버전이 흔들리면(고정 리터럴이면 놓칠 사태) 판정 영수증 연결은 닫힌다.
    await owned.db.update(workflowRuns).set({ dispatchAuthorityVersion: step.dispatchAuthorityVersion + 1 }).where(eq(workflowRuns.id, step.workflowRunId));
    await expect(verifyQualityEvaluation(owned.db, driftVerifier, { companyId: drift.companyId, actionId: drift.actionId }))
      .rejects.toMatchObject({ status: 422, message: "quality_evidence_scope_mismatch" });
  });
});
