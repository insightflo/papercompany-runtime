import "./helpers/workflow-control-node-boundary.js";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, missionPlanArtifacts, missionPlanQaVerdicts, issues, workflowDefinitions, workflowRuns, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { board, seedWorld } from "./helpers/workflow-seed-world.js";
import { createAdmittedWorkflowRun } from "../services/workflow/agent-run-create.js";
import { recordMissionPlanQaVerdict } from "../services/missions/mission-plan-qa-verdicts.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("revision-race-"); db = createDb(temp.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "revision-race-"))); }, 60000);
afterAll(async () => { await temp?.cleanup(); await rm(root, { recursive: true, force: true }); });
function latch() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }

it.each(["api", "direct-row", "admission-first"])("serializes %s PLAN-QA revocation with board admission", async writer => {
  const f = await seedWorld(db, root);
  const [definition] = await db.insert(workflowDefinitions).values({ companyId: f.companyId, missionId: f.revision.id,
    name: "Revision", sourceKind: "paqo", definitionHash: "a".repeat(64), stepsJson: f.steps }).returning();
  const [qa] = await db.insert(issues).values({ companyId: f.companyId, missionId: f.revision.id, title: "QA", status: "done" }).returning();
  const hash = "b".repeat(64);
  await db.insert(missionPlanArtifacts).values({ companyId: f.companyId, missionId: f.revision.id, revision: 1, ownerAgentId: f.agentId,
    missionGoal: "report", refs: { ownerPlanDecision: { decisionHash: hash }, planQa: { issueId: qa.id, decisionHash: hash },
      paqoWorkflow: { workflowDefinitionId: definition.id, decisionHash: hash } } });
  const verdictInput = { companyId: f.companyId, missionId: f.revision.id, planQaIssueId: qa.id, decisionHash: hash,
    reviewedBy: { actorType: "user" as const, actorId: "local-board" } };
  await recordMissionPlanQaVerdict({ db, ...verdictInput, verdict: "pass" });
  const changed = latch(), release = latch();
  if (writer === "admission-first") {
    const admission = db.transaction(async tx => {
      const run = await createAdmittedWorkflowRun(tx as unknown as Db,
        { ...f.input, workflowId: definition.id, seedFromRun: undefined }, board);
      changed.release(); await release.promise; return run;
    });
    await changed.promise;
    const revoke = recordMissionPlanQaVerdict({ db, ...verdictInput, verdict: "request_changes" });
    const early = await Promise.race([revoke, new Promise<"waiting">(r => setTimeout(() => r("waiting"), 150))]);
    release.release();
    const run = await admission; await revoke;
    expect(early).toBe("waiting");
    expect((await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, f.revision.id))).map(r => r.id)).toEqual([run.id]);
    return;
  }
  const revocation = db.transaction(async tx => {
    if (writer === "api") await recordMissionPlanQaVerdict({ db: tx as unknown as Db, ...verdictInput, verdict: "request_changes" });
    else await tx.update(missionPlanQaVerdicts).set({ verdict: "request_changes" }).where(eq(missionPlanQaVerdicts.planQaIssueId, qa.id));
    changed.release();
    await release.promise;
  });
  await changed.promise;
  const admission = createAdmittedWorkflowRun(db, { ...f.input, workflowId: definition.id, seedFromRun: undefined }, board)
    .then(run => ({ run }), error => ({ error }));
  // While the revocation is uncommitted, admission must wait, not return a run.
  const early = await Promise.race([admission, new Promise<"waiting">(r => setTimeout(() => r("waiting"), 150))]);
  release.release();
  await revocation;
  const result = await admission;
  expect(early).toBe("waiting");
  expect(result).toMatchObject({ error: { message: "workflow_revision_board_start_not_ready" } });
  expect(await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, f.revision.id))).toEqual([]);
  const [verdict] = await db.select().from(missionPlanQaVerdicts).where(eq(missionPlanQaVerdicts.planQaIssueId, qa.id));
  expect(verdict.verdict).toBe("request_changes");
});
