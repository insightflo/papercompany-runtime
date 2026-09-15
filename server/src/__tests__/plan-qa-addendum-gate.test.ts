// [TEST] T8 PLAN-QA addendum gate: strict v2 판정 검증, readRef 생산, verified gate 조회.
//   기본 판정(base)과 추가 검사(addendum) 결합, 누락/오류/근거 없는 excluded, 이전 시도 readRef
//   재사용, marker 없는 v2 제출 거부를 검증한다. 승인/완료 소비는 approval/completion 테스트가 담당.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  issues, missionPlanArtifacts, missionPlanQaVerdicts, type Db,
} from "@paperclipai/db";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { recordMissionPlanQaVerdict } from "../services/missions/mission-plan-qa-verdicts.js";
import {
  buildPlanQaScope, combinePlanQa, readPlanQaCheck, readVerifiedPlanQaGate, verifyPlanQaSubmission,
} from "../services/missions/plan-qa-addendum-gate.js";

import { seedGateWorld, checkoutReviewer, readAndVerify, GATE_CHECK_ID, GATE_DECISION_HASH } from "./helpers/plan-qa-addendum.js";

describeQualityDb("PLAN-QA addendum gate", () => {
  let owned: QualityTestDb;
  let db: Db;
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "quality-t8-gate-"));
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", root);
    owned = await createQualityTestDb();
    db = owned.db;
  }, 120_000);
  afterAll(async () => { await owned?.close(); vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); });

  it("keeps technical gaps separate from verified defects", () => {
    expect(combinePlanQa(true, ["defect"])).toBe("request_changes");
    expect(combinePlanQa(true, ["defect", "insufficient_evidence"])).toBe("missing_evidence");
    expect(combinePlanQa(false, ["satisfied"])).toBe("request_changes");
    expect(combinePlanQa(true, ["satisfied"])).toBe("pass");
  });

  it("stores actual selected values and manifest version in the read receipt", async () => {
    const w = await seedGateWorld(db);
    const scope = await buildPlanQaScope(db, { companyId: w.companyId, issueId: w.planQaIssueId, heartbeatRunId: w.runId, executionEpoch: 1 });
    expect(scope.reviewGeneration).toBe(1);
    expect(scope.decisionHash).toBe(GATE_DECISION_HASH);
    const read = await readPlanQaCheck(db, w.actor, { issueId: w.planQaIssueId, checkId: GATE_CHECK_ID, pointers: ["/missionId", "/checks/0/checkId"] });
    expect(read.values).toEqual([w.missionId, GATE_CHECK_ID]);
    await expect(readPlanQaCheck(db, w.actor, { issueId: w.planQaIssueId, checkId: "unknown-check", pointers: ["/missionId"] }))
      .rejects.toMatchObject({ status: 422 });
    await expect(readPlanQaCheck(db, w.actor, { issueId: w.planQaIssueId, checkId: GATE_CHECK_ID, pointers: ["/../etc"] }))
      .rejects.toMatchObject({ status: 422 });
  });

  it("verifies a strict v2 pass submission and exposes the verified gate", async () => {
    const w = await seedGateWorld(db);
    const result = await readAndVerify(w, "pass", { [GATE_CHECK_ID]: "satisfied" });
    expect(result).toMatchObject({ status: "pass", evidenceRefId: expect.any(String) });
    const [row] = await db.select().from(missionPlanQaVerdicts).where(eq(missionPlanQaVerdicts.planQaIssueId, w.planQaIssueId));
    expect(row?.verdict).toBe("pass");
    const scope = await buildPlanQaScope(db, { companyId: w.companyId, issueId: w.planQaIssueId, heartbeatRunId: w.runId, executionEpoch: 1 });
    await expect(readVerifiedPlanQaGate(db, scope)).resolves.toMatchObject({ verdict: "pass", evidenceRefId: (result as { evidenceRefId: string }).evidenceRefId });
  });

  it("keeps base failures and addendum defects blocking (base pass + defect, base fail + satisfied)", async () => {
    const defectWorld = await seedGateWorld(db);
    const defect = await readAndVerify(defectWorld, "pass", { [GATE_CHECK_ID]: "defect" });
    expect(defect).toMatchObject({ status: "request_changes" });
    const [defectRow] = await db.select().from(missionPlanQaVerdicts).where(eq(missionPlanQaVerdicts.planQaIssueId, defectWorld.planQaIssueId));
    const diagnostics = defectRow?.diagnostics as Array<Record<string, unknown>>;
    expect(diagnostics.some((entry) => entry.checkId === GATE_CHECK_ID && Array.isArray(entry.requirementRefs) && entry.templateId === defectWorld.templateId)).toBe(true);

    const baseFailWorld = await seedGateWorld(db);
    await expect(readAndVerify(baseFailWorld, "request_changes", { [GATE_CHECK_ID]: "satisfied" })).resolves.toMatchObject({ status: "request_changes" });
  });

  it("returns structured missing evidence for uncovered, excluded, insufficient, and unreadable reads", async () => {
    const w = await seedGateWorld(db);
    const scope = await buildPlanQaScope(db, { companyId: w.companyId, issueId: w.planQaIssueId, heartbeatRunId: w.runId, executionEpoch: 1 });
    await recordMissionPlanQaVerdict({ db, companyId: w.companyId, missionId: w.missionId, planQaIssueId: w.planQaIssueId, decisionHash: GATE_DECISION_HASH, verdict: "pass", reviewedBy: { actorType: "agent", actorId: w.reviewerAgentId } });
    const missing = await verifyPlanQaSubmission(db, w.actor, { scope, schemaVersion: 2, checks: [] });
    expect(missing).toMatchObject({ status: "missing_evidence", remainingResubmissions: 2 });
    expect((missing as { reasons: Array<{ code: string }> }).reasons.some((reason) => reason.code === "quality_check_uncovered")).toBe(true);

    const excluded = await readAndVerify(w, "pass", { [GATE_CHECK_ID]: "excluded" });
    expect((excluded as { reasons: Array<{ code: string }> }).reasons.some((reason) => reason.code === "quality_plan_qa_excluded_unverified")).toBe(true);

    const insufficient = await readAndVerify(w, "pass", { [GATE_CHECK_ID]: "insufficient_evidence" });
    expect(insufficient).toMatchObject({ status: "missing_evidence" });
    const [row] = await db.select().from(missionPlanQaVerdicts).where(eq(missionPlanQaVerdicts.planQaIssueId, w.planQaIssueId));
    expect(row?.verdict).not.toBe("pass");
  });

  it("rejects a readRef produced by a previous review attempt", async () => {
    const w = await seedGateWorld(db);
    const firstRead = await readPlanQaCheck(db, w.actor, { issueId: w.planQaIssueId, checkId: GATE_CHECK_ID, pointers: ["/missionId"] });
    await recordMissionPlanQaVerdict({ db, companyId: w.companyId, missionId: w.missionId, planQaIssueId: w.planQaIssueId, decisionHash: GATE_DECISION_HASH, verdict: "pass", reviewedBy: { actorType: "agent", actorId: w.reviewerAgentId }, sourceRunId: w.runId });
    const secondRun = await checkoutReviewer(db, { companyId: w.companyId, issueId: w.planQaIssueId, reviewerAgentId: w.reviewerAgentId, executionEpoch: 2 });
    const secondScope = await buildPlanQaScope(db, { companyId: w.companyId, issueId: w.planQaIssueId, heartbeatRunId: secondRun, executionEpoch: 2 });
    const rejected = await verifyPlanQaSubmission(db, { ...w.actor, heartbeatRunId: secondRun, executionEpoch: 2 }, {
      scope: secondScope, schemaVersion: 2,
      checks: [{ checkId: GATE_CHECK_ID, status: "satisfied", readRef: firstRead.readRef, evidence: [] }],
    });
    expect(rejected).toMatchObject({ status: "missing_evidence" });
    expect((rejected as { reasons: Array<{ code: string }> }).reasons.some((reason) => reason.code.startsWith("quality_read_receipt"))).toBe(true);
  });

  it("does not accept a stale-generation gate for the current scope", async () => {
    const w = await seedGateWorld(db);
    await readAndVerify(w, "pass", { [GATE_CHECK_ID]: "satisfied" });
    const scope = await buildPlanQaScope(db, { companyId: w.companyId, issueId: w.planQaIssueId, heartbeatRunId: w.runId, executionEpoch: 1 });
    await expect(readVerifiedPlanQaGate(db, { ...scope, reviewGeneration: 2 })).resolves.toBeNull();
  });

  it("cannot build a submission scope for an issue without a pinned binding marker", async () => {
    const w = await seedGateWorld(db, { policy: false });
    const legacyIssueId = randomUUID();
    await db.insert(issues).values({ id: legacyIssueId, companyId: w.companyId, missionId: w.missionId, title: "[PLAN-QA] legacy", originKind: "mission_plan_qa", originId: `plan-qa:${w.missionId}:${GATE_DECISION_HASH}`, status: "in_progress", assigneeAgentId: w.reviewerAgentId });
    const runId = await checkoutReviewer(db, { companyId: w.companyId, issueId: legacyIssueId, reviewerAgentId: w.reviewerAgentId, executionEpoch: 1 });
    await db.update(missionPlanArtifacts).set({ refs: { schemaVersion: 3, ownerPlanDecision: { decisionHash: GATE_DECISION_HASH }, planQa: { issueId: legacyIssueId, status: "pending", decisionHash: GATE_DECISION_HASH } } }).where(eq(missionPlanArtifacts.id, w.planArtifactId));
    await expect(buildPlanQaScope(db, {
      companyId: w.companyId, issueId: legacyIssueId, heartbeatRunId: runId, executionEpoch: 1,
    })).rejects.toMatchObject({ status: 422 });
  });
});
