import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { and, desc, eq } from "drizzle-orm";
import { heartbeatRuns, issueWorkProducts, missions, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { workProductDelegatedProducerSchema, workProductProducerPromotionMarkerSchema, workProductProducerSchema } from "@paperclipai/shared/validators/workflow-artifact";
import { badRequest, conflict } from "../../errors.js";
import { loadExecutionDefinition } from "./execution-definition.js";
import { resolveWorkProductLocalFilePath } from "../work-products.js";
import { appendWorkflowAuthorityTransition } from "./authority/transitions.js";
import { issueProducerRebind, type ProducerProvenanceRebindResult } from "./producer-rebind-issuance.js";
export type { ProducerProvenanceRebindResult } from "./producer-rebind-issuance.js";

/**
 * [파일 목적] 보드 승인 생산자 귀속 재바인딩(board producer provenance rebind).
 *   런 회복(recovery)이 실행세대를 진행시키면, 변경되지 않은 생산자의 workProduct 귀속이
 *   세대 불일치로 소비 셀렉터(workproduct_selector_stale_producer)에 차인다. 이 경로는
 *   "세대만 뒤처졌고 바이트는 동일하다"를 실패닫힘(fail-closed) 조건으로 증명한 뒤 귀속을
 *   현재 세대로 재귀속하고 권한 전환 이벤트로 감사 흔적을 남긴다.
 * [허용 조건 — 전부 만족해야 함]
 *   1) 런 상태 failed, 미션 존재 시 active
 *   2) 생산자 stepRun completed + 이슈 바인딩 존재
 *   3) workProduct 가 생산자 이슈 소속·활성(active)·로컬 파일
 *   4) 기존 귀속과의 불일치가 세대 필드(executionGeneration/sourceExecutionGeneration)뿐 (정방향)
 *   5) 하트비트 연결(회사/이슈/stepRun) 동일, 하트비트 세대 = fromGeneration
 *   6) 시도 증명(producerAttempt)을 fromGeneration 기준으로 재현 가능하고 retry/iteration 일치
 * [기록] metadata.workflowProducerRebind = 마커(sha256/byteSize 포함), workflow_transition_events 1건.
 *   원본 귀속 사실(workflowProducer.executionGeneration, sourceExecutionGeneration)은 그대로 보존한다 —
 *   마커는 fromGeneration 이후 어떤 세대에서든 유효하므로 회복/재발사의 세대 진행에 강건하다.
 * [수정시 주의] 셀렉터(workproduct-same-run)는 마커가 유효할 때만 세대 필드 불일치를 용인하고
 *   하트비트/시도증명 세대를 fromGeneration 기준으로 평가하며 매 소비마다 바이트를 재검증한다.
 */

export const PRODUCER_REBIND_ELIGIBLE_DISPATCH_ERRORS: ReadonlySet<string> = new Set([
  "workproduct_selector_stale_producer",
  "workproduct_selector_heartbeat_mismatch",
  // 회복으로 세대가 진행된 소비 단계의 또 다른 펜스 양상: 얼려진 계약 스냅숏 낡음.
  //   재발사가 새 requestId 로 스냅숏을 다시 얼리므로, 여기서 필요한 것은 생산자 재바인딩뿐이다.
  "artifact_contract_snapshot_stale",
  // [delegated producer promotion — #323] 소유자 언블록이 남긴 위임 귀속 산출물은
  //   같은 럼 셀렉터가 규속 파싱 단계에서 확정 거부한다. 보드 승격(promotion) 대상.
  "workproduct_selector_provenance_missing",
]);

// [확장 — board recovery fence-erase] 런 회복/리컨실러가 소비 단계를 재무장·스킵해 실패 흔적(dispatch
//   error)이 지워진 경우에도, 종료-실패 런 + 실제 소비자 관계 + 서비스 층 전체 증명 사슬이 유지되면
//   보드가 재귀속을 승인할 수 있다. 이 헬퍼는 그중 "실제 소비자 관계"만 증명한다: 얼려진 실행정의
//   (스냅숏, requireHistorical)에서 소비 단계로부터 생산자 단계로의 직접/전이 의존 경로를 역방향
//   탐색으로 확인한다. 엣지 해석은 런타임 전칭(control-node-validation legacyDeps)과 동일 —
//   dependencies+dependsOn 병합, isBackEdge 가 아닌 conditionalDependencies 만 선행으로 인정.
//   정의를 못 읽거나(스냅숏 누락/변조) 경로가 없으면 미증명(false) — fail-closed.
export async function consumerDependsOnProducer(db: Db, input: {
  workflowRunId: string;
  consumerStepId: string;
  producerStepId: string;
}): Promise<boolean> {
  if (input.consumerStepId === input.producerStepId) return false;
  let steps;
  try {
    const definition = await loadExecutionDefinition(db, input.workflowRunId, { requireHistorical: true });
    steps = definition.steps;
  } catch {
    return false;
  }
  const predecessorsByStep = new Map<string, string[]>();
  for (const step of steps) {
    const predecessors = new Set<string>();
    for (const dependency of [...(step.dependencies ?? []), ...(step.dependsOn ?? [])]) {
      if (typeof dependency === "string" && dependency.length > 0) predecessors.add(dependency);
    }
    for (const edge of step.conditionalDependencies ?? []) {
      if (edge && edge.isBackEdge !== true && typeof edge.stepId === "string" && edge.stepId.length > 0) {
        predecessors.add(edge.stepId);
      }
    }
    predecessorsByStep.set(step.id, Array.from(predecessors));
  }
  const visited = new Set<string>([input.consumerStepId]);
  const stack = [input.consumerStepId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const predecessor of predecessorsByStep.get(current) ?? []) {
      if (predecessor === input.producerStepId) return true;
      if (!visited.has(predecessor)) {
        visited.add(predecessor);
        stack.push(predecessor);
      }
    }
  }
  return false;
}

