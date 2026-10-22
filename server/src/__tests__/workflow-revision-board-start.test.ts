import "./helpers/workflow-control-node-boundary.js";
import express from "express";
import request from "supertest";
import { workflowRoutes } from "../routes/workflows.js";
import { errorHandler } from "../middleware/index.js";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb, issues, missionPlanArtifacts, missionPlanQaVerdicts, missions, operatorDecisions, workflowRuns, workflowDefinitions } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedWorld } from "./helpers/workflow-seed-world.js";
import { ensureOwnerPlanWorkflowRun } from "../services/workflow/owner-plan-workflow-run.js";
import { createAdmittedWorkflowRun } from "../services/workflow/agent-run-create.js";
import { startApprovedRevisionRun, sweepApprovedRevisionStarts } from "../services/workflow/approved-revision-start.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("revision-board-start-"); db = createDb(temp.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "revision-board-start-"))); }, 60000);
afterAll(async () => { await temp?.cleanup(); await rm(root, { recursive: true, force: true }); });
it("automatic revision PLAN materialization leaves a definition for explicit board trigger", async () => {
  const f = await seedWorld(db, root);
  expect(await ensureOwnerPlanWorkflowRun({ db, companyId: f.companyId, missionId: f.revision.id, workflowId: f.definition.id,
    triggeredBy: f.agentId, requirePlanQaPass: async () => {} })).toBeNull();
  expect(await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, f.revision.id))).toEqual([]);
  const target = await f.admit();
  expect(await ensureOwnerPlanWorkflowRun({ db, companyId: f.companyId, missionId: f.revision.id, workflowId: f.definition.id,
    triggeredBy: f.agentId, requirePlanQaPass: async () => {} })).toBe(target.id);
});
it.each(["omitted", "different"])("HTTP rejects %s mission identity before any mission or run creation", async mode => {
  const f = await seedWorld(db, root);
  await db.update(workflowDefinitions).set({ sourceKind: "paqo", missionId: f.revision.id }).where(eq(workflowDefinitions.id, f.definition.id));
  const [ordinary] = await db.insert(missions).values({ companyId: f.companyId, ownerAgentId: f.agentId, title: "Ordinary" }).returning();
  const beforeMissions = await db.select().from(missions).where(eq(missions.companyId, f.companyId));
  const beforeRuns = await db.select().from(workflowRuns).where(eq(workflowRuns.companyId, f.companyId));
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.actor = { type: "agent", agentId: f.agentId, companyId: f.companyId }; next(); });
  app.use("/api", workflowRoutes(db)); app.use(errorHandler);
  const response = await request(app).post(`/api/workflows/${f.definition.id}/runs`)
    .send(mode === "omitted" ? {} : { missionId: ordinary.id });
  expect(response.status, JSON.stringify(response.body)).toBe(409);
  expect(response.body.error).toBe("workflow_revision_mission_mismatch");
  expect(await db.select().from(missions).where(eq(missions.companyId, f.companyId))).toEqual(beforeMissions);
  expect(await db.select().from(workflowRuns).where(eq(workflowRuns.companyId, f.companyId))).toEqual(beforeRuns);
});
it("agent cannot bypass revision PLAN board wait by omitting seeds", async () => {
  const f = await seedWorld(db, root);
  await db.update(workflowDefinitions).set({ sourceKind: "paqo", missionId: f.revision.id }).where(eq(workflowDefinitions.id, f.definition.id));
  const { seedFromRun: _, ...input } = f.input;
  await expect(createAdmittedWorkflowRun(db, input, { type: "agent", agentId: f.agentId, companyId: f.companyId }))
    .rejects.toThrow("workflow_revision_board_start_required");
});

