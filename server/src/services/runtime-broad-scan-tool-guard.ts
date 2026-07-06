import { parseObject } from "../adapters/utils.js";
import {
  extractRuntimeCommand,
  extractShellVariableAssignments,
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
  if (guardrails?.broadScanAllowed === true) {
    return { blocked: false, reason: null, matchedCommand: null };
  }

  const command = extractRuntimeCommand(input.adapterType, input.line);
  if (!command) {
    return { blocked: false, reason: null, matchedCommand: null };
  }

  const normalized = normalizeRuntimeShellCommand(command);
  const shellVariables = extractShellVariableAssignments(normalized);
  const allowedPaths = readAllowedPaths(input.context.paperclipFileViews);
  for (const segment of splitRuntimeShellSegments(normalized)) {
    const matched = findRuntimeBroadScanCommand({
      command: segment.command,
      allowedPaths,
      shellVariables,
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

function readAllowedPaths(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => parseObject(entry)?.relativePath)
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}
