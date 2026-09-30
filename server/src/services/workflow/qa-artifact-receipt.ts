import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import { workflowStepRuns, type Db } from "@paperclipai/db";
import { manualQaResultSchema, toolArtifactReceiptSchema, type ToolArtifactReceipt } from "@paperclipai/shared/validators/workflow-artifact";
import { captureArtifactRoot, digest, readArtifactBytes } from "./artifact-files.js";
import type { QaRequest } from "./qa-artifact-request.js";

export async function toolDeploymentHashes(commandParts: string[], cwd: string) {
  // Hash actual configured script bytes. Interpreter and transitive bundle attestation
  // are separate deployment evidence, not implied by this script digest.
  const files = commandParts.filter(p => /\.(mjs|cjs|js)$/.test(p));
  const qaScript = files.find(p => path.basename(p) === "manual-onboarding-qa.mjs");
  if (qaScript) {
    const dir = path.dirname(path.resolve(cwd, qaScript));
    // Exact eight-file producer deployment contract (OVERSIGHT-V31-INTEGRATION).
    files.push(...["manual-onboarding-assets.mjs", "manual-onboarding-workflow-tool.mjs", "publication-date-contract.mjs",
      "hub-flow-update.mjs", "cms-publish.mjs", "legacy-to-contentv1.mjs", "canonical-json.mjs"].map(f => path.join(dir, f)));
  }
  if (!files.length) throw new Error("qa_tool_deployment_unresolved");
  const hashes = [];
  for (const file of files) {
    const full = path.resolve(cwd, file), root = await captureArtifactRoot(path.dirname(full));
    const bytes = await readArtifactBytes(root, path.basename(full), 32 * 1024 * 1024);
    hashes.push({ fileName: full, sha256: digest(bytes), byteSize: bytes.length });
  }
  return hashes;
}
export async function verifyQaArtifact(request: Pick<NonNullable<QaRequest>, "snapshot">, tool: { id: string; name: string },
  toolDeployment: ToolArtifactReceipt["toolDeployment"]) {
  const s = request.snapshot;
  const bytes = await readArtifactBytes(s.root, "qa-result.json", 1024 * 1024);
  const qa = manualQaResultSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (!qa.ok || qa.checks.some(c => !c.ok)) throw new Error("qa_artifact_verdict_failed");
  const actualHash = "contentSha256" in qa ? qa.contentSha256 : qa.htmlSha256;
  const assets = qa.assetManifest;
  if ((s.input.mode ?? "content") !== qa.mode) throw new Error("qa_artifact_input_mode_mismatch");
  if (qa.mode === "html" && !isDeepStrictEqual([...qa.ancillaryManifest].sort((a,b) => a.fileName.localeCompare(b.fileName)),
    [...(s.input.ancillaryManifest ?? [])].sort((a,b) => a.fileName.localeCompare(b.fileName)))) throw new Error("qa_artifact_ancillary_digest_mismatch");
  const normalize = (a: typeof assets) => [...a].sort((a, b) => a.fileName.localeCompare(b.fileName));
  if (actualHash !== s.input.sha256 || !isDeepStrictEqual(normalize(assets), normalize(s.input.assetManifest))) throw new Error("qa_artifact_input_digest_mismatch");
  const { root: _, ...scope } = s;
  const receipt = toolArtifactReceiptSchema.parse({ ...scope, schemaVersion: "workflow.tool-artifact.v1", role: "qa",
    relativePath: "qa-result.json", resultSchema: qa.schemaVersion, sha256: digest(bytes), byteSize: bytes.length,
    toolId: tool.id, toolName: tool.name, toolDeployment });
  return { receipt, qa };
}

/** Completion rechecks the durable request, not the supplied stdout or artifactPath. */
export function assertQaReceiptScope(raw: unknown, row: { run: { id: string; companyId: string; missionId: string | null };
  stepRun: typeof workflowStepRuns.$inferSelect }, requestId?: string) {
  const receipt = toolArtifactReceiptSchema.parse(raw), s = row.stepRun;
  const request = s.metadata.toolArtifactRequest as NonNullable<QaRequest>["snapshot"] | undefined;
  if (!request || receipt.companyId !== row.run.companyId || receipt.missionId !== row.run.missionId
    || receipt.workflowRunId !== row.run.id || receipt.stepRunId !== s.id || receipt.stepId !== s.stepId
    || receipt.requestId !== requestId || receipt.requestId !== s.lastDispatchRequestId
    || receipt.executionGeneration !== s.executionGeneration || receipt.retryCount !== s.retryCount
    || receipt.iterationIndex !== s.iterationIndex || receipt.outputRoot !== request.outputRoot
    || receipt.outputRootHash !== request.outputRootHash || !isDeepStrictEqual(receipt.input, request.input)) {
    throw new Error("qa_artifact_receipt_scope_mismatch");
  }
  return receipt;
}

export async function verifyQaCompletion(raw: unknown, row: Parameters<typeof assertQaReceiptScope>[1], requestId?: string) {
  const receipt = assertQaReceiptScope(raw, row, requestId);
  const snapshot = row.stepRun.metadata.toolArtifactRequest as NonNullable<QaRequest>["snapshot"];
  const verified = await verifyQaArtifact({ snapshot }, { id: receipt.toolId, name: receipt.toolName }, receipt.toolDeployment);
  if (!isDeepStrictEqual(verified.receipt, receipt)) throw new Error("qa_artifact_receipt_bytes_mismatch");
  return receipt;
}

export async function readQaReceiptBytes(db: Db, scope: { companyId: string; workflowRunId: string; stepId: string }) {
  const [step] = await db.select().from(workflowStepRuns).where(and(eq(workflowStepRuns.workflowRunId, scope.workflowRunId), eq(workflowStepRuns.stepId, scope.stepId)));
  if (!step || step.status !== "completed" || step.metadata.cacheHit) throw new Error("qa_artifact_receipt_unavailable");
  const receipt = toolArtifactReceiptSchema.parse(step.metadata.toolArtifactReceipt);
  assertQaReceiptScope(receipt, { run: { id: scope.workflowRunId, companyId: scope.companyId, missionId: receipt.missionId }, stepRun: step }, step.lastDispatchRequestId ?? undefined);
  const request = step.metadata.toolArtifactRequest as NonNullable<QaRequest>["snapshot"];
  const bytes = await readArtifactBytes(request.root, receipt.relativePath, 1024 * 1024);
  if (digest(bytes) !== receipt.sha256 || bytes.length !== receipt.byteSize) throw new Error("qa_artifact_receipt_bytes_changed");
  manualQaResultSchema.parse(JSON.parse(bytes.toString("utf8")));
  return { receipt, bytes };
}
