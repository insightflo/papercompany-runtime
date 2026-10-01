import path from "node:path";
export function readWorkflowToolArtifactPath(value: unknown): string | null {
  const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
  const str = (v: unknown) => typeof v === "string" && v.trim() ? v.trim() : null;
  const result = record(value), data = record(result.data);
  const candidate = str(result.artifactPath) ?? str(data.rawPath) ?? str(data.artifactPath);
  return candidate && path.isAbsolute(candidate) ? path.resolve(candidate) : null;
}
