// [TEST] T8 PLAN-QA addendum 승인 연결: strict 세계에서 verified gate 없이는 계획 승인/실체화가
//   없고, gate pass 승인 DB 기록+PAQO 실체화가 있으며, 결함은 기존 수정 요청 경로로 돌아간다.
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog, issues, missionPlanArtifacts, missionPlanDecisionSubmissions, missionPlanTemplates,
  missionPlanQaVerdicts, qualityPolicyVersions, workflowDefinitions, workflowRuns, type Db,
} from "@paperclipai/db";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import {
  recordLatestAuthorizedMissionOwnerPlanDecision, hashOwnerPlanDecision,
} from "../services/mission-owner-plan-decisions.js";
import { upsertMissionPlanDecisionSubmission } from "../services/missions/mission-plan-decision-ledger.js";
import { missionPlanArtifactService } from "../services/mission-plan-artifacts.js";
import { setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";
import { recordMissionPlanQaVerdict } from "../services/missions/mission-plan-qa-verdicts.js";
import { checkoutReviewer, GATE_CHECK_ID, readAndVerify, seedGateWorld, type GateWorld } from "./helpers/plan-qa-addendum.js";
import { buildPlanQaScope, readPlanQaCheck, verifyPlanQaSubmission } from "../services/missions/plan-qa-addendum-gate.js";

const sha = (body: string) => createHash("sha256").update(body).digest("hex");
const TEMPLATE_BODY = "Gate template body";

type ApprovalWorld = GateWorld & { decisionHash: string };

/** 승인 흐름: owner 결정 제출 → recordLatest 1차(pending+strict 검토 이슈) → 검토 checkout. */
async function seedApprovalWorld(db: Db): Promise<ApprovalWorld> {
  const base = await seedGateWorld(db);
  const decision = {
    missionId: base.missionId,
    missionGoal: "Gate goal",
    selectedPlanTemplateIds: [base.templateId],
    selectedExecutionUnits: [{ id: "unit-1", kind: "workflow_definition_step", title: "Run scout", selectionState: "selected", reason: "r", sourceRef: { type: "workflow_definition_step", id: base.sourceWorkflowId, stepId: "scout" } }],
    ruleRefs: [], kbRefs: [], requiredInputs: [], successCriteria: ["scout done"], steps: [],
  };
  await upsertMissionPlanDecisionSubmission({
    db, companyId: base.companyId, missionId: base.missionId, planningIssueId: base.planningIssueId,
    decision, decisionHash: hashOwnerPlanDecision(decision as Parameters<typeof hashOwnerPlanDecision>[0]),
    authorAgentId: base.ownerAgentId, status: "submitted",
  });
  const first = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId: base.companyId, missionId: base.missionId });
  expect(first.status).toBe("plan_qa_pending");
  // seedGateWorld 이 만든 사전 검토 이슈는 다른 결정 hash 세계다: 승인 흐름이 만든 현재 이슈로 갈아탄다.
  const plan = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId: base.companyId, missionId: base.missionId });
  const planQa = (plan?.refs as Record<string, unknown>).planQa as { issueId: string; decisionHash: string };
  const reviewerRun = await checkoutReviewer(db, { companyId: base.companyId, issueId: planQa.issueId, reviewerAgentId: base.reviewerAgentId, executionEpoch: 1 });
  return { ...base, planQaIssueId: planQa.issueId, runId: reviewerRun, actor: { ...base.actor, heartbeatRunId: reviewerRun }, decisionHash: planQa.decisionHash };
}

