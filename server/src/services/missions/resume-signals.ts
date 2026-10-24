import { and, eq, inArray } from "drizzle-orm";
import { toolDefinitions, workflowRunDefinitions, workflowRuns, type Db } from "@paperclipai/db";
import { bindingResolves } from "../workflow/resume/preview-policy.js";
import { previewResume } from "../workflow/resume/preview.js";
import { REVIEWED_RESUME_POLICIES, type ReviewedResumePolicy } from "../workflow/resume/reviewed-policy.js";
import { loadResumeSignerFromEnv } from "../workflow/resume/signer.js";
import { loadRevisionBoardWait } from "./revision-board-wait.js";
import { deriveResumeStartStep } from "./terminal-resume-from-decision.js";

/**
 * [안내 상태 기반화 2026-10-23] 오너 에이전트의 "운영자 할 일" 안내가 캐시·추측이 아니라
 *   호출 시점 실제 상태를 근거하게 하는 구조화 신호. 감시 루프는 이 신호를 읽어
 *   존재하지 않는 화면(리비전 시작)을 안내하거나 재개 가능성을 놓치지 않는다.
 */

export interface ResumableRunSignal {
  workflowRunId: string;
  definitionHash: string;
}

/** 정책이 온전히 resolve 되는지(모든 binding 이 현재 registry 행과 일치) — 부분 일치는 불가. */
export function reviewedResumePolicyFullyResolves(
  policy: ReviewedResumePolicy,
  registryRows: (typeof toolDefinitions.$inferSelect)[],
): boolean {
  return Object.values(policy.steps).every((step) =>
    (step.toolBindings ?? []).every((binding) => bindingResolves(binding, registryRows)));
}

/** 실행 하나의 재개 정책 사전필터 — frozen 정의 해시에 검토 정책이 존재하고 모든 binding 이
 *  현재 registry 행과 resolve 되는가(프리뷰 적격 여부는 별도 확인). */
export async function resumableRunSignalForRun(db: Db, companyId: string,
  workflowRunId: string): Promise<ResumableRunSignal | null> {
  const [frozen] = await db.select({ definitionHash: workflowRunDefinitions.definitionHash })
    .from(workflowRunDefinitions)
    .where(eq(workflowRunDefinitions.workflowRunId, workflowRunId)).limit(1);
  if (!frozen || typeof frozen.definitionHash !== "string") return null;
  const matched = REVIEWED_RESUME_POLICIES.filter((policy) =>
    policy.schemaVersion === 1 && policy.companyId === companyId && policy.definitionHash === frozen.definitionHash);
  if (matched.length !== 1) return null;
  const registryRows = await db.select().from(toolDefinitions).where(eq(toolDefinitions.companyId, companyId));
  return reviewedResumePolicyFullyResolves(matched[0]!, registryRows)
    ? { workflowRunId, definitionHash: frozen.definitionHash } : null;
}

/** 미션의 실패/타임아웃 실행 중 검토된 재개 정책이 온전히 resolve 되는 것들(프리뷰 확정 전 후보). */
export async function resumableRunSignals(db: Db, companyId: string, missionId: string): Promise<ResumableRunSignal[]> {
  const failedRuns = await db.select({ id: workflowRuns.id }).from(workflowRuns)
    .where(and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.missionId, missionId),
      inArray(workflowRuns.status, ["failed", "timed_out"])));
  const signals: ResumableRunSignal[] = [];
  for (const run of failedRuns) {
    const signal = await resumableRunSignalForRun(db, companyId, run.id);
    if (signal) signals.push(signal);
  }
  return signals;
}

/** 미션의 구조화 운영자 신호 — 재개 가능 실행과 리비전 시작 화면 현재 존재 여부. */
export async function operatorGuidanceSignals(db: Db, companyId: string, missionId: string): Promise<{
  resumableRuns: ResumableRunSignal[];
  revisionBoardWaitReady: boolean;
}> {
  const [candidates, boardWait] = await Promise.all([
    resumableRunSignals(db, companyId, missionId),
    loadRevisionBoardWait(db, companyId, missionId),
  ]);
  // [재개 약속 정직화 2026-10-23] 정책 등록(바인딩 일치)만으로는 부족하다 — 실제 프리뷰(게이트·그래프·
  //   선행 증거 포함)를 통과하는 실행만 재개 가능으로 신호한다(카드 옵션·안내가 프리뷰가 거절할
  //   경로를 약속하지 않게 한다).
  const resumableRuns: ResumableRunSignal[] = [];
  for (const candidate of candidates) {
    if (await resumePreviewEligibleForRun(db, { companyId, missionId, workflowRunId: candidate.workflowRunId })) {
      resumableRuns.push(candidate);
    }
  }
  return { resumableRuns, revisionBoardWaitReady: boardWait !== null };
}

/** 실행 하나에 대해 실제 프리뷰가 적격 판정을 내리는가 — 서명 키 부재·오류는 false(fail-closed). */
export async function resumePreviewEligibleForRun(db: Db, input: {
  companyId: string; missionId: string; workflowRunId: string;
}): Promise<boolean> {
  try {
    const startStepId = await deriveResumeStartStep(db, input.workflowRunId);
    if (startStepId === null) return false;
    const result = await previewResume(db, {
      companyId: input.companyId, missionId: input.missionId,
      workflowRunId: input.workflowRunId, startStepId,
    }, loadResumeSignerFromEnv());
    return result.preview.eligible;
  } catch {
    return false;
  }
}
