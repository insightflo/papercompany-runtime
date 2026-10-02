import { randomUUID } from "node:crypto";
import { writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { assertQaReceiptScope, readQaReceiptBytes } from "../services/workflow/qa-artifact-receipt.js";
import { prepareQaConsumer } from "../services/workflow/qa-artifact-consumer.js";
import { digest } from "../services/workflow/artifact-files.js";
import { resolveWorkflowToolStepArgs } from "../services/workflow/tool-step-args.js";
import { completeWorkflowToolStepFromResult } from "../services/workflow/dag-engine.js";
import { fixture, database } from './helpers/qa-receipt-fixture.js';
import { legacyHtmlManualPublicationContract } from './helpers/legacy-html-manual.js';
import { freezeArtifactAttempt } from '../services/workflow/artifact-contract-runtime.js';

it("legacy-html-manual runner verifies byte evidence and consumer scope, ignoring stdout", async () => {
  const db = database(), f = await fixture();
  const result = await f.invoke(); expect(result.status, JSON.stringify(result.body)).toBe(200);
  const receipt = result.toolArtifactReceipt!; expect(receipt.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(receipt.input.assetManifest).toHaveLength(1);
  const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.qaId));
  expect(receipt.outputRoot).toContain(`/attempts/2/${digest(f.requestId)}`);
  for (const patch of [{ executionGeneration: 5 }, { requestId: "other" }]) {
    expect(() => assertQaReceiptScope({ ...receipt, ...patch }, { run: { id: f.runId, companyId: f.companyId, missionId: f.missionId }, stepRun: step }, f.requestId)).toThrow();
  }
  const completion = { companyId: f.companyId, stepRunId: f.qaId, requestId: f.requestId, workflowRunId: f.runId, stepId: "qa", toolName: "local-qa", success: true };
  for (const bad of [undefined, { ...receipt, executionGeneration: 9 }, { ...receipt, sha256: "0".repeat(64) }]) {
    const before = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.qaId));
    await expect(completeWorkflowToolStepFromResult(db, { ...completion, toolArtifactReceipt: bad })).rejects.toThrow();
    expect(await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.qaId))).toEqual(before);
  }
  await completeWorkflowToolStepFromResult(db, { ...completion, toolArtifactReceipt: receipt, data: result.body.data });
  expect((await readQaReceiptBytes(db, { companyId: f.companyId, workflowRunId: f.runId, stepId: "qa" })).receipt).toEqual(receipt);
  const publishId = randomUUID();
  const publicationContract = { ...legacyHtmlManualPublicationContract('publish.mjs'),
    consumerParams: { receipt: 'evidence', content: 'source' }, inputEnvelopeVersion: 'example.publish-input.v2' };
  await db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, f.runId));
  await db.insert(workflowStepRuns).values({ id: publishId, workflowRunId: f.runId, stepId: "publish",
    status: "running", lastDispatchRequestId: "publish-1", metadata: { artifactExecution: freezeArtifactAttempt({
      adapterConfig: { artifactContract: publicationContract }, step: {},
      executionGeneration: 0, requestId: 'publish-1' }) } });
  const consumer = { db, companyId: f.companyId, workflowRunId: f.runId, stepRunId: publishId,
    stepId: 'publish', requestId: 'publish-1', parameters: { source: f.content,
      evidence: path.join(receipt.outputRoot, receipt.relativePath) } };
  const delivered = await prepareQaConsumer(consumer);
  expect(delivered.parameters).toMatchObject({ source: f.content });
  expect(JSON.parse(delivered.inputBytes!.toString()).schemaVersion).toBe("example.publish-input.v2");
  const nativeArgs = await resolveWorkflowToolStepArgs({ db, run: { id: f.runId, companyId: f.companyId },
    step: { id: "publish", dependencies: ["qa"], toolArgs: { qaResultPath: "{$steps.qa.workProductPath}" } },
    workflowSteps: [{ id: "qa" }, { id: "publish", dependencies: ["qa"] }] });
  expect(nativeArgs).toEqual({ qaResultPath: path.join(receipt.outputRoot, receipt.relativePath) });
  const before = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.qaId));
  await expect(prepareQaConsumer({ ...consumer, parameters: { ...consumer.parameters, source: '/foreign' } })).rejects.toThrow();
  expect(await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.qaId))).toEqual(before);
  await chmod(path.join(receipt.outputRoot, receipt.relativePath), 0o600);
  await writeFile(path.join(receipt.outputRoot, receipt.relativePath), "{}");
  await expect(prepareQaConsumer(consumer)).rejects.toThrow();
});

it('reads historical v1 durable requests and receipts using their declared schema, without live tool config', async () => {
  const f = await fixture(), db = database(), result = await f.invoke();
  expect(result.status).toBe(200);
  const { contractHash: _, qaConfigHash: __, runtimeChecks: ___, pluginChecks: ____, ...receipt } = result.toolArtifactReceipt as any;
  const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.qaId));
  const { artifactExecution: _____, ...request } = step.metadata.toolArtifactRequest as any;
  const legacy = { ...receipt, schemaVersion: 'workflow.tool-artifact.v1' };
  await db.update(workflowStepRuns).set({ status: 'completed', metadata: { toolArtifactRequest: request, toolArtifactReceipt: legacy } })
    .where(eq(workflowStepRuns.id, f.qaId));
  expect((await readQaReceiptBytes(db, { companyId: f.companyId, workflowRunId: f.runId, stepId: 'qa' })).receipt).toEqual(legacy);
});
