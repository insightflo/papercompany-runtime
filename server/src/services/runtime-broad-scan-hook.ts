/**
 * @fileoverview Runtime broad-scan hook — intercepts a blocked broad-scan command
 * and synthesizes an in-scope output for operator audit (runLogStore/excerpt/
 * liveEvent). Black-box CLI adapters (codex/cursor/claude/gemini/opencode/pi/
 * commandcode) run outside heartbeat's stdio pipe — the synthetic output does
 * NOT reach the agent LLM; the agent still sees its own tool's real output.
 * The run simply continues instead of throwing so the agent can retry with a
 * declared path or missionSearch. Judges a block via findRuntimeBroadScanCommand
 * (SAME policy as the legacy guard) and draws synthetic output ONLY from
 * declared/allowed paths (dependencyFiles, dependencyDirectories, outputDirectory)
 * and the pure missionSearch service. No agent shell is executed — only
 * fs.readdir and missionSearch (bounded/argument-safe). safeResolve rejects ".."
 * traversal and absolute-escape, so an undeclared parent like "steps" is excluded.
 *
 * @module server/services/runtime-broad-scan-hook
 */

import { readdirSync } from "node:fs";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { parseObject } from "../adapters/utils.js";
import {
  extractRuntimeCommand,
  extractShellVariableAssignments,
  findRuntimeBroadScanCommand,
  normalizeRuntimeShellCommand,
  splitRuntimeShellSegments,
} from "./runtime-broad-scan-command-policy.js";
import { cleanShellToken, shellTokenize } from "./runtime-shell-command-utils.js";
import {
  containsWorkingDirectoryChange,
  readAllowedFileViewPaths,
  readRuntimeSearchPaths,
  type RuntimeBroadScanPaths,
} from "./runtime-broad-scan-context.js";
import type { MissionSearchScope } from "./runtime-search-scopes.js";
import type { RuntimeSearchPathPermissions } from "./runtime-search-path-permissions.js";
import { searchMissionScope, type ScopeResult } from "./mission-search.js";

export interface RuntimeBroadScanHookInput {
  adapterType: string;
  line: string;
  ts: string;
  context: Record<string, unknown>;
  runId: string;
}

export interface RuntimeBroadScanHookResult {
  intercepted: boolean;
  rewrittenCommand?: string;
  syntheticOutput?: string;
  reason?: string;
}

const DEFAULT_SEARCH_LIMIT = 50;
const MAX_LIST_ENTRIES = 200;

interface HookContext {
  paths: RuntimeBroadScanPaths;
  allowedPaths: string[];
  allowedDirectories: string[];
  workingDirectory: string | null;
  db: Db;
  runId: string;
}

/**
 * Evaluate a runtime log line. If the command is a blocked broad scan, return an
 * intercepted result carrying a synthetic in-scope output. Otherwise pass-through.
 */
export async function evaluateRuntimeBroadScanHook(
  db: Db,
  input: RuntimeBroadScanHookInput,
): Promise<RuntimeBroadScanHookResult> {
  const manifest = parseObject(input.context.paperclipStepInputManifest);
  const guardrails = parseObject(manifest?.guardrails);
  const paths = readRuntimeSearchPaths(input.context.paperclipRuntimeSearchPaths);
  if (guardrails?.broadScanAllowed === true && !paths.declared) {
    return { intercepted: false };
  }

  const command = extractRuntimeCommand(input.adapterType, input.line);
  if (!command) return { intercepted: false };

  const normalized = normalizeRuntimeShellCommand(command);
  const shellVariables = extractShellVariableAssignments(normalized);

  const allowedPaths = [...readAllowedFileViewPaths(input.context.paperclipFileViews), ...paths.dependencyFiles];
  const allowedDirectories = [
    ...(paths.outputDirectory ? [paths.outputDirectory] : []),
    ...paths.dependencyDirectories,
  ];
  const workspace = parseObject(input.context.paperclipWorkspace);
  const workspaceCwd = workspace?.cwd;
  const declaredWorkingDirectory = paths.workingDirectory
    ?? (typeof workspaceCwd === "string" && workspaceCwd.trim().length > 0 ? workspaceCwd : null);
  const workingDirectoryChanged = containsWorkingDirectoryChange(normalized);
  const workingDirectory = workingDirectoryChanged ? null : declaredWorkingDirectory;

  const repoSearchRoot =
    paths.broadScanRepoAllowed && !workingDirectoryChanged ? declaredWorkingDirectory : null;

  const ctx: HookContext = { paths, allowedPaths, allowedDirectories, workingDirectory, db, runId: input.runId };

  for (const segment of splitRuntimeShellSegments(normalized)) {
    const matched = findRuntimeBroadScanCommand({
      command: segment.command,
      allowedPaths,
      allowedDirectories,
      workingDirectory,
      repoSearchRoot,
      shellVariables,
      stdinFromPipe: segment.stdinFromPipe,
    });
    if (!matched) continue;

    const syntheticOutput = await buildSyntheticOutput(matched, segment.command, ctx);
    return {
      intercepted: true,
      rewrittenCommand: matched,
      syntheticOutput,
      reason: `Broad-scan command intercepted ("${matched}"). Synthetic in-scope output recorded to run log for audit; the run continues (agent sees its own tool output). Next: read the declared paths above or call missionSearch.`,
    };
  }

  return { intercepted: false };
}

