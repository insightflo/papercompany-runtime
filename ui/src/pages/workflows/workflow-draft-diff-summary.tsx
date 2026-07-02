import type { JSX } from "react";
import { graphPolicyBadgeStyle } from "./workflow-page-styles.js";
import type { StepDraft } from "./step-draft.js";
import type { WorkflowGraphDraftDiff, WorkflowGraphInterfaceInput } from "./workflow-graph.js";
import { WorkflowTestPlanPreview } from "./workflow-test-plan-preview.js";

export function WorkflowDraftDiffSummary({ diff }: { diff: WorkflowGraphDraftDiff }): JSX.Element {
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

export function WorkflowDraftCompactDisclosure({
  diff,
  steps,
  interfaceInput,
}: {
  diff: WorkflowGraphDraftDiff | null;
  steps: StepDraft[];
  interfaceInput?: WorkflowGraphInterfaceInput;
}): JSX.Element {
  return (
    <details
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
        Draft details
        <span style={{ ...graphPolicyBadgeStyle, marginLeft: "8px", color: diff?.hasChanges ? "#fbbf24" : "#34d399" }}>
          {diff?.hasChanges ? "unsaved" : "saved"}
        </span>
        <span style={{ ...graphPolicyBadgeStyle, marginLeft: "6px" }}>
          {steps.length} steps
        </span>
      </summary>
      <div style={{ display: "grid", gap: "8px", marginTop: "8px" }}>
        {diff ? <WorkflowDraftDiffSummary key="draft-diff" diff={diff} /> : null}
        <WorkflowTestPlanPreview key="test-flow" steps={steps} interfaceInput={interfaceInput} />
      </div>
    </details>
  );
}
