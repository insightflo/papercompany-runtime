import type { HeartbeatRun, HeartbeatRunSummary } from "@paperclipai/shared";
import { visibleRunCostUsd } from "../lib/utils";

export type AgentDetailView = "dashboard" | "instructions" | "configuration" | "skills" | "runs" | "budget";

export function parseAgentDetailView(value: string | null): AgentDetailView {
  if (value === "instructions" || value === "prompts") return "instructions";
  if (value === "configure" || value === "configuration") return "configuration";
  if (value === "skills") return "skills";
  if (value === "budget") return "budget";
  if (value === "runs") return value;
  return "dashboard";
}

function usageNumber(usage: Record<string, unknown> | null, ...keys: string[]) {
  if (!usage) return 0;
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

export function setsEqual<T>(left: Set<T>, right: Set<T>) {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

export function runMetrics(run: HeartbeatRun | HeartbeatRunSummary) {
  const usage = (run.usageJson ?? null) as Record<string, unknown> | null;
  const result = "resultJson" in run ? ((run as HeartbeatRun).resultJson ?? null) as Record<string, unknown> | null : null;
  const input = usageNumber(usage, "inputTokens", "input_tokens");
  const output = usageNumber(usage, "outputTokens", "output_tokens");
  const cached = usageNumber(
    usage,
    "cachedInputTokens",
    "cached_input_tokens",
    "cache_read_input_tokens",
  );
  const cost =
    visibleRunCostUsd(usage, result);
  return {
    input,
    output,
    cached,
    cost,
    totalTokens: input + output,
  };
}
