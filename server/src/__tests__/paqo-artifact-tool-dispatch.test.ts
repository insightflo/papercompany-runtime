import "./helpers/workflow-control-node-boundary.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, missions, toolDefinitions, workflowDefinitions, workflowStepRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { artifactTools } from "./helpers/paqo-artifact-tool-fixture.js";
import { createWorkflowRun } from "../services/workflow/workflow-store.js";
import { executeWorkflowRun, setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";
import { loadArtifactAttempt } from "../services/workflow/artifact-contract-runtime.js";
import { captureQaDispatch } from "../services/workflow/qa-dispatch-guard.js";
import { assertNoHeartbeatWriters } from "./helpers/workflow-control-node-boundary.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
beforeAll(async () => {
  temp = await startEmbeddedPostgresTestDatabase("paqo-artifact-dispatch-");
  db = createDb(temp.connectionString);
  // The real engine writes the durable queue; the external runner is not started in this test.
  setWorkflowToolStepExecutor(async () => ({ accepted: true }));
}, 60_000);
afterAll(async () => {
  setWorkflowToolStepExecutor(null);
  await db?.$client.end();
  await temp?.cleanup();
});

it.each(artifactTools)("engine dispatches explicitly defined $name without an issue and binds the artifact attempt", async tool => {
  const [company] = await db.insert(companies).values({ name: "Dispatch", issuePrefix: randomUUID() }).returning();
  const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Owner", role: "operator", adapterType: "process" }).returning();
  const [mission] = await db.insert(missions).values({ companyId: company.id, ownerAgentId: agent.id, title: "Dispatch", status: "active" }).returning();
  await db.insert(toolDefinitions).values({ companyId: company.id, ...tool, adapterType: "builtin" });
  const steps = [{ id: 'selected', name: 'Explicit engine tool', type: 'tool', agentId: '', dependencies: [],
    toolNames: [tool.name], toolArgs: { id: 'fixture' }, graphWorkProductRequired: false }];
  const [definition] = await db.insert(workflowDefinitions).values({ companyId: company.id, missionId: mission.id,
    name: "PAQO artifact dispatch", sourceKind: "paqo", stepsJson: steps }).returning();
  const run = await createWorkflowRun(db, { companyId: company.id, workflowId: definition.id, missionId: mission.id, triggeredBy: "board" });
  await executeWorkflowRun(db, run.id);
  const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, run.id));
  const selected = rows.find(row => row.stepId === steps[0].id)!;
  expect(selected.issueId).toBeNull(); // Exercises dag-engine's private isIssueLessToolStep, not a copied predicate.
  expect(selected.status).toBe("running");
  expect(selected.lastDispatchRequestId).toEqual(expect.any(String));
  expect(selected.metadata).toMatchObject({ toolInvocation: { toolName: tool.name, requestId: selected.lastDispatchRequestId,
    args: { id: "fixture" } }, toolQueue: { status: "queued" }, artifactExecution: { requestId: selected.lastDispatchRequestId,
    executionGeneration: selected.executionGeneration, contract: tool.adapterConfig.artifactContract } });
  const scope = { db, companyId: company.id, workflowRunId: run.id, stepRunId: selected.id,
    stepId: selected.stepId, requestId: selected.lastDispatchRequestId! };
  expect(await loadArtifactAttempt({ ...scope, adapterConfig: tool.adapterConfig })).toMatchObject({ requestId: selected.lastDispatchRequestId });
  await (await captureQaDispatch(scope)).assertCurrent();
  await assertNoHeartbeatWriters(db);
});
