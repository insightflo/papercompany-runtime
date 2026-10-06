import { and, eq, inArray } from "drizzle-orm";
import { activityLog, issueWorkProducts, missions, operatorDecisions, workflowQaRebindClaims, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { loadCompanySystemLanguage } from "../missions/system-language.js";
import { validateAndHashOperatorDecisionCreate } from "../operator-decision-result.js";
import { buildQaRebindCard } from "./qa-rebind-card-display.js";
import { QA_REBIND_CARD_SOURCE_TYPE, qaRebindApprovalTargetHash, qaRebindCardRequestKey, qaRebindCardTargetChanged, readQaRebindCard, type QaRebindClaim } from "./qa-rebind-card-contract.js";
import { readQaRebindContext } from "./qa-rebind-evidence.js";
import { persistQaRebindCandidate } from "./qa-rebind-candidate.js";
import { retryIssueLessToolWorkflowStep } from "./dag-engine.js";
import { logger } from "../../middleware/logger.js";
import { workflowQaRebindExpectedDigestsSchema } from "@paperclipai/shared/validators/workflow-qa-rebind";

/** Also permits terminal runs/inactive missions for cleanup, not recovery. */
async function lockCardScope(db: Db, candidate: QaRebindClaim) {
  const [scope] = await db.select({ missionId: workflowRuns.missionId }).from(workflowRuns).where(and(
    eq(workflowRuns.companyId, candidate.companyId), eq(workflowRuns.id, candidate.workflowRunId)));
  if (!scope) return null;
  if (scope.missionId) await db.select({ id: missions.id }).from(missions).where(and(
    eq(missions.companyId, candidate.companyId), eq(missions.id, scope.missionId))).for("update");
  const [run] = await db.select().from(workflowRuns).where(and(
    eq(workflowRuns.companyId, candidate.companyId), eq(workflowRuns.id, candidate.workflowRunId))).for("update");
  if (!run || run.missionId !== scope.missionId) return null;
  const steps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, run.id))
    .orderBy(workflowStepRuns.id).for("update");
  const expected = workflowQaRebindExpectedDigestsSchema.safeParse(candidate.expectedDigests);
  if (expected.success) await db.select({ id: issueWorkProducts.id }).from(issueWorkProducts).where(and(
    eq(issueWorkProducts.companyId, candidate.companyId), eq(issueWorkProducts.id, expected.data.workProductId))).for("update");
  return { run, steps };
}
const candidateWhere = (companyId: string, id: string) => and(eq(workflowQaRebindClaims.companyId, companyId), eq(workflowQaRebindClaims.id, id));

/** Independent of B's flag. Nested transactions isolate card/audit errors from execution. */
export async function ensureQaRebindCard(db: Db, companyId: string, candidateId: string) {
  return db.transaction(async tx => {
    const language = await loadCompanySystemLanguage(tx as unknown as Db, companyId);
    const [observed] = await tx.select().from(workflowQaRebindClaims).where(candidateWhere(companyId, candidateId));
    if (!observed || observed.status !== "card_required") return null;
    const scope = await lockCardScope(tx as unknown as Db, observed);
    if (!scope || scope.run.status !== "failed") return null;
    const c = await readQaRebindContext(tx, { companyId, workflowRunId: observed.workflowRunId, consumerStepRunId: observed.consumerStepRunId });
    if (!c || c.step.status !== "failed") return null;
    if (c.expectedDigests) await tx.select({ id: issueWorkProducts.id }).from(issueWorkProducts).where(and(
      eq(issueWorkProducts.companyId, companyId), eq(issueWorkProducts.id, c.expectedDigests.workProductId))).for("update");
    if (c.bundleDigest !== observed.bundleDigest) {
      // The old stable bundle claim is never repurposed. Classify the new bundle next sweep.
      await persistQaRebindCandidate(tx, { companyId, workflowRunId: c.run.id, consumerStepRunId: c.step.id });
      return null;
    }
    const [candidate] = await tx.update(workflowQaRebindClaims).set({ authorityVersion: c.run.dispatchAuthorityVersion,
      executionGeneration: c.step.executionGeneration }).where(and(candidateWhere(companyId, candidateId),
        eq(workflowQaRebindClaims.status, "card_required"))).returning();
    if (!candidate) return null;
    const hash = qaRebindApprovalTargetHash(candidate);
    const requestKey = qaRebindCardRequestKey(candidate.workflowRunId, candidate.consumerStepId, hash);
    const load = async () => (await tx.select().from(operatorDecisions).where(and(
      eq(operatorDecisions.companyId, companyId), eq(operatorDecisions.requestKey, requestKey))))[0];
    const replay = await load();
    if (replay) return readQaRebindCard(replay, candidate) ? { decision: replay, replayed: true } : null;
    const { input, requestHash } = validateAndHashOperatorDecisionCreate(buildQaRebindCard(candidate, c.run.missionId,
      hash, scope.steps.some(s => s.metadata.failureCascadeSkipped === true), language));
    // The unique key chooses the first stored language; never submit new text to shared replay hashing.
    const [created] = await tx.insert(operatorDecisions).values({ ...input, companyId, requestHash,
      requestedByUserId: "system:qa-rebind-card" }).onConflictDoNothing().returning();
    if (!created) {
      const winner = await load();
      return winner && readQaRebindCard(winner, candidate) ? { decision: winner, replayed: true } : null;
    }
    await tx.insert(activityLog).values({ companyId, actorType: "system", actorId: "qa-rebind-card",
      action: "operator_decision.created", entityType: "operator_decision", entityId: created.id,
      details: { schemaVersion: "workflow.qa-rebind-card.v1", candidateId, approvalTargetHash: hash, requestKey: input.requestKey } });
    return { decision: created, replayed: false };
  }).catch(err => {
    logger.warn({ err, companyId, candidateId }, "QA rebind card observation deferred");
    return null;
  });
}

