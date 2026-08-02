import type { Db } from "@paperclipai/db";
import type { HeartbeatRun } from "./owner-capability.js";
import { resolveWorkflowExecutionLink } from "./workflow-link.js";
import { attemptFullSettlement } from "./settlement.js";

export async function settleHeartbeatAfterExecution(
  db: Db,
  run: HeartbeatRun,
  now: Date,
): Promise<void> {
  const settlement = await attemptFullSettlement(db, run, now);
  if (settlement !== "settled") return;
  await syncWorkflowAfterHeartbeatSettlement(db, run);
}

export async function syncWorkflowAfterHeartbeatSettlement(db: Db, run: HeartbeatRun): Promise<void> {
  if (!run.workflowStepRunId) return;
  const link = await resolveWorkflowExecutionLink(db, {
    enabled: true,
    companyId: run.companyId,
    issueId: run.issueId,
    workflowRunId: null,
    workflowStepRunId: run.workflowStepRunId,
  });
  if (!link.workflowRunId) {
    throw new Error(`Cannot sync settled heartbeat ${run.id}: linked workflow run was not found`);
  }

  const { syncWorkflowRunState } = await import("../workflow/dag-engine.js");
  await syncWorkflowRunState(db, link.workflowRunId, "heartbeat_promotion");
}
