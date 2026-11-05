import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { workProductProducerSchema, assetDigestSchema } from "@paperclipai/shared/validators/workflow-artifact";
import { readFrozenArtifactAttempt } from "./artifact-contract-runtime.js";
import { digest, type ArtifactRoot } from "./artifact-files.js";
import { qaCorrectionFollowupRefSchema } from "./control-flow/qa-correction-contract.js";

// Exact-authority admission for the single admissible post-claim metadata delta
// on a deferred-before-start release: prepareQaArtifactRequest writes a NEW
// `toolArtifactRequest` for the very same claim AFTER the queue claim
// (qa-artifact-request.ts choose() add branch). Release may re-queue only when
// every other metadata key stays deep-equal to the claim-time snapshot and the
// added snapshot itself passes the same typed authority anchors the preparation
// enforces. Unknown keys, replacements, removals, malformed or mismatched
// snapshots, and unrelated drift all hold the claim (fail closed). The final
// release UPDATE keeps its full metadata CAS, which still protects concurrency.

const QA_REQUEST_REQUIRED_KEYS = [
  "artifactExecution", "companyId", "missionId", "workflowRunId", "stepRunId", "stepId",
  "executionGeneration", "retryCount", "iterationIndex", "requestId",
  "outputRoot", "outputRootHash", "root", "internalPathRoots", "input",
] as const;
const QA_REQUEST_OPTIONAL_KEYS = ["qaCorrectionFollowup"] as const;

// Mirrors the internal `hash`/`count` of packages/shared/src/validators/workflow-artifact.ts.
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const countSchema = z.number().int().nonnegative();

// Exact shape of a snapshot's `input`, mirroring receiptBase.input in
// packages/shared/src/validators/workflow-artifact.ts field-for-field, reusing
// the real exported domain schemas (workProductProducerSchema, assetDigestSchema)
// and the same mode/htmlManifest pairing refinement.
const QA_REQUEST_INPUT_SCHEMA = z.object({
  workProductId: z.string().uuid(),
  producer: workProductProducerSchema,
  path: z.string(),
  sha256: hashSchema,
  byteSize: countSchema,
  assetsRoot: z.string(),
  assetManifest: z.array(assetDigestSchema),
  mode: z.literal("html").optional(),
  htmlManifest: z.object({ path: z.string(), sha256: hashSchema, byteSize: countSchema }).strict().optional(),
  ancillaryManifest: z.array(assetDigestSchema).optional(),
}).strict().refine((value) => value.mode === "html"
  ? value.htmlManifest !== undefined && value.ancillaryManifest !== undefined
  : value.htmlManifest === undefined && value.ancillaryManifest === undefined);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isArtifactRoot(value: unknown): value is ArtifactRoot {
  return isRecord(value) && typeof value.path === "string"
    && typeof value.dev === "number" && typeof value.ino === "number";
}

export interface DeferredClaimReleaseScope {
  companyId: string;
  missionId: string | null;
  workflowRunId: string;
  stepId: string;
  stepRunId: string;
  executionGeneration: number;
  retryCount: number;
  iterationIndex: number;
  requestId: string;
}

