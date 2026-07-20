/**
 * [purpose] Semantic topology validation for native IF/Complete control nodes, run at
 *   workflow definition create/update (via validateDag) before any launch. Pure, no DB.
 *   Enforces the V1 control-node contract: typed condition groups, fixed true/false
 *   outputs, IF-only condition predecessors, Complete as a single-forward-edge terminal
 *   with no outputs/agent/tool/loop, forward-ancestor sources, and rejection of topologies
 *   where reaching Complete would leave a separately reachable parallel branch active.
 * [links] Consumed by dag-engine.ts validateDag. Depends only on control-flow/types.
 */
import { workflowConditionGroupSchema } from "@paperclipai/shared";
import type { ConditionalEdge, ConditionalEdgeWhen } from "./types.js";

export type ControlNodeValidationStep = {
  id: string;
  type?: string;
  dependencies?: string[];
  dependsOn?: string[];
  conditionalDependencies?: ConditionalEdge[];
  agentId?: string;
  agentName?: string;
  assigneeAgentId?: string;
  toolName?: string;
  tools?: string[];
  toolNames?: string[];
  conditionGroup?: unknown;
};

type OutgoingConditionalEdge = {
  targetId: string;
  edge: ConditionalEdge;
};

const CONDITION_OUTCOMES: ReadonlySet<ConditionalEdgeWhen> = new Set(["condition_true", "condition_false"]);

function isIfStep(step: ControlNodeValidationStep): boolean {
  return step.type === "if";
}

function isCompleteStep(step: ControlNodeValidationStep): boolean {
  return step.type === "complete";
}

function legacyDeps(step: ControlNodeValidationStep): string[] {
  const deps = [...(step.dependencies ?? []), ...(step.dependsOn ?? [])];
  return Array.from(new Set(deps.filter((d): d is string => typeof d === "string" && d.length > 0)));
}

/** Forward (non-back-edge) incoming edges of a step: legacy dependencies + conditional. */
function forwardIncoming(step: ControlNodeValidationStep): ConditionalEdge[] {
  const edges: ConditionalEdge[] = legacyDeps(step).map((stepId) => ({ stepId, when: "success" }));
  for (const edge of step.conditionalDependencies ?? []) {
    if (edge && edge.isBackEdge !== true) edges.push(edge);
  }
  return edges;
}

/** Forward predecessors of a step (for ancestry): legacy deps + non-back-edge conditional stepIds. */
function forwardPredecessors(step: ControlNodeValidationStep): string[] {
  const preds = new Set<string>(legacyDeps(step));
  for (const edge of step.conditionalDependencies ?? []) {
    if (edge && edge.isBackEdge !== true && typeof edge.stepId === "string") preds.add(edge.stepId);
  }
  return Array.from(preds);
}

function collectForwardAncestors(startId: string, steps: ReadonlyArray<ControlNodeValidationStep>): Set<string> {
  const predMap = new Map(steps.map((s) => [s.id, forwardPredecessors(s)]));
  const ancestors = new Set<string>();
  const stack = [startId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const pred of predMap.get(current) ?? []) {
      if (!ancestors.has(pred)) {
        ancestors.add(pred);
        stack.push(pred);
      }
    }
  }
  return ancestors;
}

/** Forward descendants of startId (inclusive of startId) via successor edges. */
function collectForwardDescendants(startId: string, steps: ReadonlyArray<ControlNodeValidationStep>): Set<string> {
  const succMap = new Map<string, Set<string>>();
  for (const step of steps) {
    for (const pred of forwardPredecessors(step)) {
      if (!succMap.has(pred)) succMap.set(pred, new Set());
      succMap.get(pred)!.add(step.id);
    }
  }
  const descendants = new Set<string>([startId]);
  const stack = [startId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const succ of succMap.get(current) ?? []) {
      if (!descendants.has(succ)) {
        descendants.add(succ);
        stack.push(succ);
      }
    }
  }
  return descendants;
}

