// [파일 목적] 그래프 인스펙터의 advanced-policy-fields 섹션(retry backoff/jitter, error handler, restart boundary, wait controls, early response/stop) 렌더.
// GraphInspector의 <details> 내 key="advanced-policy-fields" div 기계적 추출.
// [외부 연결] ../workflow-page-styles.js, ../shared-controls.js, ../step-draft.js, react.
// [주의] 동작 변경 없이 props 기반 렌더만. 루트 Workflows.tsx 역참조 금지.
import { type JSX } from "react";
import type { StepDraft } from "../step-draft.js";
import { inputStyle, mutedTextStyle, selectStyle, textareaStyle } from "../workflow-page-styles.js";
import { FieldLabel, HelpIcon, HelpedText } from "../shared-controls.js";

// [목적] selected-step 의 advanced policy 상세 필드 렌더.
// [입력] selectedStep + updateSelectedAdvanced.
// [연결] GraphInspector <details> 내에서 렌더.
export function GraphInspectorPolicyAdvanced({
  selectedStep,
  updateSelectedAdvanced,
}: {
  selectedStep: StepDraft;
  updateSelectedAdvanced: (patch: Partial<StepDraft>) => void;
}): JSX.Element {
  return (
                <div key="advanced-policy-fields" style={{ display: "grid", gap: "8px", paddingTop: "8px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
                <div style={{ display: "grid", gap: "4px" }}>
                  <FieldLabel help="Seconds to wait before retrying this step. Leave blank for the runtime default.">Retry delay seconds</FieldLabel>
                  <input
                    style={inputStyle}
                    type="number"
                    min={1}
                    step={1}
                    value={selectedStep.graphRetryDelaySeconds}
                    placeholder="retry delay seconds"
                    onChange={(event) => updateSelectedAdvanced({ graphRetryDelaySeconds: event.target.value })}
                  />
                </div>
                <div style={{ display: "grid", gap: "4px" }}>
                  <FieldLabel help="How retry delay changes across attempts. Exponential increases fastest.">Retry backoff</FieldLabel>
                  <select
                    style={selectStyle}
                    value={selectedStep.graphRetryBackoff}
                    onChange={(event) => updateSelectedAdvanced({ graphRetryBackoff: event.target.value })}
                  >
                    <option value="">No retry backoff</option>
                    <option value="fixed">Fixed backoff</option>
                    <option value="linear">Linear backoff</option>
                    <option value="exponential">Exponential backoff</option>
                  </select>
                </div>
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
                <input
                  type="checkbox"
                  checked={selectedStep.graphRetryJitter}
                  onChange={(event) => updateSelectedAdvanced({ graphRetryJitter: event.target.checked })}
                />
                Add retry jitter
                <HelpIcon label="Adds small random timing variation to avoid many retries firing at the same instant." />
              </label>
              <div style={{ display: "grid", gap: "6px", paddingTop: "4px" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", ...mutedTextStyle, fontSize: "11px" }}>
                  Error handler
                  <HelpIcon label="Routes failed-step payloads into a handler scope instead of letting the failure stand alone." />
                </span>
                <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
                  <input
                    type="checkbox"
                    checked={selectedStep.graphErrorHandler}
                    onChange={(event) => updateSelectedAdvanced({ graphErrorHandler: event.target.checked })}
                  />
                  Handle failed flow step payloads
                  <HelpIcon label="Enables a handler path that receives failure details from this step." />
                </label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
                  <div style={{ display: "grid", gap: "4px" }}>
                    <FieldLabel help="Scope that should handle failures from this step.">Handler scope</FieldLabel>
                    <select
                      style={selectStyle}
                      value={selectedStep.graphErrorHandlerScope}
                      onChange={(event) => updateSelectedAdvanced({ graphErrorHandlerScope: event.target.value })}
                    >
                      <option value="">No handler scope</option>
                      <option value="flow">Flow error handler</option>
                      <option value="branch">Branch error handler</option>
                      <option value="step">Step error handler</option>
                    </select>
                  </div>
                  <div style={{ display: "grid", gap: "4px" }}>
                    <FieldLabel help="Expression used to build the payload passed into the error handler.">Error payload expression</FieldLabel>
                    <input
                      style={inputStyle}
                      value={selectedStep.graphErrorHandlerInput}
                      placeholder="error payload expression"
                      onChange={(event) => updateSelectedAdvanced({ graphErrorHandlerInput: event.target.value })}
                    />
                  </div>
                </div>
              </div>
              <div style={{ display: "grid", gap: "6px", paddingTop: "4px" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", ...mutedTextStyle, fontSize: "11px" }}>
                  Restart boundary
                  <HelpIcon label="Controls whether a failed or paused workflow can resume from this step instead of rerunning everything." />
                </span>
                <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
                  <input
                    type="checkbox"
                    checked={selectedStep.graphRestartBoundary}
                    onChange={(event) => updateSelectedAdvanced({ graphRestartBoundary: event.target.checked })}
                  />
                  Allow restart from this step
                  <HelpIcon label="Marks this step as a legal recovery point for reruns and resumes." />
                </label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
                  <div style={{ display: "grid", gap: "4px" }}>
                    <FieldLabel help="How much existing context should be copied when restarting from this step.">Restart strategy</FieldLabel>
                    <select
                      style={selectStyle}
                      value={selectedStep.graphRestartStrategy}
                      onChange={(event) => updateSelectedAdvanced({ graphRestartStrategy: event.target.value })}
                    >
                      <option value="">No restart strategy</option>
                      <option value="copy-predecessors">Copy predecessors</option>
                      <option value="fresh">Fresh restart</option>
                      <option value="copy-branch">Copy branch/iteration</option>
                    </select>
                  </div>
                  <div style={{ display: "grid", gap: "4px" }}>
                    <FieldLabel help="Optional selector or payload expression used when this step restarts.">Restart input</FieldLabel>
                    <input
                      style={inputStyle}
                      value={selectedStep.graphRestartInput}
                      placeholder="restart input or branch selector"
                      onChange={(event) => updateSelectedAdvanced({ graphRestartInput: event.target.value })}
                    />
                  </div>
                </div>
              </div>
              <div style={{ display: "grid", gap: "6px", paddingTop: "4px" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", ...mutedTextStyle, fontSize: "11px" }}>
                  Wait controls
                  <HelpIcon label="Sleep and suspend settings that delay this step or wait for an external event." />
                </span>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
                  <div style={{ display: "grid", gap: "4px" }}>
                    <FieldLabel help="Seconds to pause before continuing this step.">Sleep seconds</FieldLabel>
                    <input
                      style={inputStyle}
                      type="number"
                      min={1}
                      step={1}
                      value={selectedStep.graphSleepSeconds}
                      placeholder="sleep seconds"
                      onChange={(event) => updateSelectedAdvanced({ graphSleepSeconds: event.target.value })}
                    />
                  </div>
                  <div style={{ display: "grid", gap: "4px" }}>
                    <FieldLabel help="External event or condition that must occur before the step resumes.">Suspend until event</FieldLabel>
                    <input
                      style={inputStyle}
                      value={selectedStep.graphSuspendUntil}
                      placeholder="Suspend until event"
                      onChange={(event) => updateSelectedAdvanced({ graphSuspendUntil: event.target.value })}
                    />
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
                  <div style={{ display: "grid", gap: "4px" }}>
                    <FieldLabel help="Maximum seconds to wait for the suspend event before applying the timeout action.">Suspend timeout seconds</FieldLabel>
                    <input
                      style={inputStyle}
                      type="number"
                      min={1}
                      step={1}
                      value={selectedStep.graphSuspendTimeoutSeconds}
                      placeholder="suspend timeout seconds"
                      onChange={(event) => updateSelectedAdvanced({ graphSuspendTimeoutSeconds: event.target.value })}
                    />
                  </div>
                  <div style={{ display: "grid", gap: "4px" }}>
                    <FieldLabel help="What to do if the suspend timeout is reached.">Suspend timeout action</FieldLabel>
                    <select
                      style={selectStyle}
                      value={selectedStep.graphSuspendTimeoutAction}
                      onChange={(event) => updateSelectedAdvanced({ graphSuspendTimeoutAction: event.target.value })}
                    >
                      <option value="">No suspend timeout action</option>
                      <option value="resume">Resume on timeout</option>
                      <option value="cancel">Cancel on timeout</option>
                    </select>
                  </div>
                </div>
              </div>
              <div style={{ display: "grid", gap: "6px", paddingTop: "4px" }}>
                <HelpedText help="Controls the immediate response returned to synchronous or webhook-style callers before the whole workflow finishes.">Early response</HelpedText>
                <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
                  <input
                    type="checkbox"
                    checked={selectedStep.graphEarlyReturn}
                    onChange={(event) => updateSelectedAdvanced({ graphEarlyReturn: event.target.checked })}
                  />
                  Return this step for sync/webhook callers
                  <HelpIcon label="When enabled, this step's output can be returned as the caller-facing response." />
                </label>
                <div style={{ display: "grid", gap: "4px" }}>
                  <FieldLabel help="Content type for the early response, such as application/json or text/plain.">Response content type</FieldLabel>
                  <input
                    style={inputStyle}
                    value={selectedStep.graphEarlyReturnContentType}
                    placeholder="response content type"
                    onChange={(event) => updateSelectedAdvanced({ graphEarlyReturnContentType: event.target.value })}
                  />
                </div>
                <div style={{ display: "grid", gap: "4px" }}>
                  <FieldLabel help="Schema or contract describing the early response payload.">Early response schema</FieldLabel>
                  <textarea
                    style={{ ...textareaStyle, minHeight: "58px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}
                    value={selectedStep.graphEarlyReturnSchema}
                    placeholder={'Early response schema, e.g. { "required": ["publicUrl"] }'}
                    onChange={(event) => updateSelectedAdvanced({ graphEarlyReturnSchema: event.target.value })}
                  />
                </div>
              </div>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="Expression that stops this flow early when it evaluates true.">Early stop condition</FieldLabel>
                <textarea
                  style={{ ...textareaStyle, minHeight: "58px" }}
                  value={selectedStep.graphEarlyStopCondition}
                  placeholder="Early stop condition"
                  onChange={(event) => updateSelectedAdvanced({ graphEarlyStopCondition: event.target.value })}
                />
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
                <input
                  type="checkbox"
                  checked={selectedStep.graphEarlyStopLabelSkipped}
                  onChange={(event) => updateSelectedAdvanced({ graphEarlyStopLabelSkipped: event.target.checked })}
                />
                Label flow as skipped if stopped
                <HelpIcon label="Marks steps bypassed by the early-stop condition as skipped instead of leaving them ambiguous." />
              </label>
            </div>

  );
}
