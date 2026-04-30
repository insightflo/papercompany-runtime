import { useEffect, useState } from "react";
import { Link, useParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { missionsApi, type MissionStatus } from "../api/missions";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "@/components/StatusBadge";
import { InlineEditor } from "../components/InlineEditor";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { Rocket, ListTree, GitBranch, Settings, User } from "lucide-react";
import { MissionIssueTree } from "../components/MissionIssueTree";
import { MissionIssueInspector } from "../components/MissionIssueInspector";
import { MissionExecutionOverview } from "../components/MissionExecutionOverview";
import { WorkflowDagPanel } from "../components/WorkflowDagPanel";

const STATUS_OPTIONS: { value: MissionStatus; label: string }[] = [
  { value: "planning", label: "Planning" },
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
];

function formatDate(date: Date | string | null | undefined): string {
  if (!date) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(date));
}

export function MissionDetail() {
  const { missionId } = useParams<{ missionId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);

  const {
    data: mission,
    isLoading,
    error,
  } = useQuery({
    queryKey: queryKeys.missions.detail(missionId!),
    queryFn: () => missionsApi.get(missionId!),
    enabled: !!missionId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentMap = agents
    ? Object.fromEntries(agents.map((a) => [a.id, a.name]))
    : {};

  const updateMission = useMutation({
    mutationFn: (data: { title?: string; description?: string; status?: MissionStatus }) =>
      missionsApi.update(missionId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.missions.detail(missionId!) });
      if (selectedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.missions.list(selectedCompanyId) });
      }
    },
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Missions", href: "/missions" },
      { label: mission?.title ?? missionId ?? "Mission" },
    ]);
  }, [setBreadcrumbs, mission, missionId]);

  useEffect(() => {
    setSelectedIssueId(null);
  }, [missionId]);

  if (!missionId) {
    return <div className="p-4 text-sm text-muted-foreground">No mission selected.</div>;
  }

  if (isLoading) {
    return <PageSkeleton variant="detail" />;
  }

  if (error || !mission) {
    return (
      <div className="p-4">
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load mission"}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Rocket className="h-5 w-5 text-muted-foreground shrink-0" />
          <span className="text-xs text-muted-foreground uppercase tracking-wider">Mission</span>
        </div>

        <InlineEditor
          value={mission.title}
          onSave={(title) => updateMission.mutate({ title })}
          className="text-xl font-semibold leading-tight"
          placeholder="Mission title"
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge status={mission.status} />

        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <User className="h-3.5 w-3.5" />
          <span>Main executor: {agentMap[mission.ownerAgentId] ?? mission.ownerAgentId ?? "—"}</span>
        </div>

        {mission.startedAt && (
          <span className="text-sm text-muted-foreground">
            Started {formatDate(mission.startedAt)}
          </span>
        )}

        {mission.completedAt && (
          <span className="text-sm text-muted-foreground">
            Completed {formatDate(mission.completedAt)}
          </span>
        )}

        <span className="text-sm text-muted-foreground">
          Created {formatDate(mission.createdAt)}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {STATUS_OPTIONS.filter((s) => s.value !== mission.status).map((s) => (
          <Button
            key={s.value}
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => updateMission.mutate({ status: s.value })}
            disabled={updateMission.isPending}
          >
            Set {s.label}
          </Button>
        ))}
      </div>

      <Separator />

      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Description</p>
        <InlineEditor
          value={mission.description ?? ""}
          onSave={(description) => updateMission.mutate({ description })}
          className="text-sm leading-relaxed"
          placeholder="Add a description..."
          multiline
        />
      </div>

      <Separator />

      <Tabs defaultValue="overview" className="w-full">
        <TabsList className="shrink-0">
          <TabsTrigger value="overview" className="gap-1.5">
            <Rocket className="h-3.5 w-3.5" />
            Overview
          </TabsTrigger>
          <TabsTrigger value="issues" className="gap-1.5">
            <ListTree className="h-3.5 w-3.5" />
            Work
          </TabsTrigger>
          <TabsTrigger value="workflow" className="gap-1.5">
            <GitBranch className="h-3.5 w-3.5" />
            Execution Flow
          </TabsTrigger>
          <TabsTrigger value="worktree" className="gap-1.5">
            <Settings className="h-3.5 w-3.5" />
            Execution Rules
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          <MissionExecutionOverview missionId={missionId} mission={mission} />
        </TabsContent>

        <TabsContent value="issues" className="mt-4">
          <div className="grid gap-4 xl:grid-cols-[minmax(320px,1fr)_minmax(420px,1.3fr)]">
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Mission work items
              </p>
              <MissionIssueTree
                missionId={missionId}
                selectedIssueId={selectedIssueId}
                onSelectIssue={setSelectedIssueId}
              />
            </div>
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Selected work item
              </p>
              <MissionIssueInspector issueId={selectedIssueId} />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="workflow" className="mt-4">
          <WorkflowDagPanel missionId={missionId} />
        </TabsContent>

        <TabsContent value="worktree" className="mt-4">
          <div className="border border-border rounded-md p-8 text-center">
            <Settings className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
            <p className="text-sm text-muted-foreground mb-1">Execution rules coming soon</p>
            <p className="text-xs text-muted-foreground">
              Execution rule configuration will appear here once P4-T9 and P8-T6 are implemented.
            </p>
            <div className="mt-4">
              <Button asChild size="sm" variant="outline">
                <Link to="/worktree/rules">Open global execution rules</Link>
              </Button>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
