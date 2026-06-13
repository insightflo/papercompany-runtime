type RunSummary = {
  id?: string;
  parentIssueIdentifier?: string;
  parentIssueId?: string | null;
  runId?: string;
};

type RunOverviewItem = { id: string };

function shortId(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 8 ? trimmed.slice(0, 8) : trimmed;
}

export function manualRunUnavailableMessage(status: string): string {
  const normalized = status.trim().toLowerCase() || "unknown";
  if (normalized === "paused") {
    return "Run 불가: paused 상태입니다. Activate 후 다시 실행하세요.";
  }
  if (normalized === "archived") {
    return "Run 불가: archived 상태입니다. 복원 후 다시 실행하세요.";
  }
  return `Run 불가: ${normalized} 상태에서는 manual run을 시작할 수 없습니다.`;
}

export function buildManualRunButtonState(status: string): {
  disabled: boolean;
  label: string;
  title: string;
  notice: string;
} {
  const normalized = status.trim().toLowerCase();
  if (normalized === "active") {
    return {
      disabled: false,
      label: "▶ Run",
      title: "Start manual workflow run",
      notice: "",
    };
  }

  const notice = manualRunUnavailableMessage(normalized);
  if (normalized === "paused") {
    return {
      disabled: true,
      label: "Paused — Activate 필요",
      title: notice,
      notice,
    };
  }
  if (normalized === "archived") {
    return {
      disabled: true,
      label: "Archived",
      title: notice,
      notice,
    };
  }
  return {
    disabled: true,
    label: "Run 불가",
    title: notice,
    notice,
  };
}

export function buildManualRunFeedback(workflowName: string, run: RunSummary | null | undefined): string {
  const parts = ["Run 시작", workflowName.trim()].filter(Boolean).join(": ");
  const runId = typeof run?.runId === "string" && run.runId.trim()
    ? run.runId.trim()
    : typeof run?.id === "string" && run.id.trim()
      ? run.id.trim()
      : "";
  const issueLabel = typeof run?.parentIssueIdentifier === "string" && run.parentIssueIdentifier.trim()
    ? run.parentIssueIdentifier.trim()
    : typeof run?.parentIssueId === "string" && run.parentIssueId.trim()
      ? shortId(run.parentIssueId)
      : "";

  return [
    parts,
    runId ? shortId(runId) : null,
    issueLabel ? `parent issue ${issueLabel}` : null,
    "Active/Recent Runs에서 새 실행이 강조됩니다.",
  ].filter(Boolean).join(" · ");
}

export function findNewRunId(
  beforeRunIds: Set<string>,
  actionRunId: string | null | undefined,
  activeRuns: RunOverviewItem[],
  recentRuns: RunOverviewItem[],
): string | null {
  if (typeof actionRunId === "string" && actionRunId.trim()) {
    return actionRunId.trim();
  }

  for (const run of [...activeRuns, ...recentRuns]) {
    if (run.id && !beforeRunIds.has(run.id)) {
      return run.id;
    }
  }

  return null;
}
