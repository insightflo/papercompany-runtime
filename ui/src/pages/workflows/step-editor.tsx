import { useEffect, useState, type CSSProperties, type JSX } from "react";
import { useCompany } from "../../context/CompanyContext";
import { emptyStep, type StepDraft } from "./step-draft.js";
import { apiBaseUrl } from "./workflow-page-api.js";
import type { WorkflowToolGrant, WorkflowToolOption } from "./workflow-page-types.js";
import { buttonStyle, dangerButtonStyle, inputStyle, mutedTextStyle, selectStyle, textareaStyle } from "./workflow-page-styles.js";
import { FieldLabel, HelpIcon } from "./shared-controls.js";
import { splitCommaList, WorkflowToolPicker } from "./workflow-tool-picker.js";

const stepCardStyle: CSSProperties = {
  display: "grid",
  gap: "8px",
  padding: "12px",
  border: "1px solid var(--border, #334155)",
  borderRadius: "8px",
  background: "var(--background, #020617)",
};

const stepRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: "8px",
};

const collapsedStepHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "10px",
  padding: "10px 12px",
  border: "1px solid var(--border, #334155)",
  borderRadius: "8px",
  background: "var(--background, #020617)",
  cursor: "pointer",
  fontSize: "13px",
  userSelect: "none",
};

const selectedStepOutlineStyle: CSSProperties = {
  outline: "2px solid color-mix(in srgb, var(--foreground, #f8fafc) 40%, transparent)",
  outlineOffset: "-2px",
};

