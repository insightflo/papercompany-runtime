// server/src/services/missions/structural-materialization.ts
//
// [ purpose ] Structural gate materialization helpers extracted from
//   mission-owner-plan-decisions.ts to keep the legacy file from growing.
//   Contains: unit classification, fail-closed validation, toolArgs
//   reference rewriting, deterministic QA dependency repair, and scoped
//   prompt injection for QA steps downstream of structural gates.

import { isStructuralGateStep } from "../workflow/control-flow/structural-gate.js";
import { getStructuralTopologyErrors } from "../workflow/control-flow/structural-topology.js";

// Re-exported for call-site convenience
export { isStructuralGateStep };

export const DELEGATE_TO_COMPANY = "delegate_to_company";

const STEP_REF_TOKEN = /\{\$steps\.([^}]+)\.(workProductPath|workProductDir|siblingAssetsDir)\}/g;

type PlanUnit = Record<string, unknown>;
type Step = {
  id: string;
  name?: string;
  title?: string;
  agentId: string;
  dependencies: string[];
  description?: string;
  type?: string;
  qaType?: string;
  toolNames?: string[];
  toolArgs?: unknown;
  graphWorkProductRequired?: boolean;
};

// --- Unit classification ---

export function isDeclaredStructuralUnit(unit: PlanUnit): boolean {
  const unitType = readString(unit.type)?.toLowerCase() ?? "";
  const qaType = readString(unit.qaType)?.toLowerCase() ?? "";
  return unitType === "tool" && qaType === "structural";
}

export function isPartialStructuralDeclaration(unit: PlanUnit): boolean {
  const qaType = readString(unit.qaType)?.toLowerCase() ?? "";
  const unitType = readString(unit.type)?.toLowerCase() ?? "";
  return qaType === "structural" && unitType !== "tool";
}

// --- Fail-closed validation ---

export function validateStructuralUnit(unit: PlanUnit, title: string, index: number): void {
  if (isPartialStructuralDeclaration(unit)) {
    throw new Error(
      `Invalid structural unit "${title}" (id=${readString(unit.id) ?? index}): `
      + `qaType:"structural" requires type:"tool". Remove qaType or set type:"tool".`,
    );
  }
  const declared = isDeclaredStructuralUnit(unit);
  if (declared && readUnitToolNames(unit).includes(DELEGATE_TO_COMPANY)) {
    throw new Error(
      `Invalid structural tool unit "${title}" (id=${readString(unit.id) ?? index}): `
      + `delegate_to_company cannot serve as a structural validator.`,
    );
  }
  if (declared) {
    const toolNames = readUnitToolNames(unit);
    if (toolNames.length !== 1) {
      throw new Error(
        `Invalid structural tool unit "${title}" (id=${readString(unit.id) ?? index}): `
        + `declared type:"tool" + qaType:"structural" requires exactly one toolName, got ${toolNames.length}. `
        + `Fix the plan or remove the structural declaration.`,
      );
    }
  }
}
// Pre-PLAN validation extracted to structural-plan-validation.ts
export { validateDeclaredStructuralPlan } from "./structural-plan-validation.js";
/** Validates structural gate topology after materialization.
 *  Each structural gate must have exactly one non-gate producer dependency.
 *  Every QA reviewing that producer must also depend on ALL structural gates for it. */
export function validateStructuralTopology(steps: Step[]): void {
  const errors = getStructuralTopologyErrors(steps);
  if (errors.length > 0) throw new Error(errors.join(" "));
}

// --- toolArgs reference rewriting ---

export function rewriteToolArgsStepReferences(
  toolArgs: unknown,
  unitIdToStepId: Map<string, string>,
): unknown {
  if (typeof toolArgs === "string") {
    return toolArgs.replace(STEP_REF_TOKEN, (token, refId: string, field: string) => {
      const mapped = unitIdToStepId.get(refId);
      return mapped ? `{$steps.${mapped}.${field}}` : token;
    });
  }
  if (Array.isArray(toolArgs)) {
    return toolArgs.map((item) => rewriteToolArgsStepReferences(item, unitIdToStepId));
  }
  if (toolArgs && typeof toolArgs === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(toolArgs as Record<string, unknown>)) {
      result[key] = rewriteToolArgsStepReferences(value, unitIdToStepId);
    }
    return result;
  }
  return toolArgs;
}

// --- Post-materialization passes ---

/** Rewrites toolArgs references using the unit→step ID map. */
export function rewriteStepToolArgs(
  plannedSteps: Step[],
  unitIdToStepId: Map<string, string>,
): void {
  if (unitIdToStepId.size === 0) return;
  for (let i = 0; i < plannedSteps.length; i++) {
    if (plannedSteps[i]!.toolArgs !== undefined) {
      plannedSteps[i] = {
        ...plannedSteps[i]!,
        toolArgs: rewriteToolArgsStepReferences(plannedSteps[i]!.toolArgs, unitIdToStepId),
      };
    }
  }
}

// --- Helpers ---

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readUnitToolNames(unit: PlanUnit): string[] {
  return Array.from(new Set([
    ...(Array.isArray(unit.toolNames) ? unit.toolNames.filter((t): t is string => typeof t === "string" && !!t.trim()) : []),
    ...(Array.isArray(unit.tools) ? unit.tools.filter((t): t is string => typeof t === "string" && !!t.trim()) : []),
    ...(readString(unit.toolName) ? [readString(unit.toolName)!] : []),
  ]));
}


function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && Boolean(v.trim())).map((v) => v.trim());
}
