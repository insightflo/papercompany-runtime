import "./helpers/workflow-control-node-boundary.js";
import { mkdtemp, realpath, rm, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agentToolGrants, createDb, workflowDefinitions, workflowStepRuns, workflowRuns, toolDefinitions } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedWorld } from "./helpers/workflow-seed-world.js";
import { legacyHtmlManualContract, legacyHtmlManualPublicationContract } from "./helpers/legacy-html-manual.js";
import { freezeArtifactAttempt } from "../services/workflow/artifact-contract-runtime.js";
import { buildPaqoWorkflowSteps } from "../services/mission-owner-plan-decisions.js";
import { ensureWorkflowStepRunRecords } from "../services/workflow/workflow-step-materialization.js";
import { resolveWorkflowToolStepArgs } from "../services/workflow/tool-step-args.js";
import { executeCoreWorkflowTool } from "../services/workflow/core-tool-executor.js";
import { completeWorkflowToolStepFromResult, setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";
import { captureStructuralGateProducerToken } from "../services/workflow/control-flow/structural-semantic-readiness.js";
import { prepareQaConsumer } from "../services/workflow/qa-artifact-consumer.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("paqo-artifacts-"); db = createDb(temp.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "paqo-artifacts-")));
  // [Q7] toolNames 스텝은 executor 설정이 있어야 생성 시점 재검사를 통과한다(실제 실행은 executeCoreWorkflowTool 경로).
  setWorkflowToolStepExecutor(async () => ({ accepted: true })); }, 60000);
afterAll(async () => { setWorkflowToolStepExecutor(null); await temp?.cleanup(); execFileSync("chmod", ["-R", "u+w", root]); await rm(root, { recursive: true, force: true }); });
const draft = (units: Record<string, unknown>[]) => ({ missionGoal: "content", successCriteria: [],
  steps: units.map((u, i) => ({ unitId: u.id, dependencies: i ? [units[i - 1].id] : [] })), refs: { selectedExecutionUnits: units } });
const writer = { id: "write", title: "Write", graphWorkProductRequired: true };
const selector = { type: "document", title: "content.json" };
const qa = { id: "check", title: "Check", type: "tool", qaType: "structural", toolNames: ["local-qa"],
  toolArgs: { content: "{$steps.write.workProductPath}", assetsDir: "{$steps.write.siblingAssetsDir}" },
  workProductSelectors: { write: selector },
  toolArtifactContract: { schemaVersion: "manual-onboarding.qa.v1", role: "qa", inputStepId: "write" } };