export function StepEditor({
  steps,
  onChange,
  availableTools,
  availableToolGrants,
}: {
  steps: StepDraft[];
  onChange: (steps: StepDraft[]) => void;
  availableTools: WorkflowToolOption[];
  availableToolGrants: WorkflowToolGrant[];
}): JSX.Element {
  const { selectedCompanyId } = useCompany();
  const companyId = selectedCompanyId ?? "";
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (!companyId.trim()) return;
    let cancelled = false;
    fetch(`${apiBaseUrl()}/api/companies/${encodeURIComponent(companyId)}/agents`)
      .then((res) => (res.ok ? res.json() : []))
      .then((data: unknown) => {
        if (cancelled || !Array.isArray(data)) return;
        setAgents(
          data
            .filter((a): a is Record<string, unknown> => Boolean(a && typeof a === "object"))
            .map((a) => ({ id: String(a.id ?? ""), name: String(a.name ?? a.id ?? "") })),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [companyId]);
  const [collapsedSet, setCollapsedSet] = useState<Set<number>>(() => new Set(steps.map((_, i) => i)));
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  function toggleCollapse(index: number) {
    setCollapsedSet((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }

  function update(index: number, patch: Partial<StepDraft>) {
    const next = steps.map((s, i) => (i === index ? { ...s, ...patch } : s));
    onChange(next);
  }

  function remove(index: number) {
    onChange(steps.filter((_, i) => i !== index));
    setCollapsedSet((prev) => {
      const next = new Set<number>();
      for (const idx of prev) {
        if (idx < index) next.add(idx);
        else if (idx > index) next.add(idx - 1);
      }
      return next;
    });
    if (selectedIndex === index) setSelectedIndex(null);
    else if (selectedIndex !== null && selectedIndex > index) setSelectedIndex(selectedIndex - 1);
  }

  function add() {
    if (selectedIndex !== null && selectedIndex >= 0 && selectedIndex < steps.length) {
      const afterStep = steps[selectedIndex];
      const newStep = { ...emptyStep(), dependsOn: afterStep.id.trim() };
      const insertAt = selectedIndex + 1;
      const next = [...steps.slice(0, insertAt), newStep, ...steps.slice(insertAt)];
      onChange(next);
      setCollapsedSet((prev) => {
        const shifted = new Set<number>();
        for (const idx of prev) {
          if (idx < insertAt) shifted.add(idx);
          else shifted.add(idx + 1);
        }
        return shifted;
      });
      setSelectedIndex(insertAt);
    } else {
      onChange([...steps, emptyStep()]);
      setSelectedIndex(steps.length);
    }
  }

  const allIds = steps.map((s) => s.id).filter(Boolean);

  return (
    <div style={{ display: "grid", gap: "10px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ ...mutedTextStyle, fontWeight: 600 }}>Steps ({steps.length})</span>
        <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
          {selectedIndex !== null && (
            <span style={{ fontSize: "11px", color: "var(--muted-foreground, #94a3b8)" }}>
              insert after step {selectedIndex + 1}
            </span>
          )}
          <button type="button" style={buttonStyle} onClick={add}>+ Add Step</button>
          <HelpIcon label="Adds a new workflow step. When a step is selected, the new step is inserted after it and depends on that selected step." />
        </div>
      </div>
      {steps.map((step, i) => {
        const isCollapsed = collapsedSet.has(i);
        const isSelected = selectedIndex === i;

        if (isCollapsed) {
          return (
            <div
              key={i}
              style={{
                ...collapsedStepHeaderStyle,
                ...(isSelected ? selectedStepOutlineStyle : {}),
              }}
              onClick={() => {
                setSelectedIndex(isSelected ? null : i);
              }}
              onDoubleClick={() => toggleCollapse(i)}
            >
              <span style={{ fontSize: "11px", color: "var(--muted-foreground, #94a3b8)", minWidth: "18px" }}>{i + 1}</span>
              <span style={{ fontSize: "13px" }}>{step.type === "tool" ? "\uD83D\uDD27" : "\uD83E\uDD16"}</span>
              <span style={{ fontWeight: 600, fontSize: "13px", color: "var(--foreground, #f8fafc)" }}>
                {step.id || "(no id)"}
              </span>
              {step.title && (
                <span style={{ color: "var(--muted-foreground, #94a3b8)", fontSize: "12px" }}>
                  — {step.title}
                </span>
              )}
              <span style={{ marginLeft: "auto", display: "flex", gap: "4px", alignItems: "center" }}>
                <button
                  type="button"
                  style={{ ...buttonStyle, padding: "2px 8px", fontSize: "11px" }}
                  onClick={(e) => { e.stopPropagation(); toggleCollapse(i); }}
                >Expand</button>
                <button
                  type="button"
                  style={{ ...dangerButtonStyle, padding: "2px 8px", fontSize: "11px" }}
                  onClick={(e) => { e.stopPropagation(); remove(i); }}
                >Remove</button>
              </span>
            </div>
          );
        }

        return (
          <div
            key={i}
            style={{
              ...stepCardStyle,
              ...(isSelected ? selectedStepOutlineStyle : {}),
            }}
            onClick={() => setSelectedIndex(isSelected ? null : i)}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--muted-foreground, #94a3b8)" }}>
                Step {i + 1} — {step.type === "tool" ? "\uD83D\uDD27 Tool" : "\uD83E\uDD16 Agent"}
              </span>
              <div style={{ display: "flex", gap: "4px" }}>
                <button type="button" style={{ ...buttonStyle, padding: "4px 8px", fontSize: "11px" }} onClick={(e) => { e.stopPropagation(); toggleCollapse(i); }}>Collapse</button>
                <button type="button" style={{ ...dangerButtonStyle, padding: "4px 8px", fontSize: "11px" }} onClick={(e) => { e.stopPropagation(); remove(i); }}>Remove</button>
              </div>
            </div>
            <div style={stepRowStyle} onClick={(e) => e.stopPropagation()}>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="Stable step id used by dependencies and runtime step runs. Keep it unique in this workflow.">ID</FieldLabel>
                <input style={inputStyle} value={step.id} placeholder="gather" onChange={(e) => update(i, { id: e.target.value })} />
              </div>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="Human-readable step title shown in issues, graph nodes, and run history.">Title</FieldLabel>
                <input style={inputStyle} value={step.title} placeholder="데이터 수집" onChange={(e) => update(i, { title: e.target.value })} />
              </div>
            </div>
            <div style={{ display: "grid", gap: "4px" }} onClick={(e) => e.stopPropagation()}>
              <FieldLabel help="Instruction text passed to the selected agent or used to describe the tool step.">Description (에이전트에게 전달할 작업 지시)</FieldLabel>
              <textarea style={{ ...textareaStyle, minHeight: "120px" }} value={step.description} placeholder="수집된 데이터를 분석하여 보고서를 작성하세요." onChange={(e) => update(i, { description: e.target.value })} rows={2} />
            </div>
            <div style={stepRowStyle} onClick={(e) => e.stopPropagation()}>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="Agent creates an issue for a worker. Tool runs an available workflow tool directly.">Type</FieldLabel>
                <select style={selectStyle} value={step.type} onChange={(e) => {
                  const newType = e.target.value as "agent" | "tool";
                  if (newType === "tool" && availableTools.length === 0) return;
                  if (newType === "agent" && step.agentName) {
                    const granted = new Set(availableToolGrants.filter((g) => g.agentName === step.agentName).map((g) => g.toolName));
                    const cleaned = splitCommaList(step.tools).filter((t) => granted.has(t)).join(", ");
                    update(i, { type: newType, tools: cleaned });
                  } else {
                    update(i, { type: newType });
                  }
                }}>
                  <option value="tool" disabled={availableTools.length === 0}>{"\uD83D\uDD27"} Tool (시스템 실행)</option>
                  <option value="agent">{"\uD83E\uDD16"} Agent (에이전트 작업)</option>
                </select>
                {availableTools.length === 0 ? (
                  <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Tool steps are inactive until workflow tools are available.</span>
                ) : null}
              </div>
              <div style={{ display: "grid", gap: "4px" }}>
                {step.type === "tool" ? (
                  <>
                    <FieldLabel help="Authorized tool that this tool step runs. The picker only lists tools currently available to workflows.">Tool Name</FieldLabel>
                    <WorkflowToolPicker
                      value={step.toolName}
                      multiple={false}
                      tools={availableTools}
                      onChange={(value) => update(i, { toolName: value })}
                    />
                  </>
                ) : (
                  <>
                    <FieldLabel help="Worker assigned to this step. Changing this also trims tool access to grants for that agent.">Agent</FieldLabel>
                    <select style={selectStyle} value={step.agentId || agents.find((a) => a.name === step.agentName)?.id || ""} onChange={(e) => {
                  const selectedId = e.target.value;
                  const agent = agents.find((a) => a.id === selectedId);
                  const newName = agent?.name ?? "";
                  const granted = new Set(availableToolGrants.filter((g) => g.agentName === newName).map((g) => g.toolName));
                  const cleaned = splitCommaList(step.tools).filter((t) => granted.has(t)).join(", ");
                  update(i, { agentId: selectedId, agentName: newName, tools: cleaned });
                }}>
                      <option value="">— Select agent —</option>
                      {agents.map((a) => (
                        <option key={a.id} value={a.id}>{a.name}</option>
                      ))}
                    </select>
                  </>
                )}
              </div>
            </div>
            {step.type === "tool" && (
              <div style={{ display: "grid", gap: "4px" }} onClick={(e) => e.stopPropagation()}>
                <FieldLabel help="JSON arguments passed to the workflow tool. Invalid JSON is saved as an empty object by the serializer.">Tool Args (JSON)</FieldLabel>
                <textarea
                  style={{ ...textareaStyle, minHeight: "96px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px" }}
                  value={step.toolArgs}
                  placeholder={'{\n  "profile": "tech-scout"\n}'}
                  onChange={(e) => update(i, { toolArgs: e.target.value })}
                  rows={4}
                />
              </div>
            )}
            {step.type === "agent" && (
              <>
              <div style={{ display: "grid", gap: "4px" }} onClick={(e) => e.stopPropagation()}>
                <FieldLabel help="Tool or skill names this agent step may use. The picker only shows tools granted to the selected agent.">Agent tool / skill access</FieldLabel>
                <WorkflowToolPicker
                  value={step.tools}
                  multiple={true}
                  tools={availableTools.filter((t) => availableToolGrants.some((g) => g.agentName === step.agentName && g.toolName === t.name))}
                  onChange={(value) => update(i, { tools: value })}
                />
              </div>
              </>
            )}
            <div style={{ display: "grid", gap: "6px" }} onClick={(e) => e.stopPropagation()}>
              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <span style={{ ...mutedTextStyle, fontSize: "11px", fontWeight: 700 }}>Runtime output contract</span>
                <HelpIcon label="Controls runtime behavior for produced artifacts, input/output contracts, resources, and secrets." />
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
                <input
                  type="checkbox"
                  checked={step.graphWorkProductRequired}
                  onChange={(e) => update(i, { graphWorkProductRequired: e.target.checked })}
                />
                Require registered work product
                <HelpIcon label="When enabled, the runtime expects this step to register a work product before downstream artifact gates pass." />
              </label>
              <div style={stepRowStyle}>
                <div style={{ display: "grid", gap: "4px" }}>
                  <FieldLabel help="Expected output path or filename pattern for the produced work product.">Work product pattern</FieldLabel>
                  <input
                    style={inputStyle}
                    value={step.graphWorkProductPattern}
                    placeholder="reports/*.html"
                    onChange={(e) => update(i, { graphWorkProductPattern: e.target.value })}
                  />
                </div>
                <div style={{ display: "grid", gap: "4px" }}>
                  <FieldLabel help="Comma-separated runtime resources this step can read, such as files, datasets, or service assets.">Resource refs</FieldLabel>
                  <input
                    style={inputStyle}
                    value={step.graphResourceRefs}
                    placeholder="kb:market-rules, file:brief"
                    onChange={(e) => update(i, { graphResourceRefs: e.target.value })}
                  />
                </div>
                <div style={{ display: "grid", gap: "4px" }}>
                  <FieldLabel help="Comma-separated secret references made available to the step by the runtime.">Secret refs</FieldLabel>
                  <input
                    style={inputStyle}
                    value={step.graphSecretRefs}
                    placeholder="secret:telegram-token"
                    onChange={(e) => update(i, { graphSecretRefs: e.target.value })}
                  />
                </div>
                <div style={{ display: "grid", gap: "4px" }}>
                  <FieldLabel help="Optional input transform expression for upstream data handed to this step.">Input expression</FieldLabel>
                  <input
                    style={inputStyle}
                    value={step.graphInputExpression}
                    placeholder="collect.result.summary"
                    onChange={(e) => update(i, { graphInputExpression: e.target.value })}
                  />
                </div>
              </div>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="Optional JSON schema or text contract describing what this step should return.">Output schema</FieldLabel>
                <textarea
                  style={{ ...textareaStyle, minHeight: "58px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px" }}
                  value={step.graphOutputSchema}
                  placeholder={'{ "type": "object", "required": ["artifactPath"] }'}
                  onChange={(e) => update(i, { graphOutputSchema: e.target.value })}
                />
              </div>
            </div>
            <div style={stepRowStyle} onClick={(e) => e.stopPropagation()}>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="Comma-separated upstream step ids. Empty means this can be an entry step.">Depends On / upstream IDs</FieldLabel>
                <input style={inputStyle} value={step.dependsOn} placeholder={allIds.filter((id) => id !== step.id).join(", ") || "none"} onChange={(e) => update(i, { dependsOn: e.target.value })} />
              </div>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="Runtime policy when this step fails. Retry uses Max Retries and retry delay/backoff below.">On Failure</FieldLabel>
                <select style={selectStyle} value={step.onFailure} onChange={(e) => update(i, { onFailure: e.target.value })}>
                  <option value="">default</option>
                  <option value="retry">retry</option>
                  <option value="skip">skip</option>
                  <option value="abort_workflow">abort workflow</option>
                  <option value="escalate">escalate</option>
                </select>
              </div>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="Maximum number of retry attempts when the failure policy is retry.">Max Retries</FieldLabel>
                <input
                  style={inputStyle}
                  type="number"
                  min={0}
                  step={1}
                  value={step.maxRetries}
                  placeholder={step.onFailure === "retry" ? "2" : "blank"}
                  onChange={(e) => update(i, { maxRetries: e.target.value })}
                />
              </div>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="Step-level timeout in seconds. Leave blank to use the runtime default.">Timeout Seconds</FieldLabel>
                <input
                  style={inputStyle}
                  type="number"
                  min={1}
                  step={1}
                  value={step.timeoutSeconds}
                  placeholder="default"
                  onChange={(e) => update(i, { timeoutSeconds: e.target.value })}
                />
              </div>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="Optional delay before retrying this step.">Retry delay seconds</FieldLabel>
                <input
                  style={inputStyle}
                  type="number"
                  min={1}
                  step={1}
                  value={step.graphRetryDelaySeconds}
                  placeholder="blank"
                  onChange={(e) => update(i, { graphRetryDelaySeconds: e.target.value })}
                />
              </div>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="How retry delay grows between attempts.">Retry backoff</FieldLabel>
                <select style={selectStyle} value={step.graphRetryBackoff} onChange={(e) => update(i, { graphRetryBackoff: e.target.value })}>
                  <option value="">none</option>
                  <option value="fixed">fixed</option>
                  <option value="linear">linear</option>
                  <option value="exponential">exponential</option>
                </select>
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
                <input
                  type="checkbox"
                  checked={step.graphRetryJitter}
                  onChange={(e) => update(i, { graphRetryJitter: e.target.checked })}
                />
                Add retry jitter
                <HelpIcon label="Adds small random timing variation so multiple retries do not all fire at exactly the same time." />
              </label>
            </div>
            <div style={{ display: "grid", gap: "6px" }} onClick={(e) => e.stopPropagation()}>
              <FieldLabel help="Optional expression that stops the workflow early when it evaluates as true. Leave blank for normal downstream execution.">Early Stop Condition</FieldLabel>
              <textarea
                style={{ ...textareaStyle, minHeight: "54px" }}
                value={step.graphEarlyStopCondition}
                placeholder="result.done === true"
                onChange={(e) => update(i, { graphEarlyStopCondition: e.target.value })}
              />
              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--muted-foreground, #94a3b8)" }}>
                <input
                  type="checkbox"
                  checked={step.graphEarlyStopLabelSkipped}
                  onChange={(e) => update(i, { graphEarlyStopLabelSkipped: e.target.checked })}
                />
                Label flow as skipped if stopped
                <HelpIcon label="Marks the stopped path as skipped instead of treating the early stop as a normal success path." />
              </label>
            </div>
          </div>
        );
      })}
      {steps.length === 0 && <p style={mutedTextStyle}>No steps yet. Click "+ Add Step" to begin.</p>}
    </div>
  );
}
