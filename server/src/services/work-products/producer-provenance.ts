import { and, eq } from "drizzle-orm";
import { heartbeatRuns, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { lockProducerSelection } from "./producer-selection-lock.js";
import { conflict } from "../../errors.js";
import { producerAttempt } from "./producer-attempt.js";
import { delegatedProducer, type ProducerDelegation } from "./delegated-provenance.js";

/** Only DB-linked authenticated heartbeat identity may stamp producer provenance. */
export async function registeredProducer(db: Pick<Db, "select">, companyId: string, issueId: string,
  heartbeatId?: string | null, delegation?: ProducerDelegation | null) {
  if (!heartbeatId) return null;
  const [heartbeat] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, heartbeatId));
  if (!heartbeat || heartbeat.companyId !== companyId) throw conflict("workproduct_producer_scope_mismatch");
  if (delegation) return delegatedProducer(db, companyId, issueId, heartbeat, delegation);
  if (heartbeat.issueId !== issueId) throw conflict("workproduct_producer_scope_mismatch");
  if (!heartbeat.workflowStepRunId || heartbeat.workflowExecutionGeneration === null) {
    // [2026-10-17 재발 결함 — 미연결 신원의 스텝 이슈 등록 거부] 웨이크 typed 컬럼 누락·병합 흡수·
    //   403 사다리 등으로 스텝과 연결되지 않은 하트비트가 스텝 이슈에 산출물을 등록하면 봉인 없는
    //   독 기록이 남아 소비 selector 를 workproduct_selector_provenance_missing 으로 하드 실패시켰다
    //   (2026-09-30 manual-onboarding-publish-*, 2026-10-17 service-onboarding build-service-report-content).
    //   봉인은 같은-런 펜스(createdByRunId === producer.heartbeatRunId === 연결된 디스패치 하트비트)가
    //   요구하므로, 미연결 신원으로는 이슈가 스텝에 바인딩된 이상 어떤 사후 봉인·재바인딩도 소비를
    //   통과시킬 수 없다(producer-rebind-issuance 는 기존 귀속 파싱을 요구). 따라서 스텝 바인딩 이슈의
    //   미연결 신원 등록은 명시 거부한다 — 등록 계약("등록 자체는 늘 성공")과 충돌하지만, 성공은
    //   회복 불가능한 독 기록이 되므로 즉시 실패가 엄격히 낫다. 스텝 바인딩 없는 일반 이슈는
    //   봉인이 필요 없어 현행대로 null(봉인 생램)을 유지한다.
    const bindings = await db.select({ id: workflowStepRuns.id }).from(workflowStepRuns)
      .innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId))
      .where(and(eq(workflowStepRuns.issueId, issueId), eq(workflowRuns.companyId, companyId)));
    if (bindings.length > 0) {
      throw conflict("workproduct_producer_unlinked_registration", {
        issueId, heartbeatRunId: heartbeat.id, stepRunCount: bindings.length,
        hint: "This issue is bound to a workflow step run; register the artifact from the step's dispatched (linked) heartbeat run.",
      });
    }
    return null;
  }
  const [observed] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, heartbeat.workflowStepRunId));
  const locked = observed && await lockProducerSelection(db, { companyId, workflowRunId: observed.workflowRunId,
    stepRunIds: [heartbeat.workflowStepRunId] }, "share");
  const source = locked?.run && locked.steps[0] ? { run: locked.run, step: locked.steps[0] } : null;
  if (!source || source.step.issueId !== issueId || source.step.executionGeneration !== heartbeat.workflowExecutionGeneration) {
    throw conflict("workproduct_producer_stale_generation");
  }
  const attempt = await producerAttempt(db, heartbeat, source.step);
  return { schemaVersion: "workflow.work-product-producer.v1" as const, companyId, missionId: source.run.missionId,
    workflowRunId: source.run.id, stepRunId: source.step.id, stepId: source.step.stepId,
    executionGeneration: heartbeat.workflowExecutionGeneration, ...attempt, heartbeatRunId: heartbeat.id };
}

export function preserveProducerMetadata(metadata: Record<string, unknown> | null | undefined, producer: unknown,
  existing?: Record<string, unknown> | null) {
  const clean = { ...(metadata ?? {}) }; delete clean.workflowProducer;
  // Only dedicated authority writers may supply these keys. A new registration/restamp retires them;
  // ordinary metadata patches preserve the DB originals, including legacy promotion provenance.
  for (const key of ["workflowProducerRebind", "workflowProducerPromotion", "workflowProducerDelegatedOrigin"]) {
    delete clean[key];
    if (existing && Object.hasOwn(existing, key)) clean[key] = existing[key];
  }
  if (producer) clean.workflowProducer = producer;
  return clean;
}
