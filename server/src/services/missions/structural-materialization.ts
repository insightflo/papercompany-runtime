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

const STRUCTURAL_VALIDATOR_DEFAULT_ARGS_TOOL = /^validate-/;

/**
 * structural 검증 tool 스텝에 toolArgs가 비어 있으면 표준 검증 인자를 자동 채운다:
 * 의존이 정확히 1개(검증 대상 생산자)일 때 dir={$steps.<생산자>.workProductDir}, glob=*.html.
 * 인자 없는 tool 스텝은 실행 시 반드시 실패하므로(2026-08-27 gazua-evening 2 사고),
 * 채울 수 없는 경우는 fail-closed로 계획 물리화를 거부한다 — 계획 유닛에 toolArgs를 선언하게 한다.
 */
export function fillStructuralValidatorToolArgs(steps: Step[]): void {
  const stepIds = new Set(steps.map((step) => step.id));
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (step.type !== "tool" || step.qaType !== "structural") continue;
    const declared = step.toolArgs as Record<string, unknown> | undefined;
    if (declared && typeof declared === "object" && Object.keys(declared).length > 0) continue;
    const toolName = step.toolNames?.[0] ?? "";
    const dependencies = step.dependencies ?? [];
    const producerStepId = dependencies.length === 1 && stepIds.has(dependencies[0]!) ? dependencies[0]! : null;
    if (STRUCTURAL_VALIDATOR_DEFAULT_ARGS_TOOL.test(toolName) && producerStepId) {
      steps[i] = {
        ...step,
        toolArgs: { dir: `{$steps.${producerStepId}.workProductDir}`, glob: "*.html" },
      };
      continue;
    }
    throw new Error(
      `Invalid structural unit "${step.name ?? step.id}" (stepId=${step.id}): structural tool steps require toolArgs `
      + `(e.g. dir: {$steps.<producer>.workProductDir}). Declare toolArgs on the plan unit or narrow the gate to a single producer.`,
    );
  }
}

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
