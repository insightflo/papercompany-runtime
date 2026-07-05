import { createHash } from "node:crypto";

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, stableJson(record[key])]),
  );
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(stableJson(value));
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashStructuredValue(value: unknown): string {
  return sha256Text(stableStringify(value));
}
