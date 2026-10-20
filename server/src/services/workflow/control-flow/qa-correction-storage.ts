import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { workflowTransitionEvents, type Db } from "@paperclipai/db";
import { captureArtifactRoot, readArtifactBytes, type ArtifactRoot } from "../artifact-files.js";
import { createArtifactDirectory } from "../artifact-writer.js";
import { QaCorrectionReadError, parseQaCorrectionPreparationRow, readQaCorrectionReservation,
  readQaCorrectionVerdict, requireQaCorrection, type QaCorrectionDb } from "./qa-correction-authority.js";
import { hashQaCorrectionPayload, parseQaCorrectionEventPayload, qaCorrectionSourceMeasuredKey,
  qaCorrectionSourceMeasuredSchema, type QaCorrectionApplied } from "./qa-correction-contract.js";
import { withCurrentQaCorrectionPreparation } from "./qa-correction-prepare.js";
import { observeQaCorrectionSources, readQaCorrectionSourceBytes, qaCorrectionSourceFacts,
  type QaCorrectionSourceBytes } from "./qa-correction-source-bytes.js";
import { patchQaCorrectionSources, type QaCorrectionProductLayout } from "./qa-correction-patch.js";
import type { MeasuredRef } from "./qa-correction-measure.js";

type StoredRevision = QaCorrectionApplied["revisions"][number] & {
  bundleManifestRelativePath: string | null; assetsRelativeRoot: string | null;
};
export type StoredCorrection = MeasuredRef & {
  status: "stored_uncommitted"; revisions: StoredRevision[];
  outputs: { sourceProductId: string; artifactRoot: ArtifactRoot; mainPath: string; assetsRoot: string | null }[];
};
export class QaCorrectionStorageError extends Error {
  constructor(readonly reason: "historical_format_unknown" | "historical_storage_layout_unproven") {
    super("qa_correction_" + reason);
  }
}
const uuid = z.string().uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/);
const refSchema = z.object({
  preparationEventId: uuid, preparationHash: hash, sourceMeasuredEventId: uuid,
  sourceMeasuredHash: hash, sourceMeasured: qaCorrectionSourceMeasuredSchema,
}).strict();

