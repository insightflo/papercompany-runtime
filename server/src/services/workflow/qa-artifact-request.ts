import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { selectArtifactValues, artifactRelativePathSchema } from "@paperclipai/shared/validators/artifact-contract";
import { loadArtifactAttempt, readFrozenArtifactAttempt, type FrozenArtifactAttempt } from "./artifact-contract-runtime.js";
import { readHtmlBundle } from "./qa-html-input.js";
import { encodeQaInput } from "./qa-byte-transport.js";
import { createArtifactDirectory } from "./artifact-writer.js";
import { captureQaDispatch } from "./qa-dispatch-guard.js";
import { and, eq, sql } from "drizzle-orm";
import { missions, issueWorkProducts, workflowRuns, workflowStepRuns, workflowStepOutputBindings, type Db } from "@paperclipai/db";
import { toolArtifactContractSchema, workProductSelectorsSchema } from "@paperclipai/shared/validators/workflow-artifact";
import { loadExecutionDefinition } from "./execution-definition.js";
import { selectOfficialWorkProduct } from "./workproduct-selector.js";
import { lockProducerSelection } from "../work-products/producer-selection-lock.js";
import { resolveMissionWorkProductPaths } from "../work-products/output-paths.js";
import { captureArtifactRoot, digest, readArtifactBytes, type ArtifactRoot } from "./artifact-files.js";
import { readObject } from "./core-tool-context.js";
import { resolveQaInternalPathRoots } from "./qa-internal-paths.js";
import { assertQaCorrectionRequestFiles, assertQaCorrectionSelectionUnchanged,
  lockQaCorrectionSelections, readSelectedQaCorrections } from "./control-flow/qa-correction-selection.js";
import { observeQaCorrectionFollowup, readCurrentQaCorrectionFollowup } from "./control-flow/qa-correction-followup.js";
import { readIssuedQaCorrection } from "./control-flow/qa-correction-reader.js";

