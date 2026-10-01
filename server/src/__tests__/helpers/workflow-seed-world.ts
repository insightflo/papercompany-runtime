import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { agents, companies, issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { admittedProducer } from "./admitted-producer.js";
import { createWorkflowRun } from "../../services/workflow/workflow-store.js";
import { createAdmittedWorkflowRun } from "../../services/workflow/agent-run-create.js";
import { workProductService } from "../../services/work-products.js";

export const board = { type: "board" as const, userId: "local-board", source: "local_implicit" as const };
export async function seedWorld(db: Db, root: string) {
  const companyId = randomUUID(), agentId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Seed", issuePrefix: randomUUID(), workProductRoot: root });
  await db.insert(agents).values({ id: agentId, companyId, name: "Writer", role: "operator", adapterType: "process" });
  const [sourceMission] = await db.insert(missions).values({ companyId, ownerAgentId: agentId, title: "Source", status: "completed" }).returning();
  const steps = [{ id: "write", name: "Write", type: "agent", agentId, dependencies: [], graphWorkProductRequired: true },
    { id: "use", name: "Use", type: "agent", agentId, dependencies: ["write"],
      workProductSelectors: { write: { type: "document", title: "content.json" } }, toolArgs: { content: "{$steps.write.workProductPath}" } }];
  const [definition] = await db.insert(workflowDefinitions).values({ companyId, name: "Seed", stepsJson: steps }).returning();
  const sourceRun = await createWorkflowRun(db, { companyId, workflowId: definition.id, missionId: sourceMission.id, triggeredBy: "board" });
  await db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, sourceRun.id));
  const [issue] = await db.insert(issues).values({ companyId, missionId: sourceMission.id, title: "Write", status: "done" }).returning();
  const [sourceStep] = await db.insert(workflowStepRuns).values({ workflowRunId: sourceRun.id, stepId: "write", issueId: issue.id,
    status: "running", startedAt: new Date() }).returning();
  const heartbeatId = randomUUID();
  await admittedProducer(db, { companyId, agentId, issueId: issue.id, stepRunId: sourceStep.id, heartbeatId });
  const dir = path.join(root, "missions", sourceMission.id, "runs", sourceRun.id, "steps", "write");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "content.json"), bytes = '{"blocks":[]}';
  await writeFile(file, bytes);
  const product = await workProductService(db).createForIssue(issue.id, companyId, { provider: "local_file", type: "document",
    title: "content.json", status: "active", createdByRunId: heartbeatId,
    metadata: { path: file, sha256: createHash("sha256").update(bytes).digest("hex") } });
  await db.update(workflowStepRuns).set({ status: "completed", completedAt: new Date() }).where(eq(workflowStepRuns.id, sourceStep.id));
  await db.update(workflowRuns).set({ status: "failed" }).where(eq(workflowRuns.id, sourceRun.id));
  const [revision] = await db.insert(missions).values({ companyId, ownerAgentId: agentId, title: "Revision", status: "active",
    sourceMissionId: sourceMission.id, sourceWorkflowRunId: sourceRun.id }).returning();
  const input = { companyId, workflowId: definition.id, missionId: revision.id, triggeredBy: "board",
    seedFromRun: { sourceWorkflowRunId: sourceRun.id, stepIds: ["write"] } };
  const admit = () => createAdmittedWorkflowRun(db, input, board);
  return { companyId, agentId, sourceMission, sourceRun, sourceStep, revision, definition, input, admit, file, product: product!, steps };
}
