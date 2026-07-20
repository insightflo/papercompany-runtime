import type { JSX } from "react";
import {
  WORKFLOW_CONDITION_OPERATORS,
  workflowConditionGroupSchema,
  type WorkflowCondition,
  type WorkflowConditionCombinator,
  type WorkflowConditionDataType,
  type WorkflowConditionGroup,
  type WorkflowConditionOperator,
} from "@paperclipai/shared";
import type { StepDraft } from "../step-draft.js";
import {
  cloneWorkflowConditionGroup,
  defaultIfConditionGroup,
} from "../workflow-control-nodes.js";
import { buttonStyle, inputStyle, mutedTextStyle, noticeStyle, selectStyle } from "../workflow-page-styles.js";
import { FieldLabel } from "../shared-controls.js";

const UNARY_OPERATORS = new Set<WorkflowConditionOperator>([
  "is_empty",
  "is_not_empty",
  "is_true",
  "is_false",
]);

function defaultRightValue(dataType: WorkflowConditionDataType): unknown {
  return dataType === "number" ? 0 : "";
}

export function setWorkflowConditionCombinator(
  group: WorkflowConditionGroup,
  combinator: WorkflowConditionCombinator,
): WorkflowConditionGroup {
  return { ...group, combinator };
}

export function addWorkflowCondition(group: WorkflowConditionGroup, sourceStepId = ""): WorkflowConditionGroup {
  const template = cloneWorkflowConditionGroup(defaultIfConditionGroup).conditions[0]!;
  return {
    ...group,
    conditions: [
      ...group.conditions,
      { ...template, source: { ...template.source, stepId: sourceStepId } },
    ],
  };
}

export function removeWorkflowCondition(group: WorkflowConditionGroup, index: number): WorkflowConditionGroup {
  if (group.conditions.length <= 1) return group;
  return { ...group, conditions: group.conditions.filter((_, conditionIndex) => conditionIndex !== index) };
}

export function updateWorkflowCondition(
  group: WorkflowConditionGroup,
  index: number,
  patch: Partial<WorkflowCondition>,
): WorkflowConditionGroup {
  return {
    ...group,
    conditions: group.conditions.map((condition, conditionIndex) => {
      if (conditionIndex !== index) return condition;
      if (patch.dataType && patch.dataType !== condition.dataType) {
        const operator = WORKFLOW_CONDITION_OPERATORS[patch.dataType][0] as WorkflowConditionOperator;
        const next = { ...condition, ...patch, dataType: patch.dataType, operator } as WorkflowCondition;
        if (UNARY_OPERATORS.has(operator)) delete (next as { rightValue?: unknown }).rightValue;
        else next.rightValue = defaultRightValue(patch.dataType);
        return next;
      }
      const next = { ...condition, ...patch } as WorkflowCondition;
      if (patch.operator) {
        if (UNARY_OPERATORS.has(patch.operator)) delete (next as { rightValue?: unknown }).rightValue;
        else if (next.rightValue === undefined) next.rightValue = defaultRightValue(next.dataType);
      }
      return next;
    }),
  };
}

function predecessorIds(step: StepDraft): string[] {
  const legacy = step.dependsOn.split(",").map((entry) => entry.trim()).filter(Boolean);
  const rawEdges = step.extra.conditionalDependencies;
  const conditional = Array.isArray(rawEdges) ? rawEdges.flatMap((edge) => {
    if (!edge || typeof edge !== "object" || Array.isArray(edge)) return [];
    const value = edge as Record<string, unknown>;
    return value.isBackEdge !== true && typeof value.stepId === "string" && value.stepId.trim()
      ? [value.stepId.trim()]
      : [];
  }) : [];
  return Array.from(new Set([...legacy, ...conditional]));
}

export function getWorkflowConditionAncestorOptions(steps: StepDraft[], ifStepId: string): StepDraft[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const ancestors = new Set<string>();
  const stack = [ifStepId];
  while (stack.length > 0) {
    const current = byId.get(stack.pop()!);
    if (!current) continue;
    for (const predecessor of predecessorIds(current)) {
      if (ancestors.has(predecessor)) continue;
      ancestors.add(predecessor);
      stack.push(predecessor);
    }
  }
  return steps.filter((step) => ancestors.has(step.id));
}

