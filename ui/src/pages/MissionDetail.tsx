import { useEffect, useState } from "react";
import { Link, useParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { missionsApi, type MissionPlanRuntimeSummary, type MissionStatus } from "../api/missions";
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

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordArray(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function labelForRecord(record: JsonRecord, fallback: string): string {
  return textValue(record.name) ?? textValue(record.title) ?? textValue(record.key) ?? textValue(record.id) ?? fallback;
}

function getPlanRefArray(plan: MissionPlanRuntimeSummary | undefined, key: string): JsonRecord[] {
  return recordArray(isRecord(plan?.refs) ? plan.refs[key] : undefined);
}

function MissionExecutionRulesPanel({ plan }: { plan?: MissionPlanRuntimeSummary }) {
  const ruleRefs = getPlanRefArray(plan, "ruleRefs");
  const kbRefs = getPlanRefArray(plan, "kbRefs");
  const executionUnits = getPlanRefArray(plan, "executionUnits");
  const openRequiredInputs = plan?.openRequiredInputs ?? [];
  const ruleNames = plan?.ruleNames ?? [];
  const ruleModes = plan?.ruleModes ?? [];
  const blockedOrFailed = plan?.blockedOrFailedUnitCount ?? 0;

  if (!plan?.available) {
    return (
      <div className="border border-border rounded-md p-8 text-center">
        <Settings className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
        <p className="text-sm text-muted-foreground mb-1">No active mission execution plan yet</p>
        <p className="text-xs text-muted-foreground">
          Worktree Rules, KB excerpts, required inputs, and maintenance decisions appear here once the
          mission owner substrate creates an active plan.
        </p>
        <div className="mt-4">
          <Button asChild size="sm" variant="outline">
            <Link to="/worktree/rules">Open global execution rules</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Latest Maintenance Decision</p>
            <p className="mt-1 text-sm font-medium">Mission plan revision {plan.revision ?? "—"} · {plan.status ?? "active"}</p>
          </div>
          <div className="text-xs text-muted-foreground">
            {plan.executionUnitCount ?? executionUnits.length} execution units · {blockedOrFailed} blocked/failed
          </div>
        </div>
        {plan.missionGoal && <p className="mt-3 text-sm text-muted-foreground">{plan.missionGoal}</p>}
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <div className="rounded border border-border/70 p-3">
            <p className="text-xs font-medium text-muted-foreground">Required inputs</p>
            <p className="mt-1 text-sm">{plan.requiredInputsCount ?? openRequiredInputs.length} total · {openRequiredInputs.length} open</p>
          </div>
          <div className="rounded border border-border/70 p-3">
            <p className="text-xs font-medium text-muted-foreground">Suggested status/action</p>
            <p className="mt-1 text-sm">Owner decision required for retry/replan/escalation</p>
          </div>
          <div className="rounded border border-border/70 p-3">
            <p className="text-xs font-medium text-muted-foreground">Handoff target</p>
            <p className="mt-1 text-sm">Main executor / operator as required</p>
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-md border border-border p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Applied Worktree Rules</p>
          {ruleRefs.length > 0 || ruleNames.length > 0 ? (
            <ul className="mt-3 space-y-2 text-sm">
              {(ruleRefs.length > 0 ? ruleRefs : ruleNames.map<JsonRecord>((name) => ({ name }))).slice(0, 10).map((rule, index) => {
                const mode = textValue(rule.mode) ?? ruleModes[index] ?? null;
                return (
                  <li key={`${labelForRecord(rule, "Rule")}-${index}`} className="rounded border border-border/70 p-2">
                    <span className="font-medium">{labelForRecord(rule, `Rule ${index + 1}`)}</span>
                    {mode && <span className="ml-2 text-xs text-muted-foreground">{mode}</span>}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">No rule refs attached to the active mission plan.</p>
          )}
        </section>

        <section className="rounded-md border border-border p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Injected KB references/excerpts</p>
          {kbRefs.length > 0 ? (
            <ul className="mt-3 space-y-2 text-sm">
              {kbRefs.slice(0, 5).map((kb, index) => (
                <li key={`${labelForRecord(kb, "KB")}-${index}`} className="rounded border border-border/70 p-2">
                  <span className="font-medium">{labelForRecord(kb, `KB ${index + 1}`)}</span>
                  {textValue(kb.excerpt) && <p className="mt-1 text-xs text-muted-foreground">{textValue(kb.excerpt)}</p>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">No KB excerpts are attached to this active plan.</p>
          )}
        </section>
      </div>

      <section className="rounded-md border border-border p-4">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Required inputs</p>
        {openRequiredInputs.length > 0 ? (
          <ul className="mt-3 flex flex-wrap gap-2 text-sm">
            {openRequiredInputs.map((input) => <li key={input} className="rounded-full border border-border px-2 py-1">{input}</li>)}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">No open required inputs reported.</p>
        )}
      </section>

      <section className="rounded-md border border-border p-4">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Audit timeline</p>
        <p className="mt-3 text-sm text-muted-foreground">
          Evaluated observations are visible through mission owner supervision comments and activity logs; followed,
          overridden, and mismatched events will appear here once route-level audit wiring records them.
        </p>
      </section>
    </div>
  );
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
          <MissionExecutionRulesPanel plan={mission.activeMissionPlan} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
