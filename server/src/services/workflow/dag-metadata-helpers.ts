export function normalizeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function getMetadataRecord(value: unknown, key: string): Record<string, unknown> {
  const metadata = normalizeRecord(value);
  return normalizeRecord(metadata[key]);
}

export function readMetadataString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
