import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import { workflowStepOutputBindings } from "@paperclipai/db";
import { artifactRelativePathSchema, selectArtifactValues } from "@paperclipai/shared/validators/artifact-contract";
import { toolArtifactContractSchema, toolArtifactReceiptSchema, workProductSelectorsSchema } from "@paperclipai/shared/validators/workflow-artifact";
import { readFrozenArtifactAttempt } from "../artifact-contract-runtime.js";
import { readObject } from "../core-tool-context.js";
import { captureArtifactRoot, digest, readArtifactBytes, type ArtifactRoot } from "../artifact-files.js";
import { readHtmlBundle } from "../qa-html-input.js";
import { loadExecutionDefinition } from "../execution-definition.js";
import { buildMissionWorkProductPaths, resolveMissionWorkProductPaths } from "../../work-products/output-paths.js";
import { readQaCorrectionSources, readIssuedQaCorrectionHistory, qaCorrectionProductPointerSchema } from "./qa-correction-reader.js";
import { readQaCorrectionVerdict, requireQaCorrection, type QaCorrectionDb } from "./qa-correction-authority.js";
import { type QaCorrectionApplied, type QaCorrectionPreparation, type QaCorrectionSourceMeasured } from "./qa-correction-contract.js";

type FileFact = QaCorrectionSourceMeasured["sources"][number]["files"][number];
type FileBytes = FileFact & { bytes: Buffer; sourcePath: string; ancillaryRole?: string };
// root pins safe reads; relativePath is the revision layout, sourcePath the original location.
export type QaCorrectionSourceBytes = {
  productId: string; root: ArtifactRoot; mainRelativePath: string; assetsRoot: string | null; files: FileBytes[];
};
const inputSchema = toolArtifactReceiptSchema.options[0].shape.input;
const inside = (file: string, root: string) => {
  const relative = path.relative(root, file);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
};

type Revision = QaCorrectionApplied["revisions"][number];
type Producer = ReturnType<typeof inputSchema.parse>["producer"];
type History = Awaited<ReturnType<typeof readIssuedQaCorrectionHistory>>;

/** Follow verified issuance edges to the original record; never restamp a corrected product. */
async function originalWorkflowProducer(p: QaCorrectionPreparation,
  history: History, revision: Revision): Promise<Producer | null> {
  let issued = history.issued;
  const visited = new Set<string>();
  for (;;) {
    const ancestor = issued.preparation;
    requireQaCorrection(!visited.has(ancestor.correctionId)
      && ancestor.companyId === p.companyId && ancestor.missionId === p.missionId
      && ancestor.workflowRunId === p.workflowRunId && ancestor.producer.stepRunId === p.producer.stepRunId
      && ancestor.producer.stepId === p.producer.stepId && ancestor.producer.issueId === p.producer.issueId
      && Date.parse(issued.applied.appliedAt) <= Date.parse(p.preparedAt), "lineage");
    visited.add(ancestor.correctionId);
    const source = ancestor.sources.find(s => s.productId === revision.sourceProductId);
    const actual = issued.sources.find(s => s.product.id === revision.sourceProductId);
    requireQaCorrection(source && actual, "lineage");
    if (source.provenance.kind === "registered_legacy") return null;
    if (source.provenance.kind === "workflow_producer") return source.provenance.workflowProducer;
    const hint = qaCorrectionProductPointerSchema.parse(actual.product.metadata?.qaCorrection);
    requireQaCorrection(hint.appliedEventId === source.provenance.appliedEventId, "lineage");
    issued = await history.readAncestor(source.provenance.appliedEventId);
    const previous = issued.applied.revisions.find(r =>
      r.workProductId === source.productId && r.revisionId === hint.revisionId);
    requireQaCorrection(previous && path.resolve(previous.root, previous.mainRelativePath) === actual.file, "lineage");
    revision = previous;
  }
}

