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
  { label: "rg with a root target", pattern: /(^|\s)rg\s+/i },
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

// rg/find root-target policy: block ONLY an explicit root target — ".", "..", "/",
// a cwd alias / PWD substitution (. ./ $PWD $(pwd) `pwd` ${PWD}), or a target that
// resolves EXACTLY to the workdir / repo root. rg additionally ALLOWS pathless
// search (no explicit target); find with no target stays blocked (implicit execution
// root). Every other explicit non-root target is allowed (no allowlist/extension
// judgment). grep -R, tree, ls -R, git ls-files keep their previous stricter policy.
// repo scope allows all. (ponytail: missing declared path is NOT a guardrail failure
// for ordinary rg — only an explicit root target is.)
function evaluateCandidate(label: BroadScanCommandLabel, input: RuntimeBroadScanCommandInput) {
  if (label === "find .") {
    return evaluateFindCommand(input);
  }
  if (label === "git ls-files") return isRepoSearchCommandAllowed(input) ? null : label;
  if (label === "rg with a root target" || label === "grep -R without path") {
    return evaluateSearchCommand(label, input);
  }
  // tree / ls -R: unchanged policy.
  if (label === "tree" || label === "ls -R") {
    if (isRepoScopedDiscoveryCommand(input)) return null;
    return areAllExplicitTargetPathsAllowed(input) && !hasRepoWideTarget(input.command, input.shellVariables)
      ? null
      : label;
  }
  return label;
}

function evaluateFindCommand(input: RuntimeBroadScanCommandInput) {
  // find [starting-point...] [expression]: path targets precede the expression.
  const tokens = shellTokenize(input.command);
  const startIndex = tokens.findIndex((t) => t.toLowerCase() === "find");
  const targets: string[] = [];
  // `--` 는 option 종결자 — 이후 비-option 토큰은 starting-point 다. 기존에 `--` 에서 break 하면
  //   `find -- .` 가 pathless 로 우회되어 explicit root `.` 차단을 빠져나간다. `--` 는 skip 하고 계속.
  for (let i = startIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) break;
    if (token === "--") continue;
    if (token.startsWith("-")) break;
    targets.push(cleanShellToken(resolveShellVariableToken(token, input.shellVariables)));
  }
  // [handoff req 4] explicit root target (., .., /, cwd-alias, workdir/repo root) is ALWAYS blocked,
  //   even under repo scope — MUST precede the repo-scope allowance so `find . -type f` cannot bypass.
  if (targets.some((target) => isBroadScanTarget(target, input))) return "find .";
  // pathless find = implicit execution root → blocked unless repo-scoped discovery allows it.
  if (targets.length === 0) {
    return isRepoScopedDiscoveryCommand(input) ? null : "find .";
  }
  // explicit non-root target → allowed (no allowlist judgment for find targets).
  return null;
}

