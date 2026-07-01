// [파일 목적] 워크플로우 인터페이스 요약/필드 + export(YAML/JSON) 미리보기 컴포넌트.
// Workflows.tsx에서 WorkflowInterfaceSummary/Fields/ExportPreview 기계적 추출.
// [외부 연결] ../workflow-graph.js, ../workflow-page-styles.js, ../shared-controls.js, react.
// [주의] 동작 변경 없이. 루트 Workflows.tsx 역참조 금지.
import { Fragment, useEffect, useMemo, useState, type JSX } from "react";
import {
  parseWorkflowGraphYamlDraft,
  serializeWorkflowGraphExportSnapshot,
  type WorkflowGraphExportFormat,
  type WorkflowGraphExportSnapshot,
  type WorkflowGraphInterfaceSummary,
  type WorkflowGraphTestInputLibrarySummary,
} from "../workflow-graph.js";
import { buttonStyle, graphPolicyBadgeStyle, mutedTextStyle, primaryButtonStyle, statusBadgeStyle, textareaStyle } from "../workflow-page-styles.js";
import { FieldLabel, HelpIcon, HelpedText } from "../shared-controls.js";

export function WorkflowInterfaceSummary({ summary }: { summary: WorkflowGraphInterfaceSummary }): JSX.Element {
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
        <FieldLabel help="JSON array/object describing workflow-level inputs available to steps and test requests.">Flow inputs JSON</FieldLabel>
        <textarea
          style={{ ...textareaStyle, minHeight: "90px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px" }}
          value={flowInputsText}
          onChange={(event) => onFlowInputsTextChange(event.target.value)}
          rows={4}
        />
      </label>
      <label style={{ display: "grid", gap: "4px" }}>
        <FieldLabel help="JSON environment variables exposed to workflow tests and graph input previews.">Flow env variables JSON</FieldLabel>
        <textarea
          style={{ ...textareaStyle, minHeight: "90px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px" }}
          value={flowEnvVariablesText}
          onChange={(event) => onFlowEnvVariablesTextChange(event.target.value)}
          rows={4}
        />
      </label>
      <label style={{ display: "grid", gap: "4px" }}>
        <FieldLabel help="JSON presets that can be selected in Test flow to preview different request payloads.">Saved test inputs JSON</FieldLabel>
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
        <HelpedText help="Export the graph draft as JSON/YAML, or edit YAML and apply it back to the draft." style={{ fontSize: "12px", fontWeight: 700, color: "var(--foreground, #f8fafc)" }}>Export / YAML edit</HelpedText>
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
          <FieldLabel help="Editable YAML version of the current graph draft. Apply parses this YAML back into the workflow draft.">YAML draft</FieldLabel>
          <textarea
            style={{ ...textareaStyle, minHeight: "190px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px" }}
            value={yamlText}
            onChange={(event) => setYamlText(event.target.value)}
            rows={8}
          />
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
            {yamlError ? <span style={{ ...mutedTextStyle, color: "#f87171" }}>{yamlError}</span> : <span style={mutedTextStyle}>Edit YAML applies to the current draft.</span>}
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <button type="button" style={primaryButtonStyle} onClick={applyYaml}>Apply YAML</button>
              <HelpIcon label="Parses the YAML and replaces the current draft graph if it is valid." />
            </div>
          </div>
        </Fragment>
      ) : (
        <>
        <FieldLabel help="Read-only export of the current graph draft in the selected format.">Export preview</FieldLabel>
        <textarea
          readOnly
          style={{ ...textareaStyle, minHeight: "160px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px" }}
          value={exportText}
          rows={7}
        />
        </>
      )}
    </div>
  );
}
