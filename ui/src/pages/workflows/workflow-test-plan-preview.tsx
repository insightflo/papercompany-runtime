import { useEffect, useMemo, useState, type JSX } from "react";
import { FieldLabel, HelpIcon } from "./shared-controls.js";
import { graphPolicyBadgeStyle, inputStyle, mutedTextStyle, selectStyle, textareaStyle } from "./workflow-page-styles.js";
import type { StepDraft } from "./step-draft.js";
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
            <FieldLabel help="Zero-based loop item index used in the iteration preview.">Iteration index</FieldLabel>
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
        <div style={{ display: "grid", gap: "4px" }}>
          <FieldLabel help="Sample JSON item passed into the selected loop iteration preview.">Iteration item JSON</FieldLabel>
          <textarea
            style={{ ...textareaStyle, minHeight: "92px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px" }}
            value={iterationItemText}
            rows={4}
            placeholder='{"market":"KR","date":"2026-06-13"}'
            onChange={(event) => setIterationItemText(event.target.value)}
          />
        </div>
        {iterationItemPreview.error ? (
          <span style={{ ...mutedTextStyle, fontSize: "11px", color: "var(--destructive, #ef4444)" }}>{iterationItemPreview.error}</span>
        ) : null}
        <div style={{ display: "grid", gap: "4px" }}>
          <FieldLabel help="Read-only request JSON generated for the selected loop iteration.">Iteration request preview</FieldLabel>
          <textarea
            readOnly
            style={{ ...textareaStyle, minHeight: "120px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px" }}
            value={iterationPreview.requestJson}
            rows={6}
          />
        </div>
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
        <FieldLabel help="Paste a request JSON sample to map incoming body/query values into workflow test arguments.">Fill from request JSON</FieldLabel>
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
        <FieldLabel help="Read-only request JSON that would be sent by the current test flow configuration.">Test request preview</FieldLabel>
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
