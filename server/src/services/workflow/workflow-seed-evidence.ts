import path from "node:path";
import { and, eq } from "drizzle-orm";
import { heartbeatRuns, missions, workflowRuns, workflowRunSeeds, workflowStepRuns, type Db } from "@paperclipai/db";
import { workflowSeedEvidenceSchema } from "@paperclipai/shared/validators/workflow-seed";
import { unprocessable } from "../../errors.js";
import { hashStructuredValue } from "../issue-execution-cards/hash.js";
import { resolveMissionWorkProductPaths } from "../work-products/output-paths.js";
import { captureArtifactRoot, readArtifactBytes, digest } from "./artifact-files.js";
import { loadExecutionDefinition } from "./execution-definition.js";
import { selectSameRunWorkProduct } from "./workproduct-same-run.js";
import { revisionStepHash } from "./revision-step-config.js";
import { parseToolSeedEvidence, verifyToolSeedEvidence } from "./workflow-seed-tool-output.js";
import { verifySeedInterpretedInputs } from "./seed-interpreted-inputs.js";

export const seedError = (reason: string, details: Record<string, unknown> = {}) =>
  unprocessable(`workflow_seed_${reason}`, { code: `workflow_seed_${reason}`, ...details });
export const seedStepHash = revisionStepHash;

export async function requireSeedSource(db: Db, companyId: string, targetMissionId: string | null | undefined, sourceRunId: string) {
  if (!targetMissionId) throw seedError("linked_mission_required");
  const [target] = await db.select().from(missions).where(and(eq(missions.id, targetMissionId), eq(missions.companyId, companyId)));
  const [source] = await db.select().from(workflowRuns).where(and(eq(workflowRuns.id, sourceRunId), eq(workflowRuns.companyId, companyId)));
  if (!source?.missionId || !target?.sourceMissionId || target.sourceWorkflowRunId !== source.id
    || source.missionId !== target.sourceMissionId || source.missionId === target.id) throw seedError("source_scope_mismatch");
  const [mission] = await db.select().from(missions).where(and(eq(missions.id, source.missionId), eq(missions.companyId, companyId)));
  if (!mission) throw seedError("source_scope_mismatch");
  return { source, mission };
}

export async function verifySeedProductBytes(db: Db, selected: Awaited<ReturnType<typeof selectSameRunWorkProduct>>) {
  const { product, producer, file } = selected;
  const [heartbeat] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, producer.heartbeatRunId), eq(heartbeatRuns.companyId, producer.companyId)));
  if (heartbeat?.status !== "succeeded") throw seedError("source_incomplete");
  const sha256 = product.metadata?.sha256;
  if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) throw seedError("sha_missing");
  const paths = await resolveMissionWorkProductPaths(db, { companyId: producer.companyId, missionId: producer.missionId });
  if (!paths) throw seedError("artifact_root_missing");
  try {
    const root = await captureArtifactRoot(paths.missionOutputDir);
    const bytes = await readArtifactBytes(root, path.relative(root.path, file), 32 * 1024 * 1024);
    if (digest(bytes) !== sha256) throw seedError("sha_mismatch");
    return { sha256, root, bytes };
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("workflow_seed_")) throw e;
    throw seedError("artifact_unreadable");
  }
}

