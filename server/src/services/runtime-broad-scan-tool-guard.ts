function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

const COMMAND_PREFIX_PATTERNS = [
  { label: "find .", pattern: /(^|\s)find\s+/ },
  { label: "git ls-files", pattern: /(^|\s)git\s+ls-files(\s|$)/ },
  { label: "tree", pattern: /(^|\s)tree(\s|$)/ },
  { label: "ls -R", pattern: /(^|\s)ls\s+-(?:[A-Za-z]*R[A-Za-z]*)(\s|$)/ },
  { label: "rg without path", pattern: /(^|\s)rg\s+/ },
  { label: "grep -R without path", pattern: /(^|\s)grep\s+-(?:[^\n]*R|R[^\n]*)(\s|$)/ },
];

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
  const manifest = asRecord(input.context.paperclipStepInputManifest);
  const guardrails = asRecord(manifest?.guardrails);
  if (guardrails?.broadScanAllowed === true) {
    return { blocked: false, reason: null, matchedCommand: null };
  }

  const allowedPaths = Array.isArray(input.context.paperclipFileViews)
    ? input.context.paperclipFileViews
        .map((value) => asRecord(value)?.relativePath)
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];

  const command = extractCommand(input.adapterType, input.line);
  if (!command) {
    return { blocked: false, reason: null, matchedCommand: null };
  }
  const normalized = command.toLowerCase().trim();
  for (const segment of splitShellSegments(normalized)) {
    const matched = findBroadScanCommand(segment.command, allowedPaths, { stdinFromPipe: segment.stdinFromPipe });
    if (!matched) {
      continue;
    }

    return {
      blocked: true,
      matchedCommand: matched,
      reason: `Step Input Manifest blocked runtime broad scan command: "${matched}"`,
    };
  }

  return { blocked: false, reason: null, matchedCommand: null };
}

function findBroadScanCommand(
  command: string,
  allowedPaths: string[],
  options: { stdinFromPipe?: boolean } = {},
) {
  for (const candidate of COMMAND_PREFIX_PATTERNS) {
    if (!candidate.pattern.test(command)) continue;
    if (candidate.label === "find .") {
      if (hasRepoWideTarget(command)) return candidate.label;
      return areAllExplicitTargetPathsAllowed(command, allowedPaths) ? null : candidate.label;
    }
    if (candidate.label === "git ls-files") {
      return candidate.label;
    }
    if (candidate.label === "rg without path" || candidate.label === "grep -R without path") {
      if (hasRepoWideTarget(command)) return candidate.label;
      if (options.stdinFromPipe && extractExplicitTargetPaths(command).length === 0) return null;
      return areAllExplicitTargetPathsAllowed(command, allowedPaths) ? null : candidate.label;
    }
    if (candidate.label === "tree" || candidate.label === "ls -R") {
      return areAllExplicitTargetPathsAllowed(command, allowedPaths) && !hasRepoWideTarget(command)
        ? null
        : candidate.label;
    }
    return candidate.label;
  }
  return null;
}

function areAllExplicitTargetPathsAllowed(command: string, allowedPaths: string[]) {
  const explicitTargets = extractExplicitTargetPaths(command);
  if (explicitTargets.length === 0) return false;
  return explicitTargets.every((target) => allowedPaths.some((relativePath) => target === relativePath.toLowerCase()));
}

function hasRepoWideTarget(command: string) {
  const tokens = command.split(/\s+/).filter(Boolean);
  return tokens.some((token) => {
    const raw = token.toLowerCase();
    if (
      raw === "." ||
      raw === "./" ||
      raw === "$pwd" ||
      raw === '"$pwd"' ||
      raw === "'$pwd'" ||
      raw === "$(pwd)" ||
      raw === '`pwd`'
    ) {
      return true;
    }
    const normalized = token.replace(/^['"`]+|['"`,:;!?]+$/g, "").toLowerCase();
    return (
      normalized === "." ||
      normalized === "./" ||
      normalized === "$pwd" ||
      normalized === '"$pwd"' ||
      normalized === "'$pwd'" ||
      normalized === "$(pwd)" ||
      normalized === '`pwd`'
    );
  });
}

function extractExplicitTargetPaths(command: string) {
  const tokens = command.split(/\s+/).filter(Boolean);
  const explicit: string[] = [];
  for (const token of tokens) {
    if (token.startsWith("-")) continue;
    const normalized = token.replace(/^['"`]+|['"`,:;!?]+$/g, "").toLowerCase();
    if (!normalized) continue;
    if (normalized === "." || normalized === "./" || normalized === "$pwd" || normalized === '"$pwd"' || normalized === "'$pwd'") {
      continue;
    }
    if (normalized.includes("/") || /\.[a-z0-9]+$/i.test(normalized)) {
      explicit.push(normalized);
    }
  }
  return explicit;
}

function splitShellSegments(command: string) {
  const parts = command.split(/(&&|\|\||;|\|)/);
  const segments: Array<{ command: string; stdinFromPipe: boolean }> = [];
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

function extractCommand(adapterType: string, line: string) {
  const parsed = parseJsonLine(line);
  if (!parsed) return null;

  if (adapterType === "codex_local") {
    const type = asString(parsed.type);
    if (type !== "item.started") return null;
    const item = asRecord(parsed.item);
    if (asString(item?.type) !== "command_execution") return null;
    return asString(item?.command) || null;
  }

  if (adapterType === "claude_local") {
    if (asString(parsed.type) !== "assistant") return null;
    const message = asRecord(parsed.message);
    const content = Array.isArray(message?.content) ? message?.content : [];
    for (const blockRaw of content) {
      const block = asRecord(blockRaw);
      if (!block) continue;
      if (asString(block.type) !== "tool_use") continue;
      const name = asString(block.name);
      if (name !== "bash" && name !== "shell") continue;
      return asString(asRecord(block.input)?.command) || null;
    }
    return null;
  }

  if (adapterType === "cursor" || adapterType === "gemini_local") {
    if (asString(parsed.type) !== "tool_call") return null;
    const subtype = asString(parsed.subtype).toLowerCase();
    if (subtype !== "started" && subtype !== "start") return null;
    const toolCall = asRecord(parsed.tool_call ?? parsed.toolCall);
    const toolName = toolCall ? Object.keys(toolCall)[0] : "";
    const payload = toolName ? asRecord(toolCall?.[toolName]) : null;
    const shellNameAllowed = toolName === "shellToolCall" || toolName === "shell";
    if (!shellNameAllowed) return null;
    const direct = payload?.args ?? payload?.input ?? payload;
    return asString(asRecord(direct)?.command) || null;
  }

  if (adapterType === "opencode_local") {
    if (asString(parsed.type) !== "tool_use") return null;
    const part = asRecord(parsed.part);
    const toolName = asString(part?.tool);
    if (toolName !== "bash") return null;
    const state = asRecord(part?.state);
    return asString(asRecord(state?.input)?.command) || null;
  }

  if (adapterType === "pi_local") {
    if (asString(parsed.type) !== "tool_execution_start") return null;
    const toolName = asString(parsed.toolName);
    if (toolName !== "bash" && toolName !== "shell") return null;
    return asString(asRecord(parsed.args)?.command) || null;
  }

  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
