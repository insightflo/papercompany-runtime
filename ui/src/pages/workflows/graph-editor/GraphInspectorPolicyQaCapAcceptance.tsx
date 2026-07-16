import type { JSX } from "react";
import type { QaCapAcceptancePolicy } from "../qa-cap-acceptance-policy.js";
import { inputStyle, mutedTextStyle } from "../workflow-page-styles.js";
import { FieldLabel, HelpIcon, HelpedText } from "../shared-controls.js";

export function GraphInspectorPolicyQaCapAcceptance({
  policy,
  onEnabledChange,
  onMaxIterationsChange,
}: {
  policy: QaCapAcceptancePolicy;
  onEnabledChange: (enabled: boolean) => void;
  onMaxIterationsChange: (value: number) => void;
}): JSX.Element | null {
  if (!policy.available && policy.reason.startsWith("No bounded")) return null;

  return (
    <div style={{ display: "grid", gap: "6px", paddingTop: "8px", borderTop: "1px solid var(--border)" }}>
      <HelpedText help="Controls the bounded QA-to-producer rework loop. This is separate from generic step failure retries.">
        QA rework limit
      </HelpedText>
      {policy.available ? (
        <>
          <div style={{ display: "grid", gap: "4px" }}>
            <FieldLabel help="Maximum number of times the producer may be reworked after this QA requests changes.">
              QA rework attempts
            </FieldLabel>
            <input
              style={inputStyle}
              type="number"
              min={1}
              step={1}
              value={policy.maxIterations}
              onChange={(event) => onMaxIterationsChange(Number(event.target.value))}
            />
          </div>
          <label style={{ display: "flex", alignItems: "flex-start", gap: "8px", fontSize: "12px", color: "var(--muted-foreground)" }}>
            <input
              type="checkbox"
              checked={policy.enabled}
              onChange={(event) => onEnabledChange(event.target.checked)}
            />
            <span>
              Continue with recorded limitations at rework limit
              <span style={{ display: "block", marginTop: "3px", ...mutedTextStyle, fontSize: "11px", lineHeight: 1.4 }}>
                Only a fresh semantic QA verdict may continue, and only when all remaining limitations are explicitly non-blocking.
              </span>
            </span>
            <HelpIcon label="Blocking QA findings still stop the workflow. Structural and delivery verification gates are never accepted through this policy." />
          </label>
        </>
      ) : (
        <p style={{ margin: 0, ...mutedTextStyle, fontSize: "11px", lineHeight: 1.4 }}>
          This QA policy cannot be edited because more than one producer rework edge targets the selected step.
        </p>
      )}
    </div>
  );
}
