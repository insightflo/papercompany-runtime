// Small tolerant value readers shared by the workflow graph builders.
// Split out of workflow-graph.ts (pure move, function bodies unchanged).


function readTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readPlainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readArrayLike(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  const text = value.trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export {
  readTrimmedString,
  readPlainObject,
  readArrayLike,
};
