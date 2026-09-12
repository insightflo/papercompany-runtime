// server/src/services/quality/evaluation-delivery.ts
//
// [purpose] [§3.3 규칙5] 후보 고정 커밋 후 검증 B 단계의 전달(깨우기). wake false 는
//   readiness/실행가능성 실패이므로 같은 idempotencyKey(같은 intent)로 저장 run/definition 을
//   재조회·재시도하고(유한), 계속 실패하면 구조화 activity 행으로 기록한다.
//   evaluation-candidates.ts 300줄 규칙 준수를 위해 추출된 형제 파일이다.
// [boundary] 전달 시도 행(idempotencyKey) 이나 B 체크인(checkoutRunId) 이 이미 있으면 재발송하지
//   않는다. 201 응답은 저장된 후보·평가 사실 그대로 — replay 가 전달을 다시 몬다.

import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, issues, workflowDefinitions, workflowRuns } from "@paperclipai/db";
import { uuidSchema } from "@paperclipai/shared";
import { z } from "zod";
import { conflict } from "../../errors.js";
import { normalizeWorkflowStepsForExecution, wakeExistingWorkflowStepIssue } from "../workflow/dag-engine.js";
import { QUALITY_VERIFY_STEP_ID } from "./native-definition.js";
import { findQualityWakeRowByExactKey, qualityWakeKey } from "./native-wake.js";

/** 커밋 후 깨우기 재시도 상한(유한) — 회사 정책 수치가 아니라 전달 엔진 상수다. */
export const MAX_VERIFIER_WAKE_ATTEMPTS = 3;

const nonNegativeInteger = z.number().int().safe().min(0);

/** 커밋 후 B 단계 전달. 실패(false) 시 같은 intent(같은 idempotencyKey)로 재조회·재시도한다. */
export async function deliverVerifierStep(db: Db, input: {
  companyId: string; actionId: string; evaluationId: string;
  workflowRunId: string; verifierStepRunId: string; verifierIssueId: string; generation: number;
}): Promise<void> {
  const idempotencyKey = qualityWakeKey({
    actionId: input.actionId, stepRunId: input.verifierStepRunId, generation: input.generation, attempt: 1,
  });
  if (await findQualityWakeRowByExactKey(db, { companyId: input.companyId, idempotencyKey })) return;
  const [checkedOut] = await db.select({ checkoutRunId: issues.checkoutRunId }).from(issues)
    .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.verifierIssueId)));
  if (checkedOut?.checkoutRunId) return; // B 가 이미 체크인 — 전달된 intent
  for (let attempt = 1; attempt <= MAX_VERIFIER_WAKE_ATTEMPTS; attempt += 1) {
    const [run] = await db.select().from(workflowRuns)
      .where(and(eq(workflowRuns.companyId, input.companyId), eq(workflowRuns.id, input.workflowRunId)));
    if (!run) break;
    const [definition] = await db.select().from(workflowDefinitions)
      .where(and(eq(workflowDefinitions.companyId, input.companyId), eq(workflowDefinitions.id, run.workflowId)));
    if (!definition) break;
    const step = normalizeWorkflowStepsForExecution(definition.stepsJson)
      .find((candidate) => candidate.id === QUALITY_VERIFY_STEP_ID);
    if (!step) break;
    const woke = await wakeExistingWorkflowStepIssue({
      db, run, definition, step, stepRunId: input.verifierStepRunId, issueId: input.verifierIssueId,
      forceFreshSession: true, idempotencyKey,
    });
    if (woke) return;
    if (await findQualityWakeRowByExactKey(db, { companyId: input.companyId, idempotencyKey })) return;
  }
  await db.insert(activityLog).values({
    companyId: input.companyId, actorType: "system", actorId: "quality", action: "quality.verifier_wake_failed",
    entityType: "evaluator_candidate_run", entityId: input.evaluationId,
    details: {
      actionId: input.actionId, evaluationId: input.evaluationId, verifierIssueId: input.verifierIssueId,
      verifierStepRunId: input.verifierStepRunId, generation: input.generation,
      idempotencyKey, attempts: MAX_VERIFIER_WAKE_ATTEMPTS,
    },
  });
}

/** replay 저장 계약의 검증자 step 판독(전체 evaluationStateSchema 가 아닌 필요 필드만 엄격히). */
const replayStepSchema = z.object({
  verifier: z.object({
    agentId: uuidSchema,
    step: z.object({
      issueId: uuidSchema, stepRunId: uuidSchema, workflowRunId: uuidSchema,
      generation: nonNegativeInteger, dispatchAuthorityVersion: nonNegativeInteger,
    }).strict(),
    run: z.unknown().nullable(),
  }).strict(),
}).passthrough();

export function replayVerifierStep(qualityContract: unknown) {
  const parsed = replayStepSchema.safeParse(qualityContract);
  if (!parsed.success || (qualityContract as { kind?: unknown }).kind !== "evaluation") throw conflict("quality_candidate_contract_missing");
  return parsed.data.verifier.step;
}
