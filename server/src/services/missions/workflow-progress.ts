// server/src/services/missions/workflow-progress.ts
//
// [파일 목적] mission workflow run의 step/progress 표현 타입 + 정규화/집계 함수를 한 데 모은 모듈.
//   missions.ts mega-file 회피를 위해 분리. workflow-run 진행 상태 계산에 필요한 순수 로직만.
// [주요 흐름] normalizeMissionWorkflowStepStatus/Type(문자열 → 정규 status/type) → buildWorkflowRunProgress(집계).
// [외부 연결] consumer: missions.ts (import + re-export). Db: workflowRuns/workflowStepRuns infer.
// [수정시 주의] status/type 종류가 바뀌면 MISSION_WORKFLOW_STEP_STATUSES와 MissionWorkflowRunStep["status"] 동기화.
import { workflowRuns, workflowStepRuns } from "@paperclipai/db";
import type { ConditionalEdge } from "../workflow/control-flow/types.js";

/** workflow step에 연결된 issue 요약. */
export type MissionWorkflowStepIssue = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  assigneeAgentId: string | null;
};

/** workflow step 산출물 요약. */
export type MissionWorkflowStepWorkProduct = {
  id: string;
  title: string;
  type: string;
  url: string | null;
  status: string;
  summary: string | null;
  isPrimary: boolean;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
};

/** workflow run 진행 count. */
export type MissionWorkflowRunProgress = {
  totalSteps: number;
  pendingSteps: number;
  runningSteps: number;
  completedSteps: number;
  failedSteps: number;
  skippedSteps: number;
};

/** 정규화된 workflow step. */
export type MissionWorkflowRunStep = {
  stepId: string;
  name: string;
  type: "agent" | "tool";
  agentId: string;
  dependencies: string[];
  // control-flow: IF 조건부 edge + bounded back-edge loop(P5). legacy/일반 step 은 빈 배열.
  // definition stepsJson 의 normalize 결과를 그대로 노출(run view 가 이전에 drop 해서 back-edge 가 안 보였던 버그 수정).
  conditionalDependencies: ConditionalEdge[];
  description: string | null;
  toolNames: string[];
  knowledgeBaseIds: string[];
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  issueId: string | null;
  issue: MissionWorkflowStepIssue | null;
  workProducts: MissionWorkflowStepWorkProduct[];
  startedAt: Date | null;
  completedAt: Date | null;
};

const MISSION_WORKFLOW_STEP_STATUSES = new Set([
  "pending",
  "running",
  "completed",
  "failed",
  "skipped",
] as const);

export function normalizeMissionWorkflowStepStatus(status: string): MissionWorkflowRunStep["status"] {
  return MISSION_WORKFLOW_STEP_STATUSES.has(status as MissionWorkflowRunStep["status"])
    ? (status as MissionWorkflowRunStep["status"])
    : "pending";
}

export function normalizeMissionWorkflowStepType(value: unknown): MissionWorkflowRunStep["type"] {
  return typeof value === "string" && value.trim().toLowerCase() === "tool"
    ? "tool"
    : "agent";
}

/** workflow run 상세(stepRuns + 정규화 steps + progress). */
export type MissionWorkflowRunDetail = typeof workflowRuns.$inferSelect & {
  workflowName: string | null;
  stepRuns: Array<typeof workflowStepRuns.$inferSelect>;
  steps: MissionWorkflowRunStep[];
  progress: MissionWorkflowRunProgress;
};

export function buildWorkflowRunProgress(steps: MissionWorkflowRunStep[]): MissionWorkflowRunProgress {
  return steps.reduce<MissionWorkflowRunProgress>(
    (acc, step) => {
      acc.totalSteps += 1;
      switch (step.status) {
        case "completed":
          acc.completedSteps += 1;
          break;
        case "failed":
          acc.failedSteps += 1;
          break;
        case "running":
          acc.runningSteps += 1;
          break;
        case "skipped":
          acc.skippedSteps += 1;
          break;
        default:
          acc.pendingSteps += 1;
          break;
      }
      return acc;
    },
    {
      totalSteps: 0,
      pendingSteps: 0,
      runningSteps: 0,
      completedSteps: 0,
      failedSteps: 0,
      skippedSteps: 0,
    },
  );
}
