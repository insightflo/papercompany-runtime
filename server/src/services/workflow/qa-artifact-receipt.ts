import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { workflowStepRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { adaptQaResult, toolArtifactReceiptSchema, type ToolArtifactReceipt } from "@paperclipai/shared/validators/workflow-artifact";
import { artifactRelativePathSchema } from "@paperclipai/shared/validators/artifact-contract";
import { captureArtifactRoot, digest, readArtifactBytes } from "./artifact-files.js";
import { readCompletedSourceArtifactAttempt, readFrozenArtifactAttempt, type FrozenArtifactAttempt } from "./artifact-contract-runtime.js";
import { evaluateQaRules } from "./qa-rules.js";
import type { QaRequest } from "./qa-artifact-request.js";
import { resolveQaInternalPathRoots } from "./qa-internal-paths.js";
import { hashQaCorrectionPayload, parseQaCorrectionEventPayload, qaCorrectionFollowupRefSchema,
  type QaCorrectionFollowupRef } from "./control-flow/qa-correction-contract.js";
import type { QaCorrectionDb } from "./control-flow/qa-correction-authority.js";

type Snapshot = Omit<NonNullable<QaRequest>["snapshot"], "artifactExecution" | "internalPathRoots"> & {
  artifactExecution?: FrozenArtifactAttempt; internalPathRoots?: string[];
};

type QaReceiptRequestScope = Pick<ToolArtifactReceipt,
  "companyId" | "missionId" | "workflowRunId" | "stepRunId" | "stepId" | "executionGeneration"
  | "retryCount" | "iterationIndex" | "requestId" | "outputRoot" | "outputRootHash" | "input">;
function projectQaReceiptRequestScope(s: QaReceiptRequestScope): QaReceiptRequestScope {
  return {
    companyId: s.companyId, missionId: s.missionId, workflowRunId: s.workflowRunId,
    stepRunId: s.stepRunId, stepId: s.stepId, executionGeneration: s.executionGeneration,
    retryCount: s.retryCount, iterationIndex: s.iterationIndex, requestId: s.requestId,
    outputRoot: s.outputRoot, outputRootHash: s.outputRootHash, input: s.input,
  };
}

/** Server-verifier rejection, distinct from child diagnostics and invalid machine results. */
export class QaArtifactRejectionError extends Error {
  constructor(message: "qa_artifact_verdict_failed" | `qa_artifact_runtime_checks_failed:${string}`) {
    super(message);
    this.name = "QaArtifactRejectionError";
  }
}

/** Declared files only, relative to the configured deployment root. */
export async function toolDeploymentHashes(files: string[], cwd: string) {
  if (!files.length) throw new Error("qa_tool_deployment_unresolved");
  const root = await captureArtifactRoot(cwd), hashes = [];
  for (const file of [...new Set(files)]) {
    const fileName = artifactRelativePathSchema.parse(file);
    const bytes = await readArtifactBytes(root, fileName, 32 * 1024 * 1024);
    hashes.push({ fileName, sha256: digest(bytes), byteSize: bytes.length });
  }
  return hashes;
}

export async function verifyQaArtifact(request: { snapshot: Snapshot }, tool: { id: string; name: string },
  toolDeployment: ToolArtifactReceipt["toolDeployment"], legacyReceipt?: ToolArtifactReceipt) {
  const s = request.snapshot;
  const frozen = s.artifactExecution ? readFrozenArtifactAttempt(s.artifactExecution,
    { executionGeneration: s.executionGeneration, requestId: s.requestId }) : undefined;
  if (!frozen && legacyReceipt?.schemaVersion !== "workflow.tool-artifact.v1") throw new Error("artifact_contract_snapshot_required");
  const contract = frozen?.contract ?? { resultFileName: legacyReceipt!.relativePath,
    resultSchemaVersion: legacyReceipt!.resultSchema, resultAdapter: "legacy-qa" as const };
  const bytes = await readArtifactBytes(s.root, contract.resultFileName, 1024 * 1024);
  const qa = adaptQaResult(JSON.parse(bytes.toString("utf8")), contract);
  if ((s.input.mode ?? "content") !== (qa.inputDigest.mode ?? "content")) throw new Error("qa_artifact_input_mode_mismatch");
  const normalize = (a: { fileName: string; sha256: string; byteSize: number }[]) => [...a].sort((a, b) => a.fileName.localeCompare(b.fileName));
  if (s.input.mode === "html" && !isDeepStrictEqual(normalize(qa.ancillaryManifest ?? []),
    normalize(s.input.ancillaryManifest ?? []))) throw new Error("qa_artifact_ancillary_digest_mismatch");
  if (qa.inputDigest.sha256 !== s.input.sha256 || !isDeepStrictEqual(normalize(qa.assetManifest ?? []),
    normalize(s.input.assetManifest))) throw new Error("qa_artifact_input_digest_mismatch");
  let source: Buffer | undefined;
  if (frozen) {
    source = await readArtifactBytes(s.root, `input/${path.basename(s.input.path)}`, 8 * 1024 * 1024);
    if (digest(source) !== s.input.sha256 || source.length !== s.input.byteSize) throw new Error("qa_artifact_input_changed");
    for (const asset of [...s.input.assetManifest.map(a => ({ ...a, prefix: 'assets' })),
      ...(s.input.ancillaryManifest ?? []).map(a => ({ ...a, prefix: 'ancillary' }))]) {
      const data = await readArtifactBytes(s.root, `input/${asset.prefix}/${asset.fileName}`, 16 * 1024 * 1024);
      if (digest(data) !== asset.sha256 || data.length !== asset.byteSize) throw new Error("qa_artifact_asset_changed");
    }
  }
  const scope = projectQaReceiptRequestScope(s);
  const receipt = toolArtifactReceiptSchema.parse({ ...scope,
    schemaVersion: frozen ? "workflow.tool-artifact.v2" : "workflow.tool-artifact.v1", role: "qa",
    relativePath: contract.resultFileName, resultSchema: contract.resultSchemaVersion, sha256: digest(bytes), byteSize: bytes.length,
    toolId: tool.id, toolName: tool.name, toolDeployment,
    ...(frozen ? { contractHash: frozen.contractHash, qaConfigHash: frozen.qaConfigHash, pluginChecks: qa.checks } : {}) });
  // Only a result bound to valid request data and intact captured bytes can request content rework.
  if (!qa.ok || qa.checks.some(c => !c.ok)) throw new QaArtifactRejectionError("qa_artifact_verdict_failed");
  let runtimeChecks;
  if (frozen) {
    const document = s.input.mode === "html" ? { html: source!.toString("utf8") }
      : { json: JSON.parse(source!.toString("utf8")) };
    const evaluated = await evaluateQaRules({ config: frozen.qaConfig, provenanceValid: true, resultValid: true,
      ...document, assetManifest: s.input.assetManifest,
      internalPathRoots: await resolveQaInternalPathRoots([s.outputRoot, s.root.path, ...(s.internalPathRoots ?? [])]) });
    if (!evaluated.ok) {
      // ids stay first (whitelist + id-only consumers); string details (e.g. violating links) ride
      // after them, bounded, so the persisted summary and mechanical rework feedback stay actionable.
      const failed = evaluated.checks.filter(c => !c.ok);
      const details = failed.flatMap(c => (typeof c.detail === "string" && c.detail.length > 0) ? [c.detail] : [])
        .join(" ").slice(0, 300);
      throw new QaArtifactRejectionError(`qa_artifact_runtime_checks_failed:${failed.map(c => c.id).join(",")}${details ? ` ${details}` : ""}`);
    }
    runtimeChecks = evaluated.checks;
  }
  return { receipt: runtimeChecks ? toolArtifactReceiptSchema.parse({ ...receipt, runtimeChecks }) : receipt, qa };
}

/** Completion rechecks durable request + frozen contract, never stdout or supplied artifactPath. */
export function assertQaReceiptScope(raw: unknown, row: { run: { id: string; companyId: string; missionId: string | null };
  stepRun: typeof workflowStepRuns.$inferSelect }, requestId?: string) {
  const receipt = toolArtifactReceiptSchema.parse(raw), s = row.stepRun;
  const request = s.metadata.toolArtifactRequest as Snapshot | undefined;
  // [2026-10-04 tech-scout] 완료 소스의 영수증은 생성 시도의 냉동 스냅숏 기준으로 세대를 검증한다
  //   (종결/복구가 완료 행 세대를 올려도 유효). running/failed 행은 기존 정확-일치 스코프.
  const completedSource = s.status === "completed";
  const sourceFrozen = completedSource && s.metadata.artifactExecution !== undefined
    ? readCompletedSourceArtifactAttempt(s.metadata.artifactExecution, s) : null;
  const receiptGenerationOk = completedSource
    ? (sourceFrozen ? receipt.executionGeneration === sourceFrozen.executionGeneration
      : receipt.executionGeneration <= s.executionGeneration)
    : receipt.executionGeneration === s.executionGeneration;
  if (!request || receipt.role !== "qa" || receipt.companyId !== row.run.companyId || receipt.missionId !== row.run.missionId
    || receipt.workflowRunId !== row.run.id || receipt.stepRunId !== s.id || receipt.stepId !== s.stepId
    || receipt.requestId !== requestId || receipt.requestId !== s.lastDispatchRequestId
    || !receiptGenerationOk || receipt.retryCount !== s.retryCount
    || receipt.iterationIndex !== s.iterationIndex || receipt.outputRoot !== request.outputRoot
    || receipt.outputRootHash !== request.outputRootHash || !isDeepStrictEqual(receipt.input, request.input)) {
    throw new Error("qa_artifact_receipt_scope_mismatch");
  }
  if (receipt.schemaVersion === "workflow.tool-artifact.v2") {
    const frozen = sourceFrozen ?? readFrozenArtifactAttempt(s.metadata.artifactExecution,
      { executionGeneration: s.executionGeneration, requestId: receipt.requestId });
    if (!isDeepStrictEqual(frozen, request.artifactExecution) || receipt.contractHash !== frozen.contractHash
      || receipt.qaConfigHash !== frozen.qaConfigHash || receipt.relativePath !== frozen.contract.resultFileName
      || receipt.resultSchema !== frozen.contract.resultSchemaVersion) throw new Error("qa_artifact_receipt_contract_mismatch");
  } else if (request.artifactExecution || s.metadata.artifactExecution) throw new Error("qa_artifact_receipt_version_mismatch");
  return receipt;
}
export async function verifyQaCompletion(raw: unknown, row: Parameters<typeof assertQaReceiptScope>[1], requestId?: string) {
  const receipt = assertQaReceiptScope(raw, row, requestId);
  const snapshot = row.stepRun.metadata.toolArtifactRequest as Snapshot;
  const verified = await verifyQaArtifact({ snapshot }, { id: receipt.toolId, name: receipt.toolName }, receipt.toolDeployment, receipt);
  if (!isDeepStrictEqual(verified.receipt, receipt)) throw new Error("qa_artifact_receipt_bytes_mismatch");
  return receipt;
}
export async function readQaReceiptBytes(db: Db, scope: { companyId: string; workflowRunId: string; stepId: string }) {
  const [step] = await db.select().from(workflowStepRuns).where(and(eq(workflowStepRuns.workflowRunId, scope.workflowRunId), eq(workflowStepRuns.stepId, scope.stepId)));
  if (!step || step.status !== "completed" || step.metadata.cacheHit) throw new Error("qa_artifact_receipt_unavailable");
  const receipt = toolArtifactReceiptSchema.parse(step.metadata.toolArtifactReceipt);
  await verifyQaCompletion(receipt, { run: { id: scope.workflowRunId, companyId: scope.companyId, missionId: receipt.missionId }, stepRun: step }, step.lastDispatchRequestId ?? undefined);
  const request = step.metadata.toolArtifactRequest as Snapshot;
  const bytes = await readArtifactBytes(request.root, receipt.relativePath, 1024 * 1024);
  if (digest(bytes) !== receipt.sha256 || bytes.length !== receipt.byteSize) throw new Error("qa_artifact_receipt_bytes_changed");
  return { receipt, bytes };
}

const proofUuid = z.string().uuid(), proofText = z.string().min(1);
const proofHash = z.string().regex(/^[a-f0-9]{64}$/);
const proofRequestSchema = toolArtifactReceiptSchema.options[1].pick({
  companyId: true, missionId: true, workflowRunId: true, stepRunId: true, stepId: true,
  executionGeneration: true, retryCount: true, iterationIndex: true, requestId: true,
  outputRoot: true, outputRootHash: true, input: true,
}).extend({
  qaCorrectionFollowup: qaCorrectionFollowupRefSchema,
  artifactExecution: z.custom<FrozenArtifactAttempt>(value => {
    try { readFrozenArtifactAttempt(value); return true; } catch { return false; }
  }, "qa_correction_tool_proof_frozen"),
}).strict();
const toolConsumptionProofSchema = z.object({
  schemaVersion: z.literal("workflow.qa-correction.tool-consumption-proof.v1"),
  ref: qaCorrectionFollowupRefSchema, followupEventId: proofUuid,
  request: proofRequestSchema,
  receipt: toolArtifactReceiptSchema.options[1].extend({ role: z.literal("qa") }).strict(),
  completedAt: z.string().datetime({ offset: true }),
  statusTransitionVersion: z.number().int().safe().nonnegative(),
}).strict();
export type QaCorrectionToolConsumptionProof = z.infer<typeof toolConsumptionProofSchema>;
function requireToolProof(value: unknown, reason: string): asserts value {
  if (!value) throw new Error("qa_correction_tool_proof_" + reason);
}

/** Shape and frozen equality only; server issuance requires the DB reader below. */
export function parseQaCorrectionToolConsumptionProof(raw: unknown): QaCorrectionToolConsumptionProof {
  hashQaCorrectionPayload(raw);
  const proof = toolConsumptionProofSchema.parse(raw), q = proof.request, r = proof.receipt;
  const frozen = readFrozenArtifactAttempt(q.artifactExecution, q);
  requireToolProof(isDeepStrictEqual(q.qaCorrectionFollowup, proof.ref)
    && q.companyId === proof.ref.companyId && q.workflowRunId === proof.ref.workflowRunId
    && isDeepStrictEqual(projectQaReceiptRequestScope(q), projectQaReceiptRequestScope(r)), "request");
  requireToolProof(r.contractHash === frozen.contractHash && r.qaConfigHash === frozen.qaConfigHash
    && r.relativePath === frozen.contract.resultFileName && r.resultSchema === frozen.contract.resultSchemaVersion
    && frozen.contract.role === "qa", "receipt");
  return proof;
}

/** SELECT-only historical relation; never re-read current request/status, files or completion writers. */
export async function readQaCorrectionToolConsumptionProof(db: QaCorrectionDb, value: {
  ref: QaCorrectionFollowupRef; proofEventId: string; stepRunId: string; requestId: string; sha256: string;
}) {
  const lookup = z.object({ ref: qaCorrectionFollowupRefSchema, proofEventId: proofUuid,
    stepRunId: proofUuid, requestId: proofText, sha256: proofHash }).strict().parse(value);
  const [row] = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, lookup.proofEventId));
  requireToolProof(row, "missing");
  const proof = parseQaCorrectionToolConsumptionProof(row.payload), q = proof.request, r = proof.receipt;
  requireToolProof(isDeepStrictEqual(proof.ref, lookup.ref) && r.stepRunId === lookup.stepRunId
    && r.requestId === lookup.requestId && r.sha256 === lookup.sha256, "lookup");
  const { readIssuedQaCorrectionHistory } = await import("./control-flow/qa-correction-reader.js");
  const history = await readIssuedQaCorrectionHistory(db, proof.ref), issued = history.issued, p = issued.preparation;
  const followup = issued.followups.find(f => f.requestId === proof.ref.requestId);
  requireToolProof(followup && issued.applied.followupEventIds.includes(proof.followupEventId), "issuance");
  const [followupRow] = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, proof.followupEventId));
  requireToolProof(followupRow && followupRow.eventType === "qa_correction_followup_requested"
    && isDeepStrictEqual(parseQaCorrectionEventPayload("qa_correction_followup_requested", followupRow.payload), followup), "issuance");
  const t = followup.target;
  requireToolProof(row.companyId === p.companyId && row.missionId === p.missionId
    && row.workflowRunId === p.workflowRunId && row.workflowStepRunId === t.stepRunId && row.issueId === t.issueId
    && row.executionGeneration === t.executionGeneration && row.eventType === "qa_correction_tool_consumption_proof"
    && row.layer === "workflow_validation" && row.idempotencyKey === "qa-correction-tool-proof:" + q.requestId
    && row.heartbeatRunId === null && row.wakeupRequestId === null && row.toStatus === "completed"
    && row.createdAt.getTime() === Date.parse(proof.completedAt)
    && row.createdAt >= followupRow.createdAt && Date.parse(proof.completedAt) >= Date.parse(issued.applied.appliedAt), "record");
  requireToolProof(q.companyId === p.companyId && q.missionId === p.missionId && q.workflowRunId === p.workflowRunId
    && q.stepRunId === t.stepRunId && q.stepId === t.stepId && q.executionGeneration === t.executionGeneration
    && q.retryCount === t.retryCount && q.iterationIndex === t.iterationIndex, "attempt");
  const revisions = issued.applied.revisions.filter(revision => followup.revisionIds.includes(revision.revisionId));
  const revision = revisions.find(revision => revision.workProductId === r.input.workProductId);
  const main = revision?.files.find(file => file.role === "main"), input = r.input;
  requireToolProof(revisions.length === 1 && revision && main
    && input.path === path.join(revision.root, revision.mainRelativePath)
    && input.sha256 === main.sha256 && input.byteSize === main.byteSize, "input");
  const sorted = (files: { fileName: string; sha256: string; byteSize: number }[]) =>
    [...files].sort((a, b) => a.fileName.localeCompare(b.fileName));
  const assets = revision.files.filter(file => file.role === "asset").map(file => ({
    fileName: path.posix.relative(revision.assetsRelativeRoot ?? "", file.relativePath), sha256: file.sha256, byteSize: file.byteSize }));
  requireToolProof(isDeepStrictEqual(sorted(input.assetManifest), sorted(assets)), "assets");
  if (input.mode === "html") {
    const manifest = revision.files.find(file => file.relativePath === revision.bundleManifestRelativePath);
    requireToolProof(manifest && input.htmlManifest && input.htmlManifest.path === path.join(revision.root, manifest.relativePath)
      && input.htmlManifest.sha256 === manifest.sha256 && input.htmlManifest.byteSize === manifest.byteSize
      && revision.ancillaryRoleBindings !== undefined && input.ancillaryManifest, "manifest");
    const ancillary = revision.ancillaryRoleBindings.map(binding => {
      const file = revision.files.find(file => file.relativePath === binding.relativePath)!;
      return { fileName: binding.role, sha256: file.sha256, byteSize: file.byteSize };
    });
    requireToolProof(isDeepStrictEqual(sorted(input.ancillaryManifest), sorted(ancillary)), "ancillary");
  } else requireToolProof(revision.bundleManifestRelativePath === null && input.assetsRoot ===
    (revision.assetsRelativeRoot === null ? "" : path.join(revision.root, revision.assetsRelativeRoot!)), "manifest");
  let ancestor = issued, sourceProductId = revision.sourceProductId;
  const visited = new Set<string>();
  for (;;) {
    requireToolProof(!visited.has(ancestor.preparation.correctionId), "lineage");
    visited.add(ancestor.preparation.correctionId);
    const source = ancestor.preparation.sources.find(source => source.productId === sourceProductId);
    requireToolProof(source && source.provenance.kind !== "registered_legacy", "producer");
    if (source.provenance.kind === "workflow_producer") {
      requireToolProof(isDeepStrictEqual(input.producer, source.provenance.workflowProducer), "producer");
      break;
    }
    ancestor = await history.readAncestor(source.provenance.appliedEventId);
    const previous = ancestor.applied.revisions.find(revision => revision.workProductId === sourceProductId);
    requireToolProof(previous, "lineage");
    sourceProductId = previous.sourceProductId;
  }
  return { eventId: row.id, proof };
}
