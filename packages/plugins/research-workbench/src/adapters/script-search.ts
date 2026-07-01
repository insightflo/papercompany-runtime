import { spawn } from "node:child_process";
import type {
  ResearchSearchInput,
  VaneHeadlessSearchOutput,
  VaneHeadlessSearchResult,
} from "../types.js";

const DEFAULT_SCRIPT_TIMEOUT_MS = 30_000;
const MAX_BUFFER_CHARS = 4 * 1024 * 1024;

export interface ScriptSearchAdapterOptions {
  command: string;
  workingDirectory?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface ScriptSearchInput extends ResearchSearchInput {
  maxResults: number;
  categories?: string[];
}

export interface ScriptSearchAdapter {
  search(input: ScriptSearchInput): Promise<VaneHeadlessSearchOutput>;
}

function normalizeCommandParts(command: string): string[] {
  const parts: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null = null;

  while ((match = pattern.exec(command)) !== null) {
    const part = match[1] ?? match[2] ?? match[3] ?? "";
    if (part.length > 0) parts.push(part);
  }

  return parts;
}

function asResultArray(value: unknown): VaneHeadlessSearchResult[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .map((entry) => ({
      title: typeof entry.title === "string" ? entry.title : "Untitled result",
      url: typeof entry.url === "string" ? entry.url : "",
      snippet: typeof entry.snippet === "string" ? entry.snippet : typeof entry.summary === "string" ? entry.summary : "",
      source: typeof entry.source === "string" ? entry.source : undefined,
      publishedAt: typeof entry.publishedAt === "string" || entry.publishedAt === null ? entry.publishedAt : undefined,
      raw: typeof entry.raw === "object" && entry.raw !== null && !Array.isArray(entry.raw)
        ? entry.raw as Record<string, unknown>
        : undefined,
    }))
    .filter((entry) => entry.url.length > 0);
}

function parseScriptOutput(stdout: string, input: ScriptSearchInput): VaneHeadlessSearchOutput {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return {
      ok: false,
      error: "Script produced empty stdout; expected JSON search results",
      retryable: false,
      engine: { name: "script" },
      retrievedAt: new Date().toISOString(),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return {
      ok: false,
      error: `Script stdout was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      retryable: false,
      engine: { name: "script" },
      retrievedAt: new Date().toISOString(),
    };
  }

  const record = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};

  if (record.ok === false) {
    return {
      ok: false,
      error: typeof record.error === "string" ? record.error : "Script reported failure",
      retryable: typeof record.retryable === "boolean" ? record.retryable : false,
      retryAfterSeconds: typeof record.retryAfterSeconds === "number" ? record.retryAfterSeconds : undefined,
      engine: { name: "script" },
      retrievedAt: new Date().toISOString(),
    };
  }

  const engine = typeof record.engine === "object" && record.engine !== null && !Array.isArray(record.engine)
    ? record.engine as Record<string, unknown>
    : {};
  const suggestions = Array.isArray(record.suggestions)
    ? record.suggestions.filter((entry): entry is string => typeof entry === "string")
    : undefined;

  return {
    ok: true,
    query: typeof record.query === "string" ? record.query : input.query,
    results: asResultArray(record.results),
    suggestions,
    engine: {
      name: "script",
      upstreamVersion: typeof engine.upstreamVersion === "string" ? engine.upstreamVersion : undefined,
      patchVersion: typeof engine.patchVersion === "string" ? engine.patchVersion : undefined,
    },
    retrievedAt: typeof record.retrievedAt === "string" ? record.retrievedAt : new Date().toISOString(),
  };
}

export function createScriptSearchAdapter(options: ScriptSearchAdapterOptions): ScriptSearchAdapter {
  const commandParts = normalizeCommandParts(options.command);
  if (commandParts.length === 0) {
    throw new Error("scriptCommand is required for script backend");
  }

  const executable = commandParts[0];
  const args = commandParts.slice(1);
  const timeoutMs = options.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;

  async function search(input: ScriptSearchInput): Promise<VaneHeadlessSearchOutput> {
    const payload = JSON.stringify(input);

    return await new Promise<VaneHeadlessSearchOutput>((resolve) => {
      const child = spawn(executable, args, {
        cwd: options.workingDirectory || undefined,
        env: { ...process.env, ...(options.env ?? {}) },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const finish = (result: VaneHeadlessSearchOutput) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish({
          ok: false,
          error: `Script search timed out after ${timeoutMs}ms`,
          retryable: true,
          retryAfterSeconds: 60,
          engine: { name: "script" },
          retrievedAt: new Date().toISOString(),
        });
      }, timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.length > MAX_BUFFER_CHARS) {
          child.kill("SIGTERM");
          finish({
            ok: false,
            error: `Script stdout exceeded ${MAX_BUFFER_CHARS} characters`,
            retryable: false,
            engine: { name: "script" },
            retrievedAt: new Date().toISOString(),
          });
        }
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        if (stderr.length > MAX_BUFFER_CHARS) stderr = stderr.slice(-MAX_BUFFER_CHARS);
      });
      child.on("error", (err) => {
        finish({
          ok: false,
          error: `Script search failed to start: ${err.message}`,
          retryable: false,
          engine: { name: "script" },
          retrievedAt: new Date().toISOString(),
        });
      });
      child.on("close", (code) => {
        if (settled) return;
        if (code !== 0) {
          finish({
            ok: false,
            error: `Script search exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
            retryable: false,
            engine: { name: "script" },
            retrievedAt: new Date().toISOString(),
          });
          return;
        }
        finish(parseScriptOutput(stdout, input));
      });

      child.stdin.end(payload);
    });
  }

  return { search };
}
