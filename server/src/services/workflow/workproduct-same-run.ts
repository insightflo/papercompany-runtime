import { and, eq, ne } from "drizzle-orm";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { heartbeatRuns, issueWorkProducts, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { workProductProducerPromotionMarkerSchema, workProductProducerRebindMarkerSchema, workProductProducerSchema, type WorkProductSelectors } from "@paperclipai/shared/validators/workflow-artifact";
import { resolveWorkProductLocalFilePath } from "../work-products.js";
import { producerAttempt } from "../work-products/producer-attempt.js";
import { workProductProducerMismatches } from "./workproduct-producer-comparison.js";

/**
 * [producer provenance rebind] 보드 승인 재바인딩 표시가 생산 사실과 정합한지 검증.
 * 유효한 경우에만 세대 비교를 실제 생산 세대(fromGeneration) 기준으로 평가하고
 * 디스크 바이트(sha256/byteSize)를 매 소비마다 재검증한다. 그 외 모든 검증은 기본 경로와 동일.
 * 표시는 fromGeneration 이후 어떤 현재 세대에서도 유효하다(회복/재발사의 세대 진행에 강건).
 */
function validRebindMarker(product: typeof issueWorkProducts.$inferSelect, producer: {
  executionGeneration: number; heartbeatRunId: string;
}, step: typeof workflowStepRuns.$inferSelect) {
  const parsed = workProductProducerRebindMarkerSchema.safeParse(product.metadata?.workflowProducerRebind);
  if (!parsed.success) return null;
  const marker = parsed.data;
  if (marker.fromGeneration !== producer.executionGeneration
    || marker.fromHeartbeatRunId !== producer.heartbeatRunId
    || step.executionGeneration < marker.fromGeneration) return null;
  return marker;
}

/**
 * [delegated producer promotion — #323] 보드 승격 마커가 유효한지 검증.
 *   합성 귀속의 세대(fromGeneration)와 발라 권위(delegatedHeartbeatRunId)가 마커와
 *   정합하고 현재 세대가 fromGeneration 이후면 유효하다(전방향 — 회복/재발사 강건).
 */
function validPromotionMarker(product: typeof issueWorkProducts.$inferSelect, producer: {
  executionGeneration: number; heartbeatRunId: string;
}, step: typeof workflowStepRuns.$inferSelect) {
  const parsed = workProductProducerPromotionMarkerSchema.safeParse(product.metadata?.workflowProducerPromotion);
  if (!parsed.success) return null;
  const marker = parsed.data;
  if (marker.fromGeneration !== producer.executionGeneration
    || marker.delegatedHeartbeatRunId !== producer.heartbeatRunId
    || step.executionGeneration < marker.fromGeneration) return null;
  return marker;
}

/** Ordinary same-run selector: cross-run approval must never weaken these checks. */
export async function selectSameRunWorkProduct(db: Db, scope: { companyId: string; workflowRunId: string;
  stepId: string; selector: WorkProductSelectors[string]; pinnedId?: string }) {
  const [source] = await db.select({ run: workflowRuns, step: workflowStepRuns }).from(workflowRuns)
    .innerJoin(workflowStepRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id))
    .where(and(eq(workflowRuns.id, scope.workflowRunId), eq(workflowRuns.companyId, scope.companyId), eq(workflowStepRuns.stepId, scope.stepId)));
  if (!source?.step.issueId || source.step.status !== "completed") throw new Error("workproduct_selector_producer_unavailable");
  const products = await db.select().from(issueWorkProducts).where(and(
    eq(issueWorkProducts.companyId, scope.companyId), eq(issueWorkProducts.issueId, source.step.issueId),
    ...(scope.pinnedId ? [eq(issueWorkProducts.id, scope.pinnedId)] : [ne(issueWorkProducts.status, "archived")]),
    eq(issueWorkProducts.type, scope.selector.type), eq(issueWorkProducts.title, scope.selector.title)));
  if (products.length !== 1) throw new Error("workproduct_selector_not_exactly_one");
  const product = products[0];
  const parsed = workProductProducerSchema.safeParse(product.metadata?.workflowProducer);
  if (!parsed.success) throw new Error("workproduct_selector_provenance_missing");
  const p = parsed.data, s = source.step;
  const promotion = validPromotionMarker(product, p, s);
  const rebind = promotion ? null : validRebindMarker(product, p, s);
  const toleratedFields = promotion || rebind ? ["executionGeneration", "sourceExecutionGeneration"] : [];
  if (workProductProducerMismatches(p, { ...scope, run: source.run, step: s, product })
    .some((field) => !toleratedFields.includes(field))) {
    throw new Error("workproduct_selector_stale_producer");
  }
  if (promotion) {
    // [delegated producer promotion] 보드 승격 권위가 시도증명(producerAttempt) 사슬을 대체한다.
    //   위임 생산의 하트비트는 생산자 stepRun 이 아닌 위임 이슈에 연결돼 있으므로 존재·회사·
    //   위임 이슈 정합만 검증하고, 바이트 동일성은 아래에서 매 소비 재검증한다.
    const [delegatedHeartbeat] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, p.heartbeatRunId));
    if (!delegatedHeartbeat || delegatedHeartbeat.companyId !== p.companyId
      || delegatedHeartbeat.issueId !== promotion.delegatedFromIssueId) {
      throw new Error("workproduct_selector_heartbeat_mismatch");
    }
  } else {
    const [heartbeat] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, p.heartbeatRunId));
    const heartbeatGenerationHolds = heartbeat
      && heartbeat.workflowExecutionGeneration === (rebind ? rebind.fromGeneration : s.executionGeneration);
    if (!heartbeat || heartbeat.companyId !== p.companyId || heartbeat.issueId !== s.issueId
      || heartbeat.workflowStepRunId !== s.id || !heartbeatGenerationHolds) {
      throw new Error("workproduct_selector_heartbeat_mismatch");
    }
    try {
      // [producer provenance rebind] 유효한 재바인딩 표시가 있으면 시도증명의 세대 기준만
      //   fromGeneration(실제 생산 세대)으로 평가한다. retry/iteration 은 현재 값 그대로 비교된다.
      const attempt = await producerAttempt(db, heartbeat,
        rebind ? { ...s, executionGeneration: rebind.fromGeneration } : s);
      if (attempt.retryCount !== p.retryCount || attempt.iterationIndex !== p.iterationIndex) throw new Error("attempt mismatch");
    } catch { throw new Error("workproduct_selector_stale_producer"); }
  }
  const file = resolveWorkProductLocalFilePath(product);
  if (!file || !["local", "local_file"].includes(product.provider)) throw new Error("workproduct_selector_not_local");
  const authorityMarker = promotion ?? rebind;
  if (authorityMarker) {
    const bytes = await readFile(file);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== authorityMarker.sha256 || bytes.byteLength !== authorityMarker.byteSize) {
      throw new Error(promotion ? "workproduct_selector_promotion_bytes_mismatch" : "workproduct_selector_rebind_bytes_mismatch");
    }
  }
  return { product, producer: p, file };
}
