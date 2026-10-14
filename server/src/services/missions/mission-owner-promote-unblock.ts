import { and, eq, inArray } from "drizzle-orm";
import { heartbeatRuns, issues, issueWorkProducts, missions, workflowRuns,
  workflowStepOutputBindings, workflowStepRuns, type Db } from "@paperclipai/db";
import type { MissionOwnerExecuteRequest } from "@paperclipai/shared/validators/mission-owner-authority";
import { workProductDelegatedProducerSchema, workProductProducerPromotionMarkerSchema, workProductProducerSchema, workProductSelectorsSchema } from "@paperclipai/shared/validators/workflow-artifact";
import { HttpError } from "../../errors.js";
import { loadExecutionDefinition } from "../workflow/execution-definition.js";
import { consumerDependsOnProducer, promoteDelegatedProducerProvenance } from "../workflow/producer-provenance-rebind.js";
import { loadAppliedPayload, projectOwnerActionResult } from "./mission-owner-execution-state.js";
import { dispatchOwnerExactRetry, OwnerActionRefusalError, type OwnerExecutionContext } from "./mission-owner-execute.js";

/** One atomic promotion + existing strict retry. Native authority/receipt/delivery remain the source of truth.
 * No promotion survives denied retry admission. Nested native delivery only writes the durable queue;
 * the existing queue processor invokes the tool after commit. Replay uses the ordinary applied receipt.
 */
