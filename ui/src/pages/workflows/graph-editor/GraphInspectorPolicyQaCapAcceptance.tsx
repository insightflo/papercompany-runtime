// [파일 목적] 그래프 인스펙터의 QA review-step 정책 섹션 렌더.
// 선택 스텝(QA 검토자) 기준 bounded QA-to-producer 리워크 루프(qa_request_changes back-edge)를
// 생성/제거/편집하는 휴먼 에디터. generic Max retries 필드와는 별개.
// [외부 연결] ../qa-cap-acceptance-policy.js, ../workflow-page-styles.js, ../shared-controls.js, react.
// [주의] 코디네이터가 넘긴 policy/handlers 기반 렌더만 수행. 루트 역참조 금지.
import { useEffect, useState, type JSX } from "react";
import type { QaCapAcceptancePolicy } from "../qa-cap-acceptance-policy.js";
import { inputStyle, mutedTextStyle, selectStyle } from "../workflow-page-styles.js";
import { FieldLabel, HelpIcon, HelpedText } from "../shared-controls.js";

export function GraphInspectorPolicyQaCapAcceptance({
  policy,
  onLoopEnabledChange,
  onMaxIterationsChange,
  onAllowCapAcceptanceChange,
}: {
  policy: QaCapAcceptancePolicy;
  onLoopEnabledChange: (enabled: boolean, producerStepId?: string) => void;
  onMaxIterationsChange: (value: number) => void;
  onAllowCapAcceptanceChange: (value: boolean) => void;
}): JSX.Element {
  const enabled = policy.available && policy.enabled;
  const ambiguous = !policy.available;

  const disabledVariant = policy.available && !policy.enabled ? policy : null;
  const needsProducerChoice = Boolean(disabledVariant?.requiresProducerSelection);

  // Never pre-guess a producer. Only the single unambiguous upstream candidate is
  // pre-selected; when several exist the choice stays blank until the user picks one.
  const defaultProducer = disabledVariant && disabledVariant.producerStepId ? disabledVariant.producerStepId : "";
  const [producerOverride, setProducerOverride] = useState<string | null>(null);
  useEffect(() => {
    setProducerOverride(null);
  }, [defaultProducer]);
  const effectiveProducer = producerOverride ?? defaultProducer;

  const noProducer = disabledVariant !== null && disabledVariant.producerCandidates.length === 0;
  const awaitingProducerChoice = needsProducerChoice && effectiveProducer === "";
  const loopToggleDisabled = ambiguous || noProducer || awaitingProducerChoice;

  return (
    <div style={{ display: "grid", gap: "6px", paddingTop: "8px", borderTop: "1px solid var(--border, #334155)" }}>
      <HelpedText help="Bounded QA-to-producer rework loop. Enabling creates a qa_request_changes back-edge so the producer re-runs after this step requests changes; disabling removes only that edge. This is separate from the generic Max retries field above.">
        QA review step
      </HelpedText>

      {ambiguous && (
        <p style={{ margin: 0, ...mutedTextStyle, fontSize: "11px", lineHeight: 1.4 }}>
          This QA policy cannot be edited because more than one producer rework edge targets the selected step. Resolve the duplicate edge in the graph first.
        </p>
      )}

      <label style={{ display: "flex", alignItems: "flex-start", gap: "8px", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={loopToggleDisabled}
          onChange={(event) => onLoopEnabledChange(event.target.checked, effectiveProducer || undefined)}
        />
        <span>
          Enable QA rework loop
          <span style={{ display: "block", marginTop: "3px", ...mutedTextStyle, fontSize: "11px", lineHeight: 1.4 }}>
            When this step requests changes, the producer is reworked up to the rework limit.
          </span>
        </span>
      </label>

      {disabledVariant && needsProducerChoice && (
        <div style={{ display: "grid", gap: "4px" }}>
          <FieldLabel help="Choose which upstream producer this QA step reworks when it requests changes.">Producer to rework</FieldLabel>
          <select
            style={selectStyle}
            value={effectiveProducer}
            onChange={(event) => setProducerOverride(event.target.value)}
          >
            <option value="" disabled>Select a producer…</option>
            {disabledVariant.producerCandidates.map((candidate) => (
              <option key={candidate} value={candidate}>{candidate}</option>
            ))}
          </select>
        </div>
      )}

      {disabledVariant && !needsProducerChoice && disabledVariant.producerStepId && (
        <p style={{ margin: 0, ...mutedTextStyle, fontSize: "11px", lineHeight: 1.4 }}>
          Reworks producer: <strong>{disabledVariant.producerStepId}</strong>
        </p>
      )}

      {noProducer && (
        <p style={{ margin: 0, ...mutedTextStyle, fontSize: "11px", lineHeight: 1.4 }}>
          Add an upstream dependency so this step can review a producer before enabling the rework loop.
        </p>
      )}

      {policy.available && policy.enabled && (
        <>
          <p style={{ margin: 0, ...mutedTextStyle, fontSize: "11px", lineHeight: 1.4 }}>
            Reworks producer: <strong>{policy.producerStepId}</strong>
          </p>
          <div style={{ display: "grid", gap: "4px" }}>
            <FieldLabel help="Maximum number of times the producer may be reworked after this step requests changes. This is separate from generic step retries.">
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
          <label style={{ display: "flex", alignItems: "flex-start", gap: "8px", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
            <input
              type="checkbox"
              checked={policy.allowCapAcceptance}
              onChange={(event) => onAllowCapAcceptanceChange(event.target.checked)}
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
      )}
    </div>
  );
}
