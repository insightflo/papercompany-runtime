import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { readOwnResumeRequestId } from "../workflow/resume-scope-fence.js";

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
    // [Task6c-B] resume run(workflowRuns.metadata.resumeRequestId own key)은 finalization v1
    //   flag 와 무관하게 generation 을 resolve 한다 — typed queue column/wake row 가 resume run
    //   의 세대를 운반해 settlement fence 가 유효하게 한다. ordinary run 은 v1 off 에서
    //   기존과 byte-identical (generation null, read 없음).
    if (!(await isResumeLinkedRun(db, input))) {
      return {
        workflowRunId: input.workflowRunId,
        workflowStepRunId: input.workflowStepRunId,
        generation: null,
      };
    }
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

/** [Task6c-B] v1 off 일 때 대상 run 이 resume run 인지 판정한다(SELECT-only, stamp own-key). */
async function isResumeLinkedRun(
  db: Pick<Db, "select">,
  input: {
    enabled: boolean;
    companyId: string;
    issueId: string | null;
    workflowRunId: string | null;
    workflowStepRunId: string | null;
  },
): Promise<boolean> {
  if (input.workflowRunId) {
    const run = await db
      .select({ metadata: workflowRuns.metadata })
      .from(workflowRuns)
      .where(and(eq(workflowRuns.id, input.workflowRunId), eq(workflowRuns.companyId, input.companyId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return readOwnResumeRequestId(run?.metadata) !== null;
  }
  const explicitStepClause = input.workflowStepRunId
    ? eq(workflowStepRuns.id, input.workflowStepRunId)
    : null;
  const issueStepClause = input.issueId
    ? eq(workflowStepRuns.issueId, input.issueId)
    : null;
  const stepClause = explicitStepClause ?? issueStepClause;
  if (!stepClause) return false;
  const linked = await db
    .select({ metadata: workflowRuns.metadata })
    .from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId))
    .where(and(stepClause, eq(workflowRuns.companyId, input.companyId)))
    .orderBy(desc(workflowStepRuns.iterationIndex), desc(workflowStepRuns.startedAt), desc(workflowStepRuns.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return readOwnResumeRequestId(linked?.metadata) !== null;
}
