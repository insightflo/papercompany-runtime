import path from "node:path";
import type { PublicationScope } from "./publication-result.js";
import { encodeQaInput } from "./qa-byte-transport.js";
import { randomUUID } from "node:crypto";
import { createArtifactDirectory } from "./artifact-writer.js";
import { captureQaDispatch, type QaDispatchScope } from "./qa-dispatch-guard.js";
import { and, eq } from "drizzle-orm";
import { workflowRuns, workflowStepRuns, workflowStepOutputBindings, type Db } from "@paperclipai/db";
import { toolArtifactReceiptSchema } from "@paperclipai/shared/validators/workflow-artifact";
import { captureArtifactRoot, digest, readArtifactBytes } from "./artifact-files.js";
import { readQaReceiptBytes } from "./qa-artifact-receipt.js";
import { readObject } from "./core-tool-context.js";
import { selectOfficialWorkProduct } from "./workproduct-selector.js";
import type { QaRequest } from "./qa-artifact-request.js";

/** Native template path comes only from a current validated durable receipt. */
export async function resolveQaReceiptPath(db: Db, scope: { companyId: string; workflowRunId: string; stepId: string }) {
  const { receipt } = await readQaReceiptBytes(db, scope);
  return path.join(receipt.outputRoot, receipt.relativePath);
}

/** External CLI consumes the verified byte bundle, never a copied absolute path. */
export async function prepareQaConsumer(input: QaDispatchScope & { parameters: unknown }) {
  const args = readObject(input.parameters);
  if (typeof args.qaResultPath !== "string") return { parameters: input.parameters, inputBytes: undefined, resultRoot: undefined };
  if (!input.workflowRunId) throw new Error("qa_artifact_request_stale");
  const dispatch = await captureQaDispatch(input);
  const rows = await input.db.select({ step: workflowStepRuns, run: workflowRuns }).from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId)).where(and(
      eq(workflowRuns.id, input.workflowRunId), eq(workflowRuns.companyId, input.companyId)));
  const matches = rows.filter(({ step }) => {
    const r = toolArtifactReceiptSchema.safeParse(step.metadata.toolArtifactReceipt);
    return r.success && path.join(r.data.outputRoot, r.data.relativePath) === args.qaResultPath;
  });
  if (matches.length !== 1) throw new Error("qa_artifact_consumer_receipt_required");
  const { step, run } = matches[0];
  const { receipt, bytes: qaBytes } = await readQaReceiptBytes(input.db, { companyId: input.companyId, workflowRunId: run.id, stepId: step.stepId });
  if (receipt.missionId !== run.missionId) throw new Error("qa_artifact_consumer_mission_mismatch");
  const bindings = await input.db.select().from(workflowStepOutputBindings).where(and(
    eq(workflowStepOutputBindings.consumerStepRunId, step.id),
    eq(workflowStepOutputBindings.workProductId, receipt.input.workProductId)));
  if (bindings.length !== 1) throw new Error("qa_artifact_consumer_binding_required");
  const producer = await selectOfficialWorkProduct(input.db, { companyId: input.companyId, workflowRunId: run.id,
    stepId: bindings[0].referencedStepId, selector: { type: "document", title: path.basename(receipt.input.path) }, pinnedId: receipt.input.workProductId });
  if (producer.file !== receipt.input.path) throw new Error("qa_artifact_consumer_producer_changed");
  const sourceKey = typeof args.sourceContentPath === "string" ? "sourceContentPath" : "sourceHtmlPath";
  if (args[sourceKey] !== receipt.input.path || (sourceKey === "sourceHtmlPath") !== (receipt.input.mode === "html")
    || (typeof args.sourceContentPath === "string" && typeof args.sourceHtmlPath === "string")) throw new Error("qa_artifact_consumer_input_mismatch");
  const request = step.metadata.toolArtifactRequest as NonNullable<QaRequest>["snapshot"];
  const root = await captureArtifactRoot(request.root.path);
  if (root.dev !== request.root.dev || root.ino !== request.root.ino) throw new Error("qa_artifact_root_replaced");
  const source = await readArtifactBytes(root, `input/${path.basename(receipt.input.path)}`, 8 * 1024 * 1024);
  if (digest(source) !== receipt.input.sha256 || source.length !== receipt.input.byteSize) throw new Error("qa_artifact_input_changed");
  const assets = [];
  for (const a of receipt.input.assetManifest) {
    const bytes = await readArtifactBytes(root, `input/assets/${a.fileName}`, 16 * 1024 * 1024);
    if (digest(bytes) !== a.sha256 || bytes.length !== a.byteSize) throw new Error("qa_artifact_asset_changed");
    assets.push({ ...a, bytes });
  }
  const ancillary = [];
  for (const a of receipt.input.ancillaryManifest ?? []) {
    const bytes = await readArtifactBytes(root, `input/ancillary/${a.fileName}`, 1024 * 1024);
    if (digest(bytes) !== a.sha256 || bytes.length !== a.byteSize) throw new Error("qa_artifact_ancillary_changed");
    ancillary.push({ ...a, bytes });
  }
  // All validation precedes creation and tool dispatch; no external writes on rejection.
  await dispatch.assertCurrent();
  const resultRoot = await createArtifactDirectory(root, `publication-${randomUUID()}`, [], []);
  const consumer = rows.find(({ step: s }) => s.id === input.stepRunId)?.step;
  if (!consumer || !input.stepId || !input.requestId || !run.missionId) throw new Error("qa_artifact_request_stale");
  const publicationScope: PublicationScope = { companyId: input.companyId, missionId: run.missionId,
    workflowRunId: run.id, stepRunId: consumer.id, stepId: input.stepId, requestId: input.requestId,
    executionGeneration: consumer.executionGeneration, retryCount: consumer.retryCount, iterationIndex: consumer.iterationIndex };
  return { parameters: args, inputBytes: encodeQaInput(source, assets, qaBytes, receipt.input.mode === "html" ? { ancillary } : undefined), resultRoot, publicationScope };
}
