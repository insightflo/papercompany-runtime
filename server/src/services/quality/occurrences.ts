import { and, eq, inArray, sql } from "drizzle-orm";
import { activityLog, heartbeatRuns, qualityOccurrences, qualityActions, qualityActionGroups, qualityPolicyUsage, qualityReviewItems } from "@paperclipai/db";
import type { ArtifactRef, SourceAttempt } from "@paperclipai/shared";
import { conflict } from "../../errors.js";
import { evidenceError, hashContract, occurrenceInputSchema, occurrenceSetSchema, parseEvidence, type QualityDb, type QualityTx } from "./contract.js";
import { readEvidence, readSourceEvidence, resolveEvidence } from "./evidence-store.js";
import { verifySourceAttempt } from "./evidence-verifier.js";

export async function writeOccurrence(db: QualityDb, input: {
  companyId: string; reviewItemId: string; producerRunId: string;
  submissionKey: string; source: SourceAttempt; evidence: ArtifactRef[];
}): Promise<{ occurrenceId: string; replayed: boolean }> {
  const value = parseEvidence(occurrenceInputSchema, input);
  if (value.companyId !== value.source.companyId) evidenceError("quality_scope_company_mismatch");
  if (value.producerRunId !== value.source.heartbeatRunId) evidenceError("quality_evidence_scope_mismatch");
  const payloadHash = hashContract(value);
  return db.transaction(async (tx) => {
    // One review's submissions serialize across processes; DB uniqueness remains the final guard.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`quality-occurrence:${value.companyId}:${value.reviewItemId}`}, 0))`);
    const identity = and(eq(qualityOccurrences.companyId, value.companyId), eq(qualityOccurrences.producerRunId, value.producerRunId), eq(qualityOccurrences.submissionKey, value.submissionKey));
    const [previous] = await tx.select().from(qualityOccurrences).where(identity);
    if (previous) {
      if (previous.payloadHash !== payloadHash) throw conflict("quality_occurrence_conflict", { code: "quality_occurrence_conflict" });
      return { occurrenceId: previous.id, replayed: true };
    }
    const [review] = await tx.select({ id: qualityReviewItems.id }).from(qualityReviewItems).where(and(eq(qualityReviewItems.companyId, value.companyId), eq(qualityReviewItems.id, value.reviewItemId)));
    if (!review) evidenceError("quality_evidence_scope_mismatch");
    await verifySourceAttempt(tx, value.companyId, value.source);
    const evidenceRefIds: string[] = [];
    for (const ref of value.evidence) {
      const evidence = await resolveEvidence(tx, value.companyId, ref);
      if (evidence.receipt.reviewItemId !== value.reviewItemId || hashContract(evidence.contract.source) !== hashContract(value.source)) evidenceError("quality_evidence_scope_mismatch");
      if (evidence.contract.scope) await readEvidence(tx, { companyId: value.companyId, ref, scope: evidence.contract.scope, maxBytes: evidence.asset.byteSize });
      else await readSourceEvidence(tx, { companyId: value.companyId, ref, source: value.source, maxBytes: evidence.asset.byteSize });
      evidenceRefIds.push(evidence.receipt.id);
    }
    const actions = await lockRelatedActions(tx, value.companyId, value.reviewItemId);
    const [producer] = await tx.select({ createdAt: heartbeatRuns.createdAt }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, value.companyId), eq(heartbeatRuns.id, value.producerRunId)));
    const [row] = await tx.insert(qualityOccurrences).values({
      companyId: value.companyId, reviewItemId: value.reviewItemId, producerRunId: value.producerRunId,
      submissionKey: value.submissionKey, payloadHash, sourceBinding: value.source, evidenceRefIds, occurredAt: producer.createdAt,
    }).onConflictDoNothing().returning({ id: qualityOccurrences.id });
    if (!row) {
      const [concurrent] = await tx.select().from(qualityOccurrences).where(identity);
      if (!concurrent || concurrent.payloadHash !== payloadHash) throw conflict("quality_occurrence_conflict", { code: "quality_occurrence_conflict" });
      return { occurrenceId: concurrent.id, replayed: true };
    }
    // New structured evidence changes the snapshot, not the fixed effect/intent or group budget.
    for (const action of actions) {
      const occurrenceIds = parseEvidence(occurrenceSetSchema, [...action.occurrenceIds, row.id]);
      await tx.update(qualityActions).set({ occurrenceIds, occurrenceSetHash: hashContract(occurrenceIds), revision: action.revision + 1, updatedAt: new Date() })
        .where(and(eq(qualityActions.companyId, value.companyId), eq(qualityActions.id, action.id)));
    }
    await tx.insert(activityLog).values({ companyId: value.companyId, actorType: "system", actorId: "quality", action: "quality.occurrence_recorded", entityType: "quality_occurrence", entityId: row.id, details: { reviewItemId: value.reviewItemId, revisedActionIds: actions.map((a) => a.id) } });
    return { occurrenceId: row.id, replayed: false };
  });
}

async function lockRelatedActions(tx: QualityTx, companyId: string, reviewItemId: string) {
  const related = await tx.select({ id: qualityActions.id, groupId: qualityActions.groupId, policyVersionId: qualityActions.policyVersionId }).from(qualityActions)
    .where(and(eq(qualityActions.companyId, companyId), sql`exists (select 1 from ${qualityOccurrences} where ${qualityOccurrences.companyId} = ${companyId} and ${qualityOccurrences.reviewItemId} = ${reviewItemId} and ${qualityActions.occurrenceIds} @> jsonb_build_array(${qualityOccurrences.id}::text))`));
  if (!related.length) return [];
  const policies = [...new Set(related.map((a) => a.policyVersionId))].sort();
  const groups = [...new Set(related.map((a) => a.groupId))].sort();
  await tx.select({ id: qualityPolicyUsage.id }).from(qualityPolicyUsage).where(and(eq(qualityPolicyUsage.companyId, companyId), inArray(qualityPolicyUsage.policyVersionId, policies))).orderBy(qualityPolicyUsage.id).for("update");
  await tx.select({ id: qualityActionGroups.id }).from(qualityActionGroups).where(and(eq(qualityActionGroups.companyId, companyId), inArray(qualityActionGroups.id, groups))).orderBy(qualityActionGroups.id).for("update");
  return tx.select().from(qualityActions).where(and(eq(qualityActions.companyId, companyId), inArray(qualityActions.id, related.map((a) => a.id)))).orderBy(qualityActions.id).for("update");
}
