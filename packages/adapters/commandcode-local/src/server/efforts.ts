import { asString, runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { discoveryCacheKey, firstNonEmptyLine, normalizeEnv, resolveCommandCodeCommand } from "./models.js";

const EFFORTS_CACHE_TTL_MS = 300_000;

/**
 * Sentinel effort value that Command Code always rejects at argument-validation
 * time (before any model invocation), causing it to print the model's supported
 * efforts and exit 1. Real effort levels are simple lowercase words, so a value
 * with surrounding double-underscores is never valid.
 */
const EFFORT_PROBE_SENTINEL = "__paperclip_probe__";

const EFFORT_TOKEN_RE = /^[a-z]+$/;

/**
 * Parse the per-model effort list from a `cmd --model <id> --effort <sentinel>`
 * probe. Command Code validates `--effort` before invoking the model, so an
 * invalid sentinel produces (on stderr):
 *   `Unknown effort "<sentinel>". Supported: high, max.`
 * Models without adjustable reasoning effort produce:
 *   `<Model> has no adjustable reasoning effort.`
 *
 * Returns the supported effort tokens in declared order, or an empty list when
 * the model has no adjustable effort.
 */
export function parseCommandCodeEffortsProbe(stderr: string, stdout: string): string[] {
  const haystack = stderr || stdout;
  if (!haystack) return [];

  if (/no adjustable reasoning effort/i.test(haystack)) return [];

  const match = haystack.match(/Supported:\s*(.+?)\s*\./s);
  if (!match) return [];

  return match[1]
    .split(",")
    .map((token) => token.trim())
    .filter((token) => EFFORT_TOKEN_RE.test(token));
}

/**
 * Whether the probe output was recognized as a valid effort-validation response
 * (either a "Supported:" list or an explicit "no adjustable reasoning effort").
 * Used by the discovery layer to distinguish a genuine empty-effort result from
 * an unrelated failure (missing binary, auth error, etc.).
 */
export function isRecognizedEffortProbeOutput(stderr: string, stdout: string): boolean {
  const haystack = stderr || stdout;
  if (!haystack) return false;
  return /no adjustable reasoning effort/i.test(haystack) || /Supported:/i.test(haystack);
}

export async function discoverCommandCodeModelEfforts(
  modelId: string,
  input: { command?: unknown; cwd?: unknown; env?: unknown } = {},
): Promise<string[]> {
  const command = resolveCommandCodeCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const runtimeEnv = normalizeEnv({ ...process.env, ...env });

  const result = await runChildProcess(
    `commandcode-efforts-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    command,
    ["--model", modelId, "--effort", EFFORT_PROBE_SENTINEL, "-p", "", "--no-session", "--no-auto-update"],
    {
      cwd,
      env: runtimeEnv,
      timeoutSec: 20,
      graceSec: 3,
      onLog: async () => {},
    },
  );

  if (result.timedOut) {
    throw new Error(`\`cmd --effort\` probe for "${modelId}" timed out.`);
  }

  const efforts = parseCommandCodeEffortsProbe(result.stderr, result.stdout);
  // The probe is expected to exit 1 (invalid sentinel effort). When the output
  // is unrecognized the probe did not behave as expected (missing binary, auth
  // error, etc.), so fail loudly via the raw discovery API.
  if (efforts.length === 0 && !isRecognizedEffortProbeOutput(result.stderr, result.stdout)) {
    const detail = firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout);
    throw new Error(
      detail
        ? `\`cmd --effort\` probe for "${modelId}" failed: ${detail}`
        : `\`cmd --effort\` probe for "${modelId}" failed.`,
    );
  }
  return efforts;
}

const effortsCache = new Map<string, { expiresAt: number; efforts: string[] }>();

function effortsCacheKey(modelId: string, command: string, cwd: string, env: Record<string, string>): string {
  // Reuse the models.ts cache key (which hashes env values and strips volatile
  // keys) so no secret plaintext is retained in the efforts cache key.
  return `${modelId}\n${discoveryCacheKey(command, cwd, env)}`;
}

export async function discoverCommandCodeModelEffortsCached(
  modelId: string,
  input: { command?: unknown; cwd?: unknown; env?: unknown } = {},
): Promise<string[]> {
  const command = resolveCommandCodeCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const key = effortsCacheKey(modelId, command, cwd, env);
  const now = Date.now();
  for (const [k, v] of effortsCache.entries()) {
    if (v.expiresAt <= now) effortsCache.delete(k);
  }
  const cached = effortsCache.get(key);
  if (cached && cached.expiresAt > now) return cached.efforts;

  const efforts = await discoverCommandCodeModelEfforts(modelId, { command, cwd, env });
  effortsCache.set(key, { expiresAt: now + EFFORTS_CACHE_TTL_MS, efforts });
  return efforts;
}

/** Best-effort wrapper: returns [] when discovery fails (missing cmd, auth, etc.). */
export async function listCommandCodeModelEfforts(modelId: string): Promise<string[]> {
  try {
    return await discoverCommandCodeModelEffortsCached(modelId);
  } catch {
    return [];
  }
}

export function resetCommandCodeEffortsCacheForTests() {
  effortsCache.clear();
}