async function dismissCard(db: Db, candidate: QaRebindClaim, card: typeof operatorDecisions.$inferSelect) {
  await db.transaction(async tx => {
    if (!await lockCardScope(tx as unknown as Db, candidate)) return;
    const [current] = await tx.select().from(operatorDecisions).where(and(eq(operatorDecisions.companyId, candidate.companyId), eq(operatorDecisions.id, card.id)));
    if (!current || readQaRebindCard(current, candidate)?.selection !== "dismiss") return;
    const [updated] = await tx.update(workflowQaRebindClaims).set({ status: "dismissed", updatedAt: new Date() })
      .where(and(candidateWhere(candidate.companyId, candidate.id), eq(workflowQaRebindClaims.status, "card_required"))).returning({ id: workflowQaRebindClaims.id });
    if (updated) await tx.insert(activityLog).values({ companyId: candidate.companyId, actorType: "system", actorId: "qa-rebind-card",
      action: "workflow.qa_rebind_dismissed", entityType: "workflow_qa_rebind_claim", entityId: candidate.id,
      details: { schemaVersion: "workflow.qa-rebind-card-outcome.v1", operatorDecisionId: card.id, outcome: "dismissed" } });
  });
}

async function cancelTerminalCards(db: Db, candidate: QaRebindClaim, cards: (typeof operatorDecisions.$inferSelect)[]) {
  await db.transaction(async tx => {
    const scope = await lockCardScope(tx as unknown as Db, candidate);
    if (!scope || !["completed", "cancelled"].includes(scope.run.status)) return;
    for (const card of cards) {
      if (!readQaRebindCard(card, candidate)) continue;
      // Exact machine-validated identity AND exact requestKey, never prefix/fuzzy matching.
      const [cancelled] = await tx.update(operatorDecisions).set({ status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() })
        .where(and(eq(operatorDecisions.companyId, candidate.companyId), eq(operatorDecisions.id, card.id),
          eq(operatorDecisions.requestKey, card.requestKey), eq(operatorDecisions.status, "pending"))).returning({ id: operatorDecisions.id });
      if (cancelled) await tx.insert(activityLog).values({ companyId: candidate.companyId, actorType: "system", actorId: "qa-rebind-card",
        action: "operator_decision.cancelled", entityType: "operator_decision", entityId: card.id,
        details: { schemaVersion: "workflow.qa-rebind-card-outcome.v1", reason: `run_${scope.run.status}`, requestKey: card.requestKey } });
    }
  });
}

/** Read durable resolved option IDs only. Approval enters the exact B strict wrapper, not a second reset path. */
export async function sweepQaRebindCards(db: Db, companyId: string) {
  const candidates = await db.select({ candidate: workflowQaRebindClaims, run: workflowRuns }).from(workflowQaRebindClaims)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowQaRebindClaims.workflowRunId)).where(and(
      eq(workflowQaRebindClaims.companyId, companyId), eq(workflowRuns.companyId, companyId),
      inArray(workflowRuns.status, ["failed", "completed", "cancelled"])));
  for (const { candidate, run } of candidates) {
    try {
      const cards = (await db.select().from(operatorDecisions).where(and(eq(operatorDecisions.companyId, companyId),
        eq(operatorDecisions.sourceType, QA_REBIND_CARD_SOURCE_TYPE)))).filter(card => readQaRebindCard(card, candidate));
      if (["completed", "cancelled"].includes(run.status)) {
        // Skip lock acquisition for historical runs with nothing left to cancel.
        if (cards.some(card => card.status === "pending")) await cancelTerminalCards(db, candidate, cards);
        continue;
      }
      if (candidate.status !== "card_required") continue;
      for (const card of cards) {
        const authority = readQaRebindCard(card, candidate);
        if (authority?.selection === "dismiss") await dismissCard(db, candidate, card);
        if (authority?.selection !== "approve") continue;
        if (await qaRebindCardTargetChanged(db, candidate, card.id, authority.approvalTargetHash)) continue;
        await retryIssueLessToolWorkflowStep(db, { companyId, runId: candidate.workflowRunId, stepId: candidate.consumerStepId,
          recoveryRequestReference: `qa-rebind:${candidate.id}`, expectedFailure: { stepRunId: candidate.consumerStepRunId,
            authorityVersion: candidate.authorityVersion, executionGeneration: candidate.executionGeneration, dispatchRequestId: candidate.requestId },
          qaRebind: { candidateId: candidate.id, bundleDigest: candidate.bundleDigest, authorityVersion: candidate.authorityVersion,
            executionGeneration: candidate.executionGeneration, operatorDecisionId: card.id } });
      }
      await ensureQaRebindCard(db, companyId, candidate.id);
    } catch (err) { logger.warn({ err, companyId, candidateId: candidate.id }, "QA rebind card sweep deferred"); }
  }
}
