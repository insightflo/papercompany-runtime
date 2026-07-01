import * as React from "react";
import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type JSX } from "react";
import { useCompany } from "../context/CompanyContext";
import { buildManualRunFeedback, buildManualRunButtonState, findNewRunId, manualRunUnavailableMessage } from "./workflows/run-feedback.js";
import { ActiveRunsTable, RecentRunsTable, WorkflowRunDebugStrip, WorkflowRunDrawer, workflowRunDrawerActionsStyle, workflowRunOverlayBannerStyle, type WorkflowRunDrawerMode } from "./workflows/workflow-runs.js";
import { jsonToSteps, parseOptionalNonNegativeInteger, parseOptionalPositiveInteger, stepsToJson, withStepDraftDefaults, type StepDraft } from "./workflows/step-draft.js";
import { appendStepAfter, applyStepRunsToGraphSteps, applyWorkflowGraphFailureRoute, assignStepsToContainer, assignStepsToGroup, buildWorkflowGraphContainerSummary, buildWorkflowGraphDataFlowMap, buildWorkflowGraphDefinitionNavigator, buildWorkflowGraphExecutionEvidenceSummary, buildWorkflowGraphExportSnapshot, buildWorkflowGraphFailureRouteSummary, buildWorkflowGraphInspectorSummary, buildWorkflowGraphModel, buildWorkflowGraphRepairPlan, buildWorkflowGraphRunDebugSummary, buildWorkflowGraphSelectionSummary, buildWorkflowGraphStructurePaletteSummary, buildWorkflowGraphTestDrawerSummary, buildWorkflowGraphWorkbenchSummary, clearStepsGroup, clearWorkflowContainer, connectSteps, disconnectSteps, duplicateWorkflowContainer, duplicateWorkflowStep, expandWorkflowGraphSelection, getWorkflowGraphStepContext, insertWorkflowStepFromPalette, normalizeGraphEdgeKind, normalizeGraphRunStatus, parseDependencies, removeWorkflowStep, renameWorkflowStep, setGraphGroupCollapsed, summarizeWorkflowGraphInterface, summarizeWorkflowGraphTriggers, updateContainerMetadata, updateGraphEdgeMetadata, updateGraphGroupMetadata, updateStepAdvancedMetadata, updateStepApprovalMetadata, updateStepDataFlowMetadata, updateStepExecutionMetadata, updateStepNote, updateStepResourceMetadata, updateStepTestingMetadata, type WorkflowGraphContainerSummary, type WorkflowGraphContainerType, type WorkflowGraphDataFlowMap, type WorkflowGraphDefinitionNavigatorItem, type WorkflowGraphEdge, type WorkflowGraphEdgeKind, type WorkflowGraphEdgeMetadataRecord, type WorkflowGraphExecutionEvidenceSummary, type WorkflowGraphFailureRouteSummary, type WorkflowGraphInspectorMode, type WorkflowGraphInspectorSummary, type WorkflowGraphInterfaceInput, type WorkflowGraphNavigatorFilter, type WorkflowGraphPaletteNodeKind, type WorkflowGraphRepairPlan, type WorkflowGraphRunStatus, type WorkflowGraphSelectionMode, type WorkflowGraphSelectionSummary, type WorkflowGraphStep, type WorkflowGraphStepContext, type WorkflowGraphTestDrawerSummary, type WorkflowGraphTriggerSummary, type WorkflowGraphWorkbenchSummary } from "./workflows/workflow-graph.js";
import { CREATE_PARENT_ISSUE_POLICIES, normalizeCreateParentIssuePolicy, type CreateParentIssuePolicy } from "./workflows/workflow-parent-policy.js";
import type { PluginPageProps, PluginWidgetProps, StepEditorMode, ProjectOption, LabelOption, WorkflowToolOption, WorkflowToolGrant, WorkflowOverviewData, StatusFilter, WorkflowScopeFilter, WorkflowRestoreKind, WorkflowSummary, WorkflowRunSummary } from "./workflows/workflow-page-types.js";
import { badgeRowStyle, buttonDisabledStyle, buttonStyle, dangerButtonStyle, filterTabStyle, graphPolicyBadgeStyle, headerRowStyle, inputStyle, mutedTextStyle, noticeStyle, pageStyle, primaryButtonStyle, sectionTitleStyle, selectStyle, statusBadgeStyle, textareaStyle, titleStyle, widgetCountStyle, widgetTitleStyle, widgetStyle } from "./workflows/workflow-page-styles.js";
import { apiBaseUrl, createCompanyLabel, fetchCompanyLabels, formatDateTime, useAvailableWorkflowTools, useHostContext, usePluginAction, useWorkflowOverview, useWorkflowRunDetail } from "./workflows/workflow-page-api.js";
import { ErrorState, FieldLabel, HelpIcon, HelpedText } from "./workflows/shared-controls.js";
import { splitCommaList, WorkflowToolPicker } from "./workflows/workflow-tool-picker.js";
import { GraphModeTabs, StepWorkspaceEditor, type StepWorkspaceGraphEditorProps } from "./workflows/step-workspace-editor.js";
import { WorkflowGraphTestDrawer } from "./workflows/graph-editor/GraphTestDrawer.js";
import { WorkflowExportPreview, WorkflowInterfaceFields, WorkflowInterfaceSummary } from "./workflows/workflow-interface-editor.js";
import { graphInspectorResizeHandleStyle, graphPaletteItems, graphShellStyle } from "./workflows/graph-editor/graphStyles.js";
import { type GraphCanvasPanState, type GraphContextMenuState, type GraphEdgeActionAnchor, type GraphNodeDragState } from "./workflows/graph-editor/graphUiUtils.js";
import { GraphCanvas } from "./workflows/graph-editor/GraphCanvas.js";
import { GraphInspector } from "./workflows/graph-editor/GraphInspector.js";

