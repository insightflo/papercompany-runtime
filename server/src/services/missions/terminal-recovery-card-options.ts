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

export type RecoveryCardStructuredOption = {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
};

export const TERMINAL_RECOVERY_ACTION_OPTIONS: readonly RecoveryCardStructuredOption[] = [
  {
    id: "retry-revised-input",
    label: "입력 수정 후 재시도",
    description: "실패 원인을 반영해 입력·조건을 수정한 뒤 해당 단계부터 다시 시도하도록 오너에게 지시합니다.",
  },
  {
    id: "replan-mission",
    label: "재계획",
    description: "현재 실행 경로 대신 미션 계획을 다시 수립해 우회·재구성하도록 오너에게 지시합니다.",
  },
  {
    id: "reassign-owner",
    label: "담당 재배정",
    description: "담당 에이전트나 실행 구성을 변경해 다시 진행하도록 오너에게 지시합니다.",
  },
  {
    id: "cancel-mission",
    label: "취소",
    description: "추가 복구를 중단하고 미션 또는 해당 복구 요청을 종료하도록 오너에게 지시합니다.",
  },
];

export const DEAD_TARGET_RECOVERY_ACTION_OPTIONS: readonly RecoveryCardStructuredOption[] =
  TERMINAL_RECOVERY_ACTION_OPTIONS.filter((option) => option.id !== "retry-revised-input");

const PREREQUISITE_NOTICE_OPTION_IDS = new Set(["missing-recovery-target"]);
const PREREQUISITE_NOTICE_LABEL_RE = /지정\s*필요|^복구\s*대상\s*없음|^재개\s*대상\s*없음/;

export function isPrerequisiteNoticeOption(option: { readonly id: string; readonly label: string }): boolean {
  return PREREQUISITE_NOTICE_OPTION_IDS.has(option.id.trim())
    || PREREQUISITE_NOTICE_LABEL_RE.test(option.label.trim());
}

export function hasEnoughActionableOptions(
  options: ReadonlyArray<{ readonly id: string; readonly label: string }>,
): boolean {
  let actionableCount = 0;
  for (const option of options) {
    if (!isPrerequisiteNoticeOption(option)) actionableCount += 1;
  }
  return actionableCount >= 2;
}

export function terminalCardStructuredOptions(
  resumeAvailable: boolean,
  _restartAvailable: boolean,
  resumeStartStepId?: string | null,
): {
  structuredOptions: { id: string; label: string; description?: string }[];
  recommendedOptionId: string | null;
  recommendationReason: string | null;
  prerequisiteNotice: string | null;
} {
  // This compatibility signal checks for a competing run, not whether prior effects started.
  if (!resumeAvailable) {
    return {
      structuredOptions: TERMINAL_RECOVERY_ACTION_OPTIONS.map((option) => ({ ...option })),
      recommendedOptionId: null,
      recommendationReason: null,
      prerequisiteNotice: "현재 실행에는 검증된 자동 재개 대상이 없어 아래 복구 방법 중 하나를 선택해야 합니다.",
    };
  }
  const stepId = typeof resumeStartStepId === "string" && resumeStartStepId.trim().length > 0
    ? resumeStartStepId.trim()
    : null;
  return {
    structuredOptions: [
      {
        id: TERMINAL_RESUME_OPTION_ID,
        label: stepId ? `이 실행 이어서 진행(재개 · ${stepId})` : TERMINAL_RESUME_OPTION_LABEL,
        description: stepId
          ? `실패한 ${stepId} 단계부터 이 실행을 이어서 실행합니다. 이미 완료된 단계와 산출물은 그대로 보존됩니다.`
          : TERMINAL_RESUME_OPTION_DESCRIPTION,
      },
      ...TERMINAL_RECOVERY_ACTION_OPTIONS.map((option) => ({ ...option })),
    ],
    recommendedOptionId: TERMINAL_RESUME_OPTION_ID,
    recommendationReason: "실패한 단계만 이어서 실행하는 가장 저렴하고 정확한 경로입니다.",
    prerequisiteNotice: null,
  };
}
