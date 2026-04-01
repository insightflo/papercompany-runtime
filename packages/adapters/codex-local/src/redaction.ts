function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const AUTHORIZATION_BEARER_RE =
  /(Authorization\s*:\s*Bearer\s+)([^"'\\\s,;)}\]]+)/gi;
const PAPERCLIP_API_KEY_ASSIGNMENT_RE =
  /(\bPAPERCLIP_API_KEY\b\s*=\s*)([^"'\\\s,;)}\]]+)/gi;

function sanitizeUnknown(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    return redactCodexSensitiveText(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeUnknown(entry, secrets));
  }
  if (typeof value === "object" && value !== null) {
    const sanitized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      sanitized[key] = sanitizeUnknown(entry, secrets);
    }
    return sanitized;
  }
  return value;
}

export function redactCodexSensitiveText(text: string, secrets: readonly string[] = []): string {
  let redacted = text
    .replace(AUTHORIZATION_BEARER_RE, "$1***REDACTED***")
    .replace(PAPERCLIP_API_KEY_ASSIGNMENT_RE, "$1***REDACTED***");

  const seen = new Set<string>();
  for (const secret of secrets) {
    if (typeof secret !== "string") continue;
    const trimmed = secret.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    redacted = redacted.replace(new RegExp(escapeRegExp(trimmed), "g"), "***REDACTED***");
  }

  return redacted;
}

export function sanitizeCodexLogLine(line: string, secrets: readonly string[] = []): string {
  if (!line) return line;
  try {
    const parsed = JSON.parse(line) as unknown;
    return JSON.stringify(sanitizeUnknown(parsed, secrets));
  } catch {
    return redactCodexSensitiveText(line, secrets);
  }
}

export function sanitizeCodexLogStream(content: string, secrets: readonly string[] = []): string {
  if (!content) return content;
  return content
    .split(/\r?\n/)
    .map((line, index, parts) => {
      const suffix = index < parts.length - 1 ? "\n" : "";
      return sanitizeCodexLogLine(line, secrets) + suffix;
    })
    .join("");
}