// [승인=시작 2026-10-22] 계획 검토 통과(board-wait) 상태의 수정 미션을 만든다.
async function approvedWaitWorld() {
  const f = await seedWorld(db, root);
  const [definition] = await db.insert(workflowDefinitions).values({ companyId: f.companyId, missionId: f.revision.id,
    name: "Revision", sourceKind: "paqo", definitionHash: "a".repeat(64), stepsJson: f.steps }).returning();
  const [qa] = await db.insert(issues).values({ companyId: f.companyId, missionId: f.revision.id, title: "QA", status: "done" }).returning();
  const hash = "b".repeat(64);
  await db.insert(missionPlanArtifacts).values({ companyId: f.companyId, missionId: f.revision.id, revision: 1,
    ownerAgentId: f.agentId, missionGoal: "report", refs: { ownerPlanDecision: { decisionHash: hash },
      planQa: { issueId: qa.id, decisionHash: hash }, paqoWorkflow: { workflowDefinitionId: definition.id, decisionHash: hash } } });
  await db.insert(missionPlanQaVerdicts).values({ companyId: f.companyId, missionId: f.revision.id, planQaIssueId: qa.id,
    decisionHash: hash, verdict: "pass", reviewerUserId: "local-board" });
  return { ...f, definition };
}

function resolveDecision(companyId: string, missionId: string, outcome: "approve" | "reject" | "hold") {
  return db.insert(operatorDecisions).values({ companyId, requestKey: randomUUID(), requestHash: "c".repeat(64),
    interactionType: "single_select", title: "승인 요청", sourceType: "mission_owner_human_input", sourceId: randomUUID(),
    sourceContext: { missionId, workflowId: null, workflowRunId: null, artifactRefs: [] },
    definition: { options: [{ id: outcome, label: outcome, description: null, facts: [], evidenceRefs: [] }],
      actions: [{ id: outcome, label: outcome, outcome, tone: "primary", requiresSelection: true }],
      selection: { min: 1, max: 1 }, comment: { mode: "optional", label: null, placeholder: null, maxLength: 2000 },
      approvedScope: [], forbiddenScope: [] },
    status: "resolved", result: { actionId: outcome, outcome, selectedOptionIds: [outcome], comment: null },
    resolvedByUserId: "local-board", resolvedAt: new Date() });
}

const agentActor = (f: { agentId: string; companyId: string }) => ({ type: "agent" as const, agentId: f.agentId, companyId: f.companyId });

it("resolved approval lets a non-board actor start the waiting revision run", async () => {
  const f = await approvedWaitWorld();
  await resolveDecision(f.companyId, f.revision.id, "approve");
  const run = await createAdmittedWorkflowRun(db, { ...f.input, workflowId: f.definition.id, seedFromRun: undefined }, agentActor(f));
  expect(run.missionId).toBe(f.revision.id);
  expect(await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, f.revision.id))).toHaveLength(1);
});

it.each(["reject", "hold"] as const)("%s resolution does not authorize the revision start", async outcome => {
  const f = await approvedWaitWorld();
  await resolveDecision(f.companyId, f.revision.id, outcome);
  await expect(createAdmittedWorkflowRun(db, { ...f.input, workflowId: f.definition.id, seedFromRun: undefined }, agentActor(f)))
    .rejects.toThrow("workflow_revision_board_start_required");
  expect(await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, f.revision.id))).toHaveLength(0);
});

it("approval for a different mission does not authorize the start", async () => {
  const f = await approvedWaitWorld();
  await resolveDecision(f.companyId, f.sourceMission.id, "approve");
  await expect(createAdmittedWorkflowRun(db, { ...f.input, workflowId: f.definition.id, seedFromRun: undefined }, agentActor(f)))
    .rejects.toThrow("workflow_revision_board_start_required");
});

it("sweep starts an approved waiting revision exactly once", async () => {
  const f = await approvedWaitWorld();
  await resolveDecision(f.companyId, f.revision.id, "approve");
  expect(await sweepApprovedRevisionStarts(db)).toBe(1);
  expect(await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, f.revision.id))).toHaveLength(1);
  expect(await startApprovedRevisionRun(db, { companyId: f.companyId, missionId: f.revision.id })).toMatchObject({ started: false });
  expect(await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, f.revision.id))).toHaveLength(1);
});
