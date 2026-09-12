import { randomUUID } from "node:crypto";
import request from "supertest";
import { eq } from "drizzle-orm";
import { activityLog, assets, heartbeatRuns, issueComments, issues, missionPlanArtifacts, missionPlanQaVerdicts, workflowRuns } from "@paperclipai/db";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { checkoutReviewer, GATE_CHECK_ID, seedGateWorld, type GateWorld } from "./helpers/plan-qa-addendum.js";
import { planQaApiApp } from "./helpers/plan-qa-api.js";
import { submitWorkflowVerdict } from "../services/workflow/agent-api.js";

const body = { schemaVersion: 2, verdict: "pass", checks: [] };
describeQualityDb("PLAN-QA API authorization before writes", () => {
  let testDb: QualityTestDb;
  beforeAll(async () => { testDb = await createQualityTestDb(); }, 60_000);
  afterAll(async () => { await testDb?.close(); });
  async function snapshot(w: GateWorld) {
    const db = testDb.db;
    return { issues: await db.select().from(issues).where(eq(issues.companyId, w.companyId)),
      verdicts: await db.select().from(missionPlanQaVerdicts).where(eq(missionPlanQaVerdicts.companyId, w.companyId)),
      assets: await db.select().from(assets).where(eq(assets.companyId, w.companyId)),
      comments: await db.select().from(issueComments).where(eq(issueComments.companyId, w.companyId)),
      activity: await db.select().from(activityLog).where(eq(activityLog.companyId, w.companyId)),
      workflows: await db.select().from(workflowRuns).where(eq(workflowRuns.companyId, w.companyId)) };
  }
  it.each(["input", "read", "verdict"])("rejects cross-company %s with no writes", async (operation) => {
    const w = await seedGateWorld(testDb.db);
    const foreign = await seedGateWorld(testDb.db);
    const before = await snapshot(w);
    const app = planQaApiApp(testDb.db, foreign);
    const base = `/api/issues/${w.planQaIssueId}/mission-plan-qa/${operation}`;
    const out = operation === "input" ? await request(app).get(base) : await request(app).post(base).send(operation === "read" ? { checkId: GATE_CHECK_ID, pointers: ["/missionId"] } : body);
    expect(out.status).toBe(403);
    expect(await snapshot(w)).toEqual(before);
  });
  it.each(["board", "wrong_agent", "old_run", "null_epoch", "finished_run"])("rejects %s input/read/v2 without writes", async (kind) => {
    const w = await seedGateWorld(testDb.db);
    let actor: Parameters<typeof planQaApiApp>[2];
    if (kind === "board") actor = { type: "board", source: "local_implicit", userId: "local-board", isInstanceAdmin: true };
    if (kind === "wrong_agent") actor = { type: "agent", source: "agent_jwt", companyId: w.companyId, agentId: w.ownerAgentId, runId: w.runId };
    if (kind === "old_run") await checkoutReviewer(testDb.db, { companyId: w.companyId, issueId: w.planQaIssueId, reviewerAgentId: w.reviewerAgentId, executionEpoch: 2 });
    if (kind === "null_epoch") await testDb.db.update(heartbeatRuns).set({ executionEpoch: null }).where(eq(heartbeatRuns.id, w.runId));
    if (kind === "finished_run") await testDb.db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, w.runId));
    const before = await snapshot(w);
    const app = planQaApiApp(testDb.db, w, actor);
    const base = `/api/issues/${w.planQaIssueId}/mission-plan-qa`;
    for (const out of [await request(app).get(`${base}/input`),
      await request(app).post(`${base}/read`).send({ checkId: GATE_CHECK_ID, pointers: ["/missionId"] }),
      await request(app).post(`${base}/verdict`).send(body)]) {
      expect([401, 403, 409, 422]).toContain(out.status);
      expect(await snapshot(w)).toEqual(before);
    }
  });
  it.each(["unknown_field", "checks_without_v2", "duplicate_checks", "client_scope"])("rejects malformed %s before writing", async (kind) => {
    const w = await seedGateWorld(testDb.db);
    const check = { checkId: GATE_CHECK_ID, status: "satisfied", readRef: { attachmentId: randomUUID(), sha256: "a".repeat(64) }, evidence: [] };
    const payload = kind === "unknown_field" ? { ...body, override: true }
      : kind === "checks_without_v2" ? { verdict: "pass", checks: [check] }
      : kind === "duplicate_checks" ? { ...body, checks: [check, check] } : { ...body, scope: {} };
    const before = await snapshot(w);
    await request(planQaApiApp(testDb.db, w)).post(`/api/issues/${w.planQaIssueId}/mission-plan-qa/verdict`).send(payload).expect(400);
    expect(await snapshot(w)).toEqual(before);
  });
  it.each(["v1_strict", "malformed_marker", "missing_marker", "missing_decision", "foreign_decision"])("fails closed on %s", async (kind) => {
    const w = await seedGateWorld(testDb.db);
    if (kind === "malformed_marker" || kind === "missing_marker") await testDb.db.update(issues)
      .set({ qualityPlanQaBinding: kind === "malformed_marker" ? {} : null }).where(eq(issues.id, w.planQaIssueId));
    if (kind === "missing_decision" || kind === "foreign_decision") {
      const [plan] = await testDb.db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.id, w.planArtifactId));
      await testDb.db.update(missionPlanArtifacts).set({ refs: { ...plan!.refs, ownerPlanDecision: kind === "missing_decision" ? null : { decisionHash: "d".repeat(64) } } }).where(eq(missionPlanArtifacts.id, w.planArtifactId));
    }
    const before = await snapshot(w);
    const payload = kind === "v1_strict" || kind === "malformed_marker" ? { verdict: "pass" } : body;
    const out = await request(planQaApiApp(testDb.db, w)).post(`/api/issues/${w.planQaIssueId}/mission-plan-qa/verdict`).send(payload);
    expect([409, 422]).toContain(out.status);
    expect(await snapshot(w)).toEqual(before);
  });
  it("blocks the generic workflow verdict even when a marked review has a workflow origin", async () => {
    const w = await seedGateWorld(testDb.db);
    await testDb.db.update(issues).set({ originKind: "workflow_execution" }).where(eq(issues.id, w.planQaIssueId));
    const before = await snapshot(w);
    const out = await request(planQaApiApp(testDb.db, w)).post(`/api/issues/${w.planQaIssueId}/workflow/verdict`).send({ verdict: "pass" });
    expect(out.status).toBe(409);
    expect(out.body.error).toBe("quality_plan_qa_dedicated_submission_required");
    const [issue] = await testDb.db.select().from(issues).where(eq(issues.id, w.planQaIssueId));
    await expect(submitWorkflowVerdict({ db: testDb.db, issue: issue!, actor: { actorType: "agent", actorId: w.reviewerAgentId, agentId: w.reviewerAgentId, runId: w.runId }, data: { verdict: "pass" } }))
      .rejects.toMatchObject({ status: 409, message: "quality_plan_qa_dedicated_submission_required" });
    expect(await snapshot(w)).toEqual(before);
  });
});
