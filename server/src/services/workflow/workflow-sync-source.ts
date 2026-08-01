import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { workflowTransitionEvents } from "@paperclipai/db";

export const WORKFLOW_SYNC_SOURCES = [
  "workflow_sync",
  "issues_service",
  "plugin_host",
  "workflow_agent_api",
  "srb_pair_sync",
  "workflow_delegation",
  "heartbeat_promotion",
  "heartbeat_codex_autoblock",
  "issues_route",
  "plugins_route",
  "workflows_route",
  "workflow_execution",
  "workflow_tool_queue",
  "workflow_tool_result",
  "workflow_retry",
  "workflow_cancellation",
  "workflow_reconciler",
  "workflow_deadlock_reconciler",
  "mission_supervision",
  "workflow_issue_closeout",
  "mission_owner_recovery",
  "workflow_qa_cap_acceptance",
  "workflow_source_issue_resume",
] as const;

export type WorkflowSyncSource = (typeof WORKFLOW_SYNC_SOURCES)[number];

const workflowSyncSourceSet = new Set<string>(WORKFLOW_SYNC_SOURCES);

export function normalizeWorkflowSyncSource(source?: string | null): WorkflowSyncSource {
  return source && workflowSyncSourceSet.has(source)
    ? source as WorkflowSyncSource
    : "workflow_sync";
}

const terminalStepStatuses = new Set(["completed", "failed", "skipped"]);

export async function recordWorkflowStepStatusTransition(
  db: Pick<Db, "insert" | "transaction">,
  input: {
    companyId: string;
    missionId?: string | null;
    workflowRunId: string;
    workflowStepRunId: string;
    issueId?: string | null;
    heartbeatRunId?: string | null;
    fromStatus: string;
    toStatus: string;
    source?: WorkflowSyncSource | null;
    transitionVersion?: number | null;
  },
): Promise<void> {
  if (input.fromStatus === input.toStatus || !terminalStepStatuses.has(input.toStatus)) return;

  const transitionVersion = input.transitionVersion;
  if (typeof transitionVersion !== "number" || !Number.isInteger(transitionVersion) || transitionVersion < 1) return;

  const source = normalizeWorkflowSyncSource(input.source);
  try {
    await db.transaction(async (tx) => {
      await tx.insert(workflowTransitionEvents).values({
        companyId: input.companyId,
        missionId: input.missionId ?? null,
        workflowRunId: input.workflowRunId,
        workflowStepRunId: input.workflowStepRunId,
        issueId: input.issueId ?? null,
        heartbeatRunId: input.heartbeatRunId ?? null,
        eventType: "workflow_step_status_transition",
        layer: "workflow_sync",
        fromStatus: input.fromStatus,
        toStatus: input.toStatus,
        reasonCode: source,
        idempotencyKey: `wf-step-status:${input.workflowStepRunId}:${input.toStatus}:${transitionVersion}`,
        payload: {
          source,
          priorStatus: input.fromStatus,
          transitionVersion,
        },
      }).onConflictDoNothing();
    });
  } catch (err) {
    logger.warn(
      { err, workflowStepRunId: input.workflowStepRunId, transitionVersion },
      "failed to record workflow step status provenance",
    );
  }
}
export async function recordWorkflowStepStatusTransitions(
  db: Pick<Db, "insert" | "transaction">,
  input: {
    companyId: string;
    missionId?: string | null;
    workflowRunId: string;
    source: WorkflowSyncSource;
    priorStatusByStepRunId: ReadonlyMap<string, string>;
    stepRuns: ReadonlyArray<{
      id: string;
      issueId: string | null;
      status: string;
      statusTransitionVersion: number;
    }>;
  },
): Promise<void> {
  for (const stepRun of input.stepRuns) {
    await recordWorkflowStepStatusTransition(db, {
      companyId: input.companyId,
      missionId: input.missionId,
      workflowRunId: input.workflowRunId,
      workflowStepRunId: stepRun.id,
      issueId: stepRun.issueId,
      fromStatus: input.priorStatusByStepRunId.get(stepRun.id) ?? "pending",
      toStatus: stepRun.status,
      source: input.source,
      transitionVersion: stepRun.statusTransitionVersion,
    });
  }
}
