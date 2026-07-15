// server/src/services/workflow/control-flow/structural-gate.ts
//
// [ purpose ] Pure classification helper for hybrid QA structural
//   (deterministic) tool gates. A structural gate is an issue-less tool step
//   (no agentId, exactly one toolName) with qaType:"structural". It runs
//   BEFORE semantic QA and checks machine contracts only (IDs, schema keys,
//   URL patterns, selectors, roles, status, hashes).
//
//   Verdict persistence and loading are handled by structural-gate-ledger.ts
//   via the authoritative workflow_transition_events table. This module
//   contains only step classification — no metadata-derived verdict logic.

import type { ConditionalEdge } from "./types.js";

/** Minimal step shape this module needs. WorkflowStep is structurally compatible. */
export interface StructuralGateStep {
  id: string;
  agentId?: string;
  type?: string;
  qaType?: string;
  toolNames?: string[];
  dependencies?: string[];
  conditionalDependencies?: ConditionalEdge[];
}

export type StructuralGateVerdict = "pass" | "request_changes";

/** Immutable producer evidence captured when a structural gate is dispatched.
 * It binds a gate verdict to the exact producer generation, including a newer
 * completion within the same iteration. */
export interface StructuralGateProducerToken {
  producerStepId: string;
  iterationIndex: number;
  completedAt: string;
}

export function readStructuralGateProducerToken(value: unknown): StructuralGateProducerToken | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const token = value as Record<string, unknown>;
  const producerStepId = typeof token.producerStepId === "string" ? token.producerStepId.trim() : "";
  const iterationIndex = typeof token.iterationIndex === "number" && Number.isInteger(token.iterationIndex)
    ? token.iterationIndex
    : null;
  const completedAt = typeof token.completedAt === "string" ? token.completedAt.trim() : "";
  return producerStepId && iterationIndex !== null && completedAt
    ? { producerStepId, iterationIndex, completedAt }
    : null;
}

export function sameStructuralGateProducerToken(
  left: StructuralGateProducerToken | null,
  right: StructuralGateProducerToken | null,
): boolean {
  return left !== null
    && right !== null
    && left.producerStepId === right.producerStepId
    && left.iterationIndex === right.iterationIndex
    && left.completedAt === right.completedAt;
}

/**
 * Returns true when the step is an issue-less tool step explicitly declared as a
 * structural gate (type:"tool" + qaType:"structural" + exactly one toolName + no
 * workflow agentId). The agentId must be empty so no LLM heartbeat is launched.
 */
export function isStructuralGateStep(step: StructuralGateStep | null | undefined): boolean {
  if (!step) return false;
  const stepType = typeof step.type === "string" ? step.type.trim().toLowerCase() : "";
  const qaType = typeof step.qaType === "string" ? step.qaType.trim().toLowerCase() : "";
  if (stepType !== "tool" || qaType !== "structural") return false;
  const agentId = typeof step.agentId === "string" ? step.agentId.trim() : "";
  if (agentId.length > 0) return false;
  const toolNames = Array.isArray(step.toolNames)
    ? step.toolNames.filter((t) => typeof t === "string" && t.trim().length > 0)
    : [];
  return toolNames.length === 1;
}
