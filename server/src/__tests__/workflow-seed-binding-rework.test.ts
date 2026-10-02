import "./helpers/workflow-control-node-boundary.js";
import { mkdtemp, realpath, rm, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, workflowDefinitions, workflowStepRuns, workflowRuns, workflowStepOutputBindings,
  workflowRunSeeds, toolDefinitions, issues, instanceSettings, activityLog } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedWorld } from "./helpers/workflow-seed-world.js";
import { legacyHtmlManualContract } from "./helpers/legacy-html-manual.js";
import { freezeArtifactAttempt } from "../services/workflow/artifact-contract-runtime.js";
import { admittedProducer } from "./helpers/admitted-producer.js";
import { ensureWorkflowStepRunRecords } from "../services/workflow/workflow-step-materialization.js";
import { resolveWorkflowToolStepArgs } from "../services/workflow/tool-step-args.js";
import { executeCoreWorkflowTool } from "../services/workflow/core-tool-executor.js";
import { completeWorkflowToolStepFromResult, syncWorkflowRunState } from "../services/workflow/dag-engine.js";
import { captureStructuralGateProducerToken } from "../services/workflow/control-flow/structural-semantic-readiness.js";
import { workProductService } from "../services/work-products.js";
import { atomicStructuralCompletion } from "../services/workflow/control-flow/structural-completion.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("seed-binding-rework-"); db = createDb(temp.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "seed-binding-rework-"))); }, 60000);
afterAll(async () => { await temp?.cleanup(); execFileSync("chmod", ["-R", "u+w", root]); await rm(root, { recursive: true, force: true }); });

