import type { WorkflowGraphRunStatus } from "./workflow-graph.js";

export function normalizeGraphRunStatus(value: unknown): WorkflowGraphRunStatus {
  const status = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (status === "running" || status === "succeeded" || status === "failed" || status === "skipped" || status === "paused") {
    return status;
  }
  if (status === "in_progress" || status === "active") {
    return "running";
  }
  if (status === "success" || status === "completed" || status === "done") {
    return "succeeded";
  }
  if (status === "escalated" || status === "blocked" || status === "error" || status === "aborted" || status === "timed-out") {
    return "failed";
  }
  if (status === "cancelled" || status === "canceled") {
    return "skipped";
  }
  return "planned";
}
