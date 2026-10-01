import "./helpers/workflow-control-node-boundary.js";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, heartbeatRuns, workflowStepRuns, issues, missionPlanArtifacts, missionPlanQaVerdicts, toolDefinitions, workflowDefinitions } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedWorld } from "./helpers/workflow-seed-world.js";
import { revisionStartOptions } from "../services/missions/revision-start-options.js";
import { revisionPlanDiagnostics } from "../services/missions/revision-plan-validation.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("revision-declarations-"); db = createDb(temp.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "revision-declarations-"))); }, 60000);
afterAll(async () => { await temp?.cleanup(); await rm(root, { recursive: true, force: true }); });
async function boardWait(f: Awaited<ReturnType<typeof seedWorld>>, steps: unknown[]) {
  const [definition] = await db.insert(workflowDefinitions).values({ companyId: f.companyId, missionId: f.revision.id,
    name: "Revision", sourceKind: "paqo", definitionHash: "a".repeat(64), stepsJson: steps }).returning();
  const hash = "b".repeat(64);
  const [qa] = await db.insert(issues).values({ companyId: f.companyId, missionId: f.revision.id, title: "Review", status: "done" }).returning();
  await db.insert(missionPlanArtifacts).values({ companyId: f.companyId, missionId: f.revision.id, ownerAgentId: f.agentId,
    revision: 1, missionGoal: "result", refs: { ownerPlanDecision: { decisionHash: hash }, planQa: { issueId: qa.id, decisionHash: hash },
      paqoWorkflow: { workflowDefinitionId: definition.id, decisionHash: hash } } });
  await db.insert(missionPlanQaVerdicts).values({ companyId: f.companyId, missionId: f.revision.id, planQaIssueId: qa.id,
    decisionHash: hash, verdict: "pass", reviewerUserId: "local-board" });
  return definition;
}
it.each(["agent", "action", "producer", "research", "tool", "qa", "oversight", "approval", "if", "complete"])(
  "seed admission and candidates respect explicit %s execution role", async type => {
    const f = await seedWorld(db, root, mission => [{ id: "write", name: "Writer", type, agentId: mission.ownerAgentId!, dependencies: [] }]);
    const steps = [{ id: "write", name: "Writer", type, agentId: f.agentId, dependencies: [] }];
    const definition = await boardWait(f, steps);
    const options = await revisionStartOptions(db, f.companyId, f.revision.id);
    const allowed = ["agent", "action", "producer", "research"].includes(type);
    expect(options?.candidates).toHaveLength(allowed ? 1 : 0);
    f.input.workflowId = definition.id;
    if (allowed) await expect(f.admit()).resolves.toHaveProperty("id");
    else await expect(f.admit()).rejects.toThrow("workflow_seed_unsupported_step");
  });
const artifactContract = { role: "publication", resultFileName: "result.json", resultSchemaVersion: "workflow.publication-result.v1",
  resultAdapter: "generic", inputParams: { content: "document" }, deploymentFiles: ["run.mjs"], inputEnvelopeVersion: "input.v1",
  publication: { identity: { param: "id" }, bindings: [{ resultPointer: "/date", parameter: "date" }],
    publishedAt: { resultPointer: "/publishedAt", dateParam: "date", suffix: "T00:00:00.000Z" } } };
it("revision candidates resolve current company declarations, not another company's same-name tool", async () => {
  const f = await seedWorld(db, root, mission => [{ id: "write", name: "Writer", agentId: mission.ownerAgentId!,
    dependencies: [], toolNames: ["neutral"] }]);
  const other = await seedWorld(db, root);
  await db.insert(toolDefinitions).values({ companyId: other.companyId, name: "neutral", adapterType: "builtin", adapterConfig: { artifactContract } });
  const steps = [{ id: "write", name: "Writer", agentId: f.agentId, dependencies: [], toolNames: ["neutral"] }];
  await boardWait(f, steps);
  expect((await revisionStartOptions(db, f.companyId, f.revision.id))?.candidates).toHaveLength(1);
  await db.insert(toolDefinitions).values({ companyId: f.companyId, name: "neutral", adapterType: "builtin", adapterConfig: { artifactContract } });
  expect((await revisionStartOptions(db, f.companyId, f.revision.id))?.candidates).toHaveLength(0);
});
it("revision diagnostics compare company-resolved current settings against frozen historical declarations", async () => {
  const f = await seedWorld(db, root, mission => [{ id: "write", name: "Writer", agentId: mission.ownerAgentId!,
    dependencies: [], graphWorkProductRequired: true, toolNames: ["neutral"] }]);
  await db.update(workflowStepRuns).set({ status: "failed" }).where(eq(workflowStepRuns.id, f.sourceStep.id));
  await db.update(heartbeatRuns).set({ status: "failed", errorCode: "adapter_timeout" })
    .where(eq(heartbeatRuns.workflowStepRunId, f.sourceStep.id));
  // The live declaration changes executable delivery policy, not the historical source snapshot.
  const steps = [{ ...f.steps[0], toolNames: ["neutral"] }];
  await db.insert(toolDefinitions).values({ companyId: f.companyId, name: "neutral", adapterType: "builtin", adapterConfig: { artifactContract } });
  const diagnostics = await revisionPlanDiagnostics(db, f.companyId, f.revision.id, [{ id: "write", sourceStepId: "write" }], () => steps);
  expect(diagnostics).toEqual([]);
});
