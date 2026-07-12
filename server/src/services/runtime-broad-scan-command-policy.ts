import path from "node:path";
export { extractRuntimeCommand } from "./runtime-command-extractor.js";
import {
  cleanShellToken,
  shellTokenize,
  stripShellCommentLines,
} from "./runtime-shell-command-utils.js";

const COMMAND_PREFIX_PATTERNS = [
  { label: "find .", pattern: /(^|\s)find\s+/i },
  { label: "git ls-files", pattern: /(^|\s)git\s+ls-files(\s|$)/i },
  { label: "tree", pattern: /(^|\s)tree(\s|$)/i },
  { label: "ls -R", pattern: /(^|\s)ls\s+-(?:[A-Za-z]*R[A-Za-z]*)(\s|$)/i },
  { label: "rg without an allowed file path", pattern: /(^|\s)rg\s+/i },
  { label: "grep -R without path", pattern: /(^|\s)grep\s+-(?:[^\n]*R|R[^\n]*)(\s|$)/i },
] as const;

type BroadScanCommandLabel = (typeof COMMAND_PREFIX_PATTERNS)[number]["label"];
type SearchExecutable = "rg" | "grep";

interface RuntimeBroadScanCommandInput {
  readonly command: string;
  readonly allowedPaths: readonly string[];
  readonly allowedDirectories: readonly string[];
  readonly workingDirectory?: string | null;
  readonly repoSearchRoot?: string | null;
  readonly shellVariables: ReadonlyMap<string, string>;
  readonly stdinFromPipe?: boolean;
}

interface ShellSegment {
  readonly command: string;
  readonly stdinFromPipe: boolean;
}

export function normalizeRuntimeShellCommand(command: string) {
  return stripShellCommentLines(command.trim());
}

export function splitRuntimeShellSegments(command: string): readonly ShellSegment[] {
  const parts = command.split(/(\s+&&\s+|\s+\|\|\s+|;|\s+\|\s+)/);
  const segments: ShellSegment[] = [];
  let previousOperator: string | null = null;
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (trimmed === "&&" || trimmed === "||" || trimmed === ";" || trimmed === "|") {
      previousOperator = trimmed;
      continue;
    }
    segments.push({ command: trimmed, stdinFromPipe: previousOperator === "|" });
    previousOperator = null;
  }
  return segments;
}

export function extractShellVariableAssignments(command: string): ReadonlyMap<string, string> {
  const variables = new Map<string, string>();
  const assignmentPattern = /(?:^|[\s;])([a-z_][a-z0-9_]*)=(?:"([^"\n;]+)"|'([^'\n;]+)'|([^\s;]+))/g;
  for (const match of command.matchAll(assignmentPattern)) {
    const name = match[1];
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (name && value) variables.set(name, cleanShellToken(value));
  }
  return variables;
}

export function findRuntimeBroadScanCommand(input: RuntimeBroadScanCommandInput) {
  for (const candidate of COMMAND_PREFIX_PATTERNS) {
    if (!candidate.pattern.test(input.command)) continue;
    return evaluateCandidate(candidate.label, input);
  }
  return null;
}

function evaluateCandidate(label: BroadScanCommandLabel, input: RuntimeBroadScanCommandInput) {
  if (label === "find .") {
    if (isRepoScopedDiscoveryCommand(input)) return null;
    if (hasRepoWideTarget(input.command, input.shellVariables)) return label;
    return areAllExplicitTargetPathsAllowed(input) ? null : label;
  }
  if (label === "git ls-files") return isRepoSearchCommandAllowed(input) ? null : label;
  if (label === "rg without an allowed file path" || label === "grep -R without path") {
    return evaluateSearchCommand(label, input);
  }
  if (label === "tree" || label === "ls -R") {
    if (isRepoScopedDiscoveryCommand(input)) return null;
    return areAllExplicitTargetPathsAllowed(input) && !hasRepoWideTarget(input.command, input.shellVariables)
      ? null
      : label;
  }
  return label;
}

function evaluateSearchCommand(label: BroadScanCommandLabel, input: RuntimeBroadScanCommandInput) {
  const executable: SearchExecutable = label === "rg without an allowed file path" ? "rg" : "grep";
  const explicitTargets = extractSearchTargetPaths(input.command, executable, input.shellVariables);
  if (isRepoSearchCommandAllowed(input) && (
    explicitTargets.length === 0 ||
    explicitTargets.some(isRepoWideTargetToken) ||
    explicitTargets.every((target) => isPathInsideRepoSearchRoot(target, input))
  )) {
    return null;
  }
  if (explicitTargets.some(isRepoWideTargetToken)) return label;
  if (input.stdinFromPipe && explicitTargets.length === 0) return null;
  return explicitTargets.length > 0 && explicitTargets.every((target) => isAllowedTargetPath(
    target,
    input.allowedPaths,
    input.allowedDirectories,
    input.workingDirectory,
  ))
    ? null
    : label;
}

function areAllExplicitTargetPathsAllowed(input: RuntimeBroadScanCommandInput) {
  const explicitTargets = extractExplicitTargetPaths(input.command, input.shellVariables);
  if (explicitTargets.length === 0) return false;
  return explicitTargets.every((target) => isAllowedTargetPath(
    target,
    input.allowedPaths,
    input.allowedDirectories,
    input.workingDirectory,
  ));
}

function hasRepoWideTarget(command: string, shellVariables: ReadonlyMap<string, string>) {
  return shellTokenize(command).some((token) => isRepoWideTargetToken(resolveShellVariableToken(token, shellVariables)));
}