/** C03/C12 SELECT-only observation, collected again under the preparation locks before INSERT. */
export async function observeQaCorrectionSources(db: QaCorrectionDb, p: QaCorrectionPreparation) {
  const sources = await readQaCorrectionSources(db, p, true);
  const execution = await loadExecutionDefinition(db, p.workflowRunId, { requireHistorical: false });
  const paths = await resolveMissionWorkProductPaths(db, { companyId: p.companyId,
    missionId: p.missionId, workflowRunId: p.workflowRunId });
  const priors: { productId: string; revision: Revision; workflowProducer: Producer | null }[] = [];
  for (const s of sources) {
    const provenance = p.sources.find(x => x.productId === s.product.id)!.provenance;
    if (provenance.kind !== "prior_correction") continue;
    const pointer = qaCorrectionProductPointerSchema.parse(s.product.metadata?.qaCorrection);
    requireQaCorrection(pointer.appliedEventId === provenance.appliedEventId, "lineage");
    const history = await readIssuedQaCorrectionHistory(db, { companyId: p.companyId, workflowRunId: p.workflowRunId,
      appliedEventId: provenance.appliedEventId });
    const issued = history.issued;
    const revision = issued.applied.revisions.find(r => r.revisionId === pointer.revisionId && r.workProductId === s.product.id);
    requireQaCorrection(revision && issued.preparation.companyId === p.companyId
      && issued.preparation.missionId === p.missionId && issued.preparation.workflowRunId === p.workflowRunId
      && issued.preparation.producer.stepRunId === p.producer.stepRunId
      && issued.preparation.producer.stepId === p.producer.stepId && issued.preparation.producer.issueId === p.producer.issueId
      && Date.parse(issued.applied.appliedAt) <= Date.parse(p.preparedAt)
      && path.resolve(revision.root, revision.mainRelativePath) === s.file, "lineage");
    priors.push({ productId: s.product.id, revision,
      workflowProducer: await originalWorkflowProducer(p, history, revision) });
  }
  const declarations: {
    qa: Awaited<ReturnType<typeof readQaCorrectionVerdict>>["qa"];
    definition: Awaited<ReturnType<typeof loadExecutionDefinition>>["steps"][number];
    request: Record<string, unknown>; frozen: ReturnType<typeof readFrozenArtifactAttempt>;
    input: ReturnType<typeof inputSchema.parse>; pin: typeof workflowStepOutputBindings.$inferSelect;
  }[] = [];
  for (const v of p.authority.verdicts) {
    const { qa } = await readQaCorrectionVerdict(db, p, v, true);
    const definition = execution.steps.find(s => s.id === qa.stepId);
    requireQaCorrection(definition, "tool");
    const declaration = readObject(definition).toolArtifactContract;
    const declared = declaration !== undefined
      || Object.hasOwn(qa.metadata, "artifactExecution") || Object.hasOwn(qa.metadata, "toolArtifactRequest");
    if (!declared) continue;
    // A present but malformed/stale declaration must never become a legacy single-file input.
    const contract = toolArtifactContractSchema.parse(declaration);
    const frozen = readFrozenArtifactAttempt(qa.metadata.artifactExecution,
      { executionGeneration: qa.executionGeneration, requestId: qa.lastDispatchRequestId ?? "" });
    const request = readObject(qa.metadata.toolArtifactRequest), input = inputSchema.parse(request.input);
    requireQaCorrection(contract.role === "qa" && frozen.contract.role === "qa"
      && contract.schemaVersion === frozen.contract.resultSchemaVersion && contract.inputStepId === p.producer.stepId
      && request.companyId === p.companyId && request.missionId === p.missionId
      && request.workflowRunId === p.workflowRunId && request.stepRunId === qa.id && request.stepId === qa.stepId
      && request.executionGeneration === qa.executionGeneration && request.retryCount === qa.retryCount
      && request.iterationIndex === qa.iterationIndex && request.requestId === qa.lastDispatchRequestId
      && isDeepStrictEqual(readFrozenArtifactAttempt(request.artifactExecution,
        { executionGeneration: qa.executionGeneration, requestId: qa.lastDispatchRequestId ?? "" }), frozen), "tool");
    const source = sources.find(s => s.product.id === input.workProductId);
    requireQaCorrection(source && source.file === input.path && paths && inside(source.file, paths.missionOutputDir), "source");
    const producer = input.producer, prior = priors.find(s => s.productId === source.product.id);
    if (prior) {
      const selector = workProductSelectorsSchema.parse(readObject(definition).workProductSelectors)[contract.inputStepId];
      requireQaCorrection(selector && selector.type === source.product.type && selector.title === source.product.title, "source");
      requireQaCorrection(prior.workflowProducer && isDeepStrictEqual(producer, prior.workflowProducer), "source");
      const revision = prior.revision;
      // Undefined historical format is not inferred from mutable request metadata.
      requireQaCorrection(revision.bundleManifestRelativePath !== undefined && revision.assetsRelativeRoot !== undefined, "lineage");
      if (input.mode === "html") requireQaCorrection(input.assetsRoot === ""
        && typeof revision.bundleManifestRelativePath === "string" && typeof revision.assetsRelativeRoot === "string"
        && input.htmlManifest!.path === path.resolve(revision.root, revision.bundleManifestRelativePath)
        && path.resolve(revision.root, revision.assetsRelativeRoot) === path.join(path.dirname(source.file), "assets"), "source");
      else requireQaCorrection(revision.bundleManifestRelativePath === null && input.assetsRoot ===
        (revision.assetsRelativeRoot === null ? "" : path.resolve(revision.root, revision.assetsRelativeRoot)), "source");
    } else {
      requireQaCorrection(producer.companyId === p.companyId && producer.missionId === p.missionId
        && producer.workflowRunId === p.workflowRunId && producer.stepRunId === p.producer.stepRunId
        && producer.stepId === p.producer.stepId && producer.executionGeneration === p.producer.executionGeneration
        && producer.retryCount === p.producer.retryCount && producer.iterationIndex === p.producer.iterationIndex, "source");
      const provenance = p.sources.find(s => s.productId === source.product.id)!.provenance;
      requireQaCorrection(provenance.kind === "workflow_producer"
        && isDeepStrictEqual(producer, provenance.workflowProducer), "source");
    }
    const [pin] = await db.select().from(workflowStepOutputBindings).where(and(
      eq(workflowStepOutputBindings.companyId, p.companyId), eq(workflowStepOutputBindings.workflowRunId, p.workflowRunId),
      eq(workflowStepOutputBindings.consumerStepRunId, qa.id), eq(workflowStepOutputBindings.referencedStepId, p.producer.stepId)));
    requireQaCorrection(pin && pin.workProductId === source.product.id, "binding");
    const qaPaths = buildMissionWorkProductPaths({ workProductRoot: paths.workProductRoot,
      missionId: p.missionId, workflowRunId: p.workflowRunId, stepId: qa.stepId });
    const requestPath = path.join(qaPaths.stepOutputDir!, "attempts", String(qa.executionGeneration), digest(qa.lastDispatchRequestId!));
    const root = readObject(request.root);
    requireQaCorrection(typeof root.path === "string" && path.isAbsolute(root.path)
      && path.resolve(root.path) === root.path && (root.path === requestPath || path.dirname(root.path) === requestPath)
      && Number.isSafeInteger(root.dev) && Number.isSafeInteger(root.ino) && root.path === request.outputRoot
      && request.outputRootHash === digest(JSON.stringify({ path: root.path, dev: root.dev, ino: root.ino })), "tool");
    if (input.mode !== "html") requireQaCorrection(frozen.contract.inputParams.assetsDir !== undefined
      ? typeof input.assetsRoot === "string" && path.isAbsolute(input.assetsRoot)
        && path.resolve(input.assetsRoot) === input.assetsRoot && inside(input.assetsRoot, paths.missionOutputDir)
      : input.assetsRoot === "", "source");
    const previous = declarations.find(d => d.input.workProductId === input.workProductId);
    requireQaCorrection(!previous || isDeepStrictEqual(previous.input, input), "source");
    declarations.push({ qa, definition, request, frozen, input, pin });
  }
  return { sources, declarations, priors, paths, definitionHash: execution.definitionHash };
}
type Observation = Awaited<ReturnType<typeof observeQaCorrectionSources>>;

