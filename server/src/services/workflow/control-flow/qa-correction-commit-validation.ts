import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { and, eq, is } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { qualityActions, type Db } from "@paperclipai/db";
import { z } from "zod";
import { captureArtifactRoot, readArtifactBytes } from "../artifact-files.js";
import { readQaCorrectionVerdict, requireQaCorrection, type QaCorrectionDb } from "./qa-correction-authority.js";
import { hashQaCorrectionPayload, qaCorrectionAppliedSchema, qaCorrectionSourceMeasuredSchema,
  type QaCorrectionPreparation } from "./qa-correction-contract.js";
import { readMeasuredQaCorrection, type MeasuredRef } from "./qa-correction-measure.js";
import { withCurrentQaCorrectionPreparation, type BeginQaCorrectionResult } from "./qa-correction-prepare.js";
import { readIssuedQaCorrection } from "./qa-correction-reader.js";
import { observeQaCorrectionSources, readQaCorrectionSourceBytes, qaCorrectionSourceFacts,
  type QaCorrectionSourceBytes } from "./qa-correction-source-bytes.js";
import { patchQaCorrectionSources, type QaCorrectionProductLayout } from "./qa-correction-patch.js";
import { QaCorrectionStorageError, type StoredCorrection } from "./qa-correction-storage.js";

const uuid = z.string().uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/);
const storedSchema = z.object({
  preparationEventId: uuid, preparationHash: hash, sourceMeasuredEventId: uuid,
  sourceMeasuredHash: hash, sourceMeasured: qaCorrectionSourceMeasuredSchema,
  status: z.literal("stored_uncommitted"), revisions: qaCorrectionAppliedSchema.innerType().shape.revisions,
  outputs: z.array(z.object({
    sourceProductId: uuid, artifactRoot: z.object({ path: z.string().min(1),
      dev: z.number().int().safe().nonnegative(), ino: z.number().int().safe().nonnegative() }).strict(),
    mainPath: z.string().min(1), assetsRoot: z.string().min(1).nullable(),
  }).strict()).min(1),
}).strict();
const canonicalPath = (value: string) => path.isAbsolute(value) && path.resolve(value) === value;
const unique = (values: string[]) => new Set(values).size === values.length;
type Observation = Awaited<ReturnType<typeof observeQaCorrectionSources>>;
type PriorOrigin = { productId: string; correctionId: string; missionId: string; sourceProductId: string };

/** Copy raw JSON before awaiting. A StoredCorrection is a candidate, never an issuance receipt. */
function candidate(value: StoredCorrection): StoredCorrection {
  hashQaCorrectionPayload(value);
  const raw = JSON.parse(JSON.stringify(value)) as StoredCorrection;
  requireQaCorrection(hashQaCorrectionPayload(raw.sourceMeasured) === raw.sourceMeasuredHash, "record");
  const parsed = storedSchema.safeParse(raw);
  requireQaCorrection(parsed.success, "record");
  const s = parsed.data, ids = s.sourceMeasured.sources.map(source => source.productId);
  requireQaCorrection(s.sourceMeasured.preparationEventId === s.preparationEventId
    && s.sourceMeasured.preparationHash === s.preparationHash
    && s.revisions.length === ids.length && s.outputs.length === ids.length
    && unique(s.revisions.map(r => r.sourceProductId)) && unique(s.revisions.map(r => r.revisionId))
    && unique(s.revisions.map(r => r.workProductId)) && unique(s.revisions.map(r => r.root))
    && unique(s.outputs.map(o => o.sourceProductId)) && unique(s.outputs.map(o => o.artifactRoot.path)), "record");
  for (const r of s.revisions) {
    requireQaCorrection((r.bundleManifestRelativePath === null || typeof r.bundleManifestRelativePath === "string")
      && (r.assetsRelativeRoot === null || typeof r.assetsRelativeRoot === "string")
      && ids.includes(r.sourceProductId) && !ids.includes(r.workProductId) && canonicalPath(r.root), "source");
    const before = s.sourceMeasured.sources.find(source => source.productId === r.sourceProductId)!;
    requireQaCorrection(r.files.length === before.files.length && r.files.every(file => before.files.some(old =>
      old.role === file.role && old.relativePath === file.relativePath && old.sha256 === file.beforeSha256)), "source");
    const o = s.outputs.find(output => output.sourceProductId === r.sourceProductId);
    requireQaCorrection(o && o.artifactRoot.path === r.root
      && o.mainPath === path.join(r.root, r.mainRelativePath)
      && o.assetsRoot === (r.assetsRelativeRoot === null ? null : path.join(r.root, r.assetsRelativeRoot!)), "source");
  }
  return s as StoredCorrection;
}
function reference(s: StoredCorrection): MeasuredRef {
  return { preparationEventId: s.preparationEventId, preparationHash: s.preparationHash,
    sourceMeasuredEventId: s.sourceMeasuredEventId, sourceMeasuredHash: s.sourceMeasuredHash,
    sourceMeasured: s.sourceMeasured };
}