export async function rebindProducerProvenance(db: Db, input: {
  companyId: string; workflowRunId: string; producerStepId: string; productId: string;
  actor: { actorType: string; actorId: string }; now?: Date;
  expected?: { sha256: string; byteSize: number };
}): Promise<ProducerProvenanceRebindResult> {
  return issueProducerRebind(db, input);
}

export type DelegatedProducerPromotionResult =
  | { status: "promoted"; productId: string; producerStepRunId: string; fromGeneration: number; sha256: string; byteSize: number }
  | { status: "already_promoted"; productId: string; fromGeneration: number };

/**
 * [delegated producer promotion — #323] 소유자 언블록(mission_owner_unblock_source)이 남긴 위임
 *   귀속 workProduct 를 보드 승인으로 같은 럼 소비 가능 귀속으로 승격한다.
 * [정직성 원칙] 생산 사실을 위조하지 않는다 — 위임 경로에는 시도증명(producerAttempt) 사슬이
 *   애초에 존재하지 않는다(실제 생산자는 소유자의 언블록 실행). 따라서 승격의 권위는
 *   “보드 승인 + 매 소비 바이트(sha256/byteSize) 재검증”이며, 원본 위임 기록은
 *   metadata.workflowProducerDelegatedOrigin 에 원문 그대로 보존된다.
 * [허용 조건 — 전부 만족해야 함]
 *   1) 런 failed, 미션 존재 시 active
 *   2) 생산자 stepRun completed + 이슈 바인딩 존재
 *   3) workProduct 가 생산자 이슈 소속·활성(active)·로컬 파일·읽기 가능
 *   4) 기존 귀속이 위임 스키마(workflow.delegated-work-product-producer.v1)이고
 *      companyId/missionId/sourceIssueId 가 스코프와 일치
 *   5) 위임 하트비트 행이 존재하고 회사·위임 이슈가 기록과 일치
 * [기록] metadata.workflowProducer = 합성 강한 귀속(정체 사실만), workflowProducerPromotion = 마커,
 *   workflowProducerDelegatedOrigin = 원본 위임 기록 원문, workflow_transition_events 1건.
 */
