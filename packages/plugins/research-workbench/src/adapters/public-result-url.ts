import { isIP } from "node:net";

const MAX_RESULT_URL_CHARACTERS = 4096;
const BLOCKED_HOST_SUFFIXES = [
  ".home",
  ".internal",
  ".invalid",
  ".lan",
  ".local",
  ".localhost",
  ".onion",
  ".test",
] as const;

export function parsePublicResultUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_RESULT_URL_CHARACTERS) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    if (parsed.username || parsed.password) return null;

    const hostname = parsed.hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .replace(/\.+$/, "");
    if (!hostname || hostname === "localhost" || isIP(hostname) !== 0) return null;
    if (!hostname.includes(".")) return null;
    if (BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return null;

    return parsed.toString();
  } catch {
    return null;
  }
}