it.each([false, true])("native QA rework reuses both rows and refreshes frozen input (finalization=%s)", async enabled => {
  await db.insert(instanceSettings).values({ singletonKey: "default", general: {}, experimental: { enableHeartbeatFinalizationV1: enabled } })
    .onConflictDoUpdate({ target: instanceSettings.singletonKey, set: { experimental: { enableHeartbeatFinalizationV1: enabled } } });
  const f = await seedWorld(db, root);
  const steps = [f.steps[0], { id: "check", name: "Check", type: "tool", agentId: "", qaType: "structural" as const,
    toolName: "local-qa", toolNames: ["local-qa"], dependencies: ["write"],
    workProductSelectors: { write: { type: "document", title: "content.json" } },
    toolArtifactContract: { schemaVersion: "manual-onboarding.qa.v1", role: "qa", inputStepId: "write" },
    toolArgs: { content: "{$steps.write.workProductPath}", assetsDir: "{$steps.write.siblingAssetsDir}" } }];
  await db.update(workflowDefinitions).set({ stepsJson: steps }).where(eq(workflowDefinitions.id, f.definition.id));
  const target = await f.admit();
  await db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, target.id));
  await ensureWorkflowStepRunRecords(db, { runId: target.id, steps, buildMetadata: () => ({}), syncControls: async (_db, rows) => rows });
  const rows = () => db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, target.id));
  const initial = await rows(), producer = initial.find(s => s.stepId === "write")!, check = initial.find(s => s.stepId === "check")!;
  const seedAudit = await db.select().from(workflowRunSeeds).where(eq(workflowRunSeeds.targetRunId, target.id));
  const script = path.join(root, `${randomUUID()}.mjs`);
  // External producer double only: real argument selection, fd4 runner, receipt and completion.
  await writeFile(script, `import{readFileSync,writeFileSync}from'node:fs';import{createHash}from'node:crypto';
const a=Object.fromEntries(process.argv.slice(3).reduce((r,v,i,all)=>i%2?r:[...r,[v.slice(2),all[i+1]]],[]));
const v=JSON.parse(readFileSync(0,'utf8'));const h=b=>createHash('sha256').update(b).digest('hex');
writeFileSync(4,JSON.stringify({schemaVersion:'manual-onboarding.qa.v1',command:'qa',mode:'content',section:null,ok:true,
checks:[{id:'fixture',ok:true}],checkedAt:new Date().toISOString(),artifactPath:a.out,
contentSha256:h(Buffer.from(v.content.base64,'base64')),assetManifest:[]}));`);
  const adapterConfig = { command: `${process.execPath} ${script} qa`, workingDirectory: root,
    capabilities: ["structural_validation_v1"], artifactContract: legacyHtmlManualContract(path.basename(script)) };
  await db.insert(toolDefinitions).values({ companyId: f.companyId, name: "local-qa", description: "fixture", adapterType: "builtin", adapterConfig });
  const dispatch = async (concurrent = false) => {
    const requestId = randomUUID();
    const token = await captureStructuralGateProducerToken({ db, workflowRunId: target.id, gate: steps[1], steps });
    const current = (await rows()).find(s => s.id === check.id)!;
    await db.update(workflowStepRuns).set({ status: "running", lastDispatchRequestId: requestId,
      metadata: { ...current.metadata, structuralGateProducerToken: token, artifactExecution: freezeArtifactAttempt({ adapterConfig,
        step: steps[1], executionGeneration: current.executionGeneration, requestId }) } }).where(eq(workflowStepRuns.id, check.id));
    const resolve = () => resolveWorkflowToolStepArgs({ db, run: target, step: steps[1], workflowSteps: steps, consumerStepRunId: check.id });
    const parameters = concurrent ? await Promise.all([resolve(), resolve()]).then(values => {
      expect(values[0]).toEqual(values[1]); return values[0];
    }) : await resolve();
    return { requestId, parameters };
  };
  const first = await dispatch();
  expect(first.parameters).toMatchObject({ content: f.file });
  const firstCheck = (await rows()).find(s => s.id === check.id)!;
  // The official structured rejection ledger, not a fabricated successful QA receipt.
  await atomicStructuralCompletion({ db, step: steps[1], success: true, data: { verdict: "request_changes" },
    companyId: f.companyId, workflowRunId: target.id, workflowStepRunId: check.id, requestId: first.requestId,
    observedStatus: firstCheck.status, observedIterationIndex: firstCheck.iterationIndex,
    observedRequestId: first.requestId, observedCompletedAt: firstCheck.completedAt,
    observedExecutionGeneration: firstCheck.executionGeneration, producerToken: firstCheck.metadata.structuralGateProducerToken as never,
    patch: { startedAt: new Date(), completedAt: new Date(), metadata: firstCheck.metadata, fallbackFailureSummary: null } });
  await syncWorkflowRunState(db, target.id);
  const afterReset = await rows(), resetProducer = afterReset.find(s => s.id === producer.id)!;
  expect(resetProducer.iterationIndex).toBe(1);
  expect(afterReset.find(s => s.id === check.id)?.status).toBe("pending");
  expect(afterReset.map(s => s.id).sort()).toEqual(initial.map(s => s.id).sort());
  // A reset is not a license to return the seed while replacement evidence is absent.
  await expect(resolveWorkflowToolStepArgs({ db, run: target, step: steps[1], workflowSteps: steps, consumerStepRunId: check.id })).rejects.toThrow();
  expect(resetProducer.issueId).toBeTruthy();
  const heartbeatId = randomUUID();
  await db.update(workflowStepRuns).set({ status: "running", startedAt: new Date() }).where(eq(workflowStepRuns.id, producer.id));
  await admittedProducer(db, { companyId: f.companyId, agentId: f.agentId, issueId: resetProducer.issueId, stepRunId: producer.id, heartbeatId });
  const dir = path.join(root, "missions", f.revision.id, "rework"); await mkdir(dir, { recursive: true });
  const file = path.join(dir, "content.json"), bytes = '{"blocks":["new attempt"]}'; await writeFile(file, bytes);
  const product = await workProductService(db).createForIssue(resetProducer.issueId!, f.companyId, { provider: "local_file", type: "document",
    title: "content.json", status: "active", createdByRunId: heartbeatId,
    metadata: { path: file, sha256: createHash("sha256").update(bytes).digest("hex") } });
  const completedAt = new Date();
  await db.update(issues).set({ status: "done", completedAt }).where(eq(issues.id, resetProducer.issueId!));
  await db.update(workflowStepRuns).set({ status: "completed", completedAt }).where(eq(workflowStepRuns.id, producer.id));
  const second = await dispatch(true);
  expect(second.parameters).toMatchObject({ content: file });
  const result = await executeCoreWorkflowTool({ db, companyId: f.companyId, toolName: "local-qa", workflowRunId: target.id,
    stepRunId: check.id, stepId: check.stepId, requestId: second.requestId, parameters: second.parameters });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(result.toolArtifactReceipt?.input).toMatchObject({ workProductId: product!.id,
    producer: { workflowRunId: target.id, stepRunId: producer.id, iterationIndex: 1 } });
  await completeWorkflowToolStepFromResult(db, { companyId: f.companyId, workflowRunId: target.id, stepRunId: check.id,
    stepId: check.stepId, requestId: second.requestId, toolName: "local-qa", success: true,
    data: result.body.data, toolArtifactReceipt: result.toolArtifactReceipt });
  const finalCheck = (await rows()).find(s => s.id === check.id)!;
  expect(finalCheck.status, JSON.stringify(finalCheck)).toBe("completed");
  const pins = await db.select().from(workflowStepOutputBindings).where(eq(workflowStepOutputBindings.consumerStepRunId, check.id));
  expect(pins).toHaveLength(1); expect(pins[0].workProductId).toBe(product!.id);
  const retired = await db.select().from(activityLog).where(eq(activityLog.entityId, check.id));
  expect(retired.filter(e => e.action === "workflow.output_binding_retired")).toHaveLength(1);
  expect(retired.find(e => e.action === "workflow.output_binding_retired")?.details).toMatchObject({
    binding: { workProductId: f.product.id, consumerStepRunId: check.id }, producerAttempt: { iterationIndex: 1 } });
  const replay = await Promise.all([1, 2].map(() => resolveWorkflowToolStepArgs({ db, run: target,
    step: steps[1], workflowSteps: steps, consumerStepRunId: check.id })));
  expect(replay).toEqual([second.parameters, second.parameters]);
  expect(await db.select().from(workflowStepOutputBindings).where(eq(workflowStepOutputBindings.consumerStepRunId, check.id))).toEqual(pins);
  expect(await db.select().from(workflowRunSeeds).where(eq(workflowRunSeeds.targetRunId, target.id))).toEqual(seedAudit);
});