export { jsonToSteps, stepsToJson };
export type { StepDraft };

const PLUGIN_ID = "paperclip.core-workflows";

// Fix: prevent parent window from capturing arrow keys in textareas
if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement;
    if (target?.tagName === "TEXTAREA" && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.stopPropagation();
    }
  }, true);
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select" || target.isContentEditable;
}

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

const workflowConfirmOverlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 60,
  display: "grid",
  placeItems: "center",
  padding: "24px",
  background: "rgba(2, 6, 23, 0.62)",
};

const workflowConfirmDialogStyle: CSSProperties = {
  display: "grid",
  gap: "12px",
  width: "min(520px, 100%)",
  padding: "16px",
  border: "1px solid var(--border, #334155)",
  borderRadius: "10px",
  background: "var(--card, #0f172a)",
  boxShadow: "0 18px 48px rgba(0, 0, 0, 0.36)",
};

const workflowConfirmActionsStyle: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  alignItems: "center",
  flexWrap: "wrap",
  gap: "8px",
};

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

type WorkflowRunHistoryScope = "all" | "selected";

const LABEL_COLOR_PRESETS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6", "#8b5cf6", "#6366f1", "#ec4899"];

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

function clampGraphCanvasScale(value: number): number {
  return Math.min(1.8, Math.max(0.45, value));
}

function clampGraphInspectorWidth(value: number): number {
  return Math.min(620, Math.max(320, Math.round(value)));
}

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

