/**
 * Test dialog input parsing. Keeps JSON validation out of the component so it
 * can be unit tested independently. Invalid JSON is blocked client-side with a
 * clear error before any request is made.
 */

export type ParsedTestInput =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

export function parseTestInput(json: string): ParsedTestInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Invalid JSON." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Test input must be a JSON object." };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/**
 * Pretty-prints a tool test result body for the dialog. Never throws.
 */
export function formatTestResult(result: unknown): string {
  if (result === undefined || result === null) return "";
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}