async function strictGate(db: Db, w: ApprovalWorld, base: "pass" | "request_changes", status: "satisfied" | "defect") {
  const scope = await buildPlanQaScope(db, { companyId: w.companyId, issueId: w.planQaIssueId, heartbeatRunId: w.runId, executionEpoch: 1 });
  const read = await readPlanQaCheck(db, w.actor, { issueId: w.planQaIssueId, checkId: GATE_CHECK_ID, pointers: ["/missionId"] });
  await recordMissionPlanQaVerdict({ db, companyId: w.companyId, missionId: w.missionId, planQaIssueId: w.planQaIssueId, decisionHash: w.decisionHash, verdict: base, reviewedBy: { actorType: "agent", actorId: w.reviewerAgentId }, sourceRunId: w.runId });
  return verifyPlanQaSubmission(db, w.actor, { scope, schemaVersion: 2, checks: [{ checkId: GATE_CHECK_ID, status, readRef: read.readRef, evidence: [] }] });
}

async function activePlanRefs(db: Db, w: ApprovalWorld) {
  const plan = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId: w.companyId, missionId: w.missionId });
  return (plan?.refs ?? {}) as Record<string, unknown>;
}

describeQualityDb("PLAN-QA addendum approval wiring", () => {
  let owned: QualityTestDb;
  let db: Db;
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "quality-t8-approval-"));
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", root);
    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true }));
    owned = await createQualityTestDb();
    db = owned.db;
  }, 120_000);
  afterAll(async () => { setWorkflowToolStepExecutor(null); await owned?.close(); vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); });

  it("materializes the approved plan only after the strict verified gate passes", async () => {
    const w = await seedApprovalWorld(db);
    // gate 전에는 어떤 승인 기록도 실체화도 없다.
    let refs = await activePlanRefs(db, w);
    expect((refs.planQa as Record<string, unknown>)?.verdict).not.toBe("pass");
    expect((refs.paqoWorkflow as Record<string, unknown> | undefined)?.workflowRunId).toBeUndefined();

    const gate = await strictGate(db, w, "pass", "satisfied");
    expect(gate).toMatchObject({ status: "pass" });

    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId: w.companyId, missionId: w.missionId });
    expect(result.status).toBe("recorded");

    refs = await activePlanRefs(db, w);
    expect((refs.planQa as Record<string, unknown>)?.verdict).toBe("pass");
    expect((refs.paqoWorkflow as Record<string, unknown>)?.workflowRunId).toEqual(expect.any(String));
    const runs = await db.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.missionId, w.missionId));
    expect(runs.length).toBeGreaterThan(0);
    const [reviewIssue] = await db.select().from(issues).where(eq(issues.id, w.planQaIssueId));
    expect(reviewIssue?.status).toBe("done");
  });

  it("routes verified defects through the existing planning rework path without materializing", async () => {
    const w = await seedApprovalWorld(db);
    const gate = await strictGate(db, w, "pass", "defect");
    expect(gate).toMatchObject({ status: "request_changes" });

    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId: w.companyId, missionId: w.missionId });
    expect(result.status).toBe("plan_qa_changes_requested");

    const [planning] = await db.select().from(issues).where(eq(issues.id, w.planningIssueId));
    expect(planning?.status).toBe("todo");
    expect(planning?.description).toContain(GATE_CHECK_ID);
    const refs = await activePlanRefs(db, w);
    expect((refs.paqoWorkflow as Record<string, unknown> | undefined)?.workflowRunId).toBeUndefined();
    expect((refs.planQa as Record<string, unknown>)?.verdict).toBe("request_changes");
    const [reviewIssue] = await db.select().from(issues).where(eq(issues.id, w.planQaIssueId));
    expect(reviewIssue?.status).toBe("done");
  });

  it("blocks approval when only a plain v1 verdict exists on a strict pinned review", async () => {
    const w = await seedApprovalWorld(db);
    await recordMissionPlanQaVerdict({ db, companyId: w.companyId, missionId: w.missionId, planQaIssueId: w.planQaIssueId, decisionHash: w.decisionHash, verdict: "pass", reviewedBy: { actorType: "user", actorId: "board-user" } });

    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId: w.companyId, missionId: w.missionId });
    expect(result.status).toBe("plan_qa_pending");
    const refs = await activePlanRefs(db, w);
    expect((refs.planQa as Record<string, unknown>)?.verdict).not.toBe("pass");
    expect((refs.paqoWorkflow as Record<string, unknown> | undefined)?.workflowRunId).toBeUndefined();
  });

  it.each([false, true])("ignores forged PASS refs even with a workflow ref (%s)", async (withWorkflow) => {
    const w = await seedApprovalWorld(db);
    const plan = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId: w.companyId, missionId: w.missionId });
    const refs = { ...(plan!.refs as Record<string, unknown>) };
    (refs.planQa as Record<string, unknown>).verdict = "pass";
    (refs.planQa as Record<string, unknown>).status = "pass";
    if (withWorkflow) refs.paqoWorkflow = { workflowRunId: randomUUID() };
    await db.update(missionPlanArtifacts).set({ refs }).where(eq(missionPlanArtifacts.id, plan!.id));

    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId: w.companyId, missionId: w.missionId });
    expect(result.status).toBe("plan_qa_pending");
    const after = await activePlanRefs(db, w);
    expect(after.paqoWorkflow).toEqual(refs.paqoWorkflow);
    expect(await db.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.missionId, w.missionId))).toEqual([]);
  });

  it("requires current approval again when reentering an already materialized plan", async () => {
    const w = await seedApprovalWorld(db);
    await strictGate(db, w, "pass", "satisfied");
    expect((await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId: w.companyId, missionId: w.missionId })).status).toBe("recorded");
    expect((await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId: w.companyId, missionId: w.missionId })).status).toBe("noop");
    const before = await db.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.missionId, w.missionId));
    await checkoutReviewer(db, { companyId: w.companyId, issueId: w.planQaIssueId, reviewerAgentId: w.reviewerAgentId, executionEpoch: 2 });
    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId: w.companyId, missionId: w.missionId });
    expect(result.status).toBe("plan_qa_pending");
    expect(await db.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.missionId, w.missionId))).toEqual(before);
    const [review] = await db.select().from(issues).where(eq(issues.id, w.planQaIssueId));
    expect(review?.status).toBe("in_progress");
  });

  it("does not let a previous generation's verified gate approve a superseded review", async () => {
    const w = await seedApprovalWorld(db);
    const gate = await strictGate(db, w, "pass", "satisfied");
    expect(gate).toMatchObject({ status: "pass" });

    // 검토 중 plan 실행 단위 변경 → 새 reviewGeneration, 이전 판정 무효화.
    const plan = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId: w.companyId, missionId: w.missionId });
    const mutated = { ...(plan!.refs as Record<string, unknown>) };
    mutated.selectedExecutionUnits = [{ id: "unit-2", kind: "workflow_definition_step", title: "Run scout v2", selectionState: "selected", reason: "r", sourceRef: { type: "workflow_definition_step", id: w.sourceWorkflowId, stepId: "scout" } }];
    await db.update(missionPlanArtifacts).set({ refs: mutated }).where(eq(missionPlanArtifacts.id, plan!.id));

    const result = await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId: w.companyId, missionId: w.missionId });
    expect(result.status).toBe("plan_qa_pending");
    if (result.status !== "plan_qa_pending") return;
    const refs = await activePlanRefs(db, w);
    const newPlanQa = refs.planQa as { issueId: string; reviewGeneration: number };
    expect(newPlanQa.issueId).not.toBe(w.planQaIssueId);
    expect(newPlanQa.reviewGeneration).toBeGreaterThan(1);
    expect((refs.paqoWorkflow as Record<string, unknown> | undefined)?.workflowRunId).toBeUndefined();
    const [oldRow] = await db.select().from(missionPlanQaVerdicts).where(eq(missionPlanQaVerdicts.planQaIssueId, w.planQaIssueId));
    expect(oldRow?.verdict).toBe("pass");
  });
});
