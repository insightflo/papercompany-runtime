// Stale verdict guard for QA back-edge rework (RES-995).
//
// A QA REQUEST_CHANGES verdict observed BEFORE the producer's current iteration
// completion belongs to a previous producer generation. Consuming it again would
// spend the rework iteration cap twice and re-enter rework on stale evidence.
//
// This module keeps the guard pure (time comparison only, no DB) so it is easy
// to unit-test. loop-driver wires it into applyBackEdgeReworkPass; the actual
// re-queue of the QA step for a fresh run is handled by the existing
// syncStepRunsFromIssueState validation-recheck path.

export type ValidationVerdictTiming = { observedAt: Date | null };

export function isStaleQaVerdict(input: {
  qaIssueId: string | null;
  producerCompletedAt: Date | null;
  validationVerdictsByIssueId?: ReadonlyMap<string, ValidationVerdictTiming | undefined>;
}): boolean {
  if (!input.producerCompletedAt) return false;
  if (!input.qaIssueId || !input.validationVerdictsByIssueId) return false;
  const observedAt = input.validationVerdictsByIssueId.get(input.qaIssueId)?.observedAt ?? null;
  if (!observedAt) return false;
  return observedAt.getTime() < input.producerCompletedAt.getTime();
}

export type RejectableQa = {
  qaRun?: { issueId?: string | null } | null;
};

export function filterFreshRejectedQas<TQa extends RejectableQa>(
  rejectedQas: readonly TQa[],
  producerCompletedAt: Date | null,
  validationVerdictsByIssueId?: ReadonlyMap<string, ValidationVerdictTiming | undefined>,
): TQa[] {
  return rejectedQas.filter((q) => !isStaleQaVerdict({
    qaIssueId: q.qaRun?.issueId ?? null,
    producerCompletedAt,
    validationVerdictsByIssueId,
  }));
}
