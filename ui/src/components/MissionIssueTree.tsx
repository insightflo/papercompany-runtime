import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { missionsApi } from "../api/missions";
import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon } from "./PriorityIcon";
import { cn } from "../lib/utils";
import { ChevronRight, ListTree, PlayCircle } from "lucide-react";
import type { Issue } from "@paperclipai/shared";

interface MissionIssueTreeProps {
  missionId: string;
  selectedIssueId?: string | null;
  onSelectIssue?: (issueId: string) => void;
}

interface IssueNodeProps {
  issue: Issue;
  allIssues: Issue[];
  liveRunsByIssueId: Map<string, LiveRunForIssue[]>;
  depth: number;
  selectedIssueId?: string | null;
  onSelectIssue?: (issueId: string) => void;
}

function createdAtTime(issue: Issue) {
  return new Date(issue.createdAt).getTime();
}

function compareIssueCreatedAt(a: Issue, b: Issue) {
  const aTime = createdAtTime(a);
  const bTime = createdAtTime(b);
  if (aTime !== bTime) return aTime - bTime;
  return (a.identifier ?? a.title).localeCompare(b.identifier ?? b.title);
}

function RunIndicator({ runs }: { runs: LiveRunForIssue[] }) {
  if (runs.length === 0) return null;

  const primaryRun = runs[0];
  const extraCount = runs.length - 1;
  const runStatus = primaryRun.status === "queued" ? "queued" : "running";

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
        runStatus === "running"
          ? "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300"
          : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      )}
      title={`Run ${runStatus}${primaryRun.agentName ? ` by ${primaryRun.agentName}` : ""}${
        primaryRun.id ? ` (${primaryRun.id.slice(0, 8)})` : ""
      }`}
    >
      <PlayCircle className="h-3 w-3" />
      <span>Run {runStatus}</span>
      {extraCount > 0 && <span>+{extraCount}</span>}
    </span>
  );
}

function IssueNode({ issue, allIssues, liveRunsByIssueId, depth, selectedIssueId, onSelectIssue }: IssueNodeProps) {
  const children = allIssues.filter((i) => i.parentId === issue.id);
  const hasChildren = children.length > 0;
  const [expanded, setExpanded] = useState(true);
  const isSelected = selectedIssueId === issue.id;
  const liveRuns = liveRunsByIssueId.get(issue.id) ?? [];

  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-2 px-3 py-1.5 text-sm transition-colors hover:bg-accent/50",
          isSelected && "bg-accent/60",
        )}
        style={{ paddingLeft: `${depth * 16 + 12}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            aria-label={expanded ? "Collapse child issues" : "Expand child issues"}
            className="p-0.5 shrink-0"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
          >
            <ChevronRight
              className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")}
            />
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <button
          type="button"
          onClick={() => onSelectIssue?.(issue.id)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <StatusIcon status={issue.status} className="shrink-0" />
          <PriorityIcon priority={issue.priority} className="shrink-0" />
          <span className="flex-1 truncate">{issue.title}</span>
          <RunIndicator runs={liveRuns} />
          {issue.identifier && (
            <span className="shrink-0 text-xs text-muted-foreground font-mono">
              {issue.identifier}
            </span>
          )}
        </button>
      </div>

      {hasChildren && expanded && (
        <div>
          {children.map((child) => (
            <IssueNode
              key={child.id}
              issue={child}
              allIssues={allIssues}
              liveRunsByIssueId={liveRunsByIssueId}
              depth={depth + 1}
              selectedIssueId={selectedIssueId}
              onSelectIssue={onSelectIssue}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function MissionIssueTree({ missionId, selectedIssueId, onSelectIssue }: MissionIssueTreeProps) {
  const { selectedCompanyId } = useCompany();

  const { data: issues, isLoading, error } = useQuery({
    queryKey: queryKeys.missions.issues(missionId),
    queryFn: () => missionsApi.listIssues(missionId),
    enabled: !!selectedCompanyId && !!missionId,
  });

  const { data: liveRuns } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.liveRuns(selectedCompanyId) : ["live-runs", "__no-company__"],
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId && !!missionId,
    refetchInterval: 3000,
  });

  const liveRunsByIssueId = useMemo(() => {
    const map = new Map<string, LiveRunForIssue[]>();
    for (const run of liveRuns ?? []) {
      if (!run.issueId) continue;
      if (run.status !== "running" && run.status !== "queued") continue;
      const existing = map.get(run.issueId);
      if (existing) {
        existing.push(run);
      } else {
        map.set(run.issueId, [run]);
      }
    }
    return map;
  }, [liveRuns]);

  const roots = useMemo(() => {
    if (!issues) return [];
    const issueIds = new Set(issues.map((i) => i.id));
    return issues
      .filter((i) => !i.parentId || !issueIds.has(i.parentId))
      .sort(compareIssueCreatedAt);
  }, [issues]);

  useEffect(() => {
    if (!issues || issues.length === 0 || !onSelectIssue) return;
    if (selectedIssueId && issues.some((issue) => issue.id === selectedIssueId)) return;
    onSelectIssue(roots[0]?.id ?? issues[0].id);
  }, [issues, onSelectIssue, roots, selectedIssueId]);

  if (!selectedCompanyId) return null;

  if (isLoading) {
    return (
      <div className="space-y-1 py-2">
        {[12, 20, 28].map((leftPadding) => (
          <div
            key={`mission-issue-skeleton-${leftPadding}`}
            className="h-7 bg-muted animate-pulse rounded"
            style={{ marginLeft: `${leftPadding}px`, width: `calc(100% - ${leftPadding + 12}px)` }}
          />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <p className="text-sm text-destructive px-3 py-2">
        {error instanceof Error ? error.message : "Failed to load work items"}
      </p>
    );
  }

  if (!issues || issues.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 text-center">
        <ListTree className="h-8 w-8 mb-2 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">No work items linked to this mission.</p>
        <p className="text-xs text-muted-foreground mt-1">
          Work items will appear here once they are associated with this mission.
        </p>
      </div>
    );
  }

  return (
    <div className="border border-border py-1">
      {roots.map((issue) => (
        <IssueNode
          key={issue.id}
          issue={issue}
          allIssues={issues}
          liveRunsByIssueId={liveRunsByIssueId}
          depth={0}
          selectedIssueId={selectedIssueId}
          onSelectIssue={onSelectIssue}
        />
      ))}
    </div>
  );
}
