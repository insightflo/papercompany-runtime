import type { Db } from "@paperclipai/db";
import { issues, workflowRuns } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { resolveMissionWorkProductPaths } from "../work-products/output-paths.js";

export async function resolveWorkflowRunStepOutputDir(
  db: Db,
  input: { companyId: string; workflowRunId?: string | null; stepId?: string | null },
): Promise<string | null> {
  if (!input.workflowRunId) return null;
  const [run] = await db
    .select({ missionId: workflowRuns.missionId, parentIssueId: workflowRuns.parentIssueId })
    .from(workflowRuns)
    .where(and(
      eq(workflowRuns.id, input.workflowRunId),
      eq(workflowRuns.companyId, input.companyId),
    ))
    .limit(1);
  if (!run?.missionId) return null;

  let projectId: string | null = null;
  if (run.parentIssueId) {
    const [parentIssue] = await db
      .select({ projectId: issues.projectId })
      .from(issues)
      .where(and(eq(issues.id, run.parentIssueId), eq(issues.companyId, input.companyId)))
      .limit(1);
    projectId = parentIssue?.projectId ?? null;
  }

  const paths = await resolveMissionWorkProductPaths(db, {
    companyId: input.companyId,
    missionId: run.missionId,
    projectId,
    workflowRunId: input.workflowRunId,
    stepId: input.stepId,
  });
  return paths?.stepOutputDir ?? null;
}
