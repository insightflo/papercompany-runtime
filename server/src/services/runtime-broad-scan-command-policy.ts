import { asString, parseObject } from "../adapters/utils.js";

const COMMAND_PREFIX_PATTERNS = [
  { label: "find .", pattern: /(^|\s)find\s+/ },
  { label: "git ls-files", pattern: /(^|\s)git\s+ls-files(\s|$)/ },
  { label: "tree", pattern: /(^|\s)tree(\s|$)/ },
  { label: "ls -R", pattern: /(^|\s)ls\s+-(?:[A-Za-z]*R[A-Za-z]*)(\s|$)/ },
  { label: "rg without path", pattern: /(^|\s)rg\s+/ },
  { label: "grep -R without path", pattern: /(^|\s)grep\s+-(?:[^\n]*R|R[^\n]*)(\s|$)/ },
] as const;

type BroadScanCommandLabel = (typeof COMMAND_PREFIX_PATTERNS)[number]["label"];
type SearchExecutable = "rg" | "grep";

interface RuntimeBroadScanCommandInput {
  readonly command: string;
  readonly allowedPaths: readonly string[];
  readonly shellVariables: ReadonlyMap<string, string>;
  readonly stdinFromPipe?: boolean;
}

interface ShellSegment {
  readonly command: string;
  readonly stdinFromPipe: boolean;
}

export function extractRuntimeCommand(adapterType: string, line: string) {
  const parsed = parseJsonLine(line);
  if (!parsed) return null;

  if (adapterType === "codex_local") {
    const item = parseObject(parsed.item);
    if (asString(parsed.type, "") !== "item.started") return null;
    if (asString(item?.type, "") !== "command_execution") return null;
    return asString(item?.command, "") || null;
  }

  if (adapterType === "claude_local") {
    if (asString(parsed.type, "") !== "assistant") return null;
    const message = parseObject(parsed.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const blockRaw of content) {
      const block = parseObject(blockRaw);
      if (!block) continue;
      if (asString(block.type, "") !== "tool_use") continue;
      const name = asString(block.name, "");
      if (name !== "bash" && name !== "shell") continue;
      return asString(parseObject(block.input)?.command, "") || null;
    }
    return null;
  }

  if (adapterType === "cursor" || adapterType === "gemini_local") {
    if (asString(parsed.type, "") !== "tool_call") return null;
    const subtype = asString(parsed.subtype, "").toLowerCase();
    if (subtype !== "started" && subtype !== "start") return null;
    const toolCall = parseObject(parsed.tool_call ?? parsed.toolCall);
    const toolName = toolCall ? Object.keys(toolCall)[0] ?? "" : "";
    const payload = toolName ? parseObject(toolCall?.[toolName]) : null;
    const shellNameAllowed = toolName === "shellToolCall" || toolName === "shell";
    if (!shellNameAllowed) return null;
    const direct = payload?.args ?? payload?.input ?? payload;
    return asString(parseObject(direct)?.command, "") || null;
  }

  if (adapterType === "opencode_local") {
    if (asString(parsed.type, "") !== "tool_use") return null;
    const part = parseObject(parsed.part);
    if (asString(part?.tool, "") !== "bash") return null;
    const state = parseObject(part?.state);
    return asString(parseObject(state?.input)?.command, "") || null;
  }

  if (adapterType === "pi_local") {
    if (asString(parsed.type, "") !== "tool_execution_start") return null;
    const toolName = asString(parsed.toolName, "");
    if (toolName !== "bash" && toolName !== "shell") return null;
    return asString(parseObject(parsed.args)?.command, "") || null;
  }

  return null;
}

export function normalizeRuntimeShellCommand(command: string) {
  return stripShellCommentLines(command.toLowerCase().trim());
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
    if (name && value) variables.set(name, cleanToken(value));
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
    if (hasRepoWideTarget(input.command, input.shellVariables)) return label;
    return areAllExplicitTargetPathsAllowed(input) ? null : label;
  }
  if (label === "git ls-files") return label;
  if (label === "rg without path" || label === "grep -R without path") {
    return evaluateSearchCommand(label, input);
  }
  if (label === "tree" || label === "ls -R") {
    return areAllExplicitTargetPathsAllowed(input) && !hasRepoWideTarget(input.command, input.shellVariables)
      ? null
      : label;
  }
  return label;
}