async function readRecords(db: QaCorrectionDb, ref: MeasuredRef) {
  const [prepared] = await db.select().from(workflowTransitionEvents)
    .where(eq(workflowTransitionEvents.id, ref.preparationEventId));
  requireQaCorrection(prepared, "record");
  const p = parseQaCorrectionPreparationRow(prepared);
  await readQaCorrectionReservation(db, p, {
    preparationEventId: ref.preparationEventId, preparationHash: ref.preparationHash,
  });
  const [row] = await db.select().from(workflowTransitionEvents)
    .where(eq(workflowTransitionEvents.id, ref.sourceMeasuredEventId));
  requireQaCorrection(row, "record");
  let m: MeasuredRef["sourceMeasured"];
  try { m = parseQaCorrectionEventPayload("qa_correction_source_measured", row.payload); }
  catch { throw new QaCorrectionReadError("record"); }
  requireQaCorrection(row.id !== p.correctionId && row.eventType === "qa_correction_source_measured"
    && row.layer === "workflow_validation" && row.idempotencyKey === qaCorrectionSourceMeasuredKey(p.correctionId)
    && row.companyId === p.companyId && row.missionId === p.missionId && row.workflowRunId === p.workflowRunId
    && row.workflowStepRunId === p.producer.stepRunId && row.issueId === p.producer.issueId
    && row.executionGeneration === p.producer.executionGeneration
    && m.preparationEventId === ref.preparationEventId && m.preparationHash === ref.preparationHash
    && hashQaCorrectionPayload(row.payload) === ref.sourceMeasuredHash
    && hashQaCorrectionPayload(ref.sourceMeasured) === ref.sourceMeasuredHash
    && isDeepStrictEqual(m, ref.sourceMeasured)
    && row.createdAt.getTime() === Date.parse(m.measuredAt) && Date.parse(m.measuredAt) >= Date.parse(p.preparedAt)
    && m.sources.length === p.sources.length
    && m.sources.every(s => p.sources.some(old => old.productId === s.productId)), "record");
  return p;
}
type Observation = Awaited<ReturnType<typeof observeQaCorrectionSources>>;
type PriorOrigin = { productId: string; correctionId: string; missionId: string; sourceProductId: string };
function layouts(sources: QaCorrectionSourceBytes[], observed: Observation): QaCorrectionProductLayout[] {
  return sources.map(source => {
    const prior = observed.priors.find(p => p.productId === source.productId)?.revision;
    if (prior) {
      if (prior.bundleManifestRelativePath === undefined || prior.assetsRelativeRoot === undefined) {
        throw new QaCorrectionStorageError("historical_format_unknown");
      }
      return { productId: source.productId, bundleManifestRelativePath: prior.bundleManifestRelativePath,
        assetsRelativeRoot: prior.assetsRelativeRoot };
    }
    const declarations = observed.declarations.filter(d => d.input.workProductId === source.productId);
    const values = declarations.map(d => {
      if (d.input.mode !== "html") return { productId: source.productId, bundleManifestRelativePath: null,
        assetsRelativeRoot: d.frozen.contract.inputParams.assetsDir === undefined ? null : "assets" };
      const file = source.files.find(f => f.sourcePath === d.input.htmlManifest!.path);
      requireQaCorrection(file?.role === "ancillary", "source");
      return { productId: source.productId, bundleManifestRelativePath: file.relativePath, assetsRelativeRoot: "assets" };
    });
    requireQaCorrection(values.every(v => isDeepStrictEqual(v, values[0])), "source");
    return values[0] ?? { productId: source.productId, bundleManifestRelativePath: null, assetsRelativeRoot: null };
  });
}
function priorBase(root: string, prior: PriorOrigin) {
  const parts = root.split(path.sep), offset = parts.length - 4;
  const [label, correctionId, candidateId, sourceProductId] = parts.slice(offset);
  if (offset < 1 || label !== "qa-corrections" || correctionId !== prior.correctionId
    || !uuid.safeParse(candidateId).success || sourceProductId !== prior.sourceProductId) {
    throw new QaCorrectionStorageError("historical_storage_layout_unproven");
  }
  const mission = parts[offset - 2] === "missions" && parts[offset - 1] === prior.missionId;
  const base = parts.slice(0, mission ? offset - 2 : offset).join(path.sep) || path.parse(root).root;
  const prefix = mission ? path.join("missions", prior.missionId) : "";
  if (!path.isAbsolute(base) || path.join(base, prefix, "qa-corrections", correctionId!, candidateId!, sourceProductId!) !== root) {
    throw new QaCorrectionStorageError("historical_storage_layout_unproven");
  }
  return { base, prefix };
}
function readonlyDirectories(files: { relativePath: string }[], assets: string | null) {
  const directories = new Set(["."]);
  const add = (directory: string) => {
    for (let current = directory; current !== "."; current = path.posix.dirname(current)) directories.add(current);
  };
  for (const file of files) add(path.posix.dirname(file.relativePath));
  if (assets !== null) add(assets);
  return [...directories];
}
function assertMeasured(sources: QaCorrectionSourceBytes[], ref: MeasuredRef) {
  const measured = ref.sourceMeasured.sources.map(s => ({ ...s,
    files: [...s.files].sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0),
  })).sort((a, b) => a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0);
  requireQaCorrection(isDeepStrictEqual(qaCorrectionSourceFacts(sources), measured), "source");
}