export async function executeOwnerUnblockPromotion(context: OwnerExecutionContext, request: MissionOwnerExecuteRequest,
  actionId: string, validateIntent: (tx: Db) => Promise<boolean>) {
  const action = request.action;
  if (action.operation !== "promote_unblock_product") throw new OwnerActionRefusalError(422, "operation_not_available");
  const { target } = action;
  function deny(reason: string): never { throw new OwnerActionRefusalError(409, reason); }
  return context.db.transaction(async tx => {
    const db = tx as unknown as Db;
    // Same mission -> run -> all steps order as strict retry and cancellation; hold through promotion + reset.
    const [mission] = await tx.select().from(missions).where(and(eq(missions.id, request.missionId),
      eq(missions.companyId, context.companyId))).for("update");
    if (!mission || mission.status !== "active" || mission.ownerAgentId !== context.agentId) deny("not_mission_owner");
    const [run] = await tx.select().from(workflowRuns).where(and(eq(workflowRuns.id, target.workflowRunId),
      eq(workflowRuns.companyId, context.companyId), eq(workflowRuns.missionId, request.missionId))).for("update");
    if (await loadAppliedPayload(db, context.companyId, actionId)) {
      return projectOwnerActionResult(db, context.companyId, request.missionId, actionId, action.operation);
    }
    if (!run || run.status !== "failed") deny("producer_rebind_run_not_failed");
    if (run.dispatchAuthorityVersion !== target.expectedAuthorityVersion) deny("stale_authority_version");
    const rows = await tx.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, run.id))
      .orderBy(workflowStepRuns.id).for("update");
    const consumer = rows.find(s => s.id === target.stepRunId);
    if (!consumer || consumer.issueId || consumer.status !== "failed") deny("step_not_failed");
    if (consumer.executionGeneration !== target.expectedExecutionGeneration) deny("stale_generation");
    if (consumer.lastDispatchRequestId !== target.failedDispatchRequestId) deny("stale_dispatch_request");
    const invocation = consumer.metadata?.toolInvocation as { dispatchError?: unknown } | undefined;
    if (invocation?.dispatchError !== "workproduct_selector_provenance_missing") deny("unblock_promotion_not_recovery");
    // Lock intent issue before its last currentness check, serializing a newer owner request with application.
    await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.id, request.ownerActionIssueId),
      eq(issues.companyId, context.companyId))).for("update");
    if (!await validateIntent(db)) deny("stale_intent");
    const producer = rows.find(s => s.stepId === action.producerStepId);
    if (!producer?.issueId || producer.status !== "completed") deny("producer_rebind_producer_not_completed");
    const [product] = await tx.select().from(issueWorkProducts).where(and(eq(issueWorkProducts.id, action.productId),
      eq(issueWorkProducts.companyId, context.companyId), eq(issueWorkProducts.issueId, producer.issueId!))).for("update");
    if (!product || product.status !== "active") deny("unblock_product_not_found");
    const parsed = workProductDelegatedProducerSchema.safeParse(product.metadata?.workflowProducer);
    const preserved = workProductDelegatedProducerSchema.safeParse(product.metadata?.workflowProducerDelegatedOrigin);
    const origin = parsed.success ? parsed.data : preserved.success ? preserved.data : null;
    if (!origin) deny("producer_promotion_not_delegated");
    if (!parsed.success) {
      const strong = workProductProducerSchema.safeParse(product.metadata?.workflowProducer);
      const marker = workProductProducerPromotionMarkerSchema.safeParse(product.metadata?.workflowProducerPromotion);
      if (!strong.success || !marker.success || strong.data.workflowRunId !== run.id || strong.data.stepRunId !== producer.id
        || marker.data.fromGeneration !== strong.data.executionGeneration
        || marker.data.delegatedHeartbeatRunId !== origin.heartbeatRunId) deny("producer_promotion_not_delegated");
    }
    if (origin.kind !== "mission_owner_unblock_source" || origin.companyId !== context.companyId
      || origin.missionId !== request.missionId || origin.sourceIssueId !== producer.issueId) deny("producer_promotion_delegated_scope_mismatch");
    // Registration's immutable delegated provenance proves the original checked-out unblock admission.
    // Revalidate its durable chain, not the released checkout of a completed prior unblock.
    const linkedIssues = await tx.select().from(issues).where(and(eq(issues.companyId, context.companyId),
      eq(issues.missionId, request.missionId), inArray(issues.id, [origin.sourceIssueId, origin.delegatedFromIssueId])))
      .orderBy(issues.id).for("share");
    const source = linkedIssues.find(i => i.id === origin.sourceIssueId);
    const unblock = linkedIssues.find(i => i.id === origin.delegatedFromIssueId);
    const [heartbeat] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, origin.heartbeatRunId),
      eq(heartbeatRuns.companyId, context.companyId))).for("share");
    if (!source || source.originKind !== "workflow_execution" || !unblock
      || unblock.originKind !== "mission_main_executor_unblock" || unblock.originId !== source.id
      || unblock.assigneeAgentId !== context.agentId || !heartbeat || heartbeat.agentId !== context.agentId
      || heartbeat.issueId !== unblock.id || product.createdByRunId !== heartbeat.id
      || !["done", "in_progress"].includes(unblock.status)
      || (unblock.status === "in_progress" && unblock.checkoutRunId !== heartbeat.id)
      || (unblock.status === "done" && unblock.checkoutRunId !== null && unblock.checkoutRunId !== heartbeat.id)) deny("unblock_origin_chain_mismatch");
    // Fence the named product to this consumer's frozen selector, not merely any artifact in the mission.
    const definition = await loadExecutionDefinition(db, run.id, { requireHistorical: true });
    const step = definition.steps.find(s => s.id === consumer.stepId);
    const selectors = workProductSelectorsSchema.safeParse((step as { workProductSelectors?: unknown } | undefined)?.workProductSelectors);
    const selector = selectors.success ? selectors.data[action.producerStepId] : null;
    if (!selector || selector.type !== product.type || selector.title !== product.title
      || !await consumerDependsOnProducer(db, { workflowRunId: run.id, consumerStepId: consumer.stepId,
        producerStepId: producer.stepId })) deny("unblock_product_not_consumer_input");
    const [pin] = await tx.select().from(workflowStepOutputBindings).where(and(eq(workflowStepOutputBindings.companyId, context.companyId),
      eq(workflowStepOutputBindings.workflowRunId, run.id), eq(workflowStepOutputBindings.consumerStepRunId, consumer.id),
      eq(workflowStepOutputBindings.referencedStepId, producer.stepId))).for("share");
    if (pin && pin.workProductId !== product.id) deny("unblock_product_not_consumer_input");
    try {
      await promoteDelegatedProducerProvenance(db, { companyId: context.companyId, workflowRunId: run.id,
        producerStepId: producer.stepId, productId: product.id, actor: { actorType: "mission_owner", actorId: context.agentId } });
    } catch (error) {
      if (error instanceof HttpError) throw new OwnerActionRefusalError(error.status === 400 ? 422 : 409, error.message);
      throw error;
    }
    const result = await dispatchOwnerExactRetry({ ...context, db }, request, target, actionId, validateIntent);
    // Native refusal normally returns null/blocked (not an exception). Roll the promotion back too.
    if (!await loadAppliedPayload(db, context.companyId, actionId)) deny(result.reasonCode ?? "recovery_rejected");
    return result;
  });
}
