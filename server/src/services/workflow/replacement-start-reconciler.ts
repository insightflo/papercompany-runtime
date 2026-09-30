import { and, asc, desc, eq, gt, lte, or, sql } from "drizzle-orm";
import { workflowRecoveryAuthorities, workflowRuns, type Db } from "@paperclipai/db";
import { syncWorkflowRunStateWithOutcome } from "./dag-engine.js";
import { executeWorkflowRunWithStartOutcome } from "./workflow-run-execution.js";
import { logger } from "../../middleware/logger.js";

// Keyset scan, bounded to this sweep's high water mark: a bad first page cannot starve later targets.
// Errors are diagnostic results, never fresh authority or permission to reset the target.
export async function reconcileReplacementStarts(db: Db) {
  const eligible = and(or(eq(workflowRuns.status, "pending"), and(eq(workflowRuns.status, "running"),
    sql`${workflowRuns.metadata}->'replacementStart'->>'deliveredAt' is null`,
    sql`${workflowRuns.metadata}->'replacementStart'->>'authorityId' = ${workflowRecoveryAuthorities.id}::text`)),
    eq(workflowRecoveryAuthorities.recoveryKind, "replacement_from_start_v1"),
    eq(workflowRecoveryAuthorities.status, "consumed"));
  const query = () => db.select({ id: workflowRuns.id, status: workflowRuns.status }).from(workflowRecoveryAuthorities)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowRecoveryAuthorities.replacementRunId));
  const [last] = await query().where(eligible).orderBy(desc(workflowRuns.id)).limit(1);
  const results: Array<{ runId: string; kind: string; code?: string }> = [];
  if (!last) return results;
  let cursor: string | undefined;
  for (;;) {
    const page = await query().where(and(eligible, lte(workflowRuns.id, last.id), cursor ? gt(workflowRuns.id, cursor) : undefined))
      .orderBy(asc(workflowRuns.id)).limit(100);
    if (!page.length) return results;
    for (const run of page) {
      try {
        const outcome = run.status === "running"
          ? await syncWorkflowRunStateWithOutcome(db, run.id)
          : await executeWorkflowRunWithStartOutcome(db, run.id);
        results.push({ runId: run.id, kind: outcome.kind });
      } catch (err) {
        results.push({ runId: run.id, kind: "blocked", code: "replacement_start_failed" });
        logger.warn({ err, runId: run.id, code: "replacement_start_failed" }, "Replacement initial delivery failed; continuing sweep");
      }
    }
    cursor = page[page.length - 1].id;
  }
}
