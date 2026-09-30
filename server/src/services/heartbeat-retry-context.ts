import { and, desc, eq } from "drizzle-orm";
import { issues, workflowStepRuns, type Db } from "@paperclipai/db";
import { readNonEmptyString } from "./heartbeat-run-context.js";

/** Display/session context only. Typed producer identity is validated separately from the original wake. */
export async function retryContext(db: Db, companyId: string, issueId: string | null, context: Record<string, unknown>) {
  let missionId = readNonEmptyString(context.missionId);
  let workflowRunId = readNonEmptyString(context.workflowRunId);
  let stepId = readNonEmptyString(context.workflowStepId) ?? readNonEmptyString(context.stepId);
  if (issueId && (!missionId || !workflowRunId || !stepId)) {
    const row = await db.select({ missionId: issues.missionId, workflowRunId: workflowStepRuns.workflowRunId, stepId: workflowStepRuns.stepId })
      .from(issues).leftJoin(workflowStepRuns, eq(workflowStepRuns.issueId, issues.id))
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
      .orderBy(desc(workflowStepRuns.startedAt), desc(workflowStepRuns.completedAt)).limit(1).then(rows => rows[0] ?? null);
    missionId = missionId ?? row?.missionId ?? null;
    workflowRunId = workflowRunId ?? row?.workflowRunId ?? null;
    stepId = stepId ?? row?.stepId ?? null;
  }
  return { missionId, workflowRunId, stepId };
}
