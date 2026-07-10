import { parseObject } from "../adapters/utils.js";
import {
  extractRuntimeCommand,
  findRuntimeBroadScanCommand,
  normalizeRuntimeShellCommand,
  splitRuntimeShellSegments,
} from "./runtime-broad-scan-command-policy.js";

export interface RuntimeBroadScanToolGuardResult {
  blocked: boolean;
  reason: string | null;
  matchedCommand: string | null;
}

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
  const allowedDirectories = runtimeSearchPaths.outputDirectory ? [runtimeSearchPaths.outputDirectory] : [];
  const workspace = parseObject(input.context.paperclipWorkspace);
  const workspaceCwd = workspace?.cwd;
  const declaredWorkingDirectory = runtimeSearchPaths.workingDirectory
    ?? (typeof workspaceCwd === "string" && workspaceCwd.trim().length > 0 ? workspaceCwd : null);
  const workingDirectory = containsWorkingDirectoryChange(normalized)
    ? null
    : declaredWorkingDirectory;
  for (const segment of splitRuntimeShellSegments(normalized)) {
    const matched = findRuntimeBroadScanCommand({
      command: segment.command,
      allowedPaths,
      allowedDirectories,
      workingDirectory,
      shellVariables: new Map(),
      stdinFromPipe: segment.stdinFromPipe,
    });
    if (!matched) continue;

    return {
      blocked: true,
      matchedCommand: matched,
      reason: `Step Input Manifest blocked runtime broad scan command: "${matched}"`,
    };
  }

  return { blocked: false, reason: null, matchedCommand: null };
}

function readAllowedFileViewPaths(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => parseObject(entry)?.relativePath)
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function readRuntimeSearchPaths(value: unknown) {
  const permissions = parseObject(value);
  const workingDirectory = permissions?.workingDirectory;
  const outputDirectory = permissions?.outputDirectory;
  const dependencyFiles = Array.isArray(permissions?.dependencyFiles)
    ? permissions.dependencyFiles.filter(
      (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
    )
    : [];
  return {
    declared: permissions?.version === 1,
    workingDirectory: typeof workingDirectory === "string" && workingDirectory.trim().length > 0
      ? workingDirectory
      : null,
    outputDirectory: typeof outputDirectory === "string" && outputDirectory.trim().length > 0
      ? outputDirectory
      : null,
    dependencyFiles,
  };
}

function containsWorkingDirectoryChange(command: string) {
  return /(^|[\s;(])(cd|pushd|popd)\s/i.test(command);
}