/** Edges FROM stepId: every other step's forward conditionalDependencies that reference stepId. */
function outgoingConditionEdges(
  steps: ReadonlyArray<ControlNodeValidationStep>,
  stepId: string,
): OutgoingConditionalEdge[] {
  const out: OutgoingConditionalEdge[] = [];
  for (const step of steps) {
    for (const edge of step.conditionalDependencies ?? []) {
      if (edge && edge.stepId === stepId) out.push({ targetId: step.id, edge });
    }
  }
  return out;
}

function outgoingLegacyTargets(
  steps: ReadonlyArray<ControlNodeValidationStep>,
  stepId: string,
): string[] {
  return steps.filter((step) => legacyDeps(step).includes(stepId)).map((step) => step.id);
}

function hasAgentOrToolAssignment(step: ControlNodeValidationStep): boolean {
  const agentId = typeof step.agentId === "string" ? step.agentId.trim() : "";
  const agentName = typeof step.agentName === "string" ? step.agentName.trim() : "";
  const assigneeAgentId = typeof step.assigneeAgentId === "string" ? step.assigneeAgentId.trim() : "";
  const toolName = typeof step.toolName === "string" ? step.toolName.trim() : "";
  const tools = Array.isArray(step.tools) ? step.tools.some((t) => typeof t === "string" && t.trim().length > 0) : false;
  const toolNames = Array.isArray(step.toolNames) ? step.toolNames.some((t) => typeof t === "string" && t.trim().length > 0) : false;
  return agentId.length > 0 || agentName.length > 0 || assigneeAgentId.length > 0 || toolName.length > 0 || tools || toolNames;
}

/**
 * Returns actionable error strings for native control-node topology. Empty array = valid.
 * Legacy workflows without control nodes produce no errors.
 */