// Validates an ADDED toolArtifactRequest against the exact snapshot shape and
// authority checks of prepareQaArtifactRequest: the choose() stale-scope
// anchors, the typed readFrozenArtifactAttempt authority (throws => hold), the
// post-choose root/outputRootHash relation, the internalPathRoots predicate
// fragment derivable from the snapshot itself, and the real exported schemas
// for the producer, asset digests, and correction followup ref. Matching scope
// ids or mere object-ness is never sufficient.
function isExactSameRequestQaSnapshot(
  value: unknown,
  claimed: Record<string, unknown>,
  scope: DeferredClaimReleaseScope,
): boolean {
  const snapshot = isRecord(value) ? value : null;
  if (!snapshot) return false;
  const allowed = new Set<string>([...QA_REQUEST_REQUIRED_KEYS, ...QA_REQUEST_OPTIONAL_KEYS]);
  if (Object.keys(snapshot).some((key) => !allowed.has(key))) return false;
  if (QA_REQUEST_REQUIRED_KEYS.some((key) => !Object.prototype.hasOwnProperty.call(snapshot, key))) return false;
  if (snapshot.companyId !== scope.companyId || snapshot.missionId !== scope.missionId
    || snapshot.workflowRunId !== scope.workflowRunId || snapshot.stepRunId !== scope.stepRunId
    || snapshot.stepId !== scope.stepId || snapshot.executionGeneration !== scope.executionGeneration
    || snapshot.retryCount !== scope.retryCount || snapshot.iterationIndex !== scope.iterationIndex
    || snapshot.requestId !== scope.requestId) return false;
  // artifactExecution must be exactly the claim-time frozen attempt under the
  // existing typed authority read (missing/stale/hash failure throws => hold),
  // mirroring the preparation's own artifact_contract_snapshot_stale check.
  let frozen: unknown;
  try {
    frozen = readFrozenArtifactAttempt(claimed.artifactExecution,
      { executionGeneration: scope.executionGeneration, requestId: scope.requestId });
  } catch {
    return false;
  }
  if (!isDeepStrictEqual(snapshot.artifactExecution, frozen)) return false;
  // Root/outputRootHash relation from the post-choose verification in
  // qa-artifact-request.ts (qa_artifact_root_changed guard): ArtifactRoot shape
  // {path, dev, ino}, root.path === outputRoot, and the exact digest relation.
  const root = isArtifactRoot(snapshot.root) ? snapshot.root : null;
  if (!root || typeof snapshot.outputRoot !== "string" || !path.isAbsolute(snapshot.outputRoot)
    || root.path !== snapshot.outputRoot
    || typeof snapshot.outputRootHash !== "string"
    || snapshot.outputRootHash !== digest(JSON.stringify({ path: root.path, dev: root.dev, ino: root.ino }))) return false;
  // internalPathRoots predicate from the same guard: absolute strings, and it
  // must contain the snapshot's own root path (requiredRoots includes
  // chosen.root.path; mission-path-dependent roots are not recomputable here).
  if (!Array.isArray(snapshot.internalPathRoots)
    || !snapshot.internalPathRoots.every((entry) => typeof entry === "string" && path.isAbsolute(entry))
    || !snapshot.internalPathRoots.includes(snapshot.outputRoot)) return false;
  // input: full receiptBase.input shape with the real exported producer and
  // asset-digest schemas; the producer must belong to the same company.
  const parsedInput = QA_REQUEST_INPUT_SCHEMA.safeParse(snapshot.input);
  if (!parsedInput.success) return false;
  const qaInput = parsedInput.data;
  if (!path.isAbsolute(qaInput.path) || qaInput.producer.companyId !== snapshot.companyId) return false;
  // qaCorrectionFollowup is the real correction followup ref
  // (qaCorrectionFollowupRefSchema, uuid-strict) and must belong to the same company.
  if (snapshot.qaCorrectionFollowup !== undefined) {
    const parsedRef = qaCorrectionFollowupRefSchema.safeParse(snapshot.qaCorrectionFollowup);
    if (!parsedRef.success || parsedRef.data.companyId !== snapshot.companyId) return false;
  }
  return true;
}

// Returns the normalized current metadata when the only delta versus the
// claim-time snapshot is an admissible new QA `toolArtifactRequest` (or there
// is no delta at all); null means the release must hold the claim.
export function admitClaimMetadataWithQaArtifactRequest(
  currentMetadata: unknown,
  claimedMetadata: unknown,
  scope: DeferredClaimReleaseScope,
): Record<string, unknown> | null {
  const current = isRecord(currentMetadata) ? currentMetadata : null;
  const claimed = isRecord(claimedMetadata) ? claimedMetadata : null;
  if (!current || !claimed) return null;
  for (const key of Object.keys(claimed)) {
    if (key === "toolArtifactRequest") continue;
    if (!Object.prototype.hasOwnProperty.call(current, key)
      || !isDeepStrictEqual(current[key], claimed[key])) return null;
  }
  for (const key of Object.keys(current)) {
    if (key !== "toolArtifactRequest" && !Object.prototype.hasOwnProperty.call(claimed, key)) return null;
  }
  if (Object.prototype.hasOwnProperty.call(claimed, "toolArtifactRequest")) {
    // Only byte-identical reuse is admissible; a replaced snapshot holds the claim.
    return isDeepStrictEqual(current.toolArtifactRequest, claimed.toolArtifactRequest) ? current : null;
  }
  if (!Object.prototype.hasOwnProperty.call(current, "toolArtifactRequest")) return current;
  return isExactSameRequestQaSnapshot(current.toolArtifactRequest, claimed, scope) ? current : null;
}
