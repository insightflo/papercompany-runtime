// Quality identity checks shared by root admission and exact historical completion reads.
import { and, eq, sql } from "drizzle-orm";
import { qualityActions, qualityPolicyVersions, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { qualityPolicySchema, retryEnvelopeSchema, type NativeBinding, type SourceAttempt } from "@paperclipai/shared";
import { HttpError } from "../../../errors.js";
import { verifySourceAttempt } from "../../quality/evidence-verifier.js";
import { verifyCanonicalBindingJoin } from "../workflow-step-issue-records.js";
import { readQaRemediationPreparation } from "./qa-remediation-preparation-reader.js";
import { QA_REMEDIATION_PREPARATION_EVENT_TYPE, QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3,
  parseQaRemediationPreparation, qaRemediationPreparationKey, type QaRemediationPreparation } from "./qa-remediation-preparation-contract.js";
import { qaRemediationQualityBindingHash } from "./qa-remediation-quality-binding.js";
import type { QaRemediationPreparationRequest } from "./qa-remediation-prepare.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type QualityPreparation = Extract<QaRemediationPreparation, { schemaVersion: typeof QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3 }>;
export type QualityRootFacts = {
  action: typeof qualityActions.$inferSelect; source: SourceAttempt; binding: NativeBinding;
  envelope: ReturnType<typeof retryEnvelopeSchema.parse>; policy: ReturnType<typeof qualityPolicySchema.parse>;
  policyRow: typeof qualityPolicyVersions.$inferSelect; groupDeadlineAt: Date | null;
};
const dbOf = (tx: Tx) => tx as unknown as Db;

export async function classifyQualityActionHistory(tx: Tx, request: QaRemediationPreparationRequest): Promise<
  { row: typeof workflowTransitionEvents.$inferSelect; preparation: QualityPreparation } | { detail: string } | null> {
  const rows = await tx.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, request.companyId), eq(workflowTransitionEvents.workflowRunId, request.workflowRunId),
    eq(workflowTransitionEvents.eventType, QA_REMEDIATION_PREPARATION_EVENT_TYPE),
    sql`${workflowTransitionEvents.payload}->'qualityBinding'->>'actionId' = ${request.qualityActionId!}`));
  if (rows.length > 1) return { detail: "multiple Quality action reservations" };
  if (!rows.length) return null;
  const row = rows[0]!;
  let preparation: QaRemediationPreparation;
  try { preparation = parseQaRemediationPreparation(row.payload); }
  catch { return { detail: "Quality action reservation payload is malformed" }; }
  if (preparation.schemaVersion !== QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3
    || row.id !== preparation.preparationId || row.workflowStepRunId !== request.producerStepRunId
    || row.idempotencyKey !== qaRemediationPreparationKey(preparation)
    || preparation.qualityBinding.actionId !== request.qualityActionId || preparation.companyId !== request.companyId
    || preparation.missionId !== request.missionId || preparation.workflowRunId !== request.workflowRunId) {
    return { detail: "Quality action reservation row identity is invalid" };
  }
  const p = preparation, classified = await readQaRemediationPreparation(dbOf(tx), {
    companyId: p.companyId, missionId: p.missionId, workflowRunId: p.workflowRunId,
    dispatchAuthorityVersion: p.dispatchAuthorityVersion, producer: p.producer, verdicts: p.verdicts,
    qualityBinding: { actionId: p.qualityBinding.actionId, bindingHash: qaRemediationQualityBindingHash(p.qualityBinding) },
  });
  return classified.status === "prepared" && classified.preparationEventId === row.id
    ? { row, preparation } : { detail: `Quality reservation history is ${classified.status}: ${classified.detail}` };
}

export async function verifyCurrentQualityAuthority(tx: Tx, request: QaRemediationPreparationRequest,
  facts: QualityRootFacts): Promise<{ ok: true } | { ok: false; detail: string }> {
  const now = Date.now(), { policyRow, policy, envelope, action } = facts;
  if (action.cancelRequestedAt || !policyRow.approvedAt || !policyRow.enabledAt || policyRow.disabledAt
    || policy.nativeOwnership !== "native-active-plugin-disabled"
    || now < Date.parse(policy.periodStart) || now >= Date.parse(policy.periodEnd)
    || now >= Date.parse(envelope.deadlineAt) || (facts.groupDeadlineAt && now >= facts.groupDeadlineAt.getTime())) {
    return { ok: false, detail: "Quality policy, ownership, cancellation, or deadline is inactive" };
  }
  try {
    await verifySourceAttempt(dbOf(tx), request.companyId, facts.source);
    await verifyCanonicalBindingJoin(dbOf(tx), facts.binding);
  } catch (error) {
    if (error instanceof HttpError) return { ok: false, detail: `Quality source/canonical verification failed: ${error.message}` };
    throw error;
  }
  return { ok: true };
}
