import type { workflowStepRuns } from "@paperclipai/db";
import { normalizeRecord } from "./dag-metadata-helpers.js";
import { readAcceptanceRecord } from "./control-flow/qa-cap-acceptance-records.js";
import { readAttempts } from "./control-flow/verdict-store.js";

export function stepRunNeedsWorkflowResume(stepRun: typeof workflowStepRuns.$inferSelect): boolean {
  return stepRun.status === "pending" && (stepRun.iterationIndex ?? 0) > 0;
}

export function isPendingReworkAwaitingCurrentIssueCompletion(
  stepRun: typeof workflowStepRuns.$inferSelect,
  issueCompletedAt: Date | null,
): boolean {
  if (stepRun.status !== "pending" || (stepRun.iterationIndex ?? 0) === 0) return false;
  const priorCompletedAt = readAttempts(stepRun.metadata).at(-1)?.completedAt;
  if (!priorCompletedAt || !issueCompletedAt) return true;
  const priorCompletedMs = new Date(priorCompletedAt).getTime();
  return !Number.isFinite(priorCompletedMs) || issueCompletedAt.getTime() <= priorCompletedMs;
}

/**
 * [qa-cap acceptance anti-flap, generation-aware] a completed QA is protected from
 *   request_changes+done re-derivation ONLY while its qaCapAccepted sentinel's
 *   producerStepId/producerIteration match a CURRENTLY completed producer row in this run.
 *   A new producer generation (rework) breaks the match => protection lifts, re-derivation resumes.
 */
export function matchesCurrentCapAcceptedProducer(
  qaStepRun: (typeof workflowStepRuns.$inferSelect),
  stepRuns: ReadonlyArray<(typeof workflowStepRuns.$inferSelect)>,
): boolean {
  const sentinel = readAcceptanceRecord(normalizeRecord(qaStepRun.metadata).qaCapAccepted);
  if (!sentinel) return false; // forged/malformed metadata never suppresses QA re-derivation
  return stepRuns.some(
    (r) => r.stepId === sentinel.producerStepId && r.status === "completed" && (r.iterationIndex ?? 0) === sentinel.producerIteration,
  );
}