it.each(["unit", "source", "reject"])("actual PAQO %s references survive seed → tool runner → receipt → consumer", async references => {
  const sourceDraft = draft([writer, qa, { id: "consume", title: "Consume" }]);
  const f = await seedWorld(db, root, mission => buildPaqoWorkflowSteps(sourceDraft as never, mission));
  const source = buildPaqoWorkflowSteps(sourceDraft as never, f.sourceMission);
  const ref = references === "source" ? source[0].id : "write";
  const units = [writer, { ...qa, workProductSelectors: { [ref]: selector },
    toolArtifactContract: { ...qa.toolArtifactContract, inputStepId: ref },
    toolArgs: { content: `{$steps.${ref}.workProductPath}`, assetsDir: `{$steps.${ref}.siblingAssetsDir}` } },
    { id: "consume", title: "Consume", toolArgs: { sourceContentPath: "{$steps.write.workProductPath}", qaResultPath: "{$steps.check.workProductPath}" },
      workProductSelectors: { write: selector } }].map((u, i) => ({ ...u, sourceStepId: source[i].id }));
  const steps = buildPaqoWorkflowSteps(draft(units) as never, f.revision);
  expect(steps[1].workProductSelectors).toEqual({ [steps[0].id]: selector });
  expect(steps[1].toolArtifactContract).toMatchObject({ inputStepId: steps[0].id });
  await db.update(workflowDefinitions).set({ stepsJson: steps }).where(eq(workflowDefinitions.id, f.definition.id));
  f.input.seedFromRun.stepIds = [steps[0].id];
  // [Q7] admission 이전 도구 등록·capability·구조게이트 담당(미션 owner) grant 를 갖춘다(생성 시점 재검사 기준).
  const script = path.join(root, `${randomUUID()}.mjs`);
  const adapterConfig = { command: `${process.execPath} ${script} qa`, workingDirectory: root,
    capabilities: ["structural_validation_v1"], artifactContract: legacyHtmlManualContract(path.basename(script)) };
  const [qaTool] = await db.insert(toolDefinitions).values({ companyId: f.companyId, name: "local-qa", description: "fixture", adapterType: "builtin",
    adapterConfig }).returning();
  await db.insert(agentToolGrants).values({ companyId: f.companyId, agentId: f.agentId, toolId: qaTool!.id, grantedBy: "local-board" });
  const target = await f.admit();
  await db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, target.id));
  await ensureWorkflowStepRunRecords(db, { runId: target.id, steps, buildMetadata: () => ({}), syncControls: async (_db, rows) => rows });
  const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, target.id));
  const check = rows.find(s => s.stepId === steps[1].id)!, consumer = rows.find(s => s.stepId === steps[2].id)!;
  const requestId = randomUUID();
  const producerToken = await captureStructuralGateProducerToken({ db, workflowRunId: target.id, gate: steps[1], steps });
  await db.update(workflowStepRuns).set({ status: "running", lastDispatchRequestId: requestId,
    metadata: { structuralGateProducerToken: producerToken, artifactExecution: freezeArtifactAttempt({ adapterConfig,
      step: steps[1], executionGeneration: check.executionGeneration, requestId }) } }).where(eq(workflowStepRuns.id, check.id));
  await mkdir(path.join(root, "missions", f.revision.id), { recursive: true });
  const parameters = await resolveWorkflowToolStepArgs({ db, run: target, step: steps[1], workflowSteps: steps, consumerStepRunId: check.id });
  // Local machine-contract producer test double; executes through the real tool runner/fd4 transport.
  await writeFile(script, `import{readFileSync,writeFileSync}from'node:fs';import{createHash}from'node:crypto';
const a=Object.fromEntries(process.argv.slice(3).reduce((r,v,i,all)=>i%2?r:[...r,[v.slice(2),all[i+1]]],[]));
const v=JSON.parse(readFileSync(0,'utf8'));const h=b=>createHash('sha256').update(b).digest('hex');
writeFileSync(4,JSON.stringify({schemaVersion:'manual-onboarding.qa.v1',command:'qa',mode:'content',section:null,ok:${references !== "reject"},
checks:[{id:'fixture',ok:true}],checkedAt:new Date().toISOString(),artifactPath:a.out,
contentSha256:h(Buffer.from(v.content.base64,'base64')),assetManifest:[]}));`);
  const result = await executeCoreWorkflowTool({ db, companyId: f.companyId, toolName: "local-qa", workflowRunId: target.id,
    stepRunId: check.id, stepId: check.stepId, requestId, parameters });
  if (references === "reject") {
    expect(result.status).toBe(500);
    expect(result.body.error).toBe("qa_artifact_verdict_failed");
    expect(result.toolArtifactReceipt).toBeUndefined();
    await expect(resolveWorkflowToolStepArgs({ db, run: target, step: steps[2], workflowSteps: steps, consumerStepRunId: consumer.id })).rejects.toThrow();
    return;
  }
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(result.toolArtifactReceipt?.input.producer.workflowRunId).toBe(f.sourceRun.id);
  expect(result.body.data).toMatchObject({ verdict: "pass" });
  await completeWorkflowToolStepFromResult(db, { companyId: f.companyId, workflowRunId: target.id, stepRunId: check.id,
    stepId: check.stepId, requestId, toolName: "local-qa", success: true, toolArtifactReceipt: result.toolArtifactReceipt, data: result.body.data });
  await db.update(workflowStepRuns).set({ status: "running", lastDispatchRequestId: "consume",
    metadata: { artifactExecution: freezeArtifactAttempt({ adapterConfig: { artifactContract: legacyHtmlManualPublicationContract("publish.mjs") },
      step: steps[2], executionGeneration: consumer.executionGeneration, requestId: "consume" }) } }).where(eq(workflowStepRuns.id, consumer.id));
  const consumerArgs = await resolveWorkflowToolStepArgs({ db, run: target, step: steps[2], workflowSteps: steps, consumerStepRunId: consumer.id });
  const prepared = await prepareQaConsumer({ db, companyId: f.companyId, workflowRunId: target.id,
    stepRunId: consumer.id, stepId: consumer.stepId, requestId: "consume", parameters: consumerArgs });
  expect(JSON.parse(prepared.inputBytes!.toString()).schemaVersion).toBe("manual-onboarding.input.v1");
});
it.each([{ workProductSelectors: { write: { type: "bogus", title: "x" } } },
  { toolArtifactContract: { schemaVersion: "", role: "qa", inputStepId: "write" } },
  { workProductSelectors: { missing: selector } }])("PAQO rejects invalid artifact contracts instead of dropping them: %j", async patch => {
  const f = await seedWorld(db, root);
  expect(() => buildPaqoWorkflowSteps(draft([writer, { ...qa, ...patch }]) as never, f.revision)).toThrow();
});
