import { and, eq, is, isNull, sql } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { workflowStepOutputBindings as bindings } from "@paperclipai/db";
import { requireQaCorrection, type QaCorrectionDb } from "./qa-correction-authority.js";
import type { QaCorrectionApplied, QaCorrectionPreparation } from "./qa-correction-contract.js";

export type QaCorrectionBindingSnapshot = {
  bindingId: string;
  sourceExecutionGeneration: number | null;
  resolvedAt: string;
};

/** Observe under preparation locks, before IO. Keep PostgreSQL's full timestamp precision. */
export async function readQaCorrectionCommitBindings(
  db: QaCorrectionDb, p: QaCorrectionPreparation,
): Promise<QaCorrectionBindingSnapshot[]> {
  const snapshots: QaCorrectionBindingSnapshot[] = [];
  for (const expected of p.bindings) {
    const [found] = await db.select({ row: bindings, resolvedAt: sql<string>`${bindings.resolvedAt}::text` })
      .from(bindings).where(eq(bindings.id, expected.bindingId));
    requireQaCorrection(found && found.row.companyId === p.companyId
      && found.row.workflowRunId === p.workflowRunId
      && found.row.consumerStepRunId === expected.consumer.stepRunId
      && found.row.referencedStepId === expected.referencedStepId
      && expected.referencedStepId === p.producer.stepId
      && found.row.workProductId === expected.expectedProductId
      && (found.row.sourceExecutionGeneration === null
        || found.row.sourceExecutionGeneration === p.producer.executionGeneration), "binding");
    snapshots.push({ bindingId: expected.bindingId,
      sourceExecutionGeneration: found.row.sourceExecutionGeneration, resolvedAt: found.resolvedAt });
  }
  return snapshots;
}

/** C03: replace only the prepared rows. Any unsuccessful CAS escapes the owning transaction. */
export async function replaceQaCorrectionCommitBindings(
  tx: QaCorrectionDb, p: QaCorrectionPreparation, snapshots: readonly QaCorrectionBindingSnapshot[],
  revisions: QaCorrectionApplied["revisions"], appliedAt: Date,
): Promise<QaCorrectionApplied["bindingChanges"]> {
  requireQaCorrection(is(tx, PgTransaction) && snapshots.length === p.bindings.length
    && new Set(snapshots.map(s => s.bindingId)).size === snapshots.length, "binding");
  const changes: QaCorrectionApplied["bindingChanges"] = [];
  for (const expected of p.bindings) {
    const snapshot = snapshots.find(s => s.bindingId === expected.bindingId);
    const revision = revisions.find(r => r.sourceProductId === expected.expectedProductId);
    requireQaCorrection(snapshot && revision, "binding");
    const changed = await tx.update(bindings).set({
      workProductId: revision.workProductId, resolvedAt: appliedAt,
    }).where(and(
      eq(bindings.id, expected.bindingId), eq(bindings.companyId, p.companyId),
      eq(bindings.workflowRunId, p.workflowRunId),
      eq(bindings.consumerStepRunId, expected.consumer.stepRunId),
      eq(bindings.referencedStepId, expected.referencedStepId),
      eq(bindings.workProductId, expected.expectedProductId),
      snapshot.sourceExecutionGeneration === null ? isNull(bindings.sourceExecutionGeneration)
        : eq(bindings.sourceExecutionGeneration, snapshot.sourceExecutionGeneration),
      eq(bindings.resolvedAt, sql`${snapshot.resolvedAt}::timestamptz`),
    )).returning({ id: bindings.id });
    requireQaCorrection(changed.length === 1, "binding");
    changes.push({ bindingId: expected.bindingId, fromProductId: expected.expectedProductId,
      toProductId: revision.workProductId });
  }
  return changes;
}
