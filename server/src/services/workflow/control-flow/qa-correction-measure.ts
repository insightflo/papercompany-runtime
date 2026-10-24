import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { workflowTransitionEvents, type Db } from "@paperclipai/db";
import { QaCorrectionReadError, parseQaCorrectionPreparationRow, readQaCorrectionReservation,
  requireQaCorrection, type QaCorrectionDb } from "./qa-correction-authority.js";
import { hashQaCorrectionPayload, parseQaCorrectionEventPayload, qaCorrectionSourceMeasuredKey,
  qaCorrectionSourceMeasuredSchema, type QaCorrectionPreparation, type QaCorrectionSourceMeasured } from "./qa-correction-contract.js";
import { withCurrentQaCorrectionPreparation } from "./qa-correction-prepare.js";
import { observeQaCorrectionSources, readQaCorrectionSourceBytes, qaCorrectionSourceFacts } from "./qa-correction-source-bytes.js";

const preparationRefSchema = z.object({
  preparationEventId: z.string().uuid(), preparationHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type PreparationRef = z.infer<typeof preparationRefSchema>;
export type MeasuredRef = PreparationRef & {
  sourceMeasuredEventId: string; sourceMeasuredHash: string; sourceMeasured: QaCorrectionSourceMeasured;
};
type Event = typeof workflowTransitionEvents.$inferSelect;
async function measuredRow(db: QaCorrectionDb, p: QaCorrectionPreparation) {
  const [row] = await db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, p.companyId),
    eq(workflowTransitionEvents.idempotencyKey, qaCorrectionSourceMeasuredKey(p.correctionId))));
  return row;
}
function checkedMeasurement(row: Event, p: QaCorrectionPreparation, proof: PreparationRef): MeasuredRef {
  let m: QaCorrectionSourceMeasured;
  try { m = parseQaCorrectionEventPayload("qa_correction_source_measured", row.payload); }
  catch { throw new QaCorrectionReadError("record"); }
  requireQaCorrection(row.id !== p.correctionId && row.eventType === "qa_correction_source_measured"
    && row.companyId === p.companyId && row.missionId === p.missionId && row.workflowRunId === p.workflowRunId
    && row.workflowStepRunId === p.producer.stepRunId && row.issueId === p.producer.issueId
    && row.executionGeneration === p.producer.executionGeneration && row.layer === "workflow_validation"
    && row.idempotencyKey === qaCorrectionSourceMeasuredKey(p.correctionId)
    && m.preparationEventId === proof.preparationEventId && m.preparationHash === proof.preparationHash
    && row.createdAt.getTime() === Date.parse(m.measuredAt) && Date.parse(m.measuredAt) >= Date.parse(p.preparedAt)
    && m.sources.length === p.sources.length && m.sources.every(s => p.sources.some(old => old.productId === s.productId)), "record");
  return { ...proof, sourceMeasuredEventId: row.id, sourceMeasuredHash: hashQaCorrectionPayload(row.payload), sourceMeasured: m };
}
const measuredRefSchema = preparationRefSchema.extend({
  sourceMeasuredEventId: z.string().uuid(), sourceMeasuredHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceMeasured: qaCorrectionSourceMeasuredSchema,
}).strict();

/** C03: historical SELECT-only proof of the original measurement, not current issuance authority. */
export async function readMeasuredQaCorrection(db: QaCorrectionDb, expected: MeasuredRef):
  Promise<{ preparation: QaCorrectionPreparation; measured: MeasuredRef }> {
  const parsed = measuredRefSchema.safeParse(expected);
  requireQaCorrection(parsed.success, "record");
  const ref = parsed.data, proof = { preparationEventId: ref.preparationEventId, preparationHash: ref.preparationHash };
  requireQaCorrection(hashQaCorrectionPayload(expected.sourceMeasured) === ref.sourceMeasuredHash, "record");
  const [prepared] = await db.select().from(workflowTransitionEvents)
    .where(eq(workflowTransitionEvents.id, proof.preparationEventId));
  requireQaCorrection(prepared, "record");
  const preparation = parseQaCorrectionPreparationRow(prepared);
  await readQaCorrectionReservation(db, preparation, proof);
  const row = await measuredRow(db, preparation);
  requireQaCorrection(row && row.id === ref.sourceMeasuredEventId, "record");
  const measured = checkedMeasurement(row, preparation, proof);
  requireQaCorrection(isDeepStrictEqual(measured, ref), "record");
  return { preparation, measured };
}

function sortedSources(sources: QaCorrectionSourceMeasured["sources"]) {
  return sources.map(s => ({ ...s, files: [...s.files].sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0) }))
    .sort((a, b) => a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0);
}

/** C03/C12: first valid whole-source observation is fixed for this preparation, never rebased. */
export async function measureQaCorrectionSources(db: Db, candidate: PreparationRef): Promise<MeasuredRef> {
  const parsed = preparationRefSchema.safeParse(candidate);
  requireQaCorrection(parsed.success, "record");
  const proof = parsed.data;
  const [prepared] = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, proof.preparationEventId));
  requireQaCorrection(prepared, "record");
  const p = parseQaCorrectionPreparationRow(prepared), handle = { ...proof, preparation: p };
  await readQaCorrectionReservation(db, p, proof);
  // Reject historical/non-current handles before any filesystem operation; this also rolls back +0 materialization.
  const before = await withCurrentQaCorrectionPreparation(db, handle, async () => ({ effect: "noop", value: null }));
  requireQaCorrection(before.status === "current", "stale");
  const observed = await observeQaCorrectionSources(db, p);
  const bytes = await readQaCorrectionSourceBytes(p, observed), sources = qaCorrectionSourceFacts(bytes);
  const result = await withCurrentQaCorrectionPreparation(db, handle, async (tx, current) => {
    requireQaCorrection(isDeepStrictEqual(observed, await observeQaCorrectionSources(tx, current.preparation)), "stale");
    const previous = await measuredRow(tx, p);
    if (previous) return { effect: "noop", value: checkedMeasurement(previous, p, proof) };
    const now = new Date(Math.max(Date.now(), Date.parse(p.preparedAt)));
    const payload = parseQaCorrectionEventPayload("qa_correction_source_measured", {
      schemaVersion: "workflow.qa-correction.source-measured.v1", ...proof, sources, measuredAt: now.toISOString(),
    });
    const inserted = await tx.insert(workflowTransitionEvents).values({
      id: randomUUID(), companyId: p.companyId, missionId: p.missionId, workflowRunId: p.workflowRunId,
      workflowStepRunId: p.producer.stepRunId, issueId: p.producer.issueId,
      executionGeneration: p.producer.executionGeneration, eventType: "qa_correction_source_measured",
      layer: "workflow_validation", idempotencyKey: qaCorrectionSourceMeasuredKey(p.correctionId), payload, createdAt: now,
    }).onConflictDoNothing().returning();
    if (inserted[0]) return { effect: "write", value: checkedMeasurement(inserted[0], p, proof) };
    const winner = await measuredRow(tx, p);
    requireQaCorrection(winner, "record");
    // The losing transaction must roll back every prefix change before comparing with the winner.
    return { effect: "noop", value: checkedMeasurement(winner, p, proof) };
  });
  requireQaCorrection(result.status === "current", "stale");
  requireQaCorrection(isDeepStrictEqual(sortedSources(result.value.sourceMeasured.sources), sources), "source");
  return result.value;
}
