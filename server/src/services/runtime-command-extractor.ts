import { asString, parseObject } from "../adapters/utils.js";
import { parseJsonLineObject } from "./runtime-shell-command-utils.js";

export function extractRuntimeCommand(adapterType: string, line: string) {
  const parsed = parseJsonLineObject(line);

  // Hermes (and adapters that emit TUI text) log shell invocations as plain-text
  // lines like "┊ 💻 $ <cmd>", NOT a JSON envelope. Parse the command from the raw
  // line before the JSON-only early return below — otherwise hermes_local broad
  // scans slip past the runtime guard entirely (the prior fallback gap).
  if (adapterType === "hermes_local") {
    return extractHermesShellCommand(line);
  }

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
  if (adapterType === "commandcode_local") {
    // Outer frame {"type":"event","event":{...}}; the command lives in a nested
    // tool_queued AgentEvent whose toolName is shell_command (real CLI name).
    if (asString(parsed.type, "") !== "event") return null;
    const event = parseObject(parsed.event);
    if (!event || asString(event.type, "") !== "tool_queued") return null;
    const toolName = asString(event.toolName, "");
    if (toolName !== "shell_command" && toolName !== "bash" && toolName !== "shell") return null;
    return asString(parseObject(event.input)?.command, "") || null;
  }

  return null;
}

/**
 * Extract a shell command from a Hermes TUI text line.
 *
 * Hermes renders shell invocations as bordered text like:
 *   ┊ 💻 $ ls -R /srv/.../steps
 * The leading border glyphs and ANSI color codes are stripped first, then the
 * "💻 $ <command>" prompt prefix is matched. Mirrors the chrome detection in
 * hermes-local-execute.ts (`isHermesCliChromeLine` / `cleanHermesDisplayLine`).
 */
function extractHermesShellCommand(line: string): string | null {
  const stripped = line
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/^[\s│┊╭╰╮╯┌└┐┘├┤─━═]+/, "")
    .trim();
  // Canonical Hermes shell prompt: "💻 $ <command>".
  const prompt = stripped.match(/^💻\s*\$\s*(.+)$/u);
  if (prompt?.[1]?.trim()) return prompt[1].trim();
  return null;
}
