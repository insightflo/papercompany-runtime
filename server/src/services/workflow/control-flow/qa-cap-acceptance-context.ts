// server/src/services/workflow/control-flow/qa-cap-acceptance-context.ts
//
// [ purpose ] Build the downstream execution-context view of accepted QA-cap
//   limitations, read from the persisted step-run metadata. Consumed by BOTH issue
//   creation (createWorkflowStepIssue) and issue resume (wakeExistingWorkflowStepIssue)
//   so a downstream step sees the accepted nonblocking limitations regardless of
//   whether it is first launched or resumed.

import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowStepRuns } from "@paperclipai/db";
import {
  QA_CAP_ACCEPTANCE_KEY,
  QA_CAP_ACCEPTED_SENTINEL,
  readAcceptanceRecord,
  readAcceptanceRecords,
  readMeta,
} from "./qa-cap-acceptance-records.js";

export interface AcceptedQaLimitationEntry {
  readonly producerStepId: string;
  readonly qaStepId: string;
  readonly limitations: readonly string[];
  readonly acceptedAt: string;
}

export interface DownstreamQaCapAcceptanceContext {
  readonly accepted: readonly AcceptedQaLimitationEntry[];
}

/**
 * [purpose] gather accepted QA-cap limitations carried by the given predecessor step runs.
 *   A predecessor may be (a) a cap-accepted QA gate — its sentinel carries producer + limits,
 *   or (b) a producer whose metadata holds the bounded per-QA acceptance record map.
 *   Returns an empty context when no predecessor carries an acceptance.
 */
export async function loadDownstreamQaCapAcceptanceContext(input: {
  readonly db: Db;
  readonly workflowRunId: string;
  readonly predecessorStepIds: readonly string[];
}): Promise<DownstreamQaCapAcceptanceContext> {
  if (input.predecessorStepIds.length === 0) return { accepted: [] };
  // load ALL step runs for the run so each accepted entry can be checked against its producer's
  // CURRENT completed generation — a stale sentinel/record from a prior producer generation
  // (before rework) must NOT leak into downstream context.
  const allRuns = await input.db
    .select({ stepId: workflowStepRuns.stepId, status: workflowStepRuns.status, iterationIndex: workflowStepRuns.iterationIndex, metadata: workflowStepRuns.metadata })
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, input.workflowRunId));
  const byStepId = new Map(allRuns.map((r) => [r.stepId, r]));
  const isCurrentProducer = (producerStepId: string, producerIteration: number): boolean => {
    const p = byStepId.get(producerStepId);
    return !!p && p.status === "completed" && (p.iterationIndex ?? 0) === producerIteration;
  };
  const predecessorSet = new Set(input.predecessorStepIds);
  const accepted: AcceptedQaLimitationEntry[] = [];
  for (const row of allRuns) {
    if (!predecessorSet.has(row.stepId)) continue;
    const meta = readMeta(row.metadata);
    const sentinel = readAcceptanceRecord(meta[QA_CAP_ACCEPTED_SENTINEL]);
    if (sentinel && isCurrentProducer(sentinel.producerStepId, sentinel.producerIteration)) {
      accepted.push({ producerStepId: sentinel.producerStepId, qaStepId: row.stepId, limitations: sentinel.limitations, acceptedAt: sentinel.acceptedAt });
    }
    for (const [qaStepId, rec] of Object.entries(readAcceptanceRecords(meta[QA_CAP_ACCEPTANCE_KEY]))) {
      // record must own this row (producerStepId === row) AND the producer is still completed at that iteration.
      if (rec.producerStepId === row.stepId && isCurrentProducer(row.stepId, rec.producerIteration)) {
        accepted.push({ producerStepId: row.stepId, qaStepId, limitations: rec.limitations, acceptedAt: rec.acceptedAt });
      }
    }
  }
  return { accepted };
}
