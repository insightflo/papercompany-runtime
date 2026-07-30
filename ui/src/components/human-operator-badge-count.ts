export function humanOperatorBadgeCount(
  existingRequestCount: number | undefined,
  pendingDecisionCount: number | undefined,
) {
  return (existingRequestCount ?? 0) + (pendingDecisionCount ?? 0);
}