/** C03/C12 storage only. No registration, binding swap, receipt, use, followup or wake. */
export async function storeQaCorrection(db: Db, measured: MeasuredRef): Promise<StoredCorrection> {
  const parsed = refSchema.safeParse(measured);
  requireQaCorrection(parsed.success, "record");
  const ref = parsed.data, preparation = await readRecords(db, ref);
  const handle = { preparationEventId: ref.preparationEventId, preparationHash: ref.preparationHash, preparation };
  const current = async () => {
    const result = await withCurrentQaCorrectionPreparation(db, handle, async tx => {
      requireQaCorrection(isDeepStrictEqual(await readRecords(tx, ref), preparation), "record");
      const observation = await observeQaCorrectionSources(tx, preparation), remediations = [], priors: PriorOrigin[] = [];
      for (const verdict of preparation.authority.verdicts) {
        remediations.push((await readQaCorrectionVerdict(tx, preparation, verdict, true)).remediations);
      }
      for (const prior of observation.priors) {
        const provenance = preparation.sources.find(s => s.productId === prior.productId)!.provenance;
        requireQaCorrection(provenance.kind === "prior_correction", "lineage");
        priors.push({ productId: prior.productId, correctionId: prior.correctionId,
          missionId: prior.missionId, sourceProductId: prior.sourceProductId });
      }
      return { effect: "noop", value: { observation, remediations, priors } };
    });
    requireQaCorrection(result.status === "current", "stale");
    return result.value;
  };
  const first = await current();
  const original = await readQaCorrectionSourceBytes(preparation, first.observation);
  assertMeasured(original, ref);
  const productLayouts = layouts(original, first.observation);
  const patched = patchQaCorrectionSources(original, first.remediations, productLayouts);
  requireQaCorrection(isDeepStrictEqual(await current(), first), "stale");
  const candidate = randomUUID(), revisions: StoredRevision[] = [], outputs: StoredCorrection["outputs"] = [];
  const selectedRoot = first.observation.paths
    ? await captureArtifactRoot(first.observation.paths.workProductRoot) : null;
  for (const source of patched) {
    const sourceId = source.sourceProductId, input = original.find(s => s.productId === sourceId)!;
    const layout = productLayouts.find(l => l.productId === sourceId)!;
    // C02: preserve issued history; only fresh HTML may introduce observed role evidence.
    const priorRevision = first.observation.priors.find(p => p.productId === sourceId)?.revision;
    const ancillaryRoleBindings = priorRevision ? priorRevision.ancillaryRoleBindings
      : layout.bundleManifestRelativePath === null ? undefined
      : input.files.flatMap(f => f.ancillaryRole === undefined ? []
        : [{ role: f.ancillaryRole, relativePath: f.relativePath }]);
    const prior = first.priors.find(p => p.productId === sourceId);
    const origin = !selectedRoot && prior ? priorBase(input.root.path, prior) : null;
    const base = selectedRoot ?? (origin ? await captureArtifactRoot(origin.base) : input.root);
    const prefix = selectedRoot ? path.join("missions", preparation.missionId) : origin?.prefix ?? "";
    const relative = path.join(prefix, "qa-corrections", preparation.correctionId, candidate, sourceId);
    const artifactRoot = await createArtifactDirectory(base, relative,
      source.files.map(f => ({ relative: f.relativePath, bytes: f.bytes })),
      readonlyDirectories(source.files, layout.assetsRelativeRoot));
    requireQaCorrection(artifactRoot.path === path.join(base.path, relative)
      && isDeepStrictEqual(await captureArtifactRoot(artifactRoot.path), artifactRoot), "source");
    revisions.push({ revisionId: randomUUID(), workProductId: randomUUID(), sourceProductId: sourceId,
      root: artifactRoot.path, mainRelativePath: source.mainRelativePath,
      bundleManifestRelativePath: layout.bundleManifestRelativePath, assetsRelativeRoot: layout.assetsRelativeRoot,
      ...(ancillaryRoleBindings === undefined ? {} : { ancillaryRoleBindings: structuredClone(ancillaryRoleBindings) }),
      files: source.files.map(({ role, relativePath, beforeSha256, sha256, byteSize }) =>
        ({ role, relativePath, beforeSha256, sha256, byteSize })) });
    outputs.push({ sourceProductId: sourceId, artifactRoot,
      mainPath: path.join(artifactRoot.path, source.mainRelativePath),
      assetsRoot: layout.assetsRelativeRoot === null ? null : path.join(artifactRoot.path, layout.assetsRelativeRoot) });
  }
  for (const output of outputs) {
    const source = patched.find(s => s.sourceProductId === output.sourceProductId)!;
    for (const file of source.files) {
      const bytes = await readArtifactBytes(output.artifactRoot, file.relativePath, Math.max(1, file.bytes.length));
      requireQaCorrection(bytes.equals(file.bytes), "source");
    }
    requireQaCorrection(isDeepStrictEqual(await captureArtifactRoot(output.artifactRoot.path), output.artifactRoot), "source");
  }
  const after = await readQaCorrectionSourceBytes(preparation, first.observation);
  assertMeasured(after, ref);
  requireQaCorrection(isDeepStrictEqual(after, original), "source");
  requireQaCorrection(isDeepStrictEqual(await current(), first), "stale");
  return { ...ref, status: "stored_uncommitted", revisions, outputs };
}
