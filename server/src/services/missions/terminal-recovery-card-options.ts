import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { workflowRuns, type Db } from "@paperclipai/db";
import {
  TERMINAL_RESUME_OPTION_DESCRIPTION,
  TERMINAL_RESUME_OPTION_ID,
  TERMINAL_RESUME_OPTION_LABEL,
} from "./terminal-resume-from-decision.js";

export async function terminalRestartPathAvailable(
  db: Db,
  companyId: string,
  missionId: string,
  workflowRunId: string | null,
): Promise<boolean> {
  if (!workflowRunId) return false;
  const [source] = await db.select({ id: workflowRuns.id, workflowId: workflowRuns.workflowId })
    .from(workflowRuns).where(and(
      eq(workflowRuns.id, workflowRunId),
      eq(workflowRuns.companyId, companyId),
      eq(workflowRuns.missionId, missionId),
      eq(workflowRuns.status, "failed"),
      isNull(workflowRuns.parentRunId),
    )).limit(1);
  if (!source) return false;
  const [replacement] = await db.select({ id: workflowRuns.id }).from(workflowRuns).where(and(
    eq(workflowRuns.companyId, companyId),
    eq(workflowRuns.missionId, missionId),
    eq(workflowRuns.workflowId, source.workflowId),
    isNull(workflowRuns.parentRunId),
    ne(workflowRuns.id, source.id),
    or(
      inArray(workflowRuns.status, ["pending", "running"]),
      sql`${workflowRuns.metadata}->'operatorDecisionRestart'->>'sourceWorkflowRunId' = ${source.id}`,
    ),
  )).limit(1);
  return !replacement;
}

export function terminalCardStructuredOptions(resumeAvailable: boolean, _restartAvailable: boolean): {
  structuredOptions: { id: string; label: string; description?: string }[];
  recommendedOptionId: string; recommendationReason: string;
} {
  // This compatibility signal checks for a competing run, not whether prior effects started.
  if (!resumeAvailable) {
    return {
      structuredOptions: [{ id: "missing-recovery-target", label: "복구 대상 지정 필요",
        description: "현재 실행에는 검증된 재개 또는 재시작 대상이 없습니다. 새 구조화 복구 대상을 지정해야 합니다." }],
      recommendedOptionId: "missing-recovery-target",
      recommendationReason: "실행 권한이 없는 자연어 복구 경로를 선택하지 않고 유효한 대상을 먼저 지정해야 합니다.",
    };
  }
  return {
    structuredOptions: [{ id: TERMINAL_RESUME_OPTION_ID, label: TERMINAL_RESUME_OPTION_LABEL,
      description: TERMINAL_RESUME_OPTION_DESCRIPTION }],
    recommendedOptionId: TERMINAL_RESUME_OPTION_ID,
    recommendationReason: "실패한 단계만 이어서 실행하는 가장 저렴하고 정확한 경로입니다.",
  };
}
