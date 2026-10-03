import { isSensitiveToolEnvKey } from "../tool-env-sensitivity.js";

export function displayRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
/** Display only. Never interpret the sanitized text as a command or a decision. */
export function toolRecoverySafeText(value: unknown, secrets: string[] = [], max = 600): string {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return "unavailable";
  let text = String(value);
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join("[REDACTED]");
  // A header value can contain a scheme, spaces and commas. Suppress the whole
  // diagnostic line tail rather than guessing which token is the credential.
  text = text.replace(/\b(?:proxy-)?authorization["']?\s*[=:]\s*[^\r\n]*/gi, "Authorization: [REDACTED]");
  text = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi, raw => {
    try { const url = new URL(raw); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.toString(); }
    catch { return "[REDACTED_URL]"; }
  });
  text = text.replace(/(["'])([\w-]+)\1\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,}\s]+)/g,
    (match, quote: string, key: string) => isSensitiveToolEnvKey(key) ? `${quote}${key}${quote}:"[REDACTED]"` : match);
  text = text.replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [REDACTED]");
  const spans: Array<{ start: number; end: number }> = [];
  for (const match of text.matchAll(/([\w-]+)(\s*[=:]\s*|\s+)/g)) {
    if (!isSensitiveToolEnvKey(match[1])) continue;
    const start = match.index! + match[0].length;
    const value = text.slice(start).match(/^("[^"\n]*"|'[^'\n]*'|[^\s,;]+)/);
    if (value) spans.push({ start, end: start + value[0].length });
  }
  for (const span of spans.reverse()) text = text.slice(0, span.start) + "[REDACTED]" + text.slice(span.end);
  return text.replace(/[\r\n\t]/g, " ").replace(/`/g, "'").slice(0, max);
}
export function toolRecoveryHiddenValues(config: unknown): string[] {
  const values: string[] = [];
  const walk = (value: unknown, hidden = false, depth = 0) => {
    if (depth > 8) return;
    if (typeof value === "string") { if (hidden && value) values.push(value); return; }
    if (Array.isArray(value)) { value.slice(0, 100).forEach(v => walk(v, hidden, depth + 1)); return; }
    for (const [key, child] of Object.entries(displayRecord(value)).slice(0, 100))
      walk(child, hidden || key === "env" || key === "headers" || isSensitiveToolEnvKey(key), depth + 1);
  };
  walk(config);
  return values;
}
export function toolRecoveryPathFacts(value: unknown, secrets: string[], depth = 0): Record<string, string> {
  const result: Record<string, string> = {};
  if (depth > 3) return result;
  for (const [key, child] of Object.entries(displayRecord(value)).slice(0, 30)) {
    if (isSensitiveToolEnvKey(key)) continue;
    if (typeof child === "string" && /(?:path|dir|file|url)$/i.test(key)) result[key] = toolRecoverySafeText(child, secrets);
    else if (child && typeof child === "object" && !Array.isArray(child)) {
      for (const [nested, text] of Object.entries(toolRecoveryPathFacts(child, secrets, depth + 1))) result[`${key}.${nested}`] = text;
    }
  }
  return Object.fromEntries(Object.entries(result).slice(0, 30));
}
