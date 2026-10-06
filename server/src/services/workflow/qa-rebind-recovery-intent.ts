import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import { activityLog, issueWorkProducts, workflowQaRebindClaims, type Db } from "@paperclipai/db";
import { workflowQaRebindExpectedDigestsSchema } from "@paperclipai/shared/validators/workflow-qa-rebind";
import { classifyQaRebindCandidate } from "./qa-rebind-candidate.js";
import { readQaRebindContext } from "./qa-rebind-evidence.js";
import { consumerDependsOnProducer, PRODUCER_REBIND_ELIGIBLE_DISPATCH_ERRORS, rebindProducerProvenance } from "./producer-provenance-rebind.js";
import { readObject } from "./core-tool-context.js";
import { validateQaRebindCardApproval } from "./qa-rebind-card-contract.js";

export type QaRebindRecoveryIntent = {
  candidateId: string; bundleDigest: string; authorityVersion: number; executionGeneration: number;
  operatorDecisionId?: string;
};
export class QaRebindRecoveryRejected extends Error {
  constructor() { super("qa_rebind_recovery_rejected"); }
}
type Target = { companyId: string; runId: string; stepId: string; qaRebind: QaRebindRecoveryIntent };
const candidateWhere = (input: Target) => and(
  eq(workflowQaRebindClaims.companyId, input.companyId), eq(workflowQaRebindClaims.workflowRunId, input.runId),
  eq(workflowQaRebindClaims.consumerStepId, input.stepId), eq(workflowQaRebindClaims.id, input.qaRebind.candidateId),
  eq(workflowQaRebindClaims.status, input.qaRebind.operatorDecisionId ? "card_required" : "auto_eligible"),
  eq(workflowQaRebindClaims.bundleDigest, input.qaRebind.bundleDigest),
  eq(workflowQaRebindClaims.authorityVersion, input.qaRebind.authorityVersion),
  eq(workflowQaRebindClaims.executionGeneration, input.qaRebind.executionGeneration));

/** Revalidation only. Caller already holds mission/run/all-step locks; product comes next. No claim write. */
export async function validateQaRebindIntent(db: Db, input: Target): Promise<boolean> {
  const [candidate] = await db.select().from(workflowQaRebindClaims).where(candidateWhere(input));
  if (!candidate || (input.qaRebind.operatorDecisionId && !await validateQaRebindCardApproval(db, input))) return false;
  const expected = workflowQaRebindExpectedDigestsSchema.safeParse(candidate.expectedDigests);
  if (!expected.success) return false;
  const [product] = await db.select().from(issueWorkProducts).where(and(
    eq(issueWorkProducts.companyId, input.companyId), eq(issueWorkProducts.id, expected.data.workProductId))).for("update");
  if (!product) return false;
  const scope = { companyId: input.companyId, workflowRunId: input.runId, consumerStepRunId: candidate.consumerStepRunId };
  const c = await readQaRebindContext(db, scope);
  if (!c || c.run.status !== "failed" || c.step.status !== "failed" || c.step.stepId !== input.stepId
    || c.step.lastDispatchRequestId !== candidate.requestId || c.step.executionGeneration !== input.qaRebind.executionGeneration
    || c.run.dispatchAuthorityVersion !== input.qaRebind.authorityVersion) return false;
  const invocation = readObject(c.step.metadata.toolInvocation);
  if (invocation.requestId !== candidate.requestId || typeof invocation.dispatchError !== "string"
    || !PRODUCER_REBIND_ELIGIBLE_DISPATCH_ERRORS.has(invocation.dispatchError)) return false;
  const producer = c.receipt?.input.producer;
  if (!producer || !await consumerDependsOnProducer(db, { workflowRunId: input.runId,
    consumerStepId: input.stepId, producerStepId: producer.stepId })) return false;
  const result = await classifyQaRebindCandidate(db, scope);
  const eligible = result?.status === "auto_eligible" || (input.qaRebind.operatorDecisionId && result?.status === "card_required"
    && result.reasonCode !== "published_same_qa" && !c.rows.some(({ step }) => step.metadata.failureCascadeSkipped === true));
  return Boolean(eligible) && result?.bundleDigest === input.qaRebind.bundleDigest
    && result.authorityVersion === input.qaRebind.authorityVersion && result.executionGeneration === input.qaRebind.executionGeneration
    && isDeepStrictEqual(result.expectedDigests, expected.data);
}

/** Called only AFTER the terminal decision check. Rebind and conditional claim share the recovery transaction. */
export async function claimQaRebindRecovery(db: Db, input: Target) {
  const [candidate] = await db.select().from(workflowQaRebindClaims).where(candidateWhere(input));
  if (!candidate || (input.qaRebind.operatorDecisionId && !await validateQaRebindCardApproval(db, input))) throw new QaRebindRecoveryRejected();
  const expected = workflowQaRebindExpectedDigestsSchema.parse(candidate.expectedDigests);
  const c = await readQaRebindContext(db, { companyId: input.companyId, workflowRunId: input.runId,
    consumerStepRunId: candidate.consumerStepRunId });
  if (!c?.receipt) throw new QaRebindRecoveryRejected();
  await rebindProducerProvenance(db, { companyId: input.companyId, workflowRunId: input.runId,
    producerStepId: c.receipt.input.producer.stepId, productId: expected.workProductId,
    expected: { sha256: expected.sha256, byteSize: expected.byteSize }, actor: { actorType: "system", actorId: "qa-rebind-recovery" } });
  const [claimed] = await db.update(workflowQaRebindClaims).set({ status: "claimed", claimedAt: new Date(), updatedAt: new Date() })
    .where(candidateWhere(input)).returning({ id: workflowQaRebindClaims.id });
  // Lost CAS must also roll back a rebind marker; never commit partial acceptance.
  if (!claimed) throw new QaRebindRecoveryRejected();
}

export async function completeQaRebindRecovery(db: Db, input: Target, authorityId: string) {
  const [updated] = await db.update(workflowQaRebindClaims).set({ status: "recovered", authorityId, updatedAt: new Date() })
    .where(and(eq(workflowQaRebindClaims.companyId, input.companyId), eq(workflowQaRebindClaims.id, input.qaRebind.candidateId),
      eq(workflowQaRebindClaims.workflowRunId, input.runId), eq(workflowQaRebindClaims.status, "claimed")))
    .returning({ id: workflowQaRebindClaims.id });
  if (!updated) throw new QaRebindRecoveryRejected();
  await db.insert(activityLog).values({ companyId: input.companyId, actorType: "system", actorId: "qa-rebind-recovery",
    action: "workflow.qa_rebind_recovered", entityType: "workflow_qa_rebind_claim", entityId: updated.id,
    details: { schemaVersion: "workflow.qa-rebind-recovery.v1", authorityId, ...input.qaRebind } });
}
