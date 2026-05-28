export function resolveHostForUrl(rawHost: string): string {
  const host = rawHost.trim();
  if (!host || host === "0.0.0.0" || host === "::") {
    return "localhost";
  }
  if (host.includes(":") && !host.startsWith("[")) {
    return `[${host}]`;
  }
  return host;
}

export function getPaperclipApiUrl(): string {
  const explicit = process.env.PAPERCLIP_API_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/+$/, "");
  }

  const host = resolveHostForUrl(process.env.PAPERCLIP_LISTEN_HOST ?? process.env.HOST ?? "localhost");
  const port = process.env.PAPERCLIP_LISTEN_PORT ?? process.env.PORT ?? "3200";
  return `http://${host}:${port}`;
}
