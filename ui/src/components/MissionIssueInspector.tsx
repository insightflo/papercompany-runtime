import { useMemo } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { activityApi } from "../api/activity";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "@/components/StatusBadge";
import { PriorityIcon } from "./PriorityIcon";
import { CommentThread } from "./CommentThread";
import { Button } from "@/components/ui/button";
import { ListTree } from "lucide-react";

interface MissionIssueInspectorProps {
  issueId?: string | null;
}

function formatDateTime(date: Date | string | null | undefined): string {
  if (!date) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(date));
}

export function MissionIssueInspector({ issueId }: MissionIssueInspectorProps) {
  const { selectedCompanyId } = useCompany();

  const { data: issue, isLoading, error } = useQuery({
    queryKey: issueId ? queryKeys.issues.detail(issueId) : ["issues", "detail", "empty"],
    queryFn: () => issuesApi.get(issueId!),
    enabled: !!selectedCompanyId && !!issueId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: comments, isLoading: isCommentsLoading } = useQuery({
    queryKey: issueId ? queryKeys.issues.comments(issueId) : ["issues", "comments", "empty"],
    queryFn: () => issuesApi.listComments(issueId!),
    enabled: !!selectedCompanyId && !!issueId,
  });

  const { data: activity } = useQuery({
    queryKey: issueId ? queryKeys.issues.activity(issueId) : ["issues", "activity", "empty"],
    queryFn: () => activityApi.forIssue(issueId!),
    enabled: !!selectedCompanyId && !!issueId,
  });

  const { data: linkedRuns } = useQuery({
    queryKey: issueId ? queryKeys.issues.runs(issueId) : ["issues", "runs", "empty"],
    queryFn: () => activityApi.runsForIssue(issueId!),
    enabled: !!selectedCompanyId && !!issueId,
  });

  const agentNameMap = useMemo(() => {
    if (!agents) return new Map<string, string>();
    return new Map(agents.map((agent) => [agent.id, agent.name]));
  }, [agents]);

  const agentMap = useMemo(() => {
    if (!agents) return new Map();
    return new Map(agents.map((agent) => [agent.id, agent]));
  }, [agents]);

  const assigneeName = useMemo(() => {
    if (!issue?.assigneeAgentId) return null;
    return agentNameMap.get(issue.assigneeAgentId) ?? null;
  }, [agentNameMap, issue?.assigneeAgentId]);

  const commentsWithRunMeta = useMemo(() => {
    const runMetaByCommentId = new Map<string, { runId: string; runAgentId: string | null }>();
    const agentIdByRunId = new Map<string, string>();

    for (const run of linkedRuns ?? []) {
      agentIdByRunId.set(run.runId, run.agentId);
    }

    for (const evt of activity ?? []) {
      if (evt.action !== "issue.comment_added" || !evt.runId) continue;
      const details = evt.details ?? {};
      const commentId = typeof details["commentId"] === "string" ? details["commentId"] : null;
      if (!commentId || runMetaByCommentId.has(commentId)) continue;
      runMetaByCommentId.set(commentId, {
        runId: evt.runId,
        runAgentId: evt.agentId ?? agentIdByRunId.get(evt.runId) ?? null,
      });
    }

    return (comments ?? []).map((comment) => {
      const meta = runMetaByCommentId.get(comment.id);
      return meta ? { ...comment, ...meta } : comment;
    });
  }, [activity, comments, linkedRuns]);

  if (!issueId) {
    return (
      <div className="flex h-full min-h-72 flex-col items-center justify-center rounded-md border border-dashed border-border p-6 text-center">
        <ListTree className="mb-3 h-8 w-8 text-muted-foreground" />
        <p className="text-sm font-medium">Select a work item</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Click an issue in the left list to inspect its status without leaving this mission view.
        </p>
      </div>
    );
  }

  if (isLoading || isCommentsLoading) {
    return <div className="min-h-72 animate-pulse rounded-md border border-border bg-muted/30" />;
  }

  if (error || !issue) {
    return (
      <div className="rounded-md border border-border p-4">
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load work item details"}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border">
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 space-y-2">
          <div className="flex items-center gap-2">
            <PriorityIcon priority={issue.priority} className="shrink-0" />
            <StatusBadge status={issue.status} />
            {issue.identifier && (
              <span className="text-xs font-mono text-muted-foreground">{issue.identifier}</span>
            )}
          </div>
          <h3 className="text-base font-semibold leading-tight">{issue.title}</h3>
        </div>
        <Button asChild size="sm" variant="outline">
          <Link to={`/issues/${issue.id}`}>Open full page</Link>
        </Button>
      </div>

      <div className="grid gap-4 px-4 py-4 lg:grid-cols-[minmax(0,2fr)_minmax(220px,1fr)]">
        <div className="space-y-4">
          <section className="space-y-1.5">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Description</p>
            <div className="rounded-md bg-muted/40 px-3 py-2 text-sm leading-relaxed">
              {issue.description?.trim() || "No description yet."}
            </div>
          </section>

          {issue.ancestors && issue.ancestors.length > 0 && (
            <section className="space-y-1.5">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Path</p>
              <div className="text-sm text-muted-foreground">
                {issue.ancestors.map((ancestor) => ancestor.title).join(" / ")}
              </div>
            </section>
          )}

          <CommentThread
            comments={commentsWithRunMeta}
            linkedRuns={linkedRuns ?? []}
            companyId={issue.companyId}
            projectId={issue.projectId ?? null}
            agentMap={agentMap}
            issueStatus={issue.status}
            onAdd={async () => {}}
            readOnly
            timelineClassName="max-h-[min(42rem,calc(100vh-22rem))] overflow-y-auto overscroll-contain pr-2"
          />
        </div>

        <aside className="space-y-3 rounded-md bg-muted/30 p-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Assignee</p>
            <p className="mt-1 text-sm">{assigneeName ?? issue.assigneeAgentId ?? "Unassigned"}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Priority</p>
            <p className="mt-1 text-sm capitalize">{issue.priority.replace(/_/g, " ")}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Started</p>
            <p className="mt-1 text-sm">{formatDateTime(issue.startedAt)}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Completed</p>
            <p className="mt-1 text-sm">{formatDateTime(issue.completedAt)}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Updated</p>
            <p className="mt-1 text-sm">{formatDateTime(issue.updatedAt)}</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
