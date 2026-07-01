// [파일 목적] 그래프 인스펙터의 raw selected-step JSON 편집 블록을 렌더링하는 프레젠테이션 컴포넌트.
// GraphInspector에서 showRawInspector 블록만 기계적 추출.
// [외부 연결] ../workflow-page-styles.js, ../shared-controls.js, react.
// [주의] 동작 변경 없이 props 기반 렌더만 수행. 루트 Workflows.tsx 역참조 금지.
import { Fragment, type JSX } from "react";
import { buttonStyle, graphPolicyBadgeStyle, mutedTextStyle, primaryButtonStyle, textareaStyle } from "../workflow-page-styles.js";
import { FieldLabel, HelpIcon, HelpedText } from "../shared-controls.js";

type RawStepJsonFeedback = { tone: "info" | "error" | "success"; message: string } | null;

// [목적] 선택 스텝의 raw JSON 편집기(Validate/Apply) 렌더.
// [입력] showRawInspector=false 면 placeholder Fragment만 반환(원본 조건부 동작 보존).
// [출력] Selected step JSON 패널 JSX.
// [연결] GraphInspector가 렌더.
// [주의] 상태/핸들러는 코디네이터 소유, props로만 수신.
export function GraphInspectorRawStep({
  showRawInspector,
  rawStepJsonText,
  rawStepJsonFeedback,
  selectedStepId,
  setRawStepJsonText,
  setRawStepJsonFeedback,
  validateRawSelectedStepJson,
  applyRawSelectedStepJson,
}: {
  showRawInspector: boolean;
  rawStepJsonText: string;
  rawStepJsonFeedback: RawStepJsonFeedback;
  selectedStepId: string;
  setRawStepJsonText: (value: string) => void;
  setRawStepJsonFeedback: (value: { tone: "info" | "error" | "success"; message: string } | null) => void;
  validateRawSelectedStepJson: () => void;
  applyRawSelectedStepJson: () => void;
}): JSX.Element {
  if (!showRawInspector) {
    return <Fragment key="selected-step-raw-placeholder" />;
  }
  return (
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
          <HelpedText help="Editable raw JSON for the selected step. Validate checks syntax; Apply writes it back to the step draft." style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>Selected step JSON</HelpedText>
          <button
            type="button"
            title="Copy JSON to clipboard"
            aria-label="Copy JSON"
            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: "22px", height: "22px", borderRadius: "4px", border: "1px solid var(--border, #334155)", background: "transparent", color: "var(--muted-foreground, #94a3b8)", cursor: "pointer", padding: 0 }}
            onClick={() => {
              navigator.clipboard.writeText(rawStepJsonText).then(() => {
                const btn = document.querySelector('[aria-label="Copy JSON"]');
                if (btn) { btn.textContent = "✓"; setTimeout(() => { btn.textContent = "⧉"; }, 1500); }
              });
            }}
          >
            <span style={{ fontSize: "12px", lineHeight: 1 }}>⧉</span>
          </button>
        </div>
        <span style={{ ...graphPolicyBadgeStyle, color: "#fbbf24" }}>{selectedStepId}</span>
      </div>
      <FieldLabel help="Edit the selected step object as JSON. The JSON must remain an object with a unique id.">Raw step JSON</FieldLabel>
      <textarea
        key="raw-json"
        style={{
          ...textareaStyle,
          minHeight: "260px",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          fontSize: "11px",
          lineHeight: 1.5,
          color: "var(--foreground, #f8fafc)",
          background: "color-mix(in srgb, var(--background, #020617) 88%, black)",
        }}
        value={rawStepJsonText}
        onChange={(event) => {
          setRawStepJsonText(event.target.value);
          setRawStepJsonFeedback(null);
        }}
        rows={14}
      />
      <div key="raw-actions" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
        {rawStepJsonFeedback ? (
          <span style={{ ...mutedTextStyle, fontSize: "11px", color: rawStepJsonFeedback.tone === "error" ? "var(--destructive, #ef4444)" : rawStepJsonFeedback.tone === "success" ? "#34d399" : "var(--muted-foreground, #94a3b8)" }}>
            {rawStepJsonFeedback.message}
          </span>
        ) : (
          <span style={{ ...mutedTextStyle, fontSize: "11px" }}>
            Edit one step object, then validate or apply it to the selected node.
          </span>
        )}
        <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
          <button type="button" style={buttonStyle} onClick={validateRawSelectedStepJson}>
            Validate
          </button>
          <button type="button" style={primaryButtonStyle} onClick={applyRawSelectedStepJson}>
            Apply
          </button>
          <HelpIcon label="Validate checks the JSON without changing the draft. Apply validates and updates the selected step." />
        </div>
      </div>
    </div>
  );
}
