import type { JSX } from "react";
import { FieldLabel } from "./shared-controls.js";
import { graphPolicyBadgeStyle, inputStyle, mutedTextStyle, textareaStyle } from "./workflow-page-styles.js";
import type {
  WorkflowGraphIterationTestPreview,
  WorkflowGraphRequestFillPreview,
  WorkflowGraphRestartPreview,
  WorkflowGraphSingleStepTestPreview,
  WorkflowGraphTestExecutionPreview,
  WorkflowGraphTestRequestPreview,
} from "./workflow-graph.js";

type WorkflowTestStepChipsTone = "normal" | "muted" | "error";

type WorkflowTestIterationItemPreview = {
  value: unknown;
  error: string;
};

export function WorkflowTestStepChips({
  stepIds,
  emptyLabel,
  tone = "normal",
}: {
  stepIds: string[];
  emptyLabel: string;
  tone?: WorkflowTestStepChipsTone;
}): JSX.Element {
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

function workflowTestExecutionModeColor(mode: string): string {
  if (mode === "mocked") return "#38bdf8";
  if (mode === "pinned") return "#a78bfa";
  if (mode === "skipped") return "var(--muted-foreground, #94a3b8)";
  if (mode === "blocked") return "var(--destructive, #ef4444)";
  return "#22c55e";
}

function workflowTestRestartModeColor(mode: string): string {
  if (mode === "reused") return "#22c55e";
  if (mode === "rerun") return "#f59e0b";
  return "var(--destructive, #ef4444)";
}

export function WorkflowTestExecutionPreviewSection({
  executionPreview,
}: {
  executionPreview: WorkflowGraphTestExecutionPreview;
}): JSX.Element {
  return (
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
              <span style={{ ...graphPolicyBadgeStyle, color: workflowTestExecutionModeColor(step.mode) }}>{step.mode}</span>
              {step.badges.slice(0, 2).map((badge) => (
                <span key={`${step.stepId}-${badge}`} style={{ ...graphPolicyBadgeStyle, color: workflowTestExecutionModeColor(step.mode) }}>
                  {badge}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function WorkflowTestSingleStepPreviewSection({
  singleStepPreview,
}: {
  singleStepPreview: WorkflowGraphSingleStepTestPreview;
}): JSX.Element {
  return (
    <div style={{ display: "grid", gap: "4px" }}>
      <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Test this step preview</span>
      <span style={{ ...mutedTextStyle, fontSize: "11px" }}>{singleStepPreview.summary}</span>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "8px" }}>
        <div style={{ display: "grid", gap: "4px" }}>
          <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Upstream context</span>
          <WorkflowTestStepChips stepIds={singleStepPreview.upstreamContextStepIds} emptyLabel="No upstream context" />
        </div>
        <div style={{ display: "grid", gap: "4px" }}>
          <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Downstream skipped</span>
          <WorkflowTestStepChips stepIds={singleStepPreview.downstreamStepIds} emptyLabel="No downstream steps" tone="muted" />
        </div>
        {singleStepPreview.missingDependencyIds.length > 0 ? (
          <div style={{ display: "grid", gap: "4px" }}>
            <span style={{ ...mutedTextStyle, fontSize: "11px", color: "var(--destructive, #ef4444)" }}>Missing step context</span>
            <WorkflowTestStepChips stepIds={singleStepPreview.missingDependencyIds} emptyLabel="No missing dependencies" tone="error" />
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
  );
}

export function WorkflowTestIterationPreviewSection({
  iterationPreview,
  iterationItemPreview,
  iterationIndexText,
  onIterationIndexTextChange,
  iterationItemText,
  onIterationItemTextChange,
}: {
  iterationPreview: WorkflowGraphIterationTestPreview;
  iterationItemPreview: WorkflowTestIterationItemPreview;
  iterationIndexText: string;
  onIterationIndexTextChange: (value: string) => void;
  iterationItemText: string;
  onIterationItemTextChange: (value: string) => void;
}): JSX.Element {
  return (
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
            onChange={(event) => onIterationIndexTextChange(event.target.value)}
          />
        </label>
        <div style={{ display: "grid", gap: "4px" }}>
          <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Loop steps</span>
          <WorkflowTestStepChips stepIds={iterationPreview.stepIds} emptyLabel="No loop steps" />
        </div>
        <div style={{ display: "grid", gap: "4px" }}>
          <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Skipped outside loop</span>
          <WorkflowTestStepChips stepIds={iterationPreview.skippedStepIds} emptyLabel="No outside steps" tone="muted" />
        </div>
      </div>
      <div style={{ display: "grid", gap: "4px" }}>
        <FieldLabel help="Sample JSON item passed into the selected loop iteration preview.">Iteration item JSON</FieldLabel>
        <textarea
          style={{ ...textareaStyle, minHeight: "92px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px" }}
          value={iterationItemText}
          rows={4}
          placeholder='{"market":"KR","date":"2026-06-13"}'
          onChange={(event) => onIterationItemTextChange(event.target.value)}
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
  );
}

export function WorkflowTestRestartPreviewSection({
  restartPreview,
}: {
  restartPreview: WorkflowGraphRestartPreview;
}): JSX.Element {
  return (
    <div style={{ display: "grid", gap: "4px" }}>
      <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Restart preview</span>
      <span style={{ ...mutedTextStyle, fontSize: "11px" }}>{restartPreview.summary}</span>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "8px" }}>
        <div style={{ display: "grid", gap: "4px" }}>
          <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Reuse previous results</span>
          <WorkflowTestStepChips stepIds={restartPreview.reusedStepIds} emptyLabel="No previous steps" />
        </div>
        <div style={{ display: "grid", gap: "4px" }}>
          <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Rerun from restart</span>
          <WorkflowTestStepChips stepIds={restartPreview.rerunStepIds} emptyLabel="No rerun steps" tone="muted" />
        </div>
        {restartPreview.blockedStepIds.length > 0 ? (
          <div style={{ display: "grid", gap: "4px" }}>
            <span style={{ ...mutedTextStyle, fontSize: "11px", color: "var(--destructive, #ef4444)" }}>Blocked outside restart</span>
            <WorkflowTestStepChips stepIds={restartPreview.blockedStepIds} emptyLabel="No blocked steps" tone="error" />
          </div>
        ) : null}
      </div>
      <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
        {restartPreview.steps.slice(0, 8).map((step) => (
          <span key={`restart-step-${step.stepId}`} style={{ ...graphPolicyBadgeStyle, color: workflowTestRestartModeColor(step.mode) }} title={step.reason}>
            {step.stepId}: {step.mode}
          </span>
        ))}
      </div>
    </div>
  );
}

export function WorkflowTestRequestPreviewSection({
  requestFillText,
  onRequestFillTextChange,
  requestFillPreview,
  requestPreview,
}: {
  requestFillText: string;
  onRequestFillTextChange: (value: string) => void;
  requestFillPreview: WorkflowGraphRequestFillPreview;
  requestPreview: WorkflowGraphTestRequestPreview;
}): JSX.Element {
  return (
    <div style={{ display: "grid", gap: "4px" }}>
      <FieldLabel help="Paste a request JSON sample to map incoming body/query values into workflow test arguments.">Fill from request JSON</FieldLabel>
      <textarea
        style={{ ...textareaStyle, minHeight: "92px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px" }}
        value={requestFillText}
        rows={4}
        placeholder='{"body":{"market":"KR"},"query":{"limit":10}}'
        onChange={(event) => onRequestFillTextChange(event.target.value)}
      />
      {requestFillPreview.error ? (
        <span style={{ ...mutedTextStyle, fontSize: "11px", color: "var(--destructive, #ef4444)" }}>{requestFillPreview.error}</span>
      ) : requestFillText.trim() ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "8px" }}>
          <div style={{ display: "grid", gap: "4px" }}>
            <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Matched args</span>
            <WorkflowTestStepChips stepIds={requestFillPreview.matchedInputNames} emptyLabel="No matching args" />
          </div>
          {requestFillPreview.missingRequiredInputNames.length > 0 ? (
            <div style={{ display: "grid", gap: "4px" }}>
              <span style={{ ...mutedTextStyle, fontSize: "11px", color: "var(--destructive, #ef4444)" }}>Missing required args</span>
              <WorkflowTestStepChips stepIds={requestFillPreview.missingRequiredInputNames} emptyLabel="No missing args" tone="error" />
            </div>
          ) : null}
          {requestFillPreview.extraArgumentNames.length > 0 ? (
            <div style={{ display: "grid", gap: "4px" }}>
              <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Ignored extras</span>
              <WorkflowTestStepChips stepIds={requestFillPreview.extraArgumentNames} emptyLabel="No extra args" tone="muted" />
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
  );
}
