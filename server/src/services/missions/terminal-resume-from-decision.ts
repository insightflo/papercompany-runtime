import { eq } from "drizzle-orm";
import { workflowRunDefinitions, workflowStepRuns, type Db } from "@paperclipai/db";
import { loadResumeSignerFromEnv } from "../workflow/resume/signer.js";
import { applyResumeForOperatorDecisionInsideSerialization } from "../workflow/resume/apply.js";
import type { ResumeMutationTransaction, ResumeSerializationContext } from "../workflow/resume/serialization.js";
import { withResumeSerialization } from "../workflow/resume/serialization.js";

/** [승인=재개 2026-10-23] 종말 카드의 재개 옵션 식별자 — 카드 생성(terminal alert)과
 *   resolve 훅(operator-decisions-write)이 같은 값으로 연결된다. */
export const TERMINAL_RESUME_OPTION_ID = "resume-this-run";
export const TERMINAL_RESUME_OPTION_LABEL = "이 실행 이어서 진행(재개)";
export const TERMINAL_RESUME_OPTION_DESCRIPTION =
  "실패한 단계부터 이 실행을 이어서 실행합니다. 이미 완료된 단계와 산출물은 그대로 보존됩니다.";

/** frozen 정의 순서에서 첫 미완료 단계를 재개 시작 지점으로 잡는다. 적격성 판정은
 *  미리보기(preview)가 다시 검증한다 — 여기는 시작점 제안일 뿐이다. */
export async function deriveResumeStartStep(
  db: Db | ResumeMutationTransaction,
  workflowRunId: string,
): Promise<string | null> {
  const [frozen] = await db.select({ steps: workflowRunDefinitions.steps }).from(workflowRunDefinitions)
    .where(eq(workflowRunDefinitions.workflowRunId, workflowRunId)).limit(1);
  const steps = Array.isArray(frozen?.steps) ? frozen.steps : [];
  const stepIds = steps
    .filter((step): step is { id: string } => step !== null && typeof step === "object" && !Array.isArray(step)
      && typeof (step as Record<string, unknown>).id === "string")
    .map((step) => step.id);
  if (stepIds.length === 0) return null;
  const rows = await db.select({ stepId: workflowStepRuns.stepId, status: workflowStepRuns.status })
    .from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, workflowRunId));
  const completed = new Set(rows.filter((row) => row.status === "completed").map((row) => row.stepId));
  return stepIds.find((stepId) => !completed.has(stepId)) ?? null;
}

/** 사람이 종말 카드에서 재개를 선택한 resolve 를 권한 원본으로 재개를 적용한다.
 *  결정 resolve와 재개 전이는 같은 트랜잭션에서 처리되어 어느 한쪽 실패 시 함께 롤백된다. */
export async function resumeRunFromOperatorDecision(db: Db, input: {
  operatorDecisionId: string; resolvedByUserId: string; companyId: string; missionId: string; workflowRunId: string;
}): Promise<{ requestId: string; startStepId: string }> {
  return withResumeSerialization(db, {
    companyId: input.companyId,
    missionId: input.missionId,
    runId: input.workflowRunId,
  }, (context) => resumeRunFromOperatorDecisionInsideSerialization(context, input));
}

/** 결정 resolve와 같은 트랜잭션/잠금 안에서 재개를 적용한다. */
export async function resumeRunFromOperatorDecisionInsideSerialization(
  context: ResumeSerializationContext,
  input: { operatorDecisionId: string; resolvedByUserId: string; companyId: string; missionId: string;
    workflowRunId: string },
): Promise<{ requestId: string; startStepId: string }> {
  const startStepId = await deriveResumeStartStep(context.tx, input.workflowRunId);
  if (startStepId === null) {
    throw new Error("resume_start_step_unavailable");
  }
  const view = await applyResumeForOperatorDecisionInsideSerialization(context, {
    companyId: input.companyId,
    missionId: input.missionId,
    workflowRunId: input.workflowRunId,
    startStepId,
    reason: `operator decision ${input.operatorDecisionId} — terminal card resume option`,
    idempotencyKey: input.operatorDecisionId,
    authorization: { kind: "operator_decision", operatorDecisionId: input.operatorDecisionId,
      resolvedByUserId: input.resolvedByUserId },
  }, loadResumeSignerFromEnv());
  return { requestId: view.id, startStepId };
}
