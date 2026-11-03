// [purpose] Persist one validated QA-remediation preparation inside the caller's already-open transaction.
// This primitive owns neither Quality/workflow locks nor a transaction boundary; it performs no file,
// upload, evidence-use, wake, or publication effects. The stored row records identity, not execution authority.

import { is } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { type Db, workflowTransitionEvents } from "@paperclipai/db";
import {
  QA_REMEDIATION_PREPARATION_EVENT_TYPE, QaRemediationPreparationError,
  classifyQaRemediationPreparationRow, parseQaRemediationPreparation, qaRemediationPreparationKey,
  type QaRemediationEventRow, type QaRemediationPreparation, type QaRemediationPreparationScope,
} from "./qa-remediation-preparation-contract.js";
import { readQaRemediationPreparation } from "./qa-remediation-preparation-reader.js";

/** Exact transaction type accepted by the database's Drizzle transaction callback. */
export type QaRemediationPreparationTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type QaRemediationPreparationWriteResult =
  | { readonly outcome: "prepared"; readonly preparationEventId: string; readonly preparation: QaRemediationPreparation; readonly detail: string }
  | { readonly outcome: "existing"; readonly preparationEventId: string; readonly preparation: QaRemediationPreparation; readonly detail: string }
  | { readonly outcome: "held"; readonly reason: "unresolved_conflict"; readonly detail: string };

function preparationRow(preparation: QaRemediationPreparation): QaRemediationEventRow {
  return {
    id: preparation.preparationId, companyId: preparation.companyId, missionId: preparation.missionId,
    workflowRunId: preparation.workflowRunId, workflowStepRunId: preparation.producer.stepRunId,
    issueId: preparation.producer.issueId, heartbeatRunId: null,
    executionGeneration: preparation.producer.executionGeneration,
    eventType: QA_REMEDIATION_PREPARATION_EVENT_TYPE, layer: "workflow_validation",
    decision: null, verdict: null, reason: "workflow_api", reasonCode: "qa_remediation_prepare",
    idempotencyKey: qaRemediationPreparationKey(preparation), payload: preparation as unknown as Record<string, unknown>,
    createdAt: new Date(preparation.preparedAt),
  };
}

/**
 * Insert or recognize the exact durable reservation using the existing envelope and key. A conflict is
 * accepted only after the same transaction rereads one exact row; a changed binding/source/verdict holds.
 */
export async function writeQaRemediationPreparation(
  tx: QaRemediationPreparationTransaction,
  untrustedPreparation: QaRemediationPreparation,
  rootScope: QaRemediationPreparationScope,
): Promise<QaRemediationPreparationWriteResult> {
  if (!is(tx, PgTransaction)) throw new QaRemediationPreparationError("caller_transaction_required");
  let preparation: QaRemediationPreparation;
  try { preparation = parseQaRemediationPreparation(untrustedPreparation); }
  catch { throw new QaRemediationPreparationError("payload"); }

  const candidate = classifyQaRemediationPreparationRow(preparationRow(preparation), rootScope);
  if (candidate.kind !== "prepared") {
    return { outcome: "held", reason: "unresolved_conflict",
      detail: `candidate does not match the root-derived preparation scope (${candidate.kind}: ${candidate.detail})` };
  }

  const inserted = await tx.insert(workflowTransitionEvents).values({
    id: preparation.preparationId, companyId: preparation.companyId, missionId: preparation.missionId,
    workflowRunId: preparation.workflowRunId, workflowStepRunId: preparation.producer.stepRunId,
    issueId: preparation.producer.issueId, heartbeatRunId: null,
    executionGeneration: preparation.producer.executionGeneration,
    eventType: QA_REMEDIATION_PREPARATION_EVENT_TYPE, layer: "workflow_validation",
    decision: null, verdict: null, reason: "workflow_api", reasonCode: "qa_remediation_prepare",
    idempotencyKey: qaRemediationPreparationKey(preparation), payload: preparation,
  }).onConflictDoNothing().returning({ id: workflowTransitionEvents.id });
  if (inserted.length > 0) {
    return { outcome: "prepared", preparationEventId: inserted[0]!.id, preparation,
      detail: `reservation persisted in the caller transaction (${preparation.verdicts.length} verdict(s), ${preparation.files.length} file(s)); it grants no publication or execution authority` };
  }

  const reread = await readQaRemediationPreparation(tx as unknown as Db, rootScope);
  if (reread.status === "prepared") {
    return { outcome: "existing", preparationEventId: reread.preparationEventId!, preparation: reread.preparation!,
      detail: `exact reservation reread after idempotency-key conflict; candidate preparationId/preparedAt differences were ignored; ${reread.detail}` };
  }
  return { outcome: "held", reason: "unresolved_conflict",
    detail: `idempotency-key conflict but re-read did not confirm an exact preparation (${reread.detail})` };
}
