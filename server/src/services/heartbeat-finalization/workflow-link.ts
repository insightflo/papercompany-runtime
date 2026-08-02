import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowRuns, workflowStepRuns } from "@paperclipai/db";

export async function resolveWorkflowExecutionLink(
  db: Pick<Db, "select">,
  input: {
    enabled: boolean;
    companyId: string;
    issueId: string | null;
    workflowRunId: string | null;
    workflowStepRunId: string | null;
  },
): Promise<{ workflowRunId: string | null; workflowStepRunId: string | null; generation: number | null }> {
  if (!input.enabled) {
    return {
      workflowRunId: input.workflowRunId,
      workflowStepRunId: input.workflowStepRunId,
      generation: null,
    };
  }

  const explicitStepClause = input.workflowStepRunId
    ? eq(workflowStepRuns.id, input.workflowStepRunId)
    : null;
  const issueStepClause = input.issueId
    ? eq(workflowStepRuns.issueId, input.issueId)
    : null;
  const stepClause = explicitStepClause ?? issueStepClause;
  if (!stepClause) {
    return {
      workflowRunId: input.workflowRunId,
      workflowStepRunId: input.workflowStepRunId,
      generation: null,
    };
  }

  const workflowRunClause = input.workflowRunId
    ? eq(workflowStepRuns.workflowRunId, input.workflowRunId)
    : undefined;
  const row = await db
    .select({
      workflowRunId: workflowStepRuns.workflowRunId,
      workflowStepRunId: workflowStepRuns.id,
      generation: workflowStepRuns.executionGeneration,
    })
    .from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId))
    .where(and(
      stepClause,
      workflowRunClause,
      eq(workflowRuns.companyId, input.companyId),
    ))
    .orderBy(
      desc(workflowStepRuns.iterationIndex),
      desc(workflowStepRuns.startedAt),
      desc(workflowStepRuns.id),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);

  return row ?? {
    workflowRunId: input.workflowRunId,
    workflowStepRunId: input.workflowStepRunId,
    generation: null,
  };
}
