import { parseObject } from "../adapters/utils.js";
import {
  extractRuntimeCommand,
  findRuntimeBroadScanCommand,
  normalizeRuntimeShellCommand,
  splitRuntimeShellSegments,
} from "./runtime-broad-scan-command-policy.js";
import {
  containsWorkingDirectoryChange,
  readAllowedFileViewPaths,
  readRuntimeSearchPaths,
} from "./runtime-broad-scan-context.js";

export interface RuntimeBroadScanToolGuardResult {
  blocked: boolean;
  reason: string | null;
  matchedCommand: string | null;
}

/**
 * Legacy guard entrypoint. Retained as a thin wrapper so existing tests keep
 * exercising the block-judgment policy directly. The heartbeat now uses
 * `evaluateRuntimeBroadScanHook` (intercept + synthesize) instead of throwing.
 *
 * shellVariables stays an empty Map here to preserve the historical contract the
 * guard tests assert against; the hook passes real variable assignments.
 */
export function evaluateRuntimeBroadScanToolGuard(input: {
  adapterType: string;
  line: string;
  ts: string;
  context: Record<string, unknown>;
}): RuntimeBroadScanToolGuardResult {
  const manifest = parseObject(input.context.paperclipStepInputManifest);
  const guardrails = parseObject(manifest?.guardrails);
  const runtimeSearchPaths = readRuntimeSearchPaths(input.context.paperclipRuntimeSearchPaths);
  if (guardrails?.broadScanAllowed === true && !runtimeSearchPaths.declared) {
    return { blocked: false, reason: null, matchedCommand: null };
  }

  const command = extractRuntimeCommand(input.adapterType, input.line);
  if (!command) {
    return { blocked: false, reason: null, matchedCommand: null };
  }

  const normalized = normalizeRuntimeShellCommand(command);
  const allowedPaths = [
    ...readAllowedFileViewPaths(input.context.paperclipFileViews),
    ...runtimeSearchPaths.dependencyFiles,
  ];
  const allowedDirectories = [
    ...(runtimeSearchPaths.outputDirectory ? [runtimeSearchPaths.outputDirectory] : []),
    ...runtimeSearchPaths.dependencyDirectories,
  ];
  const workspace = parseObject(input.context.paperclipWorkspace);
  const workspaceCwd = workspace?.cwd;
  const declaredWorkingDirectory = runtimeSearchPaths.workingDirectory
    ?? (typeof workspaceCwd === "string" && workspaceCwd.trim().length > 0 ? workspaceCwd : null);
  const workingDirectoryChanged = containsWorkingDirectoryChange(normalized);
  const workingDirectory = workingDirectoryChanged
    ? null
    : declaredWorkingDirectory;
  const repoSearchRoot = runtimeSearchPaths.broadScanRepoAllowed && !workingDirectoryChanged
    ? declaredWorkingDirectory
    : null;
  for (const segment of splitRuntimeShellSegments(normalized)) {
    const matched = findRuntimeBroadScanCommand({
      command: segment.command,
      allowedPaths,
      allowedDirectories,
      workingDirectory,
      repoSearchRoot,
      shellVariables: new Map(),
      stdinFromPipe: segment.stdinFromPipe,
    });
    if (!matched) continue;

    return {
      blocked: true,
      matchedCommand: matched,
      reason: `Step Input Manifest blocked runtime broad scan command: "${matched}". Recover BEFORE retrying a broad command: call missionSearch (POST /api/agents/me/mission-search) or read a declared workProduct/dependency path first; only then retry a scan with a specific declared file path or an allowed repo broad-scan scope.`,
    };
  }

  return { blocked: false, reason: null, matchedCommand: null };
}