async function buildSyntheticOutput(label: string, command: string, ctx: HookContext): Promise<string> {
  switch (label) {
    case "ls -R":
    case "tree":
      return buildRecursiveListing(ctx);
    case "find .":
    case "git ls-files":
      return buildFlatFileList(ctx);
    case "grep -R without path":
    case "rg with a root target":
      return buildSearchListing(label, command, ctx);
    default:
      return buildFlatFileList(ctx);
  }
}

/** ls -R / tree: section-per-directory listing of DECLARED directories only. */
function buildRecursiveListing(ctx: HookContext): string {
  const wd = ctx.paths.workingDirectory;
  const lines = ["# broad-scan intercepted — showing DECLARED in-scope paths only (undeclared parent dirs excluded):"];
  let listed = false;
  for (const dir of dedupe(ctx.allowedDirectories)) {
    const resolved = safeResolve(dir, wd);
    if (!resolved) continue;
    const entries = safeReaddirFileNames(resolved);
    lines.push("");
    lines.push(`${displayPath(resolved, wd)}:`);
    for (const name of entries.slice(0, MAX_LIST_ENTRIES)) {
      lines.push(displayPath(path.join(resolved, name), wd));
      listed = true;
    }
  }
  const declared = ctx.paths.dependencyFiles.map((f) => presentPath(f, wd)).filter((v): v is string => Boolean(v));
  if (declared.length) {
    lines.push("");
    lines.push("declared workProduct files:");
    for (const f of declared.slice(0, MAX_LIST_ENTRIES)) {
      lines.push(f);
      listed = true;
    }
  }
  return listed ? lines.join("\n") : "(no in-scope paths declared for this run)";
}

/** find / git ls-files: flat list of in-scope files. */
function buildFlatFileList(ctx: HookContext): string {
  const wd = ctx.paths.workingDirectory;
  const result = new Set<string>();
  for (const f of ctx.paths.dependencyFiles) {
    const p = presentPath(f, wd);
    if (p) result.add(p);
  }
  for (const dir of ctx.allowedDirectories) {
    const resolved = safeResolve(dir, wd);
    if (!resolved) continue;
    for (const name of safeReaddirFileNames(resolved)) {
      result.add(displayPath(path.join(resolved, name), wd));
    }
  }
  const lines = [...result].slice(0, MAX_LIST_ENTRIES);
  return lines.length
    ? ["# broad-scan intercepted — in-scope files only:", ...lines].join("\n")
    : "(no in-scope files declared for this run)";
}

