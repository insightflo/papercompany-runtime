/** Company/run scoped IF sources: forward ancestors, current producer, bounded same-byte JSON. */
import type { Db } from "@paperclipai/db";
import type { WorkflowConditionSource, WorkflowToolJsonSource } from "@paperclipai/shared";
import type { ConditionalEdge } from "./types.js";
import { readBoundedJsonFile, workflowConditionFailure as fail } from "./condition-source-file.js";
import { selectAttemptWorkProduct, type CurrentWorkProductCandidate } from "./condition-source-candidate.js";
export { WORKFLOW_IF_CONDITION_ERROR_PREFIX, workflowConditionFailure } from "./condition-source-file.js";
export type { CurrentWorkProductCandidate } from "./condition-source-candidate.js";

export type ConditionResolverStep = {
  id: string;
  dependencies?: string[];
  dependsOn?: string[];
  conditionalDependencies?: ConditionalEdge[];
};

/** Stable internal key for a source so the executor can look up the resolved root. */
export function workflowConditionSourceKey(source: WorkflowConditionSource): string {
  if (source.kind === "tool_json") {
    return `tool_json\u0000${source.stepId}\u0000${source.toolName}\u0000${stableStringify(source.parameters)}\u0000${source.path}`;
  }
  return `work_product_json\u0000${source.stepId}\u0000${source.title}\u0000${source.path}`;
}

/** Deterministic JSON string with sorted object keys (canonical tool-source dedupe key). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

function buildForwardPredecessors(steps: ReadonlyArray<ConditionResolverStep>): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const step of steps) {
    const preds = new Set<string>();
    const legacy = step.dependencies ?? step.dependsOn ?? [];
    for (const dep of legacy) {
      if (typeof dep === "string" && dep.length > 0) preds.add(dep);
    }
    for (const edge of step.conditionalDependencies ?? []) {
      if (edge && edge.isBackEdge !== true && typeof edge.stepId === "string" && edge.stepId.length > 0) {
        preds.add(edge.stepId);
      }
    }
    map.set(step.id, preds);
  }
  return map;
}

/** Step IDs that can reach `startId` through forward (non-back-edge) edges. Excludes startId. */
function collectForwardAncestors(startId: string, steps: ReadonlyArray<ConditionResolverStep>): Set<string> {
  const predMap = buildForwardPredecessors(steps);
  const ancestors = new Set<string>();
  const stack = [startId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const preds = predMap.get(current);
    if (!preds) continue;
    for (const pred of preds) {
      if (!ancestors.has(pred)) {
        ancestors.add(pred);
        stack.push(pred);
      }
    }
  }
  return ancestors;
}

/** Shared by IF evaluation and resume-time verdict staleness checks. */
export async function selectCurrentWorkProductCandidate(input: {
  db: Db;
  run: { id: string; companyId: string };
  ifStepId: string;
  workflowSteps: ReadonlyArray<ConditionResolverStep>;
  stepId: string;
  title: string;
}): Promise<CurrentWorkProductCandidate> {
  const { stepId } = input;
  const knownStepIds = new Set(input.workflowSteps.map((step) => step.id));
  const ancestors = collectForwardAncestors(input.ifStepId, input.workflowSteps);
  if (stepId === input.ifStepId) {
    fail(`IF step "${input.ifStepId}" cannot read its own output as a condition source`);
  }
  if (!knownStepIds.has(stepId)) {
    fail(`condition source step "${stepId}" does not exist in the workflow`);
  }
  if (!ancestors.has(stepId)) {
    fail(`condition source step "${stepId}" is not a forward ancestor of IF step "${input.ifStepId}"`);
  }
  return selectAttemptWorkProduct(input);
}

/** Resolves work-product JSON locally and tool JSON through the injected executor. */
export async function resolveWorkflowConditionSources(input: {
  db: Db;
  run: { id: string; companyId: string };
  ifStep: ConditionResolverStep;
  workflowSteps: ReadonlyArray<ConditionResolverStep>;
  sources: ReadonlyArray<WorkflowConditionSource>;
  resolveToolJsonSource?: (source: WorkflowToolJsonSource) => Promise<unknown>;
}): Promise<Map<string, unknown>> {
  const ancestors = collectForwardAncestors(input.ifStep.id, input.workflowSteps);
  const out = new Map<string, unknown>();

  // Deduplicate work-product sources by (stepId, title); the same file is read once.
  const uniquePairs = new Map<string, { stepId: string; title: string }>();
  for (const source of input.sources) {
    if (source.kind === "tool_json") continue;
    const pairKey = `${source.stepId}\u0000${source.title}`;
    if (!uniquePairs.has(pairKey)) uniquePairs.set(pairKey, { stepId: source.stepId, title: source.title });
  }
  for (const { stepId, title } of uniquePairs.values()) {
    const chosen = await selectCurrentWorkProductCandidate({
      db: input.db, run: input.run, ifStepId: input.ifStep.id, workflowSteps: input.workflowSteps, stepId, title,
    });
    const parsed = await readBoundedJsonFile(chosen.path, title, chosen.expectedHash);
    for (const source of input.sources) {
      if (source.kind !== "tool_json" && source.stepId === stepId && source.title === title) {
        out.set(workflowConditionSourceKey(source), parsed);
      }
    }
  }

  // Equal tool groups execute once; store roots under every member's own key (paths may differ).
  const toolGroups = new Map<string, WorkflowToolJsonSource[]>();
  for (const source of input.sources) {
    if (source.kind !== "tool_json") continue;
    const groupKey = `${source.toolName}\u0000${stableStringify(source.parameters)}`;
    const group = toolGroups.get(groupKey);
    if (group) group.push(source);
    else toolGroups.set(groupKey, [source]);
  }
  for (const groupSources of toolGroups.values()) {
    const representative = groupSources[0]!;
    if (!ancestors.has(representative.stepId)) {
      fail(`condition source step "${representative.stepId}" is not a forward ancestor of IF step "${input.ifStep.id}"`);
    }
    const executor = input.resolveToolJsonSource;
    if (!executor) fail(`tool source "${representative.toolName}" cannot be executed in this context`);
    const data = await executor(representative);
    for (const source of groupSources) out.set(workflowConditionSourceKey(source), data);
  }
  return out;
}
