import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import { workflowStepRuns, type Db } from "@paperclipai/db";
import { adaptQaResult, toolArtifactReceiptSchema, type ToolArtifactReceipt } from "@paperclipai/shared/validators/workflow-artifact";
import { artifactRelativePathSchema } from "@paperclipai/shared/validators/artifact-contract";
import { captureArtifactRoot, digest, readArtifactBytes } from "./artifact-files.js";
import { readCompletedSourceArtifactAttempt, readFrozenArtifactAttempt, type FrozenArtifactAttempt } from "./artifact-contract-runtime.js";
import { evaluateQaRules } from "./qa-rules.js";
import type { QaRequest } from "./qa-artifact-request.js";
import { resolveQaInternalPathRoots } from "./qa-internal-paths.js";

type Snapshot = Omit<NonNullable<QaRequest>["snapshot"], "artifactExecution" | "internalPathRoots"> & {
  artifactExecution?: FrozenArtifactAttempt; internalPathRoots?: string[];
};

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
  if (!qa.ok || qa.checks.some(c => !c.ok)) throw new Error("qa_artifact_verdict_failed");
  if ((s.input.mode ?? "content") !== (qa.inputDigest.mode ?? "content")) throw new Error("qa_artifact_input_mode_mismatch");
  const normalize = (a: { fileName: string; sha256: string; byteSize: number }[]) => [...a].sort((a, b) => a.fileName.localeCompare(b.fileName));
  if (s.input.mode === "html" && !isDeepStrictEqual(normalize(qa.ancillaryManifest ?? []),
    normalize(s.input.ancillaryManifest ?? []))) throw new Error("qa_artifact_ancillary_digest_mismatch");
  if (qa.inputDigest.sha256 !== s.input.sha256 || !isDeepStrictEqual(normalize(qa.assetManifest ?? []),
    normalize(s.input.assetManifest))) throw new Error("qa_artifact_input_digest_mismatch");
  let runtimeChecks;
  if (frozen) {
    const source = await readArtifactBytes(s.root, `input/${path.basename(s.input.path)}`, 8 * 1024 * 1024);
    if (digest(source) !== s.input.sha256 || source.length !== s.input.byteSize) throw new Error("qa_artifact_input_changed");
    for (const asset of [...s.input.assetManifest.map(a => ({ ...a, prefix: 'assets' })),
      ...(s.input.ancillaryManifest ?? []).map(a => ({ ...a, prefix: 'ancillary' }))]) {
      const data = await readArtifactBytes(s.root, `input/${asset.prefix}/${asset.fileName}`, 16 * 1024 * 1024);
      if (digest(data) !== asset.sha256 || data.length !== asset.byteSize) throw new Error("qa_artifact_asset_changed");
    }
    const evaluated = await evaluateQaRules({ config: frozen.qaConfig, provenanceValid: true, resultValid: true,
      ...(s.input.mode === "html" ? { html: source.toString("utf8") } : { json: JSON.parse(source.toString("utf8")) }),
      assetManifest: s.input.assetManifest,
      internalPathRoots: await resolveQaInternalPathRoots([s.outputRoot, s.root.path, ...(s.internalPathRoots ?? [])]) });
    if (!evaluated.ok) throw new Error(`qa_artifact_runtime_checks_failed:${evaluated.checks.filter(c => !c.ok).map(c => c.id).join(',')}`);
    runtimeChecks = evaluated.checks;
  }
  const { root: _, artifactExecution: __, internalPathRoots: ___, ...scope } = s;
  const receipt = toolArtifactReceiptSchema.parse({ ...scope,
    schemaVersion: frozen ? "workflow.tool-artifact.v2" : "workflow.tool-artifact.v1", role: "qa",
    relativePath: contract.resultFileName, resultSchema: contract.resultSchemaVersion, sha256: digest(bytes), byteSize: bytes.length,
    toolId: tool.id, toolName: tool.name, toolDeployment,
    ...(frozen ? { contractHash: frozen.contractHash, qaConfigHash: frozen.qaConfigHash, runtimeChecks, pluginChecks: qa.checks } : {}) });
  return { receipt, qa };
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