/** grep -R / rg: run missionSearch over an allowed scope and format results. */
async function buildSearchListing(label: string, command: string, ctx: HookContext): Promise<string> {
  const executable = label.startsWith("rg") ? "rg" : "grep";
  const pattern = extractSearchPattern(command, executable);
  const scope = pickSearchScope(ctx.paths.allowedSearchScopes, ctx.paths.broadScanRepoAllowed);
  if (!scope) return buildFlatFileList(ctx);
  try {
    const result = await searchMissionScope(ctx.db, scope, pattern, DEFAULT_SEARCH_LIMIT, ctx.runId, toPermissions(ctx.paths, ctx.workingDirectory));
    const body = formatSearchResult(result);
    return [`# broad-scan intercepted — missionSearch ${scope} results for "${pattern}":`, body].join("\n");
  } catch {
    return buildFlatFileList(ctx);
  }
}

function extractSearchPattern(command: string, executable: "rg" | "grep"): string {
  const tokens = shellTokenize(command);
  const cmdIdx = tokens.findIndex((t) => t.toLowerCase() === executable);
  if (cmdIdx < 0) return "";
  const positional: string[] = [];
  for (let i = cmdIdx + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token || token === "--") continue;
    if (token.startsWith("-")) {
      if (SEARCH_VALUE_OPTIONS.has(token.toLowerCase()) && i + 1 < tokens.length) i += 1;
      continue;
    }
    positional.push(cleanShellToken(token));
  }
  return positional[0] ?? "";
}

const SEARCH_VALUE_OPTIONS = new Set([
  "-e", "--regexp", "-f", "--file", "-g", "--glob", "--type", "-t", "--type-not", "-T",
  "--context", "-C", "--after-context", "-A", "--before-context", "-B",
]);

function pickSearchScope(
  scopes: readonly MissionSearchScope[],
  broadScanRepoAllowed: boolean,
): MissionSearchScope | null {
  for (const preferred of ["workProduct", "missionOutput"] as const) {
    if (scopes.includes(preferred)) return preferred;
  }
  if (broadScanRepoAllowed && scopes.includes("repo")) return "repo";
  return null;
}

function toPermissions(paths: RuntimeBroadScanPaths, workingDirectory: string | null): RuntimeSearchPathPermissions {
  return {
    version: 1,
    workingDirectory: workingDirectory ?? paths.workingDirectory ?? "",
    outputDirectory: paths.outputDirectory,
    dependencyFiles: paths.dependencyFiles,
    dependencyDirectories: paths.dependencyDirectories,
    allowedSearchScopes: paths.allowedSearchScopes,
    broadScanRepoAllowed: paths.broadScanRepoAllowed,
    qaType: null,
    qaInputScope: null,
  };
}

function formatSearchResult(result: ScopeResult): string {
  const lines: string[] = [];
  if (result.scope === "workProduct") {
    lines.push(...result.files);
    for (const d of result.directories) lines.push(`${d}/`);
  } else if (result.scope === "missionOutput") {
    lines.push(...result.files);
  } else if (result.scope === "repo") {
    for (const m of result.matches) lines.push(`${m.path}:${m.line}:${m.text}`);
  } else if (result.scope === "config") {
    lines.push(...result.files);
  } else if (result.scope === "logs") {
    lines.push(`(logs scope — ${Array.isArray(result.events) ? result.events.length : 0} events)`);
  }
  return lines.slice(0, MAX_LIST_ENTRIES).join("\n") || "(no matches in declared scope)";
}

// --- filesystem helpers (all traversal-guarded; never execute agent shell) ---

function safeResolve(raw: string, workingDirectory: string | null): string | null {
  const trimmed = raw.trim();
  if (!trimmed || hasParentTraversal(trimmed)) return null;
  if (path.isAbsolute(trimmed)) return path.resolve(trimmed);
  if (workingDirectory && path.isAbsolute(workingDirectory)) return path.resolve(workingDirectory, trimmed);
  return null;
}

function hasParentTraversal(target: string): boolean {
  return target.split("/").some((segment) => segment === "..");
}

function safeReaddirFileNames(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function displayPath(absPath: string, workingDirectory: string | null): string {
  if (workingDirectory && path.isAbsolute(workingDirectory)) {
    const rel = path.relative(workingDirectory, absPath);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
  }
  return absPath;
}

function presentPath(raw: string, workingDirectory: string | null): string | null {
  const resolved = safeResolve(raw, workingDirectory);
  return resolved ? displayPath(resolved, workingDirectory) : null;
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}
