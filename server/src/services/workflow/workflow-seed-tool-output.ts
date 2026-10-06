import path from "node:path";
import { and, eq } from "drizzle-orm";
import { workflowRuns, workflowRunSeeds, workflowStepRuns, type Db } from "@paperclipai/db";
import { toolArtifactReceiptSchema } from "@paperclipai/shared/validators/workflow-artifact";
import { workflowSeedToolOutputSchema, type WorkflowSeedToolOutput } from "@paperclipai/shared/validators/workflow-seed";
import { classifyWorkflowStepRole } from "../workflow-step-role.js";
import { resolveMissionWorkProductPaths } from "../work-products/output-paths.js";
import { captureArtifactRoot, digest, readArtifactBytes } from "./artifact-files.js";
import { loadExecutionDefinition } from "./execution-definition.js";
import { readWorkflowToolArtifactPath } from "./tool-artifact-path.js";
import { findWorkflowSeed, requireSeedSource, seedError, seedStepHash } from "./workflow-seed-evidence.js";
import { verifySeedInterpretedInputs } from "./seed-interpreted-inputs.js";

/**
 * Native tool step: an issue-less tool execution whose durable output is the recorded
 * toolResult artifact (or tool artifact receipt), not an issue work product.
 */
export function isNativeToolStep(step: { type?: unknown; agentId?: unknown; toolArtifactContract?: unknown }) {
  return classifyWorkflowStepRole(step) === "unknown" && step.type === "tool" && !step.agentId
    && step.toolArtifactContract === undefined;
}

