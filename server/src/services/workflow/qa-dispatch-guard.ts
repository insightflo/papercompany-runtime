import { and, eq } from "drizzle-orm";
import { missions, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";

export type QaDispatchScope = { db: Db; companyId: string; workflowRunId?: string | null;
  stepRunId?: string | null; stepId?: string | null; requestId?: string };
type Attempt = { missionId: string | null; generation: number; retry: number; iteration: number };
type Reader = Pick<Db, "select">;
const stale = () => new Error("qa_artifact_request_stale");

async function readAttempt(db: Reader, scope: QaDispatchScope, lock: boolean): Promise<Attempt> {
  if (!scope.workflowRunId || !scope.stepRunId || !scope.stepId || !scope.requestId) throw stale();
  const query = db.select().from(workflowRuns).where(and(eq(workflowRuns.id, scope.workflowRunId), eq(workflowRuns.companyId, scope.companyId)));
  const [observed] = await query;
  if (!observed) throw stale();
  // Same mission -> run -> step lock order as workflow admission. Locks exist only
  // across the synchronous spawn, not tool completion, so cancellation can proceed.
  if (observed.missionId) {
    const mq = db.select().from(missions).where(and(eq(missions.id, observed.missionId), eq(missions.companyId, scope.companyId)));
    const [mission] = await (lock ? mq.for("share") : mq);
    if (!mission || !["planning", "active"].includes(mission.status)) throw stale();
  }
  const [run] = await (lock ? query.for("share") : query);
  if (!run || run.status !== "running" || run.missionId !== observed.missionId) throw stale();
  const sq = db.select().from(workflowStepRuns).where(and(eq(workflowStepRuns.id, scope.stepRunId),
    eq(workflowStepRuns.workflowRunId, run.id), eq(workflowStepRuns.stepId, scope.stepId)));
  const [step] = await (lock ? sq.for("share") : sq);
  if (!step || step.status !== "running" || step.lastDispatchRequestId !== scope.requestId) throw stale();
  return { missionId: run.missionId, generation: step.executionGeneration, retry: step.retryCount, iteration: step.iterationIndex };
}

/** DB request identity authorizes execution; status only vetoes it. */
export async function captureQaDispatch(scope: QaDispatchScope) {
  const attempt = await readAttempt(scope.db, scope, false);
  return {
    async assertCurrent() {
      const now = await readAttempt(scope.db, scope, false);
      if (JSON.stringify(now) !== JSON.stringify(attempt)) throw stale();
    },
    async launch<T>(spawn: () => T): Promise<{ result: T }> {
      return scope.db.transaction(async tx => {
        const now = await readAttempt(tx, scope, true);
        if (JSON.stringify(now) !== JSON.stringify(attempt)) throw stale();
        // Attach rejection observation immediately; the transaction commit must
        // not leave an already-failed child Promise temporarily unhandled.
        const result = spawn();
        void Promise.resolve(result).catch(() => undefined);
        return { result };
      });
    },
  };
}
