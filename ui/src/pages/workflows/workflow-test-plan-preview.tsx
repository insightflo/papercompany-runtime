import { useEffect, useMemo, useState, type JSX } from "react";
import { HelpIcon } from "./shared-controls.js";
import { graphPolicyBadgeStyle, mutedTextStyle, selectStyle } from "./workflow-page-styles.js";
import type { StepDraft } from "./step-draft.js";
import {
  WorkflowTestExecutionPreviewSection,
  WorkflowTestIterationPreviewSection,
  WorkflowTestRequestPreviewSection,
  WorkflowTestRestartPreviewSection,
  WorkflowTestSingleStepPreviewSection,
  WorkflowTestStepChips,
} from "./workflow-test-plan-preview-sections.js";
import {
  buildWorkflowGraphIterationTestPreview,
  buildWorkflowGraphModel,
  buildWorkflowGraphRequestFillPreview,
  buildWorkflowGraphRestartPreview,
  buildWorkflowGraphSingleStepTestPreview,
  buildWorkflowGraphTestExecutionPreview,
  buildWorkflowGraphTestPlan,
  buildWorkflowGraphTestRequestPreview,
  summarizeWorkflowGraphTestInputLibrary,
  type WorkflowGraphInterfaceInput,
  type WorkflowGraphIterationTestPreview,
  type WorkflowGraphRequestFillPreview,
  type WorkflowGraphRestartPreview,
  type WorkflowGraphSingleStepTestPreview,
  type WorkflowGraphTestExecutionPreview,
  type WorkflowGraphTestInputLibrarySummary,
  type WorkflowGraphTestPlan,
  type WorkflowGraphTestRequestPreview,
} from "./workflow-graph.js";

export function WorkflowTestPlanPreview({
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

  return (
    <div style={{ display: "grid", gap: "8px", padding: "8px", border: "1px solid var(--border, #334155)", borderRadius: "8px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
        <div style={{ display: "grid", gap: "2px" }}>
          <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--foreground, #f8fafc)" }}>Test flow</span>
          <span style={{ ...mutedTextStyle, fontSize: "11px" }}>{plan.summary}</span>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: "6px", ...mutedTextStyle, fontSize: "11px" }}>
          <span>Stop at</span>
          <HelpIcon label="Preview a partial workflow run that stops at the selected step." />
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
          <span>Saved input</span>
          <HelpIcon label="Choose one saved test input preset for the preview request." />
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
          <span>Restart from</span>
          <HelpIcon label="Preview which previous results can be reused when restarting from this step." />
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
          <span>Test this step</span>
          <HelpIcon label="Builds a focused single-step test request with upstream context." />
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
          <span>Test iteration</span>
          <HelpIcon label="Preview one loop iteration by choosing a loop container and sample item." />
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
          <WorkflowTestStepChips stepIds={plan.stepIds} emptyLabel="No steps selected" />
        </div>
        <div style={{ display: "grid", gap: "4px" }}>
          <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Skipped downstream</span>
          <WorkflowTestStepChips stepIds={plan.excludedStepIds} emptyLabel="No downstream steps" tone="muted" />
        </div>
        {plan.missingDependencyIds.length > 0 ? (
          <div style={{ display: "grid", gap: "4px" }}>
            <span style={{ ...mutedTextStyle, fontSize: "11px", color: "var(--destructive, #ef4444)" }}>Missing deps</span>
            <WorkflowTestStepChips stepIds={plan.missingDependencyIds} emptyLabel="No missing dependencies" tone="error" />
          </div>
        ) : null}
      </div>
      <WorkflowTestExecutionPreviewSection executionPreview={executionPreview} />
      <WorkflowTestSingleStepPreviewSection singleStepPreview={singleStepPreview} />
      <WorkflowTestIterationPreviewSection
        iterationPreview={iterationPreview}
        iterationItemPreview={iterationItemPreview}
        iterationIndexText={iterationIndexText}
        onIterationIndexTextChange={setIterationIndexText}
        iterationItemText={iterationItemText}
        onIterationItemTextChange={setIterationItemText}
      />
      <WorkflowTestRestartPreviewSection restartPreview={restartPreview} />
      <WorkflowTestRequestPreviewSection
        requestFillText={requestFillText}
        onRequestFillTextChange={setRequestFillText}
        requestFillPreview={requestFillPreview}
        requestPreview={requestPreview}
      />
    </div>
    );
  }
