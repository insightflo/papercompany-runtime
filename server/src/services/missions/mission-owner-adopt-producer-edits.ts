import { and, eq } from "drizzle-orm";
import { issues, issueWorkProducts, missions, workflowRuns,
  workflowStepOutputBindings, workflowStepRuns, type Db } from "@paperclipai/db";
import type { MissionOwnerExecuteRequest } from "@paperclipai/shared/validators/mission-owner-authority";
import { workProductProducerSchema, workProductSelectorsSchema } from "@paperclipai/shared/validators/workflow-artifact";
import { HttpError } from "../../errors.js";
import { loadExecutionDefinition } from "../workflow/execution-definition.js";
import { consumerDependsOnProducer } from "../workflow/producer-provenance-rebind.js";
import { issueProducerRebind } from "../workflow/producer-rebind-issuance.js";
import { loadAppliedPayload, projectOwnerActionResult } from "./mission-owner-execution-state.js";
import { dispatchOwnerExactRetry, OwnerActionRefusalError, type OwnerExecutionContext } from "./mission-owner-execute.js";

/** [owner adopt producer edits] 오너가 생산자 산출물 바이트를 직접 수정한 뒤(bytes-changed 펜스,
 *   producer_rebind_bytes_changed) 그 수정을 증명과 함께 공식 채택하는 여덟 번째 오너 작업.
 *   하나의 트랜잭션에서 (1) 서버가 디스크 바이트를 직접 측정해 오너 attestation 과 대조·재바인딩
 *   마커 발급(원본 귀속 불변, 권한 전환 이벤트 기록) (2) 기존 정확한 재시도를 실행한다.
 *   재시도가 거부되면 채택도 함께 롤백된다(#371 승격과 동일한 원자성). 클라이언트가 보낸 해시를
 *   신뢰하지 않는다 — expected 로 전달해 발급 계층의 실패닫힘 검증(live 사고 2026-10-14 a6d16f90)을
 *   그대로 재사용한다. 재실행은 적용 영수증 재생으로 처리한다.
 */
export async function executeOwnerAdoptProducerEdits(context: OwnerExecutionContext, request: MissionOwnerExecuteRequest,
  actionId: string, validateIntent: (tx: Db) => Promise<boolean>) {
  const action = request.action;
  if (action.operation !== "adopt_producer_edits") throw new OwnerActionRefusalError(422, "operation_not_available");
  const { target } = action;
  function deny(reason: string): never { throw new OwnerActionRefusalError(409, reason); }
  return context.db.transaction(async tx => {
    const db = tx as unknown as Db;
    // Same mission -> run -> all steps order as strict retry and promotion; hold through adoption + reset.
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
    const invocation = consumer.metadata?.toolInvocation as {
      dispatchError?: unknown; producerRebindDiagnostic?: { conflictReason?: unknown } | undefined;
    } | undefined;
    // Only the real changed-bytes fence qualifies; provenance-missing belongs to promote_unblock_product,
    // and a plain generation drift is served by the automatic rebind at the retry boundary.
    if (invocation?.dispatchError !== "workproduct_selector_stale_producer"
      || invocation.producerRebindDiagnostic?.conflictReason !== "producer_rebind_bytes_changed") deny("adopt_edits_not_recovery");
    // Lock intent issue before its last currentness check, serializing a newer owner request with application.
    await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.id, request.ownerActionIssueId),
      eq(issues.companyId, context.companyId))).for("update");
    if (!await validateIntent(db)) deny("stale_intent");
    const producer = rows.find(s => s.stepId === action.producerStepId);
    if (!producer?.issueId || producer.status !== "completed") deny("producer_rebind_producer_not_completed");
    const [product] = await tx.select().from(issueWorkProducts).where(and(eq(issueWorkProducts.id, action.productId),
      eq(issueWorkProducts.companyId, context.companyId), eq(issueWorkProducts.issueId, producer.issueId!))).for("update");
    if (!product || product.status !== "active") deny("adopt_edits_product_not_found");
    if (!workProductProducerSchema.safeParse(product.metadata?.workflowProducer).success) deny("adopt_edits_provenance_missing");
    // Fence the named product to this consumer's frozen selector, not merely any artifact in the mission.
    const definition = await loadExecutionDefinition(db, run.id, { requireHistorical: true });
    const step = definition.steps.find(s => s.id === consumer.stepId);
    const selectors = workProductSelectorsSchema.safeParse((step as { workProductSelectors?: unknown } | undefined)?.workProductSelectors);
    const selector = selectors.success ? selectors.data[action.producerStepId] : null;
    if (!selector || selector.type !== product.type || selector.title !== product.title
      || !await consumerDependsOnProducer(db, { workflowRunId: run.id, consumerStepId: consumer.stepId,
        producerStepId: producer.stepId })) deny("adopt_edits_not_consumer_input");
    const [pin] = await tx.select().from(workflowStepOutputBindings).where(and(eq(workflowStepOutputBindings.companyId, context.companyId),
      eq(workflowStepOutputBindings.workflowRunId, run.id), eq(workflowStepOutputBindings.consumerStepRunId, consumer.id),
      eq(workflowStepOutputBindings.referencedStepId, producer.stepId))).for("share");
    if (pin && pin.workProductId !== product.id) deny("adopt_edits_not_consumer_input");
    try {
      await issueProducerRebind(db, { companyId: context.companyId, workflowRunId: run.id,
        producerStepId: producer.stepId, productId: product.id,
        actor: { actorType: "mission_owner", actorId: context.agentId },
        reason: "owner_attested_producer_rework",
        expected: { sha256: action.attestation.sha256, byteSize: action.attestation.byteSize } });
    } catch (error) {
      if (error instanceof HttpError) throw new OwnerActionRefusalError(error.status === 400 ? 422 : 409, error.message);
      throw error;
    }
    const result = await dispatchOwnerExactRetry({ ...context, db }, request, target, actionId, validateIntent);
    // Native refusal normally returns null/blocked (not an exception). Roll the adoption back too.
    if (!await loadAppliedPayload(db, context.companyId, actionId)) deny(result.reasonCode ?? "recovery_rejected");
    return result;
  });
}