export async function promoteDelegatedProducerProvenance(db: Db, input: {
  companyId: string; workflowRunId: string; producerStepId: string; productId: string;
  actor: { actorType: string; actorId: string }; now?: Date;
}): Promise<DelegatedProducerPromotionResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    // Global lock order mission → run (same as lockProducerRebindScope / lockUnreplacedRun).
    const [scope] = await tx.select({ missionId: workflowRuns.missionId }).from(workflowRuns)
      .where(and(eq(workflowRuns.id, input.workflowRunId), eq(workflowRuns.companyId, input.companyId)));
    if (!scope) throw badRequest("producer rebind workflow run not found");
    if (scope.missionId) {
      const [mission] = await tx.select().from(missions)
        .where(and(eq(missions.id, scope.missionId), eq(missions.companyId, input.companyId))).for("update");
      if (!mission || mission.status !== "active") throw conflict("producer_rebind_mission_not_active");
    }
    const [run] = await tx.select().from(workflowRuns)
      .where(and(eq(workflowRuns.id, input.workflowRunId), eq(workflowRuns.companyId, input.companyId)))
      .for("update");
    if (!run || run.missionId !== scope.missionId) throw conflict("producer_rebind_scope_changed");
    if (run.status !== "failed") throw conflict("producer_rebind_run_not_failed");
    const [step] = await tx.select().from(workflowStepRuns)
      .where(and(eq(workflowStepRuns.workflowRunId, run.id), eq(workflowStepRuns.stepId, input.producerStepId)))
      .for("update");
    if (!step) throw badRequest("producer rebind producer step run not found");
    if (step.status !== "completed" || step.issueId == null) throw conflict("producer_rebind_producer_not_completed");
    const [product] = await tx.select().from(issueWorkProducts)
      .where(eq(issueWorkProducts.id, input.productId)).for("update");
    if (!product || product.companyId !== input.companyId || product.issueId !== step.issueId) {
      throw badRequest("producer rebind work product not on producer issue");
    }
    if (product.status === "archived") throw conflict("producer_rebind_product_archived");
    // 위임 기록 우선순위: 미승격 = workflowProducer, 승격 후 = workflowProducerDelegatedOrigin(원문 보존).
    const delegatedFromMeta = workProductDelegatedProducerSchema.safeParse(product.metadata?.workflowProducer).success
      ? product.metadata?.workflowProducer
      : workProductDelegatedProducerSchema.safeParse(product.metadata?.workflowProducerDelegatedOrigin).success
        ? product.metadata?.workflowProducerDelegatedOrigin : null;
    if (!delegatedFromMeta) throw conflict("producer_promotion_not_delegated");
    const origin = workProductDelegatedProducerSchema.parse(delegatedFromMeta);
    if (origin.companyId !== input.companyId || origin.sourceIssueId !== step.issueId
      || origin.missionId !== run.missionId) {
      throw conflict("producer_promotion_delegated_scope_mismatch");
    }
    // 멱등: 이미 유효한 승격 마커가 있으면 추가 쓰기 없이 반한한다(감사 이벤트도 중복하지 않는다).
    const promoted = workProductProducerSchema.safeParse(product.metadata?.workflowProducer);
    const existingMarker = workProductProducerPromotionMarkerSchema.safeParse(product.metadata?.workflowProducerPromotion);
    if (promoted.success && existingMarker.success && existingMarker.data.fromGeneration === promoted.data.executionGeneration
      && existingMarker.data.delegatedHeartbeatRunId === origin.heartbeatRunId) {
      return { status: "already_promoted", productId: product.id, fromGeneration: existingMarker.data.fromGeneration };
    }
    const [delegatedHeartbeat] = await tx.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, origin.heartbeatRunId));
    if (!delegatedHeartbeat || delegatedHeartbeat.companyId !== input.companyId
      || delegatedHeartbeat.issueId !== origin.delegatedFromIssueId) {
      throw conflict("producer_promotion_heartbeat_unlinked");
    }
    const file = resolveWorkProductLocalFilePath(product);
    if (!file || !["local", "local_file"].includes(product.provider)) throw conflict("producer_rebind_product_not_local");
    let bytes: Buffer;
    try { bytes = await readFile(file); } catch { throw conflict("producer_rebind_file_unreadable"); }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const [originalAttempt] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.workflowStepRunId, step.id), eq(heartbeatRuns.companyId, input.companyId)))
      .orderBy(desc(heartbeatRuns.startedAt)).limit(1);
    const synthesized = {
      schemaVersion: "workflow.work-product-producer.v1" as const,
      companyId: input.companyId, missionId: run.missionId,
      workflowRunId: run.id, stepRunId: step.id, stepId: step.stepId,
      executionGeneration: step.executionGeneration,
      retryCount: step.retryCount, iterationIndex: step.iterationIndex,
      heartbeatRunId: origin.heartbeatRunId,
    };
    const marker = {
      schemaVersion: "workflow.work-product-producer-promotion.v1" as const,
      fromGeneration: step.executionGeneration,
      promotedAtGeneration: step.executionGeneration,
      sourceKind: origin.kind,
      delegatedFromIssueId: origin.delegatedFromIssueId,
      delegatedHeartbeatRunId: origin.heartbeatRunId,
      originalAttemptHeartbeatRunId: originalAttempt?.id ?? null,
      sha256, byteSize: bytes.byteLength,
      promotedAt: now.toISOString(),
      promotedBy: { actorType: input.actor.actorType, actorId: input.actor.actorId },
      reason: "board_delegated_producer_promotion",
      authorityIdempotencyKey: `producer-delegated-promotion:${product.id}:${step.executionGeneration}`,
    };
    const nextMetadata = {
      ...(product.metadata ?? {}),
      workflowProducer: synthesized,
      workflowProducerPromotion: marker,
      workflowProducerDelegatedOrigin: product.metadata?.workflowProducer,
    };
    await tx.update(issueWorkProducts)
      .set({ metadata: nextMetadata, updatedAt: now })
      .where(eq(issueWorkProducts.id, product.id));
    await appendWorkflowAuthorityTransition(tx, {
      companyId: input.companyId, workflowRunId: run.id, workflowStepRunId: step.id,
      issueId: step.issueId, heartbeatRunId: origin.heartbeatRunId,
      executionGeneration: step.executionGeneration,
      reason: marker.reason, idempotencyKey: marker.authorityIdempotencyKey,
      payload: { version: 1, transition: "delegated_producer_promoted", productId: product.id,
        producerStepRunId: step.id, fromGeneration: marker.fromGeneration,
        promotedAtGeneration: marker.promotedAtGeneration,
        sha256, byteSize: marker.byteSize, promotedBy: marker.promotedBy,
        sourceKind: marker.sourceKind, delegatedFromIssueId: marker.delegatedFromIssueId,
        delegatedHeartbeatRunId: marker.delegatedHeartbeatRunId,
        originalAttemptHeartbeatRunId: marker.originalAttemptHeartbeatRunId },
    });
    return { status: "promoted", productId: product.id, producerStepRunId: step.id,
      fromGeneration: marker.fromGeneration, sha256, byteSize: marker.byteSize };
  });
}

/** 라우트용 디스패처: 귀속 스키마로 재바인딩(일반)과 승격(위임)을 구분한다. */
export async function rebindOrPromoteProducerProvenance(db: Db, input: {
  companyId: string; workflowRunId: string; producerStepId: string; productId: string;
  actor: { actorType: string; actorId: string }; now?: Date;
}) {
  const [product] = await db.select({ metadata: issueWorkProducts.metadata }).from(issueWorkProducts)
    .where(and(eq(issueWorkProducts.id, input.productId), eq(issueWorkProducts.companyId, input.companyId))).limit(1);
  const schemaVersion = (product?.metadata as { workflowProducer?: { schemaVersion?: string } } | undefined)
    ?.workflowProducer?.schemaVersion;
  return schemaVersion === "workflow.delegated-work-product-producer.v1"
    ? promoteDelegatedProducerProvenance(db, input)
    : rebindProducerProvenance(db, input);
}
