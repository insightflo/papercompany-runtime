import type { WorkspaceOperation } from "@paperclipai/shared";

export function workspaceOperationPhaseLabel(phase: WorkspaceOperation["phase"]) {
  switch (phase) {
    case "worktree_prepare":
      return "Execution context setup";
    case "workspace_provision":
      return "Provision";
    case "workspace_teardown":
      return "Teardown";
    case "worktree_cleanup":
      return "Execution context cleanup";
    default:
      return phase;
  }
}

export function workspaceOperationStatusTone(status: WorkspaceOperation["status"]) {
  switch (status) {
    case "succeeded":
      return "border-green-500/20 bg-green-500/10 text-green-700 dark:text-green-300";
    case "failed":
      return "border-red-500/20 bg-red-500/10 text-red-700 dark:text-red-300";
    case "running":
      return "border-cyan-500/20 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300";
    case "skipped":
      return "border-yellow-500/20 bg-yellow-500/10 text-yellow-700 dark:text-yellow-300";
    default:
      return "border-border bg-muted/40 text-muted-foreground";
  }
}

