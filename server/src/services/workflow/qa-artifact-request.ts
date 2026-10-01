import path from "node:path";
import { readHtmlBundle } from "./qa-html-input.js";
import { encodeQaInput } from "./qa-byte-transport.js";
import { createArtifactDirectory } from "./artifact-writer.js";
import { captureQaDispatch } from "./qa-dispatch-guard.js";
import { and, eq, sql } from "drizzle-orm";
import { workflowRuns, workflowStepRuns, workflowStepOutputBindings, type Db } from "@paperclipai/db";
import { toolArtifactContractSchema, workProductSelectorsSchema } from "@paperclipai/shared/validators/workflow-artifact";
import { loadExecutionDefinition } from "./execution-definition.js";
import { selectOfficialWorkProduct } from "./workproduct-selector.js";
import { resolveMissionWorkProductPaths } from "../work-products/output-paths.js";
import { captureArtifactRoot, digest, readArtifactBytes, type ArtifactRoot } from "./artifact-files.js";
import { readObject } from "./core-tool-context.js";

export type QaRequest = Awaited<ReturnType<typeof prepareQaArtifactRequest>>;
export async function prepareQaArtifactRequest(input: { db: Db; companyId: string; workflowRunId?: string | null;
  stepRunId?: string | null; stepId?: string | null; requestId: string; parameters: unknown }) {
  if (!input.workflowRunId || !input.stepRunId) return null;
  const execution = await loadExecutionDefinition(input.db, input.workflowRunId, { requireHistorical: false });
  const definition = execution.steps.find(s => s.id === input.stepId) as Record<string, unknown> | undefined;
  if (!definition?.toolArtifactContract) return null;
  const dispatch = await captureQaDispatch(input);
  const contract = toolArtifactContractSchema.parse(definition.toolArtifactContract);
  const selectors = workProductSelectorsSchema.parse(definition.workProductSelectors);
  const selector = selectors[contract.inputStepId];
  if (!selector) throw new Error("qa_artifact_input_selector_required");
  const [row] = await input.db.select({ run: workflowRuns, step: workflowStepRuns }).from(workflowRuns)
    .innerJoin(workflowStepRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id)).where(and(
      eq(workflowRuns.id, input.workflowRunId), eq(workflowRuns.companyId, input.companyId), eq(workflowStepRuns.id, input.stepRunId)));
  if (!row?.run.missionId || row.run.status !== "running" || row.step.status !== "running"
    || row.step.stepId !== input.stepId || row.step.lastDispatchRequestId !== input.requestId) throw new Error("qa_artifact_request_stale");
  const [pin] = await input.db.select().from(workflowStepOutputBindings).where(and(
    eq(workflowStepOutputBindings.companyId, input.companyId), eq(workflowStepOutputBindings.workflowRunId, row.run.id),
    eq(workflowStepOutputBindings.consumerStepRunId, row.step.id), eq(workflowStepOutputBindings.referencedStepId, contract.inputStepId)));
  if (!pin) throw new Error("qa_artifact_input_pin_required");
  const selected = await selectOfficialWorkProduct(input.db, { companyId: input.companyId, workflowRunId: row.run.id,
    stepId: contract.inputStepId, selector, pinnedId: pin.workProductId });
  const paths = await resolveMissionWorkProductPaths(input.db, { companyId: input.companyId, missionId: row.run.missionId,
    workflowRunId: row.run.id, stepId: row.step.stepId });
  if (!paths?.stepOutputDir) throw new Error("qa_artifact_root_missing");
  const missionRoot = await captureArtifactRoot(paths.missionOutputDir);
  const parameters = readObject(input.parameters);
  const sourceArg = typeof parameters.content === "string" ? "content" : "html";
  if (typeof parameters.content === "string" && typeof parameters.html === "string") throw new Error("qa_artifact_input_ambiguous");
  if (parameters[sourceArg] !== selected.file) throw new Error("qa_artifact_input_mismatch");
  const inputPaths = await resolveMissionWorkProductPaths(input.db, { companyId: input.companyId, missionId: selected.producer.missionId });
  const inputRoot = selected.producer.workflowRunId === row.run.id ? missionRoot
    : await captureArtifactRoot(inputPaths?.missionOutputDir ?? "");
  const bytes = await readArtifactBytes(inputRoot, path.relative(inputRoot.path, selected.file), 8 * 1024 * 1024);
  if (selected.producer.workflowRunId !== row.run.id && digest(bytes) !== selected.product.metadata?.sha256) throw new Error("workflow_seed_sha_mismatch");
  const assetsRoot = sourceArg === "content" && typeof parameters.assetsDir === "string" ? parameters.assetsDir : "";
  if (sourceArg === "content" && !assetsRoot) throw new Error("qa_artifact_explicit_assets_required");
  const html = sourceArg === "html" ? await readHtmlBundle(inputRoot, selected.file, bytes, parameters.htmlManifest) : undefined;
  const assets = html?.assets ?? await readDraftAssets(inputRoot, bytes, assetsRoot, sourceArg === "content");
  const ancillary = html?.ancillary ?? [];
  // HTML metadata paths are never interpreted by the CLI; only this explicit manifest is authoritative.
  if (html && ["repoMeta", "shotResult", "empiricalResult"].some(k => parameters[k] !== undefined)) throw new Error("qa_artifact_html_use_manifest");
  const directories = new Set(["input/assets", "input/ancillary", "input"]);
  for (const a of assets) for (let d = path.posix.dirname(`input/assets/${a.fileName}`); d !== "."; d = path.posix.dirname(d)) directories.add(d);
  const rootPath = path.join(paths.stepOutputDir, "attempts", String(row.step.executionGeneration), digest(input.requestId));
  await dispatch.assertCurrent();
  const root = await createArtifactDirectory(missionRoot, path.relative(missionRoot.path, rootPath), [
    { relative: `input/${path.basename(selected.file)}`, bytes },
    ...assets.map(a => ({ relative: `input/assets/${a.fileName}`, bytes: a.bytes })),
    ...ancillary.map(a => ({ relative: `input/ancillary/${a.fileName}`, bytes: a.bytes })),
  ], [...directories].sort((a,b) => b.split("/").length - a.split("/").length));
  const inputFile = path.join(root.path, "input", path.basename(selected.file));
  await dispatch.assertCurrent();
  const snapshot = { companyId: input.companyId, missionId: row.run.missionId, workflowRunId: row.run.id,
    stepRunId: row.step.id, stepId: row.step.stepId, executionGeneration: row.step.executionGeneration,
    retryCount: row.step.retryCount, iterationIndex: row.step.iterationIndex, requestId: input.requestId,
    outputRoot: root.path, outputRootHash: digest(JSON.stringify(root)), root,
    input: { workProductId: selected.product.id, producer: selected.producer, path: selected.file, sha256: digest(bytes),
      byteSize: bytes.length, assetsRoot, assetManifest: assets.map(({ bytes: _, ...a }) => a),
      ...(html ? { mode: "html" as const, htmlManifest: html.manifest, ancillaryManifest: ancillary.map(({ bytes: _, ...a }) => a) } : {}) } };
  const updated = await input.db.update(workflowStepRuns).set({ metadata:
    sql`${workflowStepRuns.metadata} || ${JSON.stringify({ toolArtifactRequest: snapshot })}::jsonb` }).where(and(
      eq(workflowStepRuns.id, row.step.id), eq(workflowStepRuns.status, "running"),
      eq(workflowStepRuns.executionGeneration, row.step.executionGeneration), eq(workflowStepRuns.lastDispatchRequestId, input.requestId))).returning({ id: workflowStepRuns.id });
  if (updated.length !== 1) throw new Error("qa_artifact_request_stale");
  return { snapshot, dispatch, inputBytes: encodeQaInput(bytes, assets, null, html), parameters: { ...parameters, [sourceArg]: inputFile,
    ...(sourceArg === "content" ? { assetsDir: path.join(root.path, "input", "assets") } : {}), out: path.join(root.path, "qa-result.json") } };
}

async function readDraftAssets(root: ArtifactRoot, bytes: Buffer, assetsRoot: string, content: boolean) {
  if (!content) return [];
  const draft = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(draft.blocks)) throw new Error("qa_artifact_content_shape");
  const names = new Set<string>();
  for (const b of draft.blocks) if (b.type === "image") {
    if (typeof b.assetFile !== "string" || path.basename(b.assetFile) !== b.assetFile || [".", ".."].includes(b.assetFile)) throw new Error("qa_artifact_asset_name");
    names.add(b.assetFile);
  }
  const assets = [];
  for (const fileName of [...names].sort()) {
    const bytes = await readArtifactBytes(root, path.relative(root.path, path.join(assetsRoot, fileName)), 16 * 1024 * 1024);
    assets.push({ fileName, bytes, sha256: digest(bytes), byteSize: bytes.length });
  }
  return assets;
}
