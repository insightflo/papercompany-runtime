import "./helpers/workflow-control-node-boundary.js";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, workflowStepRuns, workflowDefinitions, instanceSettings, toolDefinitions } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedWorld } from "./helpers/workflow-seed-world.js";
import { legacyHtmlManualContract, legacyHtmlManualPublicationContract } from "./helpers/legacy-html-manual.js";
import { freezeArtifactAttempt } from "../services/workflow/artifact-contract-runtime.js";
import { executeWorkflowRun } from "../services/workflow/dag-engine.js";
import { resolveWorkflowToolStepArgs } from "../services/workflow/tool-step-args.js";
import { prepareQaArtifactRequest } from "../services/workflow/qa-artifact-request.js";
import { verifyQaArtifact } from "../services/workflow/qa-artifact-receipt.js";
import { prepareQaConsumer } from "../services/workflow/qa-artifact-consumer.js";
import { writeArtifactFile } from "../services/workflow/artifact-writer.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("workflow-seed-qa-"); db = createDb(temp.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "workflow-seed-qa-"))); }, 60000);
afterAll(async () => { await temp?.cleanup(); execFileSync("chmod", ["-R", "u+w", root]); await rm(root, { recursive: true, force: true }); });
it("seed evidence makes successors ready with finalization enforcement on, without fabricating heartbeat ownership", async () => {
  await db.insert(instanceSettings).values({ singletonKey: "default", general: {}, experimental: { enableHeartbeatFinalizationV1: true } });
  const f = await seedWorld(db, root), target = await f.admit();
  await executeWorkflowRun(db, target.id);
  const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, target.id));
  expect(rows.find(s => s.stepId === "write")).toMatchObject({ status: "completed", dispatchOwnerHeartbeatRunId: null,
    dispatchOwnerWakeupRequestId: null, startedAt: null });
  expect(rows.find(s => s.stepId === "write")?.dispatchReadyAt).toBeInstanceOf(Date);
  expect(rows.find(s => s.stepId === "use")?.issueId).toBeTruthy();
});
it.each([false, true])("QA captures source-mission verified bytes into target request, retaining original producer (generic=%s)", async generic => {
  const f = await seedWorld(db, root);
  const contract = generic ? { ...legacyHtmlManualContract("check.mjs"), resultAdapter: "generic" as const,
    resultSchemaVersion: "workflow.qa-result.v1", resultFileName: "inspection.json",
    inputParams: { content: "document", assetsDir: "media", out: "result" }, inputEnvelopeVersion: "example.input.v1" }
    : legacyHtmlManualContract("check.mjs");
  const adapterConfig = { artifactContract: contract };
  await db.insert(toolDefinitions).values({ companyId: f.companyId, name: "inspection", adapterType: "builtin", adapterConfig });
  const mapped = { ...f.steps[0], id: "revision-write", sourceStepId: "write", name: "Revision writer" };
  f.input.seedFromRun.stepIds = [mapped.id];
  const qa = { ...f.steps[1], dependencies: [mapped.id], sourceStepId: "use",
    workProductSelectors: { [mapped.id]: { type: "document", title: "content.json" } },
    toolArtifactContract: { schemaVersion: contract.resultSchemaVersion, role: "qa", inputStepId: mapped.id },
    toolArgs: { [contract.inputParams.content!]: "{$steps.revision-write.workProductPath}",
      [contract.inputParams.assetsDir!]: "{$steps.revision-write.siblingAssetsDir}" } };
  await db.update(workflowDefinitions).set({ stepsJson: [mapped, qa] }).where(eq(workflowDefinitions.id, f.definition.id));
  const target = await f.admit();
  await executeWorkflowRun(db, target.id);
  const [use] = (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, target.id))).filter(s => s.stepId === "use");
  const requestId = randomUUID();
  await db.update(workflowStepRuns).set({ status: "running", lastDispatchRequestId: requestId,
    metadata: { ...use.metadata, artifactExecution: freezeArtifactAttempt({ adapterConfig,
      step: qa, executionGeneration: use.executionGeneration, requestId }) } }).where(eq(workflowStepRuns.id, use.id));
  await mkdir(path.join(root, "missions", f.revision.id), { recursive: true });
  const parameters = await resolveWorkflowToolStepArgs({ db, run: target, step: qa, workflowSteps: [mapped, qa], consumerStepRunId: use.id });
  const requestScope = { db, companyId: f.companyId, workflowRunId: target.id, stepRunId: use.id, stepId: "use", requestId };
  await expect(prepareQaArtifactRequest({ ...requestScope, parameters: { [contract.inputParams.content!]: f.file } }))
    .rejects.toThrow("qa_artifact_explicit_assets_required");
  const request = await prepareQaArtifactRequest({ ...requestScope, parameters });
  expect(request?.snapshot.input).toMatchObject({ workProductId: f.product.id, path: f.file,
    producer: { workflowRunId: f.sourceRun.id, stepRunId: f.sourceStep.id } });
  expect(request?.snapshot.outputRoot).toContain(f.revision.id);
  const snapshot = request!.snapshot;
  await writeArtifactFile(snapshot.root, contract.resultFileName, Buffer.from(JSON.stringify(generic ? {
    schemaVersion: "workflow.qa-result.v1", ok: true, checks: [{ id: "fixture", ok: true }],
    inputDigest: { sha256: snapshot.input.sha256, mode: "content" }, assetManifest: [],
  } : { schemaVersion: "manual-onboarding.qa.v1",
    command: "qa", mode: "content", section: null, ok: true, checks: [{ id: "fixture", ok: true }],
    checkedAt: new Date().toISOString(), artifactPath: path.join(snapshot.outputRoot, "qa-result.json"),
    contentSha256: snapshot.input.sha256, assetManifest: [] })));
  const { receipt } = await verifyQaArtifact(request!, { id: randomUUID(), name: "test-double" },
    [{ fileName: "test-double.mjs", sha256: "a".repeat(64), byteSize: 1 }]);
  await db.update(workflowStepRuns).set({ status: "completed", metadata: { artifactExecution: snapshot.artifactExecution, toolArtifactRequest: snapshot, toolArtifactReceipt: receipt } })
    .where(eq(workflowStepRuns.id, use.id));
  const [consumer] = await db.insert(workflowStepRuns).values({ workflowRunId: target.id, stepId: "publish", status: "running",
    lastDispatchRequestId: "publish-request", metadata: { artifactExecution: freezeArtifactAttempt({
      adapterConfig: { artifactContract: { ...legacyHtmlManualPublicationContract("publish.mjs"),
        consumerParams: { receipt: "evidence", content: "source" } } }, step: {}, executionGeneration: 0, requestId: "publish-request" }) } }).returning();
  const prepared = await prepareQaConsumer({ db, companyId: f.companyId, workflowRunId: target.id, stepRunId: consumer.id,
    stepId: "publish", requestId: "publish-request", parameters: { evidence: path.join(snapshot.outputRoot, contract.resultFileName), source: f.file } });
  expect(prepared.inputBytes).toBeDefined();
  expect(prepared.resultRoot?.path).toContain(f.revision.id);
});