/** Revalidate the original attempt and bytes, never restamp a producer for the target. */
export async function verifySeedEvidence(db: Db, seed: typeof workflowRunSeeds.$inferSelect, visited?: Set<string>): Promise<Array<Awaited<ReturnType<typeof selectSameRunWorkProduct>>>> {
  // Native tool-output seeds carry no issue work products; their artifact verifies on its own spine.
  if (parseToolSeedEvidence(seed.evidence)) { await verifyToolSeedEvidence(db, seed); return []; }
  const evidence = workflowSeedEvidenceSchema.safeParse(seed.evidence);
  if (!evidence.success || !seed.approvedByUserId) throw seedError("provenance_invalid");
  const [target] = await db.select().from(workflowRuns).where(and(eq(workflowRuns.id, seed.targetRunId), eq(workflowRuns.companyId, seed.companyId)));
  await requireSeedSource(db, seed.companyId, target?.missionId, seed.sourceRunId);
  const sourceDef = await loadExecutionDefinition(db, seed.sourceRunId, { requireHistorical: true });
  const targetDef = await loadExecutionDefinition(db, seed.targetRunId, { requireHistorical: true });
  const sourceStep = sourceDef.steps.find(s => s.id === seed.sourceStepId), targetStep = targetDef.steps.find(s => s.id === seed.targetStepId);
  if (!sourceStep || !targetStep || sourceDef.definitionHash !== evidence.data.sourceDefinitionHash
    || targetDef.definitionHash !== evidence.data.targetDefinitionHash || seedStepHash(sourceStep, sourceDef.steps, "seed", "current") !== evidence.data.stepConfigHash
    || seedStepHash(targetStep, targetDef.steps) !== evidence.data.stepConfigHash) throw seedError("definition_changed");
  const [sourceStepRun] = await db.select().from(workflowStepRuns).where(and(eq(workflowStepRuns.id, seed.sourceStepRunId),
    eq(workflowStepRuns.workflowRunId, seed.sourceRunId), eq(workflowStepRuns.stepId, seed.sourceStepId)));
  if (!sourceStepRun || sourceStepRun.status !== "completed") throw seedError("source_attempt_changed");
  // [Q11] 실제 해석 입력 재검증: 승인 때 바인딩한 실제 인자값과 지금 재렌더한 원본 좌표 값이 같아야 물화된다.
  if (evidence.data.interpretedInputs) {
    const [bindingSourceRun] = await db.select().from(workflowRuns).where(and(eq(workflowRuns.id, seed.sourceRunId),
      eq(workflowRuns.companyId, seed.companyId)));
    if (!bindingSourceRun) throw seedError("source_attempt_changed");
    await verifySeedInterpretedInputs(db, { companyId: seed.companyId, targetStepId: seed.targetStepId,
      binding: evidence.data.interpretedInputs, sourceRun: bindingSourceRun, sourceStep, sourceSteps: sourceDef.steps });
  }
  const seen = visited ?? new Set<string>();
  if (seen.has(seed.sourceStepRunId)) throw seedError("provenance_invalid");
  seen.add(seed.sourceStepRunId);
  // Inherited (seeded) sources resolve their upstream chain once, outside the product loop, so a
  // multi-product source never false-positives the shared cycle guard on a second traversal.
  const upstream = sourceStepRun.issueId === null
    ? await readSeededStepProducts(db, { companyId: seed.companyId, workflowRunId: seed.sourceRunId, stepId: seed.sourceStepId }, seen)
    : null;
  const products = [];
  for (const saved of evidence.data.products) {
    if (sourceStepRun.issueId !== null) {
      let selected;
      try {
        selected = await selectSameRunWorkProduct(db, { companyId: seed.companyId, workflowRunId: seed.sourceRunId,
          stepId: seed.sourceStepId, selector: { type: saved.type, title: saved.title }, pinnedId: saved.id });
      } catch { throw seedError("source_attempt_changed"); }
      if (selected.product.status === "archived" || selected.producer.stepRunId !== seed.sourceStepRunId
        || hashStructuredValue(selected.producer) !== hashStructuredValue(saved.producer) || selected.file !== saved.path) throw seedError("provenance_changed");
      const verified = await verifySeedProductBytes(db, selected);
      if (verified.sha256 !== saved.sha256) throw seedError("sha_mismatch");
      products.push(selected);
    } else {
      const match = upstream?.find(s => s.product.id === saved.id);
      if (!match || match.product.type !== saved.type || match.product.title !== saved.title || match.file !== saved.path
        || hashStructuredValue(match.producer) !== hashStructuredValue(saved.producer)) throw seedError("provenance_changed");
      if (match.product.metadata?.sha256 !== saved.sha256) throw seedError("sha_mismatch");
      products.push(match);
    }
  }
  return products;
}

export async function findWorkflowSeed(db: Db, scope: { companyId: string; workflowRunId: string; stepId: string }) {
  const [seed] = await db.select().from(workflowRunSeeds).where(and(eq(workflowRunSeeds.companyId, scope.companyId),
    eq(workflowRunSeeds.targetRunId, scope.workflowRunId), eq(workflowRunSeeds.targetStepId, scope.stepId)));
  return seed ?? null;
}

export async function readSeededStepProducts(db: Db, scope: { companyId: string; workflowRunId: string; stepId: string }, visited?: Set<string>): Promise<Array<Awaited<ReturnType<typeof selectSameRunWorkProduct>>> | null> {
  const seed = await findWorkflowSeed(db, scope);
  if (!seed) return null;
  const [target] = await db.select().from(workflowStepRuns).where(and(eq(workflowStepRuns.id, seed.targetStepRunId),
    eq(workflowStepRuns.workflowRunId, seed.targetRunId), eq(workflowStepRuns.stepId, seed.targetStepId)));
  // Native retry/rework/resume counters retire initial seed authority. The ordinary selector
  // must prove a newly admitted same-run producer; never fall back to the old seed on failure.
  if (target && (target.executionGeneration > 0 || target.retryCount > 0 || target.iterationIndex > 0)) return null;
  if (!target || target.status !== "completed" || target.issueId !== null || target.executionGeneration !== 0
    || target.retryCount !== 0 || target.iterationIndex !== 0) throw seedError("target_attempt_changed");
  return verifySeedEvidence(db, seed, visited);
}
