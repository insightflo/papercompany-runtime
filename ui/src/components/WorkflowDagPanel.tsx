import { useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import {
  missionsApi,
  type MissionAgentEntry,
  type MissionAgentRole,
  type MissionWorkflowRun,
  type MissionWorkflowStep,
  type MissionWorkflowStepWorkProduct,
} from "../api/missions";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { createIssueDetailLocationState } from "../lib/issueDetailBreadcrumb";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatDateTime } from "../lib/utils";
import { openWorkProductInBrowser } from "../lib/workProductOpen";
import { Button } from "@/components/ui/button";
import { GitBranch, User, Wrench } from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WorkflowDagPanelProps {
  missionId: string;
}

const ROLE_ORDER: MissionAgentRole[] = [
  "owner",
  "executor",
  "reviewer",
  "specialist",
  "observer",
];

const ROLE_COLORS: Record<MissionAgentRole, string> = {
  owner: "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300",
  executor: "border-yellow-500 bg-yellow-50 text-yellow-700 dark:bg-yellow-950/40 dark:text-yellow-300",
  reviewer: "border-violet-500 bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300",
  specialist: "border-cyan-500 bg-cyan-50 text-cyan-700 dark:bg-cyan-950/40 dark:text-cyan-300",
  observer: "border-neutral-400 bg-neutral-50 text-neutral-600 dark:bg-neutral-900/40 dark:text-neutral-400",
};

// ---------------------------------------------------------------------------
// WorkflowDagPanel
// ---------------------------------------------------------------------------

export function WorkflowDagPanel({ missionId }: WorkflowDagPanelProps) {
  const { selectedCompanyId } = useCompany();

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const {
    data: workflowRuns,
    isLoading: workflowRunsLoading,
    error: workflowRunsError,
  } = useQuery({
    queryKey: queryKeys.missions.workflowRuns(missionId),
    queryFn: () => missionsApi.listWorkflowRuns(missionId),
    enabled: !!missionId,
  });

  const agentMap = agents
    ? Object.fromEntries(agents.map((a) => [a.id, a.name]))
    : {};

  if (workflowRunsLoading) {
    return (
      <div className="space-y-2 py-2">
        {["mission-a", "mission-b", "mission-c"].map((key) => (
          <div key={key} className="h-12 bg-muted animate-pulse rounded" />
        ))}
      </div>
    );
  }

  if (workflowRunsError) {
    return (
      <p className="text-sm text-destructive px-3 py-2">Failed to load workflow runs.</p>
    );
  }

  return (
    <div className="space-y-6">
      <WorkflowRunList runs={workflowRuns ?? []} missionId={missionId} agentMap={agentMap} />

      {/* Agent roster grouped by role */}
      <AgentRoster missionId={missionId} agentMap={agentMap} />
    </div>
  );
}

const RUN_STATUS_TONE: Record<string, string> = {
  pending: "border-neutral-300 text-muted-foreground",
  running: "border-blue-300 text-blue-700 dark:text-blue-300",
  completed: "border-emerald-300 text-emerald-700 dark:text-emerald-300",
  failed: "border-red-300 text-red-700 dark:text-red-300",
  cancelled: "border-neutral-400 text-muted-foreground",
};

const STEP_STATUS_TONE: Record<string, string> = {
  pending: "bg-neutral-400",
  running: "bg-blue-500",
  completed: "bg-emerald-500",
  failed: "bg-red-500",
  skipped: "bg-amber-500",
};

function formatStatusLabel(status: string) {
  return status.replace(/_/g, " ");
}