export function qaCorrectionSourceFacts(sources: readonly QaCorrectionSourceBytes[]) {
  return sources.map(s => ({ productId: s.productId,
    files: s.files.map(({ role, relativePath, sha256, byteSize }) => ({ role, relativePath, sha256, byteSize }))
      .sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0),
  })).sort((a, b) => a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0);
}

/** All filesystem work lives here, outside every preparation transaction. No directory discovery. */
export async function readQaCorrectionSourceBytes(p: QaCorrectionPreparation, observed: Observation): Promise<QaCorrectionSourceBytes[]> {
  const results: QaCorrectionSourceBytes[] = [];
  for (const source of observed.sources) {
    const provenance = p.sources.find(s => s.productId === source.product.id)!.provenance;
    const prior = observed.priors.find(s => s.productId === source.product.id)?.revision;
    const declarations = observed.declarations.filter(d => d.input.workProductId === source.product.id);
    const root = await captureArtifactRoot(prior?.root ?? (declarations.length
      ? observed.paths!.missionOutputDir : path.dirname(source.file)));
    const mainRelativePath = prior?.mainRelativePath ?? path.basename(source.file);
    const read = async (sourcePath: string, role: FileFact["role"], relativePath: string, cap: number): Promise<FileBytes> => {
      artifactRelativePathSchema.parse(relativePath);
      const bytes = await readArtifactBytes(root, path.relative(root.path, sourcePath), cap);
      return { role, relativePath, bytes, sourcePath, sha256: digest(bytes), byteSize: bytes.length };
    };
    const main = await read(source.file, "main", mainRelativePath, 8 * 1024 * 1024);
    if (provenance.kind === "workflow_producer" && provenance.workflowProducer.sha256 !== undefined) {
      requireQaCorrection(main.sha256 === provenance.workflowProducer.sha256
        && main.byteSize === provenance.workflowProducer.byteSize, "source");
    }
    let files = [main], assetsRoot: string | null = typeof prior?.assetsRelativeRoot === "string"
      ? path.resolve(prior.root, prior.assetsRelativeRoot) : null;
    if (prior) {
      for (const f of prior.files) if (f.role !== "main") files.push(await read(path.join(prior.root, f.relativePath),
        f.role, f.relativePath, f.role === "asset" ? 16 * 1024 * 1024 : 1024 * 1024));
      requireQaCorrection(files.length === prior.files.length && files.every(f => prior.files.some(old =>
        old.role === f.role && old.relativePath === f.relativePath && old.sha256 === f.sha256 && old.byteSize === f.byteSize)), "lineage");
    }
    let declaredFacts: ReturnType<typeof qaCorrectionSourceFacts> | undefined;
    for (const d of declarations) {
      const input = d.input, current = [main];
      requireQaCorrection(input.sha256 === main.sha256 && input.byteSize === main.byteSize, "source");
      if (input.mode === "html") {
        const html = await readHtmlBundle(root, source.file, main.bytes, input.htmlManifest!.path, d.frozen.contract.bundleManifest);
        const manifest = await read(html.manifest.path, "ancillary",
          prior ? path.relative(prior.root, html.manifest.path) : path.basename(html.manifest.path), 1024 * 1024);
        requireQaCorrection(manifest.sha256 === html.manifest.sha256 && manifest.byteSize === html.manifest.byteSize
          && isDeepStrictEqual(html.manifest, input.htmlManifest), "source");
        // readHtmlBundle checks this raw document but aliases ancillary fileName to role.
        const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifest.bytes)) as {
          ancillary: { role: string; fileName: string; sha256: string; byteSize: number }[];
        };
        const assets = html.assets.map(a => ({ fileName: a.fileName, sha256: a.sha256, byteSize: a.byteSize }));
        const ancillary = html.ancillary.map(a => ({ fileName: a.fileName, sha256: a.sha256, byteSize: a.byteSize }));
        requireQaCorrection(isDeepStrictEqual(assets, input.assetManifest)
          && isDeepStrictEqual(ancillary, input.ancillaryManifest), "source");
        for (const a of html.assets) current.push({ role: "asset", relativePath: prior
          ? path.posix.join(prior.assetsRelativeRoot!, a.fileName) : `assets/${a.fileName}`,
          sourcePath: path.join(path.dirname(source.file), "assets", a.fileName), bytes: a.bytes, sha256: a.sha256, byteSize: a.byteSize });
        for (const a of html.ancillary) {
          const original = raw.ancillary.find(entry => entry.role === a.fileName);
          requireQaCorrection(original && original.sha256 === a.sha256 && original.byteSize === a.byteSize, "source");
          artifactRelativePathSchema.parse(original.fileName);
          current.push({ role: "ancillary", ancillaryRole: original.role, relativePath: prior
            ? path.relative(prior.root, path.join(path.dirname(source.file), original.fileName)) : original.fileName,
            sourcePath: path.join(path.dirname(source.file), original.fileName),
            bytes: a.bytes, sha256: a.sha256, byteSize: a.byteSize });
        }
        current.push(manifest);
      } else {
        const names = new Set<string>(), pointers = d.frozen.contract.assetDiscovery ?? [];
        if (pointers.length) {
          const draft: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(main.bytes));
          for (const value of selectArtifactValues(draft, pointers).flatMap(v => Array.isArray(v) ? v : [v])) {
            names.add(artifactRelativePathSchema.parse(value));
          }
        }
        requireQaCorrection(!names.size || input.assetsRoot !== "", "source");
        if (!prior) assetsRoot = input.assetsRoot;
        const assets = [];
        for (const fileName of [...names].sort()) {
          const file = await read(path.join(input.assetsRoot, fileName), "asset",
            prior ? path.posix.join(prior.assetsRelativeRoot!, fileName) : `assets/${fileName}`, 16 * 1024 * 1024);
          current.push(file); assets.push({ fileName, sha256: file.sha256, byteSize: file.byteSize });
        }
        requireQaCorrection(isDeepStrictEqual(assets, input.assetManifest), "source");
      }
      const facts = qaCorrectionSourceFacts([{ productId: source.product.id, root, mainRelativePath, assetsRoot, files: current }]);
      requireQaCorrection(!declaredFacts || isDeepStrictEqual(declaredFacts, facts), "source");
      if (prior) requireQaCorrection(isDeepStrictEqual(facts, qaCorrectionSourceFacts([{
        productId: source.product.id, root, mainRelativePath, assetsRoot, files,
      }])), "lineage");
      declaredFacts = facts; files = current;
    }
    requireQaCorrection(new Set(files.map(f => f.relativePath)).size === files.length, "source");
    requireQaCorrection(isDeepStrictEqual(await captureArtifactRoot(root.path), root), "source");
    results.push({ productId: source.product.id, root, mainRelativePath, assetsRoot, files });
  }
  return results;
}
