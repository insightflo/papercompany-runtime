import { and, eq, inArray } from "drizzle-orm";
import { toolDefinitions, workflowRunDefinitions, workflowRuns, type Db } from "@paperclipai/db";
import { bindingResolves } from "../workflow/resume/preview-policy.js";
import { REVIEWED_RESUME_POLICIES, type ReviewedResumePolicy } from "../workflow/resume/reviewed-policy.js";
import { loadRevisionBoardWait } from "./revision-board-wait.js";

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

/** 미션의 실패/타임아웃 실행 중 검토된 재개 정책이 온전히 resolve 되는 것들(보드 재개·카드 재개 옵션이 실제로 작동하는 실행). */
export async function resumableRunSignals(db: Db, companyId: string, missionId: string): Promise<ResumableRunSignal[]> {
  const failedRuns = await db.select({ id: workflowRuns.id }).from(workflowRuns)
    .where(and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.missionId, missionId),
      inArray(workflowRuns.status, ["failed", "timed_out"])));
  if (failedRuns.length === 0) return [];
  const runIds = failedRuns.map((row) => row.id);
  const frozen = await db.select({ workflowRunId: workflowRunDefinitions.workflowRunId,
    definitionHash: workflowRunDefinitions.definitionHash })
    .from(workflowRunDefinitions)
    .where(inArray(workflowRunDefinitions.workflowRunId, runIds));
  const hashes = [...new Set(frozen.map((row) => row.definitionHash).filter((hash): hash is string => typeof hash === "string"))];
  const matched = new Map<string, ReviewedResumePolicy>();
  for (const hash of hashes) {
    const policies = REVIEWED_RESUME_POLICIES.filter((policy) =>
      policy.schemaVersion === 1 && policy.companyId === companyId && policy.definitionHash === hash);
    if (policies.length === 1) matched.set(hash, policies[0]!);
  }
  if (matched.size === 0) return [];
  const registryRows = await db.select().from(toolDefinitions).where(eq(toolDefinitions.companyId, companyId));
  return frozen
    .filter((row) => typeof row.definitionHash === "string"
      && matched.has(row.definitionHash)
      && reviewedResumePolicyFullyResolves(matched.get(row.definitionHash)!, registryRows))
    .map((row) => ({ workflowRunId: row.workflowRunId, definitionHash: row.definitionHash as string }));
}

/** 미션의 구조화 운영자 신호 — 재개 가능 실행과 리비전 시작 화면 현재 존재 여부. */
export async function operatorGuidanceSignals(db: Db, companyId: string, missionId: string): Promise<{
  resumableRuns: ResumableRunSignal[];
  revisionBoardWaitReady: boolean;
}> {
  const [resumableRuns, boardWait] = await Promise.all([
    resumableRunSignals(db, companyId, missionId),
    loadRevisionBoardWait(db, companyId, missionId),
  ]);
  return { resumableRuns, revisionBoardWaitReady: boardWait !== null };
}