function isRepoWideTargetToken(token: string) {
  const normalized = cleanShellToken(token).toLowerCase();
  return normalized === "." || normalized === "./" || normalized === "$pwd" || normalized === "$(pwd)" || normalized === "`pwd`";
}

function extractExplicitTargetPaths(command: string, shellVariables: ReadonlyMap<string, string>) {
  return shellTokenize(command)
    .filter((token) => !token.startsWith("-"))
    .map((token) => resolveShellVariableToken(token, shellVariables))
    .map(cleanShellToken)
    .filter((token) => token.length > 0 && !isRepoWideTargetToken(token))
    .filter((token) => token.includes("/") || /\.[a-z0-9]+$/i.test(token));
}

function extractSearchTargetPaths(
  command: string,
  executable: SearchExecutable,
  shellVariables: ReadonlyMap<string, string>,
) {
  const tokens = shellTokenize(command);
  const commandIndex = tokens.findIndex((token) => token.toLowerCase() === executable);
  if (commandIndex < 0) return [];
  const positional: string[] = [];
  let patternProvidedByOption = false;
  for (let index = commandIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token === "--") continue;
    if (token.startsWith("-")) {
      const normalizedOption = token.toLowerCase();
      if (normalizedOption === "-f" || normalizedOption === "--file" || normalizedOption.startsWith("--file=")) return [];
      if (normalizedOption === "-e" || normalizedOption === "--regexp") patternProvidedByOption = true;
      if ((normalizedOption.startsWith("-e") && normalizedOption.length > 2) || normalizedOption.startsWith("--regexp=")) {
        patternProvidedByOption = true;
      }
      if (optionTakesValue(normalizedOption) && index + 1 < tokens.length) index += 1;
      continue;
    }
    positional.push(cleanShellToken(token));
  }
  return (patternProvidedByOption ? positional : positional.slice(1)).filter(Boolean);
}

function isAllowedTargetPath(
  target: string,
  allowedPaths: readonly string[],
  allowedDirectories: readonly string[],
  workingDirectory?: string | null,
) {
  const normalized = cleanShellToken(target);
  if (isRepoWideTargetToken(normalized)) return false;
  if (!isExplicitSingleFileTarget(normalized)) return false;
  const resolvedTarget = resolvePath(normalized, workingDirectory);
  if (!resolvedTarget) return false;
  if (allowedPaths.some((allowedPath) => resolvePath(allowedPath, workingDirectory) === resolvedTarget)) return true;
  return allowedDirectories.some((allowedDirectory) => {
    const resolvedDirectory = resolvePath(allowedDirectory, workingDirectory);
    if (!resolvedDirectory) return false;
    const relative = path.relative(resolvedDirectory, resolvedTarget);
    return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
  });
}

function resolvePath(value: string, workingDirectory?: string | null) {
  const normalized = cleanShellToken(value);
  if (!normalized || hasParentTraversal(normalized)) return null;
  if (path.isAbsolute(normalized)) return path.resolve(normalized);
  if (!workingDirectory || !path.isAbsolute(workingDirectory)) return null;
  return path.resolve(workingDirectory, normalized);
}

function hasParentTraversal(target: string) {
  return target.split("/").some((segment) => segment === "..");
}

function isExplicitSingleFileTarget(target: string) {
  if (!target || /[*?[\]{}]/.test(target)) return false;
  if (target.endsWith("/")) return false;
  const fileName = target.split("/").filter(Boolean).at(-1) ?? "";
  return /\.[a-z0-9][a-z0-9_-]*$/i.test(fileName);
}

function resolveShellVariableToken(token: string, shellVariables: ReadonlyMap<string, string>) {
  const normalized = cleanShellToken(token);
  const simpleVariableName = normalized.match(/^\$([a-z_][a-z0-9_]*)$/)?.[1];
  const bracedVariableName = normalized.match(/^\$\{([a-z_][a-z0-9_]*)\}$/)?.[1];
  const variableName = simpleVariableName ?? bracedVariableName;
  if (!variableName) return normalized;
  return shellVariables.get(variableName) ?? normalized;
}

function isRepoSearchCommandAllowed(input: RuntimeBroadScanCommandInput): boolean {
  return typeof input.repoSearchRoot === "string" && path.isAbsolute(input.repoSearchRoot);
}

function isRepoScopedDiscoveryCommand(input: RuntimeBroadScanCommandInput): boolean {
  if (!isRepoSearchCommandAllowed(input)) return false;
  const explicitTargets = extractExplicitTargetPaths(input.command, input.shellVariables);
  if (explicitTargets.length === 0) return true;
  if (explicitTargets.some(isRepoWideTargetToken)) return true;
  return explicitTargets.every((target) => isPathInsideRepoSearchRoot(target, input));
}

function isPathInsideRepoSearchRoot(target: string, input: RuntimeBroadScanCommandInput): boolean {
  if (!input.repoSearchRoot) return false;
  const resolvedTarget = resolvePath(target, input.workingDirectory);
  if (!resolvedTarget) return false;
  const relative = path.relative(input.repoSearchRoot, resolvedTarget);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function optionTakesValue(token: string) {
  return [
    "-e",
    "-f",
    "-g",
    "--glob",
    "--type",
    "-t",
    "--type-not",
    "-T",
    "--context",
    "-C",
    "--after-context",
    "-A",
    "--before-context",
    "-B",
  ].includes(token);
}
