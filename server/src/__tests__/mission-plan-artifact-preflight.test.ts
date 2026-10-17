import "./helpers/workflow-control-node-boundary.js";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import {
  agentToolGrants, agentWakeupRequests, companies, heartbeatRuns, issues, missionPlanDecisionSubmissions,
  missionPlanQaVerdicts, missions, toolDefinitions, workflowDefinitions, workflowRuns, workflowStepRuns,
} from "@paperclipai/db";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { seedPaqoMissionFixture } from "./helpers/paqo-immutability.js";
import { assertAgentAssignments, resetControlNodeBoundary } from "./helpers/workflow-control-node-boundary.js";
import { errorHandler } from "../middleware/index.js";
import { workflowAgentApiRoutes } from "../routes/workflow-agent-api.js";
import { missionPlanArtifactService } from "../services/mission-plan-artifacts.js";
import { missionService } from "../services/missions.js";
import { submitMissionOwnerPlanDecision } from "../services/missions/mission-plan-decision-agent-api.js";
import { upsertMissionPlanDecisionSubmission } from "../services/missions/mission-plan-decision-ledger.js";
import { recordMissionPlanQaVerdict } from "../services/missions/mission-plan-qa-verdicts.js";
import { readPlanQaVerdict } from "../services/missions/mission-plan-qa-completion-gate.js";
import { ensurePlanQaReviewIssue } from "../services/missions/plan-qa-reviewer-assignment.js";
import {
  buildMissionOwnerPlanRevisionDraft, hashOwnerPlanDecision, recordLatestAuthorizedMissionOwnerPlanDecision,
  type PlanQaWakeupHandler,
} from "../services/mission-owner-plan-decisions.js";
import * as builder from "../services/missions/paqo-workflow-steps.js";
import * as assignment from "../services/issue-assignment-wakeup.js";
import { createWorkflowRun } from "../services/workflow/workflow-store.js";
import { setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";

let testDb: QualityTestDb, root: string;
const selector = { type: "document", title: "content.json" };
const contract = { schemaVersion: "manual-onboarding.qa.v1", role: "qa", inputStepId: "write" };
// Registered tool contract mirrors the units' declared `contract` (role + schemaVersion) so the
// fixture's corrected plans pass the submission-time registration comparison; preflight compares
// the declaration against this registration exactly like dispatch-time freezeCompanyArtifactAttempt.
const registeredReviewContract = { role: "qa", resultFileName: "qa-result.json", resultSchemaVersion: "manual-onboarding.qa.v1",
  resultAdapter: "generic", inputParams: {}, deploymentFiles: ["runner.mjs"], inputEnvelopeVersion: "workflow.artifact-input.v1" };
const envKeys = ["PAPERCLIP_STORAGE_PROVIDER", "PAPERCLIP_STORAGE_LOCAL_DIR"] as const;
const savedEnv = envKeys.map(key => process.env[key]);

describeQualityDb("mission plan artifact materialization preflight", () => {
  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "plan-artifact-preflight-")));
    process.env.PAPERCLIP_STORAGE_PROVIDER = "local_disk";
    process.env.PAPERCLIP_STORAGE_LOCAL_DIR = path.join(root, "storage");
    testDb = await createQualityTestDb();
    // Native registration/dispatch stay real; no tool or agent CLI is executed.
    setWorkflowToolStepExecutor(async () => { throw new Error("Unexpected tool execution in plan preflight"); });
  }, 60_000);
  beforeEach(resetControlNodeBoundary);
  afterAll(async () => {
    setWorkflowToolStepExecutor(null);
    await testDb?.close();
    if (root) await rm(root, { recursive: true, force: true });
    envKeys.forEach((key, i) => { if (savedEnv[i] === undefined) delete process.env[key]; else process.env[key] = savedEnv[i]; });
  });

  async function world(sourceRevision = false, toolArtifactContract: Record<string, unknown> | null = registeredReviewContract) {
    const db = testDb.db, f = await seedPaqoMissionFixture(db, "Artifact preflight");
    await db.update(companies).set({ workProductRoot: root }).where(eq(companies.id, f.companyId));
    await db.update(missions).set({ status: "planning" }).where(eq(missions.id, f.missionId));
    await db.update(issues).set({ status: "done", assigneeAgentId: f.ownerAgentId }).where(eq(issues.id, f.planningIssueId));
    const [tool] = await db.insert(toolDefinitions).values({ companyId: f.companyId, name: "local-review",
      description: "Local definition-only tool", adapterType: "builtin",
      adapterConfig: { ...(toolArtifactContract ? { artifactContract: toolArtifactContract } : {}) }, enabled: true }).returning();
    await db.insert(agentToolGrants).values({ companyId: f.companyId, agentId: f.otherAgentId, toolId: tool!.id, grantedBy: "board" });
    if (sourceRevision) {
      const [source] = await db.insert(missions).values({ companyId: f.companyId, ownerAgentId: f.ownerAgentId,
        title: "Source", status: "completed" }).returning();
      const [definition] = await db.insert(workflowDefinitions).values({ companyId: f.companyId, name: "Source",
        stepsJson: [{ id: "source-write", name: "Write", agentId: f.otherAgentId, type: "agent", dependencies: [] }] }).returning();
      const run = await createWorkflowRun(db, { companyId: f.companyId, workflowId: definition!.id, missionId: source!.id, triggeredBy: "board" });
      await db.update(workflowRuns).set({ status: "completed" }).where(eq(workflowRuns.id, run.id));
      await db.update(missions).set({ sourceMissionId: source!.id, sourceWorkflowRunId: run.id }).where(eq(missions.id, f.missionId));
    }
    const units: Record<string, unknown>[] = [
      { id: "write", kind: "mission_plan_unit", title: "Write", type: "action", assigneeAgentId: f.otherAgentId,
        sourceStepId: "source-write", sourceRef: { type: "mission_plan_unit", id: "write" }, graphWorkProductRequired: true, dependencies: [] },
      { id: "check", kind: "mission_plan_unit", title: "Check", type: "action", assigneeAgentId: f.otherAgentId,
        sourceRef: { type: "mission_plan_unit", id: "check" }, toolNames: ["local-review"], dependencies: ["write"],
        toolArgs: { content: "{$steps.source-write.workProductPath}" }, toolArtifactContract: contract,
        workProductSelectors: { "source-write": selector } },
      { id: "semantic", kind: "mission_plan_unit", title: "Semantic review", type: "qa", qaType: "semantic",
        assigneeAgentId: f.otherAgentId, sourceRef: { type: "mission_plan_unit", id: "semantic" }, dependencies: ["check"] },
    ];
    const decision = (selectedExecutionUnits = units) => ({ missionId: f.missionId, missionGoal: "Review content",
      selectedExecutionUnits, selectedPlanTemplateIds: [], ruleRefs: [], kbRefs: [], requiredInputs: [],
      successCriteria: ["Content verified"], steps: [] });
    const qaWakeups = vi.fn<PlanQaWakeupHandler>();
    const submit = (selected = units) => submitMissionOwnerPlanDecision({ db,
      issue: { id: f.planningIssueId, companyId: f.companyId, missionId: f.missionId, originKind: "mission_main_executor_plan" },
      actor: { actorType: "agent", actorId: f.ownerAgentId }, decision: decision(selected), enqueuePlanQaWakeup: qaWakeups });
    const consume = () => recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId: f.companyId, missionId: f.missionId });
    const approve = (planQaIssueId: string, decisionHash: string) => recordMissionPlanQaVerdict({ db, companyId: f.companyId,
      missionId: f.missionId, planQaIssueId, decisionHash, verdict: "pass", reviewedBy: { actorType: "user", actorId: "test-board" } });
    return { ...f, units, decision, submit, consume, approve, qaWakeups };
  }
  type World = Awaited<ReturnType<typeof world>>;
  const changed = (w: World, patch: Record<string, unknown>) => {
    const unit = { ...w.units[1], ...patch };
    // A missing JSON field is absent, never a present undefined value.
    for (const key of Object.keys(patch)) if (patch[key] === undefined) delete unit[key];
    return [w.units[0]!, unit, w.units[2]!];
  };
  async function noExecution(w: World, historicalQaCount = 0) {
    const db = testDb.db;
    expect(await db.select().from(issues).where(and(eq(issues.missionId, w.missionId), eq(issues.originKind, "mission_plan_qa"))))
      .toHaveLength(historicalQaCount);
    expect(await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.missionId, w.missionId))).toEqual([]);
    expect(await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, w.missionId))).toEqual([]);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, w.companyId))).toEqual([]);
    expect(w.qaWakeups.mock.calls).toEqual([]);
  }
  async function rejected(w: World, selected: Record<string, unknown>[], code: string, field: string, reference?: string) {
    const result = await w.submit(selected);
    expect(result).toMatchObject({ status: "invalid", reason: "paqo_artifact_contract_invalid",
      diagnostics: [expect.objectContaining({ code, severity: "invalid", details: expect.objectContaining({ unitId: "check", field,
        ...(reference ? { reference } : {}) }) })] });
    const [ledger] = await testDb.db.select().from(missionPlanDecisionSubmissions).where(eq(missionPlanDecisionSubmissions.missionId, w.missionId));
    expect(ledger).toMatchObject({ status: "rejected", rejectionReason: "paqo_artifact_contract_invalid", diagnostics: result.diagnostics,
      decision: w.decision(selected), sourceCommentId: null });
    await noExecution(w);
    return result;
  }

  // Break caught: the real builder throws but submission silently advances to PLAN-QA.
  it.each([
    ["missing selectors", { workProductSelectors: undefined }, "paqo_artifact_schema_invalid", "workProductSelectors", undefined],
    ["empty selectors", { workProductSelectors: {} }, "paqo_artifact_selector_required", "workProductSelectors", "write"],
    ["non-target selectors", { workProductSelectors: { semantic: selector } }, "paqo_artifact_selector_required", "workProductSelectors", "write"],
    ["malformed selector", { workProductSelectors: { write: { type: "bogus", title: "content.json" } } }, "paqo_artifact_schema_invalid", "workProductSelectors", undefined],
    ["malformed contract", { toolArtifactContract: { ...contract, schemaVersion: "" } }, "paqo_artifact_schema_invalid", "toolArtifactContract", undefined],
    ["malformed QA config", { qaConfig: { mode: "bogus" } }, "paqo_artifact_schema_invalid", "qaConfig", undefined],
    ["missing reference", { workProductSelectors: { missing: selector } }, "paqo_artifact_reference_missing", "workProductSelectors", "missing"],
    ["ambiguous selector", { workProductSelectors: { write: selector, "source-write": selector } }, "paqo_artifact_reference_ambiguous", "workProductSelectors", "source-write"],
  ] as const)("rejects %s durably before review or execution", async (_label, patch, code, field, reference) => {
    const w = await world(), result = await rejected(w, changed(w, patch), code, field, reference);
    if (code === "paqo_artifact_schema_invalid") expect(result.diagnostics[0]).toMatchObject({ details: {
      schemaIssues: expect.arrayContaining([expect.objectContaining({ code: expect.any(String), path: expect.any(Array) })]) } });
  });

  it("rejects ambiguous source aliases without choosing an input", async () => {
    const w = await world();
    await rejected(w, changed(w, { sourceStepId: "source-write" }), "paqo_artifact_reference_ambiguous", "sourceStepId", "source-write");
  });
  it("catches the same contract error inside source revision diagnostics", async () => {
    const w = await world(true);
    await rejected(w, changed(w, { workProductSelectors: undefined }), "paqo_artifact_schema_invalid", "workProductSelectors");
  });
  it.each([false, true])("propagates unknown generator errors without a forged verdict (revision=%s)", async revision => {
    const w = await world(revision), error = new Error("unexpected generator defect");
    const spy = vi.spyOn(builder, "buildPaqoWorkflowSteps").mockImplementationOnce(() => { throw error; });
    try { await expect(w.submit()).rejects.toBe(error); } finally { spy.mockRestore(); }
    expect(await testDb.db.select().from(missionPlanQaVerdicts).where(eq(missionPlanQaVerdicts.missionId, w.missionId))).toEqual([]);
    const [ledger] = await testDb.db.select().from(missionPlanDecisionSubmissions).where(eq(missionPlanDecisionSubmissions.missionId, w.missionId));
    expect(ledger!.status).toBe("submitted");
    await noExecution(w);
  });

  it("rejects a declared tool artifact contract that mismatches the registered tool definition at submission", async () => {
    // [2026-10-17 manual-onboarding incident] preflight passed a QA step whose declared schemaVersion
    // differed from the tool registration; the plan failed only at dispatch (422 artifact_contract_step_mismatch).
    const w = await world(false, { ...registeredReviewContract, resultSchemaVersion: "workflow.qa-result.v1" });
    const result = await w.submit();
    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") throw new Error("Mismatched tool contract was not rejected");
    expect(result.reason).toBe("tool_artifact_contract_mismatch");
    expect(result.diagnostics).toHaveLength(1);
    const diagnostic = result.diagnostics[0]!;
    expect(diagnostic).toMatchObject({ code: "tool_artifact_contract_mismatch", severity: "invalid",
      details: { toolName: "local-review", declaredRole: "qa", declaredSchemaVersion: "manual-onboarding.qa.v1",
        registeredRole: "qa", registeredResultSchemaVersion: "workflow.qa-result.v1" } });
    const stepId = (diagnostic as { details?: { stepId?: string } }).details?.stepId;
    expect(typeof stepId).toBe("string");
    // The message must be actionable: step id, tool name, declared value, registered value.
    expect(diagnostic.message).toContain(stepId!);
    expect(diagnostic.message).toContain("local-review");
    expect(diagnostic.message).toContain("manual-onboarding.qa.v1");
    expect(diagnostic.message).toContain("workflow.qa-result.v1");
    const [ledger] = await testDb.db.select().from(missionPlanDecisionSubmissions).where(eq(missionPlanDecisionSubmissions.missionId, w.missionId));
    expect(ledger).toMatchObject({ status: "rejected", rejectionReason: "tool_artifact_contract_mismatch", diagnostics: result.diagnostics });
    await noExecution(w);
  });

  it("rejects a declared tool artifact contract when the tool registration declares none", async () => {
    const w = await world(false, null);
    const result = await w.submit();
    expect(result).toMatchObject({ status: "invalid", reason: "tool_artifact_contract_required",
      diagnostics: [expect.objectContaining({ code: "tool_artifact_contract_required", severity: "invalid",
        message: expect.stringContaining("local-review") })] });
    const [ledger] = await testDb.db.select().from(missionPlanDecisionSubmissions).where(eq(missionPlanDecisionSubmissions.missionId, w.missionId));
    expect(ledger).toMatchObject({ status: "rejected", rejectionReason: "tool_artifact_contract_required" });
    await noExecution(w);
  });

  it("keeps the authorized HTTP submission result at 200 for invalid contracts", async () => {
    const w = await world(), db = testDb.db, runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: w.companyId, agentId: w.ownerAgentId,
      issueId: w.planningIssueId, invocationSource: "assignment", status: "running" });
    await db.update(issues).set({ status: "in_progress", checkoutRunId: runId, executionRunId: runId }).where(eq(issues.id, w.planningIssueId));
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "agent", source: "agent_jwt", companyId: w.companyId, agentId: w.ownerAgentId, runId }; next(); });
    app.use("/api", workflowAgentApiRoutes(db)); app.use(errorHandler);
    const response = await request(app).post(`/api/issues/${w.planningIssueId}/mission-plan-decision`)
      .send({ decision: w.decision(changed(w, { workProductSelectors: undefined })) }).expect(200);
    expect(response.body).toMatchObject({ status: "invalid", reason: "paqo_artifact_contract_invalid" });
    await noExecution(w);
  });

  it("reenters a fixed historical invalid PASS, replans once, then starts only the corrected reviewed plan", async () => {
    // Historical incomplete input is frozen BEFORE PASS, not corruption of a valid approved plan.
    const w = await world(), db = testDb.db, incomplete = w.decision(changed(w, { workProductSelectors: undefined }));
    const decisionHash = hashOwnerPlanDecision(incomplete);
    const draft = buildMissionOwnerPlanRevisionDraft({ decision: incomplete, expectedMissionId: w.missionId,
      planningIssueId: w.planningIssueId, commentId: null });
    if (!draft.ok) throw new Error("Invalid historical fixture shape");
    const plan = await missionPlanArtifactService(db).createMissionPlanRevision({ companyId: w.companyId, missionId: w.missionId,
      refs: { ...draft.draft.refs, ownerPlanDecision: { ...draft.draft.refs.ownerPlanDecision, decisionHash } },
      requiredInputs: [], successCriteria: draft.draft.successCriteria, steps: draft.draft.steps });
    const qa = await ensurePlanQaReviewIssue({ db, companyId: w.companyId, missionId: w.missionId, missionTitle: "Artifact preflight",
      missionDescription: null, planningIssueId: w.planningIssueId, decisionHash, planArtifactId: plan.id, preferredReviewerAgentId: w.otherAgentId });
    await w.approve(qa.id, decisionHash);
    await upsertMissionPlanDecisionSubmission({ db, companyId: w.companyId, missionId: w.missionId, planningIssueId: w.planningIssueId,
      authorAgentId: w.ownerAgentId, decision: incomplete, decisionHash, status: "plan_qa_pending" });
    const verdicts = await db.select().from(missionPlanQaVerdicts).where(eq(missionPlanQaVerdicts.missionId, w.missionId));
    expect(verdicts).toMatchObject([{ verdict: "pass", decisionHash }]);
    expect(await readPlanQaVerdict({ db, companyId: w.companyId, missionId: w.missionId,
      missionPlanArtifactId: plan.id, planQaIssueId: qa.id, decisionHash })).toMatchObject({ verdict: "pass" });
    const wakes: string[] = [];
    const supervision = missionService(db, { onPlanSubmissionMissing: input => { wakes.push(input.idempotencyKey); } });
    const cycle = () => supervision.runMainExecutorSupervision({ missionId: w.missionId, applySafeActions: true,
      dispatchOwnerDecisionWakeups: false, dispatchStaleSourceIssueWakeups: false });
    const reentry = await cycle();
    expect(reentry.appliedActions).toEqual(expect.arrayContaining([expect.objectContaining({ type: "materialize_plan_decision",
      resultStatus: "invalid", planDecisionReason: "paqo_artifact_contract_invalid" })]));
    expect(wakes).toEqual([]); await noExecution(w, 1);
    const [rejectedLedger] = await db.select().from(missionPlanDecisionSubmissions).where(eq(missionPlanDecisionSubmissions.missionId, w.missionId));
    expect(rejectedLedger).toMatchObject({ status: "rejected", rejectionReason: "paqo_artifact_contract_invalid" });
    const replan = await cycle();
    expect(replan.appliedActions).toEqual(expect.arrayContaining([expect.objectContaining({ type: "plan_submission_rejected", resultStatus: "wakeup_requested" })]));
    expect(wakes).toHaveLength(1);
    const [planning] = await db.select().from(issues).where(eq(issues.id, w.planningIssueId));
    expect(planning!.status).toBe("todo");
    expect((await cycle()).appliedActions.some(a => a.type === "plan_submission_rejected")).toBe(false);
    expect(wakes).toHaveLength(1);
    expect(await db.select().from(missionPlanQaVerdicts).where(eq(missionPlanQaVerdicts.missionId, w.missionId))).toEqual(verdicts);
    const corrected = await w.submit();
    expect(corrected.status).toBe("plan_qa_pending");
    if (corrected.status !== "plan_qa_pending") throw new Error("Corrected plan was not reviewed");
    expect(corrected.planQaIssueId).not.toBe(qa.id);
    expect(corrected.decisionHash).not.toBe(decisionHash);
    await w.approve(corrected.planQaIssueId, corrected.decisionHash);
    const dispatch = vi.spyOn(assignment, "queueIssueAssignmentWakeup");
    onTestFinished(() => dispatch.mockRestore());
    expect(await w.consume()).toMatchObject({ status: "recorded" });
    const definitions = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.missionId, w.missionId));
    expect(definitions).toHaveLength(1);
    const [definition] = definitions;
    const steps = definition!.stepsJson as Array<{ id: string; name: string; workProductSelectors?: unknown; toolArtifactContract?: unknown; toolArgs?: unknown }>;
    const write = steps.find(s => s.name === "[ACTION] Write")!, check = steps.find(s => s.name === "[ACTION] Check")!;
    expect(check.workProductSelectors).toEqual({ [write.id]: selector });
    expect(check.toolArtifactContract).toEqual({ ...contract, inputStepId: write.id });
    expect(check.toolArgs).toEqual({ content: `{$steps.${write.id}.workProductPath}` });
    const runs = await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, w.missionId));
    expect(runs).toHaveLength(1); expect(runs[0]!.status).toBe("running");
    expect(runs[0]!.startedAt).not.toBeNull();
    const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runs[0]!.id));
    // The external heartbeat admission double does not claim/run the dispatched issue.
    expect(rows.find(s => s.stepId === write.id)).toMatchObject({ status: "pending", issueId: expect.any(String) });
    await assertAgentAssignments(db, { companyId: w.companyId, agentId: w.otherAgentId, runId: runs[0]!.id,
      steps: [{ stepId: write.id, issueId: rows.find(s => s.stepId === write.id)!.issueId }] });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(await w.consume()).toMatchObject({ status: "noop", reason: "already_recorded" });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.missionId, w.missionId))).toHaveLength(1);
    expect(await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, w.missionId))).toHaveLength(1);
  }, 60_000);
});