export type QaRequest = Awaited<ReturnType<typeof prepareQaArtifactRequest>>;
export async function prepareQaArtifactRequest(input: { db: Db; companyId: string; workflowRunId?: string | null;
  stepRunId?: string | null; stepId?: string | null; requestId: string; parameters: unknown; artifactExecution?: FrozenArtifactAttempt | null;
  dispatch?: Awaited<ReturnType<typeof captureQaDispatch>> }) {
  const frozen = input.artifactExecution === undefined ? await loadArtifactAttempt(input) : input.artifactExecution;
  if (!frozen || frozen.contract.role !== "qa") return null;
  if (!input.workflowRunId || !input.stepRunId) throw new Error("artifact_contract_workflow_required");
  const artifact = frozen.contract;
  const execution = await loadExecutionDefinition(input.db, input.workflowRunId, { requireHistorical: false });
  const definition = execution.steps.find(s => s.id === input.stepId) as Record<string, unknown> | undefined;
  if (!definition?.toolArtifactContract) throw new Error("qa_artifact_input_contract_required");
  const dispatch = input.dispatch ?? await captureQaDispatch(input);
  const contract = toolArtifactContractSchema.parse(definition.toolArtifactContract);
  const selectors = workProductSelectorsSchema.parse(definition.workProductSelectors);
  const selector = selectors[contract.inputStepId];
  if (!selector) throw new Error("qa_artifact_input_selector_required");
  const [row] = await input.db.select({ run: workflowRuns, step: workflowStepRuns }).from(workflowRuns)
    .innerJoin(workflowStepRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id)).where(and(
      eq(workflowRuns.id, input.workflowRunId), eq(workflowRuns.companyId, input.companyId), eq(workflowStepRuns.id, input.stepRunId)));
  if (!row?.run.missionId || row.run.status !== "running" || row.step.status !== "running"
    || row.step.stepId !== input.stepId || row.step.lastDispatchRequestId !== input.requestId) throw new Error("qa_artifact_request_stale");
  if (!isDeepStrictEqual(readFrozenArtifactAttempt(row.step.metadata.artifactExecution,
    { executionGeneration: row.step.executionGeneration, requestId: input.requestId }), frozen)) throw new Error("artifact_contract_snapshot_stale");
  const [producer] = await input.db.select().from(workflowStepRuns).where(and(
    eq(workflowStepRuns.workflowRunId, row.run.id), eq(workflowStepRuns.stepId, contract.inputStepId)));
  if (!producer) throw new Error("qa_artifact_request_stale");
  const [pin] = await input.db.select().from(workflowStepOutputBindings).where(and(
    eq(workflowStepOutputBindings.companyId, input.companyId), eq(workflowStepOutputBindings.workflowRunId, row.run.id),
    eq(workflowStepOutputBindings.consumerStepRunId, row.step.id), eq(workflowStepOutputBindings.referencedStepId, contract.inputStepId)));
  if (!pin) throw new Error("qa_artifact_input_pin_required");
  const selectionScope = { companyId: input.companyId, workflowRunId: row.run.id,
    consumerStepRunId: row.step.id, selectors: { [contract.inputStepId]: selector } };
  // Classify independently of the pin: an old A pin cannot hide an active correction.
  const corrections = await readSelectedQaCorrections(input.db, selectionScope);
  const correction = corrections.find(c => c.stepId === contract.inputStepId);
  const selected = await selectOfficialWorkProduct(input.db, { companyId: input.companyId, workflowRunId: row.run.id,
    stepId: contract.inputStepId, selector, pinnedId: pin.workProductId });
  const selectedCorrection = "correction" in selected ? selected.correction : undefined;
  if (!isDeepStrictEqual(correction?.selected.correction, selectedCorrection)
    || (correction && (!isDeepStrictEqual(correction.selected.product, selected.product)
      || !isDeepStrictEqual(correction.selected.producer, selected.producer)
      || correction.selected.file !== selected.file))) throw new Error("qa_artifact_request_stale");
  // The observer rejects PgTransaction; B preparation requires the actual root connection.
  const observation = correction ? await observeQaCorrectionFollowup(input.db,
    correction.consumer.candidate.ref, readIssuedQaCorrection) : undefined;
  const paths = await resolveMissionWorkProductPaths(input.db, { companyId: input.companyId, missionId: row.run.missionId,
    workflowRunId: row.run.id, stepId: row.step.stepId });
  if (!paths?.stepOutputDir) throw new Error("qa_artifact_root_missing");
  const missionRoot = await captureArtifactRoot(paths.missionOutputDir);
  const parameters = readObject(input.parameters);
  const names = artifact.inputParams;
  const hasContent = !!names.content && typeof parameters[names.content] === "string";
  const hasHtml = !!names.html && typeof parameters[names.html] === "string";
  if (hasContent === hasHtml) throw new Error("qa_artifact_input_ambiguous");
  const mode = hasContent ? "content" : "html", sourceArg = (hasContent ? names.content : names.html)!;
  if (parameters[sourceArg] !== selected.file) throw new Error("qa_artifact_input_mismatch");
  const inputPaths = await resolveMissionWorkProductPaths(input.db, { companyId: input.companyId, missionId: selected.producer.missionId });
  const inputRoot = selected.producer.workflowRunId === row.run.id ? missionRoot
    : await captureArtifactRoot(inputPaths?.missionOutputDir ?? "");
  const bytes = await readArtifactBytes(inputRoot, path.relative(inputRoot.path, selected.file), 8 * 1024 * 1024);
  if (selected.producer.workflowRunId !== row.run.id && digest(bytes) !== selected.product.metadata?.sha256) throw new Error("workflow_seed_sha_mismatch");
  const assetsRoot = mode === "content" && names.assetsDir && typeof parameters[names.assetsDir] === "string" ? parameters[names.assetsDir] as string : "";
  if (mode === "content" && names.assetsDir && !assetsRoot) throw new Error("qa_artifact_explicit_assets_required");
  const html = mode === "html" ? await readHtmlBundle(inputRoot, selected.file, bytes,
    names.manifest ? parameters[names.manifest] : undefined, artifact.bundleManifest) : undefined;
  const assets = html?.assets ?? await readDraftAssets(inputRoot, bytes, assetsRoot, artifact.assetDiscovery ?? []);
  const ancillary = html?.ancillary ?? [];
  const manifestBytes = correction && html ? await readArtifactBytes(inputRoot,
    path.relative(inputRoot.path, html.manifest.path), 1024 * 1024) : undefined;
  if (correction) assertQaCorrectionRequestFiles(correction.selected.correction, selected.file,
    bytes, assetsRoot, assets, html, manifestBytes);
  const directories = new Set(["input/assets", "input/ancillary", "input"]);
  for (const a of assets) for (let d = path.posix.dirname(`input/assets/${a.fileName}`); d !== "."; d = path.posix.dirname(d)) directories.add(d);
  const requestPath = path.join(paths.stepOutputDir, "attempts", String(row.step.executionGeneration), digest(input.requestId));
  const rootPath = path.join(requestPath, randomUUID());
  await dispatch.assertCurrent();
  // An abandoned candidate is never reused or removed by a later preparation.
  const root = await createArtifactDirectory(missionRoot, path.relative(missionRoot.path, rootPath), [
    { relative: `input/${path.basename(selected.file)}`, bytes },
    ...assets.map(a => ({ relative: `input/assets/${a.fileName}`, bytes: a.bytes })),
    ...ancillary.map(a => ({ relative: `input/ancillary/${a.fileName}`, bytes: a.bytes })),
    ...(html && manifestBytes ? [{ relative: `input/${path.basename(html.manifest.path)}`, bytes: manifestBytes }] : []),
  ], [...directories].sort((a,b) => b.split("/").length - a.split("/").length));
  await dispatch.assertCurrent();
  const snapshot = { artifactExecution: frozen, companyId: input.companyId, missionId: row.run.missionId, workflowRunId: row.run.id,
    stepRunId: row.step.id, stepId: row.step.stepId, executionGeneration: row.step.executionGeneration,
    retryCount: row.step.retryCount, iterationIndex: row.step.iterationIndex, requestId: input.requestId,
    outputRoot: root.path, outputRootHash: digest(JSON.stringify(root)), root,
    ...(correction ? { qaCorrectionFollowup: correction.consumer.candidate.ref } : {}),
    internalPathRoots: await resolveQaInternalPathRoots([paths.workProductRoot, paths.missionOutputDir,
      paths.runOutputDir, paths.stepOutputDir, root.path, inputRoot.path]),
    input: { workProductId: selected.product.id, producer: selected.producer, path: selected.file, sha256: digest(bytes),
      byteSize: bytes.length, assetsRoot, assetManifest: assets.map(({ bytes: _, ...a }) => a),
      ...(html ? { mode: "html" as const, htmlManifest: html.manifest, ancillaryManifest: ancillary.map(({ bytes: _, ...a }) => a) } : {}) } };
  const identity = (value: typeof snapshot) => {
    const { root: _, outputRoot: __, outputRootHash: ___, internalPathRoots: ____, ...scope } = value;
    return scope;
  };
  // No filesystem work occurs while holding mission -> run -> sorted step locks.
  const chosen = await input.db.transaction(async tx => {
    const locked = correction ? await lockQaCorrectionSelections(tx, selectionScope, corrections)
      : await lockProducerSelection(tx, { companyId: input.companyId, workflowRunId: row.run.id,
        stepIds: [contract.inputStepId], stepRunIds: [row.step.id] }, "update");
    const currentCorrections = await readSelectedQaCorrections(tx, selectionScope);
    assertQaCorrectionSelectionUnchanged(corrections, currentCorrections);
    if (correction && observation) await readCurrentQaCorrectionFollowup(tx,
      correction.consumer.candidate.ref, observation, readIssuedQaCorrection);
    const run = locked.run, step = locked.steps.find(s => s.id === row.step.id);
    const [mission] = await tx.select().from(missions).where(and(
      eq(missions.id, row.run.missionId!), eq(missions.companyId, input.companyId)));
    if (!mission || !["planning", "active"].includes(mission.status) || !run || run.status !== "running"
      || run.missionId !== row.run.missionId || run.workflowId !== row.run.workflowId || !step || step.status !== "running"
      || step.stepId !== row.step.stepId || step.lastDispatchRequestId !== input.requestId
      || step.executionGeneration !== row.step.executionGeneration || step.retryCount !== row.step.retryCount
      || step.iterationIndex !== row.step.iterationIndex
      || !isDeepStrictEqual(locked.steps.find(s => s.id === producer.id), producer)) throw new Error("qa_artifact_request_stale");
    if (!isDeepStrictEqual(readFrozenArtifactAttempt(step.metadata.artifactExecution,
      { executionGeneration: step.executionGeneration, requestId: input.requestId }), frozen)) throw new Error("artifact_contract_snapshot_stale");
    const currentDefinition = await loadExecutionDefinition(tx, run.id, { requireHistorical: false });
    if (currentDefinition.definitionHash !== execution.definitionHash) throw new Error("qa_artifact_request_stale");
    const [product] = await tx.select().from(issueWorkProducts).where(and(
      eq(issueWorkProducts.companyId, input.companyId), eq(issueWorkProducts.id, selected.product.id))).for("share");
    const [currentPin] = await tx.select().from(workflowStepOutputBindings).where(and(
      eq(workflowStepOutputBindings.companyId, input.companyId), eq(workflowStepOutputBindings.workflowRunId, run.id),
      eq(workflowStepOutputBindings.consumerStepRunId, step.id),
      eq(workflowStepOutputBindings.referencedStepId, contract.inputStepId))).for("share");
    const currentPaths = await resolveMissionWorkProductPaths(tx, { companyId: input.companyId,
      missionId: run.missionId, workflowRunId: run.id, stepId: step.stepId });
    if (!isDeepStrictEqual(product, selected.product) || !isDeepStrictEqual(currentPin, pin)
      || !isDeepStrictEqual(currentPaths, paths)) throw new Error("qa_artifact_request_stale");
    const current = step.metadata.toolArtifactRequest, observed = row.step.metadata.toolArtifactRequest;
    if (readObject(current).requestId === input.requestId) {
      const saved = current as typeof snapshot;
      if (!isDeepStrictEqual(identity(saved), identity(snapshot))) throw new Error("qa_artifact_request_conflict");
      return saved;
    }
    if (!isDeepStrictEqual(current, observed)) throw new Error("qa_artifact_request_stale");
    const updated = await tx.update(workflowStepRuns).set({ metadata:
      sql`${workflowStepRuns.metadata} || ${JSON.stringify({ toolArtifactRequest: snapshot })}::jsonb` }).where(and(
        eq(workflowStepRuns.id, step.id), eq(workflowStepRuns.status, "running"),
        eq(workflowStepRuns.executionGeneration, row.step.executionGeneration),
        eq(workflowStepRuns.retryCount, row.step.retryCount), eq(workflowStepRuns.iterationIndex, row.step.iterationIndex),
        eq(workflowStepRuns.lastDispatchRequestId, input.requestId),
        sql`(${workflowStepRuns.metadata} -> 'toolArtifactRequest') IS NOT DISTINCT FROM ${observed === undefined ? null : JSON.stringify(observed)}::jsonb`,
      )).returning({ id: workflowStepRuns.id });
    if (updated.length !== 1) throw new Error("qa_artifact_request_stale");
    return snapshot;
  });
  if (!chosen.root || typeof chosen.outputRoot !== "string" || chosen.root.path !== chosen.outputRoot
    || (chosen.outputRoot !== requestPath && path.dirname(chosen.outputRoot) !== requestPath)
    || chosen.outputRootHash !== digest(JSON.stringify({ path: chosen.root.path, dev: chosen.root.dev, ino: chosen.root.ino }))
    || !isDeepStrictEqual(await captureArtifactRoot(chosen.outputRoot), chosen.root)) throw new Error("qa_artifact_root_changed");
  const requiredRoots = [paths.workProductRoot, paths.missionOutputDir, paths.runOutputDir, paths.stepOutputDir,
    chosen.root.path, inputRoot.path].filter((p): p is string => !!p).map(p => path.resolve(p));
  if (!Array.isArray(chosen.internalPathRoots) || !chosen.internalPathRoots.every(p => typeof p === "string" && path.isAbsolute(p))
    || requiredRoots.some(p => !chosen.internalPathRoots.includes(p))) throw new Error("qa_artifact_request_conflict");
  const readCaptured = async (relative: string, expected: Buffer, cap: number) => {
    const captured = await readArtifactBytes(chosen.root, relative, cap);
    if (!captured.equals(expected)) throw new Error("qa_artifact_input_changed");
    return captured;
  };
  const capturedBytes = await readCaptured(`input/${path.basename(chosen.input.path)}`, bytes, 8 * 1024 * 1024);
  const capturedAssets = [], capturedAncillary = [];
  for (const a of assets) capturedAssets.push({ ...a, bytes: await readCaptured(`input/assets/${a.fileName}`, a.bytes, 16 * 1024 * 1024) });
  for (const a of ancillary) capturedAncillary.push({ ...a, bytes: await readCaptured(`input/ancillary/${a.fileName}`, a.bytes, 16 * 1024 * 1024) });
  const capturedHtml = html ? { ...html, assets: capturedAssets, ancillary: capturedAncillary } : undefined;
  if (html && manifestBytes) await readCaptured(`input/${path.basename(html.manifest.path)}`, manifestBytes, 1024 * 1024);
  await dispatch.assertCurrent();
  const inputFile = path.join(chosen.outputRoot, "input", path.basename(chosen.input.path));
  return { snapshot: chosen, dispatch,
    inputBytes: encodeQaInput(capturedBytes, capturedAssets, null, capturedHtml, artifact.inputEnvelopeVersion),
    parameters: { ...parameters, [sourceArg]: inputFile,
      ...(html && manifestBytes && names.manifest
        ? { [names.manifest]: path.join(chosen.outputRoot, "input", path.basename(html.manifest.path)) } : {}),
      ...(mode === "content" && names.assetsDir ? { [names.assetsDir]: path.join(chosen.outputRoot, "input", "assets") } : {}),
      ...(names.out ? { [names.out]: path.join(chosen.outputRoot, artifact.resultFileName) } : {}) } };
}

async function readDraftAssets(root: ArtifactRoot, bytes: Buffer, assetsRoot: string, pointers: string[]) {
  if (!pointers.length) return [];
  const draft = JSON.parse(bytes.toString("utf8"));
  const names = new Set<string>();
  for (const value of selectArtifactValues(draft, pointers).flatMap(v => Array.isArray(v) ? v : [v])) {
    if (!artifactRelativePathSchema.safeParse(value).success) throw new Error("qa_artifact_asset_name");
    names.add(value as string);
  }
  if (names.size && !assetsRoot) throw new Error("qa_artifact_explicit_assets_required");
  const assets = [];
  for (const fileName of [...names].sort()) {
    const bytes = await readArtifactBytes(root, path.relative(root.path, path.join(assetsRoot, fileName)), 16 * 1024 * 1024);
    assets.push({ fileName, bytes, sha256: digest(bytes), byteSize: bytes.length });
  }
  return assets;
}
