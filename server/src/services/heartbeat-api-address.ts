export function normalizePaperclipApiUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return trimmed.endsWith("/api") ? trimmed.slice(0, -4) : trimmed;
}

export function resolveHostForPaperclipApiUrl(value: string | null | undefined): string {
  const host = value?.trim() ?? "";
  if (!host || host === "0.0.0.0" || host === "::") return "localhost";
  if (host.includes(":") && !host.startsWith("[") && !host.endsWith("]")) return `[${host}]`;
  return host;
}
