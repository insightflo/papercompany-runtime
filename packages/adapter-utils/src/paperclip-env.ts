export type BuildPaperclipEnvOptions = {
  context?: Record<string, unknown> | null;
  apiUrl?: string | null;
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizePaperclipApiUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed.replace(/\/+$/, ""));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return trimmed;
}

function apiBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

function stripApiSuffix(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/api") ? trimmed.slice(0, -4) : trimmed;
}

function readContextPaperclipApiUrl(
  context: Record<string, unknown> | null | undefined,
): string | null {
  const rawApiUrl =
    typeof context?.paperclipApiUrl === "string"
      ? context.paperclipApiUrl
      : typeof context?.paperclipControlPlaneUrl === "string"
        ? context.paperclipControlPlaneUrl
        : null;
  if (rawApiUrl) {
    const normalized = normalizePaperclipApiUrl(rawApiUrl);
    if (normalized) return normalized;
  }

  const rawApiBaseUrl =
    typeof context?.paperclipApiBaseUrl === "string"
      ? context.paperclipApiBaseUrl
      : typeof context?.paperclipControlPlaneApiBaseUrl === "string"
        ? context.paperclipControlPlaneApiBaseUrl
        : null;
  return rawApiBaseUrl ? normalizePaperclipApiUrl(stripApiSuffix(rawApiBaseUrl)) : null;
}

export function buildPaperclipEnv(
  agent: { id: string; companyId: string },
  options: BuildPaperclipEnvOptions = {},
): Record<string, string> {
  const resolveHostForUrl = (rawHost: string): string => {
    const host = rawHost.trim();
    if (!host || host === "0.0.0.0" || host === "::") return "localhost";
    if (host.includes(":") && !host.startsWith("[") && !host.endsWith("]")) return `[${host}]`;
    return host;
  };
  const vars: Record<string, string> = {
    PAPERCLIP_AGENT_ID: agent.id,
    PAPERCLIP_COMPANY_ID: agent.companyId,
  };
  const runtimeHost = resolveHostForUrl(
    process.env.PAPERCLIP_LISTEN_HOST ?? process.env.HOST ?? "localhost",
  );
  const runtimePort = process.env.PAPERCLIP_LISTEN_PORT ?? process.env.PORT ?? "3200";
  const apiUrl =
    normalizePaperclipApiUrl(options.apiUrl ?? "") ??
    normalizePaperclipApiUrl(process.env.PAPERCLIP_API_URL ?? "") ??
    readContextPaperclipApiUrl(options.context) ??
    `http://${runtimeHost}:${runtimePort}`;
  vars.PAPERCLIP_API_URL = apiUrl;
  vars.PAPERCLIP_API_BASE_URL = apiBaseUrl(apiUrl);
  return vars;
}

export function isPaperclipRuntimeEnvKey(key: string): boolean {
  return key.startsWith("PAPERCLIP_");
}

export function sanitizeInheritedPaperclipEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!isPaperclipRuntimeEnvKey(key) && typeof value === "string") sanitized[key] = value;
  }
  return sanitized;
}

function stringEnv(value: unknown): Record<string, string> {
  const record = asObject(value);
  const strings: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record ?? {})) {
    if (!isPaperclipRuntimeEnvKey(key) && typeof entry === "string") strings[key] = entry;
  }
  return strings;
}

export function buildPaperclipExecutionEnv(
  runtimeEnv: Record<string, string>,
  configuredEnv: unknown,
  authToken?: string | null,
): Record<string, string> {
  const runtime: Record<string, string> = {};
  for (const [key, value] of Object.entries(runtimeEnv)) {
    if (typeof value === "string") runtime[key] = value;
  }
  const merged: Record<string, string> = {
    ...stringEnv(configuredEnv),
    ...runtime,
  };

  delete merged.PAPERCLIP_API_KEY;
  const token = typeof authToken === "string" ? authToken.trim() : "";
  if (token) merged.PAPERCLIP_API_KEY = token;
  return merged;
}
