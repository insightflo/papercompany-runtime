const SENSITIVE_ENV_KEY_RE =
  /(api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)/i;
const ENV_TOKEN_SEGMENT_RE = /(^|[_-])tokens?([_-]|$)/i;

// Tool env names only: do not apply token segments to usage fields or activity payloads.
export function isSensitiveToolEnvKey(key: string): boolean {
  return SENSITIVE_ENV_KEY_RE.test(key) || ENV_TOKEN_SEGMENT_RE.test(key);
}