function evaluateSearchCommand(label: BroadScanCommandLabel, input: RuntimeBroadScanCommandInput) {
  const executable: SearchExecutable = label === "rg without path" ? "rg" : "grep";
  const explicitTargets = extractSearchTargetPaths(input.command, executable, input.shellVariables);
  if (explicitTargets.some(isRepoWideTargetToken)) return label;
  if (input.stdinFromPipe && explicitTargets.length === 0) return null;
  return explicitTargets.length > 0 && explicitTargets.every((target) => isAllowedTargetPath(target, input.allowedPaths))
    ? null
    : label;
}

function areAllExplicitTargetPathsAllowed(input: RuntimeBroadScanCommandInput) {
  const explicitTargets = extractExplicitTargetPaths(input.command, input.shellVariables);
  if (explicitTargets.length === 0) return false;
  return explicitTargets.every((target) => isAllowedTargetPath(target, input.allowedPaths));
}

function hasRepoWideTarget(command: string, shellVariables: ReadonlyMap<string, string>) {
  return shellTokenize(command).some((token) => isRepoWideTargetToken(resolveShellVariableToken(token, shellVariables)));
}

function isRepoWideTargetToken(token: string) {
  const normalized = cleanToken(token);
  return normalized === "." || normalized === "./" || normalized === "$pwd" || normalized === "$(pwd)" || normalized === "`pwd`";
}

function extractExplicitTargetPaths(command: string, shellVariables: ReadonlyMap<string, string>) {
  return shellTokenize(command)
    .filter((token) => !token.startsWith("-"))
    .map((token) => resolveShellVariableToken(token, shellVariables))
    .map(cleanToken)
    .filter((token) => token.length > 0 && !isRepoWideTargetToken(token))
    .filter((token) => token.includes("/") || /\.[a-z0-9]+$/i.test(token));
}

function extractSearchTargetPaths(
  command: string,
  executable: SearchExecutable,
  shellVariables: ReadonlyMap<string, string>,
) {
  const tokens = shellTokenize(command);
  const commandIndex = tokens.findIndex((token) => token === executable);
  if (commandIndex < 0) return [];
  const positional: string[] = [];
  for (let index = commandIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token === "--") continue;
    if (token.startsWith("-")) {
      if (optionTakesValue(token) && index + 1 < tokens.length) index += 1;
      continue;
    }
    positional.push(resolveShellVariableToken(token, shellVariables));
  }
  return positional.slice(1).map(cleanToken).filter(Boolean);
}

function isAllowedTargetPath(target: string, allowedPaths: readonly string[]) {
  const normalized = cleanToken(target);
  if (isRepoWideTargetToken(normalized)) return false;
  if (allowedPaths.some((relativePath) => pathMatchesAllowedPath(normalized, relativePath))) return true;
  return isExplicitSingleFileTarget(normalized);
}

function pathMatchesAllowedPath(target: string, allowedPath: string) {
  const normalizedAllowedPath = cleanToken(allowedPath);
  return target === normalizedAllowedPath || target.endsWith(`/${normalizedAllowedPath}`);
}

function isExplicitSingleFileTarget(target: string) {
  if (!target || /[*?[\]{}]/.test(target)) return false;
  if (target.endsWith("/")) return false;
  if (!target.startsWith("/")) return false;
  const fileName = target.split("/").filter(Boolean).at(-1) ?? "";
  return /\.[a-z0-9][a-z0-9_-]*$/i.test(fileName);
}

function resolveShellVariableToken(token: string, shellVariables: ReadonlyMap<string, string>) {
  const normalized = cleanToken(token);
  const simpleVariableName = normalized.match(/^\$([a-z_][a-z0-9_]*)$/)?.[1];
  const bracedVariableName = normalized.match(/^\$\{([a-z_][a-z0-9_]*)\}$/)?.[1];
  const variableName = simpleVariableName ?? bracedVariableName;
  if (!variableName) return normalized;
  return shellVariables.get(variableName) ?? normalized;
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

function shellTokenize(command: string) {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function stripShellCommentLines(command: string) {
  return command
    .split(/\r?\n/)
    .map((line) => {
      const shellScriptComment = line.match(/^(\s*(?:\/bin\/)?(?:ba)?sh\s+-[a-z]*c\s+['"]?)\s*#/);
      if (shellScriptComment) return shellScriptComment[1] ?? "";
      if (line.trimStart().startsWith("#")) return "";
      return line;
    })
    .join("\n")
    .trim();
}

function cleanToken(token: string) {
  return token.replace(/^['"`]+|['"`,:;!?]+$/g, "").toLowerCase();
}

function parseJsonLine(line: string) {
  try {
    return parseObject(JSON.parse(line));
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}
