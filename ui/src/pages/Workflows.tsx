import * as React from "react";
import { Fragment, useEffect, useMemo, useRef, useState, useCallback, type CSSProperties, type FormEvent, type JSX } from "react";
import { issuesApi } from "../api/issues";
import { useCompany } from "../context/CompanyContext";
import { buildManualRunFeedback, buildManualRunButtonState, findNewRunId, manualRunUnavailableMessage } from "./workflows/run-feedback.js";
import { buildIssueHref, buildMissionHref } from "./workflows/routes.js";
import { getSelectableWorkflowTools, getWorkflowToolSystemState, type WorkflowToolSystemState } from "./workflows/tool-availability.js";
import { appendStepAfter, applyStepRunsToGraphSteps, applyWorkflowGraphFailureRoute, assignStepsToContainer, assignStepsToGroup, buildWorkflowGraphContainerSummary, buildWorkflowGraphDataFlowMap, buildWorkflowGraphDefinitionNavigator, buildWorkflowGraphExecutionEvidenceSummary, buildWorkflowGraphExportSnapshot, buildWorkflowGraphFailureRouteSummary, buildWorkflowGraphInspectorSummary, buildWorkflowGraphIterationTestPreview, buildWorkflowGraphModel, buildWorkflowGraphRepairPlan, buildWorkflowGraphRequestFillPreview, buildWorkflowGraphRestartPreview, buildWorkflowGraphRunDebugSummary, buildWorkflowGraphSelectionSummary, buildWorkflowGraphSingleStepTestPreview, buildWorkflowGraphStructurePaletteSummary, buildWorkflowGraphTestDrawerSummary, buildWorkflowGraphTestExecutionPreview, buildWorkflowGraphTestPlan, buildWorkflowGraphTestRequestPreview, buildWorkflowGraphWorkbenchSummary, clearStepsGroup, clearWorkflowContainer, connectSteps, disconnectSteps, duplicateWorkflowContainer, duplicateWorkflowStep, expandWorkflowGraphSelection, getWorkflowGraphStepContext, insertWorkflowStepFromPalette, normalizeGraphEdgeKind, normalizeGraphRunStatus, parseDependencies, parseWorkflowGraphYamlDraft, removeWorkflowStep, renameWorkflowStep, serializeWorkflowGraphExportSnapshot, setGraphGroupCollapsed, summarizeWorkflowGraphDraftDiff, summarizeWorkflowGraphInterface, summarizeWorkflowGraphTestInputLibrary, summarizeWorkflowGraphTriggers, updateContainerMetadata, updateGraphEdgeMetadata, updateGraphGroupMetadata, updateStepAdvancedMetadata, updateStepApprovalMetadata, updateStepDataFlowMetadata, updateStepExecutionMetadata, updateStepNote, updateStepResourceMetadata, updateStepTestingMetadata, type WorkflowGraphContainerSummary, type WorkflowGraphContainerType, type WorkflowGraphDataFlowMap, type WorkflowGraphDefinitionNavigatorItem, type WorkflowGraphDraftDiff, type WorkflowGraphEdge, type WorkflowGraphEdgeKind, type WorkflowGraphEdgeMetadataRecord, type WorkflowGraphExecutionEvidenceSummary, type WorkflowGraphExportFormat, type WorkflowGraphExportSnapshot, type WorkflowGraphFailureRouteSummary, type WorkflowGraphFocusLensTone, type WorkflowGraphInspectorMode, type WorkflowGraphInspectorSummary, type WorkflowGraphInterfaceInput, type WorkflowGraphInterfaceSummary, type WorkflowGraphIssueSeverity, type WorkflowGraphIterationTestPreview, type WorkflowGraphNavigatorFilter, type WorkflowGraphPaletteNodeKind, type WorkflowGraphRepairPlan, type WorkflowGraphRequestFillPreview, type WorkflowGraphRestartPreview, type WorkflowGraphRunDebugSummary, type WorkflowGraphRunDebugTileTone, type WorkflowGraphRunStatus, type WorkflowGraphSelectionMode, type WorkflowGraphSelectionSummary, type WorkflowGraphSingleStepTestPreview, type WorkflowGraphStep, type WorkflowGraphStepContext, type WorkflowGraphStructurePaletteActionId, type WorkflowGraphStructurePaletteSummary, type WorkflowGraphTestDrawerSummary, type WorkflowGraphTestExecutionPreview, type WorkflowGraphTestInputLibrarySummary, type WorkflowGraphTestPlan, type WorkflowGraphTestRequestPreview, type WorkflowGraphTriggerSummary, type WorkflowGraphWorkbenchSummary, type WorkflowGraphWorkProduct } from "./workflows/workflow-graph.js";
import { CREATE_PARENT_ISSUE_POLICIES, normalizeCreateParentIssuePolicy, type CreateParentIssuePolicy } from "./workflows/workflow-parent-policy.js";

const PLUGIN_ID = "paperclip.core-workflows";

type PluginPageProps = { context?: { companyId?: string | null } };
type PluginWidgetProps = { context?: { companyId?: string | null } };

// Fix: prevent parent window from capturing arrow keys in textareas
if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement;
    if (target?.tagName === "TEXTAREA" && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.stopPropagation();
    }
  }, true);
}

function currentBrowserPathname(): string | undefined {
  return typeof window === "undefined" ? undefined : window.location.pathname;
}

function MissionRunLink({ missionId }: { missionId?: string | null }): JSX.Element | null {
  if (!missionId) return null;
  return (
    <a
      href={buildMissionHref({
        missionId,
        currentPathname: currentBrowserPathname(),
      })}
      style={{ ...buttonStyle, textDecoration: "none" }}
      title={missionId}
    >
      Mission
    </a>
  );
}


type StepDraft = {
  id: string;
  title: string;
  description: string;
  type: "agent" | "tool";
  toolName: string;
  toolArgs: string;
  agentName: string;
  tools: string;
  dependsOn: string;
  onFailure: string;
  maxRetries: string | number;
  graphRetryDelaySeconds: string | number;
  graphRetryBackoff: string;
  graphRetryJitter: boolean;
  timeoutSeconds: string | number;
  graphSleepSeconds: string | number;
  graphSuspendUntil: string;
  graphSuspendTimeoutSeconds: string | number;
  graphSuspendTimeoutAction: string;
  graphEarlyReturn: boolean;
  graphEarlyReturnContentType: string;
  graphEarlyReturnSchema: string;
  graphErrorHandler: boolean;
  graphErrorHandlerScope: string;
  graphErrorHandlerInput: string;
  graphRestartBoundary: boolean;
  graphRestartStrategy: string;
  graphRestartInput: string;
  graphEarlyStopCondition: string;
  graphEarlyStopLabelSkipped: boolean;
  graphApprovalRequired: boolean;
  graphApprovalPrompt: string;
  graphApprovalRecipients: string;
  graphApprovalTimeoutSeconds: string | number;
  graphApprovalTimeoutAction: string;
  graphMockEnabled: boolean;
  graphMockResult: string;
  graphPinnedResultRunId: string;
  graphConcurrencyKey: string;
  graphConcurrencyLimit: string | number;
  graphPriority: string;
  graphCacheEnabled: boolean;
  graphCacheTtlSeconds: string | number;
  graphDeleteAfterUse: boolean;
  graphInputExpression: string;
  graphOutputSchema: string;
  graphWorkProductRequired: boolean;
  graphWorkProductPattern: string;
  graphResourceRefs: string;
  graphSecretRefs: string;
  graphPositionX: string | number;
  graphPositionY: string | number;
  graphGroupId: string;
  graphGroupTitle: string;
  graphGroupColor: string;
  graphGroupCollapsed?: boolean;
  graphGroupCollapsedByDefault: boolean;
  graphContainerId: string;
  graphContainerType: WorkflowGraphContainerType;
  graphContainerTitle: string;
  graphContainerDescription: string;
  graphContainerMode: string;
  graphContainerCondition: string;
  graphContainerIterator: string;
  graphContainerSkipFailure: boolean;
  graphContainerRunInParallel: boolean;
  graphContainerParallelism: string | number;
  graphRunStatus: WorkflowGraphRunStatus;
  graphRunStepRunId?: string;
  graphRunIssueId?: string;
  graphRunIssueIdentifier: string;
  graphRunUpdatedAt: string;
  graphRunSummary: string;
  graphRunStartedAt?: string;
  graphRunCompletedAt?: string;
  graphRunLastDispatchAttemptAt?: string;
  graphRunLastDispatchAcceptedAt?: string;
  graphRunLastDispatchErrorAt?: string;
  graphRunLastDispatchErrorSummary?: string;
  graphRunLastDispatchRequestId?: string;
  graphRunResultPreview?: string;
  graphRunLogPreview?: string;
  graphRunWorkProducts?: WorkflowGraphWorkProduct[];
  graphNote: string;
  graphEdgeMetadata: WorkflowGraphEdgeMetadataRecord;
  extra: Record<string, unknown>;
};

type StepEditorMode = "graph" | "form" | "json";

type ProjectOption = { id: string; name: string };
type LabelOption = { id: string; name: string; color: string };
type WorkflowToolOption = {
  name: string;
  displayName: string;
  description: string;
  pluginId: string;
  source?: string;
  enabled?: boolean;
};

type WorkflowToolGrant = {
  agentName: string;
  toolName: string;
};

type WorkflowOverviewData = {
  projects?: ProjectOption[];
  labels?: LabelOption[];
  workflows: Array<{
    id: string;
    name: string;
    description: string;
    status: string;
    triggerLabels?: string[];
    labelIds?: string[];
    schedule?: string;
    maxDailyRuns?: number;
    timezone?: string;
    deadlineTime?: string;
    lastScheduledRunAt?: string;
    lastScheduleError?: string;
    lastScheduleErrorAt?: string;
    projectId?: string;
    createParentIssuePolicy?: CreateParentIssuePolicy;
    executionMode?: string;
    dynamicPlanBootstrapOnly?: boolean;
    legacyMetadata?: Record<string, unknown>;
    steps: Array<{
      id: string;
      title: string;
      type?: string;
      toolName?: string;
      agentName?: string;
      dependsOn: string[];
      executionMode?: string;
      ownerPlanBootstrapOnly?: boolean;
      dynamicChildren?: boolean;
    }>;
  }>;
  activeRuns: Array<{
    id: string;
    workflowId?: string;
    missionId?: string;
    workflowName: string;
    status: string;
    startedAt: string;
    completedAt?: string;
    triggerSource?: string;
    parentIssueId?: string;
    parentIssueIdentifier?: string;
    runLabel?: string;
  }>;
  recentRuns: Array<{
    id: string;
    workflowId?: string;
    missionId?: string;
    workflowName: string;
    status: string;
    startedAt: string;
    completedAt?: string;
    triggerSource?: string;
    parentIssueId?: string;
    parentIssueIdentifier?: string;
    runLabel?: string;
  }>;
};

type OverviewData = WorkflowOverviewData;

type WorkflowRunDetailData = {
  run: {
    id: string;
    status: string;
    [key: string]: unknown;
  };
  stepRuns: Array<{
    id: string;
    stepId: string;
    stepTitle?: string;
    stepType?: string;
    issueId?: string;
    issueIdentifier?: string;
    status: string;
    agentName?: string;
    startedAt?: string;
    completedAt?: string;
    lastDispatchAcceptedAt?: string;
    lastDispatchAttemptAt?: string;
    lastDispatchErrorAt?: string;
    lastDispatchErrorSummary?: string;
    lastDispatchRequestId?: string;
    workProducts?: WorkflowGraphWorkProduct[];
  }>;
  workflow: {
    id: string;
    steps?: Array<WorkflowGraphStep & { id: string; title: string; type?: string }>;
    [key: string]: unknown;
  } | null;
};

const pageStyle: CSSProperties = {
  display: "grid",
  gap: "20px",
  padding: "5px",
  fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
  color: "var(--foreground, #f8fafc)",
};

const sectionStyle: CSSProperties = {
  display: "grid",
  gap: "12px",
  padding: "16px",
  border: "1px solid var(--border, #334155)",
  borderRadius: "12px",
  background: "var(--card, #0f172a)",
};

const workflowFocusSectionStyle: CSSProperties = {
  display: "grid",
  gap: "8px",
  padding: "10px",
  border: "1px solid var(--border, #334155)",
  borderRadius: "8px",
  background: "color-mix(in srgb, var(--card, #0f172a) 58%, var(--background, #020617))",
};

const workflowFocusToolbarStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "8px",
  flexWrap: "wrap",
};

const workflowFocusToolbarGroupStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "6px",
  flexWrap: "wrap",
  minWidth: 0,
};

const headerRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "12px",
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: "28px",
  lineHeight: 1.2,
  fontWeight: 700,
};

const sectionTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "18px",
  lineHeight: 1.3,
  fontWeight: 600,
};

const mutedTextStyle: CSSProperties = {
  margin: 0,
  color: "var(--muted-foreground, #94a3b8)",
  fontSize: "14px",
  lineHeight: 1.5,
};

const noticeStyle = (tone: "info" | "error" | "success"): CSSProperties => ({
  ...mutedTextStyle,
  padding: "8px 10px",
  border: "1px solid var(--border, #334155)",
  borderRadius: "8px",
  color: tone === "error" ? "#fca5a5" : tone === "success" ? "#86efac" : "var(--muted-foreground, #94a3b8)",
  background: tone === "error"
    ? "rgba(127, 29, 29, 0.18)"
    : tone === "success"
      ? "rgba(20, 83, 45, 0.18)"
      : "rgba(15, 23, 42, 0.6)",
});

const highlightedRunRowStyle: CSSProperties = {
  background: "color-mix(in srgb, #22c55e 14%, transparent)",
  boxShadow: "inset 3px 0 0 #22c55e",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "14px",
};

const thStyle: CSSProperties = {
  padding: "10px 12px",
  borderBottom: "1px solid var(--border, #334155)",
  textAlign: "left",
  fontSize: "12px",
  fontWeight: 600,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--muted-foreground, #94a3b8)",
};

const tdStyle: CSSProperties = {
  padding: "12px",
  borderBottom: "1px solid var(--border, #334155)",
  verticalAlign: "top",
};

const widgetStyle: CSSProperties = {
  display: "grid",
  gap: "10px",
  padding: "14px",
  border: "1px solid var(--border, #334155)",
  borderRadius: "12px",
  background: "var(--card, #0f172a)",
  fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
  color: "var(--foreground, #f8fafc)",
};

const widgetTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "14px",
  lineHeight: 1.2,
  fontWeight: 600,
};

const widgetCountStyle: CSSProperties = {
  fontSize: "28px",
  lineHeight: 1,
  fontWeight: 700,
};

const badgeRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "8px",
};

const buttonStyle: CSSProperties = {
  padding: "8px 12px",
  border: "1px solid var(--border, #334155)",
  borderRadius: "8px",
  background: "var(--card, #0f172a)",
  color: "var(--foreground, #f8fafc)",
  cursor: "pointer",
  fontSize: "13px",
};

const buttonDisabledStyle: CSSProperties = {
  opacity: 0.65,
  cursor: "not-allowed",
};

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "color-mix(in srgb, var(--foreground, #f8fafc) 14%, var(--card, #0f172a))",
};

const dangerButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "color-mix(in srgb, var(--muted-foreground, #94a3b8) 24%, var(--card, #0f172a))",
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  border: "1px solid var(--border, #334155)",
  borderRadius: "8px",
  background: "var(--background, #020617)",
  color: "var(--foreground, #f8fafc)",
  fontSize: "13px",
};

const textareaStyle: CSSProperties = {
  ...inputStyle,
  minHeight: "150px",
  resize: "vertical",
};

const formPanelStyle: CSSProperties = {
  display: "grid",
  gap: "10px",
  padding: "12px",
  border: "1px solid var(--border, #334155)",
  borderRadius: "10px",
  background: "var(--card, #0f172a)",
};

const workflowCreateShellStyle: CSSProperties = {
  display: "grid",
  gridTemplateRows: "auto auto minmax(560px, 1fr) auto auto",
  gap: 0,
  minHeight: "760px",
  border: "1px solid var(--border, #334155)",
  borderRadius: "10px",
  background: "var(--card, #0f172a)",
  overflow: "hidden",
};

const workflowCreateHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "12px",
  padding: "12px",
  borderBottom: "1px solid var(--border, #334155)",
  background: "color-mix(in srgb, var(--background, #020617) 44%, var(--card, #0f172a))",
  flexWrap: "wrap",
};

const workflowCreateIdentityStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(220px, 0.8fr) minmax(260px, 1.2fr)",
  gap: "10px",
  flex: "1 1 560px",
  minWidth: 0,
};

const workflowCreateActionsStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: "8px",
  flexWrap: "wrap",
};

const workflowCreateSetupStripStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
  gap: "8px",
  padding: "10px 12px",
  borderBottom: "1px solid var(--border, #334155)",
  background: "color-mix(in srgb, var(--card, #0f172a) 72%, var(--background, #020617))",
};

const workflowCreateFieldStyle: CSSProperties = {
  display: "grid",
  gap: "4px",
  minWidth: 0,
};

const workflowCreateWorkspaceStyle: CSSProperties = {
  display: "grid",
  minHeight: 0,
  padding: "12px",
};

const workflowCreateAdvancedStyle: CSSProperties = {
  display: "grid",
  gap: "10px",
  padding: "10px 12px",
  borderTop: "1px solid var(--border, #334155)",
  background: "color-mix(in srgb, var(--card, #0f172a) 82%, var(--background, #020617))",
};

const workflowCreateLabelStripStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  flexWrap: "wrap",
  minWidth: 0,
};

const paginationBarStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "12px",
  marginTop: "12px",
};

const paginationInfoStyle: CSSProperties = {
  ...mutedTextStyle,
  fontSize: "12px",
};

type StatusFilter = "active" | "archived";
type WorkflowScopeFilter = "reusable" | "manual_mission";

const filterTabStyle = (isActive: boolean): CSSProperties => ({
  padding: "6px 14px",
  border: "1px solid var(--border, #334155)",
  borderRadius: "6px",
  background: isActive
    ? "color-mix(in srgb, var(--foreground, #f8fafc) 14%, var(--card, #0f172a))"
    : "var(--card, #0f172a)",
  color: "var(--foreground, #f8fafc)",
  cursor: "pointer",
  fontSize: "12px",
  fontWeight: isActive ? 700 : 500,
  opacity: isActive ? 1 : 0.7,
});

type WorkflowSummary = WorkflowOverviewData["workflows"][number];
type WorkflowRunSummary = WorkflowOverviewData["activeRuns"][number];

function hasRecurringWorkflowTrigger(workflow: WorkflowSummary): boolean {
  return Boolean(
    (typeof workflow.schedule === "string" && workflow.schedule.trim())
    || (workflow.triggerLabels ?? []).length > 0,
  );
}

function isManualMissionPlanWorkflow(workflow: WorkflowSummary): boolean {
  const record = workflow as Record<string, unknown>;
  const sourceKind = typeof record.sourceKind === "string" ? record.sourceKind : "";
  const source = typeof record.source === "string" ? record.source : "";
  if (sourceKind === "manual_mission" || source === "manual_mission") return true;

  const name = workflow.name.trim();
  if (name.startsWith("PAQO WBS:")) return true;

  if (hasRecurringWorkflowTrigger(workflow)) return false;

  if (workflow.executionMode === "dynamic_owner_plan" || workflow.dynamicPlanBootstrapOnly === true) {
    return true;
  }

  return workflow.steps.some((step) => {
    const title = step.title.trim();
    return (
      /^action-\d+-/i.test(step.id)
      || /^qa-\d*-/i.test(step.id)
      || title.startsWith("[ACTION]")
      || title.startsWith("[QA]")
      || title === "Verify mission result"
      || step.executionMode === "dynamic_owner_plan"
      || step.ownerPlanBootstrapOnly === true
      || step.dynamicChildren === true
    );
  });
}

function workflowScopeLabel(scope: WorkflowScopeFilter): string {
  return scope === "manual_mission" ? "Manual Mission Plans" : "Reusable Workflows";
}

function workflowScopeDescription(scope: WorkflowScopeFilter): string {
  return scope === "manual_mission"
    ? "One-off planning DAGs created from manual missions. Keep these separate from reusable workflow definitions."
    : "Repeatable workflow definitions for scheduled, label-triggered, API, or operator-run execution.";
}

function filterRunsForWorkflows(
  runs: WorkflowRunSummary[],
  workflows: WorkflowSummary[],
): WorkflowRunSummary[] {
  const workflowIds = new Set(workflows.map((workflow) => workflow.id));
  const workflowNames = new Set(workflows.map((workflow) => workflow.name));
  return runs.filter((run) => {
    if (run.workflowId && workflowIds.has(run.workflowId)) return true;
    return workflowNames.has(run.workflowName);
  });
}

type WorkflowRunDrawerMode = "closed" | "active" | "recent";
type WorkflowRunHistoryScope = "all" | "selected";

const LABEL_COLOR_PRESETS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6", "#8b5cf6", "#6366f1", "#ec4899"];

function normalizeLabel(input: Record<string, unknown>): LabelOption {
  return {
    id: String(input.id ?? ""),
    name: String(input.name ?? input.id ?? ""),
    color: typeof input.color === "string" && input.color.trim() ? input.color : "#6366f1",
  };
}

function apiBaseUrl(): string {
  if (typeof window !== "undefined" && typeof window.location?.origin === "string" && window.location.origin.startsWith("http")) {
    return window.location.origin;
  }
  return "http://localhost:3100";
}

function useHostContext(): { companyId?: string } {
  const { selectedCompanyId } = useCompany();
  return { companyId: selectedCompanyId ?? "" };
}

async function coreApiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? undefined);
  if (!(init?.body instanceof FormData) && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const res = await fetch(`${apiBaseUrl()}/api${path}`, {
    credentials: "include",
    ...init,
    headers,
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => null) as { error?: string; message?: string } | null;
    throw new Error(payload?.error ?? payload?.message ?? `Request failed (${res.status})`);
  }
  return await res.json() as T;
}

function usePluginData<T>(key: string, params: Record<string, unknown>): {
  data: T | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
} {
  const paramsKey = JSON.stringify(params);
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    const parsedParams = JSON.parse(paramsKey) as Record<string, unknown>;
    setLoading(true);
    setError(null);
    try {
      if (key === "workflow-overview") {
        const companyId = typeof parsedParams.companyId === "string" ? parsedParams.companyId : "";
        if (!companyId.trim()) {
          setData({ workflows: [], activeRuns: [], recentRuns: [], projects: [], labels: [] } as T);
          return;
        }
        setData(await coreApiJson<T>(`/companies/${encodeURIComponent(companyId)}/workflows/overview`));
        return;
      }
      if (key === "workflow-run-detail") {
        const runId = typeof parsedParams.runId === "string" ? parsedParams.runId : "";
        if (!runId.trim()) {
          setData(null);
          return;
        }
        setData(await coreApiJson<T>(`/workflow-runs/${encodeURIComponent(runId)}/detail`));
        return;
      }
      throw new Error(`Unsupported workflow data key: ${key}`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError : new Error(String(nextError)));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [key, paramsKey]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void refresh().finally(() => {
      if (cancelled) return;
    });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  return { data, loading, error, refresh };
}

function usePluginAction(key: string): (params: Record<string, unknown>) => Promise<unknown> {
  return useCallback(async (params: Record<string, unknown>) => {
    if (key === "create-workflow") {
      const companyId = String(params.companyId ?? "");
      const workflow = (params.workflow && typeof params.workflow === "object" ? params.workflow : params) as Record<string, unknown>;
      return await coreApiJson(`/companies/${encodeURIComponent(companyId)}/workflows`, {
        method: "POST",
        body: JSON.stringify(workflow),
      });
    }
    if (key === "update-workflow") {
      const workflowId = String(params.workflowId ?? params.id ?? "");
      const workflow = (params.patch && typeof params.patch === "object")
        ? params.patch as Record<string, unknown>
        : (params.workflow && typeof params.workflow === "object" ? params.workflow : params) as Record<string, unknown>;
      const { workflowId: _workflowId, id: _id, companyId: _companyId, patch: _patch, ...patch } = workflow;
      if (patch.projectId === "") patch.projectId = null;
      if (patch.goalId === "") patch.goalId = null;
      return await coreApiJson(`/workflows/${encodeURIComponent(workflowId)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
    }
    if (key === "delete-workflow") {
      const workflowId = String(params.workflowId ?? params.id ?? "");
      return await coreApiJson(`/workflows/${encodeURIComponent(workflowId)}`, { method: "DELETE" });
    }
    if (key === "start-workflow") {
      const workflowId = String(params.workflowId ?? params.id ?? "");
      const { workflowId: _workflowId, id: _id, companyId: _companyId, ...body } = params;
      return await coreApiJson(`/workflows/${encodeURIComponent(workflowId)}/runs`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    }
    if (key === "resume-run") {
      const runId = String(params.runId ?? params.id ?? "");
      return await coreApiJson(`/workflow-runs/${encodeURIComponent(runId)}/resume`, {
        method: "POST",
        body: JSON.stringify({}),
      });
    }
    if (key === "abort-run" || key === "cancel-run") {
      const runId = String(params.runId ?? params.id ?? "");
      return await coreApiJson(`/workflow-runs/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
        body: JSON.stringify({ reason: key }),
      });
    }
    if (key === "manual-complete") {
      const issueId = String(params.issueId ?? "");
      return await coreApiJson(`/issues/${encodeURIComponent(issueId)}/workflow/manual-complete`, {
        method: "POST",
        body: JSON.stringify({}),
      });
    }
    if (key === "rerun-step") {
      const stepRunId = String(params.stepRunId ?? "");
      return await coreApiJson(`/workflow-step-runs/${encodeURIComponent(stepRunId)}/rerun`, {
        method: "POST",
        body: JSON.stringify({ issueId: params.issueId ?? undefined }),
      });
    }
    throw new Error(`Unsupported workflow action key: ${key}`);
  }, [key]);
}

function companyLabelsUrl(companyId: string): string {
  return `${apiBaseUrl()}/api/companies/${encodeURIComponent(companyId)}/labels`;
}

async function fetchCompanyLabels(companyId: string): Promise<LabelOption[]> {
  if (!companyId.trim()) {
    return [];
  }

  try {
    const res = await fetch(companyLabelsUrl(companyId));
    if (!res.ok) {
      return [];
    }
    const raw = await res.json() as Array<Record<string, unknown>>;
    return raw.map(normalizeLabel).filter((label) => label.id);
  } catch {
    return [];
  }
}

async function createCompanyLabel(companyId: string, name: string, color: string): Promise<LabelOption> {
  const res = await fetch(companyLabelsUrl(companyId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, color }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `레이블 생성 실패 (${res.status})`);
  }
  const payload = await res.json() as Record<string, unknown>;
  return normalizeLabel(payload);
}

function toggleLabelId(selectedIds: string[], labelId: string): string[] {
  return selectedIds.includes(labelId)
    ? selectedIds.filter((id) => id !== labelId)
    : [...selectedIds, labelId];
}

function labelChipStyle(color: string, selected: boolean): CSSProperties {
  return {
    ...inputStyle,
    width: "auto",
    padding: "6px 10px",
    border: `1px solid ${color}`,
    background: selected ? color : "transparent",
    color: selected ? "#ffffff" : color,
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    cursor: "pointer",
    fontWeight: 600,
    whiteSpace: "nowrap",
  };
}

function normalizeWorkflowToolOption(input: Record<string, unknown>): WorkflowToolOption {
  const name = String(input.name ?? "");
  return {
    name,
    displayName: String(input.displayName ?? name),
    description: String(input.description ?? ""),
    pluginId: String(input.pluginId ?? ""),
    source: typeof input.source === "string" ? input.source : undefined,
    enabled: typeof input.enabled === "boolean" ? input.enabled : true,
  };
}

async function fetchAvailableWorkflowTools(companyId: string): Promise<{ tools: WorkflowToolOption[]; grants: WorkflowToolGrant[]; toolSystem: WorkflowToolSystemState }> {
  if (!companyId.trim()) {
    return { tools: [], grants: [], toolSystem: { available: false, reason: "No company selected." } };
  }

  const catalogRes = await fetch(`${apiBaseUrl()}/api/companies/${encodeURIComponent(companyId)}/workflows/tools`);
  if (!catalogRes.ok) {
    return { tools: [], grants: [], toolSystem: { available: false, reason: "Workflow tools could not be loaded." } };
  }
  const catalogPayload = await catalogRes.json() as Record<string, unknown>;
  const pageData = catalogPayload && typeof catalogPayload === "object" && !Array.isArray(catalogPayload)
    ? catalogPayload
    : {};
  const sources = pageData.sources && typeof pageData.sources === "object" && !Array.isArray(pageData.sources)
    ? pageData.sources as Record<string, unknown>
    : {};
  const toolRegistry = sources.toolRegistry && typeof sources.toolRegistry === "object" && !Array.isArray(sources.toolRegistry)
    ? sources.toolRegistry as Record<string, unknown>
    : {};
  const toolsPayload = Array.isArray(pageData.tools) ? pageData.tools : [];
  const allTools = toolsPayload
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .map(normalizeWorkflowToolOption);
  const tools = getSelectableWorkflowTools(allTools);
  const toolSystem = getWorkflowToolSystemState(allTools, {
    available: toolRegistry.available === true,
    reason: typeof toolRegistry.unavailableReason === "string" ? toolRegistry.unavailableReason : undefined,
  });

  const grantsPayload = Array.isArray(pageData.grants) ? pageData.grants : [];
  const grants: WorkflowToolGrant[] = grantsPayload
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .map((item) => {
      const d = (item as Record<string, unknown>);
      const inner = (d.data && typeof d.data === "object" && !Array.isArray(d.data)) ? d.data as Record<string, unknown> : {};
      return {
        agentName: String(d.agentName ?? inner.agentName ?? "").trim(),
        toolName: String(d.toolName ?? inner.toolName ?? "").trim(),
      };
    })
    .filter((g) => g.agentName && g.toolName);

  return { tools, grants, toolSystem };
}

function useAvailableWorkflowTools(companyId: string): { tools: WorkflowToolOption[]; grants: WorkflowToolGrant[]; toolSystem: WorkflowToolSystemState } {
  const [tools, setTools] = useState<WorkflowToolOption[]>([]);
  const [grants, setGrants] = useState<WorkflowToolGrant[]>([]);
  const [toolSystem, setToolSystem] = useState<WorkflowToolSystemState>({ available: false });
  useEffect(() => {
    let cancelled = false;
    void fetchAvailableWorkflowTools(companyId)
      .then((result) => {
        if (!cancelled) {
          setTools(result.tools);
          setGrants(result.grants);
          setToolSystem(result.toolSystem);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTools([]);
          setGrants([]);
          setToolSystem({ available: false, reason: "Workflow tools could not be loaded." });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [companyId]);
  return { tools, grants, toolSystem };
}

function splitCommaList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function toggleCommaListValue(value: string, item: string): string {
  const selected = splitCommaList(value);
  const next = selected.includes(item)
    ? selected.filter((entry) => entry !== item)
    : [...selected, item];
  return next.join(", ");
}

function toolChoiceChipStyle(selected: boolean): CSSProperties {
  return {
    ...buttonStyle,
    width: "auto",
    justifyContent: "flex-start",
    padding: "6px 8px",
    fontSize: "11px",
    borderColor: selected ? "#38bdf8" : "var(--border, #334155)",
    background: selected
      ? "color-mix(in srgb, #38bdf8 18%, var(--background, #020617))"
      : "color-mix(in srgb, var(--card, #0f172a) 72%, var(--background, #020617))",
    color: selected ? "#bae6fd" : "var(--foreground, #f8fafc)",
  };
}

function WorkflowToolPicker({
  value,
  multiple,
  tools,
  onChange,
}: {
  value: string;
  multiple: boolean;
  tools: WorkflowToolOption[];
  onChange: (value: string) => void;
}): JSX.Element {
  const selectedValues = multiple ? splitCommaList(value) : [value.trim()].filter(Boolean);
  const availableNames = new Set(tools.map((tool) => tool.name));
  const unavailableSelections = selectedValues.filter((toolName) => !availableNames.has(toolName));

  if (!multiple) {
    return (
      <div style={{ display: "grid", gap: "5px" }}>
        <select style={selectStyle} value={value.trim()} onChange={(event) => onChange(event.target.value)}>
          <option value="">Choose authorized tool</option>
          {tools.map((tool) => (
            <option key={tool.name} value={tool.name}>
              {tool.displayName || tool.name}
            </option>
          ))}
          {unavailableSelections.map((toolName) => (
            <option key={`unavailable-${toolName}`} value={toolName}>
              {toolName} (unavailable)
            </option>
          ))}
        </select>
        {value.trim() ? (
          <span style={{ ...mutedTextStyle, fontSize: "11px", overflowWrap: "anywhere" }}>
            {tools.find((tool) => tool.name === value.trim())?.description || "Selected workflow tool"}
          </span>
        ) : (
          <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Select one authorized tool for this tool step.</span>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: "6px" }}>
      {tools.length > 0 ? (
        <div style={{ display: "flex", gap: "5px", flexWrap: "wrap" }}>
          {tools.map((tool) => {
            const selected = selectedValues.includes(tool.name);
            return (
              <button
                key={tool.name}
                type="button"
                title={tool.description || tool.name}
                style={toolChoiceChipStyle(selected)}
                onClick={() => onChange(toggleCommaListValue(value, tool.name))}
              >
                {selected ? "✓ " : ""}
                {tool.displayName || tool.name}
              </button>
            );
          })}
        </div>
      ) : (
        <span style={{ ...mutedTextStyle, fontSize: "11px" }}>No authorized tools available.</span>
      )}
      {unavailableSelections.length > 0 ? (
        <div style={{ display: "flex", gap: "5px", flexWrap: "wrap" }}>
          {unavailableSelections.map((toolName) => (
            <span key={toolName} style={{ ...graphPolicyBadgeStyle, color: "var(--destructive, #ef4444)" }}>
              {toolName} unavailable
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function useWorkflowOverview(companyId: string | null | undefined) {
  return usePluginData<OverviewData>("workflow-overview", {
    companyId: companyId ?? "",
  });
}

function useWorkflowRunDetail(runId: string | null | undefined) {
  return usePluginData<WorkflowRunDetailData | null>("workflow-run-detail", {
    runId: runId ?? "",
  });
}

function statusBadgeStyle(status: string): CSSProperties {
  const normalized = status.trim().toLowerCase();
  const base: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    padding: "2px 8px",
    borderRadius: "999px",
    fontSize: "12px",
    fontWeight: 600,
    border: "1px solid var(--border, #334155)",
    color: "var(--foreground, #f8fafc)",
  };

  if (normalized === "running" || normalized === "active") {
    return {
      ...base,
      background: "color-mix(in srgb, var(--foreground, #f8fafc) 16%, var(--background, #020617))",
    };
  }

  if (normalized === "completed") {
    return {
      ...base,
      background: "color-mix(in srgb, var(--foreground, #f8fafc) 22%, var(--background, #020617))",
    };
  }

  if (normalized === "succeeded" || normalized === "success" || normalized === "done") {
    return {
      ...base,
      background: "color-mix(in srgb, #22c55e 22%, var(--background, #020617))",
    };
  }

  if (normalized === "failed" || normalized === "aborted") {
    return {
      ...base,
      background: "color-mix(in srgb, var(--muted-foreground, #94a3b8) 26%, var(--background, #020617))",
    };
  }

  if (normalized === "timed-out" || normalized === "paused") {
    return {
      ...base,
      background: "color-mix(in srgb, var(--muted-foreground, #94a3b8) 20%, var(--background, #020617))",
    };
  }

  if (normalized === "skipped") {
    return {
      ...base,
      background: "color-mix(in srgb, var(--muted-foreground, #94a3b8) 14%, var(--background, #020617))",
    };
  }

  return {
    ...base,
    background: "color-mix(in srgb, var(--background, #020617) 78%, var(--card, #0f172a))",
  };
}

function formatDateTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}

function countStatuses(activeRuns: WorkflowOverviewData["activeRuns"]): Array<{ status: string; count: number }> {
  const counts = new Map<string, number>();

  for (const run of activeRuns) {
    const status = run.status.trim().toLowerCase() || "unknown";
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([status, count]) => ({ status, count }))
    .sort((left, right) => right.count - left.count || left.status.localeCompare(right.status));
}

function normalizeMaxDailyRunsInput(value: string): { value: number | undefined; error?: string } {
  const trimmed = value.trim();
  if (!trimmed) {
    return { value: undefined };
  }

  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return { value: undefined, error: "maxDailyRuns는 0 이상의 정수여야 합니다." };
  }

  return { value: parsed };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function formatJsonArrayForForm(value: unknown): string {
  return JSON.stringify(Array.isArray(value) ? value : [], null, 2);
}

function parseJsonArrayField(value: string, label: string): { value: unknown[]; error?: string } {
  const trimmed = value.trim();
  if (!trimmed) return { value: [] };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) {
      return { value: [], error: `${label}는 JSON 배열이어야 합니다.` };
    }
    return { value: parsed };
  } catch (error) {
    return { value: [], error: `${label} JSON 파싱 실패: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function buildWorkflowInterfaceMetadata(
  currentLegacyMetadata: unknown,
  flowInputsText: string,
  flowEnvVariablesText: string,
  testInputPresetsText: string,
): { value: Record<string, unknown>; error?: string } {
  const parsedInputs = parseJsonArrayField(flowInputsText, "Flow inputs");
  if (parsedInputs.error) return { value: {}, error: parsedInputs.error };
  const parsedEnvVariables = parseJsonArrayField(flowEnvVariablesText, "Flow env variables");
  if (parsedEnvVariables.error) return { value: {}, error: parsedEnvVariables.error };
  const parsedTestInputPresets = parseJsonArrayField(testInputPresetsText, "Saved test inputs");
  if (parsedTestInputPresets.error) return { value: {}, error: parsedTestInputPresets.error };
  return {
    value: {
      ...(isRecord(currentLegacyMetadata) ? currentLegacyMetadata : {}),
      graphFlowInputs: parsedInputs.value,
      graphFlowEnvVariables: parsedEnvVariables.value,
      graphTestInputPresets: parsedTestInputPresets.value,
    },
  };
}

function workflowStepsForExport(steps: StepDraft[], mode: StepEditorMode, jsonText: string): WorkflowGraphStep[] {
  if (mode === "json") {
    try {
      const parsed = JSON.parse(jsonText) as unknown;
      if (Array.isArray(parsed)) return parsed as WorkflowGraphStep[];
    } catch {
      // Keep export preview available while the JSON editor is temporarily invalid.
    }
  }
  return stepsToJson(steps) as WorkflowGraphStep[];
}

function formatWorkflowGraphStepsForJsonEditor(steps: WorkflowGraphStep[]): string {
  return JSON.stringify(steps, null, 2);
}

function parseOptionalNonNegativeInteger(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseOptionalPositiveInteger(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseOptionalGraphPosition(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : undefined;
}

function clampGraphCanvasScale(value: number): number {
  return Math.min(1.8, Math.max(0.45, value));
}

const selectStyle: CSSProperties = {
  ...inputStyle,
  appearance: "none",
  backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%2394a3b8' viewBox='0 0 16 16'%3E%3Cpath d='M8 11L3 6h10z'/%3E%3C/svg%3E\")",
  backgroundRepeat: "no-repeat",
  backgroundPosition: "right 10px center",
  paddingRight: "28px",
};

const stepCardStyle: CSSProperties = {
  display: "grid",
  gap: "8px",
  padding: "12px",
  border: "1px solid var(--border, #334155)",
  borderRadius: "8px",
  background: "var(--background, #020617)",
};

const stepRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: "8px",
};

function emptyStep(): StepDraft {
  return {
    id: "",
    title: "",
    description: "",
    type: "agent",
    toolName: "",
    toolArgs: "{}",
    agentName: "",
    tools: "",
    dependsOn: "",
    onFailure: "",
    maxRetries: "",
    graphRetryDelaySeconds: "",
    graphRetryBackoff: "",
    graphRetryJitter: false,
    timeoutSeconds: "",
    graphSleepSeconds: "",
    graphSuspendUntil: "",
    graphSuspendTimeoutSeconds: "",
    graphSuspendTimeoutAction: "",
    graphEarlyReturn: false,
    graphEarlyReturnContentType: "",
    graphEarlyReturnSchema: "",
    graphErrorHandler: false,
    graphErrorHandlerScope: "",
    graphErrorHandlerInput: "",
    graphRestartBoundary: false,
    graphRestartStrategy: "",
    graphRestartInput: "",
    graphEarlyStopCondition: "",
    graphEarlyStopLabelSkipped: false,
    graphApprovalRequired: false,
    graphApprovalPrompt: "",
    graphApprovalRecipients: "",
    graphApprovalTimeoutSeconds: "",
    graphApprovalTimeoutAction: "",
    graphMockEnabled: false,
    graphMockResult: "",
    graphPinnedResultRunId: "",
    graphConcurrencyKey: "",
    graphConcurrencyLimit: "",
    graphPriority: "",
    graphCacheEnabled: false,
    graphCacheTtlSeconds: "",
    graphDeleteAfterUse: false,
    graphInputExpression: "",
    graphOutputSchema: "",
    graphWorkProductRequired: false,
    graphWorkProductPattern: "",
    graphResourceRefs: "",
    graphSecretRefs: "",
    graphPositionX: "",
    graphPositionY: "",
    graphGroupId: "",
    graphGroupTitle: "",
    graphGroupColor: "#64748b",
    graphGroupCollapsed: undefined,
    graphGroupCollapsedByDefault: false,
    graphContainerId: "",
    graphContainerType: "branch",
    graphContainerTitle: "",
    graphContainerDescription: "",
    graphContainerMode: "branch-one",
    graphContainerCondition: "",
    graphContainerIterator: "",
    graphContainerSkipFailure: false,
    graphContainerRunInParallel: false,
    graphContainerParallelism: "",
    graphRunStatus: "planned",
    graphRunIssueIdentifier: "",
    graphRunUpdatedAt: "",
    graphRunSummary: "",
    graphNote: "",
    graphEdgeMetadata: {},
    extra: {},
  };
}

function withStepDraftDefaults(steps: StepDraft[]): StepDraft[] {
  return steps.map((step) => {
    const next = { ...emptyStep() };
    for (const [key, value] of Object.entries(step) as Array<[keyof StepDraft, StepDraft[keyof StepDraft]]>) {
      if (value !== undefined) {
        next[key] = value as never;
      }
    }
    return next;
  });
}

const collapsedStepHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "10px",
  padding: "10px 12px",
  border: "1px solid var(--border, #334155)",
  borderRadius: "8px",
  background: "var(--background, #020617)",
  cursor: "pointer",
  fontSize: "13px",
  userSelect: "none",
};

const selectedStepOutlineStyle: CSSProperties = {
  outline: "2px solid color-mix(in srgb, var(--foreground, #f8fafc) 40%, transparent)",
  outlineOffset: "-2px",
};

function StepEditor({
  steps,
  onChange,
  availableTools,
  availableToolGrants,
}: {
  steps: StepDraft[];
  onChange: (steps: StepDraft[]) => void;
  availableTools: WorkflowToolOption[];
  availableToolGrants: WorkflowToolGrant[];
}): JSX.Element {
  const [collapsedSet, setCollapsedSet] = useState<Set<number>>(() => new Set(steps.map((_, i) => i)));
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  function toggleCollapse(index: number) {
    setCollapsedSet((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }

  function update(index: number, patch: Partial<StepDraft>) {
    const next = steps.map((s, i) => (i === index ? { ...s, ...patch } : s));
    onChange(next);
  }

  function remove(index: number) {
    onChange(steps.filter((_, i) => i !== index));
    setCollapsedSet((prev) => {
      const next = new Set<number>();
      for (const idx of prev) {
        if (idx < index) next.add(idx);
        else if (idx > index) next.add(idx - 1);
      }
      return next;
    });
    if (selectedIndex === index) setSelectedIndex(null);
    else if (selectedIndex !== null && selectedIndex > index) setSelectedIndex(selectedIndex - 1);
  }

  function add() {
    if (selectedIndex !== null && selectedIndex >= 0 && selectedIndex < steps.length) {
      const afterStep = steps[selectedIndex];
      const newStep = { ...emptyStep(), dependsOn: afterStep.id.trim() };
      const insertAt = selectedIndex + 1;
      const next = [...steps.slice(0, insertAt), newStep, ...steps.slice(insertAt)];
      onChange(next);
      setCollapsedSet((prev) => {
        const shifted = new Set<number>();
        for (const idx of prev) {
          if (idx < insertAt) shifted.add(idx);
          else shifted.add(idx + 1);
        }
        return shifted;
      });
      setSelectedIndex(insertAt);
    } else {
      onChange([...steps, emptyStep()]);
      setSelectedIndex(steps.length);
    }
  }

  const allIds = steps.map((s) => s.id).filter(Boolean);

  return (
    <div style={{ display: "grid", gap: "10px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ ...mutedTextStyle, fontWeight: 600 }}>Steps ({steps.length})</span>
        <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
          {selectedIndex !== null && (
            <span style={{ fontSize: "11px", color: "var(--muted-foreground, #94a3b8)" }}>
              insert after step {selectedIndex + 1}
            </span>
          )}
          <button type="button" style={buttonStyle} onClick={add}>+ Add Step</button>
        </div>
      </div>
      {steps.map((step, i) => {
        const isCollapsed = collapsedSet.has(i);
        const isSelected = selectedIndex === i;

        if (isCollapsed) {
          return (
            <div
              key={i}
              style={{
                ...collapsedStepHeaderStyle,
                ...(isSelected ? selectedStepOutlineStyle : {}),
              }}
              onClick={() => {
                setSelectedIndex(isSelected ? null : i);
              }}
              onDoubleClick={() => toggleCollapse(i)}
            >
              <span style={{ fontSize: "11px", color: "var(--muted-foreground, #94a3b8)", minWidth: "18px" }}>{i + 1}</span>
              <span style={{ fontSize: "13px" }}>{step.type === "tool" ? "\uD83D\uDD27" : "\uD83E\uDD16"}</span>
              <span style={{ fontWeight: 600, fontSize: "13px", color: "var(--foreground, #f8fafc)" }}>
                {step.id || "(no id)"}
              </span>
              {step.title && (
                <span style={{ color: "var(--muted-foreground, #94a3b8)", fontSize: "12px" }}>
                  — {step.title}
                </span>
              )}
              <span style={{ marginLeft: "auto", display: "flex", gap: "4px", alignItems: "center" }}>
                <button
                  type="button"
                  style={{ ...buttonStyle, padding: "2px 8px", fontSize: "11px" }}
                  onClick={(e) => { e.stopPropagation(); toggleCollapse(i); }}
                >Expand</button>
                <button
                  type="button"
                  style={{ ...dangerButtonStyle, padding: "2px 8px", fontSize: "11px" }}
                  onClick={(e) => { e.stopPropagation(); remove(i); }}
                >Remove</button>
              </span>
            </div>
          );
        }

        return (
          <div
            key={i}
            style={{
              ...stepCardStyle,
              ...(isSelected ? selectedStepOutlineStyle : {}),
            }}
            onClick={() => setSelectedIndex(isSelected ? null : i)}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--muted-foreground, #94a3b8)" }}>
                Step {i + 1} — {step.type === "tool" ? "\uD83D\uDD27 Tool" : "\uD83E\uDD16 Agent"}
              </span>
              <div style={{ display: "flex", gap: "4px" }}>
                <button type="button" style={{ ...buttonStyle, padding: "4px 8px", fontSize: "11px" }} onClick={(e) => { e.stopPropagation(); toggleCollapse(i); }}>Collapse</button>
                <button type="button" style={{ ...dangerButtonStyle, padding: "4px 8px", fontSize: "11px" }} onClick={(e) => { e.stopPropagation(); remove(i); }}>Remove</button>
              </div>
            </div>
            <div style={stepRowStyle} onClick={(e) => e.stopPropagation()}>
              <div style={{ display: "grid", gap: "4px" }}>
                <label style={{ ...mutedTextStyle, fontSize: "11px" }}>ID</label>
                <input style={inputStyle} value={step.id} placeholder="gather" onChange={(e) => update(i, { id: e.target.value })} />
              </div>
              <div style={{ display: "grid", gap: "4px" }}>
                <label style={{ ...mutedTextStyle, fontSize: "11px" }}>Title</label>
                <input style={inputStyle} value={step.title} placeholder="데이터 수집" onChange={(e) => update(i, { title: e.target.value })} />
              </div>
            </div>
            <div style={{ display: "grid", gap: "4px" }} onClick={(e) => e.stopPropagation()}>
              <label style={{ ...mutedTextStyle, fontSize: "11px" }}>Description (에이전트에게 전달할 작업 지시)</label>
              <textarea style={{ ...textareaStyle, minHeight: "120px" }} value={step.description} placeholder="수집된 데이터를 분석하여 보고서를 작성하세요." onChange={(e) => update(i, { description: e.target.value })} rows={2} />
            </div>
            <div style={stepRowStyle} onClick={(e) => e.stopPropagation()}>
              <div style={{ display: "grid", gap: "4px" }}>
                <label style={{ ...mutedTextStyle, fontSize: "11px" }}>Type</label>
                <select style={selectStyle} value={step.type} onChange={(e) => {
                  const newType = e.target.value as "agent" | "tool";
                  if (newType === "tool" && availableTools.length === 0) return;
                  if (newType === "agent" && step.agentName) {
                    const granted = new Set(availableToolGrants.filter((g) => g.agentName === step.agentName).map((g) => g.toolName));
                    const cleaned = splitCommaList(step.tools).filter((t) => granted.has(t)).join(", ");
                    update(i, { type: newType, tools: cleaned });
                  } else {
                    update(i, { type: newType });
                  }
                }}>
                  <option value="tool" disabled={availableTools.length === 0}>{"\uD83D\uDD27"} Tool (시스템 실행)</option>
                  <option value="agent">{"\uD83E\uDD16"} Agent (에이전트 작업)</option>
                </select>
                {availableTools.length === 0 ? (
                  <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Tool steps are inactive until workflow tools are available.</span>
                ) : null}
              </div>
              <div style={{ display: "grid", gap: "4px" }}>
                {step.type === "tool" ? (
                  <>
                    <label style={{ ...mutedTextStyle, fontSize: "11px" }}>Tool Name</label>
                    <WorkflowToolPicker
                      value={step.toolName}
                      multiple={false}
                      tools={availableTools}
                      onChange={(value) => update(i, { toolName: value })}
                    />
                  </>
                ) : (
                  <>
                    <label style={{ ...mutedTextStyle, fontSize: "11px" }}>Agent Name</label>
                    <input style={inputStyle} value={step.agentName} placeholder="헐크" onChange={(e) => {
                  const newName = e.target.value;
                  const granted = new Set(availableToolGrants.filter((g) => g.agentName === newName).map((g) => g.toolName));
                  const cleaned = splitCommaList(step.tools).filter((t) => granted.has(t)).join(", ");
                  update(i, { agentName: newName, tools: cleaned });
                }} />
                  </>
                )}
              </div>
            </div>
            {step.type === "tool" && (
              <div style={{ display: "grid", gap: "4px" }} onClick={(e) => e.stopPropagation()}>
                <label style={{ ...mutedTextStyle, fontSize: "11px" }}>Tool Args (JSON)</label>
                <textarea
                  style={{ ...textareaStyle, minHeight: "96px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px" }}
                  value={step.toolArgs}
                  placeholder={'{\n  "profile": "tech-scout"\n}'}
                  onChange={(e) => update(i, { toolArgs: e.target.value })}
                  rows={4}
                />
              </div>
            )}
            {step.type === "agent" && (
              <div style={{ display: "grid", gap: "4px" }} onClick={(e) => e.stopPropagation()}>
                <label style={{ ...mutedTextStyle, fontSize: "11px" }}>Agent tool access</label>
                <WorkflowToolPicker
                  value={step.tools}
                  multiple={true}
                  tools={availableTools.filter((t) => availableToolGrants.some((g) => g.agentName === step.agentName && g.toolName === t.name))}
                  onChange={(value) => update(i, { tools: value })}
                />
              </div>
            )}
            <div style={stepRowStyle} onClick={(e) => e.stopPropagation()}>
              <div style={{ display: "grid", gap: "4px" }}>
                <label style={{ ...mutedTextStyle, fontSize: "11px" }}>Depends On (comma-separated IDs)</label>
                <input style={inputStyle} value={step.dependsOn} placeholder={allIds.filter((id) => id !== step.id).join(", ") || "none"} onChange={(e) => update(i, { dependsOn: e.target.value })} />
              </div>
              <div style={{ display: "grid", gap: "4px" }}>
                <label style={{ ...mutedTextStyle, fontSize: "11px" }}>On Failure</label>
                <select style={selectStyle} value={step.onFailure} onChange={(e) => update(i, { onFailure: e.target.value })}>
                  <option value="">default</option>
                  <option value="retry">retry</option>
                  <option value="skip">skip</option>
                  <option value="abort_workflow">abort workflow</option>
                  <option value="escalate">escalate</option>
                </select>
              </div>
              <div style={{ display: "grid", gap: "4px" }}>
                <label style={{ ...mutedTextStyle, fontSize: "11px" }}>Max Retries</label>
                <input
                  style={inputStyle}
                  type="number"
                  min={0}
                  step={1}
                  value={step.maxRetries}
                  placeholder={step.onFailure === "retry" ? "2" : "blank"}
                  onChange={(e) => update(i, { maxRetries: e.target.value })}
                />
              </div>
              <div style={{ display: "grid", gap: "4px" }}>
                <label style={{ ...mutedTextStyle, fontSize: "11px" }}>Timeout Seconds</label>
                <input
                  style={inputStyle}
                  type="number"
                  min={1}
                  step={1}
                  value={step.timeoutSeconds}
                  placeholder="default"
                  onChange={(e) => update(i, { timeoutSeconds: e.target.value })}
                />
              </div>
            </div>
            <div style={{ display: "grid", gap: "6px" }} onClick={(e) => e.stopPropagation()}>
              <label style={{ ...mutedTextStyle, fontSize: "11px" }}>Early Stop Condition</label>
              <textarea
                style={{ ...textareaStyle, minHeight: "54px" }}
                value={step.graphEarlyStopCondition}
                placeholder="result.done === true"
                onChange={(e) => update(i, { graphEarlyStopCondition: e.target.value })}
              />
              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
                <input
                  type="checkbox"
                  checked={step.graphEarlyStopLabelSkipped}
                  onChange={(e) => update(i, { graphEarlyStopLabelSkipped: e.target.checked })}
                />
                Label flow as skipped if stopped
              </label>
            </div>
          </div>
        );
      })}
      {steps.length === 0 && <p style={mutedTextStyle}>No steps yet. Click "+ Add Step" to begin.</p>}
    </div>
  );
}

const graphShellStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(620px, 1fr) 340px",
  gap: "0",
  alignItems: "stretch",
  minHeight: 0,
  height: "100%",
  border: "1px solid var(--border, #334155)",
  borderRadius: "8px",
  overflow: "hidden",
  background: "var(--background, #020617)",
};

const graphWorkbenchMainStyle: CSSProperties = {
  display: "grid",
  gridTemplateRows: "minmax(360px, 1fr) auto",
  minWidth: 0,
  minHeight: 0,
  borderRight: "1px solid var(--border, #334155)",
};

const graphStatusStripStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  alignItems: "center",
  gap: "10px",
  padding: "9px 10px",
  borderTop: "1px solid var(--border, #334155)",
  background: "color-mix(in srgb, var(--card, #0f172a) 72%, var(--background, #020617))",
};

const graphCanvasStyle: CSSProperties = {
  position: "relative",
  minHeight: "360px",
  height: "100%",
  overflow: "hidden",
  background: "linear-gradient(90deg, color-mix(in srgb, var(--border, #334155) 22%, transparent) 1px, transparent 1px), linear-gradient(180deg, color-mix(in srgb, var(--border, #334155) 22%, transparent) 1px, transparent 1px), var(--background, #020617)",
  backgroundSize: "28px 28px",
};

const graphCanvasToolDockBaseStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "6px",
  width: "fit-content",
  padding: "4px",
  border: "1px solid var(--border, #334155)",
  borderRadius: "8px",
  background: "color-mix(in srgb, var(--card, #0f172a) 92%, transparent)",
  boxShadow: "0 6px 20px color-mix(in srgb, #000 22%, transparent)",
};

const graphCanvasEditToolLayerStyle: CSSProperties = {
  position: "absolute",
  top: "10px",
  right: "10px",
  zIndex: 10,
  display: "flex",
  justifyContent: "flex-end",
  pointerEvents: "none",
};

const graphCanvasViewToolLayerStyle: CSSProperties = {
  position: "absolute",
  right: "10px",
  bottom: "10px",
  zIndex: 10,
  display: "flex",
  justifyContent: "flex-end",
  pointerEvents: "none",
};

const graphCanvasEditToolDockStyle: CSSProperties = {
  ...graphCanvasToolDockBaseStyle,
  pointerEvents: "auto",
};

const graphCanvasViewToolDockStyle: CSSProperties = {
  ...graphCanvasToolDockBaseStyle,
  pointerEvents: "auto",
};

const graphCanvasToolGroupStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "4px",
  padding: "2px",
  border: "1px solid color-mix(in srgb, var(--border, #334155) 70%, transparent)",
  borderRadius: "7px",
  background: "color-mix(in srgb, var(--background, #020617) 76%, transparent)",
};

const graphCanvasToolLabelStyle: CSSProperties = {
  padding: "0 5px",
  color: "var(--muted-foreground, #94a3b8)",
  fontSize: "10px",
  fontWeight: 800,
  textTransform: "uppercase",
  whiteSpace: "nowrap",
};

const graphCanvasToolButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: "28px",
  height: "28px",
  padding: 0,
  border: "1px solid color-mix(in srgb, var(--border, #334155) 82%, transparent)",
  borderRadius: "7px",
  background: "var(--background, #020617)",
  color: "var(--foreground, #f8fafc)",
  fontSize: "12px",
  fontWeight: 800,
  cursor: "pointer",
};

const graphContextMenuStyle: CSSProperties = {
  position: "fixed",
  zIndex: 40,
  display: "grid",
  gap: "3px",
  minWidth: "176px",
  padding: "5px",
  border: "1px solid var(--border, #334155)",
  borderRadius: "8px",
  background: "var(--card, #0f172a)",
  boxShadow: "0 10px 28px color-mix(in srgb, #000 34%, transparent)",
};

const graphContextMenuButtonStyle: CSSProperties = {
  width: "100%",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "10px",
  padding: "7px 8px",
  border: "0",
  borderRadius: "6px",
  background: "transparent",
  color: "var(--foreground, #f8fafc)",
  fontSize: "12px",
  textAlign: "left",
  cursor: "pointer",
};

const graphSidebarStyle: CSSProperties = {
  display: "grid",
  gap: "10px",
  alignContent: "start",
  padding: "12px",
  background: "var(--background, #020617)",
  overflow: "auto",
  minHeight: 0,
};

const workflowManagementShellStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "280px minmax(640px, 1fr)",
  gap: "0",
  minHeight: "620px",
  border: "1px solid var(--border, #334155)",
  borderRadius: "8px",
  overflow: "hidden",
  background: "var(--background, #020617)",
};

const workflowDefinitionRailStyle: CSSProperties = {
  display: "grid",
  gridTemplateRows: "auto 1fr",
  gap: "10px",
  minWidth: 0,
  minHeight: 0,
  padding: "12px",
  borderRight: "1px solid var(--border, #334155)",
  background: "color-mix(in srgb, var(--card, #0f172a) 62%, var(--background, #020617))",
};

const workflowDefinitionRailListStyle: CSSProperties = {
  display: "grid",
  alignContent: "start",
  gap: "7px",
  minHeight: 0,
  overflow: "auto",
};

const workflowNavigatorSummaryGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
  gap: "6px",
};

const workflowNavigatorMetricStyle: CSSProperties = {
  display: "grid",
  gap: "2px",
  minWidth: 0,
  padding: "7px",
  border: "1px solid var(--border, #334155)",
  borderRadius: "8px",
  background: "var(--background, #020617)",
};

const workflowNavigatorFilterRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "5px",
  minWidth: 0,
  overflowX: "auto",
  paddingBottom: "1px",
};

const workflowNavigatorFilterButtonStyle = (selected: boolean): CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  gap: "5px",
  height: "28px",
  padding: "0 8px",
  border: `1px solid ${selected ? "color-mix(in srgb, #22c55e 46%, var(--border, #334155))" : "var(--border, #334155)"}`,
  borderRadius: "8px",
  background: selected
    ? "color-mix(in srgb, #22c55e 9%, var(--background, #020617))"
    : "var(--background, #020617)",
  color: selected ? "var(--foreground, #f8fafc)" : "var(--muted-foreground, #94a3b8)",
  fontSize: "11px",
  fontWeight: 800,
  whiteSpace: "nowrap",
  cursor: "pointer",
});

const workflowDefinitionRailButtonStyle = (selected: boolean): CSSProperties => ({
  display: "grid",
  gap: "5px",
  width: "100%",
  padding: "9px",
  border: `1px solid ${selected ? "color-mix(in srgb, #22c55e 54%, var(--border, #334155))" : "var(--border, #334155)"}`,
  borderRadius: "8px",
  background: selected
    ? "color-mix(in srgb, #22c55e 8%, var(--background, #020617))"
    : "var(--background, #020617)",
  color: "var(--foreground, #f8fafc)",
  textAlign: "left",
  cursor: "pointer",
});

const workflowDefinitionListStyle: CSSProperties = {
  display: "grid",
  gap: "8px",
};

const workflowDefinitionListRowStyle = (highlighted: boolean): CSSProperties => ({
  display: "grid",
  gridTemplateColumns: "minmax(220px, 0.95fr) minmax(320px, 1.25fr) minmax(230px, auto)",
  gap: "12px",
  alignItems: "center",
  padding: "10px",
  border: `1px solid ${highlighted ? "color-mix(in srgb, #22c55e 46%, var(--border, #334155))" : "var(--border, #334155)"}`,
  borderRadius: "8px",
  background: highlighted
    ? "color-mix(in srgb, #22c55e 8%, var(--background, #020617))"
    : "color-mix(in srgb, var(--background, #020617) 84%, var(--card, #0f172a))",
});

const workflowDefinitionListIdentityStyle: CSSProperties = {
  display: "grid",
  gap: "5px",
  minWidth: 0,
};

const workflowDefinitionListTitleStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "7px",
  minWidth: 0,
  flexWrap: "wrap",
};

const workflowDefinitionMiniFlowStyle: CSSProperties = {
  display: "grid",
  gap: "6px",
  minWidth: 0,
};

const workflowDefinitionMiniFlowNodesStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(4, minmax(58px, 1fr))",
  gap: "6px",
  alignItems: "center",
  minWidth: 0,
};

const workflowDefinitionMiniFlowNodeStyle = (type?: string): CSSProperties => ({
  minWidth: 0,
  padding: "5px 6px",
  border: `1px solid ${type === "tool" ? "color-mix(in srgb, #38bdf8 45%, var(--border, #334155))" : "var(--border, #334155)"}`,
  borderRadius: "7px",
  background: "var(--background, #020617)",
  color: "var(--foreground, #f8fafc)",
  fontSize: "11px",
  lineHeight: 1.2,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});

const workflowDefinitionListMetricsStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "9px",
  minWidth: 0,
  color: "var(--muted-foreground, #94a3b8)",
  fontSize: "11px",
  overflow: "hidden",
  whiteSpace: "nowrap",
};

const workflowDefinitionListActionsStyle: CSSProperties = {
  display: "grid",
  justifyItems: "end",
  gap: "6px",
  minWidth: 0,
};

const workflowDefinitionListActionRowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "6px",
  flexWrap: "wrap",
};

const workflowSelectedEditorStyle: CSSProperties = {
  display: "grid",
  gridTemplateRows: "auto minmax(0, 1fr) auto",
  gap: "0",
  minWidth: 0,
  minHeight: 0,
};

const workflowSelectedHeaderStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  gap: "8px 12px",
  alignItems: "center",
  padding: "8px 10px",
  borderBottom: "1px solid var(--border, #334155)",
  background: "color-mix(in srgb, var(--background, #020617) 90%, var(--card, #0f172a))",
};

const workflowSelectedHeaderMainStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  minWidth: 0,
  flexWrap: "wrap",
};

const workflowSelectedHeaderActionsStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: "6px",
  flexWrap: "wrap",
};

const workflowSelectedIdentityStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(220px, 0.8fr) minmax(280px, 1.2fr)",
  gap: "8px",
  minWidth: 0,
};

const workflowSelectedSetupStripStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(145px, 1fr))",
  gap: "8px",
  gridColumn: "1 / -1",
  paddingTop: "8px",
  borderTop: "1px solid var(--border, #334155)",
};

const workflowSelectedAdvancedStyle: CSSProperties = {
  display: "grid",
  gap: "10px",
  gridColumn: "1 / -1",
  paddingTop: "8px",
  borderTop: "1px solid var(--border, #334155)",
};

const workflowSelectedWorkspaceStyle: CSSProperties = {
  minHeight: 0,
  overflow: "auto",
};

const workflowRunDrawerStyle = (mode: WorkflowRunDrawerMode): CSSProperties => ({
  display: "grid",
  gridTemplateRows: mode === "closed" ? "auto" : "auto minmax(0, 1fr)",
  minHeight: mode === "closed" ? "46px" : "430px",
  maxHeight: mode === "closed" ? "46px" : "560px",
  borderTop: "1px solid var(--border, #334155)",
  background: "color-mix(in srgb, var(--background, #020617) 86%, var(--card, #0f172a))",
});

const workflowRunDrawerHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "10px",
  minWidth: 0,
  padding: "8px 10px",
  borderBottom: "1px solid var(--border, #334155)",
};

const workflowRunDrawerSummaryStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "10px",
  minWidth: 0,
  padding: "8px 10px",
};

const workflowRunDrawerBodyStyle: CSSProperties = {
  minHeight: 0,
  overflow: "auto",
};

const workflowRunHistorySectionStyle: CSSProperties = {
  ...workflowFocusSectionStyle,
  minHeight: "430px",
};

const workflowPolicyDetailsStyle: CSSProperties = {
  display: "grid",
  gap: "8px",
  padding: "8px",
  border: "1px solid var(--border, #334155)",
  borderRadius: "8px",
  background: "color-mix(in srgb, var(--card, #0f172a) 48%, var(--background, #020617))",
};

const workflowPolicyDetailsSummaryStyle: CSSProperties = {
  cursor: "pointer",
  color: "var(--foreground, #f8fafc)",
  fontSize: "12px",
  fontWeight: 800,
};

const workflowRunTimelineStyle: CSSProperties = {
  display: "grid",
  gap: "7px",
  minHeight: 0,
  padding: "8px 10px",
};

const workflowRunTimelineRowStyle = (selected: boolean): CSSProperties => ({
  display: "grid",
  gridTemplateColumns: "14px minmax(170px, 1.2fr) minmax(110px, 0.7fr) minmax(150px, 1fr) auto",
  gap: "9px",
  alignItems: "center",
  minHeight: "48px",
  padding: "8px",
  border: `1px solid ${selected ? "color-mix(in srgb, #38bdf8 48%, var(--border, #334155))" : "var(--border, #334155)"}`,
  borderRadius: "8px",
  background: selected
    ? "color-mix(in srgb, #38bdf8 7%, var(--background, #020617))"
    : "var(--background, #020617)",
});

const workflowRunTimelineDotStyle = (status: string): CSSProperties => {
  const normalized = status.trim().toLowerCase();
  const color = normalized === "failed" || normalized === "aborted" || normalized === "error"
    ? "var(--destructive, #ef4444)"
    : normalized === "running" || normalized === "in_progress"
      ? "#38bdf8"
      : normalized === "completed" || normalized === "succeeded" || normalized === "success" || normalized === "done"
        ? "#22c55e"
        : "#94a3b8";
  return {
    width: "9px",
    height: "9px",
    borderRadius: "999px",
    background: color,
    boxShadow: `0 0 0 3px color-mix(in srgb, ${color} 16%, transparent)`,
  };
};

const workflowRunTimelineActionsStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: "6px",
  flexWrap: "wrap",
};

const workflowRunTimelineDetailStyle: CSSProperties = {
  padding: "8px",
  border: "1px dashed color-mix(in srgb, #38bdf8 36%, var(--border, #334155))",
  borderRadius: "8px",
  background: "color-mix(in srgb, #38bdf8 5%, var(--background, #020617))",
};

const workflowRunDrawerActionsStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: "6px",
  flexWrap: "wrap",
};

const workflowRunOverlayBannerStyle: CSSProperties = {
  gridColumn: "1 / -1",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "10px",
  minWidth: 0,
  padding: "8px 9px",
  borderTop: "1px solid color-mix(in srgb, #38bdf8 24%, var(--border, #334155))",
  background: "color-mix(in srgb, #38bdf8 7%, var(--background, #020617))",
};

const workflowRunDebugStripStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(188px, 0.9fr) repeat(4, minmax(116px, 1fr))",
  gap: "5px",
  gridColumn: "1 / -1",
  minWidth: 0,
  padding: "6px",
  borderBottom: "1px solid var(--border, #334155)",
  background: "color-mix(in srgb, #38bdf8 5%, var(--background, #020617))",
};

function workflowRunDebugToneColor(tone: WorkflowGraphRunDebugTileTone): string {
  if (tone === "success") return "#22c55e";
  if (tone === "warning") return "#f59e0b";
  if (tone === "danger") return "var(--destructive, #ef4444)";
  if (tone === "info") return "#38bdf8";
  return "var(--muted-foreground, #94a3b8)";
}

const workflowRunDebugDecisionStyle = (tone: WorkflowGraphRunDebugTileTone): CSSProperties => {
  const color = workflowRunDebugToneColor(tone);
  return {
    display: "grid",
    gap: "4px",
    minWidth: 0,
    padding: "8px",
    border: `1px solid color-mix(in srgb, ${color} 42%, var(--border, #334155))`,
    borderRadius: "8px",
    background: `color-mix(in srgb, ${color} 6%, var(--background, #020617))`,
  };
};

const workflowRunDebugTileStyle = (tone: WorkflowGraphRunDebugTileTone): CSSProperties => {
  const color = workflowRunDebugToneColor(tone);
  return {
    display: "grid",
    gridTemplateRows: "auto auto 1fr",
    gap: "4px",
    minWidth: 0,
    padding: "8px",
    border: `1px solid color-mix(in srgb, ${color} 28%, var(--border, #334155))`,
    borderRadius: "8px",
    background: `color-mix(in srgb, ${color} 4%, var(--card, #0f172a))`,
  };
};

const graphInspectorSectionStyle: CSSProperties = {
  display: "grid",
  gap: "8px",
  paddingBottom: "8px",
  borderBottom: "1px solid var(--border, #334155)",
};

function workflowGraphFocusLensToneColor(tone: WorkflowGraphFocusLensTone): string {
  if (tone === "success") return "#22c55e";
  if (tone === "warning") return "#f59e0b";
  if (tone === "danger") return "var(--destructive, #ef4444)";
  if (tone === "info") return "#38bdf8";
  return "var(--muted-foreground, #94a3b8)";
}

const workflowGraphFocusLensMetricStyle = (tone: WorkflowGraphFocusLensTone): CSSProperties => {
  const color = workflowGraphFocusLensToneColor(tone);
  return {
    display: "grid",
    gap: "3px",
    minWidth: 0,
    padding: "7px",
    borderLeft: `2px solid ${color}`,
    background: `color-mix(in srgb, ${color} 5%, var(--background, #020617))`,
  };
};

const workflowGraphTestDrawerStyle = (tone: WorkflowGraphFocusLensTone): CSSProperties => {
  const color = workflowGraphFocusLensToneColor(tone);
  return {
    display: "grid",
    gap: "9px",
    padding: "9px",
    border: `1px solid color-mix(in srgb, ${color} 34%, var(--border, #334155))`,
    borderRadius: "8px",
    background: `color-mix(in srgb, ${color} 5%, var(--background, #020617))`,
  };
};

const workflowGraphTestDrawerModeStyle = (tone: WorkflowGraphFocusLensTone): CSSProperties => {
  const color = workflowGraphFocusLensToneColor(tone);
  return {
    display: "grid",
    gap: "4px",
    minWidth: 0,
    padding: "7px",
    border: `1px solid color-mix(in srgb, ${color} 28%, var(--border, #334155))`,
    borderRadius: "7px",
    background: `color-mix(in srgb, ${color} 4%, transparent)`,
  };
};

const workflowGraphStructurePaletteStyle = (tone: WorkflowGraphFocusLensTone): CSSProperties => {
  const color = workflowGraphFocusLensToneColor(tone);
  return {
    display: "grid",
    gap: "8px",
    padding: "9px",
    border: `1px solid color-mix(in srgb, ${color} 32%, var(--border, #334155))`,
    borderRadius: "8px",
    background: `color-mix(in srgb, ${color} 5%, var(--background, #020617))`,
  };
};

const workflowGraphStructureActionStyle = (tone: WorkflowGraphFocusLensTone, disabled = false): CSSProperties => {
  const color = workflowGraphFocusLensToneColor(tone);
  return {
    ...buttonStyle,
    display: "grid",
    gap: "3px",
    justifyContent: "stretch",
    alignContent: "start",
    minHeight: "54px",
    padding: "7px",
    textAlign: "left",
    borderColor: `color-mix(in srgb, ${color} 24%, var(--border, #334155))`,
    background: `color-mix(in srgb, ${color} 4%, var(--background, #020617))`,
    ...(disabled ? buttonDisabledStyle : {}),
  };
};

const graphNodeStyle = (selected: boolean, kind: string, matched = false, inSelection = false): CSSProperties => ({
  position: "absolute",
  width: "172px",
  minHeight: "76px",
  padding: "10px",
  border: selected
    ? "2px solid color-mix(in srgb, var(--foreground, #f8fafc) 62%, transparent)"
    : matched
      ? "2px solid #fbbf24"
      : inSelection
        ? "2px solid #22c55e"
      : "1px solid var(--border, #334155)",
  borderRadius: "8px",
  background: kind === "tool"
    ? "color-mix(in srgb, #0891b2 18%, var(--card, #0f172a))"
    : kind === "group"
      ? "color-mix(in srgb, #0ea5e9 16%, var(--card, #0f172a))"
    : "var(--card, #0f172a)",
  color: "var(--foreground, #f8fafc)",
  boxShadow: selected
    ? "0 0 0 3px color-mix(in srgb, var(--foreground, #f8fafc) 10%, transparent)"
    : matched
      ? "0 0 0 3px color-mix(in srgb, #fbbf24 18%, transparent)"
      : inSelection
        ? "0 0 0 3px color-mix(in srgb, #22c55e 14%, transparent)"
      : "none",
  cursor: "pointer",
  textAlign: "left",
});

const graphNodeHandleBaseStyle: CSSProperties = {
  position: "absolute",
  top: "50%",
  width: "14px",
  height: "14px",
  border: "2px solid var(--background, #020617)",
  borderRadius: "999px",
  transform: "translateY(-50%)",
  boxShadow: "0 0 0 1px color-mix(in srgb, #38bdf8 55%, transparent)",
  cursor: "crosshair",
  zIndex: 4,
};

const graphNodeInputHandleStyle = (active: boolean): CSSProperties => ({
  ...graphNodeHandleBaseStyle,
  left: "-8px",
  background: active ? "#22c55e" : "#64748b",
  boxShadow: active
    ? "0 0 0 3px color-mix(in srgb, #22c55e 24%, transparent)"
    : graphNodeHandleBaseStyle.boxShadow,
});

const graphNodeOutputHandleStyle = (active: boolean): CSSProperties => ({
  ...graphNodeHandleBaseStyle,
  right: "-8px",
  background: active ? "#22c55e" : "#38bdf8",
  boxShadow: active
    ? "0 0 0 3px color-mix(in srgb, #22c55e 24%, transparent)"
    : graphNodeHandleBaseStyle.boxShadow,
});

const graphEdgeRemoveButtonStyle: CSSProperties = {
  position: "absolute",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: "22px",
  height: "22px",
  padding: 0,
  border: "1px solid color-mix(in srgb, var(--destructive, #ef4444) 48%, var(--border, #334155))",
  borderRadius: "999px",
  background: "var(--background, #020617)",
  color: "var(--destructive, #ef4444)",
  fontSize: "16px",
  fontWeight: 800,
  lineHeight: 1,
  cursor: "pointer",
  zIndex: 6,
  boxShadow: "0 6px 18px rgba(0, 0, 0, 0.35)",
};

const graphPolicyBadgeStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  maxWidth: "100%",
  padding: "2px 5px",
  border: "1px solid color-mix(in srgb, var(--muted-foreground, #94a3b8) 32%, transparent)",
  borderRadius: "999px",
  color: "var(--muted-foreground, #94a3b8)",
  fontSize: "10px",
  fontWeight: 700,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const graphDiagnosticRowStyle: CSSProperties = {
  display: "grid",
  gap: "5px",
  padding: "8px",
  border: "1px solid var(--border, #334155)",
  borderRadius: "8px",
  background: "var(--card, #0f172a)",
};

const graphPaletteItems: Array<{ kind: WorkflowGraphPaletteNodeKind; label: string; description: string }> = [
  { kind: "agent", label: "Agent", description: "Papercompany assignee step" },
  { kind: "tool", label: "Tool", description: "System tool execution" },
  { kind: "branch", label: "Branch", description: "Conditional flow container" },
  { kind: "loop", label: "Loop", description: "For-each container" },
  { kind: "approval", label: "Approval", description: "Suspend until approved" },
  { kind: "failure-handler", label: "Failure", description: "Failure edge handler" },
];

type GraphContextMenuState = {
  kind: "canvas" | "node" | "edge";
  clientX: number;
  clientY: number;
  stepId?: string;
  edgeId?: string;
  sourceId?: string;
  targetId?: string;
};

type GraphNodeDragState = {
  stepId: string;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
  moved: boolean;
};

type GraphCanvasPanState = {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startPanX: number;
  startPanY: number;
};

type GraphEdgeActionAnchor = {
  edge: WorkflowGraphEdge;
  x: number;
  y: number;
};

function graphIssueBadgeStyle(severity: WorkflowGraphIssueSeverity): CSSProperties {
  const color = severity === "error"
    ? "#ef4444"
    : severity === "warning"
      ? "#f59e0b"
      : "#38bdf8";
  return {
    display: "inline-flex",
    alignItems: "center",
    width: "fit-content",
    padding: "2px 6px",
    borderRadius: "999px",
    background: `color-mix(in srgb, ${color} 18%, transparent)`,
    color,
    fontSize: "10px",
    fontWeight: 700,
    textTransform: "uppercase",
  };
}

function containerColor(type: WorkflowGraphContainerType): string {
  return type === "loop" ? "#f59e0b" : "#8b5cf6";
}

function graphEdgeColor(kind: WorkflowGraphEdgeKind): string {
  if (kind === "conditional") return "#38bdf8";
  if (kind === "failure") return "#f87171";
  if (kind === "early-stop") return "#fbbf24";
  return "var(--muted-foreground, #94a3b8)";
}

function graphEdgeDashArray(kind: WorkflowGraphEdgeKind): string | undefined {
  if (kind === "conditional") return "6 4";
  if (kind === "failure") return "3 4";
  if (kind === "early-stop") return "8 3 2 3";
  return undefined;
}

function graphEdgeDisplayLabel(edge: WorkflowGraphEdge): string {
  if (edge.label.trim()) return edge.label.trim();
  if (edge.kind !== "normal") return edge.kind;
  return edge.condition.trim();
}

function graphEdgeMetadataFor(step: StepDraft | null, sourceId: string): { kind: WorkflowGraphEdgeKind; label: string; condition: string } {
  const metadata = step?.graphEdgeMetadata?.[sourceId];
  return {
    kind: normalizeGraphEdgeKind(metadata?.kind),
    label: typeof metadata?.label === "string" ? metadata.label : "",
    condition: typeof metadata?.condition === "string" ? metadata.condition : "",
  };
}

function GraphModeTabs({
  mode,
  onChange,
}: {
  mode: StepEditorMode;
  onChange: (mode: StepEditorMode) => void;
}): JSX.Element {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
      {(["graph", "form", "json"] as const).map((entry) => (
        <button
          key={entry}
          type="button"
          style={filterTabStyle(mode === entry)}
          onClick={() => onChange(entry)}
        >
          {entry === "graph" ? "Graph" : entry === "form" ? "Form" : "JSON"}
        </button>
      ))}
    </div>
  );
}

function WorkflowGraphTestDrawer({
  summary,
  steps,
  interfaceInput,
  onClose,
}: {
  summary: WorkflowGraphTestDrawerSummary;
  steps: StepDraft[];
  interfaceInput?: WorkflowGraphInterfaceInput;
  onClose: () => void;
}): JSX.Element {
  return (
    <div key="workflow-graph-test-drawer" style={workflowGraphTestDrawerStyle(summary.tone)}>
      <div key="header" style={{ display: "flex", alignItems: "start", justifyContent: "space-between", gap: "8px", minWidth: 0 }}>
        <div style={{ display: "grid", gap: "4px", minWidth: 0 }}>
          <span style={{ ...mutedTextStyle, fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 800 }}>
            Test drawer
          </span>
          <strong style={{ fontSize: "13px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{summary.title}</strong>
          <span style={{ ...mutedTextStyle, fontSize: "11px", lineHeight: 1.35, overflowWrap: "anywhere" }}>{summary.summary}</span>
        </div>
        <button type="button" style={{ ...buttonStyle, padding: "4px 8px", fontSize: "11px" }} onClick={onClose}>
          Close
        </button>
      </div>
      <div key="badges" style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
        {summary.badges.slice(0, 5).map((badge) => (
          <span key={badge} style={graphPolicyBadgeStyle}>{badge}</span>
        ))}
      </div>
      <div key="modes" style={{ display: "grid", gap: "6px" }}>
        {summary.modes.map((mode) => (
          <div key={mode.id} style={workflowGraphTestDrawerModeStyle(mode.tone)}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "6px", minWidth: 0 }}>
              <strong style={{ fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{mode.title}</strong>
              <span style={{ ...graphPolicyBadgeStyle, color: workflowGraphFocusLensToneColor(mode.tone) }}>{mode.badges[0] ?? mode.tone}</span>
            </div>
            <span style={{ ...mutedTextStyle, fontSize: "11px", lineHeight: 1.35, overflowWrap: "anywhere" }}>{mode.summary}</span>
          </div>
        ))}
      </div>
      <details key="detailed-controls" open style={{ display: "grid", gap: "8px" }}>
        <summary style={{ cursor: "pointer", color: "var(--muted-foreground, #94a3b8)", fontSize: "11px", fontWeight: 750 }}>
          Execution controls
        </summary>
        <WorkflowTestPlanPreview steps={steps} interfaceInput={interfaceInput} />
      </details>
    </div>
  );
}

function GraphZoomIcon({ direction }: { direction: "in" | "out" }): JSX.Element {
  return (
    <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="m16.5 16.5 4 4" />
      <path d="M8 11h6" />
      {direction === "in" ? <path d="M11 8v6" /> : null}
    </svg>
  );
}

function WorkflowGraphStructurePalette({
  summary,
  onAction,
}: {
  summary: WorkflowGraphStructurePaletteSummary;
  onAction: (actionId: WorkflowGraphStructurePaletteActionId) => void;
}): JSX.Element {
  const visibleTransformActions = summary.transformActions.filter((action) => action.id !== "route-failure");
  const renderAction = (action: WorkflowGraphStructurePaletteSummary["addActions"][number]): JSX.Element => (
    <button
      key={action.id}
      type="button"
      style={workflowGraphStructureActionStyle(action.tone, action.disabled)}
      disabled={action.disabled}
      onClick={() => onAction(action.id)}
      title={action.description}
    >
      <strong key="label" style={{ fontSize: "12px", color: "var(--foreground, #f8fafc)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {action.label}
      </strong>
      <span key="description" style={{ color: "var(--muted-foreground, #94a3b8)", fontSize: "10px", lineHeight: 1.25, overflowWrap: "anywhere" }}>
        {action.description}
      </span>
    </button>
  );

  return (
    <div key="workflow-graph-structure-palette" style={workflowGraphStructurePaletteStyle(summary.tone)}>
      <div key="header" style={{ display: "flex", alignItems: "start", justifyContent: "space-between", gap: "8px", minWidth: 0 }}>
        <div style={{ display: "grid", gap: "4px", minWidth: 0 }}>
          <span style={{ ...mutedTextStyle, fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 800 }}>
            Structure palette
          </span>
          <strong style={{ fontSize: "13px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{summary.title}</strong>
          <span style={{ ...mutedTextStyle, fontSize: "11px", lineHeight: 1.35, overflowWrap: "anywhere" }}>{summary.summary}</span>
        </div>
        <span style={{ ...graphPolicyBadgeStyle, color: workflowGraphFocusLensToneColor(summary.tone) }}>
          {summary.selectedStepId || "start"}
        </span>
      </div>
      <div key="badges" style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
        {summary.badges.slice(0, 5).map((badge) => (
          <span key={badge} style={graphPolicyBadgeStyle}>{badge}</span>
        ))}
      </div>
      <div key="add-actions" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "6px" }}>
        {summary.addActions.map(renderAction)}
      </div>
      {visibleTransformActions.length > 0 ? (
      <div key="transform-actions" style={{ display: "grid", gap: "6px", paddingTop: "7px", borderTop: "1px solid var(--border, #334155)" }}>
        <span style={{ ...mutedTextStyle, fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 800 }}>
          Path transforms
        </span>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "6px" }}>
          {visibleTransformActions.map(renderAction)}
        </div>
      </div>
      ) : (
        <Fragment key="transform-actions-placeholder" />
      )}
    </div>
  );
}

function WorkflowGraphExecutionEvidenceDrawer({
  summary,
  onClose,
}: {
  summary: WorkflowGraphExecutionEvidenceSummary;
  onClose: () => void;
}): JSX.Element {
  return (
    <div key="workflow-graph-execution-evidence" style={workflowGraphTestDrawerStyle(summary.tone)}>
      <div key="header" style={{ display: "flex", alignItems: "start", justifyContent: "space-between", gap: "8px", minWidth: 0 }}>
        <div style={{ display: "grid", gap: "4px", minWidth: 0 }}>
          <span style={{ ...mutedTextStyle, fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 800 }}>
            Execution evidence
          </span>
          <strong style={{ fontSize: "13px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{summary.title}</strong>
          <span style={{ ...mutedTextStyle, fontSize: "11px", lineHeight: 1.35, overflowWrap: "anywhere" }}>{summary.summary}</span>
        </div>
        <button type="button" style={{ ...buttonStyle, padding: "4px 8px", fontSize: "11px" }} onClick={onClose}>
          Close
        </button>
      </div>
      <div key="badges" style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
        {summary.badges.slice(0, 6).map((badge) => (
          <span key={badge} style={graphPolicyBadgeStyle}>{badge}</span>
        ))}
      </div>
      <div key="metrics" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "6px" }}>
        {summary.metrics.map((metric) => (
          <div key={metric.id} style={workflowGraphFocusLensMetricStyle(metric.tone)} title={metric.detail}>
            <span style={{ ...mutedTextStyle, fontSize: "10px", textTransform: "uppercase", fontWeight: 800 }}>{metric.label}</span>
            <strong style={{ fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{metric.value}</strong>
          </div>
        ))}
      </div>
      <div key="outputs" style={{ display: "grid", gap: "6px", paddingTop: "7px", borderTop: "1px solid var(--border, #334155)" }}>
        <span style={{ ...mutedTextStyle, fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 800 }}>
          Work products
        </span>
        {summary.workProducts.length > 0 ? (
          <div style={{ display: "grid", gap: "6px" }}>
            {summary.workProducts.slice(0, 4).map((product) => (
              <div key={product.id} style={workflowGraphTestDrawerModeStyle(product.isPrimary ? "success" : "neutral")}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "6px", minWidth: 0 }}>
                  {product.url ? (
                    <a href={product.url} target="_blank" rel="noreferrer" style={{ color: "var(--link, #60a5fa)", fontSize: "12px", fontWeight: 700, textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {product.title}
                    </a>
                  ) : (
                    <strong style={{ fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{product.title}</strong>
                  )}
                  {product.isPrimary ? <span style={graphPolicyBadgeStyle}>Primary</span> : null}
                </div>
                <span style={{ ...mutedTextStyle, fontSize: "11px", lineHeight: 1.35, overflowWrap: "anywhere" }}>
                  {product.summary || product.type || product.status || "Registered work product"}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <span style={{ ...mutedTextStyle, fontSize: "11px" }}>No registered outputs for this step.</span>
        )}
      </div>
      {summary.resultPreview || summary.logPreview ? (
        <div key="previews" style={{ display: "grid", gap: "7px", paddingTop: "7px", borderTop: "1px solid var(--border, #334155)" }}>
          {summary.resultPreview ? (
            <div key="result" style={{ display: "grid", gap: "4px" }}>
              <span style={{ ...mutedTextStyle, fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 800 }}>Result preview</span>
              <pre style={{ margin: 0, maxHeight: "120px", overflow: "auto", padding: "8px", border: "1px solid var(--border, #334155)", borderRadius: "7px", background: "var(--card, #0f172a)", color: "var(--foreground, #f8fafc)", fontSize: "11px", lineHeight: 1.35, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {summary.resultPreview}
              </pre>
            </div>
          ) : null}
          {summary.logPreview ? (
            <div key="log" style={{ display: "grid", gap: "4px" }}>
              <span style={{ ...mutedTextStyle, fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 800 }}>Log preview</span>
              <pre style={{ margin: 0, maxHeight: "120px", overflow: "auto", padding: "8px", border: "1px solid var(--border, #334155)", borderRadius: "7px", background: "var(--card, #0f172a)", color: "var(--muted-foreground, #94a3b8)", fontSize: "11px", lineHeight: 1.35, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {summary.logPreview}
              </pre>
            </div>
          ) : null}
        </div>
      ) : (
        <Fragment key="previews-placeholder" />
      )}
    </div>
  );
}

function WorkflowGraphEditor({
  steps,
  runOverlaySteps,
  onChange,
  triggerSummary,
  testInterfaceInput,
  availableTools,
  availableToolGrants,
  surface = "stacked",
}: {
  steps: StepDraft[];
  runOverlaySteps?: StepDraft[];
  onChange: (steps: StepDraft[]) => void;
  triggerSummary?: WorkflowGraphTriggerSummary;
  testInterfaceInput?: WorkflowGraphInterfaceInput;
  availableTools: WorkflowToolOption[];
  availableToolGrants: WorkflowToolGrant[];
  surface?: "stacked" | "focus";
}): JSX.Element {
  const [selectedStepId, setSelectedStepId] = useState<string | null>(steps[0]?.id ?? null);
  const [selectedPathStepIds, setSelectedPathStepIds] = useState<string[]>(() => steps[0]?.id ? [steps[0].id] : []);
  const [failureHandlerStepId, setFailureHandlerStepId] = useState<string>("");
  const [graphError, setGraphError] = useState<string>("");
  const [graphInspectorMode, setGraphInspectorMode] = useState<WorkflowGraphInspectorMode>("edit");
  const [showGraphDetails, setShowGraphDetails] = useState<boolean>(false);
  const [showGraphTestDrawer, setShowGraphTestDrawer] = useState<boolean>(false);
  const [showGraphEvidenceDrawer, setShowGraphEvidenceDrawer] = useState<boolean>(false);
  const [canvasScale, setCanvasScale] = useState<number>(1);
  const [graphContextMenu, setGraphContextMenu] = useState<GraphContextMenuState | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [connectingFromStepId, setConnectingFromStepId] = useState<string | null>(null);
  const [draggingStepId, setDraggingStepId] = useState<string | null>(null);
  const [isCanvasPanning, setIsCanvasPanning] = useState<boolean>(false);
  const [canvasPanX, setCanvasPanX] = useState<number>(0);
  const [canvasPanY, setCanvasPanY] = useState<number>(0);
  const graphCanvasRef = React.useRef<HTMLDivElement | null>(null);
  const graphNodeDragRef = React.useRef<GraphNodeDragState | null>(null);
  const graphCanvasPanRef = React.useRef<GraphCanvasPanState | null>(null);
  const suppressNodeClickRef = React.useRef<string | null>(null);
  const displaySteps = useMemo(() => {
    if (!runOverlaySteps) return steps;
    const positionsById = new Map(steps.map((step) => [step.id, {
      graphPositionX: step.graphPositionX,
      graphPositionY: step.graphPositionY,
    }]));
    return runOverlaySteps.map((step) => {
      const position = positionsById.get(step.id);
      return position ? { ...step, ...position } : step;
    });
  }, [runOverlaySteps, steps]);
  const graph = useMemo(() => buildWorkflowGraphModel(displaySteps), [displaySteps]);
  const matchingNodeIds = useMemo(() => new Set<string>(), []);
  const selectedStep = steps.find((step) => step.id === selectedStepId) ?? steps[0] ?? null;
  const selectedGraphNode = selectedStep ? graph.nodes.find((node) => node.step.id === selectedStep.id) ?? null : null;
  const selectedGraphContext = selectedStep ? getWorkflowGraphStepContext(steps, selectedStep.id) : null;
  const selectedDataFlowMap = useMemo<WorkflowGraphDataFlowMap | null>(
    () => selectedStep ? buildWorkflowGraphDataFlowMap(steps, selectedStep.id) : null,
    [selectedStep, steps],
  );
  const selectedPathSummary = useMemo<WorkflowGraphSelectionSummary>(
    () => buildWorkflowGraphSelectionSummary(steps, selectedPathStepIds),
    [steps, selectedPathStepIds],
  );
  const selectedPathFailureHandlerId = failureHandlerStepId || selectedPathSummary.outboundStepIds[0] || "";
  const selectedPathFailureRouteSummary = useMemo<WorkflowGraphFailureRouteSummary>(
    () => buildWorkflowGraphFailureRouteSummary(steps, selectedPathSummary.stepIds, selectedPathFailureHandlerId, {
      label: "Selected path failure",
      condition: "upstream step failed",
    }),
    [steps, selectedPathSummary.stepIds, selectedPathFailureHandlerId],
  );
  const selectedPathNodeIds = useMemo(
    () => new Set(selectedPathSummary.stepIds),
    [selectedPathSummary],
  );
  const selectedContainerSummary = useMemo<WorkflowGraphContainerSummary | null>(
    () => {
      const containerId = selectedStep?.graphContainerId.trim() ?? "";
      return containerId ? buildWorkflowGraphContainerSummary(steps, containerId) : null;
    },
    [selectedStep, steps],
  );
  const selectedGroup = selectedStep?.graphGroupId.trim()
    ? graph.groups.find((group) => group.id === selectedStep.graphGroupId.trim()) ?? null
    : null;
  const diagnostics = graph.diagnostics;
  const repairPlan = useMemo<WorkflowGraphRepairPlan>(
    () => buildWorkflowGraphRepairPlan(steps),
    [steps],
  );
  const inspectorSummary = useMemo<WorkflowGraphInspectorSummary>(
    () => buildWorkflowGraphInspectorSummary(steps, selectedStep?.id ?? "", selectedPathStepIds),
    [selectedPathStepIds, selectedStep, steps],
  );
  const testDrawerSummary = useMemo<WorkflowGraphTestDrawerSummary>(
    () => buildWorkflowGraphTestDrawerSummary(steps, selectedStep?.id ?? "", testInterfaceInput),
    [selectedStep, steps, testInterfaceInput],
  );
  const evidenceSummary = useMemo<WorkflowGraphExecutionEvidenceSummary>(
    () => buildWorkflowGraphExecutionEvidenceSummary(displaySteps, selectedStep?.id ?? ""),
    [displaySteps, selectedStep],
  );
  const workbenchSummary = useMemo<WorkflowGraphWorkbenchSummary>(
    () => buildWorkflowGraphWorkbenchSummary(steps, selectedStep?.id ?? "", selectedPathStepIds),
    [selectedPathStepIds, selectedStep, steps],
  );
  const activeInspectorSection = inspectorSummary.sections.find((section) => section.mode === graphInspectorMode) ?? inspectorSummary.sections[0];
  const showOverviewInspector = false;
  const showEditInspector = graphInspectorMode === "edit";
  const showPolicyInspector = graphInspectorMode === "policy";
  const showRawInspector = graphInspectorMode === "raw";
  const inspectorAccent = graphInspectorMode === "overview"
    ? "#22c55e"
    : graphInspectorMode === "edit"
      ? "#38bdf8"
      : graphInspectorMode === "policy"
        ? "#a78bfa"
        : "#fbbf24";
  const graphTriggerSummary = triggerSummary ?? summarizeWorkflowGraphTriggers({});
  const selectedRawStepJson = useMemo(
    () => selectedStep ? JSON.stringify(stepsToJson([selectedStep])[0], null, 2) : "",
    [selectedStep],
  );
  const canvasWidth = Math.max(620, ...graph.nodes.map((node) => node.x + 230), 620);
  const canvasHeight = Math.max(360, ...graph.nodes.map((node) => node.y + 132), 360);
  const selectedEdgeActionAnchor = useMemo<GraphEdgeActionAnchor | null>(() => {
    if (!selectedEdgeId) return null;
    const edge = graph.edges.find((candidate) => candidate.id === selectedEdgeId);
    if (!edge) return null;
    const source = graph.nodes.find((node) => node.id === edge.source);
    const target = graph.nodes.find((node) => node.id === edge.target);
    if (!source || !target) return null;
    const startX = source.x + 172;
    const startY = source.y + 38;
    const endX = target.x;
    const endY = target.y + 38;
    const midX = startX + Math.max(34, (endX - startX) / 2);
    return { edge, x: midX, y: (startY + endY) / 2 };
  }, [graph.edges, graph.nodes, selectedEdgeId]);

  useEffect(() => {
    const container = graphCanvasRef.current;
    if (!container) return undefined;
    const handleWheel = (event: WheelEvent): void => {
      event.preventDefault();
      closeGraphContextMenu();
      const direction = event.deltaY > 0 ? -1 : 1;
      setCanvasScaleFromPoint(canvasScale + direction * 0.1, event.clientX, event.clientY);
    };
    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, [canvasScale]);

  function updateSelected(patch: Partial<StepDraft>): void {
    if (!selectedStep) return;
    onChange(steps.map((step) => (step.id === selectedStep.id ? { ...step, ...patch } : step)));
  }

  function updateStepGraphPosition(stepId: string, x: number, y: number): void {
    onChange(steps.map((step) => (step.id === stepId ? {
      ...step,
      graphPositionX: Math.round(x),
      graphPositionY: Math.round(y),
    } : step)));
  }

  function setCanvasScaleFromPoint(nextScale: number, clientX?: number, clientY?: number): void {
    const container = graphCanvasRef.current;
    const normalizedScale = clampGraphCanvasScale(nextScale);
    if (!container || clientX === undefined || clientY === undefined) {
      setCanvasScale(normalizedScale);
      return;
    }
    const rect = container.getBoundingClientRect();
    const offsetX = clientX - rect.left;
    const offsetY = clientY - rect.top;
    const graphX = (-canvasPanX + offsetX) / canvasScale;
    const graphY = (-canvasPanY + offsetY) / canvasScale;
    setCanvasScale(normalizedScale);
    setCanvasPanX(offsetX - graphX * normalizedScale);
    setCanvasPanY(offsetY - graphY * normalizedScale);
  }

  function renameSelectedStep(nextStepId: string): void {
    if (!selectedStep) return;
    try {
      setGraphError("");
      const next = renameWorkflowStep(steps, selectedStep.id, nextStepId);
      onChange(next);
      const trimmed = nextStepId.trim();
      if (trimmed) setSelectedStepId(trimmed);
    } catch (error) {
      setGraphError(error instanceof Error ? error.message : String(error));
    }
  }

  function selectStep(stepId: string): void {
    setSelectedStepId(stepId);
    setSelectedEdgeId(null);
    setSelectedPathStepIds(stepId.trim() ? [stepId] : []);
    setFailureHandlerStepId("");
    setGraphError("");
  }

  function expandSelectedPath(mode: WorkflowGraphSelectionMode): void {
    if (!selectedStep) return;
    setSelectedPathStepIds(expandWorkflowGraphSelection(steps, [selectedStep.id], mode));
    setGraphError("");
  }

  function clearSelectedPath(): void {
    setSelectedPathStepIds(selectedStep?.id ? [selectedStep.id] : []);
    setFailureHandlerStepId("");
    setGraphError("");
  }

  function connect(sourceId: string, targetId: string): void {
    try {
      setGraphError("");
      setSelectedEdgeId(null);
      onChange(connectSteps(steps, sourceId, targetId));
    } catch (error) {
      setGraphError(error instanceof Error ? error.message : String(error));
    }
  }

  function disconnect(sourceId: string, targetId: string): void {
    setGraphError("");
    setSelectedEdgeId((edgeId) => edgeId === `${sourceId}->${targetId}` ? null : edgeId);
    onChange(disconnectSteps(steps, sourceId, targetId));
  }

  function updateEdge(sourceId: string, patch: { kind?: string; label?: string; condition?: string }): void {
    if (!selectedStep) return;
    setGraphError("");
    onChange(updateGraphEdgeMetadata(steps, sourceId, selectedStep.id, patch));
  }

  function addAfter(stepId: string | null): void {
    const next = appendStepAfter(steps, stepId);
    onChange(next);
    const insertedIndex = stepId ? steps.findIndex((step) => step.id === stepId) + 1 : next.length - 1;
    setSelectedStepId(next[Math.max(0, insertedIndex)]?.id ?? null);
  }

  function insertPaletteNode(kind: WorkflowGraphPaletteNodeKind): void {
    const beforeIds = new Set(steps.map((step) => step.id));
    const next = insertWorkflowStepFromPalette(steps, selectedStep?.id ?? null, kind);
    onChange(next);
    const insertedStep = next.find((step) => !beforeIds.has(step.id));
    setSelectedStepId(insertedStep?.id ?? selectedStep?.id ?? next[0]?.id ?? null);
    setGraphError("");
  }

  function centerSelectedGraphStep(): void {
    if (!selectedGraphNode || !graphCanvasRef.current) return;
    const container = graphCanvasRef.current;
    const nodeCenterX = (selectedGraphNode.x + 86) * canvasScale;
    const nodeCenterY = (selectedGraphNode.y + 38) * canvasScale;
    setCanvasPanX(container.clientWidth / 2 - nodeCenterX);
    setCanvasPanY(container.clientHeight / 2 - nodeCenterY);
  }

  function centerGraphStep(stepId: string): void {
    const node = graph.nodes.find((candidate) => candidate.step.id === stepId);
    if (!node || !graphCanvasRef.current) return;
    const container = graphCanvasRef.current;
    const nodeCenterX = (node.x + 86) * canvasScale;
    const nodeCenterY = (node.y + 38) * canvasScale;
    setCanvasPanX(container.clientWidth / 2 - nodeCenterX);
    setCanvasPanY(container.clientHeight / 2 - nodeCenterY);
  }

  function runWorkbenchAction(actionId: string): void {
    if (actionId === "fit-canvas") {
      setCanvasScaleFromPoint(0.86);
      return;
    }
    if (actionId === "actual-size") {
      setCanvasScaleFromPoint(1);
      return;
    }
    if (actionId === "center-selected") {
      centerSelectedGraphStep();
      return;
    }
    if (actionId === "diagnostics") {
      setGraphInspectorMode("edit");
      setShowGraphDetails(true);
      return;
    }
    if (actionId === "agent" || actionId === "tool" || actionId === "branch" || actionId === "loop" || actionId === "approval" || actionId === "failure-handler") {
      insertPaletteNode(actionId);
      return;
    }
    if (actionId === "upstream" || actionId === "downstream" || actionId === "connected") {
      expandSelectedPath(actionId);
      return;
    }
    if (actionId === "group") {
      groupSelectedGraphSelection();
      return;
    }
    if (actionId === "branch-wrap") {
      wrapSelectedGraphSelection("branch");
      return;
    }
    if (actionId === "loop-wrap") {
      wrapSelectedGraphSelection("loop");
      return;
    }
    if (actionId === "route-failure") {
      routeSelectedPathFailures();
    }
  }

  function duplicateStep(stepId: string): void {
    const next = duplicateWorkflowStep(steps, stepId);
    onChange(next);
    const insertedIndex = steps.findIndex((step) => step.id === stepId) + 1;
    setSelectedStepId(next[Math.max(0, insertedIndex)]?.id ?? stepId);
  }

  function duplicateSelectedStep(): void {
    if (!selectedStep) return;
    duplicateStep(selectedStep.id);
  }

  function duplicateSelectedContainer(): void {
    if (!selectedContainerSummary) return;
    const beforeIds = new Set(steps.map((step) => step.id));
    const next = duplicateWorkflowContainer(steps, selectedContainerSummary.id);
    onChange(next);
    const copiedStep = next.find((step) => !beforeIds.has(step.id));
    setSelectedStepId(copiedStep?.id ?? selectedStep?.id ?? next[0]?.id ?? null);
  }

  function deleteStep(stepId: string): void {
    const selectedIndex = steps.findIndex((step) => step.id === stepId);
    const next = removeWorkflowStep(steps, stepId);
    onChange(next);
    setSelectedStepId(next[Math.min(Math.max(selectedIndex, 0), Math.max(next.length - 1, 0))]?.id ?? null);
  }

  function deleteSelectedStep(): void {
    if (!selectedStep) return;
    deleteStep(selectedStep.id);
  }

  function closeGraphContextMenu(): void {
    setGraphContextMenu(null);
  }

  function handleCanvasClick(): void {
    closeGraphContextMenu();
    setSelectedEdgeId(null);
    setConnectingFromStepId(null);
  }

  function handleCanvasContextMenu(event: React.MouseEvent<HTMLDivElement>): void {
    const target = event.target as HTMLElement;
    if (target.closest("[data-graph-node='true'], [data-graph-toolbar='true'], [data-graph-menu='true'], [data-graph-edge='true'], [data-graph-handle='true'], [data-graph-edge-remove='true']")) return;
    event.preventDefault();
    setGraphContextMenu({ kind: "canvas", clientX: event.clientX, clientY: event.clientY });
  }

  function handleNodeContextMenu(event: React.MouseEvent<HTMLElement>, stepId: string): void {
    event.preventDefault();
    event.stopPropagation();
    selectStep(stepId);
    setGraphContextMenu({ kind: "node", stepId, clientX: event.clientX, clientY: event.clientY });
  }

  function handleEdgeClick(event: React.MouseEvent<Element>, edge: WorkflowGraphEdge): void {
    event.preventDefault();
    event.stopPropagation();
    closeGraphContextMenu();
    setConnectingFromStepId(null);
    setSelectedEdgeId(edge.id);
    setGraphError("");
  }

  function handleEdgeContextMenu(event: React.MouseEvent<Element>, edge: WorkflowGraphEdge): void {
    event.preventDefault();
    event.stopPropagation();
    setConnectingFromStepId(null);
    setSelectedEdgeId(edge.id);
    setGraphContextMenu({
      kind: "edge",
      edgeId: edge.id,
      sourceId: edge.source,
      targetId: edge.target,
      clientX: event.clientX,
      clientY: event.clientY,
    });
  }

  function connectPendingEdgeTo(targetId: string): void {
    const sourceId = connectingFromStepId;
    if (!sourceId) return;
    setConnectingFromStepId(null);
    if (sourceId === targetId) {
      setGraphError("Cannot connect a step to itself.");
      return;
    }
    connect(sourceId, targetId);
  }

  function beginEdgeConnection(event: React.PointerEvent<HTMLElement>, sourceId: string): void {
    event.preventDefault();
    event.stopPropagation();
    closeGraphContextMenu();
    setSelectedEdgeId(null);
    setConnectingFromStepId(sourceId);
    setGraphError("");
  }

  function completeEdgeConnection(event: React.PointerEvent<HTMLElement> | React.MouseEvent<HTMLElement>, targetId: string): void {
    event.preventDefault();
    event.stopPropagation();
    connectPendingEdgeTo(targetId);
  }

  function beginCanvasPan(event: React.PointerEvent<HTMLDivElement>): void {
    const target = event.target as HTMLElement;
    if (target.closest("[data-graph-node='true'], [data-graph-toolbar='true'], [data-graph-menu='true'], [data-graph-edge='true'], [data-graph-handle='true'], [data-graph-edge-remove='true']")) return;
    if (event.button !== 0 && event.button !== 1) return;
    closeGraphContextMenu();
    graphCanvasPanRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPanX: canvasPanX,
      startPanY: canvasPanY,
    };
    setIsCanvasPanning(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleCanvasPointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    const pan = graphCanvasPanRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    setCanvasPanX(pan.startPanX + (event.clientX - pan.startClientX));
    setCanvasPanY(pan.startPanY + (event.clientY - pan.startClientY));
  }

  function endCanvasPan(event: React.PointerEvent<HTMLDivElement>): void {
    const pan = graphCanvasPanRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    graphCanvasPanRef.current = null;
    setIsCanvasPanning(false);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released by the browser.
    }
  }

  function beginNodeDrag(event: React.PointerEvent<HTMLButtonElement>, stepId: string, x: number, y: number): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    closeGraphContextMenu();
    selectStep(stepId);
    graphNodeDragRef.current = {
      stepId,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: x,
      startY: y,
      moved: false,
    };
    setDraggingStepId(stepId);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleNodePointerMove(event: React.PointerEvent<HTMLButtonElement>): void {
    const drag = graphNodeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = (event.clientX - drag.startClientX) / canvasScale;
    const deltaY = (event.clientY - drag.startClientY) / canvasScale;
    if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) drag.moved = true;
    updateStepGraphPosition(drag.stepId, drag.startX + deltaX, drag.startY + deltaY);
  }

  function endNodeDrag(event: React.PointerEvent<HTMLButtonElement>): void {
    const drag = graphNodeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.moved) suppressNodeClickRef.current = drag.stepId;
    graphNodeDragRef.current = null;
    setDraggingStepId(null);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released by the browser.
    }
  }

  function handleNodeClick(event: React.MouseEvent<HTMLButtonElement>, stepId: string): void {
    if (suppressNodeClickRef.current === stepId) {
      suppressNodeClickRef.current = null;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    event.stopPropagation();
    selectStep(stepId);
  }

  function runNodeContextAction(actionId: string, stepId: string): void {
    closeGraphContextMenu();
    if (actionId === "add-downstream") {
      addAfter(stepId);
      return;
    }
    if (actionId === "duplicate") {
      duplicateStep(stepId);
      return;
    }
    if (actionId === "delete") {
      deleteStep(stepId);
      return;
    }
    if (actionId === "center") {
      centerGraphStep(stepId);
      return;
    }
    if (actionId === "select-upstream" || actionId === "select-downstream" || actionId === "select-connected") {
      const mode = actionId.replace("select-", "") as WorkflowGraphSelectionMode;
      setSelectedStepId(stepId);
      setSelectedPathStepIds(expandWorkflowGraphSelection(steps, [stepId], mode));
      return;
    }
    if (actionId === "connect-selected-to-this" && selectedStep && selectedStep.id !== stepId) {
      connect(selectedStep.id, stepId);
      return;
    }
    if (actionId === "connect-this-to-selected" && selectedStep && selectedStep.id !== stepId) {
      connect(stepId, selectedStep.id);
    }
  }

  function runCanvasContextAction(actionId: string): void {
    closeGraphContextMenu();
    if (actionId === "fit-canvas" || actionId === "actual-size" || actionId === "center-selected") {
      runWorkbenchAction(actionId);
      return;
    }
    if (actionId === "agent" || actionId === "tool" || actionId === "branch" || actionId === "loop" || actionId === "approval" || actionId === "failure-handler") {
      insertPaletteNode(actionId);
    }
  }

  function runEdgeContextAction(actionId: string, sourceId: string, targetId: string): void {
    closeGraphContextMenu();
    if (actionId === "remove-edge") {
      disconnect(sourceId, targetId);
      return;
    }
    if (actionId === "select-source") {
      selectStep(sourceId);
      return;
    }
    if (actionId === "select-target") {
      selectStep(targetId);
    }
  }

  function groupSelectedWithDependencies(): void {
    if (!selectedStep) return;
    const upstreamIds = parseDependencies(selectedStep.dependsOn);
    const stepIds = Array.from(new Set([...upstreamIds, selectedStep.id]));
    const groupId = selectedStep.graphGroupId.trim() || `${selectedStep.id}-group`;
    onChange(assignStepsToGroup(steps, stepIds, {
      id: groupId,
      title: selectedStep.graphGroupTitle.trim() || "Workflow group",
      color: selectedStep.graphGroupColor.trim() || "#64748b",
    }));
  }

  function clearSelectedGroup(): void {
    if (!selectedStep) return;
    onChange(clearStepsGroup(steps, [selectedStep.id]));
  }

  function setSelectedGroupCollapsed(collapsed: boolean): void {
    if (!selectedStep || !selectedStep.graphGroupId.trim()) return;
    onChange(setGraphGroupCollapsed(steps, selectedStep.graphGroupId, collapsed));
  }

  function updateSelectedGroupMetadata(patch: { title?: string; color?: string; collapsedByDefault?: boolean }): void {
    if (!selectedStep) return;
    const groupId = selectedStep.graphGroupId.trim();
    if (!groupId) {
      onChange(steps.map((step) => step.id === selectedStep.id ? {
        ...step,
        ...(patch.title !== undefined ? { graphGroupTitle: patch.title } : {}),
        ...(patch.color !== undefined ? { graphGroupColor: patch.color } : {}),
        ...(patch.collapsedByDefault !== undefined ? { graphGroupCollapsedByDefault: patch.collapsedByDefault } : {}),
      } : step));
      return;
    }
    onChange(updateGraphGroupMetadata(steps, groupId, patch));
  }

  function updateSelectedAdvanced(patch: Partial<Pick<StepDraft, "onFailure" | "maxRetries" | "graphRetryDelaySeconds" | "graphRetryBackoff" | "graphRetryJitter" | "timeoutSeconds" | "graphSleepSeconds" | "graphSuspendUntil" | "graphSuspendTimeoutSeconds" | "graphSuspendTimeoutAction" | "graphEarlyReturn" | "graphEarlyReturnContentType" | "graphEarlyReturnSchema" | "graphErrorHandler" | "graphErrorHandlerScope" | "graphErrorHandlerInput" | "graphRestartBoundary" | "graphRestartStrategy" | "graphRestartInput" | "graphEarlyStopCondition" | "graphEarlyStopLabelSkipped">>): void {
    if (!selectedStep) return;
    const nextDraft = { ...selectedStep, ...patch };
    onChange(updateStepAdvancedMetadata(steps, selectedStep.id, {
      ...(Object.hasOwn(patch, "onFailure") ? { onFailure: nextDraft.onFailure } : {}),
      ...(Object.hasOwn(patch, "maxRetries") ? { maxRetries: parseOptionalNonNegativeInteger(String(nextDraft.maxRetries ?? "")) } : {}),
      ...(Object.hasOwn(patch, "graphRetryDelaySeconds") ? { retryDelaySeconds: parseOptionalPositiveInteger(String(nextDraft.graphRetryDelaySeconds ?? "")) } : {}),
      ...(Object.hasOwn(patch, "graphRetryBackoff") ? { retryBackoff: nextDraft.graphRetryBackoff } : {}),
      ...(Object.hasOwn(patch, "graphRetryJitter") ? { retryJitter: nextDraft.graphRetryJitter } : {}),
      ...(Object.hasOwn(patch, "timeoutSeconds") ? { timeoutSeconds: parseOptionalPositiveInteger(String(nextDraft.timeoutSeconds ?? "")) } : {}),
      ...(Object.hasOwn(patch, "graphSleepSeconds") ? { sleepSeconds: parseOptionalPositiveInteger(String(nextDraft.graphSleepSeconds ?? "")) } : {}),
      ...(Object.hasOwn(patch, "graphSuspendUntil") ? { suspendUntil: nextDraft.graphSuspendUntil } : {}),
      ...(Object.hasOwn(patch, "graphSuspendTimeoutSeconds") ? { suspendTimeoutSeconds: parseOptionalPositiveInteger(String(nextDraft.graphSuspendTimeoutSeconds ?? "")) } : {}),
      ...(Object.hasOwn(patch, "graphSuspendTimeoutAction") ? { suspendTimeoutAction: nextDraft.graphSuspendTimeoutAction } : {}),
      ...(Object.hasOwn(patch, "graphEarlyReturn") ? { earlyReturn: nextDraft.graphEarlyReturn } : {}),
      ...(Object.hasOwn(patch, "graphEarlyReturnContentType") ? { earlyReturnContentType: nextDraft.graphEarlyReturnContentType } : {}),
      ...(Object.hasOwn(patch, "graphEarlyReturnSchema") ? { earlyReturnSchema: nextDraft.graphEarlyReturnSchema } : {}),
      ...(Object.hasOwn(patch, "graphErrorHandler") ? { errorHandler: nextDraft.graphErrorHandler } : {}),
      ...(Object.hasOwn(patch, "graphErrorHandlerScope") ? { errorHandlerScope: nextDraft.graphErrorHandlerScope } : {}),
      ...(Object.hasOwn(patch, "graphErrorHandlerInput") ? { errorHandlerInput: nextDraft.graphErrorHandlerInput } : {}),
      ...(Object.hasOwn(patch, "graphRestartBoundary") ? { restartBoundary: nextDraft.graphRestartBoundary } : {}),
      ...(Object.hasOwn(patch, "graphRestartStrategy") ? { restartStrategy: nextDraft.graphRestartStrategy } : {}),
      ...(Object.hasOwn(patch, "graphRestartInput") ? { restartInput: nextDraft.graphRestartInput } : {}),
      ...(Object.hasOwn(patch, "graphEarlyStopCondition") ? { earlyStopCondition: nextDraft.graphEarlyStopCondition } : {}),
      ...(Object.hasOwn(patch, "graphEarlyStopLabelSkipped") ? { earlyStopLabelSkipped: nextDraft.graphEarlyStopLabelSkipped } : {}),
    }));
  }

  function updateSelectedApproval(patch: Partial<Pick<StepDraft, "graphApprovalRequired" | "graphApprovalPrompt" | "graphApprovalRecipients" | "graphApprovalTimeoutSeconds" | "graphApprovalTimeoutAction">>): void {
    if (!selectedStep) return;
    const nextDraft = { ...selectedStep, ...patch };
    onChange(updateStepApprovalMetadata(steps, selectedStep.id, {
      ...(Object.hasOwn(patch, "graphApprovalRequired") ? { required: nextDraft.graphApprovalRequired } : {}),
      ...(Object.hasOwn(patch, "graphApprovalPrompt") ? { prompt: nextDraft.graphApprovalPrompt } : {}),
      ...(Object.hasOwn(patch, "graphApprovalRecipients") ? { recipients: nextDraft.graphApprovalRecipients } : {}),
      ...(Object.hasOwn(patch, "graphApprovalTimeoutSeconds") ? { timeoutSeconds: parseOptionalPositiveInteger(String(nextDraft.graphApprovalTimeoutSeconds ?? "")) } : {}),
      ...(Object.hasOwn(patch, "graphApprovalTimeoutAction") ? { timeoutAction: nextDraft.graphApprovalTimeoutAction } : {}),
    }));
  }

  function updateSelectedTesting(patch: Partial<Pick<StepDraft, "graphMockEnabled" | "graphMockResult" | "graphPinnedResultRunId">>): void {
    if (!selectedStep) return;
    const nextDraft = { ...selectedStep, ...patch };
    onChange(updateStepTestingMetadata(steps, selectedStep.id, {
      ...(Object.hasOwn(patch, "graphMockEnabled") ? { mockEnabled: nextDraft.graphMockEnabled } : {}),
      ...(Object.hasOwn(patch, "graphMockResult") ? { mockResult: nextDraft.graphMockResult } : {}),
      ...(Object.hasOwn(patch, "graphPinnedResultRunId") ? { pinnedResultRunId: nextDraft.graphPinnedResultRunId } : {}),
    }));
  }

  function updateSelectedExecution(patch: Partial<Pick<StepDraft, "graphConcurrencyKey" | "graphConcurrencyLimit" | "graphPriority" | "graphCacheEnabled" | "graphCacheTtlSeconds" | "graphDeleteAfterUse">>): void {
    if (!selectedStep) return;
    const nextDraft = { ...selectedStep, ...patch };
    onChange(updateStepExecutionMetadata(steps, selectedStep.id, {
      ...(Object.hasOwn(patch, "graphConcurrencyKey") ? { concurrencyKey: nextDraft.graphConcurrencyKey } : {}),
      ...(Object.hasOwn(patch, "graphConcurrencyLimit") ? { concurrencyLimit: parseOptionalPositiveInteger(String(nextDraft.graphConcurrencyLimit ?? "")) } : {}),
      ...(Object.hasOwn(patch, "graphPriority") ? { priority: nextDraft.graphPriority } : {}),
      ...(Object.hasOwn(patch, "graphCacheEnabled") ? { cacheEnabled: nextDraft.graphCacheEnabled } : {}),
      ...(Object.hasOwn(patch, "graphCacheTtlSeconds") ? { cacheTtlSeconds: parseOptionalPositiveInteger(String(nextDraft.graphCacheTtlSeconds ?? "")) } : {}),
      ...(Object.hasOwn(patch, "graphDeleteAfterUse") ? { deleteAfterUse: nextDraft.graphDeleteAfterUse } : {}),
    }));
  }

  function updateSelectedDataFlow(patch: Partial<Pick<StepDraft, "graphInputExpression" | "graphOutputSchema" | "graphWorkProductRequired" | "graphWorkProductPattern">>): void {
    if (!selectedStep) return;
    const nextDraft = { ...selectedStep, ...patch };
    onChange(updateStepDataFlowMetadata(steps, selectedStep.id, {
      ...(Object.hasOwn(patch, "graphInputExpression") ? { inputExpression: nextDraft.graphInputExpression } : {}),
      ...(Object.hasOwn(patch, "graphOutputSchema") ? { outputSchema: nextDraft.graphOutputSchema } : {}),
      ...(Object.hasOwn(patch, "graphWorkProductRequired") ? { workProductRequired: nextDraft.graphWorkProductRequired } : {}),
      ...(Object.hasOwn(patch, "graphWorkProductPattern") ? { workProductPattern: nextDraft.graphWorkProductPattern } : {}),
    }));
  }

  function updateSelectedResources(patch: Partial<Pick<StepDraft, "graphResourceRefs" | "graphSecretRefs">>): void {
    if (!selectedStep) return;
    const nextDraft = { ...selectedStep, ...patch };
    onChange(updateStepResourceMetadata(steps, selectedStep.id, {
      ...(Object.hasOwn(patch, "graphResourceRefs") ? { resourceRefs: nextDraft.graphResourceRefs } : {}),
      ...(Object.hasOwn(patch, "graphSecretRefs") ? { secretRefs: nextDraft.graphSecretRefs } : {}),
    }));
  }

  function setSelectedNote(note: string): void {
    if (!selectedStep) return;
    onChange(updateStepNote(steps, selectedStep.id, note));
  }

  function wrapSelectedPathInContainer(): void {
    if (!selectedStep) return;
    const downstreamIds = steps
      .filter((step) => parseDependencies(step.dependsOn).includes(selectedStep.id))
      .map((step) => step.id);
    const stepIds = Array.from(new Set([selectedStep.id, ...downstreamIds]));
    const containerId = selectedStep.graphContainerId.trim() || `${selectedStep.id}-${selectedStep.graphContainerType}`;
    onChange(assignStepsToContainer(steps, stepIds, {
      id: containerId,
      type: selectedStep.graphContainerType,
      title: selectedStep.graphContainerTitle.trim() || (selectedStep.graphContainerType === "loop" ? "Loop container" : "Branch container"),
      description: selectedStep.graphContainerDescription.trim(),
      mode: selectedStep.graphContainerMode,
      condition: selectedStep.graphContainerCondition,
      iterator: selectedStep.graphContainerIterator,
      skipFailure: selectedStep.graphContainerSkipFailure,
      runInParallel: selectedStep.graphContainerRunInParallel,
      parallelism: parseOptionalPositiveInteger(String(selectedStep.graphContainerParallelism ?? "")),
    }));
  }

  function wrapSelectedGraphSelection(containerType: WorkflowGraphContainerType): void {
    if (!selectedStep || selectedPathSummary.blocked || selectedPathSummary.stepIds.length === 0) return;
    const containerId = selectedStep.graphContainerId.trim() || `${selectedStep.id}-${containerType}`;
    onChange(assignStepsToContainer(steps, selectedPathSummary.stepIds, {
      id: containerId,
      type: containerType,
      title: selectedStep.graphContainerTitle.trim() || (containerType === "loop" ? "Loop selection" : "Branch selection"),
      description: selectedStep.graphContainerDescription.trim(),
      mode: containerType === "loop" ? "for-each" : "branch-one",
      condition: selectedStep.graphContainerCondition,
      iterator: selectedStep.graphContainerIterator,
      skipFailure: selectedStep.graphContainerSkipFailure,
      runInParallel: selectedStep.graphContainerRunInParallel,
      parallelism: parseOptionalPositiveInteger(String(selectedStep.graphContainerParallelism ?? "")),
    }));
  }

  function groupSelectedGraphSelection(): void {
    if (!selectedStep || selectedPathSummary.blocked || selectedPathSummary.stepIds.length === 0) return;
    const groupId = selectedStep.graphGroupId.trim() || `${selectedStep.id}-selection`;
    onChange(assignStepsToGroup(steps, selectedPathSummary.stepIds, {
      id: groupId,
      title: selectedStep.graphGroupTitle.trim() || "Selected path",
      color: selectedStep.graphGroupColor.trim() || "#22c55e",
    }));
  }

  function routeSelectedPathFailures(): void {
    if (selectedPathFailureRouteSummary.blocked) return;
    try {
      setGraphError("");
      onChange(applyWorkflowGraphFailureRoute(steps, selectedPathSummary.stepIds, selectedPathFailureRouteSummary.handlerStepId, {
        label: selectedPathFailureRouteSummary.label,
        condition: selectedPathFailureRouteSummary.condition,
        handlerScope: "selected-path",
        handlerInput: "{{ error }}",
      }));
      setSelectedStepId(selectedPathFailureRouteSummary.handlerStepId);
    } catch (error) {
      setGraphError(error instanceof Error ? error.message : String(error));
    }
  }

  function clearSelectedContainer(): void {
    const containerId = selectedContainerSummary?.id ?? selectedStep?.graphContainerId.trim() ?? "";
    if (!containerId) return;
    onChange(withStepDraftDefaults(clearWorkflowContainer(steps, containerId)));
  }

  function updateSelectedContainerMetadata(patch: Partial<Pick<StepDraft, "graphContainerType" | "graphContainerTitle" | "graphContainerDescription" | "graphContainerMode" | "graphContainerCondition" | "graphContainerIterator" | "graphContainerSkipFailure" | "graphContainerRunInParallel" | "graphContainerParallelism">>): void {
    if (!selectedStep) return;
    const groupId = selectedStep.graphContainerId.trim();
    const nextDraft = { ...selectedStep, ...patch };
    const parsedParallelism = parseOptionalPositiveInteger(String(nextDraft.graphContainerParallelism ?? ""));
    if (!groupId) {
      onChange(steps.map((step) => step.id === selectedStep.id ? { ...step, ...patch } : step));
      return;
    }
    onChange(updateContainerMetadata(steps, groupId, {
      ...(Object.hasOwn(patch, "graphContainerType") ? { type: nextDraft.graphContainerType } : {}),
      ...(Object.hasOwn(patch, "graphContainerTitle") ? { title: nextDraft.graphContainerTitle } : {}),
      ...(Object.hasOwn(patch, "graphContainerDescription") ? { description: nextDraft.graphContainerDescription } : {}),
      ...(Object.hasOwn(patch, "graphContainerMode") ? { mode: nextDraft.graphContainerMode } : {}),
      ...(Object.hasOwn(patch, "graphContainerCondition") ? { condition: nextDraft.graphContainerCondition } : {}),
      ...(Object.hasOwn(patch, "graphContainerIterator") ? { iterator: nextDraft.graphContainerIterator } : {}),
      ...(Object.hasOwn(patch, "graphContainerSkipFailure") ? { skipFailure: nextDraft.graphContainerSkipFailure } : {}),
      ...(Object.hasOwn(patch, "graphContainerRunInParallel") ? { runInParallel: nextDraft.graphContainerRunInParallel } : {}),
      ...(Object.hasOwn(patch, "graphContainerParallelism") ? { parallelism: parsedParallelism } : {}),
    }));
  }

  function renderDataFlowChips(values: string[], emptyLabel: string, tone: "normal" | "muted" | "error" = "normal"): JSX.Element {
    if (values.length === 0) {
      return <span style={{ ...mutedTextStyle, fontSize: "11px" }}>{emptyLabel}</span>;
    }
    const color = tone === "error" ? "var(--destructive, #ef4444)" : tone === "muted" ? "var(--muted-foreground, #94a3b8)" : "#14b8a6";
    return (
      <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
        {values.map((value) => (
          <span key={value} style={{ ...graphPolicyBadgeStyle, color }}>{value}</span>
        ))}
      </div>
    );
  }

  if (steps.length === 0) {
    return (
      <div style={formPanelStyle}>
        <p key="empty-message" style={mutedTextStyle}>No steps yet. Start with an entry node.</p>
        <div key="empty-actions" style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
          <button key="add-entry" type="button" style={primaryButtonStyle} onClick={() => addAfter(null)}>
            Add Entry Step
          </button>
          <div key="starter-palette" style={{ display: "contents" }}>
            {graphPaletteItems.slice(0, 2).map((item) => (
              <button key={item.kind} type="button" style={buttonStyle} onClick={() => insertPaletteNode(item.kind)}>
                Start with {item.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={graphShellStyle}>
      {surface === "stacked" ? (
        <div
          key="graph-trigger-summary"
          style={{
            gridColumn: "1 / -1",
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) auto",
            gap: "10px",
            alignItems: "center",
            padding: "10px 12px",
            border: "1px solid var(--border, #334155)",
            borderRadius: "8px",
            background: "var(--background, #020617)",
          }}
        >
          <div key="trigger-copy" style={{ minWidth: 0 }}>
            <div key="trigger-title-row" style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <span key="title" style={{ fontSize: "12px", fontWeight: 800, color: "var(--foreground, #f8fafc)" }}>Flow triggers</span>
              <span key="status" style={{ ...statusBadgeStyle(graphTriggerSummary.status), fontSize: "10px" }}>{graphTriggerSummary.status}</span>
              {graphTriggerSummary.badges.map((badge) => (
                <span key={badge} style={graphPolicyBadgeStyle}>{badge}</span>
              ))}
            </div>
            <p key="description" style={{ margin: "5px 0 0", color: "var(--muted-foreground, #94a3b8)", fontSize: "12px", overflowWrap: "anywhere" }}>
              {graphTriggerSummary.description}
            </p>
            {graphTriggerSummary.schedule.error ? (
              <p key="error" style={{ margin: "5px 0 0", color: "var(--destructive, #ef4444)", fontSize: "12px", overflowWrap: "anywhere" }}>
                Last schedule error{graphTriggerSummary.schedule.errorAt ? ` (${formatDateTime(graphTriggerSummary.schedule.errorAt)})` : ""}: {graphTriggerSummary.schedule.error}
              </p>
            ) : (
              <Fragment key="error-placeholder" />
            )}
          </div>
          <div key="trigger-timing" style={{ display: "grid", gap: "2px", justifyItems: "end" }}>
            <span key="timezone" style={{ ...mutedTextStyle, fontSize: "11px" }}>
              {graphTriggerSummary.schedule.timezone || "Local timezone"}
            </span>
            <span key="last-run" style={{ fontSize: "12px", color: "var(--foreground, #f8fafc)", whiteSpace: "nowrap" }}>
              {graphTriggerSummary.schedule.lastRunAt ? `Last run ${formatDateTime(graphTriggerSummary.schedule.lastRunAt)}` : "No scheduled run yet"}
            </span>
          </div>
        </div>
      ) : (
        <Fragment key="graph-trigger-summary-placeholder" />
      )}
      <div key="graph-workbench-main" style={graphWorkbenchMainStyle}>
      <div
        key="graph-canvas"
        ref={graphCanvasRef}
        style={{ ...graphCanvasStyle, cursor: isCanvasPanning ? "grabbing" : "grab" }}
        onPointerDown={beginCanvasPan}
        onPointerMove={handleCanvasPointerMove}
        onPointerUp={endCanvasPan}
        onPointerCancel={endCanvasPan}
        onContextMenu={handleCanvasContextMenu}
        onClick={handleCanvasClick}
      >
        <div key="graph-canvas-edit-tools-layer" style={graphCanvasEditToolLayerStyle}>
          <div key="graph-canvas-edit-tools" data-graph-toolbar="true" style={graphCanvasEditToolDockStyle}>
            <div key="object-tools" aria-label="Object editing tools" style={graphCanvasToolGroupStyle}>
              <span style={graphCanvasToolLabelStyle}>Edit</span>
              <button type="button" style={graphCanvasToolButtonStyle} title="Add downstream step" aria-label="Add downstream step" onClick={() => addAfter(selectedStep?.id ?? null)}>
                +
              </button>
              <button
                type="button"
                style={selectedStep ? { ...graphCanvasToolButtonStyle, color: "var(--destructive, #ef4444)" } : { ...graphCanvasToolButtonStyle, ...buttonDisabledStyle }}
                title="Delete selected step"
                aria-label="Delete selected step"
                disabled={!selectedStep}
                onClick={deleteSelectedStep}
              >
                -
              </button>
            </div>
          </div>
        </div>
        {graphContextMenu ? (
          <div
            key="graph-context-menu"
            data-graph-menu="true"
            style={{ ...graphContextMenuStyle, left: graphContextMenu.clientX, top: graphContextMenu.clientY }}
            onClick={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            {graphContextMenu.kind === "node" && graphContextMenu.stepId ? (
              <Fragment key="node-menu">
                <button type="button" style={graphContextMenuButtonStyle} onClick={() => runNodeContextAction("add-downstream", graphContextMenu.stepId || "")}>Add downstream<span>+</span></button>
                <button type="button" style={graphContextMenuButtonStyle} onClick={() => runNodeContextAction("duplicate", graphContextMenu.stepId || "")}>Duplicate<span>2x</span></button>
                <button type="button" style={{ ...graphContextMenuButtonStyle, color: "var(--destructive, #ef4444)" }} onClick={() => runNodeContextAction("delete", graphContextMenu.stepId || "")}>Delete<span>Del</span></button>
                <button type="button" style={graphContextMenuButtonStyle} onClick={() => runNodeContextAction("center", graphContextMenu.stepId || "")}>Center<span>C</span></button>
                <button type="button" style={graphContextMenuButtonStyle} onClick={() => runNodeContextAction("select-upstream", graphContextMenu.stepId || "")}>Select upstream<span>U</span></button>
                <button type="button" style={graphContextMenuButtonStyle} onClick={() => runNodeContextAction("select-downstream", graphContextMenu.stepId || "")}>Select downstream<span>D</span></button>
                <button type="button" style={graphContextMenuButtonStyle} onClick={() => runNodeContextAction("select-connected", graphContextMenu.stepId || "")}>Select connected<span>A</span></button>
              </Fragment>
            ) : graphContextMenu.kind === "edge" && graphContextMenu.sourceId && graphContextMenu.targetId ? (
              <Fragment key="edge-menu">
                <button type="button" style={{ ...graphContextMenuButtonStyle, color: "var(--destructive, #ef4444)" }} onClick={() => runEdgeContextAction("remove-edge", graphContextMenu.sourceId || "", graphContextMenu.targetId || "")}>Remove relationship<span>-</span></button>
                <button type="button" style={graphContextMenuButtonStyle} onClick={() => runEdgeContextAction("select-source", graphContextMenu.sourceId || "", graphContextMenu.targetId || "")}>Select source<span>Src</span></button>
                <button type="button" style={graphContextMenuButtonStyle} onClick={() => runEdgeContextAction("select-target", graphContextMenu.sourceId || "", graphContextMenu.targetId || "")}>Select target<span>Tgt</span></button>
              </Fragment>
            ) : (
              <Fragment key="canvas-menu">
                <button type="button" style={graphContextMenuButtonStyle} onClick={() => runCanvasContextAction("agent")}>Add Agent<span>+</span></button>
                <button
                  type="button"
                  style={availableTools.length === 0 ? { ...graphContextMenuButtonStyle, ...buttonDisabledStyle } : graphContextMenuButtonStyle}
                  disabled={availableTools.length === 0}
                  onClick={() => runCanvasContextAction("tool")}
                >Add Tool<span>+</span></button>
                <button type="button" style={graphContextMenuButtonStyle} onClick={() => runCanvasContextAction("branch")}>Add Branch<span>B</span></button>
                <button type="button" style={graphContextMenuButtonStyle} onClick={() => runCanvasContextAction("loop")}>Add Loop<span>L</span></button>
                <button type="button" style={graphContextMenuButtonStyle} onClick={() => runCanvasContextAction("approval")}>Add Approval<span>A</span></button>
                <button type="button" style={graphContextMenuButtonStyle} onClick={() => runCanvasContextAction("fit-canvas")}>Fit canvas<span>F</span></button>
                <button type="button" style={graphContextMenuButtonStyle} onClick={() => runCanvasContextAction("actual-size")}>Actual size<span>1</span></button>
              </Fragment>
            )}
          </div>
        ) : (
          <Fragment key="graph-context-menu-placeholder" />
        )}
        <div
          key="graph-canvas-inner"
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
          }}
        >
        <div
          key="graph-canvas-content"
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: `${canvasWidth}px`,
            height: `${canvasHeight}px`,
            overflow: "visible",
            transform: `translate(${canvasPanX}px, ${canvasPanY}px) scale(${canvasScale})`,
            transformOrigin: "0 0",
            transition: draggingStepId || isCanvasPanning ? "none" : "transform 140ms ease",
            pointerEvents: "none",
          }}
        >
          <div key="graph-containers" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
            {graph.containers.map((container) => {
              const color = containerColor(container.type);
              const selected = selectedContainerSummary?.id === container.id;
              return (
                <button
                  key={container.id}
                  type="button"
                  aria-label={`Select ${container.type} container ${container.title}`}
                  onClick={() => {
                    const firstStepId = container.stepIds[0];
                    if (firstStepId) selectStep(firstStepId);
                  }}
                  style={{
                    position: "absolute",
                    left: container.x,
                    top: container.y,
                    width: container.width,
                    height: container.height,
                    padding: 0,
                    border: `${selected ? "2px solid" : "1px dashed"} ${color}`,
                    borderRadius: "8px",
                    background: `color-mix(in srgb, ${color} 8%, transparent)`,
                    boxShadow: selected ? `0 0 0 2px color-mix(in srgb, ${color} 24%, transparent)` : "none",
                    cursor: "pointer",
                    pointerEvents: "auto",
                    textAlign: "left",
                  }}
                >
                  <div
                    key="container-label"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                      maxWidth: "calc(100% - 16px)",
                      margin: "6px",
                      padding: "3px 7px",
                      borderRadius: "6px",
                      background: "var(--background, #020617)",
                      color,
                      fontSize: "11px",
                      fontWeight: 700,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <span key="type" style={{ textTransform: "uppercase" }}>{container.type}</span>
                    <span key="title">{container.title}</span>
                  </div>
                  {container.description ? (
                    <div
                      key="description"
                      style={{
                        margin: "0 8px",
                        maxWidth: "calc(100% - 16px)",
                        color: "var(--muted-foreground, #94a3b8)",
                        fontSize: "11px",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {container.description}
                    </div>
                  ) : (
                    <Fragment key="description-placeholder" />
                  )}
                  {container.badges.length > 0 ? (
                    <div key="badges" style={{ display: "flex", flexWrap: "wrap", gap: "4px", margin: "6px 8px 0" }}>
                      {container.badges.map((badge) => (
                        <span key={badge} style={{ ...graphPolicyBadgeStyle, color }}>{badge}</span>
                      ))}
                    </div>
                  ) : (
                    <Fragment key="badges-placeholder" />
                  )}
                </button>
              );
            })}
          </div>
          <div key="graph-groups" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
            {graph.groups.filter((group) => !group.collapsed).map((group) => (
              <div
                key={group.id}
                style={{
                  position: "absolute",
                  left: group.x,
                  top: group.y,
                  width: group.width,
                  height: group.height,
                  border: `1px solid ${group.color}`,
                  borderRadius: "8px",
                  background: `color-mix(in srgb, ${group.color} 10%, transparent)`,
                  pointerEvents: "none",
                }}
              >
                <div
                  style={{
                    display: "inline-flex",
                    maxWidth: "calc(100% - 16px)",
                    margin: "6px",
                    padding: "3px 7px",
                    borderRadius: "6px",
                    background: "var(--background, #020617)",
                    color: group.color,
                    fontSize: "11px",
                    fontWeight: 700,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {group.title}
                </div>
              </div>
            ))}
          </div>
          <svg
            key="graph-edges"
            aria-hidden="true"
            width={canvasWidth}
            height={canvasHeight}
            style={{ position: "absolute", inset: 0, overflow: "visible", pointerEvents: "auto" }}
          >
            <defs>
              <marker id="workflow-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                <path d="M0,0 L8,4 L0,8 Z" fill="var(--muted-foreground, #94a3b8)" />
              </marker>
            </defs>
            <g key="edge-paths">
              {graph.edges.map((edge) => {
                const source = graph.nodes.find((node) => node.id === edge.source);
                const target = graph.nodes.find((node) => node.id === edge.target);
                if (!source || !target) return null;
                const startX = source.x + 172;
                const startY = source.y + 38;
                const endX = target.x;
                const endY = target.y + 38;
                const midX = startX + Math.max(34, (endX - startX) / 2);
                const edgePath = `M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX - 8} ${endY}`;
                const selected = selectedEdgeId === edge.id;
                return (
                  <g key={edge.id}>
                    <path
                      data-graph-edge="true"
                      data-edge-id={edge.id}
                      d={edgePath}
                      fill="none"
                      stroke="transparent"
                      strokeWidth="16"
                      pointerEvents="stroke"
                      style={{ cursor: "pointer" }}
                      onClick={(event) => handleEdgeClick(event, edge)}
                      onContextMenu={(event) => handleEdgeContextMenu(event, edge)}
                    />
                    <path
                      d={edgePath}
                      fill="none"
                      stroke={graphEdgeColor(edge.kind)}
                      strokeWidth={selected ? "3" : edge.kind === "failure" ? "2" : "1.5"}
                      strokeDasharray={graphEdgeDashArray(edge.kind)}
                      markerEnd="url(#workflow-arrow)"
                      pointerEvents="none"
                    />
                    {graphEdgeDisplayLabel(edge) ? (
                      <text
                        x={midX}
                        y={(startY + endY) / 2 - 6}
                        fill={graphEdgeColor(edge.kind)}
                        fontSize="11"
                        fontWeight="700"
                        textAnchor="middle"
                        pointerEvents="none"
                      >
                        {graphEdgeDisplayLabel(edge)}
                      </text>
                    ) : null}
                  </g>
                );
              })}
            </g>
          </svg>
          {selectedEdgeActionAnchor ? (
            <button
              key="graph-edge-remove"
              type="button"
              data-graph-edge-remove="true"
              aria-label={`Remove relationship from ${selectedEdgeActionAnchor.edge.source} to ${selectedEdgeActionAnchor.edge.target}`}
              title="Remove relationship"
              style={{
                ...graphEdgeRemoveButtonStyle,
                left: selectedEdgeActionAnchor.x - 11,
                top: selectedEdgeActionAnchor.y - 11,
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                disconnect(selectedEdgeActionAnchor.edge.source, selectedEdgeActionAnchor.edge.target);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                handleEdgeContextMenu(event, selectedEdgeActionAnchor.edge);
              }}
            >
              -
            </button>
          ) : (
            <Fragment key="graph-edge-remove-placeholder" />
          )}
          <div key="graph-nodes" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
            {graph.nodes.map((node) => {
              const selected = selectedStep?.id === node.step.id;
              const matched = matchingNodeIds.has(node.id);
              const inSelection = !selected && selectedPathNodeIds.has(node.id);
              const showNodeMetadata = selected || matched || inSelection;
              return (
                <button
                  key={node.id || node.order}
                  type="button"
                  data-graph-node="true"
                  style={{
                    ...graphNodeStyle(selected, node.kind, matched, inSelection),
                    left: node.x,
                    top: node.y,
                    cursor: draggingStepId === node.step.id ? "grabbing" : "grab",
                    touchAction: "none",
                    pointerEvents: "auto",
                  }}
                  onPointerDown={(event) => beginNodeDrag(event, node.step.id, node.x, node.y)}
                  onPointerMove={handleNodePointerMove}
                  onPointerUp={endNodeDrag}
                  onPointerCancel={endNodeDrag}
                  onContextMenu={(event) => handleNodeContextMenu(event, node.step.id)}
                  onClick={(event) => handleNodeClick(event, node.step.id)}
                >
                  <span
                    key="input-handle"
                    data-graph-handle="true"
                    data-graph-handle-kind="input"
                    data-step-id={node.step.id}
                    title={connectingFromStepId ? `Connect to ${node.step.id}` : `Input: ${node.step.id}`}
                    aria-hidden="true"
                    style={graphNodeInputHandleStyle(Boolean(connectingFromStepId && connectingFromStepId !== node.step.id))}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onPointerUp={(event) => completeEdgeConnection(event, node.step.id)}
                    onClick={(event) => completeEdgeConnection(event, node.step.id)}
                  />
                  <span
                    key="output-handle"
                    data-graph-handle="true"
                    data-graph-handle-kind="output"
                    data-step-id={node.step.id}
                    title={`Start relationship from ${node.step.id}`}
                    aria-hidden="true"
                    style={graphNodeOutputHandleStyle(connectingFromStepId === node.step.id)}
                    onPointerDown={(event) => beginEdgeConnection(event, node.step.id)}
                    onPointerUp={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                  />
                  <span key="meta-row" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                    <span key="kind" style={{ fontSize: "11px", color: "var(--muted-foreground, #94a3b8)", textTransform: "uppercase" }}>
                      {node.kind}
                    </span>
                    <span key="status" style={{ ...statusBadgeStyle(node.runStatus.status), fontSize: "10px" }}>
                      {node.runStatus.status}
                    </span>
                  </span>
                  <span key="label" style={{ display: "block", marginTop: "6px", fontSize: "13px", fontWeight: 700, overflowWrap: "anywhere" }}>
                    {node.label}
                  </span>
                  <span key="location" style={{ display: "block", marginTop: "4px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "11px", color: "var(--muted-foreground, #94a3b8)", overflowWrap: "anywhere" }}>
                    L{node.layer} · {node.id || "(no id)"}
                  </span>
                  {matched ? (
                    <span key="match" style={{ display: "block", marginTop: "5px", fontSize: "11px", color: "#fbbf24", fontWeight: 700 }}>
                      Search match
                    </span>
                  ) : (
                    <Fragment key="match-placeholder" />
                  )}
                  {inSelection ? (
                    <span key="selection" style={{ display: "block", marginTop: "5px", fontSize: "11px", color: "#22c55e", fontWeight: 700 }}>
                      Selected path
                    </span>
                  ) : (
                    <Fragment key="selection-placeholder" />
                  )}
                  {showNodeMetadata && node.advanced.badges.length > 0 ? (
                    <span key="badges" style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "6px" }}>
                      {node.advanced.badges.map((badge) => (
                        <span key={badge} style={graphPolicyBadgeStyle}>{badge}</span>
                      ))}
                    </span>
                  ) : (
                    <Fragment key="badges-placeholder" />
                  )}
                  {showNodeMetadata && node.testing.badges.length > 0 ? (
                    <span key="testing-badges" style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "6px" }}>
                      {node.testing.badges.map((badge) => (
                        <span key={badge} style={{ ...graphPolicyBadgeStyle, color: "#fbbf24" }}>{badge}</span>
                      ))}
                    </span>
                  ) : (
                    <Fragment key="testing-badges-placeholder" />
                  )}
                  {showNodeMetadata && node.execution.badges.length > 0 ? (
                    <span key="execution-badges" style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "6px" }}>
                      {node.execution.badges.map((badge) => (
                        <span key={badge} style={{ ...graphPolicyBadgeStyle, color: "#38bdf8" }}>{badge}</span>
                      ))}
                    </span>
                  ) : (
                    <Fragment key="execution-badges-placeholder" />
                  )}
                  {showNodeMetadata && node.dataFlow.badges.length > 0 ? (
                    <span key="data-flow-badges" style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "6px" }}>
                      {node.dataFlow.badges.map((badge) => (
                        <span key={badge} style={{ ...graphPolicyBadgeStyle, color: "#a78bfa" }}>{badge}</span>
                      ))}
                    </span>
                  ) : (
                    <Fragment key="data-flow-badges-placeholder" />
                  )}
                  {showNodeMetadata && node.resources.badges.length > 0 ? (
                    <span key="resource-badges" style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "6px" }}>
                      {node.resources.badges.map((badge) => (
                        <span key={badge} style={{ ...graphPolicyBadgeStyle, color: "#34d399" }}>{badge}</span>
                      ))}
                    </span>
                  ) : (
                    <Fragment key="resource-badges-placeholder" />
                  )}
                  {showNodeMetadata && node.runStatus.runtimeBadges.length > 0 ? (
                    <span key="runtime-badges" style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "6px" }}>
                      {node.runStatus.runtimeBadges.map((badge) => (
                        <span key={badge} style={{ ...graphPolicyBadgeStyle, color: "#f97316" }}>{badge}</span>
                      ))}
                    </span>
                  ) : (
                    <Fragment key="runtime-badges-placeholder" />
                  )}
                  {showNodeMetadata && node.runStatus.issueIdentifier ? (
                    <span key="issue" style={{ display: "block", marginTop: "5px", fontSize: "11px", color: "var(--muted-foreground, #94a3b8)", overflowWrap: "anywhere" }}>
                      Issue: {node.runStatus.issueIdentifier}
                    </span>
                  ) : (
                    <Fragment key="issue-placeholder" />
                  )}
                  {showNodeMetadata && node.runStatus.summary ? (
                    <span key="summary" style={{ display: "block", marginTop: "5px", fontSize: "11px", color: "var(--muted-foreground, #94a3b8)", overflowWrap: "anywhere" }}>
                      {node.runStatus.summary}
                    </span>
                  ) : (
                    <Fragment key="summary-placeholder" />
                  )}
                  {showNodeMetadata && typeof node.step.graphNote === "string" && node.step.graphNote.trim() ? (
                    <span key="note" style={{ display: "block", marginTop: "6px", fontSize: "11px", color: "var(--muted-foreground, #94a3b8)", overflowWrap: "anywhere" }}>
                      Note: {node.step.graphNote.trim()}
                    </span>
                  ) : (
                    <Fragment key="note-placeholder" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
        </div>
        <div key="graph-canvas-view-tools-layer" style={graphCanvasViewToolLayerStyle}>
          <div key="graph-canvas-view-tools" data-graph-toolbar="true" style={graphCanvasViewToolDockStyle}>
            <div key="view-tools" aria-label="Canvas view tools" style={graphCanvasToolGroupStyle}>
              <span style={graphCanvasToolLabelStyle}>View</span>
              <button type="button" style={graphCanvasToolButtonStyle} title="Zoom out" aria-label="Zoom out" onClick={() => setCanvasScaleFromPoint(canvasScale - 0.1)}>
                <GraphZoomIcon direction="out" />
              </button>
              <button type="button" style={graphCanvasToolButtonStyle} title="Zoom in" aria-label="Zoom in" onClick={() => setCanvasScaleFromPoint(canvasScale + 0.1)}>
                <GraphZoomIcon direction="in" />
              </button>
              <button type="button" style={graphCanvasToolButtonStyle} title="Fit canvas" aria-label="Fit canvas" onClick={() => runWorkbenchAction("fit-canvas")}>
                F
              </button>
              <button type="button" style={graphCanvasToolButtonStyle} title="Center selected" aria-label="Center selected" onClick={() => runWorkbenchAction("center-selected")} disabled={!selectedStep}>
                C
              </button>
            </div>
          </div>
        </div>
      </div>
        <div key="graph-status-strip" style={graphStatusStripStyle}>
          <div key="path-summary" style={{ minWidth: 0, display: "flex", alignItems: "center", gap: "7px", color: "var(--muted-foreground, #94a3b8)", fontSize: "12px", overflow: "hidden" }}>
            <strong style={{ color: "var(--foreground, #f8fafc)", whiteSpace: "nowrap" }}>Selected path</strong>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{workbenchSummary.pathSummary}</span>
          </div>
          <div key="status-badges" style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "5px", flexWrap: "wrap" }}>
            {workbenchSummary.statusBadges.map((badge) => (
              <span key={badge} style={{ ...graphPolicyBadgeStyle, color: badge.includes("error") && !badge.startsWith("0 ") ? "var(--destructive, #ef4444)" : "#38bdf8" }}>{badge}</span>
            ))}
            <span key="canvas-scale" style={{ ...graphPolicyBadgeStyle, color: "#a78bfa" }}>{Math.round(canvasScale * 100)}%</span>
          </div>
        </div>
      </div>

      <aside key="graph-sidebar" style={graphSidebarStyle}>
        <div key="graph-inspector-mode" style={{ display: "grid", gap: "8px", paddingBottom: "8px", borderBottom: "1px solid var(--border, #334155)" }}>
          <div key="inspector-heading" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
            <p style={{ ...mutedTextStyle, fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.04em" }}>
              Inspector
            </p>
            <span style={{ ...graphPolicyBadgeStyle, color: inspectorAccent }}>
              {activeInspectorSection.title}
            </span>
          </div>
          <div key="inspector-tabs" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "6px" }}>
            {inspectorSummary.sections.filter((section) => section.mode !== "overview").map((section) => (
              <button
                key={section.mode}
                type="button"
                style={{ ...filterTabStyle(graphInspectorMode === section.mode), justifyContent: "center", padding: "6px 8px" }}
                onClick={() => setGraphInspectorMode(section.mode)}
              >
                {section.title}
              </button>
            ))}
          </div>
          <p key="inspector-summary" style={{ margin: 0, color: "var(--muted-foreground, #94a3b8)", fontSize: "12px", lineHeight: 1.4 }}>
            {activeInspectorSection.summary}
          </p>
          <div key="inspector-badges" style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
            {activeInspectorSection.badges.map((badge) => (
              <span key={badge} style={{ ...graphPolicyBadgeStyle, color: inspectorAccent }}>{badge}</span>
            ))}
          </div>
        </div>
        {showOverviewInspector && showGraphDetails ? (
        <div key="graph-diagnostics" style={{ display: "grid", gap: "8px", paddingBottom: "8px", borderBottom: "1px solid var(--border, #334155)" }}>
          <div key="diagnostics-header">
            <p style={{ ...mutedTextStyle, fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.04em" }}>
              Graph diagnostics
            </p>
            <p style={{ margin: "4px 0 0", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
              {diagnostics.issues.length === 0 ? "No structural issues detected." : `${diagnostics.issues.length} structural issue${diagnostics.issues.length === 1 ? "" : "s"} detected.`}
            </p>
          </div>
          <div key="diagnostic-stats" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "6px" }}>
            <div key="errors" style={graphDiagnosticRowStyle}>
              <span style={{ ...mutedTextStyle, fontSize: "10px", textTransform: "uppercase" }}>Errors</span>
              <strong style={{ fontSize: "16px" }}>{diagnostics.issueCountBySeverity.error}</strong>
            </div>
            <div key="entry" style={graphDiagnosticRowStyle}>
              <span style={{ ...mutedTextStyle, fontSize: "10px", textTransform: "uppercase" }}>Entry</span>
              <strong style={{ fontSize: "16px" }}>{diagnostics.entryStepIds.length}</strong>
            </div>
            <div key="terminal" style={graphDiagnosticRowStyle}>
              <span style={{ ...mutedTextStyle, fontSize: "10px", textTransform: "uppercase" }}>Terminal</span>
              <strong style={{ fontSize: "16px" }}>{diagnostics.terminalStepIds.length}</strong>
            </div>
          </div>
          <div
            key="repair-plan"
            style={{
              display: "grid",
              gap: "7px",
              padding: "8px",
              border: "1px solid color-mix(in srgb, #38bdf8 34%, var(--border, #334155))",
              borderRadius: "8px",
              background: "color-mix(in srgb, #38bdf8 7%, transparent)",
            }}
          >
            <div key="repair-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
              <span style={{ ...mutedTextStyle, fontSize: "11px", textTransform: "uppercase" }}>
                Repair plan
              </span>
              <span style={{ ...graphPolicyBadgeStyle, color: repairPlan.blocked ? "var(--destructive, #ef4444)" : "#38bdf8" }}>
                {repairPlan.blocked ? "blocked" : "ready"}
              </span>
            </div>
            <span key="repair-summary" style={{ ...mutedTextStyle, fontSize: "11px", lineHeight: 1.4 }}>
              {repairPlan.summary}
            </span>
            <div key="repair-badges" style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
              {repairPlan.badges.map((badge) => (
                <span key={badge} style={{ ...graphPolicyBadgeStyle, color: repairPlan.blocked ? "var(--destructive, #ef4444)" : "#38bdf8" }}>{badge}</span>
              ))}
            </div>
            {repairPlan.items.length > 0 ? (
              <div key="repair-items" style={{ display: "grid", gap: "6px" }}>
                {repairPlan.items.slice(0, 4).map((item) => {
                  const canFocus = Boolean(item.focusStepId && steps.some((step) => step.id === item.focusStepId));
                  return (
                    <div key={item.id} style={graphDiagnosticRowStyle}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
                        <strong style={{ fontSize: "12px", overflowWrap: "anywhere" }}>{item.title}</strong>
                        {canFocus ? (
                          <button
                            type="button"
                            style={{ ...buttonStyle, padding: "3px 8px", fontSize: "11px" }}
                            onClick={() => selectStep(item.focusStepId)}
                          >
                            Focus
                          </button>
                        ) : null}
                      </div>
                      <p style={{ margin: "4px 0 0", color: "var(--muted-foreground, #94a3b8)", fontSize: "11px", lineHeight: 1.4 }}>
                        {item.description}
                      </p>
                      <div style={{ display: "flex", gap: "4px", flexWrap: "wrap", marginTop: "5px" }}>
                        {item.badges.map((badge) => (
                          <span key={badge} style={{ ...graphPolicyBadgeStyle, color: item.severity === "error" ? "var(--destructive, #ef4444)" : "#38bdf8" }}>{badge}</span>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <Fragment key="repair-items-placeholder" />
            )}
          </div>
          {diagnostics.issues.length > 0 ? (
            <div key="diagnostic-issues" style={{ display: "grid", gap: "6px" }}>
              {diagnostics.issues.map((issue) => {
                const focusStepId = issue.stepId || issue.targetId || "";
                const canFocus = Boolean(focusStepId && steps.some((step) => step.id === focusStepId));
                return (
                  <div key={issue.id} style={graphDiagnosticRowStyle}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                      <span style={graphIssueBadgeStyle(issue.severity)}>{issue.code}</span>
                      {canFocus ? (
                        <button
                          type="button"
                          style={{ ...buttonStyle, padding: "3px 8px", fontSize: "11px" }}
                          onClick={() => selectStep(focusStepId)}
                        >
                          Focus
                        </button>
                      ) : null}
                    </div>
                    <p style={{ margin: 0, color: "var(--muted-foreground, #94a3b8)", fontSize: "12px", lineHeight: 1.4 }}>
                      {issue.message}
                    </p>
                  </div>
                );
              })}
            </div>
          ) : (
            <Fragment key="diagnostic-issues-placeholder" />
          )}
          <div key="entry-steps" style={{ display: "grid", gap: "6px" }}>
            <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Entry steps</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "5px" }}>
              {diagnostics.entryStepIds.length > 0 ? diagnostics.entryStepIds.map((stepId) => (
                <button
                  key={stepId}
                  type="button"
                  style={{ ...buttonStyle, padding: "3px 7px", fontSize: "11px" }}
                  onClick={() => selectStep(stepId)}
                >
                  {stepId}
                </button>
              )) : <span style={{ ...mutedTextStyle, fontSize: "12px" }}>None</span>}
            </div>
          </div>
          <div key="terminal-steps" style={{ display: "grid", gap: "6px" }}>
            <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Terminal steps</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "5px" }}>
              {diagnostics.terminalStepIds.length > 0 ? diagnostics.terminalStepIds.map((stepId) => (
                <button
                  key={stepId}
                  type="button"
                  style={{ ...buttonStyle, padding: "3px 7px", fontSize: "11px" }}
                  onClick={() => selectStep(stepId)}
                >
                  {stepId}
                </button>
              )) : <span style={{ ...mutedTextStyle, fontSize: "12px" }}>None</span>}
            </div>
          </div>
        </div>
        ) : (
          <Fragment key="graph-diagnostics-placeholder" />
        )}
        {showOverviewInspector && showGraphTestDrawer ? (
          <WorkflowGraphTestDrawer
            key="test-drawer"
            summary={testDrawerSummary}
            steps={steps}
            interfaceInput={testInterfaceInput}
            onClose={() => setShowGraphTestDrawer(false)}
          />
        ) : (
          <Fragment key="test-drawer-placeholder" />
        )}
        {showOverviewInspector && showGraphEvidenceDrawer ? (
          <WorkflowGraphExecutionEvidenceDrawer
            key="evidence-drawer"
            summary={evidenceSummary}
            onClose={() => setShowGraphEvidenceDrawer(false)}
          />
        ) : (
          <Fragment key="evidence-drawer-placeholder" />
        )}
        {showOverviewInspector && showGraphDetails ? (
        <div
          key="selected-path-summary"
          style={{
            display: "grid",
            gap: "7px",
            padding: "8px",
            border: "1px solid color-mix(in srgb, #22c55e 42%, var(--border, #334155))",
            borderRadius: "8px",
            background: "color-mix(in srgb, #22c55e 8%, transparent)",
          }}
        >
          <div key="header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
            <span style={{ ...mutedTextStyle, fontSize: "11px", textTransform: "uppercase" }}>
              Selected path
            </span>
            <span style={{ ...graphPolicyBadgeStyle, color: selectedPathSummary.blocked ? "var(--destructive, #ef4444)" : "#22c55e" }}>
              {selectedPathSummary.blocked ? "empty" : `${selectedPathSummary.stepIds.length} nodes`}
            </span>
          </div>
          <span key="summary" style={{ ...mutedTextStyle, fontSize: "11px", lineHeight: 1.4 }}>
            {selectedPathSummary.summary}
          </span>
          <div key="badges" style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
            {selectedPathSummary.badges.map((badge) => (
              <span key={badge} style={{ ...graphPolicyBadgeStyle, color: selectedPathSummary.blocked ? "var(--destructive, #ef4444)" : "#22c55e" }}>{badge}</span>
            ))}
          </div>
          <div key="selection-mode-actions" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "6px" }}>
            <button type="button" style={{ ...buttonStyle, justifyContent: "center", fontSize: "11px" }} onClick={() => expandSelectedPath("upstream")}>
              Select upstream
            </button>
            <button type="button" style={{ ...buttonStyle, justifyContent: "center", fontSize: "11px" }} onClick={() => expandSelectedPath("downstream")}>
              Select downstream
            </button>
            <button type="button" style={{ ...buttonStyle, justifyContent: "center", fontSize: "11px" }} onClick={() => expandSelectedPath("connected")}>
              Select connected
            </button>
            <button type="button" style={{ ...buttonStyle, justifyContent: "center", fontSize: "11px" }} onClick={clearSelectedPath}>
              Clear path
            </button>
          </div>
          <div key="selection-actions" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "6px" }}>
            <button type="button" style={{ ...buttonStyle, justifyContent: "center", fontSize: "11px" }} onClick={groupSelectedGraphSelection} disabled={selectedPathSummary.blocked}>
              Group
            </button>
            <button type="button" style={{ ...buttonStyle, justifyContent: "center", fontSize: "11px" }} onClick={() => wrapSelectedGraphSelection("branch")} disabled={selectedPathSummary.blocked}>
              Branch
            </button>
            <button type="button" style={{ ...buttonStyle, justifyContent: "center", fontSize: "11px" }} onClick={() => wrapSelectedGraphSelection("loop")} disabled={selectedPathSummary.blocked}>
              Loop
            </button>
          </div>
          <div key="selection-boundaries" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: "6px" }}>
            <div style={{ display: "grid", gap: "3px" }}>
              <span style={{ ...mutedTextStyle, fontSize: "10px" }}>Steps</span>
              {renderDataFlowChips(selectedPathSummary.stepIds, "No selected steps")}
            </div>
            <div style={{ display: "grid", gap: "3px" }}>
              <span style={{ ...mutedTextStyle, fontSize: "10px" }}>Inbound</span>
              {renderDataFlowChips(selectedPathSummary.inboundStepIds, "No inbound", "muted")}
            </div>
            <div style={{ display: "grid", gap: "3px" }}>
              <span style={{ ...mutedTextStyle, fontSize: "10px" }}>Outbound</span>
              {renderDataFlowChips(selectedPathSummary.outboundStepIds, "No outbound", "muted")}
            </div>
          </div>
        </div>
        ) : (
          <Fragment key="selected-path-summary-placeholder" />
        )}
        {showOverviewInspector && showGraphDetails && selectedContainerSummary ? (
          <div
            key="selected-container-summary"
            style={{
              display: "grid",
              gap: "7px",
              padding: "8px",
              border: `1px solid ${containerColor(selectedContainerSummary.type)}`,
              borderRadius: "8px",
              background: `color-mix(in srgb, ${containerColor(selectedContainerSummary.type)} 10%, transparent)`,
            }}
          >
            <div key="header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
              <span style={{ ...mutedTextStyle, fontSize: "11px", textTransform: "uppercase" }}>
                Selected container
              </span>
              <span style={{ ...graphPolicyBadgeStyle, color: containerColor(selectedContainerSummary.type) }}>
                {selectedContainerSummary.type}
              </span>
            </div>
            <strong key="title" style={{ fontSize: "13px", overflowWrap: "anywhere" }}>{selectedContainerSummary.title}</strong>
            <span key="summary" style={{ ...mutedTextStyle, fontSize: "11px", lineHeight: 1.4 }}>
              {selectedContainerSummary.summary}
            </span>
            <div key="badges" style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
              {selectedContainerSummary.badges.map((badge) => (
                <span key={badge} style={{ ...graphPolicyBadgeStyle, color: selectedContainerSummary.blocked ? "var(--destructive, #ef4444)" : containerColor(selectedContainerSummary.type) }}>{badge}</span>
              ))}
            </div>
            <div key="container-actions" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
              <button
                key="duplicate-container"
                type="button"
                style={{ ...buttonStyle, justifyContent: "center", fontSize: "11px" }}
                onClick={duplicateSelectedContainer}
              >
                Duplicate container
              </button>
              <button
                key="clear-container"
                type="button"
                style={{ ...buttonStyle, justifyContent: "center", fontSize: "11px" }}
                onClick={clearSelectedContainer}
              >
                Clear container
              </button>
            </div>
            <div key="boundaries" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: "6px" }}>
              <div style={{ display: "grid", gap: "3px" }}>
                <span style={{ ...mutedTextStyle, fontSize: "10px" }}>Steps</span>
                {renderDataFlowChips(selectedContainerSummary.stepIds, "No steps")}
              </div>
              <div style={{ display: "grid", gap: "3px" }}>
                <span style={{ ...mutedTextStyle, fontSize: "10px" }}>Entry</span>
                {renderDataFlowChips(selectedContainerSummary.entryStepIds, "No entry", "muted")}
              </div>
              <div style={{ display: "grid", gap: "3px" }}>
                <span style={{ ...mutedTextStyle, fontSize: "10px" }}>Exit</span>
                {renderDataFlowChips(selectedContainerSummary.terminalStepIds, "No exit", "muted")}
              </div>
              <div style={{ display: "grid", gap: "3px" }}>
                <span style={{ ...mutedTextStyle, fontSize: "10px" }}>Inbound</span>
                {renderDataFlowChips(selectedContainerSummary.inboundStepIds, "No inbound", "muted")}
              </div>
              <div style={{ display: "grid", gap: "3px" }}>
                <span style={{ ...mutedTextStyle, fontSize: "10px" }}>Outbound</span>
                {renderDataFlowChips(selectedContainerSummary.outboundStepIds, "No outbound", "muted")}
              </div>
            </div>
          </div>
        ) : (
          <Fragment key="selected-container-summary-placeholder" />
        )}
        {graphError ? <p key="graph-error" style={noticeStyle("error")}>{graphError}</p> : <Fragment key="graph-error-placeholder" />}
        {selectedStep ? (
          <div key="selected-step-editor" style={{ display: "contents" }}>
            {showEditInspector ? (
            <Fragment key="selected-step-edit-fields">
            <div key="step-id-field" style={{ display: "grid", gap: "4px" }}>
              <label key="label" style={{ ...mutedTextStyle, fontSize: "11px" }}>Step ID</label>
              <input
                key="input"
                style={inputStyle}
                value={selectedStep.id}
                onChange={(event) => renameSelectedStep(event.target.value)}
              />
            </div>
            <div key="step-title-field" style={{ display: "grid", gap: "4px" }}>
              <label key="label" style={{ ...mutedTextStyle, fontSize: "11px" }}>Title</label>
              <input key="input" style={inputStyle} value={selectedStep.title} onChange={(event) => updateSelected({ title: event.target.value })} />
            </div>
            <div key="step-type-field" style={{ display: "grid", gap: "4px" }}>
              <label key="label" style={{ ...mutedTextStyle, fontSize: "11px" }}>Type</label>
              <select key="select" style={selectStyle} value={selectedStep.type} onChange={(event) => {
                const newType = event.target.value as "agent" | "tool";
                if (newType === "tool" && availableTools.length === 0) return;
                if (newType === "agent" && selectedStep.agentName) {
                  const granted = new Set(availableToolGrants.filter((g) => g.agentName === selectedStep.agentName).map((g) => g.toolName));
                  const cleaned = splitCommaList(selectedStep.tools).filter((t) => granted.has(t)).join(", ");
                  updateSelected({ type: newType, tools: cleaned });
                } else {
                  updateSelected({ type: newType });
                }
              }}>
                <option key="agent" value="agent">Agent</option>
                <option key="tool" value="tool" disabled={availableTools.length === 0}>Tool</option>
              </select>
              {availableTools.length === 0 ? (
                <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Tool steps are inactive until workflow tools are available.</span>
              ) : null}
            </div>
            <div key="step-description-field" style={{ display: "grid", gap: "4px" }}>
              <label key="label" style={{ ...mutedTextStyle, fontSize: "11px" }}>Description</label>
              <textarea key="textarea" style={{ ...textareaStyle, minHeight: "76px" }} value={selectedStep.description} onChange={(event) => updateSelected({ description: event.target.value })} />
            </div>
            {selectedStep.type === "tool" ? (
              <Fragment key="tool-step-fields">
                <div key="tool-name-field" style={{ display: "grid", gap: "4px" }}>
                  <label style={{ ...mutedTextStyle, fontSize: "11px" }}>Tool</label>
                  <WorkflowToolPicker
                    value={selectedStep.toolName}
                    multiple={false}
                    tools={availableTools}
                    onChange={(value) => updateSelected({ toolName: value })}
                  />
                </div>
                <div key="tool-args-field" style={{ display: "grid", gap: "4px" }}>
                  <label style={{ ...mutedTextStyle, fontSize: "11px" }}>Tool Args (JSON)</label>
                  <textarea
                    style={{ ...textareaStyle, minHeight: "92px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: "12px" }}
                    value={selectedStep.toolArgs}
                    onChange={(event) => updateSelected({ toolArgs: event.target.value })}
                  />
                </div>
              </Fragment>
            ) : (
              <Fragment key="agent-step-fields">
                <div key="agent-name-field" style={{ display: "grid", gap: "4px" }}>
                  <label style={{ ...mutedTextStyle, fontSize: "11px" }}>Agent</label>
                  <input style={inputStyle} value={selectedStep.agentName} placeholder="Agent name" onChange={(event) => {
                    const newName = event.target.value;
                    const granted = new Set(availableToolGrants.filter((g) => g.agentName === newName).map((g) => g.toolName));
                    const cleaned = splitCommaList(selectedStep.tools).filter((t) => granted.has(t)).join(", ");
                    updateSelected({ agentName: newName, tools: cleaned });
                  }} />
                </div>
                <div key="agent-tool-access-field" style={{ display: "grid", gap: "4px" }}>
                  <label style={{ ...mutedTextStyle, fontSize: "11px" }}>Agent tool access</label>
                  <WorkflowToolPicker
                    value={selectedStep.tools}
                    multiple={true}
                    tools={availableTools.filter((t) => availableToolGrants.some((g) => g.agentName === selectedStep.agentName && g.toolName === t.name))}
                    onChange={(value) => updateSelected({ tools: value })}
                  />
                </div>
              </Fragment>
            )}
            <button key="add-downstream" type="button" style={primaryButtonStyle} onClick={() => addAfter(selectedStep.id)}>
              Add downstream step
            </button>
            <div key="node-actions" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
              <button type="button" style={buttonStyle} onClick={duplicateSelectedStep}>
                Duplicate selected
              </button>
              <button type="button" style={dangerButtonStyle} onClick={deleteSelectedStep}>
                Delete selected
              </button>
            </div>
            </Fragment>
            ) : (
              <Fragment key="selected-step-edit-placeholder" />
            )}
            {showPolicyInspector ? (
            <Fragment key="selected-step-policy-fields">
            <div key="advanced-policy" style={{ display: "grid", gap: "6px", paddingTop: "8px", borderTop: "1px solid var(--border, #334155)" }}>
              <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Step policy</span>
              <select
                style={selectStyle}
                value={selectedStep.onFailure}
                onChange={(event) => updateSelectedAdvanced({ onFailure: event.target.value })}
              >
                <option value="">Default failure policy</option>
                <option value="retry">Retry</option>
                <option value="skip">Skip on failure</option>
                <option value="abort_workflow">Abort workflow</option>
                <option value="escalate">Escalate</option>
              </select>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
                <input
                  style={inputStyle}
                  type="number"
                  min={0}
                  step={1}
                  value={selectedStep.maxRetries}
                  placeholder={selectedStep.onFailure === "retry" ? "max retries (default 2)" : "max retries"}
                  onChange={(event) => updateSelectedAdvanced({ maxRetries: event.target.value })}
                />
                <input
                  style={inputStyle}
                  type="number"
                  min={1}
                  step={1}
                  value={selectedStep.timeoutSeconds}
                  placeholder="timeout seconds"
                  onChange={(event) => updateSelectedAdvanced({ timeoutSeconds: event.target.value })}
                />
              </div>
              <details key="advanced-policy-details" style={workflowPolicyDetailsStyle}>
                <summary style={workflowPolicyDetailsSummaryStyle}>Advanced policy</summary>
                <div key="advanced-policy-fields" style={{ display: "grid", gap: "8px", paddingTop: "8px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
                <input
                  style={inputStyle}
                  type="number"
                  min={1}
                  step={1}
                  value={selectedStep.graphRetryDelaySeconds}
                  placeholder="retry delay seconds"
                  onChange={(event) => updateSelectedAdvanced({ graphRetryDelaySeconds: event.target.value })}
                />
                <select
                  style={selectStyle}
                  value={selectedStep.graphRetryBackoff}
                  onChange={(event) => updateSelectedAdvanced({ graphRetryBackoff: event.target.value })}
                >
                  <option value="">No retry backoff</option>
                  <option value="fixed">Fixed backoff</option>
                  <option value="linear">Linear backoff</option>
                  <option value="exponential">Exponential backoff</option>
                </select>
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
                <input
                  type="checkbox"
                  checked={selectedStep.graphRetryJitter}
                  onChange={(event) => updateSelectedAdvanced({ graphRetryJitter: event.target.checked })}
                />
                Add retry jitter
              </label>
              <div style={{ display: "grid", gap: "6px", paddingTop: "4px" }}>
                <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Error handler</span>
                <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
                  <input
                    type="checkbox"
                    checked={selectedStep.graphErrorHandler}
                    onChange={(event) => updateSelectedAdvanced({ graphErrorHandler: event.target.checked })}
                  />
                  Handle failed flow step payloads
                </label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
                  <select
                    style={selectStyle}
                    value={selectedStep.graphErrorHandlerScope}
                    onChange={(event) => updateSelectedAdvanced({ graphErrorHandlerScope: event.target.value })}
                  >
                    <option value="">No handler scope</option>
                    <option value="flow">Flow error handler</option>
                    <option value="branch">Branch error handler</option>
                    <option value="step">Step error handler</option>
                  </select>
                  <input
                    style={inputStyle}
                    value={selectedStep.graphErrorHandlerInput}
                    placeholder="error payload expression"
                    onChange={(event) => updateSelectedAdvanced({ graphErrorHandlerInput: event.target.value })}
                  />
                </div>
              </div>
              <div style={{ display: "grid", gap: "6px", paddingTop: "4px" }}>
                <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Restart boundary</span>
                <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
                  <input
                    type="checkbox"
                    checked={selectedStep.graphRestartBoundary}
                    onChange={(event) => updateSelectedAdvanced({ graphRestartBoundary: event.target.checked })}
                  />
                  Allow restart from this step
                </label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
                  <select
                    style={selectStyle}
                    value={selectedStep.graphRestartStrategy}
                    onChange={(event) => updateSelectedAdvanced({ graphRestartStrategy: event.target.value })}
                  >
                    <option value="">No restart strategy</option>
                    <option value="copy-predecessors">Copy predecessors</option>
                    <option value="fresh">Fresh restart</option>
                    <option value="copy-branch">Copy branch/iteration</option>
                  </select>
                  <input
                    style={inputStyle}
                    value={selectedStep.graphRestartInput}
                    placeholder="restart input or branch selector"
                    onChange={(event) => updateSelectedAdvanced({ graphRestartInput: event.target.value })}
                  />
                </div>
              </div>
              <div style={{ display: "grid", gap: "6px", paddingTop: "4px" }}>
                <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Wait controls</span>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
                  <input
                    style={inputStyle}
                    type="number"
                    min={1}
                    step={1}
                    value={selectedStep.graphSleepSeconds}
                    placeholder="sleep seconds"
                    onChange={(event) => updateSelectedAdvanced({ graphSleepSeconds: event.target.value })}
                  />
                  <input
                    style={inputStyle}
                    value={selectedStep.graphSuspendUntil}
                    placeholder="Suspend until event"
                    onChange={(event) => updateSelectedAdvanced({ graphSuspendUntil: event.target.value })}
                  />
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
                  <input
                    style={inputStyle}
                    type="number"
                    min={1}
                    step={1}
                    value={selectedStep.graphSuspendTimeoutSeconds}
                    placeholder="suspend timeout seconds"
                    onChange={(event) => updateSelectedAdvanced({ graphSuspendTimeoutSeconds: event.target.value })}
                  />
                  <select
                    style={selectStyle}
                    value={selectedStep.graphSuspendTimeoutAction}
                    onChange={(event) => updateSelectedAdvanced({ graphSuspendTimeoutAction: event.target.value })}
                  >
                    <option value="">No suspend timeout action</option>
                    <option value="resume">Resume on timeout</option>
                    <option value="cancel">Cancel on timeout</option>
                  </select>
                </div>
              </div>
              <div style={{ display: "grid", gap: "6px", paddingTop: "4px" }}>
                <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Early response</span>
                <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
                  <input
                    type="checkbox"
                    checked={selectedStep.graphEarlyReturn}
                    onChange={(event) => updateSelectedAdvanced({ graphEarlyReturn: event.target.checked })}
                  />
                  Return this step for sync/webhook callers
                </label>
                <input
                  style={inputStyle}
                  value={selectedStep.graphEarlyReturnContentType}
                  placeholder="response content type"
                  onChange={(event) => updateSelectedAdvanced({ graphEarlyReturnContentType: event.target.value })}
                />
                <textarea
                  style={{ ...textareaStyle, minHeight: "58px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}
                  value={selectedStep.graphEarlyReturnSchema}
                  placeholder={'Early response schema, e.g. { "required": ["publicUrl"] }'}
                  onChange={(event) => updateSelectedAdvanced({ graphEarlyReturnSchema: event.target.value })}
                />
              </div>
              <textarea
                style={{ ...textareaStyle, minHeight: "58px" }}
                value={selectedStep.graphEarlyStopCondition}
                placeholder="Early stop condition"
                onChange={(event) => updateSelectedAdvanced({ graphEarlyStopCondition: event.target.value })}
              />
              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
                <input
                  type="checkbox"
                  checked={selectedStep.graphEarlyStopLabelSkipped}
                  onChange={(event) => updateSelectedAdvanced({ graphEarlyStopLabelSkipped: event.target.checked })}
                />
                Label flow as skipped if stopped
              </label>
            </div>
            <div key="approval-gate" style={{ display: "grid", gap: "6px", paddingTop: "8px", borderTop: "1px solid var(--border, #334155)" }}>
              <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Approval gate</span>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
                <input
                  type="checkbox"
                  checked={selectedStep.graphApprovalRequired}
                  onChange={(event) => updateSelectedApproval({ graphApprovalRequired: event.target.checked })}
                />
                Suspend until approved
              </label>
              <textarea
                style={{ ...textareaStyle, minHeight: "58px" }}
                value={selectedStep.graphApprovalPrompt}
                placeholder="Approval prompt"
                onChange={(event) => updateSelectedApproval({ graphApprovalPrompt: event.target.value })}
              />
              <input
                style={inputStyle}
                value={selectedStep.graphApprovalRecipients}
                placeholder="Approvers, comma-separated"
                onChange={(event) => updateSelectedApproval({ graphApprovalRecipients: event.target.value })}
              />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
                <input
                  style={inputStyle}
                  type="number"
                  min={1}
                  step={1}
                  value={selectedStep.graphApprovalTimeoutSeconds}
                  placeholder="timeout seconds"
                  onChange={(event) => updateSelectedApproval({ graphApprovalTimeoutSeconds: event.target.value })}
                />
                <select
                  style={selectStyle}
                  value={selectedStep.graphApprovalTimeoutAction}
                  onChange={(event) => updateSelectedApproval({ graphApprovalTimeoutAction: event.target.value })}
                >
                  <option value="">No timeout action</option>
                  <option value="cancel">Cancel on timeout</option>
                  <option value="resume">Resume on timeout</option>
                </select>
              </div>
            </div>
            <div key="execution-controls" style={{ display: "grid", gap: "6px", paddingTop: "8px", borderTop: "1px solid var(--border, #334155)" }}>
              <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Execution controls</span>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
                <input
                  style={inputStyle}
                  value={selectedStep.graphConcurrencyKey}
                  placeholder="concurrency key"
                  onChange={(event) => updateSelectedExecution({ graphConcurrencyKey: event.target.value })}
                />
                <input
                  style={inputStyle}
                  type="number"
                  min={1}
                  step={1}
                  value={selectedStep.graphConcurrencyLimit}
                  placeholder="concurrency limit"
                  onChange={(event) => updateSelectedExecution({ graphConcurrencyLimit: event.target.value })}
                />
              </div>
              <select
                style={selectStyle}
                value={selectedStep.graphPriority}
                onChange={(event) => updateSelectedExecution({ graphPriority: event.target.value })}
              >
                <option value="">Default priority</option>
                <option value="low">Low priority</option>
                <option value="normal">Normal priority</option>
                <option value="high">High priority</option>
                <option value="critical">Critical priority</option>
              </select>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
                <input
                  type="checkbox"
                  checked={selectedStep.graphCacheEnabled}
                  onChange={(event) => updateSelectedExecution({ graphCacheEnabled: event.target.checked })}
                />
                Cache step result
              </label>
              <input
                style={inputStyle}
                type="number"
                min={1}
                step={1}
                value={selectedStep.graphCacheTtlSeconds}
                placeholder="cache ttl seconds"
                onChange={(event) => updateSelectedExecution({ graphCacheTtlSeconds: event.target.value })}
              />
              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
                <input
                  type="checkbox"
                  checked={selectedStep.graphDeleteAfterUse}
                  onChange={(event) => updateSelectedExecution({ graphDeleteAfterUse: event.target.checked })}
                />
                Delete logs and results after use
              </label>
            </div>
            <div key="data-flow-contract" style={{ display: "grid", gap: "6px", paddingTop: "8px", borderTop: "1px solid var(--border, #334155)" }}>
              <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Data flow contract</span>
              <textarea
                style={{ ...textareaStyle, minHeight: "58px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px" }}
                value={selectedStep.graphInputExpression}
                placeholder="Input transform, e.g. select.result.summary"
                onChange={(event) => updateSelectedDataFlow({ graphInputExpression: event.target.value })}
              />
              <textarea
                style={{ ...textareaStyle, minHeight: "72px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px" }}
                value={selectedStep.graphOutputSchema}
                placeholder={'Output schema, e.g. { "type": "object", "required": ["htmlPath"] }'}
                onChange={(event) => updateSelectedDataFlow({ graphOutputSchema: event.target.value })}
              />
              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
                <input
                  type="checkbox"
                  checked={selectedStep.graphWorkProductRequired}
                  onChange={(event) => updateSelectedDataFlow({ graphWorkProductRequired: event.target.checked })}
                />
                Require registered work product
              </label>
              <input
                style={inputStyle}
                value={selectedStep.graphWorkProductPattern}
                placeholder="Expected output path pattern"
                onChange={(event) => updateSelectedDataFlow({ graphWorkProductPattern: event.target.value })}
              />
              {selectedDataFlowMap ? (
                <div
                  style={{
                    display: "grid",
                    gap: "6px",
                    padding: "8px",
                    border: "1px solid var(--border, #334155)",
                    borderRadius: "8px",
                    background: "rgba(15, 23, 42, 0.24)",
                  }}
                >
                  <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
                    {selectedDataFlowMap.badges.map((badge) => (
                      <span
                        key={`data-flow-map-${badge}`}
                        style={{ ...graphPolicyBadgeStyle, color: selectedDataFlowMap.blocked ? "var(--destructive, #ef4444)" : "#14b8a6" }}
                      >
                        {badge}
                      </span>
                    ))}
                  </div>
                  <span style={{ ...mutedTextStyle, fontSize: "11px" }}>{selectedDataFlowMap.summary}</span>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: "6px" }}>
                    <div style={{ display: "grid", gap: "3px" }}>
                      <span style={{ ...mutedTextStyle, fontSize: "10px" }}>Flow inputs</span>
                      {renderDataFlowChips(selectedDataFlowMap.flowInputRefs, "No flow inputs")}
                    </div>
                    <div style={{ display: "grid", gap: "3px" }}>
                      <span style={{ ...mutedTextStyle, fontSize: "10px" }}>Upstream results</span>
                      {renderDataFlowChips(
                        selectedDataFlowMap.resultRefs
                          .filter((ref) => ref.available)
                          .map((ref) => `${ref.stepId}.result${ref.path ? `.${ref.path}` : ""}`),
                        "No result refs",
                      )}
                    </div>
                    <div style={{ display: "grid", gap: "3px" }}>
                      <span style={{ ...mutedTextStyle, fontSize: "10px" }}>Resources</span>
                      {renderDataFlowChips(selectedDataFlowMap.resourceRefs, "No resources", "muted")}
                    </div>
                    <div style={{ display: "grid", gap: "3px" }}>
                      <span style={{ ...mutedTextStyle, fontSize: "10px" }}>Secrets</span>
                      {renderDataFlowChips(selectedDataFlowMap.secretRefs, "No secrets", "muted")}
                    </div>
                    {selectedDataFlowMap.missingStepIds.length > 0 ? (
                      <div style={{ display: "grid", gap: "3px" }}>
                        <span style={{ ...mutedTextStyle, fontSize: "10px", color: "var(--destructive, #ef4444)" }}>Missing steps</span>
                        {renderDataFlowChips(selectedDataFlowMap.missingStepIds, "No missing steps", "error")}
                      </div>
                    ) : null}
                  </div>
                  {selectedDataFlowMap.outputContractBadges.length > 0 ? (
                    <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
                      {selectedDataFlowMap.outputContractBadges.map((badge) => (
                        <span key={`output-contract-${badge}`} style={{ ...graphPolicyBadgeStyle, color: "#a78bfa" }}>{badge}</span>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div key="resource-bindings" style={{ display: "grid", gap: "6px", paddingTop: "8px", borderTop: "1px solid var(--border, #334155)" }}>
              <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Resource bindings</span>
              <input
                style={inputStyle}
                value={selectedStep.graphResourceRefs}
                placeholder="Resources, comma-separated"
                onChange={(event) => updateSelectedResources({ graphResourceRefs: event.target.value })}
              />
              <input
                style={inputStyle}
                value={selectedStep.graphSecretRefs}
                placeholder="Secret references, comma-separated"
                onChange={(event) => updateSelectedResources({ graphSecretRefs: event.target.value })}
              />
            </div>
            <div key="testing-overrides" style={{ display: "grid", gap: "6px", paddingTop: "8px", borderTop: "1px solid var(--border, #334155)" }}>
              <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Testing overrides</span>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
                <input
                  type="checkbox"
                  checked={selectedStep.graphMockEnabled}
                  onChange={(event) => updateSelectedTesting({ graphMockEnabled: event.target.checked })}
                />
                Mock step result while testing
              </label>
              <textarea
                style={{ ...textareaStyle, minHeight: "72px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px" }}
                value={selectedStep.graphMockResult}
                placeholder={'{ "status": "ok" }'}
                onChange={(event) => updateSelectedTesting({ graphMockResult: event.target.value })}
              />
              <input
                style={inputStyle}
                value={selectedStep.graphPinnedResultRunId}
                placeholder="Pinned run or step result id"
                onChange={(event) => updateSelectedTesting({ graphPinnedResultRunId: event.target.value })}
              />
            </div>
            <div key="graph-group" style={{ display: "grid", gap: "6px", paddingTop: "8px", borderTop: "1px solid var(--border, #334155)" }}>
              <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Graph group</span>
              <input
                style={inputStyle}
                value={selectedStep.graphGroupId}
                placeholder="group-id"
                onChange={(event) => updateSelected({ graphGroupId: event.target.value })}
              />
              <input
                style={inputStyle}
                value={selectedGroup?.title ?? selectedStep.graphGroupTitle}
                placeholder="Group title"
                onChange={(event) => updateSelectedGroupMetadata({ title: event.target.value })}
              />
              <input
                type="color"
                style={{ ...inputStyle, height: "36px", padding: "4px" }}
                value={(selectedGroup?.color ?? selectedStep.graphGroupColor) || "#64748b"}
                onChange={(event) => updateSelectedGroupMetadata({ color: event.target.value })}
              />
              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
                <input
                  type="checkbox"
                  checked={selectedGroup?.collapsedByDefault ?? selectedStep.graphGroupCollapsedByDefault}
                  onChange={(event) => updateSelectedGroupMetadata({ collapsedByDefault: event.target.checked })}
                />
                Collapsed by default
              </label>
              <button type="button" style={buttonStyle} onClick={groupSelectedWithDependencies}>
                Group with upstream steps
              </button>
              {selectedStep.graphGroupId.trim() ? (
                <button
                  type="button"
                  style={buttonStyle}
                  onClick={() => setSelectedGroupCollapsed(!(selectedGroup?.collapsed ?? selectedStep.graphGroupCollapsed ?? false))}
                >
                  {(selectedGroup?.collapsed ?? selectedStep.graphGroupCollapsed ?? false) ? "Expand selected group" : "Collapse selected group"}
                </button>
              ) : (
                <Fragment key="collapse-group-placeholder" />
              )}
              <button type="button" style={buttonStyle} onClick={clearSelectedGroup}>
                Clear selected group
              </button>
            </div>
            <div key="flow-container" style={{ display: "grid", gap: "6px", paddingTop: "8px", borderTop: "1px solid var(--border, #334155)" }}>
              <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Flow container</span>
              <select
                style={selectStyle}
                value={selectedStep.graphContainerType}
                onChange={(event) => updateSelectedContainerMetadata({
                  graphContainerType: event.target.value as WorkflowGraphContainerType,
                  graphContainerMode: event.target.value === "loop" ? "for-each" : "branch-one",
                })}
              >
                <option value="branch">Branch</option>
                <option value="loop">Loop</option>
              </select>
              <input
                style={inputStyle}
                value={selectedStep.graphContainerId}
                placeholder="container-id"
                onChange={(event) => updateSelected({ graphContainerId: event.target.value })}
              />
              <input
                style={inputStyle}
                value={selectedStep.graphContainerTitle}
                placeholder="Container title"
                onChange={(event) => updateSelectedContainerMetadata({ graphContainerTitle: event.target.value })}
              />
              <textarea
                style={{ ...textareaStyle, minHeight: "64px" }}
                value={selectedStep.graphContainerDescription}
                placeholder="Container description"
                onChange={(event) => updateSelectedContainerMetadata({ graphContainerDescription: event.target.value })}
              />
              <select
                style={selectStyle}
                value={selectedStep.graphContainerMode || (selectedStep.graphContainerType === "loop" ? "for-each" : "branch-one")}
                onChange={(event) => updateSelectedContainerMetadata({ graphContainerMode: event.target.value })}
              >
                {selectedStep.graphContainerType === "loop" ? [
                  <option key="for-each" value="for-each">For each</option>,
                  <option key="while" value="while">While</option>,
                ] : [
                  <option key="branch-one" value="branch-one">Run first matching branch</option>,
                  <option key="branch-all" value="branch-all">Run all matching branches</option>,
                ]}
              </select>
              {selectedStep.graphContainerType === "branch" ? (
                <textarea
                  key="branch-condition"
                  style={{ ...textareaStyle, minHeight: "58px" }}
                  value={selectedStep.graphContainerCondition}
                  placeholder="Branch condition"
                  onChange={(event) => updateSelectedContainerMetadata({ graphContainerCondition: event.target.value })}
                />
              ) : (
                <Fragment key="loop-settings">
                  <textarea
                    key="iterator"
                    style={{ ...textareaStyle, minHeight: "58px" }}
                    value={selectedStep.graphContainerIterator}
                    placeholder="Iterator expression"
                    onChange={(event) => updateSelectedContainerMetadata({ graphContainerIterator: event.target.value })}
                  />
                  <div key="loop-toggles" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
                    <label key="parallel" style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
                      <input
                        type="checkbox"
                        checked={selectedStep.graphContainerRunInParallel}
                        onChange={(event) => updateSelectedContainerMetadata({ graphContainerRunInParallel: event.target.checked })}
                      />
                      Run in parallel
                    </label>
                    <label key="skip-failure" style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
                      <input
                        type="checkbox"
                        checked={selectedStep.graphContainerSkipFailure}
                        onChange={(event) => updateSelectedContainerMetadata({ graphContainerSkipFailure: event.target.checked })}
                      />
                      Skip failure
                    </label>
                  </div>
                  <input
                    key="parallelism"
                    style={inputStyle}
                    type="number"
                    min={1}
                    step={1}
                    value={selectedStep.graphContainerParallelism}
                    placeholder="parallelism"
                    onChange={(event) => updateSelectedContainerMetadata({ graphContainerParallelism: event.target.value })}
                  />
                </Fragment>
              )}
              <button key="wrap" type="button" style={buttonStyle} onClick={wrapSelectedPathInContainer}>
                Wrap selected path
              </button>
              <button key="clear" type="button" style={buttonStyle} onClick={clearSelectedContainer}>
                Clear selected container
              </button>
            </div>
            <div key="run-overlay" style={{ display: "grid", gap: "6px", paddingTop: "8px", borderTop: "1px solid var(--border, #334155)" }}>
              <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Run overlay</span>
              <select
                style={selectStyle}
                value={selectedStep.graphRunStatus}
                onChange={(event) => updateSelected({ graphRunStatus: normalizeGraphRunStatus(event.target.value) })}
              >
                <option value="planned">Planned</option>
                <option value="running">Running</option>
                <option value="succeeded">Succeeded</option>
                <option value="failed">Failed</option>
                <option value="skipped">Skipped</option>
                <option value="paused">Paused</option>
              </select>
              <input
                style={inputStyle}
                value={selectedStep.graphRunIssueIdentifier}
                placeholder="Issue identifier"
                onChange={(event) => updateSelected({ graphRunIssueIdentifier: event.target.value })}
              />
              <input
                style={inputStyle}
                value={selectedStep.graphRunUpdatedAt}
                placeholder="Updated at"
                onChange={(event) => updateSelected({ graphRunUpdatedAt: event.target.value })}
              />
              <textarea
                style={{ ...textareaStyle, minHeight: "64px" }}
                value={selectedStep.graphRunSummary}
                placeholder="Run summary"
                onChange={(event) => updateSelected({ graphRunSummary: event.target.value })}
              />
            </div>
            <div key="sticky-note" style={{ display: "grid", gap: "4px" }}>
              <label style={{ ...mutedTextStyle, fontSize: "11px" }}>Sticky note</label>
              <textarea
                style={{ ...textareaStyle, minHeight: "72px" }}
                value={selectedStep.graphNote}
                placeholder="Markdown note for this node"
                onChange={(event) => setSelectedNote(event.target.value)}
              />
            </div>
              </details>
            </div>
            </Fragment>
            ) : (
              <Fragment key="selected-step-policy-placeholder" />
            )}
            {showRawInspector ? (
              <div
                key="selected-step-raw"
                style={{
                  display: "grid",
                  gap: "8px",
                  paddingTop: "8px",
                  borderTop: "1px solid var(--border, #334155)",
                }}
              >
                <div key="raw-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <span style={{ ...mutedTextStyle, fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.04em" }}>Selected step JSON</span>
                    <button
                      type="button"
                      title="Copy JSON to clipboard"
                      aria-label="Copy JSON"
                      style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: "22px", height: "22px", borderRadius: "4px", border: "1px solid var(--border, #334155)", background: "transparent", color: "var(--muted-foreground, #94a3b8)", cursor: "pointer", padding: 0 }}
                      onClick={() => {
                        navigator.clipboard.writeText(selectedRawStepJson).then(() => {
                          const btn = document.querySelector('[aria-label="Copy JSON"]');
                          if (btn) { btn.textContent = "✓"; setTimeout(() => { btn.textContent = "⧉"; }, 1500); }
                        });
                      }}
                    >
                      <span style={{ fontSize: "12px", lineHeight: 1 }}>⧉</span>
                    </button>
                  </div>
                  <span style={{ ...graphPolicyBadgeStyle, color: "#fbbf24" }}>{selectedStep.id}</span>
                </div>
                <textarea
                  key="raw-json"
                  readOnly
                  style={{
                    ...textareaStyle,
                    minHeight: "260px",
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                    fontSize: "11px",
                    lineHeight: 1.5,
                    color: "var(--foreground, #f8fafc)",
                    background: "color-mix(in srgb, var(--background, #020617) 88%, black)",
                  }}
                  value={selectedRawStepJson}
                  rows={14}
                />
                <p key="raw-note" style={{ margin: 0, color: "var(--muted-foreground, #94a3b8)", fontSize: "11px", lineHeight: 1.4 }}>
                  Raw JSON is read-only here. Use Edit or Policy for graph-safe changes, or switch to the JSON tab for bulk edits.
                </p>
              </div>
            ) : (
              <Fragment key="selected-step-raw-placeholder" />
            )}
          </div>
        ) : (
          <Fragment key="selected-step-editor-placeholder" />
        )}
      </aside>
    </div>
  );
}

function WorkflowRunGraphPreview({
  steps,
  pendingStepRunId,
  onRerunStep,
}: {
  steps: WorkflowGraphStep[];
  pendingStepRunId?: string | null;
  onRerunStep?: (input: { stepId: string; stepRunId: string; issueId: string }) => void;
}): JSX.Element | null {
  const graph = useMemo(() => buildWorkflowGraphModel(steps), [steps]);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [canvasScale, setCanvasScale] = useState(1);
  const [isCanvasPanning, setIsCanvasPanning] = useState(false);
  const [canvasPanX, setCanvasPanX] = useState(0);
  const [canvasPanY, setCanvasPanY] = useState(0);
  const [nodeDragOffsets, setNodeDragOffsets] = useState<Record<string, { dx: number; dy: number }>>({});
  const [draggingStepId, setDraggingStepId] = useState<string | null>(null);
  const [openingWorkProductId, setOpeningWorkProductId] = useState<string | null>(null);
  const [openedWorkProductId, setOpenedWorkProductId] = useState<string | null>(null);
  const [workProductOpenError, setWorkProductOpenError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const canvasPanRef = useRef<GraphCanvasPanState | null>(null);
  const nodeDragRef = useRef<{ stepId: string; pointerId: number; startClientX: number; startClientY: number; startDx: number; startDy: number; moved: boolean } | null>(null);
  const suppressNodeClickRef = useRef<string | null>(null);
  if (steps.length === 0 || graph.nodes.length === 0) return null;

  const selectedNode = graph.nodes.find((node) => node.step.id === selectedStepId)
    ?? graph.nodes.find((node) => node.runStatus.status === "failed")
    ?? graph.nodes.find((node) => node.runStatus.status === "running")
    ?? graph.nodes[0];
  const selectedGraphContext = selectedNode ? getWorkflowGraphStepContext(steps, selectedNode.step.id) : null;
  const canRerunSelected = Boolean(onRerunStep && selectedNode?.runStatus.stepRunId);
  const selectedPending = Boolean(selectedNode?.runStatus.stepRunId && pendingStepRunId === selectedNode.runStatus.stepRunId);
  const canvasWidth = Math.max(620, ...graph.nodes.map((node) => {
    const off = nodeDragOffsets[node.step.id];
    return node.x + (off?.dx ?? 0) + 230;
  }), 620);
  const canvasHeight = Math.max(260, ...graph.nodes.map((node) => {
    const off = nodeDragOffsets[node.step.id];
    return node.y + (off?.dy ?? 0) + 132;
  }), 260);

  async function handleOpenWorkProduct(product: WorkflowGraphWorkProduct): Promise<void> {
    setOpeningWorkProductId(product.id);
    setOpenedWorkProductId(null);
    setWorkProductOpenError(null);
    try {
      await issuesApi.openWorkProduct(product.id);
      setOpenedWorkProductId(product.id);
    } catch (error) {
      setWorkProductOpenError(error instanceof Error ? error.message : "Failed to open work product");
    } finally {
      setOpeningWorkProductId(null);
    }
  }

  function getNodeOffset(stepId: string): { dx: number; dy: number } {
    return nodeDragOffsets[stepId] ?? { dx: 0, dy: 0 };
  }

  function beginRunNodeDrag(event: React.PointerEvent<HTMLButtonElement>, stepId: string): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const current = getNodeOffset(stepId);
    nodeDragRef.current = {
      stepId,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startDx: current.dx,
      startDy: current.dy,
      moved: false,
    };
    setDraggingStepId(stepId);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleRunNodePointerMove(event: React.PointerEvent<HTMLButtonElement>): void {
    const drag = nodeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = (event.clientX - drag.startClientX) / canvasScale;
    const deltaY = (event.clientY - drag.startClientY) / canvasScale;
    if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) drag.moved = true;
    setNodeDragOffsets((prev) => ({
      ...prev,
      [drag.stepId]: { dx: drag.startDx + deltaX, dy: drag.startDy + deltaY },
    }));
  }

  function endRunNodeDrag(event: React.PointerEvent<HTMLButtonElement>): void {
    const drag = nodeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.moved) suppressNodeClickRef.current = drag.stepId;
    nodeDragRef.current = null;
    setDraggingStepId(null);
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* noop */ }
  }

  function handleRunNodeClick(event: React.MouseEvent<HTMLButtonElement>, stepId: string): void {
    if (suppressNodeClickRef.current === stepId) {
      suppressNodeClickRef.current = null;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    setSelectedStepId(stepId);
  }

  useEffect(() => {
    const container = canvasRef.current;
    if (!container) return undefined;
    const handleWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const direction = event.deltaY > 0 ? -1 : 1;
      const nextScale = clampGraphCanvasScale(canvasScale + direction * 0.1);
      const rect = container.getBoundingClientRect();
      const offsetX = event.clientX - rect.left;
      const offsetY = event.clientY - rect.top;
      const graphX = (-canvasPanX + offsetX) / canvasScale;
      const graphY = (-canvasPanY + offsetY) / canvasScale;
      setCanvasScale(nextScale);
      setCanvasPanX(offsetX - graphX * nextScale);
      setCanvasPanY(offsetY - graphY * nextScale);
    };
    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, [canvasScale, canvasPanX, canvasPanY]);

  function beginCanvasPan(event: React.PointerEvent<HTMLDivElement>): void {
    const target = event.target as HTMLElement;
    if (target.closest("[data-graph-node='true'], [data-graph-toolbar='true'], [data-graph-menu='true'], [data-graph-edge='true'], [data-graph-handle='true'], [data-graph-edge-remove='true']")) return;
    if (event.button !== 0 && event.button !== 1) return;
    canvasPanRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPanX: canvasPanX,
      startPanY: canvasPanY,
    };
    setIsCanvasPanning(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleCanvasPointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    const pan = canvasPanRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    setCanvasPanX(pan.startPanX + (event.clientX - pan.startClientX));
    setCanvasPanY(pan.startPanY + (event.clientY - pan.startClientY));
  }

  function endCanvasPan(event: React.PointerEvent<HTMLDivElement>): void {
    const pan = canvasPanRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    canvasPanRef.current = null;
    setIsCanvasPanning(false);
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* noop */ }
  }

  return (
    <div style={{ display: "grid", gap: "8px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
        <span style={{ ...mutedTextStyle, fontWeight: 600 }}>Run graph</span>
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
          {(["planned", "running", "succeeded", "failed", "skipped", "paused"] as const).map((status) => (
            <span key={status} style={{ ...statusBadgeStyle(status), fontSize: "10px" }}>{status}</span>
          ))}
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(420px, 1fr) 260px", gap: "10px", alignItems: "stretch" }}>
        <div
          ref={canvasRef}
          style={{ ...graphCanvasStyle, minHeight: "260px", cursor: isCanvasPanning ? "grabbing" : "grab" }}
          onPointerDown={beginCanvasPan}
          onPointerMove={handleCanvasPointerMove}
          onPointerUp={endCanvasPan}
          onPointerCancel={endCanvasPan}
        >
          <div key="run-graph-view-tools-layer" style={graphCanvasViewToolLayerStyle}>
            <div key="run-graph-view-tools" data-graph-toolbar="true" style={graphCanvasViewToolDockStyle}>
              <div key="view-tools" aria-label="Canvas view tools" style={graphCanvasToolGroupStyle}>
                <span style={graphCanvasToolLabelStyle}>View</span>
                <button type="button" style={graphCanvasToolButtonStyle} title="Zoom out" aria-label="Zoom out" onClick={() => setCanvasScale(clampGraphCanvasScale(canvasScale - 0.1))}>&minus;</button>
                <span style={{ fontSize: "11px", color: "var(--muted-foreground, #94a3b8)", minWidth: "32px", textAlign: "center" }}>{Math.round(canvasScale * 100)}%</span>
                <button type="button" style={graphCanvasToolButtonStyle} title="Zoom in" aria-label="Zoom in" onClick={() => setCanvasScale(clampGraphCanvasScale(canvasScale + 0.1))}>+</button>
                <button type="button" style={graphCanvasToolButtonStyle} title="Reset zoom" aria-label="Reset zoom" onClick={() => { setCanvasScale(1); setCanvasPanX(0); setCanvasPanY(0); }}>&#8634;</button>
              </div>
            </div>
          </div>
          <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
          <div style={{ position: "absolute", top: 0, left: 0, width: `${canvasWidth}px`, height: `${canvasHeight}px`, overflow: "visible", transform: `translate(${canvasPanX}px, ${canvasPanY}px) scale(${canvasScale})`, transformOrigin: "0 0", transition: isCanvasPanning ? "none" : "transform 140ms ease", pointerEvents: "none" }}>
          {graph.containers.map((container) => {
            const color = containerColor(container.type);
            return (
              <div
                key={container.id}
                style={{
                  position: "absolute",
                  left: container.x,
                  top: container.y,
                  width: container.width,
                  height: container.height,
                  border: `1px dashed ${color}`,
                  borderRadius: "8px",
                  background: `color-mix(in srgb, ${color} 8%, transparent)`,
                  pointerEvents: "none",
                }}
              >
                <div
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    maxWidth: "calc(100% - 16px)",
                    margin: "6px",
                    padding: "3px 7px",
                    borderRadius: "6px",
                    background: "var(--background, #020617)",
                    color,
                    fontSize: "11px",
                    fontWeight: 700,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  <span style={{ textTransform: "uppercase" }}>{container.type}</span>
                  <span>{container.title}</span>
                </div>
                {container.badges.length > 0 ? (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", margin: "0 8px" }}>
                    {container.badges.map((badge) => (
                      <span key={badge} style={{ ...graphPolicyBadgeStyle, color }}>{badge}</span>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
          {graph.groups.filter((group) => !group.collapsed).map((group) => (
            <div
              key={group.id}
              style={{
                position: "absolute",
                left: group.x,
                top: group.y,
                width: group.width,
                height: group.height,
                border: `1px solid ${group.color}`,
                borderRadius: "8px",
                background: `color-mix(in srgb, ${group.color} 10%, transparent)`,
                pointerEvents: "none",
              }}
            >
              <div
                style={{
                  display: "inline-flex",
                  maxWidth: "calc(100% - 16px)",
                  margin: "6px",
                  padding: "3px 7px",
                  borderRadius: "6px",
                  background: "var(--background, #020617)",
                  color: group.color,
                  fontSize: "11px",
                  fontWeight: 700,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {group.title}
              </div>
            </div>
          ))}
          <svg
            aria-hidden="true"
            width={canvasWidth}
            height={canvasHeight}
            style={{ position: "absolute", inset: 0, overflow: "visible", pointerEvents: "none" }}
          >
            <defs>
              <marker id="workflow-run-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                <path d="M0,0 L8,4 L0,8 Z" fill="var(--muted-foreground, #94a3b8)" />
              </marker>
            </defs>
            {graph.edges.map((edge) => {
              const source = graph.nodes.find((node) => node.id === edge.source);
              const target = graph.nodes.find((node) => node.id === edge.target);
              if (!source || !target) return null;
              const sOff = getNodeOffset(source.step.id);
              const tOff = getNodeOffset(target.step.id);
              const startX = source.x + sOff.dx + 172;
              const startY = source.y + sOff.dy + 38;
              const endX = target.x + tOff.dx;
              const endY = target.y + tOff.dy + 38;
              const midX = startX + Math.max(34, (endX - startX) / 2);
              return (
                <g key={edge.id}>
                  <path
                    d={`M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX - 8} ${endY}`}
                    fill="none"
                    stroke={graphEdgeColor(edge.kind)}
                    strokeWidth={edge.kind === "failure" ? "2" : "1.5"}
                    strokeDasharray={graphEdgeDashArray(edge.kind)}
                    markerEnd="url(#workflow-run-arrow)"
                  />
                  {graphEdgeDisplayLabel(edge) ? (
                    <text
                      x={midX}
                      y={(startY + endY) / 2 - 6}
                      fill={graphEdgeColor(edge.kind)}
                      fontSize="11"
                      fontWeight="700"
                      textAnchor="middle"
                    >
                      {graphEdgeDisplayLabel(edge)}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </svg>
            {graph.nodes.map((node) => {
              const selected = selectedNode?.step.id === node.step.id;
              const off = getNodeOffset(node.step.id);
              return (
            <button
              key={node.id || node.order}
              type="button"
              style={{ ...graphNodeStyle(selected, node.kind), left: node.x + off.dx, top: node.y + off.dy, cursor: draggingStepId === node.step.id ? "grabbing" : "grab", touchAction: "none", pointerEvents: "auto" }}
              onPointerDown={(event) => beginRunNodeDrag(event, node.step.id)}
              onPointerMove={handleRunNodePointerMove}
              onPointerUp={endRunNodeDrag}
              onPointerCancel={endRunNodeDrag}
              onClick={(event) => handleRunNodeClick(event, node.step.id)}
            >
              <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                <span style={{ fontSize: "11px", color: "var(--muted-foreground, #94a3b8)", textTransform: "uppercase" }}>
                  {node.kind}
                </span>
                <span style={{ ...statusBadgeStyle(node.runStatus.status), fontSize: "10px" }}>
                  {node.runStatus.status}
                </span>
              </span>
              <span style={{ display: "block", marginTop: "6px", fontSize: "13px", fontWeight: 700, overflowWrap: "anywhere" }}>
                {node.label}
              </span>
              <span style={{ display: "block", marginTop: "4px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "11px", color: "var(--muted-foreground, #94a3b8)", overflowWrap: "anywhere" }}>
                L{node.layer} · {node.id || "(no id)"}
              </span>
              {node.advanced.badges.length > 0 ? (
                <span style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "6px" }}>
                  {node.advanced.badges.map((badge) => (
                    <span key={badge} style={graphPolicyBadgeStyle}>{badge}</span>
                  ))}
                </span>
              ) : null}
              {node.dataFlow.badges.length > 0 ? (
                <span style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "6px" }}>
                  {node.dataFlow.badges.map((badge) => (
                    <span key={badge} style={{ ...graphPolicyBadgeStyle, color: "#a78bfa" }}>{badge}</span>
                  ))}
                </span>
              ) : null}
              {node.resources.badges.length > 0 ? (
                <span style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "6px" }}>
                  {node.resources.badges.map((badge) => (
                    <span key={badge} style={{ ...graphPolicyBadgeStyle, color: "#34d399" }}>{badge}</span>
                  ))}
                </span>
              ) : null}
              {node.runStatus.runtimeBadges.length > 0 ? (
                <span style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "6px" }}>
                  {node.runStatus.runtimeBadges.map((badge) => (
                    <span key={badge} style={{ ...graphPolicyBadgeStyle, color: "#f97316" }}>{badge}</span>
                  ))}
                </span>
              ) : null}
              {node.runStatus.issueIdentifier ? (
                <span style={{ display: "block", marginTop: "5px", fontSize: "11px", color: "var(--muted-foreground, #94a3b8)", overflowWrap: "anywhere" }}>
                  Issue: {node.runStatus.issueIdentifier}
                </span>
              ) : null}
              {node.runStatus.workProducts.length > 0 ? (
                <span style={{ display: "block", marginTop: "5px", fontSize: "11px", color: "var(--muted-foreground, #94a3b8)", overflowWrap: "anywhere" }}>
                  Outputs: {node.runStatus.workProducts.length}
                </span>
              ) : null}
              {node.runStatus.updatedAt ? (
                <span style={{ display: "block", marginTop: "5px", fontSize: "11px", color: "var(--muted-foreground, #94a3b8)", overflowWrap: "anywhere" }}>
                  {formatDateTime(node.runStatus.updatedAt)}
                </span>
              ) : null}
              {node.runStatus.summary ? (
                <span style={{ display: "block", marginTop: "5px", fontSize: "11px", color: "var(--muted-foreground, #94a3b8)", overflowWrap: "anywhere" }}>
                  {node.runStatus.summary}
                </span>
              ) : null}
            </button>
              );
            })}
          </div>
          </div>
        </div>
        <div style={{ ...graphSidebarStyle, minHeight: "260px" }}>
          <div>
            <p style={{ ...mutedTextStyle, fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.04em" }}>
              Run graph actions
            </p>
            <p style={{ margin: "4px 0 0", fontSize: "14px", fontWeight: 700 }}>{selectedNode?.label ?? "none"}</p>
          </div>
          {selectedNode ? (
            <>
              <div style={{ display: "grid", gap: "5px" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                  <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Status</span>
                  <span style={{ ...statusBadgeStyle(selectedNode.runStatus.status), fontSize: "10px" }}>
                    {selectedNode.runStatus.status}
                  </span>
                </div>
                <div style={{ display: "grid", gap: "2px" }}>
                  <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Step run</span>
                  <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "11px", color: "var(--muted-foreground, #94a3b8)", overflowWrap: "anywhere" }}>
                    {selectedNode.runStatus.stepRunId || "-"}
                  </span>
                </div>
                <div style={{ display: "grid", gap: "2px" }}>
                  <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Issue</span>
                  {selectedNode.runStatus.issueId ? (
                    <a
                      href={buildIssueHref({
                        issueId: selectedNode.runStatus.issueId,
                        issueIdentifier: selectedNode.runStatus.issueIdentifier,
                        currentPathname: currentBrowserPathname(),
                      })}
                      style={{ color: "var(--link, #60a5fa)", fontSize: "12px", textDecoration: "none", overflowWrap: "anywhere" }}
                      title={selectedNode.runStatus.issueId}
                    >
                      {selectedNode.runStatus.issueIdentifier || selectedNode.runStatus.issueId.slice(0, 8)}
                    </a>
                  ) : (
                    <span style={mutedTextStyle}>-</span>
                  )}
                </div>
              </div>
              {selectedNode.dataFlow.badges.length > 0 ? (
                <div style={{ display: "grid", gap: "6px", paddingTop: "8px", borderTop: "1px solid var(--border, #334155)" }}>
                  <span style={{ ...mutedTextStyle, fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                    Data flow
                  </span>
                  {selectedNode.dataFlow.inputExpression ? (
                    <div style={{ display: "grid", gap: "2px" }}>
                      <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Input transform</span>
                      <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "11px", color: "var(--foreground, #f8fafc)", overflowWrap: "anywhere" }}>
                        {selectedNode.dataFlow.inputExpression}
                      </span>
                    </div>
                  ) : null}
                  {selectedNode.dataFlow.outputSchema ? (
                    <div style={{ display: "grid", gap: "2px" }}>
                      <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Output schema</span>
                      <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "11px", color: "var(--foreground, #f8fafc)", overflowWrap: "anywhere" }}>
                        {selectedNode.dataFlow.outputSchema}
                      </span>
                    </div>
                  ) : null}
                  {selectedNode.dataFlow.workProductRequired || selectedNode.dataFlow.workProductPattern ? (
                    <div style={{ display: "grid", gap: "2px" }}>
                      <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Work product</span>
                      <span style={{ fontSize: "12px", color: "var(--foreground, #f8fafc)", overflowWrap: "anywhere" }}>
                        {selectedNode.dataFlow.workProductRequired ? "Required" : "Optional"}
                        {selectedNode.dataFlow.workProductPattern ? ` · ${selectedNode.dataFlow.workProductPattern}` : ""}
                      </span>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {selectedNode.runStatus.resultPreview || selectedNode.runStatus.logPreview ? (
                <div style={{ display: "grid", gap: "8px", paddingTop: "8px", borderTop: "1px solid var(--border, #334155)" }}>
                  <span style={{ ...mutedTextStyle, fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                    Step preview
                  </span>
                  {selectedNode.runStatus.resultPreview ? (
                    <div style={{ display: "grid", gap: "3px" }}>
                      <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Result preview</span>
                      <pre style={{ margin: 0, maxHeight: "120px", overflow: "auto", padding: "8px", border: "1px solid var(--border, #334155)", borderRadius: "8px", background: "var(--card, #0f172a)", color: "var(--foreground, #f8fafc)", fontSize: "11px", lineHeight: 1.35, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                        {selectedNode.runStatus.resultPreview}
                      </pre>
                    </div>
                  ) : null}
                  {selectedNode.runStatus.logPreview ? (
                    <div style={{ display: "grid", gap: "3px" }}>
                      <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Log preview</span>
                      <pre style={{ margin: 0, maxHeight: "120px", overflow: "auto", padding: "8px", border: "1px solid var(--border, #334155)", borderRadius: "8px", background: "var(--card, #0f172a)", color: "var(--muted-foreground, #94a3b8)", fontSize: "11px", lineHeight: 1.35, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                        {selectedNode.runStatus.logPreview}
                      </pre>
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div style={{ display: "grid", gap: "6px", paddingTop: "8px", borderTop: "1px solid var(--border, #334155)" }}>
                <span style={{ ...mutedTextStyle, fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  Work products
                </span>
                {selectedNode.runStatus.workProducts.length > 0 ? (
                  <div style={{ display: "grid", gap: "6px" }}>
                    {selectedNode.runStatus.workProducts.map((product) => (
                      <div
                        key={product.id}
                        style={{
                          display: "grid",
                          gap: "4px",
                          padding: "8px",
                          border: "1px solid var(--border, #334155)",
                          borderRadius: "8px",
                          background: "var(--card, #0f172a)",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "8px" }}>
                          <div style={{ display: "grid", gap: "4px", minWidth: 0 }}>
                            {product.url ? (
                              <a
                                href={product.url}
                                target="_blank"
                                rel="noreferrer"
                                style={{ color: "var(--link, #60a5fa)", fontSize: "12px", fontWeight: 700, textDecoration: "none", overflowWrap: "anywhere" }}
                              >
                                {product.title}
                              </a>
                            ) : (
                              <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--foreground, #f8fafc)", overflowWrap: "anywhere" }}>
                                {product.title}
                              </span>
                            )}
                            {openedWorkProductId === product.id ? (
                              <span style={{ ...mutedTextStyle, fontSize: "11px", color: "#34d399" }}>Opened</span>
                            ) : null}
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: "6px", flex: "0 0 auto" }}>
                            {product.isPrimary ? (
                              <span style={{ ...graphPolicyBadgeStyle, flex: "0 0 auto" }}>Primary</span>
                            ) : null}
                            <button
                              type="button"
                              onClick={() => void handleOpenWorkProduct(product)}
                              disabled={openingWorkProductId === product.id}
                              style={{ ...buttonStyle, padding: "4px 8px", fontSize: "11px", lineHeight: 1.2 }}
                              title="Open with the operating system"
                            >
                              {openingWorkProductId === product.id ? "Opening" : "Open"}
                            </button>
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: "5px", flexWrap: "wrap" }}>
                          {product.type ? <span style={graphPolicyBadgeStyle}>{product.type}</span> : null}
                          {product.status ? <span style={graphPolicyBadgeStyle}>{product.status}</span> : null}
                        </div>
                        {product.summary ? (
                          <p style={{ margin: 0, color: "var(--muted-foreground, #94a3b8)", fontSize: "11px", lineHeight: 1.35, overflowWrap: "anywhere" }}>
                            {product.summary}
                          </p>
                        ) : null}
                      </div>
                    ))}
                    {workProductOpenError ? (
                      <p style={{ margin: 0, color: "var(--destructive, #ef4444)", fontSize: "11px", lineHeight: 1.35, overflowWrap: "anywhere" }}>
                        {workProductOpenError}
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <span style={mutedTextStyle}>No registered outputs for this step.</span>
                )}
              </div>
              <div style={{ display: "grid", gap: "6px", paddingTop: "8px", borderTop: "1px solid var(--border, #334155)" }}>
                <span style={{ ...mutedTextStyle, fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  Execution details
                </span>
                <div style={{ display: "grid", gap: "5px" }}>
                  <div style={{ display: "grid", gap: "2px" }}>
                    <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Started</span>
                    <span style={{ fontSize: "12px", color: "var(--foreground, #f8fafc)", overflowWrap: "anywhere" }}>
                      {selectedNode.runStatus.startedAt ? formatDateTime(selectedNode.runStatus.startedAt) : "-"}
                    </span>
                  </div>
                  <div style={{ display: "grid", gap: "2px" }}>
                    <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Completed</span>
                    <span style={{ fontSize: "12px", color: "var(--foreground, #f8fafc)", overflowWrap: "anywhere" }}>
                      {selectedNode.runStatus.completedAt ? formatDateTime(selectedNode.runStatus.completedAt) : "-"}
                    </span>
                  </div>
                  <div style={{ display: "grid", gap: "2px" }}>
                    <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Dispatch attempt</span>
                    <span style={{ fontSize: "12px", color: "var(--foreground, #f8fafc)", overflowWrap: "anywhere" }}>
                      {selectedNode.runStatus.lastDispatchAttemptAt ? formatDateTime(selectedNode.runStatus.lastDispatchAttemptAt) : "-"}
                    </span>
                  </div>
                  <div style={{ display: "grid", gap: "2px" }}>
                    <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Dispatch accepted</span>
                    <span style={{ fontSize: "12px", color: "var(--foreground, #f8fafc)", overflowWrap: "anywhere" }}>
                      {selectedNode.runStatus.lastDispatchAcceptedAt ? formatDateTime(selectedNode.runStatus.lastDispatchAcceptedAt) : "-"}
                    </span>
                  </div>
                  <div style={{ display: "grid", gap: "2px" }}>
                    <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Dispatch request</span>
                    <span style={{ fontSize: "12px", color: "var(--foreground, #f8fafc)", overflowWrap: "anywhere" }}>
                      {selectedNode.runStatus.lastDispatchRequestId || "-"}
                    </span>
                  </div>
                  <div style={{ display: "grid", gap: "2px" }}>
                    <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Dispatch error at</span>
                    <span style={{ fontSize: "12px", color: selectedNode.runStatus.lastDispatchErrorAt ? "var(--destructive, #ef4444)" : "var(--foreground, #f8fafc)", overflowWrap: "anywhere" }}>
                      {selectedNode.runStatus.lastDispatchErrorAt ? formatDateTime(selectedNode.runStatus.lastDispatchErrorAt) : "-"}
                    </span>
                  </div>
                  {selectedNode.runStatus.lastDispatchErrorSummary ? (
                    <div style={{ display: "grid", gap: "2px" }}>
                      <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Dispatch error</span>
                      <span style={{ fontSize: "12px", color: "var(--destructive, #ef4444)", overflowWrap: "anywhere", lineHeight: 1.35 }}>
                        {selectedNode.runStatus.lastDispatchErrorSummary}
                      </span>
                    </div>
                  ) : null}
                  {selectedNode.runStatus.concurrencyBlocked ? (
                    <div style={{ display: "grid", gap: "2px" }}>
                      <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Concurrency blocked</span>
                      <span style={{ fontSize: "12px", color: "#f97316", overflowWrap: "anywhere", lineHeight: 1.35 }}>
                        {selectedNode.runStatus.concurrencyBlocked.concurrencyKey}
                        {selectedNode.runStatus.concurrencyBlocked.concurrencyLimit !== null
                          ? ` limit ${selectedNode.runStatus.concurrencyBlocked.concurrencyLimit}`
                          : ""}
                        {selectedNode.runStatus.concurrencyBlocked.runningCount !== null
                          ? `, running ${selectedNode.runStatus.concurrencyBlocked.runningCount}`
                          : ""}
                        {selectedNode.runStatus.concurrencyBlocked.checkedAt
                          ? `, checked ${formatDateTime(selectedNode.runStatus.concurrencyBlocked.checkedAt)}`
                          : ""}
                      </span>
                    </div>
                  ) : null}
                  {selectedNode.runStatus.retentionDeleted ? (
                    <div style={{ display: "grid", gap: "2px" }}>
                      <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Retention</span>
                      <span style={{ fontSize: "12px", color: "#f97316", overflowWrap: "anywhere", lineHeight: 1.35 }}>
                        Deleted after use
                        {selectedNode.runStatus.retentionDeleted.toolName ? ` by ${selectedNode.runStatus.retentionDeleted.toolName}` : ""}
                        {selectedNode.runStatus.retentionDeleted.deletedAt
                          ? ` at ${formatDateTime(selectedNode.runStatus.retentionDeleted.deletedAt)}`
                          : ""}
                      </span>
                    </div>
                  ) : null}
                </div>
              </div>
              <button
                type="button"
                style={!canRerunSelected || selectedPending ? { ...buttonStyle, ...buttonDisabledStyle } : buttonStyle}
                disabled={!canRerunSelected || selectedPending}
                onClick={() => {
                  if (!selectedNode?.runStatus.stepRunId || !onRerunStep) return;
                  onRerunStep({
                    stepId: selectedNode.step.id,
                    stepRunId: selectedNode.runStatus.stepRunId,
                    issueId: selectedNode.runStatus.issueId,
                  });
                }}
              >
                {selectedPending ? "Rerunning..." : "Rerun selected step"}
              </button>
              <p style={{ ...mutedTextStyle, fontSize: "11px" }}>
                Rerun uses the same workflow step recovery action as the table below.
              </p>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function WorkflowDraftDiffSummary({ diff }: { diff: WorkflowGraphDraftDiff }): JSX.Element {
  const detailItems = [
    ...diff.addedSteps.map((id) => `+ step ${id}`),
    ...diff.removedSteps.map((id) => `- step ${id}`),
    ...diff.changedSteps.map((step) => `~ step ${step.id}: ${step.fields.join(", ")}`),
    ...diff.addedEdges.map((id) => `+ edge ${id}`),
    ...diff.removedEdges.map((id) => `- edge ${id}`),
    ...diff.changedEdges.map((id) => `~ edge ${id}`),
  ].slice(0, 8);

  return (
    <div style={{ display: "grid", gap: "7px", padding: "10px", border: "1px solid var(--border, #334155)", borderRadius: "8px", background: "color-mix(in srgb, var(--card, #0f172a) 82%, var(--background, #020617))" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
        <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--foreground, #f8fafc)" }}>Draft diff</span>
        <span style={{ ...graphPolicyBadgeStyle, color: diff.hasChanges ? "#fbbf24" : "#34d399" }}>
          {diff.hasChanges ? "Unsaved graph changes" : "Draft matches saved graph"}
        </span>
      </div>
      <div style={{ display: "flex", gap: "5px", flexWrap: "wrap" }}>
        {diff.summary.map((item) => (
          <span key={item} style={graphPolicyBadgeStyle}>{item}</span>
        ))}
      </div>
      {detailItems.length > 0 ? (
        <div style={{ display: "grid", gap: "3px" }}>
          {detailItems.map((item) => (
            <span key={item} style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "11px", color: "var(--muted-foreground, #94a3b8)", overflowWrap: "anywhere" }}>
              {item}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function WorkflowInterfaceSummary({ summary }: { summary: WorkflowGraphInterfaceSummary }): JSX.Element {
  return (
    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
      <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--foreground, #f8fafc)" }}>Flow interface</span>
      {summary.badges.map((badge) => (
        <span key={badge} style={statusBadgeStyle(badge === "No flow interface" ? "pending" : "running")}>{badge}</span>
      ))}
    </div>
  );
}

function WorkflowInterfaceFields({
  flowInputsText,
  flowEnvVariablesText,
  testInputPresetsText,
  onFlowInputsTextChange,
  onFlowEnvVariablesTextChange,
  onTestInputPresetsTextChange,
  summary,
  testInputLibrary,
}: {
  flowInputsText: string;
  flowEnvVariablesText: string;
  testInputPresetsText: string;
  onFlowInputsTextChange: (value: string) => void;
  onFlowEnvVariablesTextChange: (value: string) => void;
  onTestInputPresetsTextChange: (value: string) => void;
  summary: WorkflowGraphInterfaceSummary;
  testInputLibrary: WorkflowGraphTestInputLibrarySummary;
}): JSX.Element {
  return (
    <div style={{ display: "grid", gap: "8px", padding: "8px", border: "1px solid var(--border, #334155)", borderRadius: "8px" }}>
      <WorkflowInterfaceSummary summary={summary} />
      <div style={{ display: "flex", gap: "5px", flexWrap: "wrap" }}>
        {testInputLibrary.badges.map((badge) => (
          <span key={badge} style={{ ...graphPolicyBadgeStyle, color: "#38bdf8" }}>{badge}</span>
        ))}
      </div>
      <label style={{ display: "grid", gap: "4px" }}>
        <span style={mutedTextStyle}>Flow inputs JSON</span>
        <textarea
          style={{ ...textareaStyle, minHeight: "90px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px" }}
          value={flowInputsText}
          onChange={(event) => onFlowInputsTextChange(event.target.value)}
          rows={4}
        />
      </label>
      <label style={{ display: "grid", gap: "4px" }}>
        <span style={mutedTextStyle}>Flow env variables JSON</span>
        <textarea
          style={{ ...textareaStyle, minHeight: "90px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px" }}
          value={flowEnvVariablesText}
          onChange={(event) => onFlowEnvVariablesTextChange(event.target.value)}
          rows={4}
        />
      </label>
      <label style={{ display: "grid", gap: "4px" }}>
        <span style={mutedTextStyle}>Saved test inputs JSON</span>
        <textarea
          style={{ ...textareaStyle, minHeight: "90px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px" }}
          value={testInputPresetsText}
          onChange={(event) => onTestInputPresetsTextChange(event.target.value)}
          rows={4}
        />
      </label>
    </div>
  );
}

function WorkflowExportPreview({
  snapshot,
  onApplyYaml,
}: {
  snapshot: WorkflowGraphExportSnapshot;
  onApplyYaml: (snapshot: WorkflowGraphExportSnapshot) => void;
}): JSX.Element {
  const [format, setFormat] = useState<WorkflowGraphExportFormat>("json");
  const [yamlText, setYamlText] = useState<string>("");
  const [yamlError, setYamlError] = useState<string>("");
  const exportText = useMemo(() => serializeWorkflowGraphExportSnapshot(snapshot, format), [snapshot, format]);
  useEffect(() => {
    if (format === "yaml") {
      setYamlText(serializeWorkflowGraphExportSnapshot(snapshot, "yaml"));
      setYamlError("");
    }
  }, [format, snapshot]);

  function applyYaml(): void {
    const parsed = parseWorkflowGraphYamlDraft(yamlText);
    if (parsed.error) {
      setYamlError(parsed.error);
      return;
    }
    setYamlError("");
    onApplyYaml(parsed.snapshot);
  }

  return (
    <div style={{ display: "grid", gap: "8px", padding: "8px", border: "1px solid var(--border, #334155)", borderRadius: "8px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
        <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--foreground, #f8fafc)" }}>Export / YAML edit</span>
        <div style={{ display: "flex", gap: "6px" }}>
          {(["json", "yaml"] as WorkflowGraphExportFormat[]).map((entry) => (
            <button
              key={entry}
              type="button"
              style={format === entry ? primaryButtonStyle : buttonStyle}
              onClick={() => setFormat(entry)}
            >
              {entry.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      {format === "yaml" ? (
        <Fragment>
          <textarea
            style={{ ...textareaStyle, minHeight: "190px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px" }}
            value={yamlText}
            onChange={(event) => setYamlText(event.target.value)}
            rows={8}
          />
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
            {yamlError ? <span style={{ ...mutedTextStyle, color: "#f87171" }}>{yamlError}</span> : <span style={mutedTextStyle}>Edit YAML applies to the current draft.</span>}
            <button type="button" style={primaryButtonStyle} onClick={applyYaml}>Apply YAML</button>
          </div>
        </Fragment>
      ) : (
        <textarea
          readOnly
          style={{ ...textareaStyle, minHeight: "160px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px" }}
          value={exportText}
          rows={7}
        />
      )}
    </div>
  );
}

function WorkflowTestPlanPreview({
  steps,
  interfaceInput,
}: {
  steps: StepDraft[];
  interfaceInput?: WorkflowGraphInterfaceInput;
}): JSX.Element {
  const targetOptions = useMemo(
    () => steps.map((step) => step.id.trim()).filter(Boolean),
    [steps],
  );
  const iterationLoopOptions = useMemo(
    () => buildWorkflowGraphModel(steps).containers.filter((container) => container.type === "loop"),
    [steps],
  );
  const [targetStepId, setTargetStepId] = useState<string>(targetOptions.at(-1) ?? "");
  const [restartStepId, setRestartStepId] = useState<string>(targetOptions[0] ?? "");
  const [singleStepTestId, setSingleStepTestId] = useState<string>(targetOptions[0] ?? "");
  const [iterationContainerId, setIterationContainerId] = useState<string>(iterationLoopOptions[0]?.id ?? "");
  const [iterationIndexText, setIterationIndexText] = useState<string>("0");
  const [iterationItemText, setIterationItemText] = useState<string>("{}");
  useEffect(() => {
    if (targetOptions.length === 0) {
      if (targetStepId) setTargetStepId("");
      if (restartStepId) setRestartStepId("");
      if (singleStepTestId) setSingleStepTestId("");
      return;
    }
    if (!targetOptions.includes(targetStepId)) {
      setTargetStepId(targetOptions.at(-1) ?? "");
    }
    if (!targetOptions.includes(restartStepId)) {
      setRestartStepId(targetOptions[0] ?? "");
    }
    if (!targetOptions.includes(singleStepTestId)) {
      setSingleStepTestId(targetOptions[0] ?? "");
    }
  }, [restartStepId, singleStepTestId, targetOptions, targetStepId]);
  useEffect(() => {
    if (iterationLoopOptions.length === 0) {
      if (iterationContainerId) setIterationContainerId("");
      return;
    }
    if (!iterationLoopOptions.some((container) => container.id === iterationContainerId)) {
      setIterationContainerId(iterationLoopOptions[0]?.id ?? "");
    }
  }, [iterationContainerId, iterationLoopOptions]);

  const plan = useMemo<WorkflowGraphTestPlan>(
    () => buildWorkflowGraphTestPlan(steps, targetStepId),
    [steps, targetStepId],
  );
  const executionPreview = useMemo<WorkflowGraphTestExecutionPreview>(
    () => buildWorkflowGraphTestExecutionPreview(steps, targetStepId),
    [steps, targetStepId],
  );
  const restartPreview = useMemo<WorkflowGraphRestartPreview>(
    () => buildWorkflowGraphRestartPreview(steps, restartStepId),
    [restartStepId, steps],
  );
  const inputLibrary = useMemo<WorkflowGraphTestInputLibrarySummary>(
    () => summarizeWorkflowGraphTestInputLibrary(interfaceInput ?? {}),
    [interfaceInput],
  );
  const [selectedTestPresetName, setSelectedTestPresetName] = useState<string>("");
  useEffect(() => {
    if (selectedTestPresetName && !inputLibrary.presets.some((preset) => preset.name === selectedTestPresetName)) {
      setSelectedTestPresetName("");
    }
  }, [inputLibrary.presets, selectedTestPresetName]);
  const [requestFillText, setRequestFillText] = useState<string>("");
  const requestFillPreview = useMemo<WorkflowGraphRequestFillPreview>(
    () => buildWorkflowGraphRequestFillPreview(interfaceInput ?? {}, requestFillText),
    [interfaceInput, requestFillText],
  );
  const requestFillArguments = requestFillText.trim() && !requestFillPreview.error ? requestFillPreview.arguments : undefined;
  const requestPreview = useMemo<WorkflowGraphTestRequestPreview>(
    () => buildWorkflowGraphTestRequestPreview(interfaceInput ?? {}, selectedTestPresetName, requestFillArguments),
    [interfaceInput, requestFillArguments, selectedTestPresetName],
  );
  const singleStepPreview = useMemo<WorkflowGraphSingleStepTestPreview>(
    () => buildWorkflowGraphSingleStepTestPreview(steps, singleStepTestId, interfaceInput ?? {}, requestPreview.arguments),
    [interfaceInput, requestPreview.arguments, singleStepTestId, steps],
  );
  const iterationIndex = useMemo(() => {
    const parsed = Number(iterationIndexText.trim());
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
  }, [iterationIndexText]);
  const iterationItemPreview = useMemo<{ value: unknown; error: string }>(() => {
    const trimmed = iterationItemText.trim();
    if (!trimmed) {
      return { value: {}, error: "" };
    }
    try {
      return { value: JSON.parse(trimmed) as unknown, error: "" };
    } catch (error) {
      return {
        value: {},
        error: error instanceof Error ? error.message : "Invalid iteration item JSON",
      };
    }
  }, [iterationItemText]);
  const iterationPreview = useMemo<WorkflowGraphIterationTestPreview>(
    () => buildWorkflowGraphIterationTestPreview(steps, iterationContainerId, iterationIndex, iterationItemPreview.value),
    [iterationContainerId, iterationIndex, iterationItemPreview.value, steps],
  );

  function renderStepChips(stepIds: string[], emptyLabel: string, tone: "normal" | "muted" | "error" = "normal"): JSX.Element {
    if (stepIds.length === 0) {
      return <span style={{ ...mutedTextStyle, fontSize: "12px" }}>{emptyLabel}</span>;
    }
    const color = tone === "error" ? "var(--destructive, #ef4444)" : tone === "muted" ? "var(--muted-foreground, #94a3b8)" : graphPolicyBadgeStyle.color;
    return (
      <div style={{ display: "flex", gap: "5px", flexWrap: "wrap" }}>
        {stepIds.map((stepId) => (
          <span key={stepId} style={{ ...graphPolicyBadgeStyle, color }}>{stepId}</span>
        ))}
      </div>
    );
  }

  function executionModeColor(mode: string): string {
    if (mode === "mocked") return "#38bdf8";
    if (mode === "pinned") return "#a78bfa";
    if (mode === "skipped") return "var(--muted-foreground, #94a3b8)";
    if (mode === "blocked") return "var(--destructive, #ef4444)";
    return "#22c55e";
  }

  function restartModeColor(mode: string): string {
    if (mode === "reused") return "#22c55e";
    if (mode === "rerun") return "#f59e0b";
    return "var(--destructive, #ef4444)";
  }

  return (
    <div style={{ display: "grid", gap: "8px", padding: "8px", border: "1px solid var(--border, #334155)", borderRadius: "8px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
        <div style={{ display: "grid", gap: "2px" }}>
          <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--foreground, #f8fafc)" }}>Test flow</span>
          <span style={{ ...mutedTextStyle, fontSize: "11px" }}>{plan.summary}</span>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: "6px", ...mutedTextStyle, fontSize: "11px" }}>
          Stop at
          <select
            style={{ ...selectStyle, minWidth: "150px" }}
            value={targetStepId}
            disabled={targetOptions.length === 0}
            onChange={(event) => setTargetStepId(event.target.value)}
          >
            {targetOptions.length === 0 ? <option value="">No steps</option> : null}
            {targetOptions.map((stepId) => (
              <option key={stepId} value={stepId}>{stepId}</option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: "6px", ...mutedTextStyle, fontSize: "11px" }}>
          Saved input
          <select
            style={{ ...selectStyle, minWidth: "160px" }}
            value={selectedTestPresetName}
            onChange={(event) => setSelectedTestPresetName(event.target.value)}
          >
            <option value="">Default inputs</option>
            {inputLibrary.presets.map((preset) => (
              <option key={preset.name} value={preset.name}>{preset.name}</option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: "6px", ...mutedTextStyle, fontSize: "11px" }}>
          Restart from
          <select
            style={{ ...selectStyle, minWidth: "150px" }}
            value={restartStepId}
            disabled={targetOptions.length === 0}
            onChange={(event) => setRestartStepId(event.target.value)}
          >
            {targetOptions.length === 0 ? <option value="">No steps</option> : null}
            {targetOptions.map((stepId) => (
              <option key={stepId} value={stepId}>{stepId}</option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: "6px", ...mutedTextStyle, fontSize: "11px" }}>
          Test this step
          <select
            style={{ ...selectStyle, minWidth: "150px" }}
            value={singleStepTestId}
            disabled={targetOptions.length === 0}
            onChange={(event) => setSingleStepTestId(event.target.value)}
          >
            {targetOptions.length === 0 ? <option value="">No steps</option> : null}
            {targetOptions.map((stepId) => (
              <option key={stepId} value={stepId}>{stepId}</option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: "6px", ...mutedTextStyle, fontSize: "11px" }}>
          Test iteration
          <select
            style={{ ...selectStyle, minWidth: "150px" }}
            value={iterationContainerId}
            disabled={iterationLoopOptions.length === 0}
            onChange={(event) => setIterationContainerId(event.target.value)}
          >
            {iterationLoopOptions.length === 0 ? <option value="">No loop containers</option> : null}
            {iterationLoopOptions.map((container) => (
              <option key={container.id} value={container.id}>{container.title || container.id}</option>
            ))}
          </select>
        </label>
      </div>
      <div style={{ display: "flex", gap: "5px", flexWrap: "wrap" }}>
        {plan.badges.map((badge) => (
          <span
            key={badge}
            style={{
              ...graphPolicyBadgeStyle,
              color: plan.blocked && badge === "Blocked" ? "var(--destructive, #ef4444)" : graphPolicyBadgeStyle.color,
            }}
          >
            {badge}
          </span>
        ))}
        {requestPreview.badges.map((badge) => (
          <span key={`request-${badge}`} style={{ ...graphPolicyBadgeStyle, color: "#38bdf8" }}>
            {badge}
          </span>
        ))}
        {requestFillPreview.badges.map((badge) => (
          <span
            key={`request-fill-${badge}`}
            style={{
              ...graphPolicyBadgeStyle,
              color: requestFillPreview.error || badge.includes("missing") ? "var(--destructive, #ef4444)" : "#38bdf8",
            }}
          >
            {badge}
          </span>
        ))}
        {executionPreview.badges.map((badge) => (
          <span key={`execution-${badge}`} style={{ ...graphPolicyBadgeStyle, color: "#a78bfa" }}>
            {badge}
          </span>
        ))}
        {restartPreview.badges.map((badge) => (
          <span key={`restart-${badge}`} style={{ ...graphPolicyBadgeStyle, color: restartPreview.blocked ? "var(--destructive, #ef4444)" : "#f59e0b" }}>
            {badge}
          </span>
        ))}
        {singleStepPreview.badges.map((badge) => (
          <span key={`single-step-${badge}`} style={{ ...graphPolicyBadgeStyle, color: singleStepPreview.blocked ? "var(--destructive, #ef4444)" : "#22c55e" }}>
            {badge}
          </span>
        ))}
        {iterationPreview.badges.map((badge) => (
          <span
            key={`iteration-${badge}`}
            style={{ ...graphPolicyBadgeStyle, color: iterationPreview.blocked || iterationItemPreview.error ? "var(--destructive, #ef4444)" : "#14b8a6" }}
          >
            {badge}
          </span>
        ))}
        {iterationItemPreview.error ? (
          <span style={{ ...graphPolicyBadgeStyle, color: "var(--destructive, #ef4444)" }}>Invalid iteration item</span>
        ) : null}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "8px" }}>
        <div style={{ display: "grid", gap: "4px" }}>
          <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Included steps</span>
          {renderStepChips(plan.stepIds, "No steps selected")}
        </div>
        <div style={{ display: "grid", gap: "4px" }}>
          <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Skipped downstream</span>
          {renderStepChips(plan.excludedStepIds, "No downstream steps", "muted")}
        </div>
        {plan.missingDependencyIds.length > 0 ? (
          <div style={{ display: "grid", gap: "4px" }}>
            <span style={{ ...mutedTextStyle, fontSize: "11px", color: "var(--destructive, #ef4444)" }}>Missing deps</span>
            {renderStepChips(plan.missingDependencyIds, "No missing dependencies", "error")}
          </div>
        ) : null}
      </div>
      <div style={{ display: "grid", gap: "4px" }}>
        <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Execution preview</span>
        <div style={{ display: "grid", gap: "4px" }}>
          {executionPreview.steps.length === 0 ? (
            <span style={{ ...mutedTextStyle, fontSize: "12px" }}>No steps to preview</span>
          ) : executionPreview.steps.map((step) => (
            <div
              key={step.stepId}
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(110px, 1fr) minmax(90px, auto)",
                gap: "8px",
                alignItems: "center",
                padding: "6px 8px",
                border: "1px solid var(--border, #334155)",
                borderRadius: "6px",
                background: "rgba(15, 23, 42, 0.18)",
              }}
              title={step.reason}
            >
              <div style={{ display: "grid", gap: "2px", minWidth: 0 }}>
                <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--foreground, #f8fafc)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {step.title || step.stepId}
                </span>
                <span style={{ ...mutedTextStyle, fontSize: "11px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {step.stepId} · {step.kind}
                </span>
              </div>
              <div style={{ display: "flex", gap: "4px", justifyContent: "flex-end", flexWrap: "wrap" }}>
                <span style={{ ...graphPolicyBadgeStyle, color: executionModeColor(step.mode) }}>{step.mode}</span>
                {step.badges.slice(0, 2).map((badge) => (
                  <span key={`${step.stepId}-${badge}`} style={{ ...graphPolicyBadgeStyle, color: executionModeColor(step.mode) }}>
                    {badge}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div style={{ display: "grid", gap: "4px" }}>
        <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Test this step preview</span>
        <span style={{ ...mutedTextStyle, fontSize: "11px" }}>{singleStepPreview.summary}</span>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "8px" }}>
          <div style={{ display: "grid", gap: "4px" }}>
            <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Upstream context</span>
            {renderStepChips(singleStepPreview.upstreamContextStepIds, "No upstream context")}
          </div>
          <div style={{ display: "grid", gap: "4px" }}>
            <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Downstream skipped</span>
            {renderStepChips(singleStepPreview.downstreamStepIds, "No downstream steps", "muted")}
          </div>
          {singleStepPreview.missingDependencyIds.length > 0 ? (
            <div style={{ display: "grid", gap: "4px" }}>
              <span style={{ ...mutedTextStyle, fontSize: "11px", color: "var(--destructive, #ef4444)" }}>Missing step context</span>
              {renderStepChips(singleStepPreview.missingDependencyIds, "No missing dependencies", "error")}
            </div>
          ) : null}
        </div>
        {singleStepPreview.contextResults.length > 0 ? (
          <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
            {singleStepPreview.contextResults.map((result) => (
              <span
                key={`single-step-context-${result.stepId}`}
                style={{
                  ...graphPolicyBadgeStyle,
                  color: result.mode === "unavailable" ? "var(--destructive, #ef4444)" : result.mode === "pinned" ? "#a78bfa" : "#38bdf8",
                }}
                title={result.badges.join(" · ")}
              >
                {result.stepId}: {result.mode}
              </span>
            ))}
          </div>
        ) : null}
        <textarea
          readOnly
          style={{ ...textareaStyle, minHeight: "120px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px" }}
          value={singleStepPreview.requestJson}
          rows={6}
        />
      </div>
      <div style={{ display: "grid", gap: "4px" }}>
        <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Test iteration preview</span>
        <span style={{ ...mutedTextStyle, fontSize: "11px" }}>{iterationPreview.summary}</span>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "8px" }}>
          <label style={{ display: "grid", gap: "4px" }}>
            <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Iteration index</span>
            <input
              style={{ ...inputStyle, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
              value={iterationIndexText}
              inputMode="numeric"
              onChange={(event) => setIterationIndexText(event.target.value)}
            />
          </label>
          <div style={{ display: "grid", gap: "4px" }}>
            <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Loop steps</span>
            {renderStepChips(iterationPreview.stepIds, "No loop steps")}
          </div>
          <div style={{ display: "grid", gap: "4px" }}>
            <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Skipped outside loop</span>
            {renderStepChips(iterationPreview.skippedStepIds, "No outside steps", "muted")}
          </div>
        </div>
        <textarea
          style={{ ...textareaStyle, minHeight: "92px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px" }}
          value={iterationItemText}
          rows={4}
          placeholder='{"market":"KR","date":"2026-06-13"}'
          onChange={(event) => setIterationItemText(event.target.value)}
        />
        {iterationItemPreview.error ? (
          <span style={{ ...mutedTextStyle, fontSize: "11px", color: "var(--destructive, #ef4444)" }}>{iterationItemPreview.error}</span>
        ) : null}
        <textarea
          readOnly
          style={{ ...textareaStyle, minHeight: "120px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px" }}
          value={iterationPreview.requestJson}
          rows={6}
        />
      </div>
      <div style={{ display: "grid", gap: "4px" }}>
        <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Restart preview</span>
        <span style={{ ...mutedTextStyle, fontSize: "11px" }}>{restartPreview.summary}</span>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "8px" }}>
          <div style={{ display: "grid", gap: "4px" }}>
            <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Reuse previous results</span>
            {renderStepChips(restartPreview.reusedStepIds, "No previous steps", "normal")}
          </div>
          <div style={{ display: "grid", gap: "4px" }}>
            <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Rerun from restart</span>
            {renderStepChips(restartPreview.rerunStepIds, "No rerun steps", "muted")}
          </div>
          {restartPreview.blockedStepIds.length > 0 ? (
            <div style={{ display: "grid", gap: "4px" }}>
              <span style={{ ...mutedTextStyle, fontSize: "11px", color: "var(--destructive, #ef4444)" }}>Blocked outside restart</span>
              {renderStepChips(restartPreview.blockedStepIds, "No blocked steps", "error")}
            </div>
          ) : null}
        </div>
        <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
          {restartPreview.steps.slice(0, 8).map((step) => (
            <span key={`restart-step-${step.stepId}`} style={{ ...graphPolicyBadgeStyle, color: restartModeColor(step.mode) }} title={step.reason}>
              {step.stepId}: {step.mode}
            </span>
          ))}
        </div>
      </div>
      <div style={{ display: "grid", gap: "4px" }}>
        <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Fill from request JSON</span>
        <textarea
          style={{ ...textareaStyle, minHeight: "92px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px" }}
          value={requestFillText}
          rows={4}
          placeholder='{"body":{"market":"KR"},"query":{"limit":10}}'
          onChange={(event) => setRequestFillText(event.target.value)}
        />
        {requestFillPreview.error ? (
          <span style={{ ...mutedTextStyle, fontSize: "11px", color: "var(--destructive, #ef4444)" }}>{requestFillPreview.error}</span>
        ) : requestFillText.trim() ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "8px" }}>
            <div style={{ display: "grid", gap: "4px" }}>
              <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Matched args</span>
              {renderStepChips(requestFillPreview.matchedInputNames, "No matching args")}
            </div>
            {requestFillPreview.missingRequiredInputNames.length > 0 ? (
              <div style={{ display: "grid", gap: "4px" }}>
                <span style={{ ...mutedTextStyle, fontSize: "11px", color: "var(--destructive, #ef4444)" }}>Missing required args</span>
                {renderStepChips(requestFillPreview.missingRequiredInputNames, "No missing args", "error")}
              </div>
            ) : null}
            {requestFillPreview.extraArgumentNames.length > 0 ? (
              <div style={{ display: "grid", gap: "4px" }}>
                <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Ignored extras</span>
                {renderStepChips(requestFillPreview.extraArgumentNames, "No extra args", "muted")}
              </div>
            ) : null}
          </div>
        ) : null}
        <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Test request preview</span>
        <textarea
          readOnly
          style={{ ...textareaStyle, minHeight: "120px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px" }}
          value={requestPreview.requestJson}
          rows={6}
        />
      </div>
    </div>
  );
}

function StepWorkspaceEditor({
  steps,
  baseSteps,
  runOverlaySteps,
  onChange,
  mode,
  onModeChange,
  jsonText,
  onJsonTextChange,
  onJsonError,
  triggerSummary,
  testInterfaceInput,
  availableTools,
  availableToolGrants,
  surface = "stacked",
}: {
  steps: StepDraft[];
  baseSteps?: StepDraft[];
  runOverlaySteps?: StepDraft[];
  onChange: (steps: StepDraft[]) => void;
  mode: StepEditorMode;
  onModeChange: (mode: StepEditorMode) => void;
  jsonText: string;
  onJsonTextChange: (value: string) => void;
  onJsonError: (message: string) => void;
  triggerSummary?: WorkflowGraphTriggerSummary;
  testInterfaceInput?: WorkflowGraphInterfaceInput;
  availableTools: WorkflowToolOption[];
  availableToolGrants: WorkflowToolGrant[];
  surface?: "stacked" | "focus";
}): JSX.Element {
  const draftDiff = useMemo<WorkflowGraphDraftDiff | null>(() => {
    return baseSteps ? summarizeWorkflowGraphDraftDiff(baseSteps, steps) : null;
  }, [baseSteps, steps]);

  function switchMode(nextMode: StepEditorMode): void {
    if (nextMode === mode) return;
    if (nextMode === "json") {
      onJsonTextChange(JSON.stringify(stepsToJson(steps), null, 2));
      onModeChange(nextMode);
      return;
    }
    if (mode === "json") {
      try {
        const parsed = JSON.parse(jsonText);
        if (!Array.isArray(parsed)) {
          onJsonError("steps는 JSON 배열이어야 합니다.");
          return;
        }
        onChange(jsonToSteps(parsed as WorkflowOverviewData["workflows"][number]["steps"]));
      } catch (error) {
        onJsonError(`JSON 파싱 실패: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
    onModeChange(nextMode);
  }

  return (
    <div style={surface === "focus" ? { display: "grid", minHeight: 0, height: "100%" } : { display: "grid", gap: "10px" }}>
      {surface === "stacked" ? (
        <div key="step-editor-toolbar" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
          <span key="label" style={{ ...mutedTextStyle, fontWeight: 600 }}>Steps</span>
          <GraphModeTabs key="tabs" mode={mode} onChange={switchMode} />
        </div>
      ) : (
        <Fragment key="step-editor-toolbar-placeholder" />
      )}
      {mode === "graph" ? (
        <Fragment key="graph-workspace">
          <WorkflowGraphEditor key="graph-editor" steps={steps} runOverlaySteps={runOverlaySteps} onChange={onChange} triggerSummary={triggerSummary} testInterfaceInput={testInterfaceInput} availableTools={availableTools} availableToolGrants={availableToolGrants} surface={surface} />
          {surface === "stacked" ? (
            <details
              key="graph-workspace-details"
              style={{
                display: "grid",
                gap: "8px",
                padding: "8px",
                border: "1px solid var(--border, #334155)",
                borderRadius: "8px",
                background: "color-mix(in srgb, var(--card, #0f172a) 58%, transparent)",
              }}
            >
              <summary style={{ cursor: "pointer", color: "var(--foreground, #f8fafc)", fontSize: "12px", fontWeight: 700 }}>
                Test, diff, and execution preview
              </summary>
              <div style={{ display: "grid", gap: "8px", marginTop: "8px" }}>
                {draftDiff ? <WorkflowDraftDiffSummary key="draft-diff" diff={draftDiff} /> : null}
                <WorkflowTestPlanPreview key="test-flow" steps={steps} interfaceInput={testInterfaceInput} />
              </div>
            </details>
          ) : (
            <Fragment key="graph-workspace-details-placeholder" />
          )}
        </Fragment>
      ) : mode === "json" ? (
        <Fragment key="json-workspace">
          {draftDiff ? <WorkflowDraftDiffSummary key="draft-diff" diff={draftDiff} /> : null}
          <WorkflowTestPlanPreview key="test-flow" steps={steps} interfaceInput={testInterfaceInput} />
        <textarea
          key="json-editor"
          style={{ ...textareaStyle, minHeight: "250px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px" }}
          value={jsonText}
          onChange={(event) => onJsonTextChange(event.target.value)}
          rows={10}
        />
        </Fragment>
      ) : (
        <Fragment key="form-workspace">
          {draftDiff ? <WorkflowDraftDiffSummary key="draft-diff" diff={draftDiff} /> : null}
          <WorkflowTestPlanPreview key="test-flow" steps={steps} interfaceInput={testInterfaceInput} />
          <StepEditor key="form-editor" steps={steps} onChange={onChange} availableTools={availableTools} availableToolGrants={availableToolGrants} />
        </Fragment>
      )}
    </div>
  );
}

function stepsToJson(drafts: StepDraft[]): unknown[] {
  const safeText = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
  const safeCsv = (value: unknown): string[] => safeText(value).split(",").map((entry) => entry.trim()).filter(Boolean);
  return drafts.map((d) => {
    const step: Record<string, unknown> = {
      ...d.extra,
      id: safeText(d.id),
      title: safeText(d.title),
      description: safeText(d.description) || undefined,
      type: d.type,
      dependsOn: safeCsv(d.dependsOn),
    };
    if (d.type === "tool") {
      step.toolName = safeText(d.toolName);
      try { step.toolArgs = JSON.parse(d.toolArgs || "{}"); } catch { step.toolArgs = {}; }
    } else {
      if (safeText(d.agentName)) step.agentName = safeText(d.agentName);
      const toolsList = safeCsv(d.tools);
      if (toolsList.length > 0) step.tools = toolsList;
    }
    if (d.onFailure) step.onFailure = d.onFailure;
    const maxRetries = parseOptionalNonNegativeInteger(String(d.maxRetries ?? ""));
    if (maxRetries !== undefined) step.maxRetries = maxRetries;
    const graphRetryDelaySeconds = parseOptionalPositiveInteger(String(d.graphRetryDelaySeconds ?? ""));
    if (graphRetryDelaySeconds !== undefined) step.graphRetryDelaySeconds = graphRetryDelaySeconds;
    if (safeText(d.graphRetryBackoff)) step.graphRetryBackoff = safeText(d.graphRetryBackoff);
    if (d.graphRetryJitter) step.graphRetryJitter = true;
    const timeoutSeconds = parseOptionalPositiveInteger(String(d.timeoutSeconds ?? ""));
    if (timeoutSeconds !== undefined) step.timeoutSeconds = timeoutSeconds;
    const graphSleepSeconds = parseOptionalPositiveInteger(String(d.graphSleepSeconds ?? ""));
    if (graphSleepSeconds !== undefined) step.graphSleepSeconds = graphSleepSeconds;
    if (safeText(d.graphSuspendUntil)) step.graphSuspendUntil = safeText(d.graphSuspendUntil);
    const graphSuspendTimeoutSeconds = parseOptionalPositiveInteger(String(d.graphSuspendTimeoutSeconds ?? ""));
    if (graphSuspendTimeoutSeconds !== undefined) step.graphSuspendTimeoutSeconds = graphSuspendTimeoutSeconds;
    if (safeText(d.graphSuspendTimeoutAction)) step.graphSuspendTimeoutAction = safeText(d.graphSuspendTimeoutAction);
    if (d.graphEarlyReturn) step.graphEarlyReturn = true;
    if (safeText(d.graphEarlyReturnContentType)) step.graphEarlyReturnContentType = safeText(d.graphEarlyReturnContentType);
    if (safeText(d.graphEarlyReturnSchema)) step.graphEarlyReturnSchema = safeText(d.graphEarlyReturnSchema);
    if (d.graphErrorHandler) step.graphErrorHandler = true;
    if (safeText(d.graphErrorHandlerScope)) step.graphErrorHandlerScope = safeText(d.graphErrorHandlerScope);
    if (safeText(d.graphErrorHandlerInput)) step.graphErrorHandlerInput = safeText(d.graphErrorHandlerInput);
    if (d.graphRestartBoundary) step.graphRestartBoundary = true;
    if (safeText(d.graphRestartStrategy)) step.graphRestartStrategy = safeText(d.graphRestartStrategy);
    if (safeText(d.graphRestartInput)) step.graphRestartInput = safeText(d.graphRestartInput);
    if (safeText(d.graphEarlyStopCondition)) step.graphEarlyStopCondition = safeText(d.graphEarlyStopCondition);
    if (d.graphEarlyStopLabelSkipped) step.graphEarlyStopLabelSkipped = true;
    if (d.graphApprovalRequired) step.graphApprovalRequired = true;
    if (safeText(d.graphApprovalPrompt)) step.graphApprovalPrompt = safeText(d.graphApprovalPrompt);
    if (safeText(d.graphApprovalRecipients)) step.graphApprovalRecipients = safeText(d.graphApprovalRecipients);
    const graphApprovalTimeoutSeconds = parseOptionalPositiveInteger(String(d.graphApprovalTimeoutSeconds ?? ""));
    if (graphApprovalTimeoutSeconds !== undefined) step.graphApprovalTimeoutSeconds = graphApprovalTimeoutSeconds;
    if (safeText(d.graphApprovalTimeoutAction)) step.graphApprovalTimeoutAction = safeText(d.graphApprovalTimeoutAction);
    if (d.graphMockEnabled) step.graphMockEnabled = true;
    if (safeText(d.graphMockResult)) step.graphMockResult = safeText(d.graphMockResult);
    if (safeText(d.graphPinnedResultRunId)) step.graphPinnedResultRunId = safeText(d.graphPinnedResultRunId);
    if (safeText(d.graphConcurrencyKey)) step.graphConcurrencyKey = safeText(d.graphConcurrencyKey);
    const graphConcurrencyLimit = parseOptionalPositiveInteger(String(d.graphConcurrencyLimit ?? ""));
    if (graphConcurrencyLimit !== undefined) step.graphConcurrencyLimit = graphConcurrencyLimit;
    if (safeText(d.graphPriority)) step.graphPriority = safeText(d.graphPriority);
    if (d.graphCacheEnabled) step.graphCacheEnabled = true;
    const graphCacheTtlSeconds = parseOptionalPositiveInteger(String(d.graphCacheTtlSeconds ?? ""));
    if (graphCacheTtlSeconds !== undefined) step.graphCacheTtlSeconds = graphCacheTtlSeconds;
    if (d.graphDeleteAfterUse) step.graphDeleteAfterUse = true;
    if (safeText(d.graphInputExpression)) step.graphInputExpression = safeText(d.graphInputExpression);
    if (safeText(d.graphOutputSchema)) step.graphOutputSchema = safeText(d.graphOutputSchema);
    if (d.graphWorkProductRequired) step.graphWorkProductRequired = true;
    if (safeText(d.graphWorkProductPattern)) step.graphWorkProductPattern = safeText(d.graphWorkProductPattern);
    const graphResourceRefs = safeCsv(d.graphResourceRefs);
    if (graphResourceRefs.length > 0) step.graphResourceRefs = Array.from(new Set(graphResourceRefs));
    const graphSecretRefs = safeCsv(d.graphSecretRefs);
    if (graphSecretRefs.length > 0) step.graphSecretRefs = Array.from(new Set(graphSecretRefs));
    const graphPositionX = parseOptionalGraphPosition(d.graphPositionX);
    const graphPositionY = parseOptionalGraphPosition(d.graphPositionY);
    if (graphPositionX !== undefined) step.graphPositionX = graphPositionX;
    if (graphPositionY !== undefined) step.graphPositionY = graphPositionY;
    if (safeText(d.graphGroupId)) step.graphGroupId = safeText(d.graphGroupId);
    if (safeText(d.graphGroupTitle)) step.graphGroupTitle = safeText(d.graphGroupTitle);
    if (safeText(d.graphGroupColor)) step.graphGroupColor = safeText(d.graphGroupColor);
    if (d.graphGroupCollapsed) step.graphGroupCollapsed = true;
    if (d.graphGroupCollapsedByDefault) step.graphGroupCollapsedByDefault = true;
    if (safeText(d.graphContainerId)) step.graphContainerId = safeText(d.graphContainerId);
    if (safeText(d.graphContainerType)) step.graphContainerType = safeText(d.graphContainerType);
    if (safeText(d.graphContainerTitle)) step.graphContainerTitle = safeText(d.graphContainerTitle);
    if (safeText(d.graphContainerDescription)) step.graphContainerDescription = safeText(d.graphContainerDescription);
    if (safeText(d.graphContainerMode)) step.graphContainerMode = safeText(d.graphContainerMode);
    if (safeText(d.graphContainerCondition)) step.graphContainerCondition = safeText(d.graphContainerCondition);
    if (safeText(d.graphContainerIterator)) step.graphContainerIterator = safeText(d.graphContainerIterator);
    if (d.graphContainerSkipFailure) step.graphContainerSkipFailure = true;
    if (d.graphContainerRunInParallel) step.graphContainerRunInParallel = true;
    const graphContainerParallelism = parseOptionalPositiveInteger(String(d.graphContainerParallelism ?? ""));
    if (graphContainerParallelism !== undefined) step.graphContainerParallelism = graphContainerParallelism;
    if (safeText(d.graphRunStatus) && d.graphRunStatus !== "planned") step.graphRunStatus = safeText(d.graphRunStatus);
    if (safeText(d.graphRunIssueIdentifier)) step.graphRunIssueIdentifier = safeText(d.graphRunIssueIdentifier);
    if (safeText(d.graphRunUpdatedAt)) step.graphRunUpdatedAt = safeText(d.graphRunUpdatedAt);
    if (safeText(d.graphRunSummary)) step.graphRunSummary = safeText(d.graphRunSummary);
    if (safeText(d.graphNote)) step.graphNote = safeText(d.graphNote);
    const graphEdgeMetadata = d.graphEdgeMetadata ?? {};
    if (Object.keys(graphEdgeMetadata).length > 0) step.graphEdgeMetadata = graphEdgeMetadata;
    return step;
  });
}

function jsonToSteps(steps: WorkflowOverviewData["workflows"][number]["steps"]): StepDraft[] {
  return steps.map((s) => {
    const raw = s as Record<string, unknown>;
    const rawToolArgs = raw.toolArgs;
    const extra = { ...raw };
    for (const key of [
      "id",
      "title",
      "name",
      "description",
      "type",
      "toolName",
      "toolArgs",
      "agentName",
      "tools",
      "toolNames",
      "dependsOn",
      "dependencies",
      "onFailure",
      "maxRetries",
      "graphRetryDelaySeconds",
      "graphRetryBackoff",
      "graphRetryJitter",
      "timeoutSeconds",
      "graphSleepSeconds",
      "graphSuspendUntil",
      "graphSuspendTimeoutSeconds",
      "graphSuspendTimeoutAction",
      "graphEarlyReturn",
      "graphEarlyReturnContentType",
      "graphEarlyReturnSchema",
      "graphErrorHandler",
      "graphErrorHandlerScope",
      "graphErrorHandlerInput",
      "graphRestartBoundary",
      "graphRestartStrategy",
      "graphRestartInput",
      "graphEarlyStopCondition",
      "graphEarlyStopLabelSkipped",
      "graphApprovalRequired",
      "graphApprovalPrompt",
      "graphApprovalRecipients",
      "graphApprovalTimeoutSeconds",
      "graphApprovalTimeoutAction",
      "graphMockEnabled",
      "graphMockResult",
      "graphPinnedResultRunId",
      "graphConcurrencyKey",
      "graphConcurrencyLimit",
      "graphPriority",
      "graphCacheEnabled",
      "graphCacheTtlSeconds",
      "graphDeleteAfterUse",
      "graphInputExpression",
      "graphOutputSchema",
      "graphWorkProductRequired",
      "graphWorkProductPattern",
      "graphResourceRefs",
      "graphSecretRefs",
      "graphPositionX",
      "graphPositionY",
      "graphGroupId",
      "graphGroupTitle",
      "graphGroupColor",
      "graphGroupCollapsed",
      "graphGroupCollapsedByDefault",
      "graphContainerId",
      "graphContainerType",
      "graphContainerTitle",
      "graphContainerDescription",
      "graphContainerMode",
      "graphContainerCondition",
      "graphContainerIterator",
      "graphContainerSkipFailure",
      "graphContainerRunInParallel",
      "graphContainerParallelism",
      "graphRunStatus",
      "graphRunIssueIdentifier",
      "graphRunUpdatedAt",
      "graphRunSummary",
      "graphNote",
      "graphEdgeMetadata",
    ]) {
      delete extra[key];
    }
    const rawGraphEdgeMetadata = raw.graphEdgeMetadata && typeof raw.graphEdgeMetadata === "object" && !Array.isArray(raw.graphEdgeMetadata)
      ? raw.graphEdgeMetadata as WorkflowGraphEdgeMetadataRecord
      : {};
    return {
      id: s.id,
      title: s.title,
      description: raw.description as string || "",
      type: (s.type as "agent" | "tool") || "agent",
      toolName: s.toolName || "",
      toolArgs: JSON.stringify(
        rawToolArgs && typeof rawToolArgs === "object" ? rawToolArgs : {},
        null,
        2,
      ),
      agentName: s.agentName || "",
      tools: Array.isArray(raw.tools)
        ? (raw.tools as string[]).join(", ")
        : Array.isArray(raw.toolNames)
          ? (raw.toolNames as string[]).join(", ")
          : "",
      dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.join(", ") : parseDependencies(raw.dependencies).join(", "),
      onFailure: typeof raw.onFailure === "string" ? raw.onFailure : "",
      maxRetries: typeof raw.maxRetries === "number" || typeof raw.maxRetries === "string" ? String(raw.maxRetries) : "",
      graphRetryDelaySeconds: typeof raw.graphRetryDelaySeconds === "number" || typeof raw.graphRetryDelaySeconds === "string" ? String(raw.graphRetryDelaySeconds) : "",
      graphRetryBackoff: typeof raw.graphRetryBackoff === "string" ? raw.graphRetryBackoff : "",
      graphRetryJitter: raw.graphRetryJitter === true || raw.graphRetryJitter === "true",
      timeoutSeconds: typeof raw.timeoutSeconds === "number" || typeof raw.timeoutSeconds === "string" ? String(raw.timeoutSeconds) : "",
      graphSleepSeconds: typeof raw.graphSleepSeconds === "number" || typeof raw.graphSleepSeconds === "string" ? String(raw.graphSleepSeconds) : "",
      graphSuspendUntil: typeof raw.graphSuspendUntil === "string" ? raw.graphSuspendUntil : "",
      graphSuspendTimeoutSeconds: typeof raw.graphSuspendTimeoutSeconds === "number" || typeof raw.graphSuspendTimeoutSeconds === "string" ? String(raw.graphSuspendTimeoutSeconds) : "",
      graphSuspendTimeoutAction: typeof raw.graphSuspendTimeoutAction === "string" ? raw.graphSuspendTimeoutAction : "",
      graphEarlyReturn: raw.graphEarlyReturn === true || raw.graphEarlyReturn === "true",
      graphEarlyReturnContentType: typeof raw.graphEarlyReturnContentType === "string" ? raw.graphEarlyReturnContentType : "",
      graphEarlyReturnSchema: typeof raw.graphEarlyReturnSchema === "string" ? raw.graphEarlyReturnSchema : "",
      graphErrorHandler: raw.graphErrorHandler === true || raw.graphErrorHandler === "true",
      graphErrorHandlerScope: typeof raw.graphErrorHandlerScope === "string" ? raw.graphErrorHandlerScope : "",
      graphErrorHandlerInput: typeof raw.graphErrorHandlerInput === "string" ? raw.graphErrorHandlerInput : "",
      graphRestartBoundary: raw.graphRestartBoundary === true || raw.graphRestartBoundary === "true",
      graphRestartStrategy: typeof raw.graphRestartStrategy === "string" ? raw.graphRestartStrategy : "",
      graphRestartInput: typeof raw.graphRestartInput === "string" ? raw.graphRestartInput : "",
      graphEarlyStopCondition: typeof raw.graphEarlyStopCondition === "string" ? raw.graphEarlyStopCondition : "",
      graphEarlyStopLabelSkipped: raw.graphEarlyStopLabelSkipped === true || raw.graphEarlyStopLabelSkipped === "true",
      graphApprovalRequired: raw.graphApprovalRequired === true || raw.graphApprovalRequired === "true",
      graphApprovalPrompt: typeof raw.graphApprovalPrompt === "string" ? raw.graphApprovalPrompt : "",
      graphApprovalRecipients: Array.isArray(raw.graphApprovalRecipients)
        ? (raw.graphApprovalRecipients as string[]).join(", ")
        : typeof raw.graphApprovalRecipients === "string"
          ? raw.graphApprovalRecipients
          : "",
      graphApprovalTimeoutSeconds: typeof raw.graphApprovalTimeoutSeconds === "number" || typeof raw.graphApprovalTimeoutSeconds === "string" ? String(raw.graphApprovalTimeoutSeconds) : "",
      graphApprovalTimeoutAction: typeof raw.graphApprovalTimeoutAction === "string" ? raw.graphApprovalTimeoutAction : "",
      graphMockEnabled: raw.graphMockEnabled === true || raw.graphMockEnabled === "true",
      graphMockResult: typeof raw.graphMockResult === "string" ? raw.graphMockResult : "",
      graphPinnedResultRunId: typeof raw.graphPinnedResultRunId === "string" ? raw.graphPinnedResultRunId : "",
      graphConcurrencyKey: typeof raw.graphConcurrencyKey === "string" ? raw.graphConcurrencyKey : "",
      graphConcurrencyLimit: typeof raw.graphConcurrencyLimit === "number" || typeof raw.graphConcurrencyLimit === "string" ? String(raw.graphConcurrencyLimit) : "",
      graphPriority: typeof raw.graphPriority === "string" ? raw.graphPriority : "",
      graphCacheEnabled: raw.graphCacheEnabled === true || raw.graphCacheEnabled === "true",
      graphCacheTtlSeconds: typeof raw.graphCacheTtlSeconds === "number" || typeof raw.graphCacheTtlSeconds === "string" ? String(raw.graphCacheTtlSeconds) : "",
      graphDeleteAfterUse: raw.graphDeleteAfterUse === true || raw.graphDeleteAfterUse === "true",
      graphInputExpression: typeof raw.graphInputExpression === "string" ? raw.graphInputExpression : "",
      graphOutputSchema: typeof raw.graphOutputSchema === "string" ? raw.graphOutputSchema : "",
      graphWorkProductRequired: raw.graphWorkProductRequired === true || raw.graphWorkProductRequired === "true",
      graphWorkProductPattern: typeof raw.graphWorkProductPattern === "string" ? raw.graphWorkProductPattern : "",
      graphResourceRefs: Array.isArray(raw.graphResourceRefs)
        ? (raw.graphResourceRefs as string[]).join(", ")
        : typeof raw.graphResourceRefs === "string"
          ? raw.graphResourceRefs
          : "",
      graphSecretRefs: Array.isArray(raw.graphSecretRefs)
        ? (raw.graphSecretRefs as string[]).join(", ")
        : typeof raw.graphSecretRefs === "string"
          ? raw.graphSecretRefs
          : "",
      graphPositionX: typeof raw.graphPositionX === "number" || typeof raw.graphPositionX === "string" ? String(raw.graphPositionX) : "",
      graphPositionY: typeof raw.graphPositionY === "number" || typeof raw.graphPositionY === "string" ? String(raw.graphPositionY) : "",
      graphGroupId: typeof raw.graphGroupId === "string" ? raw.graphGroupId : "",
      graphGroupTitle: typeof raw.graphGroupTitle === "string" ? raw.graphGroupTitle : "",
      graphGroupColor: typeof raw.graphGroupColor === "string" && raw.graphGroupColor.trim() ? raw.graphGroupColor : "#64748b",
      graphGroupCollapsed: raw.graphGroupCollapsed === true || raw.graphGroupCollapsed === "true"
        ? true
        : raw.graphGroupCollapsed === false || raw.graphGroupCollapsed === "false"
          ? false
          : undefined,
      graphGroupCollapsedByDefault: raw.graphGroupCollapsedByDefault === true || raw.graphGroupCollapsedByDefault === "true",
      graphContainerId: typeof raw.graphContainerId === "string" ? raw.graphContainerId : "",
      graphContainerType: raw.graphContainerType === "loop" ? "loop" : "branch",
      graphContainerTitle: typeof raw.graphContainerTitle === "string" ? raw.graphContainerTitle : "",
      graphContainerDescription: typeof raw.graphContainerDescription === "string" ? raw.graphContainerDescription : "",
      graphContainerMode: typeof raw.graphContainerMode === "string"
        ? raw.graphContainerMode
        : raw.graphContainerType === "loop"
          ? "for-each"
          : "branch-one",
      graphContainerCondition: typeof raw.graphContainerCondition === "string" ? raw.graphContainerCondition : "",
      graphContainerIterator: typeof raw.graphContainerIterator === "string" ? raw.graphContainerIterator : "",
      graphContainerSkipFailure: raw.graphContainerSkipFailure === true || raw.graphContainerSkipFailure === "true",
      graphContainerRunInParallel: raw.graphContainerRunInParallel === true || raw.graphContainerRunInParallel === "true",
      graphContainerParallelism: typeof raw.graphContainerParallelism === "number" || typeof raw.graphContainerParallelism === "string" ? String(raw.graphContainerParallelism) : "",
      graphRunStatus: normalizeGraphRunStatus(raw.graphRunStatus),
      graphRunIssueIdentifier: typeof raw.graphRunIssueIdentifier === "string" ? raw.graphRunIssueIdentifier : "",
      graphRunUpdatedAt: typeof raw.graphRunUpdatedAt === "string" ? raw.graphRunUpdatedAt : "",
      graphRunSummary: typeof raw.graphRunSummary === "string" ? raw.graphRunSummary : "",
      graphNote: typeof raw.graphNote === "string" ? raw.graphNote : "",
      graphEdgeMetadata: rawGraphEdgeMetadata,
      extra,
    };
  });
}

function ErrorState({
  message,
  onRetry,
  retrying,
}: {
  message: string;
  onRetry: () => Promise<void>;
  retrying: boolean;
}): JSX.Element {
  return (
    <div style={sectionStyle}>
      <p style={mutedTextStyle}>{message}</p>
      <div>
        <button
          onClick={() => {
            void onRetry();
          }}
          style={retrying ? { ...buttonStyle, ...buttonDisabledStyle } : buttonStyle}
          type="button"
          disabled={retrying}
        >
          {retrying ? "갱신 중..." : "Retry"}
        </button>
      </div>
    </div>
  );
}

function WorkflowRunDebugStrip({ summary }: { summary: WorkflowGraphRunDebugSummary }): JSX.Element {
  return (
    <div key="workflow-run-debug-strip" style={workflowRunDebugStripStyle}>
      <div key="decision" style={workflowRunDebugDecisionStyle(summary.tone)} title={summary.summary}>
        <div key="decision-header" style={{ display: "flex", justifyContent: "space-between", gap: "8px", minWidth: 0 }}>
          <span style={{ ...mutedTextStyle, fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 800 }}>
            Run debug
          </span>
          <span style={{ ...graphPolicyBadgeStyle, color: workflowRunDebugToneColor(summary.tone) }}>
            {summary.available ? summary.focusStepId || "run" : "loading"}
          </span>
        </div>
        <strong style={{ fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{summary.title}</strong>
        <span style={{ ...mutedTextStyle, fontSize: "10px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {summary.summary}
        </span>
        <span key="badges" style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
          {summary.badges.slice(0, 4).map((badge) => (
            <span key={badge} style={graphPolicyBadgeStyle}>{badge}</span>
          ))}
        </span>
      </div>
      {summary.tiles.map((tile) => (
        <div key={tile.id} style={workflowRunDebugTileStyle(tile.tone)} title={tile.summary}>
          <div key="tile-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "7px", minWidth: 0 }}>
            <strong style={{ fontSize: "11px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tile.title}</strong>
            <span style={{ ...graphPolicyBadgeStyle, color: workflowRunDebugToneColor(tile.tone) }}>{tile.status}</span>
          </div>
          <span style={{ ...mutedTextStyle, fontSize: "10px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {tile.badges.slice(0, 2).join(" · ") || tile.summary}
          </span>
          <span style={{ ...mutedTextStyle, fontSize: "10px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {tile.summary}
          </span>
        </div>
      ))}
    </div>
  );
}

function WorkflowRunTimeline({
  runs,
  mode,
  companyId,
  highlightedRunId,
  inspectedRunId,
  onRefreshOverview,
  onAbortRun,
  onInspectRun,
}: {
  runs: WorkflowRunSummary[];
  mode: Exclude<WorkflowRunDrawerMode, "closed">;
  companyId: string;
  highlightedRunId: string | null;
  inspectedRunId: string | null;
  onRefreshOverview: () => Promise<void>;
  onAbortRun?: (runId: string) => void;
  onInspectRun: (runId: string) => void;
}): JSX.Element {
  const pageSize = 8;
  const [page, setPage] = useState(1);
  const [expandedRunIds, setExpandedRunIds] = useState<Set<string>>(() => new Set());
  const totalPages = Math.max(1, Math.ceil(runs.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * pageSize;
  const visibleRuns = runs.slice(pageStart, pageStart + pageSize);

  useEffect(() => {
    setPage(1);
  }, [runs.length, mode]);

  if (!Array.isArray(runs) || runs.length === 0) {
    return <p style={{ ...mutedTextStyle, padding: "8px 10px" }}>{mode === "active" ? "No active runs." : "No recent runs."}</p>;
  }

  return (
    <div style={workflowRunTimelineStyle}>
      {visibleRuns.map((run, runIndex) => {
        const isExpanded = expandedRunIds.has(run.id);
        const isHighlighted = highlightedRunId === run.id;
        const isInspected = inspectedRunId === run.id;
        const runKey = `${run.id || run.runLabel || run.workflowName}:${pageStart + runIndex}`;
        const runLabel = run.runLabel?.trim() || run.id.slice(0, 8);
        return (
          <Fragment key={runKey}>
            <div key={`${runKey}:summary`} style={workflowRunTimelineRowStyle(isInspected)}>
              <span key="dot" style={workflowRunTimelineDotStyle(run.status)} />
              <div key="main" style={{ display: "grid", gap: "3px", minWidth: 0 }}>
                <strong style={{ fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {runLabel}
                </strong>
                <span style={{ color: "var(--muted-foreground, #94a3b8)", fontSize: "11px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {formatTriggerSource(run.triggerSource)} · {run.workflowName}
                </span>
              </div>
              <div key="status" style={{ display: "flex", alignItems: "center", gap: "5px", flexWrap: "wrap" }}>
                <span style={{ ...statusBadgeStyle(run.status), fontSize: "10px" }}>{run.status}</span>
                {isHighlighted ? <span style={{ ...statusBadgeStyle("running"), fontSize: "10px" }}>new</span> : null}
                {isInspected ? <span style={{ ...graphPolicyBadgeStyle, color: "#38bdf8" }}>overlay</span> : null}
              </div>
              <div key="time" style={{ display: "grid", gap: "2px", minWidth: 0 }}>
                <span style={{ color: "var(--muted-foreground, #94a3b8)", fontSize: "11px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  Started {formatDateTime(run.startedAt)}
                </span>
                <span style={{ color: "var(--muted-foreground, #94a3b8)", fontSize: "11px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {run.completedAt ? `Completed ${formatDateTime(run.completedAt)}` : run.parentIssueIdentifier || run.parentIssueId || "in progress"}
                </span>
              </div>
              <div key="actions" style={workflowRunTimelineActionsStyle}>
                <MissionRunLink missionId={run.missionId} />
                {run.parentIssueId ? (
                  <a
                    href={buildIssueHref({
                      issueId: run.parentIssueId,
                      issueIdentifier: run.parentIssueIdentifier,
                      currentPathname: currentBrowserPathname(),
                    })}
                    style={{ color: "var(--link, #60a5fa)", fontSize: "12px", textDecoration: "none" }}
                    title={run.parentIssueId}
                  >
                    {run.parentIssueIdentifier || run.parentIssueId.slice(0, 8)}
                  </a>
                ) : null}
                <button type="button" style={isInspected ? primaryButtonStyle : buttonStyle} onClick={() => onInspectRun(run.id)}>
                  Inspect
                </button>
                <button
                  type="button"
                  style={buttonStyle}
                  onClick={() => {
                    setExpandedRunIds((prev) => {
                      const next = new Set(prev);
                      if (next.has(run.id)) next.delete(run.id);
                      else next.add(run.id);
                      return next;
                    });
                  }}
                >
                  {isExpanded ? "Hide Steps" : "View Steps"}
                </button>
                {mode === "active" && onAbortRun ? (
                  <button type="button" style={dangerButtonStyle} onClick={() => onAbortRun(run.id)}>Abort</button>
                ) : null}
              </div>
            </div>
            {isExpanded ? (
              <div key={`${runKey}:detail`} style={workflowRunTimelineDetailStyle}>
                <WorkflowRunDetailPanel
                  companyId={companyId}
                  runId={run.id}
                  onRefreshOverview={onRefreshOverview}
                />
              </div>
            ) : null}
          </Fragment>
        );
      })}
      {totalPages > 1 ? (
        <div key="run-timeline-pagination" style={paginationBarStyle}>
          <span key="page-info" style={paginationInfoStyle}>
            {pageStart + 1}-{Math.min(pageStart + pageSize, runs.length)} / {runs.length}
          </span>
          <div key="page-actions" style={{ display: "flex", gap: "8px" }}>
            <button type="button" style={currentPage <= 1 ? { ...buttonStyle, ...buttonDisabledStyle } : buttonStyle} disabled={currentPage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>Prev</button>
            <button type="button" style={currentPage >= totalPages ? { ...buttonStyle, ...buttonDisabledStyle } : buttonStyle} disabled={currentPage >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>Next</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function WorkflowRunDrawer({
  mode,
  onModeChange,
  workflowName,
  activeRuns,
  recentRuns,
  companyId,
  highlightedRunId,
  inspectedRunId,
  onRefreshOverview,
  onAbortRun,
  onInspectRun,
}: {
  mode: WorkflowRunDrawerMode;
  onModeChange: (mode: WorkflowRunDrawerMode) => void;
  workflowName: string;
  activeRuns: WorkflowOverviewData["activeRuns"];
  recentRuns: WorkflowOverviewData["recentRuns"];
  companyId: string;
  highlightedRunId: string | null;
  inspectedRunId: string | null;
  onRefreshOverview: () => Promise<void>;
  onAbortRun: (runId: string) => void;
  onInspectRun: (runId: string) => void;
}): JSX.Element {
  const failedRecentRuns = recentRuns.filter((run) => run.status.trim().toLowerCase() === "failed").length;
  const drawerTitle = mode === "active"
    ? `Active Runs for ${workflowName}`
    : mode === "recent"
      ? `Recent Runs for ${workflowName}`
      : `Runs for ${workflowName}`;
  const activeButtonStyle = mode === "active" ? primaryButtonStyle : buttonStyle;
  const recentButtonStyle = mode === "recent" ? primaryButtonStyle : buttonStyle;

  return (
    <div key="workflow-run-drawer" style={workflowRunDrawerStyle(mode)}>
      <div key="run-drawer-summary" style={mode === "closed" ? workflowRunDrawerSummaryStyle : workflowRunDrawerHeaderStyle}>
        <div key="summary-main" style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0, flexWrap: "wrap" }}>
          <strong style={{ fontSize: "13px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "320px" }}>
            {drawerTitle}
          </strong>
          <span style={graphPolicyBadgeStyle}>scoped</span>
          <span style={graphPolicyBadgeStyle}>{activeRuns.length} active</span>
          <span style={graphPolicyBadgeStyle}>{recentRuns.length} recent</span>
          {failedRecentRuns > 0 ? <span style={{ ...graphPolicyBadgeStyle, color: "var(--destructive, #ef4444)" }}>{failedRecentRuns} failed</span> : null}
        </div>
        <div key="summary-actions" style={workflowRunDrawerActionsStyle}>
          <button type="button" style={activeButtonStyle} onClick={() => onModeChange(mode === "active" ? "closed" : "active")}>
            Runs
          </button>
          <button type="button" style={recentButtonStyle} onClick={() => onModeChange(mode === "recent" ? "closed" : "recent")}>
            History
          </button>
          {mode !== "closed" ? (
            <button type="button" style={buttonStyle} onClick={() => onModeChange("closed")}>
              Collapse
            </button>
          ) : (
            <Fragment key="collapse-placeholder" />
          )}
        </div>
      </div>
      {mode === "closed" ? (
        <Fragment key="run-drawer-body-placeholder" />
      ) : (
        <div key="run-drawer-body" style={workflowRunDrawerBodyStyle}>
          <WorkflowRunTimeline
            runs={mode === "active" ? activeRuns : recentRuns}
            mode={mode}
            companyId={companyId}
            highlightedRunId={highlightedRunId}
            inspectedRunId={inspectedRunId}
            onRefreshOverview={onRefreshOverview}
            onAbortRun={mode === "active" ? onAbortRun : undefined}
            onInspectRun={onInspectRun}
          />
        </div>
      )}
    </div>
  );
}

function WorkflowDefinitionMiniFlow({ workflow }: { workflow: WorkflowSummary }): JSX.Element {
  const visibleSteps = workflow.steps.slice(0, 4);
  const remainingCount = Math.max(0, workflow.steps.length - visibleSteps.length);

  if (workflow.steps.length === 0) {
    return (
      <div style={workflowDefinitionMiniFlowStyle}>
        <div style={workflowDefinitionMiniFlowNodesStyle}>
          <span style={{ ...workflowDefinitionMiniFlowNodeStyle(), color: "var(--muted-foreground, #94a3b8)" }}>No steps</span>
        </div>
        <div style={workflowDefinitionListMetricsStyle}>
          <span>0 steps</span>
          <span>Manual draft</span>
        </div>
      </div>
    );
  }

  return (
    <div style={workflowDefinitionMiniFlowStyle}>
      <div style={workflowDefinitionMiniFlowNodesStyle}>
        {visibleSteps.map((step) => (
          <span key={step.id} style={workflowDefinitionMiniFlowNodeStyle(step.type)} title={step.title || step.id}>
            {step.title || step.id}
          </span>
        ))}
      </div>
      <div style={workflowDefinitionListMetricsStyle}>
        <span>{workflow.steps.length} steps</span>
        <span>{workflow.schedule?.trim() ? "cron" : "manual"}</span>
        {(workflow.triggerLabels ?? []).length > 0 ? <span>{workflow.triggerLabels!.length} labels</span> : null}
        {remainingCount > 0 ? <span>+{remainingCount} more</span> : null}
      </div>
    </div>
  );
}

function WorkflowNavigatorMiniDag({ item }: { item: WorkflowGraphDefinitionNavigatorItem }): JSX.Element {
  if (item.miniSteps.length === 0) {
    return (
      <div style={workflowDefinitionMiniFlowNodesStyle}>
        <span style={{ ...workflowDefinitionMiniFlowNodeStyle(), gridColumn: "1 / -1", color: "var(--muted-foreground, #94a3b8)" }}>
          No steps
        </span>
      </div>
    );
  }

  return (
    <div style={workflowDefinitionMiniFlowNodesStyle}>
      {item.miniSteps.map((step) => (
        <span key={step.id || step.title} style={workflowDefinitionMiniFlowNodeStyle(step.type)} title={step.title}>
          {step.title}
        </span>
      ))}
      {item.stepCount > item.miniSteps.length ? (
        <span style={{ ...workflowDefinitionMiniFlowNodeStyle(), color: "var(--muted-foreground, #94a3b8)" }}>
          +{item.stepCount - item.miniSteps.length}
        </span>
      ) : null}
    </div>
  );
}

function WorkflowDefinitionList({
  workflows,
  activeRuns,
  recentRuns,
  pendingWorkflowId,
  editingWorkflowId,
  onOpenGraph,
  onRunWorkflow,
  onRestoreWorkflow,
  onDeleteWorkflow,
  onToggleStatus,
}: {
  workflows: WorkflowOverviewData["workflows"];
  activeRuns: WorkflowOverviewData["activeRuns"];
  recentRuns: WorkflowOverviewData["recentRuns"];
  pendingWorkflowId: string | null;
  editingWorkflowId: string | null;
  onOpenGraph: (workflow: WorkflowSummary) => void;
  onRunWorkflow: (workflow: WorkflowSummary) => void;
  onRestoreWorkflow: (workflow: WorkflowSummary) => void;
  onDeleteWorkflow: (workflow: WorkflowSummary) => void;
  onToggleStatus: (workflow: WorkflowSummary) => void;
}): JSX.Element {
  if (workflows.length === 0) {
    return (
      <div style={{ padding: "14px", border: "1px solid var(--border, #334155)", borderRadius: "8px", background: "var(--background, #020617)" }}>
        <p style={mutedTextStyle}>No workflows defined yet.</p>
      </div>
    );
  }

  return (
    <div style={workflowDefinitionListStyle}>
      {workflows.map((workflow) => {
        const normalizedStatus = workflow.status.trim().toLowerCase();
        const isPending = pendingWorkflowId === workflow.id;
        const runButtonState = buildManualRunButtonState(normalizedStatus);
        const runButtonDisabled = isPending || runButtonState.disabled;
        const workflowActiveRuns = filterRunsForWorkflows(activeRuns, [workflow]);
        const workflowRecentRuns = filterRunsForWorkflows(recentRuns, [workflow]);
        const failedRecentRuns = workflowRecentRuns.filter((run) => run.status.trim().toLowerCase() === "failed").length;
        const isSelected = editingWorkflowId === workflow.id;

        return (
          <div key={`${workflow.id}:definition-row`} style={workflowDefinitionListRowStyle(isSelected)}>
            <div key="identity" style={workflowDefinitionListIdentityStyle}>
              <div key="title" style={workflowDefinitionListTitleStyle}>
                <strong style={{ fontSize: "13px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {workflow.name}
                </strong>
                <span style={{ ...statusBadgeStyle(workflow.status), fontSize: "10px" }}>{workflow.status}</span>
                {isManualMissionPlanWorkflow(workflow) ? (
                  <span style={{ ...statusBadgeStyle("planned"), fontSize: "10px" }}>manual mission plan</span>
                ) : null}
              </div>
              <span key="description" style={{ ...mutedTextStyle, fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {workflow.description || "No description"}
              </span>
              <div key="badges" style={{ display: "flex", gap: "5px", flexWrap: "wrap" }}>
                <span style={{ ...graphPolicyBadgeStyle, color: workflow.schedule?.trim() ? "#38bdf8" : graphPolicyBadgeStyle.color }}>
                  {workflow.schedule?.trim() || "manual"}
                </span>
                <span style={graphPolicyBadgeStyle}>{workflow.timezone || "Local timezone"}</span>
                <span style={graphPolicyBadgeStyle}>parent {normalizeCreateParentIssuePolicy(workflow.createParentIssuePolicy)}</span>
              </div>
            </div>
            <div key="flow" style={workflowDefinitionMiniFlowStyle}>
              <WorkflowDefinitionMiniFlow workflow={workflow} />
              <div key="runtime-metrics" style={workflowDefinitionListMetricsStyle}>
                {workflowActiveRuns.length > 0 ? <span>{workflowActiveRuns.length} active run{workflowActiveRuns.length === 1 ? "" : "s"}</span> : <span>0 active</span>}
                {workflowRecentRuns.length > 0 ? <span>{workflowRecentRuns.length} recent</span> : <span>0 recent</span>}
                {failedRecentRuns > 0 ? <span style={{ color: "var(--destructive, #ef4444)" }}>{failedRecentRuns} failed</span> : null}
                {workflow.lastScheduledRunAt ? <span>last {formatDateTime(workflow.lastScheduledRunAt)}</span> : null}
                {workflow.lastScheduleError ? <span style={{ color: "var(--destructive, #ef4444)" }}>schedule error</span> : null}
              </div>
            </div>
            <div key="actions" style={workflowDefinitionListActionsStyle}>
              <div key="action-row" style={workflowDefinitionListActionRowStyle}>
                {normalizedStatus === "archived" ? (
                  <button
                    type="button"
                    style={isPending ? { ...primaryButtonStyle, ...buttonDisabledStyle } : primaryButtonStyle}
                    disabled={isPending}
                    onClick={() => onRestoreWorkflow(workflow)}
                  >
                    복원
                  </button>
                ) : (
                  <Fragment>
                    <button
                      type="button"
                      style={isPending ? { ...primaryButtonStyle, ...buttonDisabledStyle } : primaryButtonStyle}
                      disabled={isPending}
                      onClick={() => onOpenGraph(workflow)}
                    >
                      {isSelected ? "Graph Open" : "Open Graph"}
                    </button>
                    <button
                      type="button"
                      style={runButtonDisabled ? { ...buttonStyle, ...buttonDisabledStyle } : buttonStyle}
                      disabled={runButtonDisabled}
                      title={runButtonState.title}
                      onClick={() => onRunWorkflow(workflow)}
                    >
                      {isPending ? "Running..." : runButtonState.label}
                    </button>
                    <button
                      type="button"
                      style={isPending ? { ...buttonStyle, ...buttonDisabledStyle } : buttonStyle}
                      disabled={isPending || (normalizedStatus !== "active" && normalizedStatus !== "paused")}
                      onClick={() => onToggleStatus(workflow)}
                    >
                      {normalizedStatus === "active" ? "Pause" : "Activate"}
                    </button>
                    <button
                      type="button"
                      style={isPending ? { ...dangerButtonStyle, ...buttonDisabledStyle } : dangerButtonStyle}
                      disabled={isPending}
                      onClick={() => onDeleteWorkflow(workflow)}
                    >
                      보관
                    </button>
                  </Fragment>
                )}
              </div>
              {runButtonState.notice && normalizedStatus !== "archived" ? (
                <span style={{ ...mutedTextStyle, color: "#fbbf24", fontSize: "11px", textAlign: "right" }}>
                  {runButtonState.notice}
                </span>
              ) : (
                <span style={{ ...mutedTextStyle, fontSize: "11px", textAlign: "right" }}>
                  {isManualMissionPlanWorkflow(workflow) ? "One-off plan" : "Reusable procedure"}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DefinitionsTable({
  workflows,
  companyId,
  refreshOverview,
  projects,
  labels,
  refreshLabels,
  activeRuns,
  recentRuns,
  onManualRunStarted,
  highlightedRunId,
  onAbortRun,
  navigatorSearch,
  onEditingWorkflowChange,
  availableTools,
  availableToolGrants,
}: {
  workflows: WorkflowOverviewData["workflows"];
  companyId: string;
  refreshOverview: () => Promise<void>;
  projects: ProjectOption[];
  labels: LabelOption[];
  refreshLabels: () => Promise<LabelOption[]>;
  activeRuns: WorkflowOverviewData["activeRuns"];
  recentRuns: WorkflowOverviewData["recentRuns"];
  onManualRunStarted: (runId: string | null) => void;
  highlightedRunId: string | null;
  onAbortRun: (runId: string) => void;
  navigatorSearch: string;
  onEditingWorkflowChange?: (workflowId: string | null) => void;
  availableTools: WorkflowToolOption[];
  availableToolGrants: WorkflowToolGrant[];
}): JSX.Element {
  const updateWorkflow = usePluginAction("update-workflow");
  const deleteWorkflow = usePluginAction("delete-workflow");
  const runWorkflow = usePluginAction("start-workflow");
  const [editingWorkflowId, setEditingWorkflowId] = useState<string | null>(null);
  const [railCollapsed, setRailCollapsed] = useState<boolean>(false);
  const [editingName, setEditingName] = useState<string>("");
  const [editingDescription, setEditingDescription] = useState<string>("");
  const [editingStatus, setEditingStatus] = useState<string>("active");
  const [editingTriggerLabels, setEditingTriggerLabels] = useState<string>("");
  const [editingLabelIds, setEditingLabelIds] = useState<string[]>([]);
  const [showNewLabelForm, setShowNewLabelForm] = useState<boolean>(false);
  const [newLabelName, setNewLabelName] = useState<string>("");
  const [newLabelColor, setNewLabelColor] = useState<string>("#6366f1");
  const [creatingLabel, setCreatingLabel] = useState<boolean>(false);
  const [editingSchedule, setEditingSchedule] = useState<string>("");
  const [editingMaxDailyRuns, setEditingMaxDailyRuns] = useState<string>("");
  const [editingTimezone, setEditingTimezone] = useState<string>("Asia/Seoul");
  const [editingProjectId, setEditingProjectId] = useState<string>("");
  const [editingCreateParentIssuePolicy, setEditingCreateParentIssuePolicy] = useState<CreateParentIssuePolicy>("when_multiple_steps");
  const [editingSteps, setEditingSteps] = useState<StepDraft[]>([]);
  const [editStepMode, setEditStepMode] = useState<StepEditorMode>("graph");
  const [editJsonText, setEditJsonText] = useState("");
  const [editingFlowInputsText, setEditingFlowInputsText] = useState("[]");
  const [editingFlowEnvVariablesText, setEditingFlowEnvVariablesText] = useState("[]");
  const [editingTestInputPresetsText, setEditingTestInputPresetsText] = useState("[]");
  const [pendingWorkflowId, setPendingWorkflowId] = useState<string | null>(null);
  const [tableError, setTableError] = useState<string>("");
  const [tableNotice, setTableNotice] = useState<{ tone: "info" | "success"; message: string } | null>(null);
  const [graphShellDismissed, setGraphShellDismissed] = useState<boolean>(false);
  const [runDrawerMode, setRunDrawerMode] = useState<WorkflowRunDrawerMode>("closed");
  const [inspectedRunId, setInspectedRunId] = useState<string | null>(null);
  const navigatorFilter: WorkflowGraphNavigatorFilter = "all";
  const inspectedRunDetail = useWorkflowRunDetail(inspectedRunId);

  function clearTableFeedback(): void {
    setTableError("");
    setTableNotice(null);
  }

  function beginEdit(workflow: WorkflowOverviewData["workflows"][number]): void {
    clearTableFeedback();
    setGraphShellDismissed(false);
    setRunDrawerMode("closed");
    setInspectedRunId(null);
    setEditingWorkflowId(workflow.id);
    onEditingWorkflowChange?.(workflow.id);
    setEditingName(workflow.name);
    setEditingDescription(workflow.description);
    setEditingStatus(workflow.status);
    setEditingTriggerLabels((workflow.triggerLabels ?? []).join(", "));
    setEditingLabelIds(workflow.labelIds ?? []);
    setShowNewLabelForm(false);
    setNewLabelName("");
    setNewLabelColor("#6366f1");
    const rawWorkflow = workflow as Record<string, unknown>;
    const rawSchedule = rawWorkflow.schedule;
    const rawProjectId = rawWorkflow.projectId;
    const rawTimezone = rawWorkflow.timezone;
    const rawMaxDailyRuns = rawWorkflow.maxDailyRuns;
    const rawCreateParentIssuePolicy = rawWorkflow.createParentIssuePolicy;
    setEditingSchedule(typeof rawSchedule === "string" ? rawSchedule : "");
    setEditingProjectId(typeof rawProjectId === "string" ? rawProjectId : "");
    setEditingTimezone(typeof rawTimezone === "string" && rawTimezone.trim() ? rawTimezone : "Asia/Seoul");
    setEditingCreateParentIssuePolicy(normalizeCreateParentIssuePolicy(rawCreateParentIssuePolicy));
    setEditingMaxDailyRuns(
      typeof rawMaxDailyRuns === "number" && Number.isFinite(rawMaxDailyRuns)
        ? String(Math.trunc(rawMaxDailyRuns))
        : "",
    );
    setEditingSteps(jsonToSteps(workflow.steps));
    setEditStepMode("graph");
    setEditJsonText(JSON.stringify(workflow.steps, null, 2));
    setEditingFlowInputsText(formatJsonArrayForForm(workflow.legacyMetadata?.graphFlowInputs));
    setEditingFlowEnvVariablesText(formatJsonArrayForForm(workflow.legacyMetadata?.graphFlowEnvVariables));
    setEditingTestInputPresetsText(formatJsonArrayForForm(workflow.legacyMetadata?.graphTestInputPresets));
  }

  function cancelEdit(): void {
    setGraphShellDismissed(true);
    setEditingWorkflowId(null);
    onEditingWorkflowChange?.(null);
    setEditingName("");
    setEditingDescription("");
    setEditingStatus("active");
    setEditingTriggerLabels("");
    setEditingLabelIds([]);
    setShowNewLabelForm(false);
    setNewLabelName("");
    setNewLabelColor("#6366f1");
    setEditingSchedule("");
    setEditingMaxDailyRuns("");
    setEditingTimezone("Asia/Seoul");
    setEditingProjectId("");
    setEditingCreateParentIssuePolicy("when_multiple_steps");
    setEditingSteps([]);
    setEditStepMode("graph");
    setEditJsonText("");
    setEditingFlowInputsText("[]");
    setEditingFlowEnvVariablesText("[]");
    setEditingTestInputPresetsText("[]");
    setRunDrawerMode("closed");
    setInspectedRunId(null);
    clearTableFeedback();
  }

  useEffect(() => {
    if (editingWorkflowId || workflows.length === 0) return;
    beginEdit(workflows[0]!);
  }, [editingWorkflowId, workflows]);

  useEffect(() => {
    if (editingWorkflowId && !workflows.some((w) => w.id === editingWorkflowId)) {
      setGraphShellDismissed(false);
      setEditingWorkflowId(null);
      onEditingWorkflowChange?.(null);
    }
  }, [editingWorkflowId, onEditingWorkflowChange, workflows]);

  function switchEditingStepMode(nextMode: StepEditorMode): void {
    if (nextMode === editStepMode) return;
    setTableError("");
    if (nextMode === "json") {
      setEditJsonText(JSON.stringify(stepsToJson(editingSteps), null, 2));
      setEditStepMode(nextMode);
      return;
    }
    if (editStepMode === "json") {
      try {
        const parsed = JSON.parse(editJsonText) as unknown;
        if (!Array.isArray(parsed)) {
          setTableError("steps는 JSON 배열이어야 합니다.");
          return;
        }
        setEditingSteps(jsonToSteps(parsed as WorkflowOverviewData["workflows"][number]["steps"]));
      } catch (error) {
        setTableError(`JSON 파싱 실패: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
    setEditStepMode(nextMode);
  }

  async function onSaveEdit(workflowId: string): Promise<void> {
    const nextName = editingName.trim();
    if (!nextName) {
      setTableError("name은 필수입니다.");
      return;
    }

    setPendingWorkflowId(workflowId);
    setTableError("");
    try {
      const parsedMaxDailyRuns = normalizeMaxDailyRunsInput(editingMaxDailyRuns);
      if (parsedMaxDailyRuns.error) {
        setTableError(parsedMaxDailyRuns.error);
        return;
      }
      const triggerLabels = editingTriggerLabels.split(",").map((l) => l.trim()).filter(Boolean);
      const labelIds = editingLabelIds.map((l) => l.trim()).filter(Boolean);
      let steps: unknown[];
      if (editStepMode === "json") {
        try {
          steps = JSON.parse(editJsonText);
          if (!Array.isArray(steps)) { setTableError("steps는 JSON 배열이어야 합니다."); return; }
        } catch (e) { setTableError(`JSON 파싱 실패: ${e instanceof Error ? e.message : String(e)}`); return; }
      } else {
        steps = stepsToJson(editingSteps);
      }
      const legacyMetadata = buildWorkflowInterfaceMetadata(
        workflows.find((workflow) => workflow.id === workflowId)?.legacyMetadata,
        editingFlowInputsText,
        editingFlowEnvVariablesText,
        editingTestInputPresetsText,
      );
      if (legacyMetadata.error) {
        setTableError(legacyMetadata.error);
        return;
      }
      const patch = {
        name: nextName,
        description: editingDescription.trim(),
        status: editingStatus.trim() || "active",
        triggerLabels,
        labelIds,
        steps,
        schedule: editingSchedule.trim(),
        maxDailyRuns: parsedMaxDailyRuns.value,
        timezone: editingTimezone.trim(),
        projectId: editingProjectId.trim(),
        createParentIssuePolicy: editingCreateParentIssuePolicy,
        legacyMetadata: legacyMetadata.value,
      };
      await updateWorkflow({
        companyId,
        workflowId,
        id: workflowId,
        patch,
        ...patch,
      });
      cancelEdit();
      await refreshOverview();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTableError(`수정 실패: ${message}`);
    } finally {
      setPendingWorkflowId(null);
    }
  }

  async function onCreateLabelForEditForm(): Promise<void> {
    const name = newLabelName.trim();
    if (!name) {
      setTableError("새 레이블 이름을 입력하세요.");
      return;
    }
    if (!companyId.trim()) {
      setTableError("companyId가 없어 레이블을 생성할 수 없습니다.");
      return;
    }

    setTableError("");
    setCreatingLabel(true);
    try {
      const created = await createCompanyLabel(companyId, name, newLabelColor);
      const nextLabels = await refreshLabels();
      const createdId = nextLabels.find((label) => label.id === created.id)?.id ?? created.id;
      setEditingLabelIds((prev) => (prev.includes(createdId) ? prev : [...prev, createdId]));
      setNewLabelName("");
      setNewLabelColor("#6366f1");
      setShowNewLabelForm(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTableError(`레이블 생성 실패: ${message}`);
    } finally {
      setCreatingLabel(false);
    }
  }

  async function onDeleteWorkflow(workflow: WorkflowOverviewData["workflows"][number]): Promise<void> {
    const accepted = typeof window !== "undefined"
      ? window.confirm(`"${workflow.name}" 워크플로를 보관할까요?`)
      : true;
    if (!accepted) {
      return;
    }

    setPendingWorkflowId(workflow.id);
    setTableError("");
    try {
      await deleteWorkflow({
        companyId,
        workflowId: workflow.id,
        id: workflow.id,
        status: "archived",
      });
      if (editingWorkflowId === workflow.id) {
        cancelEdit();
      }
      await refreshOverview();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTableError(`삭제 실패: ${message}`);
    } finally {
      setPendingWorkflowId(null);
    }
  }

  async function onToggleStatus(workflow: WorkflowOverviewData["workflows"][number]): Promise<void> {
    const normalized = workflow.status.trim().toLowerCase();
    if (normalized !== "active" && normalized !== "paused") {
      return;
    }

    const nextStatus = normalized === "active" ? "paused" : "active";
    setPendingWorkflowId(workflow.id);
    setTableError("");
    try {
      await updateWorkflow({
        companyId,
        workflowId: workflow.id,
        id: workflow.id,
        patch: { status: nextStatus },
        status: nextStatus,
      });
      await refreshOverview();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTableError(`status 변경 실패: ${message}`);
    } finally {
      setPendingWorkflowId(null);
    }
  }

  async function onRunWorkflow(workflow: WorkflowOverviewData["workflows"][number]): Promise<void> {
    const normalizedStatus = workflow.status.trim().toLowerCase();
    if (normalizedStatus !== "active") {
      setTableError("");
      setTableNotice({ tone: "info", message: manualRunUnavailableMessage(normalizedStatus) });
      onManualRunStarted(null);
      return;
    }

    const beforeRunIds = new Set([...activeRuns, ...recentRuns].map((run) => run.id));
    setPendingWorkflowId(workflow.id);
    clearTableFeedback();
    try {
      const result = await runWorkflow({ companyId, workflowId: workflow.id }) as Record<string, unknown> | null | undefined;
      const runId = typeof result?.runId === "string" ? result.runId : typeof result?.id === "string" ? result.id : null;
      const highlightedRunId = findNewRunId(beforeRunIds, runId, activeRuns, recentRuns);
      onManualRunStarted(highlightedRunId);
      setTableNotice({
        tone: "success",
        message: buildManualRunFeedback(workflow.name, {
          id: typeof result?.id === "string" ? result.id : undefined,
          runId: runId ?? undefined,
          parentIssueId: typeof result?.parentIssueId === "string" ? result.parentIssueId : undefined,
          parentIssueIdentifier: typeof result?.parentIssueIdentifier === "string" ? result.parentIssueIdentifier : undefined,
        }),
      });
      await refreshOverview();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onManualRunStarted(null);
      setTableError(`Run 실패: ${message}`);
    } finally {
      setPendingWorkflowId(null);
    }
  }

  async function onRestoreWorkflow(workflow: WorkflowOverviewData["workflows"][number]): Promise<void> {
    setPendingWorkflowId(workflow.id);
    setTableError("");
    try {
      await updateWorkflow({
        companyId,
        workflowId: workflow.id,
        id: workflow.id,
        patch: { status: "active" },
        status: "active",
      });
      await refreshOverview();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTableError(`복원 실패: ${message}`);
    } finally {
      setPendingWorkflowId(null);
    }
  }

  if (workflows.length === 0) {
    return <p style={mutedTextStyle}>No workflows defined yet.</p>;
  }

  const editingWorkflow = workflows.find((workflow) => workflow.id === editingWorkflowId) ?? null;
  const editingWorkflowPending = editingWorkflow ? pendingWorkflowId === editingWorkflow.id : false;
  const editingWorkflowActiveRuns = editingWorkflow ? filterRunsForWorkflows(activeRuns, [editingWorkflow]) : [];
  const editingWorkflowRecentRuns = editingWorkflow ? filterRunsForWorkflows(recentRuns, [editingWorkflow]) : [];
  const inspectedRunSummary: WorkflowRunSummary | null = inspectedRunId
    ? [...editingWorkflowActiveRuns, ...editingWorkflowRecentRuns].find((run) => run.id === inspectedRunId) ?? null
    : null;
  const runOverlaySteps = inspectedRunId && inspectedRunDetail.data?.stepRuns
    ? applyStepRunsToGraphSteps(editingSteps, inspectedRunDetail.data.stepRuns)
    : undefined;
  const editingWorkflowRunDebugSummary = inspectedRunId ? buildWorkflowGraphRunDebugSummary({
    steps: editingSteps,
    stepRuns: inspectedRunDetail.data?.stepRuns ?? [],
    selectedStepId: editingSteps[0]?.id ?? "",
  }) : null;
  const navigatorSummary = buildWorkflowGraphDefinitionNavigator({
    workflows,
    activeRuns,
    recentRuns,
    search: navigatorSearch,
    filter: navigatorFilter,
  });

  return (
    <div style={{ display: "grid", gap: "8px" }}>
      {tableError ? <p key="table-error" style={noticeStyle("error")}>{tableError}</p> : null}
      {tableNotice ? <p key="table-notice" style={noticeStyle(tableNotice.tone)}>{tableNotice.message}</p> : null}
      {editingWorkflow ? (
        <div id="wf-editor" key="selected-workflow-shell" style={{ ...workflowManagementShellStyle, gridTemplateColumns: railCollapsed ? "36px minmax(640px, 1fr)" : "280px minmax(640px, 1fr)" }}>
          <aside id="wf-rail" key="workflow-rail" style={railCollapsed ? { ...workflowDefinitionRailStyle, padding: "6px", gridTemplateRows: "auto" } : workflowDefinitionRailStyle}>
            {railCollapsed ? (
              <button
                key="rail-expand"
                type="button"
                title="Expand sidebar"
                aria-label="Expand sidebar"
                style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", background: "transparent", border: "none", color: "var(--muted-foreground, #94a3b8)", cursor: "pointer", padding: "4px", borderRadius: "6px" }}
                onClick={() => setRailCollapsed(false)}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <rect width="18" height="18" x="3" y="3" rx="2" />
                  <path d="M9 3v18" />
                  <path d="m14 9 3 3-3 3" />
                </svg>
              </button>
            ) : (
              <Fragment key="rail-expanded">
            <div key="rail-header" style={{ display: "grid", gap: "5px" }}>
              <div key="title-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
                <span style={{ ...mutedTextStyle, fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 800 }}>
                  Workflows
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                  <span style={graphPolicyBadgeStyle}>{navigatorSummary.visibleItems.length}</span>
                  <button
                    type="button"
                    title="Collapse sidebar"
                    aria-label="Collapse sidebar"
                    style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", background: "transparent", border: "none", color: "var(--muted-foreground, #94a3b8)", cursor: "pointer", padding: "4px", borderRadius: "6px" }}
                    onClick={() => setRailCollapsed(true)}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <rect width="18" height="18" x="3" y="3" rx="2" />
                      <path d="M9 3v18" />
                      <path d="m16 15-3-3 3-3" />
                    </svg>
                  </button>
                </div>
              </div>
              <p key="description" style={{ ...mutedTextStyle, margin: 0, fontSize: "12px", lineHeight: 1.4 }}>
                Select a workflow. Details stay in the editor.
              </p>
            </div>
            <div key="rail-list" style={workflowDefinitionRailListStyle}>
              {navigatorSummary.visibleItems.length === 0 ? (
                <div style={{ padding: "10px", border: "1px solid var(--border, #334155)", borderRadius: "8px", background: "var(--background, #020617)" }}>
                  <p style={{ ...mutedTextStyle, margin: 0 }}>No workflows match your search.</p>
                </div>
              ) : null}
              {navigatorSummary.visibleItems.map((item) => {
                const workflow = workflows.find((entry) => entry.id === item.id);
                if (!workflow) return null;
                const selected = workflow.id === editingWorkflow.id;
                const normalized = workflow.status.trim().toLowerCase();
                const activeLabel = normalized === "active" ? "active" : "inactive";
                const lastRunLabel = item.trigger.schedule.lastRunAt ? `last ${formatDateTime(item.trigger.schedule.lastRunAt)}` : "last run -";
                return (
                  <button
                    key={workflow.id}
                    type="button"
                    style={workflowDefinitionRailButtonStyle(selected)}
                    onClick={() => beginEdit(workflow)}
                  >
                    <span key="main" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", minWidth: 0 }}>
                      <strong style={{ fontSize: "13px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{workflow.name}</strong>
                      <span style={{ ...graphPolicyBadgeStyle, color: normalized === "active" ? "#22c55e" : "var(--muted-foreground, #94a3b8)" }}>{activeLabel}</span>
                    </span>
                    <span key="description" style={{ color: "var(--muted-foreground, #94a3b8)", fontSize: "11px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {workflow.description || "No description"}
                    </span>
                    <span key="runtime" style={{ color: "var(--muted-foreground, #94a3b8)", fontSize: "11px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {lastRunLabel}
                    </span>
                  </button>
                );
              })}
            </div>
              </Fragment>
            )}
          </aside>
          <div key="selected-workflow-editor" style={workflowSelectedEditorStyle}>
            <div key="selected-workflow-header" style={{ ...workflowSelectedHeaderStyle, gridTemplateColumns: "1fr" }}>
              <div key="action-bar" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                <GraphModeTabs mode={editStepMode} onChange={switchEditingStepMode} />
                <div key="action-buttons" style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
                  <button
                    type="button"
                    style={editingWorkflowPending ? { ...primaryButtonStyle, ...buttonDisabledStyle } : primaryButtonStyle}
                    disabled={editingWorkflowPending || buildManualRunButtonState(editingWorkflow.status.trim().toLowerCase()).disabled}
                    onClick={() => { void onRunWorkflow(editingWorkflow); }}
                  >
                    {editingWorkflowPending ? "Running..." : "Run"}
                  </button>
                  <button
                    type="button"
                    style={editingWorkflowPending ? { ...primaryButtonStyle, ...buttonDisabledStyle } : primaryButtonStyle}
                    disabled={editingWorkflowPending}
                    onClick={() => { void onSaveEdit(editingWorkflow.id); }}
                  >
                    Save
                  </button>
                  <button type="button" style={buttonStyle} onClick={cancelEdit}>Close</button>
                  <button
                    type="button"
                    style={editingWorkflowPending ? { ...buttonStyle, ...buttonDisabledStyle } : buttonStyle}
                    disabled={editingWorkflowPending || !["active", "paused"].includes(editingWorkflow.status.trim().toLowerCase())}
                    onClick={() => { void onToggleStatus(editingWorkflow); }}
                  >
                    {editingWorkflow.status.trim().toLowerCase() === "active" ? "Pause" : "Activate"}
                  </button>
                  <button
                    type="button"
                    style={editingWorkflowPending ? { ...dangerButtonStyle, ...buttonDisabledStyle } : dangerButtonStyle}
                    disabled={editingWorkflowPending}
                    onClick={() => { void onDeleteWorkflow(editingWorkflow); }}
                  >
                    보관
                  </button>
                </div>
              </div>
              <div key="workflow-main" style={workflowSelectedIdentityStyle}>
                <div key="name-field" style={workflowCreateFieldStyle}>
                  <label style={{ ...mutedTextStyle, fontSize: "11px", fontWeight: 700 }}>Workflow name</label>
                  <input style={inputStyle} value={editingName} onChange={(event) => setEditingName(event.target.value)} required />
                </div>
                <div key="description-field" style={workflowCreateFieldStyle}>
                  <label style={{ ...mutedTextStyle, fontSize: "11px", fontWeight: 700 }}>Description</label>
                  <textarea
                    style={{ ...textareaStyle, minHeight: "38px" }}
                    value={editingDescription}
                    onChange={(event) => setEditingDescription(event.target.value)}
                    rows={2}
                  />
                </div>
              </div>
              <div key="workflow-setup-strip" style={workflowSelectedSetupStripStyle}>
                <div key="status-field" style={workflowCreateFieldStyle}>
                  <label style={{ ...mutedTextStyle, fontSize: "11px" }}>Status</label>
                  <select style={selectStyle} value={editingStatus} onChange={(event) => setEditingStatus(event.target.value)}>
                    <option value="active">active</option>
                    <option value="paused">paused</option>
                    <option value="archived">archived</option>
                  </select>
                </div>
                <div key="schedule-field" style={workflowCreateFieldStyle}>
                  <label style={{ ...mutedTextStyle, fontSize: "11px" }}>Schedule (cron)</label>
                  <input style={inputStyle} value={editingSchedule} onChange={(event) => setEditingSchedule(event.target.value)} placeholder="0 9 * * *" />
                </div>
                <div key="timezone-field" style={workflowCreateFieldStyle}>
                  <label style={{ ...mutedTextStyle, fontSize: "11px" }}>Timezone</label>
                  <input style={inputStyle} value={editingTimezone} onChange={(event) => setEditingTimezone(event.target.value)} placeholder="Asia/Seoul" />
                </div>
                <div key="project-field" style={workflowCreateFieldStyle}>
                  <label style={{ ...mutedTextStyle, fontSize: "11px" }}>Project</label>
                  <select style={selectStyle} value={editingProjectId} onChange={(event) => setEditingProjectId(event.target.value)}>
                    <option value="">— none —</option>
                    {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                  </select>
                </div>
                <div key="max-daily-runs-field" style={workflowCreateFieldStyle}>
                  <label style={{ ...mutedTextStyle, fontSize: "11px" }}>Max Daily Runs</label>
                  <input style={inputStyle} type="number" min={0} step={1} value={editingMaxDailyRuns} onChange={(event) => setEditingMaxDailyRuns(event.target.value)} placeholder="blank=1/day" />
                </div>
                <div key="trigger-labels-field" style={workflowCreateFieldStyle}>
                  <label style={{ ...mutedTextStyle, fontSize: "11px" }}>Trigger Labels</label>
                  <input style={inputStyle} value={editingTriggerLabels} onChange={(event) => setEditingTriggerLabels(event.target.value)} placeholder="daily-tech-research" />
                </div>
              </div>
              {inspectedRunId ? (
                <div key="run-overlay-banner" style={workflowRunOverlayBannerStyle}>
                  <div key="run-overlay-main" style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0, flexWrap: "wrap" }}>
                    <strong style={{ fontSize: "13px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "280px" }}>
                      Inspecting run
                    </strong>
                    <span style={statusBadgeStyle(inspectedRunSummary?.status ?? inspectedRunDetail.data?.run.status ?? "running")}>
                      {inspectedRunSummary?.status ?? inspectedRunDetail.data?.run.status ?? (inspectedRunDetail.loading ? "loading" : "selected")}
                    </span>
                    <span style={graphPolicyBadgeStyle}>{inspectedRunSummary?.runLabel || inspectedRunId.slice(0, 8)}</span>
                    {inspectedRunSummary?.startedAt ? <span style={graphPolicyBadgeStyle}>{formatDateTime(inspectedRunSummary.startedAt)}</span> : null}
                    {inspectedRunDetail.data?.stepRuns ? <span style={graphPolicyBadgeStyle}>{inspectedRunDetail.data.stepRuns.length} step runs</span> : null}
                    {inspectedRunDetail.error ? <span style={{ ...graphPolicyBadgeStyle, color: "var(--destructive, #ef4444)" }}>detail failed</span> : null}
                  </div>
                  <div key="run-overlay-actions" style={workflowRunDrawerActionsStyle}>
                    <button type="button" style={buttonStyle} onClick={() => setInspectedRunId(null)}>
                      Clear overlay
                    </button>
                    {inspectedRunId && runDrawerMode === "closed" ? (
                      <button type="button" style={buttonStyle} onClick={() => setRunDrawerMode(inspectedRunSummary && editingWorkflowActiveRuns.some((run) => run.id === inspectedRunSummary.id) ? "active" : "recent")}>
                        View run row
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : (
                <Fragment key="run-overlay-banner-placeholder" />
              )}
              {editingWorkflowRunDebugSummary ? (
                <WorkflowRunDebugStrip key="run-debug" summary={editingWorkflowRunDebugSummary} />
              ) : (
                <Fragment key="run-debug-placeholder" />
              )}
            </div>
            <div key="selected-step-workspace" style={workflowSelectedWorkspaceStyle}>
              <StepWorkspaceEditor
                steps={editingSteps}
                baseSteps={jsonToSteps(editingWorkflow.steps)}
                onChange={setEditingSteps}
                mode={editStepMode}
                onModeChange={setEditStepMode}
                jsonText={editJsonText}
                onJsonTextChange={setEditJsonText}
                onJsonError={setTableError}
                runOverlaySteps={runOverlaySteps}
                triggerSummary={summarizeWorkflowGraphTriggers({
                  schedule: editingSchedule,
                  timezone: editingTimezone,
                  triggerLabels: editingTriggerLabels,
                  lastScheduledRunAt: editingWorkflow.lastScheduledRunAt,
                  lastScheduleError: editingWorkflow.lastScheduleError,
                  lastScheduleErrorAt: editingWorkflow.lastScheduleErrorAt,
                })}
                testInterfaceInput={{
                  graphFlowInputs: editingFlowInputsText,
                  graphFlowEnvVariables: editingFlowEnvVariablesText,
                  graphTestInputPresets: editingTestInputPresetsText,
                }}
                availableTools={availableTools}
                availableToolGrants={availableToolGrants}
                surface="focus"
              />
            </div>
          </div>
        </div>
      ) : (
        <Fragment key="selected-workflow-shell-placeholder" />
      )}
      {editingWorkflow ? (
        <Fragment key="definitions-table-hidden-while-editing" />
      ) : (
        <WorkflowDefinitionList
          key="definitions-flow-list"
          workflows={workflows}
          activeRuns={activeRuns}
          recentRuns={recentRuns}
          pendingWorkflowId={pendingWorkflowId}
          editingWorkflowId={editingWorkflowId}
          onOpenGraph={beginEdit}
          onRunWorkflow={(workflow) => { void onRunWorkflow(workflow); }}
          onRestoreWorkflow={(workflow) => { void onRestoreWorkflow(workflow); }}
          onDeleteWorkflow={(workflow) => { void onDeleteWorkflow(workflow); }}
          onToggleStatus={(workflow) => { void onToggleStatus(workflow); }}
        />
      )}
    </div>
  );
}

function WorkflowRunDetailPanel({
  companyId,
  runId,
  onRefreshOverview,
}: {
  companyId: string;
  runId: string;
  onRefreshOverview: () => Promise<void>;
}): JSX.Element {
  const detail = useWorkflowRunDetail(runId);
  const rerunStep = usePluginAction("rerun-step");
  const [pendingStepId, setPendingStepId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string>("");
  const runGraphSteps = useMemo(() => {
    const workflowSteps = detail.data?.workflow?.steps ?? [];
    const stepRuns = detail.data?.stepRuns ?? [];
    return applyStepRunsToGraphSteps(workflowSteps, stepRuns);
  }, [detail.data]);

  async function handleRerunStep(input: { stepRunId: string; issueId?: string | null }): Promise<void> {
    setPendingStepId(input.stepRunId);
    setActionError("");
    try {
      await rerunStep({
        companyId,
        stepRunId: input.stepRunId,
        issueId: input.issueId || undefined,
      });
      await Promise.all([detail.refresh(), onRefreshOverview()]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActionError(`Step rerun 실패: ${message}`);
    } finally {
      setPendingStepId(null);
    }
  }

  if (detail.loading) {
    return <p style={mutedTextStyle}>Loading step details...</p>;
  }

  if (detail.error) {
    return <p style={mutedTextStyle}>Failed to load step details: {detail.error.message}</p>;
  }

  if (!detail.data) {
    return <p style={mutedTextStyle}>No step details available.</p>;
  }

  return (
    <div style={{ display: "grid", gap: "8px" }}>
      {actionError ? <p style={mutedTextStyle}>{actionError}</p> : null}
      <WorkflowRunGraphPreview
        steps={runGraphSteps}
        pendingStepRunId={pendingStepId}
        onRerunStep={(input) => {
          void handleRerunStep({ stepRunId: input.stepRunId, issueId: input.issueId });
        }}
      />
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>Step</th>
            <th style={thStyle}>Issue</th>
            <th style={thStyle}>Type</th>
            <th style={thStyle}>Status</th>
            <th style={thStyle}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {detail.data.stepRuns.map((step) => {
            const canRerun = Boolean(step.id && companyId.trim() && (step.issueId || step.id));
            const isPending = pendingStepId === step.id;
            return (
              <tr key={step.id}>
                <td style={tdStyle}>
                  <div style={{ display: "grid", gap: "2px" }}>
                    <span style={{ fontWeight: 600, fontSize: "13px" }}>{step.stepTitle || step.stepId}</span>
                    <span style={{ ...mutedTextStyle, fontSize: "11px" }}>{step.stepId}</span>
                  </div>
                </td>
                <td style={tdStyle}>
                  {step.issueId ? (
                    <a
                      href={buildIssueHref({
                        issueId: step.issueId,
                        issueIdentifier: step.issueIdentifier,
                        currentPathname: currentBrowserPathname(),
                      })}
                      style={{ color: "var(--link, #60a5fa)", fontSize: "12px", textDecoration: "none" }}
                      title={step.issueId}
                    >
                      {step.issueIdentifier || step.issueId.slice(0, 8)}
                    </a>
                  ) : (
                    <span style={mutedTextStyle}>-</span>
                  )}
                </td>
                <td style={tdStyle}>{step.stepType || "-"}</td>
                <td style={tdStyle}>
                  <span style={statusBadgeStyle(step.status)}>{step.status}</span>
                </td>
                <td style={tdStyle}>
                  <button
                    type="button"
                    style={!canRerun || isPending ? { ...buttonStyle, ...buttonDisabledStyle } : buttonStyle}
                    disabled={!canRerun || isPending}
                    onClick={() => {
                      void handleRerunStep({ stepRunId: step.id, issueId: step.issueId });
                    }}
                  >
                    {isPending ? "Rerunning..." : "Rerun Step"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ActiveRunsTable({
  activeRuns,
  companyId,
  onAbort,
  onRefreshOverview,
  highlightedRunId,
  inspectedRunId,
  onInspectRun,
}: {
  activeRuns: WorkflowOverviewData["activeRuns"];
  companyId: string;
  onAbort: (runId: string) => void;
  onRefreshOverview: () => Promise<void>;
  highlightedRunId: string | null;
  inspectedRunId?: string | null;
  onInspectRun?: (runId: string) => void;
}): JSX.Element {
  if (!Array.isArray(activeRuns) || activeRuns.length === 0) {
    return <p style={mutedTextStyle}>No active runs.</p>;
  }

  const pageSize = 10;
  const [page, setPage] = useState(1);
  const [expandedRunIds, setExpandedRunIds] = useState<Set<string>>(() => new Set());
  const totalPages = Math.max(1, Math.ceil(activeRuns.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * pageSize;
  const visibleRuns = activeRuns.slice(pageStart, pageStart + pageSize);

  useEffect(() => {
    setPage(1);
  }, [activeRuns.length]);

  return (
    <div>
      <table key="active-runs-table" style={tableStyle}>
        <thead key="active-runs-head">
          <tr key="active-runs-head-row">
            <th key="workflow" style={thStyle}>Workflow</th>
            <th key="run" style={thStyle}>Run</th>
            <th key="issue" style={thStyle}>Issue</th>
            <th key="status" style={thStyle}>Status</th>
            <th key="started" style={thStyle}>Started</th>
            <th key="actions" style={thStyle}>Actions</th>
          </tr>
        </thead>
        <tbody key="active-runs-body">
          {visibleRuns.map((run, runIndex) => {
            const isExpanded = expandedRunIds.has(run.id);
            const isHighlighted = highlightedRunId === run.id;
            const isInspected = inspectedRunId === run.id;
            const runKey = `${run.id || run.runLabel || run.workflowName}:${pageStart + runIndex}`;
            return (
              <Fragment key={runKey}>
              <tr key={`${runKey}:summary`} style={isHighlighted ? highlightedRunRowStyle : undefined}>
                <td key="workflow" style={tdStyle}>{run.workflowName}</td>
                <td key="run" style={tdStyle}>
	                  {run.runLabel && <span key="label" style={{ fontSize: "12px", fontWeight: 600 }}>{run.runLabel}</span>}
	                  {isHighlighted ? <span key="highlight" style={{ ...statusBadgeStyle("running"), marginLeft: "6px" }}>new</span> : null}
	                  {isInspected ? <span key="inspected" style={{ ...graphPolicyBadgeStyle, marginLeft: "6px", color: "#38bdf8" }}>overlay</span> : null}
	                </td>
                <td key="issue" style={tdStyle}>
                  {run.parentIssueId && (
                    <a
                      href={buildIssueHref({
                        issueId: run.parentIssueId,
                        issueIdentifier: run.parentIssueIdentifier,
                        currentPathname: currentBrowserPathname(),
                      })}
                      style={{ color: "var(--link, #60a5fa)", fontSize: "12px", textDecoration: "none" }}
                      title={run.parentIssueId}
                    >
                      {run.parentIssueIdentifier || run.parentIssueId.slice(0, 8)}
                    </a>
                  )}
                </td>
                <td key="status" style={tdStyle}>
                  <span style={statusBadgeStyle(run.status)}>{run.status}</span>
                </td>
                <td key="started" style={tdStyle}>{formatDateTime(run.startedAt)}</td>
                <td key="actions" style={tdStyle}>
                  <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                    <MissionRunLink missionId={run.missionId} />
                    <button
                      type="button"
                      style={buttonStyle}
                      onClick={() => {
                        setExpandedRunIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(run.id)) next.delete(run.id);
                          else next.add(run.id);
                          return next;
                        });
                      }}
	                    >
	                      {isExpanded ? "Hide Steps" : "View Steps"}
	                    </button>
	                    {onInspectRun ? (
	                      <button type="button" style={isInspected ? primaryButtonStyle : buttonStyle} onClick={() => onInspectRun(run.id)}>
	                        Inspect
	                      </button>
	                    ) : null}
	                    <button type="button" style={dangerButtonStyle} onClick={() => onAbort(run.id)}>Abort</button>
	                  </div>
                </td>
              </tr>
              {isExpanded ? (
                <tr key={`${runKey}:detail`}>
                  <td key="detail" style={tdStyle} colSpan={6}>
                    <WorkflowRunDetailPanel
                      companyId={companyId}
                      runId={run.id}
                      onRefreshOverview={onRefreshOverview}
                    />
                  </td>
                </tr>
              ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {totalPages > 1 ? (
        <div key="active-runs-pagination" style={paginationBarStyle}>
          <span key="page-info" style={paginationInfoStyle}>
            {pageStart + 1}-{Math.min(pageStart + pageSize, activeRuns.length)} / {activeRuns.length}
          </span>
          <div key="page-actions" style={{ display: "flex", gap: "8px" }}>
            <button
              type="button"
              style={currentPage <= 1 ? { ...buttonStyle, ...buttonDisabledStyle } : buttonStyle}
              disabled={currentPage <= 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >Prev</button>
            <button
              type="button"
              style={currentPage >= totalPages ? { ...buttonStyle, ...buttonDisabledStyle } : buttonStyle}
              disabled={currentPage >= totalPages}
              onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
            >Next</button>
          </div>
        </div>
      ) : (
        <Fragment key="active-runs-pagination-placeholder" />
      )}
    </div>
  );
}

function formatTriggerSource(triggerSource?: string): string {
  switch ((triggerSource ?? "").trim().toLowerCase()) {
    case "schedule":
      return "cron";
    case "label":
      return "label";
    case "api":
      return "api";
    case "manual":
      return "manual";
    default:
      return triggerSource?.trim() || "unknown";
  }
}

function RecentRunsTable({
  recentRuns,
  companyId,
  onRefreshOverview,
  highlightedRunId,
  inspectedRunId,
  onInspectRun,
}: {
  recentRuns: WorkflowOverviewData["recentRuns"];
  companyId: string;
  onRefreshOverview: () => Promise<void>;
  highlightedRunId: string | null;
  inspectedRunId?: string | null;
  onInspectRun?: (runId: string) => void;
}): JSX.Element {
  if (!Array.isArray(recentRuns) || recentRuns.length === 0) {
    return <p style={mutedTextStyle}>No recent runs.</p>;
  }

  const pageSize = 10;
  const [page, setPage] = useState(1);
  const [expandedRunIds, setExpandedRunIds] = useState<Set<string>>(() => new Set());
  const totalPages = Math.max(1, Math.ceil(recentRuns.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * pageSize;
  const visibleRuns = recentRuns.slice(pageStart, pageStart + pageSize);

  useEffect(() => {
    setPage(1);
  }, [recentRuns.length]);

  return (
    <div>
      <table key="recent-runs-table" style={tableStyle}>
        <thead key="recent-runs-head">
          <tr key="recent-runs-head-row">
            <th key="workflow" style={thStyle}>Workflow</th>
            <th key="run" style={thStyle}>Run</th>
            <th key="trigger" style={thStyle}>Trigger</th>
            <th key="issue" style={thStyle}>Issue</th>
            <th key="status" style={thStyle}>Status</th>
            <th key="started" style={thStyle}>Started</th>
            <th key="completed" style={thStyle}>Completed</th>
            <th key="actions" style={thStyle}>Actions</th>
          </tr>
        </thead>
        <tbody key="recent-runs-body">
          {visibleRuns.map((run, runIndex) => {
            const isExpanded = expandedRunIds.has(run.id);
            const isHighlighted = highlightedRunId === run.id;
            const isInspected = inspectedRunId === run.id;
            const runKey = `${run.id || run.runLabel || run.workflowName}:${pageStart + runIndex}`;
            return (
              <Fragment key={runKey}>
              <tr key={`${runKey}:summary`} style={isHighlighted ? highlightedRunRowStyle : undefined}>
                <td key="workflow" style={tdStyle}>{run.workflowName}</td>
                <td key="run" style={tdStyle}>
	                  {run.runLabel && <span key="label" style={{ fontSize: "12px", fontWeight: 600 }}>{run.runLabel}</span>}
	                  {isHighlighted ? <span key="highlight" style={{ ...statusBadgeStyle("running"), marginLeft: "6px" }}>new</span> : null}
	                  {isInspected ? <span key="inspected" style={{ ...graphPolicyBadgeStyle, marginLeft: "6px", color: "#38bdf8" }}>overlay</span> : null}
	                </td>
                <td key="trigger" style={tdStyle}>{formatTriggerSource(run.triggerSource)}</td>
                <td key="issue" style={tdStyle}>
                  {run.parentIssueId ? (
                    <a
                      href={buildIssueHref({
                        issueId: run.parentIssueId,
                        issueIdentifier: run.parentIssueIdentifier,
                        currentPathname: currentBrowserPathname(),
                      })}
                      style={{ color: "var(--link, #60a5fa)", fontSize: "12px", textDecoration: "none" }}
                      title={run.parentIssueId}
                    >
                      {run.parentIssueIdentifier || run.parentIssueId.slice(0, 8)}
                    </a>
                  ) : (
                    <span style={mutedTextStyle}>-</span>
                  )}
                </td>
                <td key="status" style={tdStyle}>
                  <span style={statusBadgeStyle(run.status)}>{run.status}</span>
                </td>
                <td key="started" style={tdStyle}>{formatDateTime(run.startedAt)}</td>
                <td key="completed" style={tdStyle}>{run.completedAt ? formatDateTime(run.completedAt) : "-"}</td>
                <td key="actions" style={tdStyle}>
                  <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                    <MissionRunLink missionId={run.missionId} />
                    <button
                      type="button"
                      style={buttonStyle}
                      onClick={() => {
                        setExpandedRunIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(run.id)) next.delete(run.id);
                          else next.add(run.id);
                          return next;
                        });
                      }}
                    >
                      {isExpanded ? "Hide Steps" : "View Steps"}
                    </button>
                    {onInspectRun ? (
                      <button type="button" style={isInspected ? primaryButtonStyle : buttonStyle} onClick={() => onInspectRun(run.id)}>
                        Inspect
                      </button>
                    ) : null}
                  </div>
	                </td>
              </tr>
              {isExpanded ? (
                <tr key={`${runKey}:detail`}>
                  <td key="detail" style={tdStyle} colSpan={8}>
                    <WorkflowRunDetailPanel
                      companyId={companyId}
                      runId={run.id}
                      onRefreshOverview={onRefreshOverview}
                    />
                  </td>
                </tr>
              ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {totalPages > 1 ? (
        <div key="recent-runs-pagination" style={paginationBarStyle}>
          <span key="page-info" style={paginationInfoStyle}>
            {pageStart + 1}-{Math.min(pageStart + pageSize, recentRuns.length)} / {recentRuns.length}
          </span>
          <div key="page-actions" style={{ display: "flex", gap: "8px" }}>
            <button
              type="button"
              style={currentPage <= 1 ? { ...buttonStyle, ...buttonDisabledStyle } : buttonStyle}
              disabled={currentPage <= 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >Prev</button>
            <button
              type="button"
              style={currentPage >= totalPages ? { ...buttonStyle, ...buttonDisabledStyle } : buttonStyle}
              disabled={currentPage >= totalPages}
              onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
            >Next</button>
          </div>
        </div>
      ) : (
        <Fragment key="recent-runs-pagination-placeholder" />
      )}
    </div>
  );
}

export function WorkflowPage(props: PluginPageProps): JSX.Element {
  const hostContext = useHostContext();
  const companyId = hostContext.companyId ?? props.context?.companyId ?? "";
  const overview = useWorkflowOverview(companyId);
  const { tools: availableTools, grants: availableToolGrants, toolSystem } = useAvailableWorkflowTools(companyId);
  const createWorkflow = usePluginAction("create-workflow");
  const abortRun = usePluginAction("abort-run");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [workflowScopeFilter, setWorkflowScopeFilter] = useState<WorkflowScopeFilter>("reusable");
  const [workflowStatusFilter, setWorkflowStatusFilter] = useState<StatusFilter>("active");
  const [runHistoryScope, setRunHistoryScope] = useState<WorkflowRunHistoryScope>("all");
  const [activeRunsScope, setActiveRunsScope] = useState<WorkflowRunHistoryScope>("all");
  const [selectedHistoryWorkflowId, setSelectedHistoryWorkflowId] = useState<string | null>(null);
  const [navigatorSearch, setNavigatorSearch] = useState("");
  const [showNewWorkflowForm, setShowNewWorkflowForm] = useState(false);
  const [definitionsCollapsed, setDefinitionsCollapsed] = useState(false);
  const [definitionsHeight, setDefinitionsHeight] = useState<number | null>(null);
  const definitionsResizeRef = useRef<number>(0);
  const definitionsStartY = useRef<number>(0);
  const [newWorkflowName, setNewWorkflowName] = useState("");
  const [newWorkflowDescription, setNewWorkflowDescription] = useState("");
  const [newWorkflowSteps, setNewWorkflowSteps] = useState<StepDraft[]>([]);
  const [newStepMode, setNewStepMode] = useState<StepEditorMode>("graph");
  const [newJsonText, setNewJsonText] = useState("[]");
  const [newFlowInputsText, setNewFlowInputsText] = useState("[]");
  const [newFlowEnvVariablesText, setNewFlowEnvVariablesText] = useState("[]");
  const [newTestInputPresetsText, setNewTestInputPresetsText] = useState("[]");
  const [newTriggerLabels, setNewTriggerLabels] = useState("");
  const [newLabelIds, setNewLabelIds] = useState<string[]>([]);
  const [showNewLabelForm, setShowNewLabelForm] = useState<boolean>(false);
  const [newLabelName, setNewLabelName] = useState<string>("");
  const [newLabelColor, setNewLabelColor] = useState<string>("#6366f1");
  const [creatingLabel, setCreatingLabel] = useState<boolean>(false);
  const [newSchedule, setNewSchedule] = useState("");
  const [newMaxDailyRuns, setNewMaxDailyRuns] = useState("");
  const [newTimezone, setNewTimezone] = useState("Asia/Seoul");
  const [newProjectId, setNewProjectId] = useState("");
  const [newCreateParentIssuePolicy, setNewCreateParentIssuePolicy] = useState<CreateParentIssuePolicy>("when_multiple_steps");
  const [createError, setCreateError] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [labels, setLabels] = useState<LabelOption[]>([]);
  const [highlightedRunId, setHighlightedRunId] = useState<string | null>(null);

  async function refreshOverview(): Promise<void> {
    if (isRefreshing) {
      return;
    }
    setIsRefreshing(true);
    try {
      await overview.refresh();
    } finally {
      setIsRefreshing(false);
    }
  }

  useEffect(() => {
    const nextLabels = overview.data?.labels ?? [];
    setLabels(nextLabels.map((label) => ({
      id: String(label.id),
      name: String(label.name ?? label.id),
      color: typeof label.color === "string" && label.color.trim() ? label.color : "#6366f1",
    })));
  }, [overview.data?.labels]);

  useEffect(() => {
    if (!companyId.trim()) {
      setLabels([]);
    }
  }, [companyId]);

  async function refreshLabels(): Promise<LabelOption[]> {
    const next = await fetchCompanyLabels(companyId);
    setLabels(next);
    return next;
  }

  function handleAbortRun(runId: string): void {
    void (async () => {
      try {
        await abortRun({ runId });
        await refreshOverview();
      } catch { /* ignore */ }
    })();
  }

  function resetCreateForm(): void {
    setNewWorkflowName("");
    setNewWorkflowDescription("");
    setNewWorkflowSteps([]);
    setNewStepMode("graph");
    setNewJsonText("[]");
    setNewFlowInputsText("[]");
    setNewFlowEnvVariablesText("[]");
    setNewTestInputPresetsText("[]");
    setNewTriggerLabels("");
    setNewLabelIds([]);
    setShowNewLabelForm(false);
    setNewLabelName("");
    setNewLabelColor("#6366f1");
    setNewSchedule("");
    setNewMaxDailyRuns("");
    setNewTimezone("Asia/Seoul");
    setNewProjectId("");
    setNewCreateParentIssuePolicy("when_multiple_steps");
    setCreateError("");
    setShowNewWorkflowForm(false);
  }

  async function onCreateWorkflow(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const name = newWorkflowName.trim();
    if (!name) {
      setCreateError("name은 필수입니다.");
      return;
    }

    let parsedSteps: unknown[];
    if (newStepMode === "json") {
      try {
        parsedSteps = JSON.parse(newJsonText);
        if (!Array.isArray(parsedSteps)) { setCreateError("steps는 JSON 배열이어야 합니다."); return; }
      } catch (e) { setCreateError(`JSON 파싱 실패: ${e instanceof Error ? e.message : String(e)}`); return; }
    } else {
      parsedSteps = stepsToJson(newWorkflowSteps);
    }
    const invalidStep = parsedSteps.find((s) => !(s as Record<string, unknown>).id);
    if (invalidStep) {
      setCreateError("모든 step에 ID가 필요합니다.");
      return;
    }

    setCreateError("");
    setIsCreating(true);
    try {
      const parsedMaxDailyRuns = normalizeMaxDailyRunsInput(newMaxDailyRuns);
      if (parsedMaxDailyRuns.error) {
        setCreateError(parsedMaxDailyRuns.error);
        return;
      }
      const description = newWorkflowDescription.trim();
      const triggerLabels = newTriggerLabels.split(",").map((l) => l.trim()).filter(Boolean);
      const labelIds = newLabelIds.map((l) => l.trim()).filter(Boolean);
      const legacyMetadata = buildWorkflowInterfaceMetadata({}, newFlowInputsText, newFlowEnvVariablesText, newTestInputPresetsText);
      if (legacyMetadata.error) {
        setCreateError(legacyMetadata.error);
        return;
      }
      const workflow = {
        name,
        description,
        status: "active",
        steps: parsedSteps,
        maxDailyRuns: parsedMaxDailyRuns.value,
        timezone: newTimezone.trim() || undefined,
        createParentIssuePolicy: newCreateParentIssuePolicy,
        legacyMetadata: legacyMetadata.value,
        ...(triggerLabels.length > 0 ? { triggerLabels } : {}),
        ...(labelIds.length > 0 ? { labelIds } : {}),
        ...(newSchedule.trim() ? { schedule: newSchedule.trim() } : {}),
        ...(newProjectId.trim() ? { projectId: newProjectId.trim() } : {}),
      };
      await createWorkflow({
        companyId,
        workflow,
        ...workflow,
      });
      resetCreateForm();
      await refreshOverview();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCreateError(`생성 실패: ${message}`);
    } finally {
      setIsCreating(false);
    }
  }

  async function onCreateLabelForCreateForm(): Promise<void> {
    const name = newLabelName.trim();
    if (!name) {
      setCreateError("새 레이블 이름을 입력하세요.");
      return;
    }
    if (!companyId.trim()) {
      setCreateError("companyId가 없어 레이블을 생성할 수 없습니다.");
      return;
    }

    setCreateError("");
    setCreatingLabel(true);
    try {
      const created = await createCompanyLabel(companyId, name, newLabelColor);
      const nextLabels = await refreshLabels();
      const createdId = nextLabels.find((label) => label.id === created.id)?.id ?? created.id;
      setNewLabelIds((prev) => (prev.includes(createdId) ? prev : [...prev, createdId]));
      setNewLabelName("");
      setNewLabelColor("#6366f1");
      setShowNewLabelForm(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCreateError(`레이블 생성 실패: ${message}`);
    } finally {
      setCreatingLabel(false);
    }
  }

  const refreshButtonLabel = isRefreshing ? "갱신 중..." : "↻ Refresh";

  const allWorkflows = overview.data?.workflows ?? [];
  const reusableWorkflows = useMemo(
    () => allWorkflows.filter((workflow) => !isManualMissionPlanWorkflow(workflow)),
    [allWorkflows],
  );
  const manualMissionWorkflows = useMemo(
    () => allWorkflows.filter(isManualMissionPlanWorkflow),
    [allWorkflows],
  );
  const scopedWorkflows = workflowScopeFilter === "manual_mission" ? manualMissionWorkflows : reusableWorkflows;
  const activeWorkflows = useMemo(
    () => scopedWorkflows.filter((w) => w.status.trim().toLowerCase() !== "archived"),
    [scopedWorkflows],
  );
  const archivedWorkflows = useMemo(
    () => scopedWorkflows.filter((w) => w.status.trim().toLowerCase() === "archived"),
    [scopedWorkflows],
  );
  const filteredWorkflows = workflowStatusFilter === "active" ? activeWorkflows : archivedWorkflows;

  if (overview.loading) {
    return (
      <div data-plugin-id={PLUGIN_ID} style={pageStyle}>
        <div key="workflow-page-header" style={headerRowStyle}>
          <h1 key="title" style={titleStyle}>Workflows</h1>
          <button
            key="refresh"
            type="button"
            onClick={() => {
              void refreshOverview();
            }}
            disabled={isRefreshing}
            style={isRefreshing ? { ...buttonStyle, ...buttonDisabledStyle } : buttonStyle}
          >
            {refreshButtonLabel}
          </button>
        </div>
        <p key="loading" style={mutedTextStyle}>Loading workflows...</p>
      </div>
    );
  }

  if (overview.error) {
    return (
      <div data-plugin-id={PLUGIN_ID} style={pageStyle}>
        <div key="workflow-page-header" style={headerRowStyle}>
          <h1 key="title" style={titleStyle}>Workflows</h1>
          <button
            key="refresh"
            type="button"
            onClick={() => {
              void refreshOverview();
            }}
            disabled={isRefreshing}
            style={isRefreshing ? { ...buttonStyle, ...buttonDisabledStyle } : buttonStyle}
          >
            {refreshButtonLabel}
          </button>
        </div>
        <ErrorState
          key="error-state"
          message={`Failed to load workflows: ${overview.error.message}`}
          onRetry={refreshOverview}
          retrying={isRefreshing}
        />
      </div>
    );
  }

  const data = {
    workflows: overview.data?.workflows ?? [],
    activeRuns: overview.data?.activeRuns ?? [],
    recentRuns: overview.data?.recentRuns ?? [],
    projects: overview.data?.projects ?? [],
    labels: overview.data?.labels ?? [],
  };
  const scopedActiveRuns = filterRunsForWorkflows(data.activeRuns, scopedWorkflows);
  const scopedRecentRuns = filterRunsForWorkflows(data.recentRuns, scopedWorkflows);
  const selectedHistoryWorkflow = selectedHistoryWorkflowId
    ? scopedWorkflows.find((workflow) => workflow.id === selectedHistoryWorkflowId) ?? null
    : null;
  const selectedHistoryRuns = selectedHistoryWorkflow
    ? filterRunsForWorkflows(scopedRecentRuns, [selectedHistoryWorkflow])
    : [];
  const historyRuns = runHistoryScope === "selected" && selectedHistoryWorkflow
    ? selectedHistoryRuns
    : scopedRecentRuns;
  const canFilterSelectedHistory = Boolean(selectedHistoryWorkflow);
  const selectedActiveRuns = selectedHistoryWorkflow
    ? filterRunsForWorkflows(scopedActiveRuns, [selectedHistoryWorkflow])
    : [];
  const displayActiveRuns = activeRunsScope === "selected" && selectedHistoryWorkflow
    ? selectedActiveRuns
    : scopedActiveRuns;

  return (
    <div data-plugin-id={PLUGIN_ID} id="wf-page" style={pageStyle}>
      <div id="wf-header" key="workflow-page-header" style={{ ...headerRowStyle, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <h1 key="title" style={titleStyle}>Workflows</h1>
          <button
            type="button"
            title={showHelp ? "도움말 닫기" : "도움말"}
            aria-label="Help"
            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: "20px", height: "20px", borderRadius: "50%", border: "1px solid var(--muted-foreground, #94a3b8)", background: "transparent", color: "var(--muted-foreground, #94a3b8)", cursor: "pointer", fontSize: "12px", fontWeight: 700, padding: 0, lineHeight: 1 }}
            onClick={() => setShowHelp(!showHelp)}
          >
            ?
          </button>
        </div>
        <div key="header-actions" style={{ display: "flex", gap: "6px", alignItems: "center" }}>
          <button
            key="new-workflow"
            type="button"
            style={showNewWorkflowForm ? { ...buttonStyle, ...buttonDisabledStyle } : primaryButtonStyle}
            disabled={showNewWorkflowForm}
            onClick={() => {
              setCreateError("");
              setShowNewWorkflowForm(true);
            }}
          >
            + New Workflow
          </button>
          <button
            key="refresh"
            type="button"
            onClick={() => {
              void refreshOverview();
            }}
            disabled={isRefreshing}
            style={isRefreshing ? { ...buttonStyle, ...buttonDisabledStyle } : buttonStyle}
          >
            {refreshButtonLabel}
          </button>
        </div>
      </div>

      <section id="wf-definitions" key="definitions-section" style={{ ...workflowFocusSectionStyle, height: definitionsCollapsed || definitionsHeight === null ? "auto" : `${definitionsHeight}px`, overflow: definitionsHeight === null ? "visible" : "auto", minHeight: definitionsCollapsed ? "auto" : "200px" }}>
        <div key="definitions-toolbar" style={{ ...workflowFocusToolbarStyle, flexShrink: 0, height: "fit-content" }}>
          <div key="definition-controls" style={workflowFocusToolbarGroupStyle}>
            <input
              key="navigator-search"
              style={{ ...inputStyle, width: "200px", fontSize: "12px" }}
              value={navigatorSearch}
              onChange={(event) => setNavigatorSearch(event.target.value)}
              placeholder="Search workflows..."
              aria-label="Search workflows"
            />
          </div>
          <div key="scope-filter" style={workflowFocusToolbarGroupStyle}>
            <button key="reusable" type="button" style={filterTabStyle(workflowScopeFilter === "reusable")} onClick={() => setWorkflowScopeFilter("reusable")}>
              Reusable ({reusableWorkflows.length})
            </button>
            <button key="manual-mission" type="button" style={filterTabStyle(workflowScopeFilter === "manual_mission")} onClick={() => setWorkflowScopeFilter("manual_mission")}>
              Manual ({manualMissionWorkflows.length})
            </button>
            <button key="active" type="button" style={filterTabStyle(workflowStatusFilter === "active")} onClick={() => setWorkflowStatusFilter("active")}>
              활성 ({activeWorkflows.length})
            </button>
            <button key="archived" type="button" style={filterTabStyle(workflowStatusFilter === "archived")} onClick={() => setWorkflowStatusFilter("archived")}>
              보관 ({archivedWorkflows.length})
            </button>
            <button
              key="collapse-toggle"
              type="button"
              style={buttonStyle}
              onClick={() => setDefinitionsCollapsed((prev) => !prev)}
            >
              {definitionsCollapsed ? "▼" : "▲"}
            </button>
          </div>
        </div>
        {!definitionsCollapsed && (
          <Fragment key="definitions-body">
        {showNewWorkflowForm ? (
          <form key="new-workflow-form" style={workflowCreateShellStyle} onSubmit={(event) => void onCreateWorkflow(event)}>
            <div key="create-header" style={workflowCreateHeaderStyle}>
              <div key="identity" style={workflowCreateIdentityStyle}>
                <div key="name-field" style={workflowCreateFieldStyle}>
                  <label key="label" style={{ ...mutedTextStyle, fontSize: "11px", fontWeight: 700 }}>Workflow name</label>
                  <input
                    key="input"
                    style={inputStyle}
                    value={newWorkflowName}
                    onChange={(event) => setNewWorkflowName(event.target.value)}
                    placeholder="Daily market signal digest"
                    required
                  />
                </div>
                <div key="description-field" style={workflowCreateFieldStyle}>
                  <label key="label" style={{ ...mutedTextStyle, fontSize: "11px", fontWeight: 700 }}>Description</label>
                  <textarea
                    key="textarea"
                    style={{ ...textareaStyle, minHeight: "38px" }}
                    value={newWorkflowDescription}
                    onChange={(event) => setNewWorkflowDescription(event.target.value)}
                    rows={2}
                    placeholder="What this workflow does"
                  />
                </div>
              </div>
              <div key="create-actions" style={workflowCreateActionsStyle}>
                <GraphModeTabs key="mode-tabs" mode={newStepMode} onChange={setNewStepMode} />
                <button
                  type="submit"
                  style={isCreating ? { ...primaryButtonStyle, ...buttonDisabledStyle } : primaryButtonStyle}
                  disabled={isCreating}
                >
                  Save
                </button>
                <button
                  type="button"
                  style={isCreating ? { ...buttonStyle, ...buttonDisabledStyle } : buttonStyle}
                  disabled={isCreating}
                  onClick={resetCreateForm}
                >
                  Cancel
                </button>
              </div>
            </div>

            <div key="create-setup-strip" style={workflowCreateSetupStripStyle}>
              <div key="schedule-field" style={workflowCreateFieldStyle}>
                <label key="label" style={{ ...mutedTextStyle, fontSize: "11px" }}>Schedule (cron)</label>
                <input key="input" style={inputStyle} value={newSchedule} onChange={(e) => setNewSchedule(e.target.value)} placeholder="0 9 * * *" />
              </div>
              <div key="timezone-field" style={workflowCreateFieldStyle}>
                <label key="label" style={{ ...mutedTextStyle, fontSize: "11px" }}>Timezone</label>
                <input key="input" style={inputStyle} value={newTimezone} onChange={(e) => setNewTimezone(e.target.value)} placeholder="Asia/Seoul" />
              </div>
              <div key="project-field" style={workflowCreateFieldStyle}>
                <label key="label" style={{ ...mutedTextStyle, fontSize: "11px" }}>Project</label>
                <select key="select" style={selectStyle} value={newProjectId} onChange={(e) => setNewProjectId(e.target.value)}>
                  {[
                    <option key="none" value="">— none —</option>,
                    ...(data.projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>),
                  ]}
                </select>
              </div>
              <div key="max-daily-runs-field" style={workflowCreateFieldStyle}>
                <label key="label" style={{ ...mutedTextStyle, fontSize: "11px" }}>Max Daily Runs</label>
                <input key="input" style={inputStyle} type="number" min={0} step={1} value={newMaxDailyRuns} onChange={(e) => setNewMaxDailyRuns(e.target.value)} placeholder="blank=1/day" />
              </div>
              <div key="trigger-labels-field" style={workflowCreateFieldStyle}>
                <label key="label" style={{ ...mutedTextStyle, fontSize: "11px" }}>Trigger labels</label>
                <input
                  key="input"
                  style={inputStyle}
                  value={newTriggerLabels}
                  onChange={(event) => setNewTriggerLabels(event.target.value)}
                  placeholder="daily-tech-research"
                />
              </div>
            </div>

            {!toolSystem.available ? (
              <p key="tool-system-unavailable" style={{ ...mutedTextStyle, padding: "0 12px", fontSize: "12px" }}>
                Workflow tools inactive: {toolSystem.reason ?? "no workflow tools are available."}
              </p>
            ) : (
              <Fragment key="tool-system-available-placeholder" />
            )}

            <div key="create-workspace" style={workflowCreateWorkspaceStyle}>
              <StepWorkspaceEditor
                key="steps-editor"
                steps={newWorkflowSteps}
                onChange={setNewWorkflowSteps}
                mode={newStepMode}
                onModeChange={setNewStepMode}
                jsonText={newJsonText}
                onJsonTextChange={setNewJsonText}
                onJsonError={setCreateError}
                triggerSummary={summarizeWorkflowGraphTriggers({
                  schedule: newSchedule,
                  timezone: newTimezone,
                  triggerLabels: newTriggerLabels,
                })}
                testInterfaceInput={{
                  graphFlowInputs: newFlowInputsText,
                  graphFlowEnvVariables: newFlowEnvVariablesText,
                  graphTestInputPresets: newTestInputPresetsText,
                }}
                availableTools={availableTools}
                availableToolGrants={availableToolGrants}
                surface={newStepMode === "graph" ? "focus" : "stacked"}
              />
            </div>

            {createError ? <p key="create-error" style={{ ...mutedTextStyle, padding: "0 12px 12px" }}>{createError}</p> : <Fragment key="create-error-placeholder" />}
          </form>
        ) : (
          <Fragment key="new-workflow-form-placeholder" />
        )}
        <DefinitionsTable
          key="definitions-table"
          workflows={filteredWorkflows}
          companyId={companyId}
          refreshOverview={refreshOverview}
          projects={data.projects ?? []}
          labels={labels}
          refreshLabels={refreshLabels}
          activeRuns={scopedActiveRuns}
          recentRuns={scopedRecentRuns}
          onManualRunStarted={setHighlightedRunId}
          highlightedRunId={highlightedRunId}
          onAbortRun={handleAbortRun}
          navigatorSearch={navigatorSearch}
          onEditingWorkflowChange={setSelectedHistoryWorkflowId}
          availableTools={availableTools}
          availableToolGrants={availableToolGrants}
        />
          </Fragment>
        )}
      </section>

      {!definitionsCollapsed && (
        <div
          id="wf-resize-handle"
          key="definitions-resize-handle"
          style={{
            height: "6px",
            cursor: "ns-resize",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "var(--border, #334155)",
            borderRadius: "3px",
            margin: "-2px 0",
            position: "relative",
          }}
          onMouseDown={(e) => {
            e.preventDefault();
            definitionsStartY.current = e.clientY;
            definitionsResizeRef.current = definitionsHeight ?? (e.currentTarget.previousElementSibling as HTMLElement)?.offsetHeight ?? 420;
            const onMove = (ev: MouseEvent) => {
              const delta = ev.clientY - definitionsStartY.current;
              const next = Math.max(200, definitionsResizeRef.current + delta);
              setDefinitionsHeight(next);
            };
            const onUp = () => {
              window.removeEventListener("mousemove", onMove);
              window.removeEventListener("mouseup", onUp);
              document.body.style.cursor = "";
            };
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
            document.body.style.cursor = "ns-resize";
          }}
        >
          <div style={{ width: "40px", height: "2px", background: "var(--muted-foreground, #94a3b8)", borderRadius: "1px" }} />
        </div>
      )}

      <section id="wf-active-runs" key="active-runs-section" style={workflowFocusSectionStyle}>
        <div key="active-runs-toolbar" style={workflowFocusToolbarStyle}>
          <div key="active-runs-title" style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
            <h2 key="title" style={{ ...sectionTitleStyle, fontSize: "14px" }}>Active Runs</h2>
            {activeRunsScope === "selected" && selectedHistoryWorkflow ? (
              <span key="selected-name" style={{ ...mutedTextStyle, fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {selectedHistoryWorkflow.name}
              </span>
            ) : (
              <Fragment key="active-selected-name-placeholder" />
            )}
          </div>
          <div key="active-runs-filters" style={workflowFocusToolbarGroupStyle}>
            <button key="all" type="button" style={filterTabStyle(activeRunsScope === "all")} onClick={() => setActiveRunsScope("all")}>
              All ({scopedActiveRuns.length})
            </button>
            <button
              key="selected"
              type="button"
              style={canFilterSelectedHistory ? filterTabStyle(activeRunsScope === "selected") : { ...filterTabStyle(activeRunsScope === "selected"), ...buttonDisabledStyle }}
              disabled={!canFilterSelectedHistory}
              onClick={() => setActiveRunsScope("selected")}
            >
              Selected ({selectedActiveRuns.length})
            </button>
          </div>
        </div>
        <ActiveRunsTable
          activeRuns={displayActiveRuns}
          companyId={companyId}
          onAbort={handleAbortRun}
          onRefreshOverview={refreshOverview}
          highlightedRunId={highlightedRunId}
        />
      </section>

      <section id="wf-run-history" key="run-history-section" style={workflowRunHistorySectionStyle}>
        <div key="run-history-toolbar" style={workflowFocusToolbarStyle}>
          <div key="run-history-title" style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
            <h2 key="title" style={{ ...sectionTitleStyle, fontSize: "14px" }}>Run History</h2>
            {runHistoryScope === "selected" && selectedHistoryWorkflow ? (
              <span key="selected-name" style={{ ...mutedTextStyle, fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {selectedHistoryWorkflow.name}
              </span>
            ) : (
              <Fragment key="selected-name-placeholder" />
            )}
          </div>
          <div key="run-history-filters" style={workflowFocusToolbarGroupStyle}>
            <button key="all" type="button" style={filterTabStyle(runHistoryScope === "all")} onClick={() => setRunHistoryScope("all")}>
              All ({scopedRecentRuns.length})
            </button>
            <button
              key="selected"
              type="button"
              style={canFilterSelectedHistory ? filterTabStyle(runHistoryScope === "selected") : { ...filterTabStyle(runHistoryScope === "selected"), ...buttonDisabledStyle }}
              disabled={!canFilterSelectedHistory}
              onClick={() => setRunHistoryScope("selected")}
            >
              Selected ({selectedHistoryRuns.length})
            </button>
          </div>
        </div>
        <RecentRunsTable
          recentRuns={historyRuns}
          companyId={companyId}
          onRefreshOverview={refreshOverview}
          highlightedRunId={highlightedRunId}
        />
      </section>

      {showHelp && (
        <>
          <div
            key="help-overlay"
            style={{ position: "fixed", inset: 0, zIndex: 9998, background: "transparent" }}
            onClick={() => setShowHelp(false)}
          />
          <div
            id="wf-help"
            key="help-popup"
            style={{
              position: "absolute",
              top: "44px",
              left: "100px",
              zIndex: 9999,
              width: "440px",
              maxHeight: "70vh",
              overflowY: "auto",
              padding: "16px",
              borderRadius: "10px",
              border: "1px solid var(--border, #334155)",
              background: "var(--card, #0f172a)",
              boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
            }}
          >
            <div key="help-content" style={mutedTextStyle}>
              <p style={{ ...mutedTextStyle, fontWeight: 600, fontSize: "15px", marginBottom: "8px" }}>Workflow Engine 도움말</p>

              <p style={{ ...mutedTextStyle, fontWeight: 600, marginTop: "12px" }}>기본 개념</p>
              <ul style={{ margin: "4px 0", paddingLeft: "20px" }}>
                <li><strong>Workflow</strong>: 여러 Step으로 구성된 자동화 파이프라인</li>
                <li><strong>Step</strong>: Tool(시스템 실행) 또는 Agent(에이전트 작업) 유형</li>
                <li><strong>Tool Step</strong>: Tool Registry에 등록된 도구를 시스템이 직접 실행</li>
                <li><strong>Agent Step</strong>: 지정된 에이전트가 이슈를 받아 작업 수행</li>
              </ul>

              <p style={{ ...mutedTextStyle, fontWeight: 600, marginTop: "12px" }}>Step 설정</p>
              <ul style={{ margin: "4px 0", paddingLeft: "20px" }}>
                <li><strong>ID</strong>: 고유 식별자 (dependsOn에서 참조)</li>
                <li><strong>Type</strong>: Tool(도구 실행) / Agent(에이전트 작업)</li>
                <li><strong>Depends On</strong>: 선행 step ID (쉼표 구분, 비워두면 첫 step)</li>
                <li><strong>Tools</strong>: Agent step에서 사용할 도구 이름 (사용법이 자동 전달됨)</li>
                <li><strong>On Failure</strong>: 실패 시 정책 (retry/skip/abort)</li>
              </ul>

              <p style={{ ...mutedTextStyle, fontWeight: 600, marginTop: "12px" }}>변수</p>
              <p style={mutedTextStyle}>Step title에 사용 가능한 변수:</p>
              <ul style={{ margin: "4px 0", paddingLeft: "20px" }}>
                <li><code>{"{$date}"}</code> — 실행 날짜 (2026-03-25)</li>
                <li><code>{"{$runNumber}"}</code> — 당일 실행 번호 (1, 2, ...)</li>
                <li><code>{"{$runLabel}"}</code> — 실행 라벨 (#2026-03-25-1)</li>
                <li><code>{"{$workflowName}"}</code> — 워크플로우 이름</li>
              </ul>

              <p style={{ ...mutedTextStyle, fontWeight: 600, marginTop: "12px" }}>Schedule (Cron)</p>
              <ul style={{ margin: "4px 0", paddingLeft: "20px" }}>
                <li>형식: 분 시 일 월 요일 (예: <code>0 9 * * *</code> = 매일 9시)</li>
                <li>Reconciler가 5분 간격으로 체크하여 실행</li>
              </ul>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function Workflows(): JSX.Element {
  return <WorkflowPage context={{}} />;
}

export function WorkflowDashboardWidget(props: PluginWidgetProps): JSX.Element {
  const hostContext = useHostContext();
  const companyId = hostContext.companyId ?? props.context?.companyId ?? "";
  const overview = useWorkflowOverview(companyId);

  if (overview.loading) {
    return (
      <div data-plugin-id={PLUGIN_ID} style={widgetStyle}>
        <h2 style={widgetTitleStyle}>Workflows</h2>
        <span style={mutedTextStyle}>Loading workflows...</span>
      </div>
    );
  }

  if (overview.error) {
    return (
      <div data-plugin-id={PLUGIN_ID} style={widgetStyle}>
        <h2 style={widgetTitleStyle}>Workflows</h2>
        <span style={mutedTextStyle}>Unable to load workflow summary.</span>
      </div>
    );
  }

  const data = {
    workflows: overview.data?.workflows ?? [],
    activeRuns: overview.data?.activeRuns ?? [],
    recentRuns: overview.data?.recentRuns ?? [],
    projects: overview.data?.projects ?? [],
    labels: overview.data?.labels ?? [],
  };
  const statusCounts = countStatuses(data.activeRuns);

  return (
    <div data-plugin-id={PLUGIN_ID} style={widgetStyle}>
      <h2 style={widgetTitleStyle}>Workflows</h2>
      <div style={{ display: "flex", alignItems: "baseline", gap: "8px" }}>
        <span style={widgetCountStyle}>{data.activeRuns.length}</span>
        <span style={mutedTextStyle}>active runs</span>
      </div>
      <div style={badgeRowStyle}>
        {statusCounts.length > 0 ? (
          statusCounts.map((item) => (
            <span key={item.status} style={statusBadgeStyle(item.status)}>
              {item.status}: {item.count}
            </span>
          ))
        ) : (
          <span style={mutedTextStyle}>No active runs.</span>
        )}
      </div>
    </div>
  );
}

export function WorkflowSidebarLink({ context }: { context: { companyPrefix?: string | null } }) {
  const href = context.companyPrefix ? `/${context.companyPrefix}/workflows` : "/workflows";
  const isActive = typeof window !== "undefined" && window.location.pathname === href;
  return (
    <a
      href={href}
      style={{
        display: "flex", alignItems: "center", gap: "10px", padding: "8px 12px",
        fontSize: "13px", fontWeight: 500, textDecoration: "none",
        color: isActive ? "var(--foreground, #f8fafc)" : "color-mix(in srgb, var(--foreground, #f8fafc) 80%, transparent)",
        background: isActive ? "var(--accent, rgba(125,211,252,0.12))" : "transparent",
        borderRadius: "8px",
      }}
    >
      <span>⚡ Workflows</span>
    </a>
  );
}
