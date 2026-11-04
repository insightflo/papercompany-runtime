export type CodexAuthAutoBlockInfo = {
  reasonCode: string;
  authErrorCode: string | null;
};

const CODEX_AUTH_401_ERROR_CODE_PREFIX = "codex_auth_401";

function normalizeReasonCodeSegment(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function detectCodexAuthFailureForAutoBlock(input: {
  adapterType: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  stdoutExcerpt?: string | null;
  stderrExcerpt?: string | null;
}): CodexAuthAutoBlockInfo | null {
  if (input.adapterType !== "codex_local") return null;

  const normalizedErrorCode = (input.errorCode ?? "").trim().toLowerCase();
  if (normalizedErrorCode.startsWith(CODEX_AUTH_401_ERROR_CODE_PREFIX)) {
    const authErrorCode = normalizedErrorCode.slice(CODEX_AUTH_401_ERROR_CODE_PREFIX.length).replace(/^_+/, "");
    if (authErrorCode) return {
      reasonCode: `CODEX_AUTH_401_${normalizeReasonCodeSegment(authErrorCode)}`,
      authErrorCode,
    };
  }

  const haystack = [
    input.errorMessage ?? "",
    input.stdoutExcerpt ?? "",
    input.stderrExcerpt ?? "",
  ]
    .join("\n")
    .trim();

  const explicitAuthErrorCode = haystack.match(/\bauth error code:\s*([a-z0-9_]+)/i)?.[1]?.toLowerCase() ?? null;
  const detectedAuthErrorCode =
    explicitAuthErrorCode ??
    (haystack.match(/\b(refresh_token_reused|token_expired|invalid_grant|session_expired)\b/i)?.[1]?.toLowerCase() ?? null);

  const hasProviderSpecific401 = Boolean(detectedAuthErrorCode) || /\bauth error:\s*401\b/i.test(haystack);
  if (hasProviderSpecific401 && (normalizedErrorCode === CODEX_AUTH_401_ERROR_CODE_PREFIX || /\b401\s+unauthorized\b|\bauth error:\s*401\b/i.test(haystack))) {
    return {
      reasonCode: detectedAuthErrorCode
        ? `CODEX_AUTH_401_${normalizeReasonCodeSegment(detectedAuthErrorCode)}`
        : "CODEX_AUTH_401",
      authErrorCode: detectedAuthErrorCode,
    };
  }

  if (
    detectedAuthErrorCode ||
    /provided authentication token is expired|access token could not be refreshed|please log out and sign in again|no codex credentials stored/i.test(
      haystack,
    )
  ) {
    const authErrorCode = detectedAuthErrorCode ?? "reauth_required";
    return {
      reasonCode: `CODEX_AUTH_${normalizeReasonCodeSegment(authErrorCode)}`,
      authErrorCode,
    };
  }

  return null;
}
