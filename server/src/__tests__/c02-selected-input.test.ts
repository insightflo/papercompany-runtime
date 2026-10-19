import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import {
  issueWorkProducts,
  workflowDefinitions,
  workflowRuns,
  workflowStepOutputBindings,
  workflowStepRuns,
} from "@paperclipai/db";
import { executeCoreWorkflowTool } from "../services/workflow/core-tool-executor.js";
import type { QaRequest } from "../services/workflow/qa-artifact-request.js";
import { resolveWorkflowToolStepArgs } from "../services/workflow/tool-step-args.js";
import { database, fixture } from "./helpers/qa-receipt-fixture.js";

// C02 stage6/C12 expectation sources: the adopted extraction map,
// workflow-tool-step-args (ancestor/assets and metadata), and workflow-qa-receipt.
// This observes ordinary selected-input capture, not corrected-B delivery/consumption.
it("renders selected input into the real QA request without restamping its producer", async () => {
  const db = database(), f = await fixture();
  const pinScope = and(
    eq(workflowStepOutputBindings.companyId, f.companyId),
    eq(workflowStepOutputBindings.workflowRunId, f.runId),
    eq(workflowStepOutputBindings.consumerStepRunId, f.qaId),
  );
  const readPins = () => db.select().from(workflowStepOutputBindings).where(pinScope);
  const initialPins = await readPins();
  // fixture:64-65 resolves once. Remove only that fixture-owned pin so this
  // invocation must perform real selection and a first pin, rather than reuse it.
  expect(initialPins).toHaveLength(1);
  expect(initialPins[0].referencedStepId).toBe("write");
  await db.delete(workflowStepOutputBindings).where(and(pinScope,
    eq(workflowStepOutputBindings.id, initialPins[0].id)));
  expect(await readPins()).toEqual([]);

  const products = await db.select().from(issueWorkProducts).where(and(
    eq(issueWorkProducts.companyId, f.companyId),
    eq(issueWorkProducts.type, "document"),
    eq(issueWorkProducts.title, "content.json"),
  ));
  expect(products).toHaveLength(1);
  const product = products[0];
  expect(product.metadata?.path).toBe(f.content);
  expect(initialPins[0].workProductId).toBe(product.id);
  const [producer] = await db.select().from(workflowStepRuns).where(and(
    eq(workflowStepRuns.workflowRunId, f.runId), eq(workflowStepRuns.stepId, "write"),
  ));
  expect(producer.executionGeneration).toBe(1);
  expect(product.issueId).toBe(producer.issueId);
  const registeredProducer = product.metadata?.workflowProducer;
  expect(registeredProducer).toMatchObject({
    companyId: f.companyId, missionId: f.missionId, workflowRunId: f.runId,
    stepRunId: producer.id, stepId: "write", executionGeneration: 1,
    retryCount: producer.retryCount, iterationIndex: producer.iterationIndex,
  });

  const [beforeRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, f.runId));
  await db.update(workflowRuns).set({ metadata: { ...beforeRun.metadata,
    section: "tech-blog", workflowChildInputs: { edition: "stage6" },
  } }).where(eq(workflowRuns.id, f.runId));
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, f.runId));
  const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, run.workflowId));
  const workflowSteps = definition.stepsJson as Parameters<typeof resolveWorkflowToolStepArgs>[0]["workflowSteps"];
  const qa = workflowSteps.find(step => step.id === "qa");
  if (!qa) throw new Error("QA fixture definition is missing its consumer");
  expect(qa.workProductSelectors).toEqual({ write: { type: "document", title: "content.json" } });
  const [beforeQa] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.qaId));
  expect(beforeQa.executionGeneration).toBe(2);
  expect(beforeQa.metadata.toolArtifactRequest).toBeUndefined();

  const parameters = await resolveWorkflowToolStepArgs({
    db, run, consumerStepRunId: f.qaId, workflowSteps,
    step: { ...qa, toolArgs: {
      content: "{$steps.write.workProductPath}",
      assetsDir: "{$steps.write.siblingAssetsDir}",
      section: "{$runMetadata.section}",
      edition: "{$childInputs.edition}",
    } },
  });
  // These literal expectations come from the fixture's paths and declared inputs,
  // not from rendering helpers or another selector invocation.
  expect(parameters).toEqual({
    content: f.content, assetsDir: f.assetsDir, section: "tech-blog", edition: "stage6",
  });
  const pins = await readPins();
  expect(pins).toHaveLength(1);
  expect(pins[0]).toMatchObject({
    companyId: f.companyId, workflowRunId: f.runId, consumerStepRunId: f.qaId,
    referencedStepId: "write", workProductId: product.id, sourceExecutionGeneration: 1,
  });
  expect(pins[0].id).not.toBe(initialPins[0].id);

  // Only the external QA producer is the fixture's deterministic machine double.
  // Pass the resolver's exact return value through the actual core executor.
  const result = await executeCoreWorkflowTool({
    db, companyId: f.companyId, toolName: "local-qa", workflowRunId: f.runId,
    stepRunId: f.qaId, stepId: "qa", requestId: f.requestId, parameters,
  });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  const [savedQa] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.qaId));
  expect(savedQa.metadata.toolArtifactRequest).toBeDefined();
  const request = savedQa.metadata.toolArtifactRequest as NonNullable<QaRequest>["snapshot"];
  const [contentBytes, assetBytes] = await Promise.all([
    readFile(f.content), readFile(path.join(f.assetsDir, "hero.png")),
  ]);
  const contentSha256 = createHash("sha256").update(contentBytes).digest("hex");
  const assetManifest = [{
    fileName: "hero.png",
    sha256: createHash("sha256").update(assetBytes).digest("hex"),
    byteSize: assetBytes.length,
  }];
  expect(request).toMatchObject({
    companyId: f.companyId, missionId: f.missionId, workflowRunId: f.runId,
    stepRunId: f.qaId, stepId: "qa", executionGeneration: 2, requestId: f.requestId,
  });
  expect(request.input).toEqual({
    workProductId: product.id, producer: registeredProducer, path: f.content,
    sha256: contentSha256, byteSize: contentBytes.length,
    assetsRoot: f.assetsDir, assetManifest,
  });
  expect(await readFile(path.join(request.outputRoot, "input", "content.json"))).toEqual(contentBytes);
  expect(await readFile(path.join(request.outputRoot, "input", "assets", "hero.png"))).toEqual(assetBytes);
  expect(result.toolArtifactReceipt?.input).toEqual(request.input);
  expect(await readPins()).toEqual(pins);
});