export function GraphInspectorControlNode({
  steps,
  selectedStep,
  updateSelected,
}: {
  steps: StepDraft[];
  selectedStep: StepDraft;
  updateSelected: (patch: Partial<StepDraft>) => void;
}): JSX.Element {
  if (selectedStep.type === "complete") {
    return (
      <div style={{ display: "grid", gap: "6px" }}>
        <FieldLabel help="Optional human-readable reason stored with the successful Complete result.">Completion reason</FieldLabel>
        <input
          style={inputStyle}
          value={selectedStep.completionReason}
          maxLength={500}
          placeholder="Workflow finished without a processing target"
          onChange={(event) => updateSelected({ completionReason: event.target.value })}
        />
        <span style={{ ...mutedTextStyle, fontSize: "11px" }}>Complete is terminal and has no output connection.</span>
      </div>
    );
  }

  const group = selectedStep.conditionGroup;
  const ancestors = getWorkflowConditionAncestorOptions(steps, selectedStep.id);
  const validation = workflowConditionGroupSchema.safeParse(group);

  return (
    <div style={{ display: "grid", gap: "8px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
        <button
          type="button"
          style={buttonStyle}
          aria-pressed={group.combinator === "all"}
          onClick={() => updateSelected({ conditionGroup: setWorkflowConditionCombinator(group, "all") })}
        >All conditions</button>
        <button
          type="button"
          style={buttonStyle}
          aria-pressed={group.combinator === "any"}
          onClick={() => updateSelected({ conditionGroup: setWorkflowConditionCombinator(group, "any") })}
        >Any condition</button>
      </div>
      {group.conditions.map((condition, index) => {
        const operators = WORKFLOW_CONDITION_OPERATORS[condition.dataType] as readonly WorkflowConditionOperator[];
        const unary = UNARY_OPERATORS.has(condition.operator);
        return (
          <div key={index} style={{ display: "grid", gap: "6px", padding: "8px", border: "1px solid var(--border, #334155)", borderRadius: "8px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", alignItems: "center" }}>
              <strong style={{ fontSize: "12px" }}>Condition {index + 1}</strong>
              <button type="button" style={buttonStyle} disabled={group.conditions.length <= 1} onClick={() => updateSelected({ conditionGroup: removeWorkflowCondition(group, index) })}>Remove</button>
            </div>
            <FieldLabel help="Only completed forward-ancestor steps can provide condition data.">Source step</FieldLabel>
            <select
              style={selectStyle}
              value={condition.source.stepId}
              onChange={(event) => updateSelected({ conditionGroup: updateWorkflowCondition(group, index, { source: { ...condition.source, stepId: event.target.value } }) })}
            >
              <option value="">— Select ancestor —</option>
              {ancestors.map((step) => <option key={step.id} value={step.id}>{step.title || step.id}</option>)}
            </select>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="Exact registered JSON work-product title from the selected step.">Work product title</FieldLabel>
                <input style={inputStyle} value={condition.source.title} placeholder="decision.json" onChange={(event) => updateSelected({ conditionGroup: updateWorkflowCondition(group, index, { source: { ...condition.source, title: event.target.value } }) })} />
              </div>
              <div style={{ display: "grid", gap: "4px" }}>
                <FieldLabel help="Restricted path such as $.status or $.items[0].id.">JSON path</FieldLabel>
                <input style={inputStyle} value={condition.source.path} placeholder="$.status" onChange={(event) => updateSelected({ conditionGroup: updateWorkflowCondition(group, index, { source: { ...condition.source, path: event.target.value } }) })} />
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: unary ? "1fr 1fr" : "1fr 1fr 1fr", gap: "6px" }}>
              <select style={selectStyle} aria-label="Data type" value={condition.dataType} onChange={(event) => updateSelected({ conditionGroup: updateWorkflowCondition(group, index, { dataType: event.target.value as WorkflowConditionDataType }) })}>
                {Object.keys(WORKFLOW_CONDITION_OPERATORS).map((dataType) => <option key={dataType} value={dataType}>{dataType}</option>)}
              </select>
              <select style={selectStyle} aria-label="Operator" value={condition.operator} onChange={(event) => updateSelected({ conditionGroup: updateWorkflowCondition(group, index, { operator: event.target.value as WorkflowConditionOperator }) })}>
                {operators.map((operator) => <option key={operator} value={operator}>{operator}</option>)}
              </select>
              {!unary ? <input style={inputStyle} aria-label="Right value" value={String(condition.rightValue ?? "")} onChange={(event) => updateSelected({ conditionGroup: updateWorkflowCondition(group, index, { rightValue: condition.dataType === "number" ? Number(event.target.value) : event.target.value }) })} /> : null}
            </div>
          </div>
        );
      })}
      <button type="button" style={buttonStyle} onClick={() => updateSelected({ conditionGroup: addWorkflowCondition(group, ancestors[0]?.id ?? "") })}>Add condition</button>
      {!validation.success ? <p style={noticeStyle("error")}>Fix the condition fields before saving. {validation.error.issues[0]?.message}</p> : null}
    </div>
  );
}
