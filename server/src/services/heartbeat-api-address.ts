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

export function resolveCurrentPaperclipApiUrl(): string {
  const explicit = normalizePaperclipApiUrl(process.env.PAPERCLIP_API_URL);
  if (explicit) return explicit;
  const host = resolveHostForPaperclipApiUrl(process.env.PAPERCLIP_LISTEN_HOST ?? process.env.HOST);
  const port = process.env.PAPERCLIP_LISTEN_PORT ?? process.env.PORT ?? "3200";
  return `http://${host}:${port}`;
}

export function applyPaperclipApiContext(context: Record<string, unknown>): void {
  const apiUrl = resolveCurrentPaperclipApiUrl();
  context.paperclipApiUrl = apiUrl;
  context.paperclipApiBaseUrl = `${apiUrl.replace(/\/+$/, "")}/api`;
}
