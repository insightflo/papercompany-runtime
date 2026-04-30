import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { missionsApi } from "../api/missions";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon } from "./PriorityIcon";
import { cn } from "../lib/utils";
import { ChevronRight, ListTree } from "lucide-react";
import type { Issue } from "@paperclipai/shared";

interface MissionIssueTreeProps {
  missionId: string;
  selectedIssueId?: string | null;
  onSelectIssue?: (issueId: string) => void;
}

interface IssueNodeProps {
  issue: Issue;
  allIssues: Issue[];
  depth: number;
  selectedIssueId?: string | null;
  onSelectIssue?: (issueId: string) => void;
}

function IssueNode({ issue, allIssues, depth, selectedIssueId, onSelectIssue }: IssueNodeProps) {
  const children = allIssues.filter((i) => i.parentId === issue.id);
  const hasChildren = children.length > 0;
  const [expanded, setExpanded] = useState(true);
  const isSelected = selectedIssueId === issue.id;

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

  const roots = useMemo(() => {
    if (!issues) return [];
    const issueIds = new Set(issues.map((i) => i.id));
    return issues.filter((i) => !i.parentId || !issueIds.has(i.parentId));
  }, [issues]);

  useEffect(() => {
    if (!issues || issues.length === 0 || !onSelectIssue) return;
    if (selectedIssueId && issues.some((issue) => issue.id === selectedIssueId)) return;
    onSelectIssue(issues[0].id);
  }, [issues, onSelectIssue, selectedIssueId]);

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
          depth={0}
          selectedIssueId={selectedIssueId}
          onSelectIssue={onSelectIssue}
        />
      ))}
    </div>
  );
}