function evaluateSearchCommand(label: BroadScanCommandLabel, input: RuntimeBroadScanCommandInput) {
  const executable: SearchExecutable = label === "rg with a root target" ? "rg" : "grep";
  const explicitTargets = extractSearchTargetPaths(input.command, executable);
  // [handoff req 4] an explicit root target (., .., /, cwd-alias, workdir, repo root) is ALWAYS
  //   blocked for rg and grep -R — even under repo scope. This MUST precede the repo-scope allowance
  //   so repo-scoped `rg -n TODO .` / `grep -R .` cannot bypass the root-target block.
  if (explicitTargets.some((target) => isBroadScanTarget(target, input))) {
    return label;
  }
  // repo scope: with no root target, pathless / explicit-in-repo search is allowed.
  if (isRepoSearchCommandAllowed(input) && (
    explicitTargets.length === 0 ||
    explicitTargets.every((target) => isPathInsideRepoSearchRoot(target, input))
  )) {
    return null;
  }
  // rg: pathless search and explicit non-root targets are allowed (root already excluded above).
  if (executable === "rg") {
    return null;
  }
  // grep -R keeps the stricter allow-list policy (block when pathless or any target is off the allowlist).
  if (input.stdinFromPipe && explicitTargets.length === 0) return null;
  if (explicitTargets.length === 0) return label;
  return explicitTargets.every((target) => isAllowedTargetPath(target, input.allowedPaths, input.allowedDirectories, input.workingDirectory))
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

function extractSearchTargetPaths(command: string, executable: SearchExecutable) {
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
      if (normalizedOption === "-f" || normalizedOption === "--file" || normalizedOption.startsWith("--file=")) {
        // rg: a patterns file supplies the pattern, so later positionals are explicit targets.
        // grep keeps its previous policy (block regardless of target) — only rg/find relax.
        if (executable !== "rg") return [];
        patternProvidedByOption = true;
      }
      if (normalizedOption === "-e" || normalizedOption === "--regexp") patternProvidedByOption = true;
      if ((normalizedOption.startsWith("-e") && normalizedOption.length > 2) || normalizedOption.startsWith("--regexp=")) {
        patternProvidedByOption = true;
      }
      if (optionTakesValue(normalizedOption) && index + 1 < tokens.length) index += 1;
      continue;
    }
    positional.push(cleanShellToken(token));
  }
  const patternTargets = patternProvidedByOption ? positional : positional.slice(1);
  // rg only: recover absolute targets merged into the pattern token by escaped-quote
  // forms (rg -n \"PATTERN\"/abs/path). Gated to backslash-bearing tokens so a bare
  // slash-bearing regex (rg -n /api/v1) stays pathless and blocked.
  const embedded = executable === "rg" ? positional.flatMap(extractEmbeddedAbsoluteTargets) : [];
  return Array.from(new Set([...patternTargets, ...embedded])).filter(Boolean);
}

function extractEmbeddedAbsoluteTargets(token: string): string[] {
  // Only the escaped-quote merge form leaves a backslash artifact in the token.
  if (!token.includes("\\")) return [];
  const matches = token.match(/\/(?:[^\s"\\|;&<>]+\/)*[^\s"\\|;&<>]+/gi) ?? [];
  return matches.map((match) => cleanShellToken(match));
}

/** Blocked target: "/", parent-dir aliases (..  ../), a cwd alias / PWD substitution, or resolved target === path.resolve-normalized workdir/repoSearchRoot. Embedded ".." in a path (src/../file) is allowed; roots are normalized so trailing-slash / ".." roots still match. */
function isBroadScanTarget(token: string, input: RuntimeBroadScanCommandInput): boolean {
  const normalized = cleanShellToken(token).toLowerCase();
  if (normalized === "/" || normalized === ".." || normalized === "../" || normalized === "${pwd}" || isRepoWideTargetToken(token)) return true;
  const resolved = resolveForBroadScan(token, input.workingDirectory);
  const rootOf = (value: string | null | undefined) => (value && path.isAbsolute(value) ? path.resolve(value) : "");
  return !!resolved && (rootOf(input.workingDirectory) === resolved || rootOf(input.repoSearchRoot) === resolved);
}

function resolveForBroadScan(token: string, workingDirectory?: string | null): string | null {
  const normalized = cleanShellToken(token);
  if (!normalized) return null;
  if (path.isAbsolute(normalized)) return path.resolve(normalized);
  if (workingDirectory && path.isAbsolute(workingDirectory)) return path.resolve(workingDirectory, normalized);
  return null;
}

// tree / ls -R allow-list check (unchanged policy).
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

const SEARCH_OPTIONS_TAKING_VALUE = new Set([
  "-e", "-f", "--file", "-g", "--glob", "--type", "-t", "--type-not", "-T",
  "--context", "-C", "--after-context", "-A", "--before-context", "-B",
]);
function optionTakesValue(token: string) {
  return SEARCH_OPTIONS_TAKING_VALUE.has(token);
}
