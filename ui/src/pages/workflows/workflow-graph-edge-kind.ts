import type { WorkflowGraphEdgeKind } from "./workflow-graph.js";

export function normalizeGraphEdgeKind(value: unknown): WorkflowGraphEdgeKind {
  const kind = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (kind === "conditional" || kind === "failure" || kind === "early-stop") return kind;
  return "normal";
}