/** DB-only snapshot; caller owns the preparation locks. Official order is verdicts, then items. */
async function currentFacts(db: QaCorrectionDb, p: QaCorrectionPreparation, ref: MeasuredRef) {
  requireQaCorrection(isDeepStrictEqual((await readMeasuredQaCorrection(db, ref)).preparation, p), "record");
  const observation = await observeQaCorrectionSources(db, p);
  const remediations: Awaited<ReturnType<typeof readQaCorrectionVerdict>>["remediations"][] = [];
  for (const verdict of p.authority.verdicts) remediations.push((await readQaCorrectionVerdict(db, p, verdict, true)).remediations);
  const priors: PriorOrigin[] = [];
  for (const prior of observation.priors) {
    const provenance = p.sources.find(source => source.productId === prior.productId)!.provenance;
    requireQaCorrection(provenance.kind === "prior_correction", "lineage");
    const issued = await readIssuedQaCorrection(db, { companyId: p.companyId,
      workflowRunId: p.workflowRunId, appliedEventId: provenance.appliedEventId });
    requireQaCorrection(issued.applied.revisions.some(r => isDeepStrictEqual(r, prior.revision)), "lineage");
    priors.push({ productId: prior.productId, correctionId: issued.preparation.correctionId,
      missionId: issued.preparation.missionId, sourceProductId: prior.revision.sourceProductId });
  }
  let retryEnvelope: unknown = null;
  if (p.authority.kind === "quality_current_output") {
    const [action] = await db.select().from(qualityActions).where(and(
      eq(qualityActions.companyId, p.companyId), eq(qualityActions.id, p.authority.actionId)));
    requireQaCorrection(action, "quality");
    retryEnvelope = action.retryEnvelope;
  }
  return { observation, remediations, priors, retryEnvelope };
}
function layouts(sources: QaCorrectionSourceBytes[], observation: Observation): QaCorrectionProductLayout[] {
  return sources.map(source => {
    const prior = observation.priors.find(p => p.productId === source.productId)?.revision;
    if (prior) {
      if (prior.bundleManifestRelativePath === undefined || prior.assetsRelativeRoot === undefined) {
        throw new QaCorrectionStorageError("historical_format_unknown");
      }
      return { productId: source.productId, bundleManifestRelativePath: prior.bundleManifestRelativePath,
        assetsRelativeRoot: prior.assetsRelativeRoot };
    }
    const values = observation.declarations.filter(d => d.input.workProductId === source.productId).map(d => {
      if (d.input.mode !== "html") return { productId: source.productId, bundleManifestRelativePath: null,
        assetsRelativeRoot: d.frozen.contract.inputParams.assetsDir === undefined ? null : "assets" };
      const manifest = source.files.find(f => f.sourcePath === d.input.htmlManifest!.path);
      requireQaCorrection(manifest?.role === "ancillary", "source");
      return { productId: source.productId, bundleManifestRelativePath: manifest.relativePath, assetsRelativeRoot: "assets" };
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
function assertMeasured(sources: QaCorrectionSourceBytes[], ref: MeasuredRef) {
  const expected = ref.sourceMeasured.sources.map(s => ({ ...s,
    files: [...s.files].sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0),
  })).sort((a, b) => a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0);
  requireQaCorrection(isDeepStrictEqual(qaCorrectionSourceFacts(sources), expected), "source");
}
type Facts = Awaited<ReturnType<typeof currentFacts>>;
type Details = { stored: StoredCorrection; preparation: QaCorrectionPreparation; measured: MeasuredRef;
  current: Facts; beforeHash: string; revisionHash: string };
declare const validationBrand: unique symbol;
export type ValidatedQaCorrectionCandidate = { readonly [validationBrand]: true };
export type QaCorrectionCommitCandidateInspection =
  | { status: "validated"; token: ValidatedQaCorrectionCandidate }
  | { status: "stopped"; result: BeginQaCorrectionResult };
const validations = new WeakMap<ValidatedQaCorrectionCandidate, { details: Details; original: QaCorrectionSourceBytes[] }>();
function validated(token: ValidatedQaCorrectionCandidate) {
  const value = validations.get(token);
  requireQaCorrection(value, "record");
  return value;
}

/** Detached values for the later writer's handle, binding CAS and exact quality binding. No locks survive. */
export function qaCorrectionCommitDetails(token: ValidatedQaCorrectionCandidate): Details {
  return structuredClone(validated(token).details);
}

/** C03 inspection only: preserve actual stops before IO; no issuance or additional reservation. */
export async function inspectQaCorrectionCommitCandidate(db: Db, input: StoredCorrection): Promise<QaCorrectionCommitCandidateInspection> {
  requireQaCorrection(!is(db, PgTransaction), "record");
  const stored = candidate(input), ref = reference(stored);
  const { preparation } = await readMeasuredQaCorrection(db, ref);
  const checked = await withCurrentQaCorrectionPreparation(db, { preparationEventId: ref.preparationEventId,
    preparationHash: ref.preparationHash, preparation }, async tx =>
    ({ effect: "noop", value: await currentFacts(tx, preparation, ref) }));
  if (checked.status === "stopped") return { status: "stopped", result: checked.result };
  const current = checked.value, original = await readQaCorrectionSourceBytes(preparation, current.observation);
  assertMeasured(original, ref);
  const productLayouts = layouts(original, current.observation);
  const patched = patchQaCorrectionSources(original, current.remediations, productLayouts);
  const selected = current.observation.paths ? await captureArtifactRoot(current.observation.paths.workProductRoot) : null;
  let candidateId: string | undefined;
  for (const expected of patched) {
    const sourceId = expected.sourceProductId, r = stored.revisions.find(r => r.sourceProductId === sourceId)!;
    const output = stored.outputs.find(o => o.sourceProductId === sourceId)!;
    const source = original.find(source => source.productId === sourceId)!;
    const layout = productLayouts.find(layout => layout.productId === sourceId)!;
    // Recompute from independently read source/issuance facts, never from the candidate.
    const priorRevision = current.observation.priors.find(p => p.productId === sourceId)?.revision;
    const ancillaryRoleBindings = priorRevision ? priorRevision.ancillaryRoleBindings
      : layout.bundleManifestRelativePath === null ? undefined
      : source.files.flatMap(f => f.ancillaryRole === undefined ? []
        : [{ role: f.ancillaryRole, relativePath: f.relativePath }]);
    const prior = current.priors.find(prior => prior.productId === sourceId);
    const origin = !selected && prior ? priorBase(source.root.path, prior) : null;
    const base = selected ?? (origin ? await captureArtifactRoot(origin.base) : source.root);
    const prefix = selected ? path.join("missions", preparation.missionId) : origin?.prefix ?? "";
    const managed = path.join(base.path, prefix, "qa-corrections", preparation.correctionId);
    const relative = path.relative(managed, r.root).split(path.sep);
    requireQaCorrection(relative.length === 2 && uuid.safeParse(relative[0]).success && relative[1] === sourceId
      && r.root === path.join(managed, relative[0]!, sourceId)
      && (candidateId === undefined || candidateId === relative[0]), "source");
    candidateId = relative[0];
    requireQaCorrection(r.mainRelativePath === expected.mainRelativePath
      && r.bundleManifestRelativePath === layout.bundleManifestRelativePath && r.assetsRelativeRoot === layout.assetsRelativeRoot
      && isDeepStrictEqual(r.ancillaryRoleBindings, ancillaryRoleBindings)
      && isDeepStrictEqual(r.files, expected.files.map(({ role, relativePath, beforeSha256, sha256, byteSize }) =>
        ({ role, relativePath, beforeSha256, sha256, byteSize })))
      && isDeepStrictEqual(await captureArtifactRoot(r.root), output.artifactRoot), "source");
    if (output.assetsRoot !== null) await captureArtifactRoot(output.assetsRoot);
    for (const file of expected.files) {
      const bytes = await readArtifactBytes(output.artifactRoot, file.relativePath, Math.max(1, file.byteSize));
      requireQaCorrection(bytes.equals(file.bytes), "source");
    }
    requireQaCorrection(isDeepStrictEqual(await captureArtifactRoot(r.root), output.artifactRoot), "source");
  }
  const token = Object.freeze({}) as ValidatedQaCorrectionCandidate;
  validations.set(token, { original, details: { stored, preparation, measured: ref, current,
    beforeHash: hashQaCorrectionPayload(ref.sourceMeasured.sources), revisionHash: hashQaCorrectionPayload(stored.revisions) } });
  return { status: "validated", token };
}

/** Compatibility: existing callers still reject every preparation stop as stale. */
export async function validateQaCorrectionCommitCandidate(db: Db, input: StoredCorrection): Promise<ValidatedQaCorrectionCandidate> {
  const inspected = await inspectQaCorrectionCommitCandidate(db, input);
  requireQaCorrection(inspected.status === "validated", "stale");
  return inspected.token;
}

/** Outside TX, after quality upload/readback. Compare every A file and root with the first read. */
export async function rereadQaCorrectionCommitSources(token: ValidatedQaCorrectionCandidate): Promise<void> {
  const { details: d, original } = validated(token);
  const actual = await readQaCorrectionSourceBytes(d.preparation, d.current.observation);
  assertMeasured(actual, d.measured);
  requireQaCorrection(isDeepStrictEqual(actual, original), "source");
}

/** DB-only: call inside the final withCurrent body, before quality use or any other write.
 * The writer still owes use/verifiedAt -> B nonprimary -> A archive/primary transfer -> binding CAS
 * -> applied/followup -> readIssuedQaCorrection in that same transaction. Never reissue after use.
 */
export async function assertQaCorrectionCommitCurrent(tx: QaCorrectionDb, token: ValidatedQaCorrectionCandidate): Promise<void> {
  requireQaCorrection(is(tx, PgTransaction), "record");
  const { details: d } = validated(token);
  requireQaCorrection(isDeepStrictEqual(await currentFacts(tx, d.preparation, d.measured), d.current), "stale");
}
