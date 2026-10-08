import "./helpers/workflow-control-node-boundary.js";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { activityLog, issues, missionPlanDecisionSubmissions, workflowDefinitions, workflowRuns } from "@paperclipai/db";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { revisionPassWorld, REVISION_IDS, GRAPH_DIAGNOSTICS } from "./helpers/revision-pass-world.js";
import { setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";
import { missionService } from "../services/missions.js";
import { listMissionGovernanceThread } from "../services/missions/governance-thread.js";

let testDb: QualityTestDb, root: string;
const storageEnv = ["PAPERCLIP_STORAGE_PROVIDER", "PAPERCLIP_STORAGE_LOCAL_DIR"] as const;
const previousEnv = storageEnv.map(key => process.env[key]);

describeQualityDb("revision raw -> frozen pending -> dedicated PASS", () => {
  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "revision-pass-test-")));
    process.env.PAPERCLIP_STORAGE_PROVIDER = "local_disk";
    process.env.PAPERCLIP_STORAGE_LOCAL_DIR = path.join(root, "storage");
    testDb = await createQualityTestDb();
    setWorkflowToolStepExecutor(async () => { throw new Error("Unexpected tool execution in PASS consumer test"); });
  }, 60_000);
  afterAll(async () => {
    setWorkflowToolStepExecutor(null);
    await testDb?.close();
    if (root) await rm(root, { recursive: true, force: true });
    storageEnv.forEach((key, index) => {
      if (previousEnv[index] === undefined) delete process.env[key]; else process.env[key] = previousEnv[index];
    });
  });

  it("preserves all six validated identities and dependencies across persistence and frozen PASS consumption", async () => {
    // Break caught: generic legacy filtering removes bare A before binding freezes the reviewed plan.
    const w = await revisionPassWorld(testDb.db, root);
    expect(Object.hasOwn(w.decision, "revisionDelta")).toBe(false);
    const pending = await w.active();
    const refs = pending.refs as Record<string, unknown>;
    const units = refs.selectedExecutionUnits as Record<string, unknown>[];
    expect(units.map(u => u.id)).toEqual(REVISION_IDS);
    expect(units.map(u => u.dependencies)).toEqual([[], ["build-service-report-content"], ["validate-service-report-content"],
      ["unit-qa-mechanical"], ["unit-publish"], []]);
    expect(units.slice(0, 2).every(u => !Object.hasOwn(u, "selectionState") && !Object.hasOwn(u, "reason"))).toBe(true);
    const [qaBefore] = await testDb.db.select().from(issues).where(eq(issues.id, w.first.planQaIssueId));
    const response = await w.pass();
    expect(response.body).toMatchObject({ status: "recorded", verdict: "pass", decisionHash: w.first.decisionHash,
      planDecisionStatus: "recorded", planDecisionReason: null, planDecisionDiagnostics: [] });
    const [qaAfter] = await testDb.db.select().from(issues).where(eq(issues.id, w.first.planQaIssueId));
    expect(qaAfter!.qualityPlanQaBinding).toEqual(qaBefore!.qualityPlanQaBinding);
    const recorded = await w.active();
    expect(recorded.id).toBe(pending.id);
    expect(recorded.revision).toBe(pending.revision);
    expect((recorded.refs as Record<string, unknown>).selectedExecutionUnits).toEqual(units);
    expect(await testDb.db.select().from(workflowDefinitions).where(and(eq(workflowDefinitions.companyId, w.companyId),
      eq(workflowDefinitions.missionId, w.mission.id)))).toHaveLength(1);
    // Existing revision policy stays definition-only: neither fabricated delta/source-copy nor auto-start.
    expect(await testDb.db.select().from(workflowRuns).where(eq(workflowRuns.missionId, w.mission.id))).toEqual([]);
  }, 60_000);

  it.each([false, true])("makes a corrupt frozen graph failure durable and visible (strict=%s) without raw fallback or rejection", async (strict) => {
    // Break caught: reason/diagnostics are discarded after recorded PASS, or silently repaired under old PASS.
    const w = await revisionPassWorld(testDb.db, root, strict, strict);
    await w.corrupt();
    const pending = await w.active();
    const [before] = await testDb.db.select().from(missionPlanDecisionSubmissions)
      .where(eq(missionPlanDecisionSubmissions.missionId, w.mission.id));
    const [qaBefore] = await testDb.db.select().from(issues).where(eq(issues.id, w.first.planQaIssueId));
    const response = await w.pass();
    expect(response.body).toMatchObject({ status: "recorded", verdict: "pass", planDecisionStatus: "invalid",
      planDecisionReason: "invalid_dependency_graph", planDecisionDiagnostics: GRAPH_DIAGNOSTICS });
    const observations = await testDb.db.select().from(activityLog).where(and(eq(activityLog.companyId, w.companyId),
      eq(activityLog.entityId, w.mission.id), eq(activityLog.action, "mission.plan.rejected")));
    expect(observations).toEqual(expect.arrayContaining([expect.objectContaining({ details: expect.objectContaining({
      planningIssueId: w.planning.id, decisionHash: w.first.decisionHash,
      reason: "invalid_dependency_graph", diagnostics: GRAPH_DIAGNOSTICS }) })]));
    const verdictActivity = await testDb.db.select().from(activityLog).where(and(eq(activityLog.companyId, w.companyId),
      eq(activityLog.entityId, w.first.planQaIssueId), eq(activityLog.action, "issue.mission_plan_qa_verdict_submitted")));
    expect(verdictActivity.at(-1)?.details).toMatchObject({ planDecisionStatus: "invalid",
      planDecisionReason: "invalid_dependency_graph", planDecisionDiagnostics: GRAPH_DIAGNOSTICS });
    const [after] = await testDb.db.select().from(missionPlanDecisionSubmissions)
      .where(eq(missionPlanDecisionSubmissions.missionId, w.mission.id));
    expect(after).toEqual(before);
    expect(await w.active()).toEqual(pending);
    const [qaAfter] = await testDb.db.select().from(issues).where(eq(issues.id, w.first.planQaIssueId));
    expect(qaAfter!.qualityPlanQaBinding).toEqual(qaBefore!.qualityPlanQaBinding);
    const thread = await listMissionGovernanceThread(testDb.db, { companyId: w.companyId, missionId: w.mission.id });
    expect(thread!.events.some(event => event.summary.includes("invalid_dependency_graph")
      && event.summary.includes("unresolved_dependency_ref"))).toBe(true);
    expect(await listMissionGovernanceThread(testDb.db, { companyId: "00000000-0000-0000-0000-000000000000",
      missionId: w.mission.id })).toBeNull();
    expect(await testDb.db.select().from(workflowDefinitions).where(eq(workflowDefinitions.missionId, w.mission.id))).toEqual([]);
    expect(await testDb.db.select().from(workflowRuns).where(eq(workflowRuns.missionId, w.mission.id))).toEqual([]);
  }, 60_000);

  it.each([false, true])("consumes dedicated PASS without stalling (strict=%s) on the unchanged reviewed graph", async (strict) => {
    const w = await revisionPassWorld(testDb.db, root, strict);
    const response = await w.pass();
    expect(response.body).toMatchObject({ status: "recorded", verdict: "pass", planDecisionStatus: "recorded" });
  }, 60_000);

  it("projects the same frozen failure in supervision appliedActions without changing retry eligibility", async () => {
    // Break caught: supervision keeps status but loses the structured diagnostic payload.
    const w = await revisionPassWorld(testDb.db, root);
    await w.corrupt();
    const service = missionService(testDb.db);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await service.runMainExecutorSupervision({ missionId: w.mission.id, applySafeActions: true });
      expect(result.appliedActions).toEqual(expect.arrayContaining([expect.objectContaining({
        type: "materialize_plan_decision", resultStatus: "invalid", planDecisionReason: "invalid_dependency_graph",
        planDecisionDiagnostics: GRAPH_DIAGNOSTICS })]));
      expect(result.recommendations.some(r => r.type === "plan_submission_rejected")).toBe(false);
    }
    const [submission] = await testDb.db.select().from(missionPlanDecisionSubmissions)
      .where(eq(missionPlanDecisionSubmissions.missionId, w.mission.id));
    expect(submission!.status).toBe("plan_qa_pending");
    expect(await testDb.db.select().from(workflowRuns).where(eq(workflowRuns.missionId, w.mission.id))).toEqual([]);
  }, 60_000);
});
