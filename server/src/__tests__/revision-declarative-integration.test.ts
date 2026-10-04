import "./helpers/workflow-control-node-boundary.js";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, workflowStepRuns, issues, missionPlanArtifacts, missionPlanQaVerdicts, missions, toolDefinitions, workflowDefinitions, workflowRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { board, seedWorld } from "./helpers/workflow-seed-world.js";
import { createAdmittedWorkflowRun } from "../services/workflow/agent-run-create.js";
import { createWorkflowRun } from "../services/workflow/workflow-store.js";
import { revisionStartOptions } from "../services/missions/revision-start-options.js";
import { revisionPlanDiagnostics } from "../services/missions/revision-plan-validation.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("revision-declarations-"); db = createDb(temp.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "revision-declarations-"))); }, 60000);
afterAll(async () => { await temp?.cleanup(); await rm(root, { recursive: true, force: true }); });
async function boardWait(f: { companyId: string; agentId: string; revision: { id: string } }, steps: unknown[]) {
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
// [수정 변경맹 — Q3/Q4/Q5 native tool 시작 후보] 원본 실행이 완료 기록으로 남긴 native tool 스텝의
// 내구 toolResult 산출물(seed spine 이 지원)을 운영자 시작 선택 후보에 노출한다. 후보는 회사가
// 해당 도구를 현재 선언한 경우에만 나타나고(실행 가능 단위), 선언이 없으면 제외된다(Q4/Q5 게이트
// 유지 — agent 후보의 기존 검사는 그대로다).
async function nativeToolWorld(declareTool: boolean) {
  const companyId = randomUUID(), agentId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Native", issuePrefix: randomUUID(), workProductRoot: root });
  await db.insert(agents).values({ id: agentId, companyId, name: "Owner", role: "operator", adapterType: "process" });
  if (declareTool) await db.insert(toolDefinitions).values({ companyId, name: "collect-x", description: "Declared collect",
    adapterType: "builtin", adapterConfig: { command: "true" } });
  const [sourceMission] = await db.insert(missions).values({ companyId, ownerAgentId: agentId, title: "Source", status: "completed" }).returning();
  const sourceSteps = [{ id: "collect", name: "Collect", type: "tool", agentId: "", toolNames: ["collect-x"], dependencies: [] }];
  const [sourceDefinition] = await db.insert(workflowDefinitions).values({ companyId, name: "Native", stepsJson: sourceSteps }).returning();
  const sourceRun = await createWorkflowRun(db, { companyId, workflowId: sourceDefinition.id, missionId: sourceMission.id, triggeredBy: "board" as const });
  await db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, sourceRun.id));
  const requestId = randomUUID();
  const [step] = await db.insert(workflowStepRuns).values({ workflowRunId: sourceRun.id, stepId: "collect",
    issueId: null, status: "running", startedAt: new Date(), lastDispatchRequestId: requestId }).returning();
  const dir = path.join(root, "missions", sourceMission.id, "runs", sourceRun.id, "steps", "collect");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "result.json"), bytes = Buffer.from('{"collected":true}');
  await writeFile(file, bytes);
  await db.update(workflowStepRuns).set({ status: "completed", completedAt: new Date(),
    metadata: { toolResult: { requestId, toolName: "collect-x", success: true, artifactPath: file,
      artifactSha256: createHash("sha256").update(bytes).digest("hex"), stdout: null, stderr: null,
      exitCode: 0, error: null, completedAt: new Date().toISOString() } } }).where(eq(workflowStepRuns.id, step.id));
  await db.update(workflowRuns).set({ status: "failed" }).where(eq(workflowRuns.id, sourceRun.id));
  const [revision] = await db.insert(missions).values({ companyId, ownerAgentId: agentId, title: "Revision", status: "active",
    sourceMissionId: sourceMission.id, sourceWorkflowRunId: sourceRun.id }).returning();
  const steps = [{ id: "collect2", sourceStepId: "collect", name: "Collect", type: "tool", agentId: "",
    toolNames: ["collect-x"], dependencies: [] }];
  const definition = await boardWait({ companyId, agentId, revision }, steps);
  return { companyId, sourceRun, revision,
    admit: () => createAdmittedWorkflowRun(db, { companyId, workflowId: definition.id, missionId: revision.id,
      triggeredBy: "board" as const, seedFromRun: { sourceWorkflowRunId: sourceRun.id, stepIds: ["collect2"] } }, board) };
}
it("native tool seed candidates appear with current company tool declarations and admit through the seed spine", async () => {
  const f = await nativeToolWorld(true);
  expect(await revisionStartOptions(db, f.companyId, f.revision.id)).toMatchObject({ sourceWorkflowRunId: f.sourceRun.id,
    candidates: [{ stepId: "collect2", sourceStepId: "collect", name: "Collect", dependencies: [] }] });
  await expect(f.admit()).resolves.toHaveProperty("id"); // GET 후보 = 실제 승인 경로로 물화 가능
});
it("native tool candidates stay excluded while the company lacks the declared tool", async () => {
  const f = await nativeToolWorld(false);
  expect((await revisionStartOptions(db, f.companyId, f.revision.id))?.candidates).toEqual([]);
});
