// [파일 목적] 그래프 에디터의 자체 완결형 드로어 컴포넌트.
// [주의] WorkflowGraphTestDrawer는 WorkflowTestPlanPreview(루트 잔류)에 의존하여
// 허용 import 밖이므로 Workflows.tsx에 남겨뒀다. 이 파일에는 의존성이 허용 범위 안인
// 드로어만 둔다.
import { Fragment, type JSX } from "react";
import { buttonStyle, graphPolicyBadgeStyle, mutedTextStyle } from "../workflow-page-styles.js";
import type { WorkflowGraphExecutionEvidenceSummary } from "../workflow-graph.js";
import {
  workflowGraphFocusLensMetricStyle,
  workflowGraphFocusLensToneColor,
  workflowGraphTestDrawerModeStyle,
  workflowGraphTestDrawerStyle,
} from "./graphStyles.js";

export function WorkflowGraphExecutionEvidenceDrawer({
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