export function parseToolSeedEvidence(evidence: unknown): WorkflowSeedToolOutput | null {
  const parsed = workflowSeedToolOutputSchema.safeParse(evidence);
  return parsed.success ? parsed.data : null;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Production-time digest the durable toolResult record must carry for receipt-less seed reuse. */
const storedArtifactDigest = (value: unknown): string | null =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null;

/**
 * Read the artifact a completed native tool step actually recorded (receipt authority first,
 * toolResult otherwise) and prove it against the current row: same-run producer binding,
 * company+mission scope, current dispatch attempt and byte-level SHA anchored to the digest
 * stored at production time (receipt sha256, or toolResult artifactSha256 when receipt-less).
 * A present-but-malformed receipt, a receipt-less record without a stored digest, or current
 * bytes diverging from that digest each refuse with a structured reason — approval never
 * re-baselines a digest from the current file; never a silent reuse, never a loose fallback.
 */
export async function readToolStepSeedArtifact(db: Db, input: { companyId: string;
  run: typeof workflowRuns.$inferSelect; stepRun: typeof workflowStepRuns.$inferSelect }): Promise<WorkflowSeedToolOutput["artifact"]> {
  const s = input.stepRun;
  if (s.workflowRunId !== input.run.id || s.issueId !== null) throw seedError("tool_output_scope_mismatch");
  if (s.status !== "completed") throw seedError("source_incomplete");
  const stored = record(s.metadata?.toolResult);
  const rawReceipt = s.metadata?.toolArtifactReceipt ?? null;
  const receipt = toolArtifactReceiptSchema.safeParse(rawReceipt);
  // A present-but-malformed receipt is durable-record corruption, not an absent receipt: refuse
  // outright instead of falling through to the weaker receipt-less toolResult branch.
  if (rawReceipt !== null && !receipt.success) throw seedError("tool_output_receipt_invalid");
  let file = "", sha256 = "", byteSize = 0, requestId: string | null = null;
  if (receipt.success) {
    const r = receipt.data;
    if (r.companyId !== input.companyId || r.workflowRunId !== input.run.id || r.stepRunId !== s.id
      || r.stepId !== s.stepId || r.executionGeneration !== s.executionGeneration
      || r.retryCount !== s.retryCount || r.iterationIndex !== s.iterationIndex) throw seedError("tool_output_scope_mismatch");
    file = path.join(r.outputRoot, r.relativePath);
    sha256 = r.sha256; byteSize = r.byteSize; requestId = r.requestId;
  } else {
    if (stored.success !== true) throw seedError("tool_output_record_missing");
    file = readWorkflowToolArtifactPath(stored) ?? "";
    if (!file) throw seedError("tool_output_record_invalid");
    requestId = typeof stored.requestId === "string" && stored.requestId ? stored.requestId : null;
    const producedDigest = storedArtifactDigest(stored.artifactSha256);
    // Without the digest stamped when the tool completed, approval-time bytes cannot be told
    // apart from post-production tampering: refuse conservatively, never re-baseline.
    if (!producedDigest) throw seedError("tool_output_digest_missing");
    sha256 = producedDigest;
  }
  // The producing attempt must still be the step run's current recorded attempt.
  if (!requestId || requestId !== s.lastDispatchRequestId) throw seedError("source_attempt_changed");
  const paths = await resolveMissionWorkProductPaths(db, { companyId: input.companyId, missionId: input.run.missionId });
  if (!paths) throw seedError("artifact_root_missing");
  const relative = path.relative(paths.missionOutputDir, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw seedError("tool_output_scope_mismatch");
  try {
    const root = await captureArtifactRoot(path.dirname(file));
    const bytes = await readArtifactBytes(root, path.basename(file), 32 * 1024 * 1024);
    if (receipt.success) {
      if (digest(bytes) !== sha256 || bytes.length !== byteSize) throw seedError("sha_mismatch");
    } else {
      // Current bytes must be the produced bytes: divergence from the stored production-time
      // digest refuses with a structured reason — no new baseline, no partial reuse.
      if (digest(bytes) !== sha256) throw seedError("tool_output_digest_mismatch");
      byteSize = bytes.length;
    }
    return { stepRunId: s.id, requestId, path: file, sha256, byteSize,
      executionGeneration: s.executionGeneration, retryCount: s.retryCount, iterationIndex: s.iterationIndex };
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("workflow_seed_")) throw e;
    throw seedError("artifact_unreadable");
  }
}

/** Revalidate a durable tool-output seed end to end (scope, attempt, record, bytes); never restamp. */
export async function verifyToolSeedEvidence(db: Db, seed: typeof workflowRunSeeds.$inferSelect): Promise<WorkflowSeedToolOutput["artifact"]> {
  const evidence = parseToolSeedEvidence(seed.evidence);
  if (!evidence || !seed.approvedByUserId) throw seedError("provenance_invalid");
  const [target] = await db.select().from(workflowRuns).where(and(eq(workflowRuns.id, seed.targetRunId), eq(workflowRuns.companyId, seed.companyId)));
  if (!target) throw seedError("source_scope_mismatch");
  await requireSeedSource(db, seed.companyId, target.missionId, seed.sourceRunId);
  const sourceDef = await loadExecutionDefinition(db, seed.sourceRunId, { requireHistorical: true });
  const targetDef = await loadExecutionDefinition(db, seed.targetRunId, { requireHistorical: true });
  const sourceStep = sourceDef.steps.find(s => s.id === seed.sourceStepId), targetStep = targetDef.steps.find(s => s.id === seed.targetStepId);
  if (!sourceStep || !targetStep || sourceDef.definitionHash !== evidence.sourceDefinitionHash
    || targetDef.definitionHash !== evidence.targetDefinitionHash || seedStepHash(sourceStep, sourceDef.steps, "seed", "current") !== evidence.stepConfigHash
    || seedStepHash(targetStep, targetDef.steps) !== evidence.stepConfigHash) throw seedError("definition_changed");
  const [row] = await db.select({ run: workflowRuns, step: workflowStepRuns }).from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId))
    .where(and(eq(workflowStepRuns.id, evidence.artifact.stepRunId), eq(workflowStepRuns.stepId, seed.sourceStepId)));
  if (!row || row.run.id !== seed.sourceRunId || row.run.companyId !== seed.companyId
    || row.step.id !== seed.sourceStepRunId) throw seedError("tool_output_scope_mismatch");
  const a = evidence.artifact;
  if (a.requestId !== row.step.lastDispatchRequestId || a.executionGeneration !== row.step.executionGeneration
    || a.retryCount !== row.step.retryCount || a.iterationIndex !== row.step.iterationIndex) throw seedError("source_attempt_changed");
  const current = await readToolStepSeedArtifact(db, { companyId: seed.companyId, run: row.run, stepRun: row.step });
  if (current.path !== a.path || current.sha256 !== a.sha256 || current.byteSize !== a.byteSize
    || current.stepRunId !== a.stepRunId) throw seedError("tool_output_record_changed");
  // [Q11] native tool 스텝의 실제 해석 인자 재검증 — agent seed 와 동일하게 원본 재렌더·재선택에 더해
  // 대상(현재 실행) 레코드 실제값 대조·대상 재렌더를 수행한다(토큰 없는 스텝은 바인딩이 없어 기존 동작).
  if (evidence.interpretedInputs) {
    await verifySeedInterpretedInputs(db, { companyId: seed.companyId, targetStepId: seed.targetStepId,
      binding: evidence.interpretedInputs, sourceRun: row.run, sourceStep, sourceSteps: sourceDef.steps,
      targetRun: target, targetStep, targetSteps: targetDef.steps });
  }
  return current;
}

/** Consumer-side verified read of a seeded tool artifact; null when the step has no tool-output seed. */
export async function readSeededToolArtifact(db: Db, scope: { companyId: string; workflowRunId: string; stepId: string }) {
  const seed = await findWorkflowSeed(db, scope);
  if (!seed || !parseToolSeedEvidence(seed.evidence)) return null;
  const [target] = await db.select().from(workflowStepRuns).where(and(eq(workflowStepRuns.id, seed.targetStepRunId),
    eq(workflowStepRuns.workflowRunId, seed.targetRunId), eq(workflowStepRuns.stepId, seed.targetStepId)));
  // Native retry/rework/resume counters retire initial seed authority, mirroring readSeededStepProducts.
  if (target && (target.executionGeneration > 0 || target.retryCount > 0 || target.iterationIndex > 0)) return null;
  if (!target || target.status !== "completed" || target.issueId !== null || target.executionGeneration !== 0
    || target.retryCount !== 0 || target.iterationIndex !== 0) throw seedError("target_attempt_changed");
  return verifyToolSeedEvidence(db, seed);
}
