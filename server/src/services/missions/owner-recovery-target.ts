import { and, eq } from "drizzle-orm";
import { issues, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { conflict } from "../../errors.js";
import type { OwnerRecoveryTarget } from "./mission-owner-recovery-events.js";

// Called inside the submission transaction, after the mission lock and before checkout writes.
// Target links convey identity, never permission to dispatch or to consume recovery authority.
export async function assertOwnerRecoveryTarget(db: Db, companyId: string, missionId: string, target?: OwnerRecoveryTarget) {
  if (!target) return;
  const reject = () => conflict("Owner-recovery target is missing, stale or outside the mission", {
    reason: "owner_recovery_target_mismatch",
  });
  if (target.kind === "issue") {
    const [issue] = await db.select({ id: issues.id }).from(issues).where(and(
      eq(issues.id, target.issueId), eq(issues.companyId, companyId), eq(issues.missionId, missionId),
    )).limit(1).for("share");
    if (!issue) throw reject();
    return;
  }
  const [run] = await db.select().from(workflowRuns).where(and(eq(workflowRuns.id, target.workflowRunId),
    eq(workflowRuns.companyId, companyId), eq(workflowRuns.missionId, missionId))).limit(1).for("update");
  if (!run || run.status !== "failed" || run.dispatchAuthorityVersion !== target.expectedAuthorityVersion) throw reject();
  const [step] = await db.select().from(workflowStepRuns).where(and(eq(workflowStepRuns.id, target.stepRunId),
    eq(workflowStepRuns.workflowRunId, target.workflowRunId))).limit(1).for("update");
  if (!step || step.status !== "failed" || step.executionGeneration !== target.expectedExecutionGeneration
    || step.lastDispatchRequestId !== target.failedDispatchRequestId) throw reject();
}
