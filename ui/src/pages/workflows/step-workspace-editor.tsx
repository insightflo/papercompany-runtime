import { Fragment, useMemo, type JSX } from "react";
import type { StepEditorMode, WorkflowOverviewData, WorkflowToolGrant, WorkflowToolOption } from "./workflow-page-types.js";
import { filterTabStyle, mutedTextStyle, textareaStyle } from "./workflow-page-styles.js";
import { HelpIcon } from "./shared-controls.js";
import { jsonToSteps, stepsToJson, type StepDraft } from "./step-draft.js";
import { StepEditor } from "./step-editor.js";
import { summarizeWorkflowGraphDraftDiff, type WorkflowGraphDraftDiff, type WorkflowGraphInterfaceInput, type WorkflowGraphTriggerSummary } from "./workflow-graph.js";
import { WorkflowDraftCompactDisclosure } from "./workflow-draft-diff-summary.js";

export { WorkflowTestPlanPreview } from "./workflow-test-plan-preview.js";

export type StepWorkspaceSurface = "stacked" | "focus";

export type StepWorkspaceGraphEditorProps = {
  steps: StepDraft[];
  runOverlaySteps?: StepDraft[] | undefined;
  onChange: (steps: StepDraft[]) => void;
  triggerSummary?: WorkflowGraphTriggerSummary | undefined;
  testInterfaceInput?: WorkflowGraphInterfaceInput | undefined;
  availableTools: WorkflowToolOption[];
  availableToolGrants: WorkflowToolGrant[];
  surface?: StepWorkspaceSurface | undefined;
};

export function GraphModeTabs({
  mode,
  onChange,
}: {
  mode: StepEditorMode;
  onChange: (mode: StepEditorMode) => void;
}): JSX.Element {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
      <HelpIcon label="Switch between the graph canvas, structured form fields, and raw steps JSON. Leaving JSON mode validates and imports the JSON array." />
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

export function StepWorkspaceEditor({
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
  renderGraphEditor,
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
  renderGraphEditor: (props: StepWorkspaceGraphEditorProps) => JSX.Element;
}): JSX.Element {
  const draftDiff = useMemo<WorkflowGraphDraftDiff | null>(() => {
    return baseSteps ? summarizeWorkflowGraphDraftDiff(baseSteps, steps) : null;
  }, [baseSteps, steps]);
  const jsonSyntaxFeedback = useMemo<{ tone: "success" | "error"; message: string } | null>(() => {
    if (mode !== "json") return null;
    const trimmed = jsonText.trim();
    if (!trimmed) {
      return { tone: "error", message: "steps JSON 배열을 입력하세요." };
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!Array.isArray(parsed)) {
        return { tone: "error", message: "steps는 JSON 배열이어야 합니다." };
      }
      return { tone: "success", message: `Valid JSON array (${parsed.length} steps).` };
    } catch (error) {
      return { tone: "error", message: `JSON 파싱 실패: ${error instanceof Error ? error.message : String(error)}` };
    }
  }, [jsonText, mode]);

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
        {surface === "stacked" && mode !== "json" ? (
          <WorkflowDraftCompactDisclosure key="draft-details" diff={draftDiff} steps={steps} interfaceInput={testInterfaceInput} />
        ) : (
          <Fragment key="draft-details-placeholder" />
        )}
        {mode === "graph" ? (
          <Fragment key="graph-workspace">
            {renderGraphEditor({ steps, runOverlaySteps, onChange, triggerSummary, testInterfaceInput, availableTools, availableToolGrants, surface })}
          </Fragment>
        ) : mode === "json" ? (
          <Fragment key="json-workspace">
            <textarea
              key="json-editor"
              style={{ ...textareaStyle, minHeight: "250px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px" }}
              value={jsonText}
              onChange={(event) => onJsonTextChange(event.target.value)}
              rows={10}
            />
            {jsonSyntaxFeedback ? (
              <span
                key="json-syntax-feedback"
                style={{
                  ...mutedTextStyle,
                  fontSize: "11px",
                  color: jsonSyntaxFeedback.tone === "success" ? "#34d399" : "var(--destructive, #ef4444)",
                }}
              >
                {jsonSyntaxFeedback.message}
              </span>
            ) : null}
          </Fragment>
        ) : (
          <Fragment key="form-workspace">
            <StepEditor key="form-editor" steps={steps} onChange={onChange} availableTools={availableTools} availableToolGrants={availableToolGrants} />
          </Fragment>
        )}
    </div>
  );
}
