import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { conflict } from "../../errors.js";

/** New admission identity is independent of optional lifecycle finalization. */
export async function resolveWorkflowExecutionLink(
  db: Pick<Db, "select">,
  input: {
    enabled?: boolean;
    companyId: string;
    issueId: string | null;
    workflowRunId: string | null;
    workflowStepRunId: string | null;
  },
): Promise<{ workflowRunId: string | null; workflowStepRunId: string | null; generation: number | null }> {
  const unlinked = { workflowRunId: input.workflowRunId, workflowStepRunId: null, generation: null };
  if (!input.workflowStepRunId && !input.issueId) return unlinked;
  const row = await db.select({
    workflowRunId: workflowStepRuns.workflowRunId,
    workflowStepRunId: workflowStepRuns.id,
    generation: workflowStepRuns.executionGeneration,
  }).from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId))
    .leftJoin(issues, eq(issues.id, workflowStepRuns.issueId))
    .where(and(
      eq(workflowRuns.companyId, input.companyId),
      input.workflowStepRunId ? eq(workflowStepRuns.id, input.workflowStepRunId) : undefined,
      input.workflowRunId ? eq(workflowStepRuns.workflowRunId, input.workflowRunId) : undefined,
      input.issueId ? and(eq(workflowStepRuns.issueId, input.issueId), eq(issues.companyId, input.companyId)) : undefined,
    ))
    .orderBy(desc(workflowStepRuns.iterationIndex), desc(workflowStepRuns.startedAt), desc(workflowStepRuns.id))
    .limit(1).then(rows => rows[0] ?? null);
  if (!row && input.workflowStepRunId) throw conflict("heartbeat_workflow_scope_mismatch");
  if (!row && input.workflowRunId && input.issueId) {
    const [linked] = await db.select({ id: workflowStepRuns.id }).from(workflowStepRuns)
      .innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId))
      .where(and(eq(workflowStepRuns.issueId, input.issueId), eq(workflowRuns.companyId, input.companyId))).limit(1);
    if (linked) throw conflict("heartbeat_workflow_scope_mismatch");
  }
  return row ?? unlinked;
}