function WorkflowRunList({
  runs,
  missionId,
  agentMap,
}: {
  runs: MissionWorkflowRun[];
  missionId: string;
  agentMap: Record<string, string>;
}) {
  if (runs.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border p-4 text-center">
        <GitBranch className="h-6 w-6 mx-auto mb-2 text-muted-foreground" />
        <p className="text-sm font-medium">No workflow runs for this mission yet.</p>
        <p className="text-xs text-muted-foreground mt-1">
          Mission-linked workflow runs will appear here once execution starts.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {runs.map((run) => {
        return (
          <div key={run.id} className="rounded-md border border-border p-4 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">
                  {run.workflowName ?? "Unnamed workflow"}
                </p>
                <p className="text-xs text-muted-foreground font-mono truncate">{run.id}</p>
              </div>
              <span
                className={cn(
                  "text-xs rounded border px-2 py-1 uppercase tracking-wide",
                  RUN_STATUS_TONE[run.status] ?? RUN_STATUS_TONE.pending,
                )}
              >
                {formatStatusLabel(run.status)}
              </span>
            </div>
            <div className="text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
              <span>Triggered by: {run.triggeredBy}</span>
              <span>Started: {run.startedAt ? formatDateTime(run.startedAt) : "—"}</span>
              <span>Ended: {run.completedAt ? formatDateTime(run.completedAt) : "—"}</span>
              <span>Steps: {run.progress.totalSteps}</span>
              <span>Completed: {run.progress.completedSteps}</span>
              {run.progress.runningSteps > 0 ? <span>Running: {run.progress.runningSteps}</span> : null}
              {run.progress.failedSteps > 0 ? <span>Failed: {run.progress.failedSteps}</span> : null}
              {run.progress.skippedSteps > 0 ? <span>Skipped: {run.progress.skippedSteps}</span> : null}
            </div>
            {run.steps.length > 0 ? (
              <div className="space-y-2 border-t border-border pt-3">
                {run.steps.map((step) => (
                  <WorkflowStepRow
                    key={`${run.id}-${step.stepId}`}
                    missionId={missionId}
                    step={step}
                    steps={run.steps}
                    agentMap={agentMap}
                  />
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function WorkProductCard({
  product,
}: {
  product: MissionWorkflowStepWorkProduct;
}) {
  const [openingProductId, setOpeningProductId] = useState<string | null>(null);
  const [openedProductId, setOpenedProductId] = useState<string | null>(null);
  const [openErrorProductId, setOpenErrorProductId] = useState<string | null>(null);

  async function openWorkProduct() {
    setOpeningProductId(product.id);
    setOpenedProductId(null);
    setOpenErrorProductId(null);
    try {
      await openWorkProductInBrowser(product.id);
      setOpenedProductId(product.id);
    } catch {
      setOpenErrorProductId(product.id);
    } finally {
      setOpeningProductId(null);
    }
  }

  return (
    <div className="rounded border border-border bg-background px-2 py-1.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          {product.url ? (
            <a
              href={product.url}
              target="_blank"
              rel="noreferrer"
              className="block truncate text-xs font-medium underline-offset-2 hover:underline"
            >
              {product.title}
            </a>
          ) : (
            <p className="truncate text-xs font-medium">{product.title}</p>
          )}
          <div className="flex flex-wrap gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            <span className="rounded border border-border px-1.5 py-0.5">{product.type}</span>
            <span className="rounded border border-border px-1.5 py-0.5">{formatStatusLabel(product.status)}</span>
            {product.isPrimary ? (
              <span className="rounded border border-emerald-500/60 px-1.5 py-0.5 text-emerald-700 dark:text-emerald-300">Primary</span>
            ) : null}
          </div>
          {product.summary ? <p className="text-[11px] text-muted-foreground">{product.summary}</p> : null}
          {openedProductId === product.id ? <p className="text-[11px] text-emerald-600">Opened</p> : null}
          {openErrorProductId === product.id ? <p className="text-[11px] text-destructive">Open failed</p> : null}
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-6 shrink-0 px-2 text-[11px]"
          onClick={() => void openWorkProduct()}
          disabled={openingProductId === product.id}
        >
          {openingProductId === product.id ? "Opening…" : "Open"}
        </Button>
      </div>
    </div>
  );
}

function WorkflowStepRow({
  missionId,
  step,
  steps,
  agentMap,
}: {
  missionId: string;
  step: MissionWorkflowStep;
  steps: MissionWorkflowStep[];
  agentMap: Record<string, string>;
}) {
  const dependencyNames = step.dependencies.map(
    (dependencyId) => steps.find((candidate) => candidate.stepId === dependencyId)?.name ?? dependencyId,
  );
  const assignee = getStepAssignee(step, agentMap);
  const workProducts = step.workProducts ?? [];

  return (
    <div className="rounded border border-border/70 px-3 py-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className={cn(
                "h-2.5 w-2.5 shrink-0 rounded-full",
                STEP_STATUS_TONE[step.status] ?? STEP_STATUS_TONE.pending,
              )}
            />
            <span className="truncate text-sm font-medium">{step.name}</span>
            <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              {formatStatusLabel(step.status)}
            </span>
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded border px-1.5 py-0.5",
                assignee.kind === "tool"
                  ? "border-cyan-500/50 text-cyan-700 dark:text-cyan-300"
                  : assignee.kind === "agent"
                    ? "border-blue-500/50 text-blue-700 dark:text-blue-300"
                    : "border-border text-muted-foreground",
              )}
              title={assignee.title}
            >
              {assignee.kind === "tool" ? (
                <Wrench className="h-3 w-3" />
              ) : (
                <User className="h-3 w-3" />
              )}
              <span>Assignee: {assignee.label}</span>
            </span>
            {dependencyNames.length > 0 ? <span>Depends on: {dependencyNames.join(", ")}</span> : <span>Entry step</span>}
          </div>
          {step.toolNames.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {step.toolNames.map((toolName) => (
                <span
                  key={`${step.stepId}-${toolName}`}
                  className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
                >
                  {toolName}
                </span>
              ))}
            </div>
          ) : null}
          {step.knowledgeBaseIds.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {step.knowledgeBaseIds.map((knowledgeBaseId) => (
                <span
                  key={`${step.stepId}-${knowledgeBaseId}`}
                  className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
                >
                  kb:{knowledgeBaseId}
                </span>
              ))}
            </div>
          ) : null}
          {step.description ? <p className="text-xs text-muted-foreground">{step.description}</p> : null}
        </div>
        {workProducts.length > 0 ? (
          <div className="w-[20rem] shrink-0 space-y-1.5 rounded border border-border/70 bg-muted/20 p-2">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Work products · {workProducts.length}
            </p>
            <div className="space-y-1.5">
              {workProducts.map((product) => (
                <WorkProductCard key={product.id} product={product} />
              ))}
            </div>
          </div>
        ) : null}
        <div className="w-[16rem] shrink-0 space-y-1 text-right">
          {step.issue ? (
            <Link
              to={`/issues/${step.issue.identifier ?? step.issue.id}`}
              state={createIssueDetailLocationState("Mission", `/missions/${missionId}`)}
              className="block rounded border border-border px-2 py-1 text-xs no-underline transition-colors hover:bg-accent/50"
            >
              <span className="block truncate font-mono text-muted-foreground">
                {step.issue.identifier ?? step.issue.id}
              </span>
              <span className="block truncate">{step.issue.title}</span>
              <span className="block truncate text-muted-foreground">
                Issue: {formatStatusLabel(step.issue.status)}
              </span>
            </Link>
          ) : (
            <div className="rounded border border-dashed border-border px-2 py-1 text-xs text-muted-foreground">
              Issue pending
            </div>
          )}
          <div className="space-y-0.5 text-[11px] leading-tight text-muted-foreground">
            <div>Started: {step.startedAt ? formatDateTime(step.startedAt) : "—"}</div>
            <div>Ended: {step.completedAt ? formatDateTime(step.completedAt) : "—"}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function getStepAssignee(
  step: MissionWorkflowStep,
  agentMap: Record<string, string>,
): { kind: "agent" | "tool" | "unassigned"; label: string; title: string } {
  if (step.type === "tool") {
    return {
      kind: "tool",
      label: "tool",
      title: step.toolNames.length > 0 ? `Tool step: ${step.toolNames.join(", ")}` : "Tool step",
    };
  }

  const agentId = step.agentId.trim();
  const issueAssigneeAgentId = step.issue?.assigneeAgentId?.trim() ?? "";
  const resolvedAgentId = agentId || issueAssigneeAgentId;
  if (resolvedAgentId) {
    return {
      kind: "agent",
      label: agentMap[resolvedAgentId] ?? resolvedAgentId,
      title: resolvedAgentId,
    };
  }

  return {
    kind: "unassigned",
    label: "Unassigned",
    title: "No agent or tool is assigned to this step yet.",
  };
}

// ---------------------------------------------------------------------------
// AgentRoster — fetches /missions/:id agents directly via the missions detail
// ---------------------------------------------------------------------------

interface AgentRosterProps {
  missionId: string;
  agentMap: Record<string, string>;
}

interface MissionAgentRosterResult {
  entries: MissionAgentEntry[];
  endpointAvailable: boolean;
}

function AgentRoster({ missionId, agentMap }: AgentRosterProps) {
  const { data: rosterData, isLoading } = useQuery<MissionAgentRosterResult>({
    queryKey: [...queryKeys.missions.detail(missionId), "agents"],
    queryFn: async () => {
      try {
        return {
          entries: await missionsApi.listAgents(missionId),
          endpointAvailable: true,
        };
      } catch (error) {
        const status =
          error instanceof Error && "status" in error
            ? Number((error as Error & { status?: number }).status)
            : null;
        if (status === 404) {
          return {
            entries: [],
            endpointAvailable: false,
          };
        }
        throw new Error("Failed to load mission roster");
      }
    },
    enabled: !!missionId,
  });

  if (isLoading) {
    return (
      <div className="space-y-1">
        {["roster-a", "roster-b"].map((key) => (
          <div key={key} className="h-10 bg-muted animate-pulse rounded" />
        ))}
      </div>
    );
  }

  const entries: MissionAgentEntry[] = rosterData?.entries ?? [];

  if (rosterData?.endpointAvailable === false) {
    return (
      <div className="flex flex-col items-center py-6 text-center">
        <User className="h-6 w-6 mb-2 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Mission roster is not available yet.</p>
        <p className="text-xs text-muted-foreground mt-1">
          This workspace can still show mission details while the roster endpoint is being rolled out.
        </p>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center py-6 text-center">
        <User className="h-6 w-6 mb-2 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">No agents assigned to this mission.</p>
      </div>
    );
  }

  // Sort by canonical role order
  const sorted = [...entries].sort(
    (a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role),
  );

  // Group by role
  const grouped = ROLE_ORDER.reduce<Record<string, MissionAgentEntry[]>>((acc, role) => {
    const members = sorted.filter((e) => e.role === role);
    if (members.length > 0) acc[role] = members;
    return acc;
  }, {});

  return (
    <div className="space-y-4">
      {Object.entries(grouped).map(([role, members]) => (
        <div key={role} className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {role}
          </p>
          <div className="flex flex-wrap gap-2">
            {members.map((entry) => (
              <div
                key={entry.agentId}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-xs font-medium",
                  ROLE_COLORS[entry.role as MissionAgentRole] ?? "border-border bg-muted text-muted-foreground",
                )}
              >
                <User className="h-3 w-3" />
                {agentMap[entry.agentId] ?? entry.agentId}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
