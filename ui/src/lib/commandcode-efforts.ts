/**
 * Build thinking-effort option list for the Command Code (local) adapter.
 *
 * Command Code does NOT have an "auto"/"default" effort level — that slot is
 * Papercompany's "no override" state (empty string = use the model's own
 * default). The remaining options are the per-model supported efforts discovered
 * from `cmd --model <id> --effort <probe>`, e.g. ["high","max"] or
 * ["low","medium","high","xhigh","max"]. A model with no adjustable reasoning
 * effort yields only the "Auto" (no-override) option.
 */
export function buildCommandCodeEffortOptions(
  efforts: string[],
): Array<{ id: string; label: string }> {
  return [
    { id: "", label: "Auto" },
    ...efforts.map((effort) => ({ id: effort, label: labelForEffort(effort) })),
  ];
}

/**
 * Whether a previously-selected Command Code effort should be reset to Auto.
 *
 * Returns true ONLY when the effort list has been successfully loaded AND the
 * current effort is not among the supported levels. While loading (efforts
 * undefined) or before discovery succeeds, returns false — this prevents
 * clearing a valid effort/draft selection before the query resolves.
 */
export function shouldResetCommandCodeEffort(
  currentEffort: string,
  efforts: string[] | undefined,
  loaded: boolean,
): boolean {
  if (!currentEffort) return false;
  if (!loaded || !efforts) return false;
  return !efforts.includes(currentEffort);
}

/** Overrides for compound-word effort levels to match the Codex UI convention. */
const EFFORT_LABEL_OVERRIDES: Record<string, string> = {
  xhigh: "XHigh",
};

function labelForEffort(effort: string): string {
  return EFFORT_LABEL_OVERRIDES[effort] ?? (effort.charAt(0).toUpperCase() + effort.slice(1));
}