function graphEdgeMetadataFor(step: StepDraft | null, sourceId: string): { kind: WorkflowGraphEdgeKind; label: string; condition: string } {
  const metadata = step?.graphEdgeMetadata?.[sourceId];
  return {
    kind: normalizeGraphEdgeKind(metadata?.kind),
    label: typeof metadata?.label === "string" ? metadata.label : "",
    condition: typeof metadata?.condition === "string" ? metadata.condition : "",
  };
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
  const [graphInspectorWidth, setGraphInspectorWidth] = useState<number>(420);
  const [rawStepJsonText, setRawStepJsonText] = useState<string>("");
  const [rawStepJsonFeedback, setRawStepJsonFeedback] = useState<{ tone: "info" | "error" | "success"; message: string } | null>(null);
  const [graphContextMenu, setGraphContextMenu] = useState<GraphContextMenuState | null>(null);
  const { selectedCompanyId: graphCompanyId } = useCompany();
  const [graphAgents, setGraphAgents] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    const cid = graphCompanyId ?? "";
    if (!cid.trim()) return;
    let cancelled = false;
    fetch(`${apiBaseUrl()}/api/companies/${encodeURIComponent(cid)}/agents`)
      .then((res) => (res.ok ? res.json() : []))
      .then((data: unknown) => {
        if (cancelled || !Array.isArray(data)) return;
        setGraphAgents(
          data
            .filter((a): a is Record<string, unknown> => Boolean(a && typeof a === "object"))
            .map((a) => ({ id: String(a.id ?? ""), name: String(a.name ?? a.id ?? "") })),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [graphCompanyId]);
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
  const selectedStepIdForKeyboard = selectedStep?.id ?? "";
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
    setRawStepJsonText(selectedRawStepJson);
    setRawStepJsonFeedback(null);
  }, [selectedRawStepJson]);

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

  function deleteSelectedEdge(): boolean {
    const edge = selectedEdgeActionAnchor?.edge ?? graph.edges.find((candidate) => candidate.id === selectedEdgeId);
    if (!edge) return false;
    disconnect(edge.source, edge.target);
    return true;
  }

  function deleteSelectedGraphObject(): void {
    if (deleteSelectedEdge()) return;
    deleteSelectedStep();
  }

  function handleDeleteGraphObjectPointerDown(event: React.PointerEvent<HTMLButtonElement>): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    deleteSelectedGraphObject();
  }

  function stopGraphControlEvent(event: React.SyntheticEvent<HTMLElement>): void {
    event.stopPropagation();
  }

  function beginGraphInspectorResize(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const startClientX = event.clientX;
    const startWidth = graphInspectorWidth;
    const onMove = (moveEvent: PointerEvent): void => {
      setGraphInspectorWidth(clampGraphInspectorWidth(startWidth - (moveEvent.clientX - startClientX)));
    };
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  useEffect(() => {
    if (!selectedStepIdForKeyboard && !selectedEdgeId) return undefined;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      if (isEditableKeyboardTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      const edge = graph.edges.find((candidate) => candidate.id === selectedEdgeId);
      if (edge) {
        disconnect(edge.source, edge.target);
        return;
      }
      if (!selectedStepIdForKeyboard) return;
      deleteStep(selectedStepIdForKeyboard);
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [graph.edges, selectedEdgeId, selectedStepIdForKeyboard, steps]);

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

  function parseRawSelectedStepJson(): StepDraft | null {
    if (!selectedStep) return null;
    try {
      const parsed = JSON.parse(rawStepJsonText) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setRawStepJsonFeedback({ tone: "error", message: "Selected step JSON must be one object." });
        return null;
      }
      const [draft] = jsonToSteps([parsed as WorkflowOverviewData["workflows"][number]["steps"][number]]);
      if (!draft?.id.trim()) {
        setRawStepJsonFeedback({ tone: "error", message: "Selected step JSON must include a non-empty id." });
        return null;
      }
      const duplicate = steps.some((step) => step.id !== selectedStep.id && step.id === draft.id);
      if (duplicate) {
        setRawStepJsonFeedback({ tone: "error", message: `Step id "${draft.id}" already exists.` });
        return null;
      }
      return draft;
    } catch (error) {
      setRawStepJsonFeedback({ tone: "error", message: `JSON parse failed: ${error instanceof Error ? error.message : String(error)}` });
      return null;
    }
  }

  function validateRawSelectedStepJson(): void {
    const parsed = parseRawSelectedStepJson();
    if (!parsed) return;
    setRawStepJsonFeedback({ tone: "success", message: `Valid step JSON for ${parsed.id}.` });
  }

    function applyRawSelectedStepJson(): void {
      if (!selectedStep) return;
      const parsed = parseRawSelectedStepJson();
      if (!parsed) return;
      const renamedSteps = parsed.id !== selectedStep.id
        ? renameWorkflowStep(steps, selectedStep.id, parsed.id)
        : steps;
      onChange(renamedSteps.map((step) => (step.id === parsed.id ? parsed : step)));
      setSelectedStepId(parsed.id);
    setSelectedPathStepIds(parsed.id.trim() ? [parsed.id] : []);
    setRawStepJsonFeedback({ tone: "success", message: `Applied JSON to ${parsed.id}.` });
    setGraphError("");
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
    <div style={{ ...graphShellStyle, gridTemplateColumns: `minmax(620px, 1fr) 8px ${graphInspectorWidth}px` }}>
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
      <GraphCanvas
        graph={graph}
        canvasWidth={canvasWidth}
        canvasHeight={canvasHeight}
        canvasScale={canvasScale}
        canvasPanX={canvasPanX}
        canvasPanY={canvasPanY}
        isCanvasPanning={isCanvasPanning}
        draggingStepId={draggingStepId}
        connectingFromStepId={connectingFromStepId}
        graphCanvasRef={graphCanvasRef}
        selectedStep={selectedStep}
        selectedEdgeId={selectedEdgeId}
        selectedEdgeActionAnchor={selectedEdgeActionAnchor}
        graphContextMenu={graphContextMenu}
        selectedContainerSummary={selectedContainerSummary}
        selectedPathNodeIds={selectedPathNodeIds}
        matchingNodeIds={matchingNodeIds}
        availableTools={availableTools}
        workbenchSummary={workbenchSummary}
        beginCanvasPan={beginCanvasPan}
        handleCanvasPointerMove={handleCanvasPointerMove}
        endCanvasPan={endCanvasPan}
        handleCanvasClick={handleCanvasClick}
        handleCanvasContextMenu={handleCanvasContextMenu}
        stopGraphControlEvent={stopGraphControlEvent}
        handleEdgeClick={handleEdgeClick}
        handleEdgeContextMenu={handleEdgeContextMenu}
        beginNodeDrag={beginNodeDrag}
        handleNodePointerMove={handleNodePointerMove}
        endNodeDrag={endNodeDrag}
        handleNodeClick={handleNodeClick}
        handleNodeContextMenu={handleNodeContextMenu}
        beginEdgeConnection={beginEdgeConnection}
        completeEdgeConnection={completeEdgeConnection}
        disconnect={disconnect}
        setCanvasScaleFromPoint={setCanvasScaleFromPoint}
        runWorkbenchAction={runWorkbenchAction}
        runNodeContextAction={runNodeContextAction}
        runEdgeContextAction={runEdgeContextAction}
        runCanvasContextAction={runCanvasContextAction}
        addAfter={addAfter}
        handleDeleteGraphObjectPointerDown={handleDeleteGraphObjectPointerDown}
      />

      <div
        key="graph-inspector-resize"
        aria-label="Resize graph inspector"
        role="separator"
        style={graphInspectorResizeHandleStyle}
        title="Drag to resize Inspector"
        onPointerDown={beginGraphInspectorResize}
      >
        <span style={{ width: "2px", height: "42px", borderRadius: "2px", background: "var(--muted-foreground, #94a3b8)", opacity: 0.55 }} />
      </div>

      <GraphInspector
        steps={steps}
        selectedStep={selectedStep}
        selectedContainerSummary={selectedContainerSummary}
        selectedDataFlowMap={selectedDataFlowMap}
        selectedGroup={selectedGroup}
        selectedPathSummary={selectedPathSummary}
        inspectorSummary={inspectorSummary}
        activeInspectorSection={activeInspectorSection}
        evidenceSummary={evidenceSummary}
        repairPlan={repairPlan}
        diagnostics={diagnostics}
        graphError={graphError}
        graphInspectorMode={graphInspectorMode}
        inspectorAccent={inspectorAccent}
        showOverviewInspector={showOverviewInspector}
        showEditInspector={showEditInspector}
        showPolicyInspector={showPolicyInspector}
        showRawInspector={showRawInspector}
        showGraphDetails={showGraphDetails}
        showGraphTestDrawer={showGraphTestDrawer}
        showGraphEvidenceDrawer={showGraphEvidenceDrawer}
        rawStepJsonText={rawStepJsonText}
        rawStepJsonFeedback={rawStepJsonFeedback}
        availableTools={availableTools}
        availableToolGrants={availableToolGrants}
        graphAgents={graphAgents}
        testDrawerSlot={showOverviewInspector && showGraphTestDrawer ? (
          <WorkflowGraphTestDrawer
            key="test-drawer"
            summary={testDrawerSummary}
            steps={steps}
            interfaceInput={testInterfaceInput}
            onClose={() => setShowGraphTestDrawer(false)}
          />
        ) : null}
        setGraphInspectorMode={setGraphInspectorMode}
        setShowGraphTestDrawer={setShowGraphTestDrawer}
        setShowGraphEvidenceDrawer={setShowGraphEvidenceDrawer}
        setRawStepJsonText={setRawStepJsonText}
        setRawStepJsonFeedback={setRawStepJsonFeedback}
        selectStep={selectStep}
        addAfter={addAfter}
        expandSelectedPath={expandSelectedPath}
        clearSelectedPath={clearSelectedPath}
        groupSelectedGraphSelection={groupSelectedGraphSelection}
        wrapSelectedGraphSelection={wrapSelectedGraphSelection}
        wrapSelectedPathInContainer={wrapSelectedPathInContainer}
        duplicateSelectedStep={duplicateSelectedStep}
        duplicateSelectedContainer={duplicateSelectedContainer}
        clearSelectedContainer={clearSelectedContainer}
        clearSelectedGroup={clearSelectedGroup}
        groupSelectedWithDependencies={groupSelectedWithDependencies}
        setSelectedGroupCollapsed={setSelectedGroupCollapsed}
        handleDeleteGraphObjectPointerDown={handleDeleteGraphObjectPointerDown}
        renameSelectedStep={renameSelectedStep}
        updateSelected={updateSelected}
        updateSelectedAdvanced={updateSelectedAdvanced}
        updateSelectedApproval={updateSelectedApproval}
        updateSelectedTesting={updateSelectedTesting}
        updateSelectedExecution={updateSelectedExecution}
        updateSelectedDataFlow={updateSelectedDataFlow}
        updateSelectedResources={updateSelectedResources}
        updateSelectedGroupMetadata={updateSelectedGroupMetadata}
        updateSelectedContainerMetadata={updateSelectedContainerMetadata}
        setSelectedNote={setSelectedNote}
        validateRawSelectedStepJson={validateRawSelectedStepJson}
        applyRawSelectedStepJson={applyRawSelectedStepJson}
      />
    </div>
  );
}


function renderWorkflowGraphEditor(props: StepWorkspaceGraphEditorProps): JSX.Element {
  return <WorkflowGraphEditor {...props} />;
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
                <HelpIcon label={normalizedStatus === "archived"
                  ? "Restores this archived workflow and asks whether it should return as reusable or manual."
                  : "Open Graph edits this workflow. Run starts it. Pause/Activate changes status. Archive moves it out of active lists."}
                />
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
  const [restoreTarget, setRestoreTarget] = useState<WorkflowOverviewData["workflows"][number] | null>(null);
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
      const updated = await updateWorkflow({
        companyId,
        workflowId,
        id: workflowId,
        patch,
        ...patch,
      });
      const updatedRecord = updated && typeof updated === "object" ? updated as Record<string, unknown> : {};
      const updatedWorkflow = (updatedRecord.workflow && typeof updatedRecord.workflow === "object"
        ? updatedRecord.workflow
        : updatedRecord) as WorkflowOverviewData["workflows"][number] | null;
      if (updatedWorkflow?.id) {
        beginEdit(updatedWorkflow);
      }
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

  async function onRestoreWorkflow(workflow: WorkflowOverviewData["workflows"][number], kind: WorkflowRestoreKind): Promise<void> {
    setPendingWorkflowId(workflow.id);
    setTableError("");
    try {
      // 복원 종류에 따라 source/sourceKind 도 갱신. shared PATCH schema 가 source/sourceKind 를
      // 허용하고 workflow-store update 가 patch 를 통과시킨다.
      const sourcePatch = kind === "manual"
        ? { source: "manual_mission", sourceKind: "manual_mission" }
        : { source: "native", sourceKind: "workflow" };
      await updateWorkflow({
        companyId,
        workflowId: workflow.id,
        id: workflow.id,
        patch: { status: "active", ...sourcePatch },
        status: "active",
        ...sourcePatch,
      });
      await refreshOverview();
      setTableNotice({ tone: "success", message: `${workflow.name} 복원 완료 (${kind === "manual" ? "Manual mission plan" : "Reusable procedure"})` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTableError(`복원 실패: ${message}`);
    } finally {
      setPendingWorkflowId(null);
    }
  }

  function confirmRestoreWorkflow(kind: WorkflowRestoreKind): void {
    const target = restoreTarget;
    if (!target) return;
    setRestoreTarget(null);
    void onRestoreWorkflow(target, kind);
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
        {restoreTarget ? (
          <div
            key="restore-workflow-confirm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="restore-workflow-title"
            style={workflowConfirmOverlayStyle}
            onClick={() => setRestoreTarget(null)}
          >
            <div style={workflowConfirmDialogStyle} onClick={(event) => event.stopPropagation()}>
              <div style={{ display: "grid", gap: "4px" }}>
                <strong id="restore-workflow-title" style={{ fontSize: "15px", color: "var(--foreground, #f8fafc)" }}>
                  Restore archived workflow
                </strong>
                <span style={{ ...mutedTextStyle, fontSize: "12px", lineHeight: 1.45 }}>
                  Choose how to classify "{restoreTarget.name}" when it becomes active again.
                </span>
              </div>
              <div style={{ display: "grid", gap: "6px" }}>
                <span style={{ ...mutedTextStyle, fontSize: "12px" }}>
                  Reusable workflows appear with normal saved procedures. Manual workflows stay grouped with one-off mission plans.
                </span>
              </div>
              <div style={workflowConfirmActionsStyle}>
                <button type="button" style={buttonStyle} onClick={() => setRestoreTarget(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  style={primaryButtonStyle}
                  onClick={() => confirmRestoreWorkflow("reusable")}
                >
                  Restore as reusable
                </button>
                <button
                  type="button"
                  style={primaryButtonStyle}
                  onClick={() => confirmRestoreWorkflow("manual")}
                >
                  Restore as manual
                </button>
              </div>
            </div>
          </div>
        ) : null}
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
                  <FieldLabel help="Name shown in workflow lists, run history, and generated run labels.">Workflow name</FieldLabel>
                  <input style={inputStyle} value={editingName} onChange={(event) => setEditingName(event.target.value)} required />
                </div>
                <div key="description-field" style={workflowCreateFieldStyle}>
                  <FieldLabel help="Short operator-facing summary of what this workflow does.">Description</FieldLabel>
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
                  <FieldLabel help="Workflow availability. Active can run, paused stays saved, archived is hidden from active operation.">Status</FieldLabel>
                  <select style={selectStyle} value={editingStatus} onChange={(event) => setEditingStatus(event.target.value)}>
                    <option value="active">active</option>
                    <option value="paused">paused</option>
                    <option value="archived">archived</option>
                  </select>
                </div>
                <div key="schedule-field" style={workflowCreateFieldStyle}>
                  <FieldLabel help="Cron expression for scheduled runs. Leave blank for manual or label-triggered runs only.">Schedule (cron)</FieldLabel>
                  <input style={inputStyle} value={editingSchedule} onChange={(event) => setEditingSchedule(event.target.value)} placeholder="0 9 * * *" />
                </div>
                <div key="timezone-field" style={workflowCreateFieldStyle}>
                  <FieldLabel help="Timezone used to interpret the cron schedule.">Timezone</FieldLabel>
                  <input style={inputStyle} value={editingTimezone} onChange={(event) => setEditingTimezone(event.target.value)} placeholder="Asia/Seoul" />
                </div>
                <div key="project-field" style={workflowCreateFieldStyle}>
                  <FieldLabel help="Optional project that generated issues and runs should be associated with.">Project</FieldLabel>
                  <select style={selectStyle} value={editingProjectId} onChange={(event) => setEditingProjectId(event.target.value)}>
                    <option value="">— none —</option>
                    {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                  </select>
                </div>
                <div key="max-daily-runs-field" style={workflowCreateFieldStyle}>
                  <FieldLabel help="Daily run cap for scheduled or label-triggered execution. Blank uses the default limit.">Max Daily Runs</FieldLabel>
                  <input style={inputStyle} type="number" min={0} step={1} value={editingMaxDailyRuns} onChange={(event) => setEditingMaxDailyRuns(event.target.value)} placeholder="blank=1/day" />
                </div>
                <div key="trigger-labels-field" style={workflowCreateFieldStyle}>
                  <FieldLabel help="Comma-separated issue labels that can trigger this workflow.">Trigger Labels</FieldLabel>
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
                  renderGraphEditor={renderWorkflowGraphEditor}
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
          onRestoreWorkflow={(workflow) => setRestoreTarget(workflow)}
          onDeleteWorkflow={(workflow) => { void onDeleteWorkflow(workflow); }}
          onToggleStatus={(workflow) => { void onToggleStatus(workflow); }}
        />
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
          <HelpIcon label="New Workflow opens the creation form. Refresh reloads workflow definitions and run status from the server." />
        </div>
      </div>

      <section id="wf-definitions" key="definitions-section" style={{ ...workflowFocusSectionStyle, height: definitionsCollapsed || definitionsHeight === null ? "auto" : `${definitionsHeight}px`, overflow: definitionsHeight === null ? "visible" : "auto", minHeight: definitionsCollapsed ? "auto" : "200px" }}>
        <div key="definitions-toolbar" style={{ ...workflowFocusToolbarStyle, flexShrink: 0, height: "fit-content" }}>
          <div key="definition-controls" style={workflowFocusToolbarGroupStyle}>
            <label key="navigator-search-field" style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <input
                key="navigator-search"
                style={{ ...inputStyle, width: "200px", fontSize: "12px" }}
                value={navigatorSearch}
                onChange={(event) => setNavigatorSearch(event.target.value)}
                placeholder="Search workflows..."
                aria-label="Search workflows"
              />
              <HelpIcon label="Filters the workflow list by name, description, or related metadata." />
            </label>
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
            <HelpIcon label="Use Reusable/Manual to switch workflow categories, Active/Archived to switch status, and the arrow to collapse this list." />
          </div>
        </div>
        {!definitionsCollapsed && (
          <Fragment key="definitions-body">
        {showNewWorkflowForm ? (
          <form key="new-workflow-form" style={workflowCreateShellStyle} onSubmit={(event) => void onCreateWorkflow(event)}>
            <div key="create-header" style={workflowCreateHeaderStyle}>
              <div key="identity" style={workflowCreateIdentityStyle}>
                <div key="name-field" style={workflowCreateFieldStyle}>
                  <FieldLabel help="Name shown in lists, editor headers, and run history.">Workflow name</FieldLabel>
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
                  <FieldLabel help="Short summary of what this workflow is intended to automate.">Description</FieldLabel>
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
                <HelpIcon label="Save creates the workflow. Cancel clears this draft. Mode tabs choose graph, form, or raw JSON step editing." />
              </div>
            </div>

            <div key="create-setup-strip" style={workflowCreateSetupStripStyle}>
              <div key="schedule-field" style={workflowCreateFieldStyle}>
                <FieldLabel help="Cron expression for automatic scheduled runs. Leave blank if this workflow is only manual or label-triggered.">Schedule (cron)</FieldLabel>
                <input key="input" style={inputStyle} value={newSchedule} onChange={(e) => setNewSchedule(e.target.value)} placeholder="0 9 * * *" />
              </div>
              <div key="timezone-field" style={workflowCreateFieldStyle}>
                <FieldLabel help="Timezone used to interpret the cron schedule.">Timezone</FieldLabel>
                <input key="input" style={inputStyle} value={newTimezone} onChange={(e) => setNewTimezone(e.target.value)} placeholder="Asia/Seoul" />
              </div>
              <div key="project-field" style={workflowCreateFieldStyle}>
                <FieldLabel help="Optional project to attach generated issues and runs to.">Project</FieldLabel>
                <select key="select" style={selectStyle} value={newProjectId} onChange={(e) => setNewProjectId(e.target.value)}>
                  {[
                    <option key="none" value="">— none —</option>,
                    ...(data.projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>),
                  ]}
                </select>
              </div>
              <div key="max-daily-runs-field" style={workflowCreateFieldStyle}>
                <FieldLabel help="Daily execution cap for this workflow. Blank uses the server default.">Max Daily Runs</FieldLabel>
                <input key="input" style={inputStyle} type="number" min={0} step={1} value={newMaxDailyRuns} onChange={(e) => setNewMaxDailyRuns(e.target.value)} placeholder="blank=1/day" />
              </div>
              <div key="trigger-labels-field" style={workflowCreateFieldStyle}>
                <FieldLabel help="Comma-separated issue labels that should trigger this workflow.">Trigger labels</FieldLabel>
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
                  renderGraphEditor={renderWorkflowGraphEditor}
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
            <HelpIcon label="Switches active runs between all visible workflows and the workflow selected in the definitions list." />
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
            <HelpIcon label="Switches run history between all visible workflows and the workflow selected in the definitions list." />
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
