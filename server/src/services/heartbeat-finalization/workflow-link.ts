import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowStepRuns } from "@paperclipai/db";

export async function resolveWorkflowExecutionGeneration(
  db: Pick<Db, "select">,
  input: { enabled: boolean; workflowRunId: string | null; workflowStepRunId: string | null },
): Promise<number | null> {
  if (!input.enabled || !input.workflowRunId || !input.workflowStepRunId) return null;
  return db
    .select({ generation: workflowStepRuns.executionGeneration })
    .from(workflowStepRuns)
    .where(and(
      eq(workflowStepRuns.id, input.workflowStepRunId),
      eq(workflowStepRuns.workflowRunId, input.workflowRunId),
    ))
    .then((rows) => rows[0]?.generation ?? null);
}
