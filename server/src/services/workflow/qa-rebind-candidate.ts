import { and, asc, eq } from "drizzle-orm";
import { activityLog, companies, missions, issueWorkProducts, workflowQaRebindClaims, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { workflowQaRebindClassificationResultSchema, type WorkflowQaRebindClassificationResult } from "@paperclipai/shared/validators/workflow-qa-rebind";
import { readQaReceiptBytes } from "./qa-artifact-receipt.js";
import { readQaRebindContext, publicationFence, producerFence, type QaRebindCandidateScope } from "./qa-rebind-evidence.js";
import type { DbOrTx } from "./execution-definition.js";
import { readObject } from "./core-tool-context.js";
import { logger } from "../../middleware/logger.js";
import { isQaRebindRecoveryEnabled } from "./qa-rebind-recovery-flag.js";
export type { QaRebindCandidateScope } from "./qa-rebind-evidence.js";

/** Deterministic DB/hash evidence only. Never consult comments, stdout, error prose or live source content. */
export async function classifyQaRebindCandidate(db: Db, scope: QaRebindCandidateScope): Promise<WorkflowQaRebindClassificationResult | null> {
  const c = await readQaRebindContext(db, scope);
  if (!c) return null;
  const result = (status: WorkflowQaRebindClassificationResult["status"], reasonCode: WorkflowQaRebindClassificationResult["reasonCode"]) =>
    workflowQaRebindClassificationResultSchema.parse({ schemaVersion: "workflow.qa-rebind-classification.v1", status, reasonCode,
      bundleDigest: c.bundleDigest, expectedDigests: c.expectedDigests,
      authorityVersion: c.run.dispatchAuthorityVersion, executionGeneration: c.step.executionGeneration });
  const publication = await publicationFence(db, c);
  if (publication === "publication_unproven") return result("blocked", publication);
  const r = c.receipt;
  if (r && (r.companyId !== c.run.companyId || r.workflowRunId !== c.run.id || r.missionId !== c.run.missionId))
    return result("excluded", "receipt_scope_mismatch");
  if (r?.schemaVersion === "workflow.tool-artifact.v1") return result("card_required", "receipt_v1_no_contract_hash");
  if (c.rows.some(({ step }) => step.metadata.failureCascadeSkipped === true)) return result("card_required", "failure_cascade_skipped");
  if (publication === "published_same_qa") return result("card_required", publication);
  if (!c.execution || !c.frozen || c.role !== "publication" || c.step.issueId !== null)
    return result("excluded", "contract_invalid");
  if (!r || !c.qa || c.qa.status !== "completed") return result("card_required", "receipt_unavailable");
  try {
    // Reuses completion-strength receipt validation and frozen input/asset/result byte checks.
    // Explicit mission validation above closes readQaReceiptBytes' receipt-derived mission shortcut.
    await readQaReceiptBytes(db, { companyId: c.run.companyId, workflowRunId: c.run.id, stepId: c.qa.stepId });
  } catch { return result("blocked", "frozen_digest_mismatch"); }
  const producer = await producerFence(db, c);
  if (producer) return result(producer === "producer_bytes_mismatch" ? "blocked" : "card_required", producer);
  return result("auto_eligible", "generation_only");
}

/** This selects an observation path only; classification independently validates all contracts. */
export function isQaRebindConsumer(issueId: string | null, definition: unknown, metadata: unknown) {
  const role = readObject(readObject(readObject(metadata).artifactExecution).contract).role
    ?? readObject(readObject(definition).toolArtifactContract).role;
  return issueId === null && (role === "publication" || role === "publication-verify");
}

/** Failure writer only: savepoint isolation keeps observation failures from changing execution. */
export async function persistQaRebindCandidate(db: DbOrTx, scope: QaRebindCandidateScope) {
  try {
    return await db.transaction(async tx => {
      const c = await readQaRebindContext(tx, scope);
      if (!c || c.step.issueId !== null || c.step.status !== "failed"
        || (c.role !== "publication" && c.role !== "publication-verify")) return null;
      const [row] = await tx.insert(workflowQaRebindClaims).values({
        companyId: c.run.companyId, workflowRunId: c.run.id, consumerStepRunId: c.step.id, consumerStepId: c.step.stepId,
        bundleDigest: c.bundleDigest, expectedDigests: c.expectedDigests,
        authorityVersion: c.run.dispatchAuthorityVersion, executionGeneration: c.step.executionGeneration,
        requestId: c.step.lastDispatchRequestId, status: "candidate",
      }).onConflictDoNothing().returning();
      return row ?? null;
    });
  } catch (error) {
    logger.warn({ ...scope, err: error instanceof Error ? error.message : String(error) }, "QA rebind candidate observation failed");
    return null;
  }
}

/** B is opt-in. Human cards are independent of that flag and use the same strict recovery. */
export async function sweepQaRebindCandidates(db: Db, now = new Date()): Promise<number> {
  let classified = 0;
  // Enumerate tenants, then scope every candidate/run/step query to that tenant.
  for (const { id: companyId } of await db.select({ id: companies.id }).from(companies)) {
    const pending = await db.select({ candidate: workflowQaRebindClaims }).from(workflowQaRebindClaims)
      .innerJoin(workflowRuns, eq(workflowRuns.id, workflowQaRebindClaims.workflowRunId)).where(and(
        eq(workflowQaRebindClaims.companyId, companyId), eq(workflowRuns.companyId, companyId),
        eq(workflowQaRebindClaims.status, "candidate"), eq(workflowRuns.status, "failed")));
    for (const { candidate } of pending) {
      classified += await db.transaction(async tx => {
        // Mission → run → steps → product → claim, including observation paths.
        const [scopeRun] = await tx.select({ missionId: workflowRuns.missionId }).from(workflowRuns).where(and(
          eq(workflowRuns.companyId, companyId), eq(workflowRuns.id, candidate.workflowRunId)));
        if (scopeRun?.missionId) await tx.select({ id: missions.id }).from(missions).where(and(
          eq(missions.companyId, companyId), eq(missions.id, scopeRun.missionId))).for("share");
        const [run] = await tx.select().from(workflowRuns).where(and(
          eq(workflowRuns.companyId, companyId), eq(workflowRuns.id, candidate.workflowRunId))).for("share");
        if (!run || run.status !== "failed" || run.missionId !== scopeRun?.missionId) return 0;
        await tx.select({ id: workflowStepRuns.id }).from(workflowStepRuns)
          .innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId)).where(and(
            eq(workflowRuns.companyId, companyId), eq(workflowRuns.id, run.id)))
          .orderBy(asc(workflowStepRuns.id)).for("share", { of: workflowStepRuns });
        const scope = { companyId, workflowRunId: run.id, consumerStepRunId: candidate.consumerStepRunId };
        const classification = await classifyQaRebindCandidate(tx as unknown as Db, scope);
        if (!classification) return 0;
        const current = await readQaRebindContext(tx, scope);
        if (!current || current.step.status !== "failed") return 0;
        if (classification.bundleDigest !== candidate.bundleDigest) {
          classification.status = "excluded";
          classification.reasonCode = "candidate_target_changed";
        }
        if (current.expectedDigests) await tx.select({ id: issueWorkProducts.id }).from(issueWorkProducts).where(and(
          eq(issueWorkProducts.companyId, companyId), eq(issueWorkProducts.id, current.expectedDigests.workProductId))).for("share");
        const [updated] = await tx.update(workflowQaRebindClaims).set({
          status: classification.status, reasonCode: classification.reasonCode,
          authorityVersion: classification.authorityVersion, executionGeneration: classification.executionGeneration,
          classifiedAt: now, updatedAt: now,
        }).where(and(eq(workflowQaRebindClaims.companyId, companyId), eq(workflowQaRebindClaims.id, candidate.id),
          eq(workflowQaRebindClaims.status, "candidate"))).returning({ id: workflowQaRebindClaims.id });
        if (!updated) return 0;
        await tx.insert(activityLog).values({ companyId, actorType: "system", actorId: "qa-rebind-observer",
          action: "workflow.qa_rebind_classified", entityType: "workflow_qa_rebind_claim", entityId: candidate.id,
          details: classification });
        return 1;
      });
    }
    if (await isQaRebindRecoveryEnabled(db, companyId)) {
      const { recoverAutoEligibleQaRebindCandidates } = await import("./qa-rebind-recovery.js");
      await recoverAutoEligibleQaRebindCandidates(db, companyId);
    }
    const { sweepQaRebindCards } = await import("./qa-rebind-card.js");
    await sweepQaRebindCards(db, companyId);
  }
  return classified;
}
