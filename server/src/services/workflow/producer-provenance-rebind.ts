import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { heartbeatRuns, issueWorkProducts, missions, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { workProductProducerRebindMarkerSchema, workProductProducerSchema } from "@paperclipai/shared/validators/workflow-artifact";
import { badRequest, conflict } from "../../errors.js";
import { resolveWorkProductLocalFilePath } from "../work-products.js";
import { producerAttempt } from "../work-products/producer-attempt.js";
import { appendWorkflowAuthorityTransition } from "./authority/transitions.js";
import { workProductProducerMismatches } from "./workproduct-producer-comparison.js";

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
]);

export type ProducerProvenanceRebindResult =
  | { status: "rebound"; productId: string; producerStepRunId: string; fromGeneration: number; reboundAtGeneration: number; sha256: string; byteSize: number }
  | { status: "already_rebound"; productId: string; fromGeneration: number };

export async function rebindProducerProvenance(db: Db, input: {
  companyId: string; workflowRunId: string; producerStepId: string; productId: string;
  actor: { actorType: string; actorId: string }; now?: Date;
}): Promise<ProducerProvenanceRebindResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [run] = await tx.select().from(workflowRuns)
      .where(and(eq(workflowRuns.id, input.workflowRunId), eq(workflowRuns.companyId, input.companyId)))
      .for("update");
    if (!run) throw badRequest("producer rebind workflow run not found");
    if (run.status !== "failed") throw conflict("producer_rebind_run_not_failed");
    if (run.missionId) {
      const [mission] = await tx.select().from(missions)
        .where(and(eq(missions.id, run.missionId), eq(missions.companyId, input.companyId))).for("update");
      if (!mission || mission.status !== "active") throw conflict("producer_rebind_mission_not_active");
    }
    // restampProducer 와 동일한 잠금 순서: run → step → product row.
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
    const parsed = workProductProducerSchema.safeParse(product.metadata?.workflowProducer);
    if (!parsed.success) throw conflict("producer_rebind_provenance_missing");
    const p = parsed.data;
    // 멱등: 이 생산 사실에 대해 이미 유효한 마커가 있으면 추가 쓰기 없이 반혼한다(감사 이벤트도 중복하지 않는다).
    const existingMarker = workProductProducerRebindMarkerSchema.safeParse(product.metadata?.workflowProducerRebind);
    if (existingMarker.success && existingMarker.data.fromGeneration === p.executionGeneration
      && existingMarker.data.fromHeartbeatRunId === p.heartbeatRunId) {
      return { status: "already_rebound", productId: product.id, fromGeneration: p.executionGeneration };
    }
    const mismatches = workProductProducerMismatches(p, {
      companyId: input.companyId, workflowRunId: run.id,
      run: { missionId: run.missionId }, step, product,
    });
    const generationOnly = mismatches.length > 0
      && mismatches.every((field) => field === "executionGeneration" || field === "sourceExecutionGeneration");
    if (!generationOnly) throw conflict("producer_rebind_not_generation_only");
    if (p.executionGeneration >= step.executionGeneration) throw conflict("producer_rebind_not_stale");
    const [heartbeat] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, p.heartbeatRunId));
    if (!heartbeat || heartbeat.companyId !== p.companyId || heartbeat.issueId !== step.issueId
      || heartbeat.workflowStepRunId !== step.id) {
      throw conflict("producer_rebind_heartbeat_unlinked");
    }
    if (heartbeat.workflowExecutionGeneration !== p.executionGeneration) {
      throw conflict("producer_rebind_heartbeat_generation_mismatch");
    }
    let attempt: { retryCount: number; iterationIndex: number };
    try {
      attempt = await producerAttempt(tx, heartbeat, { ...step, executionGeneration: p.executionGeneration });
    } catch {
      throw conflict("producer_rebind_attempt_unproven");
    }
    if (attempt.retryCount !== p.retryCount || attempt.iterationIndex !== p.iterationIndex) {
      throw conflict("producer_rebind_attempt_mismatch");
    }
    const file = resolveWorkProductLocalFilePath(product);
    if (!file || !["local", "local_file"].includes(product.provider)) throw conflict("producer_rebind_product_not_local");
    let bytes: Buffer;
    try { bytes = await readFile(file); } catch { throw conflict("producer_rebind_file_unreadable"); }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const marker = {
      schemaVersion: "workflow.work-product-producer-rebind.v1" as const,
      fromGeneration: p.executionGeneration,
      reboundAtGeneration: step.executionGeneration,
      fromHeartbeatRunId: p.heartbeatRunId,
      sha256, byteSize: bytes.byteLength,
      reboundAt: now.toISOString(),
      reboundBy: { actorType: input.actor.actorType, actorId: input.actor.actorId },
      reason: "board_producer_provenance_rebind",
      authorityIdempotencyKey: `producer-provenance-rebind:${product.id}:${p.executionGeneration}`,
    };
    const nextMetadata = {
      ...(product.metadata ?? {}),
      workflowProducerRebind: marker,
    };
    await tx.update(issueWorkProducts)
      .set({ metadata: nextMetadata, updatedAt: now })
      .where(eq(issueWorkProducts.id, product.id));
    await appendWorkflowAuthorityTransition(tx, {
      companyId: input.companyId, workflowRunId: run.id, workflowStepRunId: step.id,
      issueId: step.issueId, heartbeatRunId: p.heartbeatRunId,
      executionGeneration: step.executionGeneration,
      reason: marker.reason, idempotencyKey: marker.authorityIdempotencyKey,
      payload: { version: 1, transition: "producer_provenance_rebound", productId: product.id,
        producerStepRunId: step.id, fromGeneration: marker.fromGeneration,
        reboundAtGeneration: marker.reboundAtGeneration,
        sha256, byteSize: marker.byteSize, reboundBy: marker.reboundBy },
    });
    return { status: "rebound", productId: product.id, producerStepRunId: step.id,
      fromGeneration: marker.fromGeneration, reboundAtGeneration: marker.reboundAtGeneration,
      sha256, byteSize: marker.byteSize };
  });
}