export function validateWorkflowControlNodes(steps: ReadonlyArray<ControlNodeValidationStep>): string[] {
  const errors: string[] = [];
  const stepIds = new Set(steps.map((s) => s.id));
  const stepById = new Map(steps.map((s) => [s.id, s] as const));

  // Only IF nodes may be predecessors of condition_true/condition_false edges.
  for (const step of steps) {
    for (const edge of step.conditionalDependencies ?? []) {
      if (edge && CONDITION_OUTCOMES.has(edge.when ?? ("success" as ConditionalEdgeWhen))) {
        const pred = stepById.get(edge.stepId);
        if (!pred || !isIfStep(pred)) {
          errors.push(`Step "${step.id}" has a ${edge.when} edge from "${edge.stepId}" which is not an IF control node`);
        }
      }
    }
  }

  for (const step of steps) {
    if (isIfStep(step)) {
      const parsedConditionGroup = workflowConditionGroupSchema.safeParse(step.conditionGroup);
      if (!parsedConditionGroup.success) {
        errors.push(`IF step "${step.id}" requires a valid non-empty conditionGroup`);
      }
      const outgoing = outgoingConditionEdges(steps, step.id);
      const trueForward = outgoing.filter(({ edge }) => edge.when === "condition_true" && edge.isBackEdge !== true);
      const falseForward = outgoing.filter(({ edge }) => edge.when === "condition_false" && edge.isBackEdge !== true);
      if (trueForward.length === 0) {
        errors.push(`IF step "${step.id}" must have at least one outgoing condition_true edge`);
      }
      if (falseForward.length === 0) {
        errors.push(`IF step "${step.id}" must have at least one outgoing condition_false edge`);
      }
      if (outgoingLegacyTargets(steps, step.id).length > 0) {
        errors.push(`IF step "${step.id}" outgoing edges must use condition_true or condition_false`);
      }
      for (const { edge } of outgoing) {
        if (edge.isBackEdge === true) {
          errors.push(`IF step "${step.id}" ${edge.when ?? "success"} output edge may not be a back-edge`);
        }
        if (!CONDITION_OUTCOMES.has(edge.when ?? ("success" as ConditionalEdgeWhen))) {
          errors.push(`IF step "${step.id}" outgoing edges must use condition_true or condition_false`);
        }
      }
      if (hasAgentOrToolAssignment(step)) {
        errors.push(`IF step "${step.id}" must not select an agent or tool`);
      }
      // Every IF source must be a forward ancestor (and not the IF itself).
      const ancestors = collectForwardAncestors(step.id, steps);
      const rawConditions = step.conditionGroup && typeof step.conditionGroup === "object"
        ? (step.conditionGroup as { conditions?: unknown[] }).conditions
        : undefined;
      for (const condition of Array.isArray(rawConditions) ? rawConditions : []) {
        const source = (condition as { source?: { stepId?: unknown } } | null)?.source;
        const sourceStepId = typeof source?.stepId === "string" ? source.stepId : undefined;
        if (!sourceStepId) {
          errors.push(`IF step "${step.id}" has a condition without a source stepId`);
        } else if (sourceStepId === step.id) {
          errors.push(`IF step "${step.id}" cannot read its own output as a condition source`);
        } else if (!stepIds.has(sourceStepId)) {
          errors.push(`IF step "${step.id}" condition source "${sourceStepId}" does not exist`);
        } else if (!ancestors.has(sourceStepId)) {
          errors.push(`IF step "${step.id}" condition source "${sourceStepId}" is not a forward ancestor`);
        }
      }
    } else if (isCompleteStep(step)) {
      const incoming = forwardIncoming(step);
      const conditionIncoming = incoming.filter((e) => CONDITION_OUTCOMES.has(e.when ?? ("success" as ConditionalEdgeWhen)));
      if (incoming.length !== 1 || conditionIncoming.length !== 1) {
        errors.push(`Complete step "${step.id}" must have exactly one incoming forward condition edge`);
      } else {
        const edge = conditionIncoming[0]!;
        const pred = stepById.get(edge.stepId);
        if (!pred || !isIfStep(pred)) {
          errors.push(`Complete step "${step.id}" incoming edge must originate from an IF control node`);
        }
      }
      const hasBackEdge = (step.conditionalDependencies ?? []).some((e) => e?.isBackEdge === true);
      if (hasBackEdge) {
        errors.push(`Complete step "${step.id}" may not carry a loop (back-edge) annotation`);
      }
      const outgoing = outgoingConditionEdges(steps, step.id);
      const outgoingLegacy = outgoingLegacyTargets(steps, step.id).length > 0;
      if (outgoing.length > 0 || outgoingLegacy) {
        errors.push(`Complete step "${step.id}" must have no outgoing edges`);
      }
      if (hasAgentOrToolAssignment(step)) {
        errors.push(`Complete step "${step.id}" must not select an agent or tool`);
      }
    }
  }

  // Parallel-branch guard: reaching a Complete must not leave a separately reachable
  // branch active outside its IF's ancestors and two output branches.
  for (const complete of steps.filter(isCompleteStep)) {
    const incoming = forwardIncoming(complete).find((e) => CONDITION_OUTCOMES.has(e.when ?? ("success" as ConditionalEdgeWhen)));
    if (!incoming) continue; // already reported above
    const ifId = incoming.stepId;
    const allowed = new Set<string>(collectForwardAncestors(ifId, steps));
    allowed.add(ifId);
    const targets = outgoingConditionEdges(steps, ifId)
      .filter(({ edge }) => edge.isBackEdge !== true && CONDITION_OUTCOMES.has(edge.when ?? ("success" as ConditionalEdgeWhen)));
    for (const { targetId } of targets) {
      for (const desc of collectForwardDescendants(targetId, steps)) {
        allowed.add(desc);
      }
    }
    allowed.add(complete.id);
    for (const step of steps) {
      if (!allowed.has(step.id)) {
        errors.push(`Complete step "${complete.id}" would leave a separately reachable parallel branch active (step "${step.id}")`);
        break;
      }
    }
  }

  return errors;
}
