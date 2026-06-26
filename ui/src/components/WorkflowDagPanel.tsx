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
  /** Default Execution Flow view: "graph" (default, read-only DAG) or "text" (classic run/step list). */
  defaultMode?: "graph" | "text";
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

export function WorkflowDagPanel({ missionId, defaultMode = "graph" }: WorkflowDagPanelProps) {
  const { selectedCompanyId } = useCompany();
  const [mode, setMode] = useState<"graph" | "text">(defaultMode);

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
      <div className="flex items-center gap-1" role="group" aria-label="Execution flow view">
        <button
          type="button"
          onClick={() => setMode("graph")}
          aria-pressed={mode === "graph"}
          className={cn(
            "rounded-l-md border border-r-0 px-3 py-1 text-xs font-medium transition-colors",
            mode === "graph" ? "bg-accent/60 text-foreground" : "bg-background text-muted-foreground hover:bg-accent/30",
          )}
        >
          Graph
        </button>
        <button
          type="button"
          onClick={() => setMode("text")}
          aria-pressed={mode === "text"}
          className={cn(
            "rounded-r-md border px-3 py-1 text-xs font-medium transition-colors",
            mode === "text" ? "bg-accent/60 text-foreground" : "bg-background text-muted-foreground hover:bg-accent/30",
          )}
        >
          Text
        </button>
      </div>

      {mode === "graph" ? (
        <WorkflowRunGraph runs={workflowRuns ?? []} missionId={missionId} agentMap={agentMap} />
      ) : (
        <WorkflowRunList runs={workflowRuns ?? []} missionId={missionId} agentMap={agentMap} />
      )}

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
// WorkflowRunGraph — read-only DAG visualization (default Execution Flow view)
// [목적] mission workflow run 의 step 들을 dependency level(L→R) 배치 + SVG edge 로 시각화.
//   read-only. node 선택 시 기존 WorkflowStepRow 를 detail rail 로 재사용(text mode 장점 섞기).
// [수정시 주의] 좌표는 GRAPH_* 상수로 고정(cell 단위). cycle/미해결 dependency 방어.
// ---------------------------------------------------------------------------

const GRAPH_COL_WIDTH = 240;
const GRAPH_ROW_HEIGHT = 96;
const GRAPH_NODE_WIDTH = 216;

// [목적] step.dependencies 기반 topological level 계산(0 = entry). cycle/미존재 dep 방어.
// [출력] stepId -> level. dep 없으면 0, 있으면 max(dep level)+1.
function computeStepLevels(steps: MissionWorkflowStep[]): Map<string, number> {
  const byId = new Map(steps.map((step) => [step.stepId, step]));
  const levels = new Map<string, number>();
  const visiting = new Set<string>();
  const resolve = (id: string): number => {
    if (levels.has(id)) return levels.get(id)!;
    const step = byId.get(id);
    if (!step) {
      levels.set(id, 0);
      return 0;
    }
    if (visiting.has(id)) {
      // cycle 방어 — 순환 dep 면 0으로 평탄화
      levels.set(id, 0);
      return 0;
    }
    visiting.add(id);
    const knownDeps = step.dependencies.filter((depId) => byId.has(depId));
    const level = knownDeps.length === 0 ? 0 : Math.max(...knownDeps.map((depId) => resolve(depId))) + 1;
    visiting.delete(id);
    levels.set(id, level);
    return level;
  };
  steps.forEach((step) => resolve(step.stepId));
  return levels;
}

function WorkflowRunGraph({
  runs,
  missionId,
  agentMap,
}: {
  runs: MissionWorkflowRun[];
  missionId: string;
  agentMap: Record<string, string>;
}) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);

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

  // 기본 run: running 중인 것 우선, 없으면 첫 run. 사용자가 run selector 로 변경 가능.
  const runningRun = runs.find((run) => run.status === "running");
  const run = runs.find((candidate) => candidate.id === selectedRunId) ?? runningRun ?? runs[0];

  const levels = computeStepLevels(run.steps);
  const maxLevel = run.steps.length === 0 ? 0 : Math.max(0, ...run.steps.map((step) => levels.get(step.stepId) ?? 0));
  const columns: MissionWorkflowStep[][] = Array.from({ length: maxLevel + 1 }, () => []);
  run.steps.forEach((step) => {
    columns[levels.get(step.stepId) ?? 0]?.push(step);
  });
  const positionByKey = new Map<string, { col: number; row: number }>();
  columns.forEach((columnSteps, col) => {
    columnSteps.forEach((step, row) => {
      positionByKey.set(`${run.id}:${step.stepId}`, { col, row });
    });
  });
  const numRows = Math.max(1, ...columns.map((columnSteps) => columnSteps.length));
  const graphWidth = (maxLevel + 1) * GRAPH_COL_WIDTH;
  const graphHeight = numRows * GRAPH_ROW_HEIGHT;

  const edges: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  run.steps.forEach((step) => {
    const target = positionByKey.get(`${run.id}:${step.stepId}`);
    if (!target) return;
    step.dependencies.forEach((dependencyId) => {
      const source = positionByKey.get(`${run.id}:${dependencyId}`);
      if (!source) return;
      edges.push({
        x1: source.col * GRAPH_COL_WIDTH + GRAPH_NODE_WIDTH,
        y1: source.row * GRAPH_ROW_HEIGHT + GRAPH_ROW_HEIGHT / 2,
        x2: target.col * GRAPH_COL_WIDTH,
        y2: target.row * GRAPH_ROW_HEIGHT + GRAPH_ROW_HEIGHT / 2,
      });
    });
  });

  const selectedStep = selectedStepId ? run.steps.find((step) => step.stepId === selectedStepId) ?? null : null;

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border p-4 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{run.workflowName ?? "Unnamed workflow"}</p>
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
        {runs.length > 1 ? (
          <div className="flex flex-wrap gap-1 pt-1">
            {runs.map((candidateRun) => (
              <button
                key={candidateRun.id}
                type="button"
                onClick={() => {
                  setSelectedRunId(candidateRun.id);
                  setSelectedStepId(null);
                }}
                className={cn(
                  "rounded border px-2 py-1 text-[11px] transition-colors",
                  candidateRun.id === run.id
                    ? "border-foreground/30 bg-accent/50 text-foreground"
                    : "border-border text-muted-foreground hover:bg-accent/30",
                )}
              >
                {candidateRun.workflowName ?? candidateRun.id.slice(0, 8)}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {run.steps.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
          No steps in this run.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border bg-muted/10 p-3">
          <div className="relative" style={{ width: graphWidth, height: graphHeight, minWidth: "100%" }}>
            <svg
              className="absolute inset-0 pointer-events-none text-border"
              width={graphWidth}
              height={graphHeight}
              style={{ minWidth: "100%" }}
              aria-hidden="true"
            >
              {edges.map((edge, index) => (
                <line
                  key={index}
                  x1={edge.x1}
                  y1={edge.y1}
                  x2={edge.x2}
                  y2={edge.y2}
                  stroke="currentColor"
                  strokeWidth={1.5}
                />
              ))}
            </svg>
            {run.steps.map((step) => {
              const position = positionByKey.get(`${run.id}:${step.stepId}`);
              if (!position) return null;
              const assignee = getStepAssignee(step, agentMap);
              const isEntry = step.dependencies.length === 0;
              const isSelected = selectedStepId === step.stepId;
              const tone = STEP_STATUS_TONE[step.status] ?? STEP_STATUS_TONE.pending;
              const emphasis =
                step.status === "failed"
                  ? "border-red-500/70"
                  : step.status === "running"
                    ? "border-blue-500/70"
                    : "border-border";
              return (
                <button
                  key={`${run.id}-${step.stepId}`}
                  type="button"
                  onClick={() => setSelectedStepId(isSelected ? null : step.stepId)}
                  aria-pressed={isSelected}
                  title={step.name}
                  className={cn(
                    "absolute text-left rounded-md border bg-background px-2.5 py-2 shadow-sm transition-colors hover:bg-accent/40",
                    emphasis,
                    isSelected ? "ring-2 ring-foreground/40" : "",
                  )}
                  style={{
                    left: position.col * GRAPH_COL_WIDTH,
                    top: position.row * GRAPH_ROW_HEIGHT,
                    width: GRAPH_NODE_WIDTH,
                  }}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", tone)} />
                    <span className="truncate text-xs font-medium">{step.name}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                    <span className="uppercase tracking-wide">{formatStatusLabel(step.status)}</span>
                    {isEntry ? <span className="rounded border border-border px-1">Entry</span> : null}
                    <span className="truncate">{assignee.label}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                    {step.issue ? <span className="font-mono">{step.issue.identifier ?? step.issue.id}</span> : null}
                    {step.workProducts.length > 0 ? (
                      <span className="rounded border border-border px-1">wp·{step.workProducts.length}</span>
                    ) : null}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {selectedStep ? (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Selected step</p>
          <WorkflowStepRow missionId={missionId} step={selectedStep} steps={run.steps} agentMap={agentMap} />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Select a step node to see full detail (issue, assignee, tools, knowledge bases, work products).
        </p>
      )}
    </div>
  );
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
