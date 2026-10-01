import "./helpers/workflow-control-node-boundary.js";
import { mkdtemp, realpath, rm, mkdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, workflowDefinitions, workflowRuns, workflowStepRuns, issues, heartbeatRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedWorld, board } from "./helpers/workflow-seed-world.js";
import { admittedProducer } from "./helpers/admitted-producer.js";
import { createAdmittedWorkflowRun } from "../services/workflow/agent-run-create.js";
import { executeWorkflowRun } from "../services/workflow/dag-engine.js";
import { selectOfficialWorkProduct } from "../services/workflow/workproduct-selector.js";
import { workProductService } from "../services/work-products.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("second-revision-"); db = createDb(temp.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "second-revision-"))); }, 60000);
afterAll(async () => { await temp?.cleanup(); await rm(root, { recursive: true, force: true }); });
async function world(failed: boolean) {
  // Source snapshot carries previous-revision identities; current source coordinates are a1/b1, never a/b.
  const f = await seedWorld(db, root, mission => [
    { id: "a1", sourceStepId: "a", agentId: mission.ownerAgentId!, name: "Write", dependencies: [], graphWorkProductRequired: true },
    { id: "b1", sourceStepId: "b", agentId: mission.ownerAgentId!, name: "Transform", dependencies: ["a1"],
      toolArgs: { content: "{$steps.a1.workProductPath}" }, workProductSelectors: { a1: { type: "document", title: "content.json" } } },
  ]);
  const [issue] = await db.insert(issues).values({ companyId: f.companyId, missionId: f.sourceMission.id, title: "Transform", status: "done" }).returning();
  const [step] = await db.insert(workflowStepRuns).values({ workflowRunId: f.sourceRun.id, stepId: "b1", issueId: issue.id,
    status: "running", startedAt: new Date() }).returning();
  const heartbeatId = randomUUID();
  await db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, f.sourceRun.id));
  await admittedProducer(db, { companyId: f.companyId, agentId: f.agentId, issueId: issue.id, stepRunId: step.id, heartbeatId });
  const dir = path.join(root, "missions", f.sourceMission.id, "b1"); await mkdir(dir, { recursive: true });
  const file = path.join(dir, "content.json"), bytes = '{"transformed":true}'; await writeFile(file, bytes);
  const product = await workProductService(db).createForIssue(issue.id, f.companyId, { type: "document", title: "content.json",
    provider: "local_file", status: "active", createdByRunId: heartbeatId,
    metadata: { path: file, sha256: createHash("sha256").update(bytes).digest("hex") } });
  await db.update(workflowStepRuns).set({ status: failed ? "failed" : "completed", completedAt: new Date() }).where(eq(workflowStepRuns.id, step.id));
  if (failed) await db.update(heartbeatRuns).set({ status: "failed", errorCode: "adapter_timeout" }).where(eq(heartbeatRuns.id, heartbeatId));
  await db.update(workflowRuns).set({ status: failed ? "failed" : "completed" }).where(eq(workflowRuns.id, f.sourceRun.id));
  const targetSteps = [
    { id: "a2", sourceStepId: "a1", agentId: f.agentId, name: "Write again", dependencies: [], graphWorkProductRequired: true },
    { id: "b2", sourceStepId: "b1", agentId: f.agentId, name: "Transform again", dependencies: ["a2"],
      toolArgs: { content: "{$steps.a2.workProductPath}" }, workProductSelectors: { a2: { type: "document", title: "content.json" } } },
  ];
  await db.update(workflowDefinitions).set({ stepsJson: targetSteps }).where(eq(workflowDefinitions.id, f.definition.id));
  f.input.seedFromRun.stepIds = ["a2", "b2"];
  return { ...f, product, targetSteps };
}
it("second revision admits and revalidates both ancestor and dependent seed using immediate source IDs", async () => {
  const f = await world(false), target = await f.admit();
  await executeWorkflowRun(db, target.id);
  expect((await selectOfficialWorkProduct(db, { companyId: f.companyId, workflowRunId: target.id, stepId: "b2",
    selector: { type: "document", title: "content.json" } })).product.id).toBe(f.product!.id);
});
it("second revision still rejects an unchanged failed dependent configuration and permits a real change", async () => {
  const f = await world(true), input = { ...f.input, seedFromRun: undefined };
  await expect(createAdmittedWorkflowRun(db, input, board)).rejects.toThrow("mission_revision_repeat_failure");
  expect(await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, f.revision.id))).toEqual([]);
  await db.update(workflowDefinitions).set({ stepsJson: [f.targetSteps[0], { ...f.targetSteps[1], toolArgs: { changed: true } }] })
    .where(eq(workflowDefinitions.id, f.definition.id));
  expect((await createAdmittedWorkflowRun(db, input, board)).id).toBeTruthy();
});
