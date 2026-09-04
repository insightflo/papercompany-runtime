// server/src/services/workflow/control-flow/structural-gate-readiness.ts
//
// [ purpose ] Capability/readiness validation for opt-in structural gates.
//   A structural gate is valid only when its single named tool is registered,
//   enabled, has adapterConfig.capabilities including "structural_validation_v1",
//   and the gate's assigneeAgentId has an agent-tool grant for that tool.
//
//   Pure functions + DB-backed readiness check. No company/workflow/tool hardcoding.

import type { Db } from "@paperclipai/db";
import { agentToolGrants, agents, toolDefinitions } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { listWorkflowToolCatalog } from "../tool-catalog.js";
import type { StructuralGateStep } from "./structural-gate.js";
import { isStructuralGateStep } from "./structural-gate.js";
import { STEP_MACHINE_CHECKS_TOOL } from "../step-machine-checks.js";

export { isStructuralGateStep };

export const STRUCTURAL_VALIDATION_CAPABILITY = "structural_validation_v1";

export interface StructuralReadinessResult {
  ready: boolean;
  errors: string[];
}

/**
 * Checks whether a structural gate step's tool is registered, enabled,
 * has the structural_validation_v1 capability, and the assignee has a grant.
 */
export async function checkStructuralGateReadiness(input: {
  db: Db;
  companyId: string;
  step: StructuralGateStep;
}): Promise<StructuralReadinessResult> {
  const errors: string[] = [];
  const toolNames = Array.isArray(input.step.toolNames)
    ? input.step.toolNames.filter((t) => typeof t === "string" && t.trim())
    : [];
  if (toolNames.length !== 1) {
    return { ready: false, errors: ["Structural gate must have exactly one toolName."] };
  }
  const toolName = toolNames[0]!;
  // [machine-check gates] The reserved in-process verifier carries no tool
  //   authority: it runs deterministic code-level predicates inside the server
  //   with no registry row, no capability declaration, and no agent grant.
  //   Shape checks (single toolName, empty agentId, topology) remain fully
  //   active in validateStructuralGateReadinessForSteps.
  if (toolName === STEP_MACHINE_CHECKS_TOOL) {
    return { ready: true, errors: [] };
  }
  const assigneeAgentId = (input.step as { assigneeAgentId?: string }).assigneeAgentId;
  if (!assigneeAgentId?.trim()) {
    return { ready: false, errors: ["Structural gate must declare assigneeAgentId as grant subject."] };
  }

  // 1. Check tool is registered and enabled via catalog
  const catalog = await listWorkflowToolCatalog(input.db, input.companyId);
  const tool = catalog.tools.find((t) => t.name === toolName);
  if (!tool) {
    errors.push(`Tool "${toolName}" is not registered.`);
  } else if (!tool.enabled) {
    errors.push(`Tool "${toolName}" is registered but not enabled.`);
  }

  // 2. Check capability via toolDefinitions.adapterConfig.capabilities
  const [def] = await input.db
    .select({ adapterConfig: toolDefinitions.adapterConfig })
    .from(toolDefinitions)
    .where(and(
      eq(toolDefinitions.companyId, input.companyId),
      eq(toolDefinitions.name, toolName),
    ))
    .limit(1);

  if (def) {
    const config = def.adapterConfig as Record<string, unknown> | null;
    const capabilities = config?.capabilities;
    const hasCapability = Array.isArray(capabilities)
      && capabilities.includes(STRUCTURAL_VALIDATION_CAPABILITY);
    if (!hasCapability) {
      errors.push(
        `Tool "${toolName}" does not declare capability "${STRUCTURAL_VALIDATION_CAPABILITY}" in adapterConfig.capabilities.`,
      );
    }
  } else {
    // No toolDefinitions row — plugin or otherwise. Must fail: capability
    // can only be verified via adapterConfig.capabilities on a registered tool.
    errors.push(`Tool "${toolName}" has no toolDefinitions row — cannot verify "${STRUCTURAL_VALIDATION_CAPABILITY}" capability.`);
  }

  // 3. Check assignee has agent-tool grant
  const grants = catalog.grants.filter(
    (g) => g.toolName === toolName && (g.agentId === assigneeAgentId || !g.agentId),
  );
  if (grants.length === 0) {
    // Also check DB directly (catalog may not cover all grant forms)
    const [dbGrant] = await input.db
      .select({ id: agentToolGrants.id })
      .from(agentToolGrants)
      .innerJoin(toolDefinitions, eq(agentToolGrants.toolId, toolDefinitions.id))
      .innerJoin(agents, and(
        eq(agents.id, agentToolGrants.agentId),
        eq(agents.companyId, input.companyId),
      ))
      .where(and(
        eq(agentToolGrants.companyId, input.companyId),
        eq(agentToolGrants.agentId, assigneeAgentId),
        eq(toolDefinitions.name, toolName),
      ))
      .limit(1);
    if (!dbGrant) {
      errors.push(`Agent ${assigneeAgentId} has no tool grant for "${toolName}".`);
    }
  }

  return { ready: errors.length === 0, errors };
}

/**
 * Validates all structural gates in a persisted workflow's steps for readiness.
 * Returns all errors; empty array means all gates pass readiness.
 */
export async function validateStructuralGateReadinessForSteps(input: {
  db: Db;
  companyId: string;
  steps: readonly StructuralGateStep[];
}): Promise<string[]> {
  const allErrors: string[] = [];
  for (const step of input.steps) {
    const declaredStructural = typeof step.qaType === "string" && step.qaType.trim().toLowerCase() === "structural";
    if (!declaredStructural) continue;
    const stepType = typeof step.type === "string" ? step.type.trim().toLowerCase() : "";
    const agentId = typeof step.agentId === "string" ? step.agentId.trim() : "";
    const toolNames = Array.isArray(step.toolNames)
      ? step.toolNames.filter((name) => typeof name === "string" && name.trim())
      : [];
    if (stepType !== "tool") {
      allErrors.push(`[${step.id}] Structural gate requires type:"tool".`);
      continue;
    }
    if (agentId) {
      allErrors.push(`[${step.id}] Structural gate must be issue-less (empty agentId).`);
      continue;
    }
    if (toolNames.length !== 1) {
      allErrors.push(`[${step.id}] Structural gate must have exactly one toolName.`);
      continue;
    }
    if (!isStructuralGateStep(step)) continue;
    const result = await checkStructuralGateReadiness({
      db: input.db,
      companyId: input.companyId,
      step,
    });
    if (!result.ready) {
      allErrors.push(...result.errors.map((e) => `[${step.id}] ${e}`));
    }
  }
  return allErrors;
}

// [ purpose ] Pre-PLAN readiness: applies the SAME registered-tool readiness
//   (toolDefinitions row, enabled, structural_validation_v1 capability,
//   assignee grant) to DECLARED plan units before PLAN-QA side effects.
//   Self-contained (no import of structural-materialization) to avoid a
//   cross-module dependency cycle. Mirrors isDeclaredStructuralUnit semantics.

type PlanUnit = Record<string, unknown>;

function readTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isDeclaredStructuralPlanUnit(unit: PlanUnit): boolean {
  const unitType = readTrimmedString(unit.type)?.toLowerCase() ?? "";
  const qaType = readTrimmedString(unit.qaType)?.toLowerCase() ?? "";
  return unitType === "tool" && qaType === "structural";
}

function readUnitToolNames(unit: PlanUnit): string[] {
  return Array.from(new Set([
    ...(Array.isArray(unit.toolNames) ? unit.toolNames.filter((t): t is string => typeof t === "string" && Boolean(t.trim())) : []),
    ...(Array.isArray(unit.tools) ? unit.tools.filter((t): t is string => typeof t === "string" && Boolean(t.trim())) : []),
    ...(readTrimmedString(unit.toolName) ? [readTrimmedString(unit.toolName)!] : []),
  ]));
}

/**
 * Validates readiness for every declared structural plan unit, applying the
 * exact same checks as persisted runtime gates. Returns actionable errors;
 * empty array means all declared gates are ready. Units that do not declare
 * exactly one toolName are skipped here (arity is enforced by topology validation).
 */
export async function validateDeclaredStructuralPlanReadiness(input: {
  db: Db;
  companyId: string;
  units: readonly PlanUnit[];
}): Promise<string[]> {
  const gateUnits = input.units.filter(isDeclaredStructuralPlanUnit);
  if (gateUnits.length === 0) return [];
  const steps: StructuralGateStep[] = [];
  for (const unit of gateUnits) {
    const id = readTrimmedString(unit.id) ?? readTrimmedString(unit.unitId) ?? readTrimmedString(unit.stepId) ?? "?";
    const assigneeAgentId = readTrimmedString(unit.assigneeAgentId) ?? undefined;
    const step: StructuralGateStep & { assigneeAgentId?: string } = {
      id,
      type: "tool",
      qaType: "structural",
      agentId: "",
      toolNames: readUnitToolNames(unit),
      ...(assigneeAgentId ? { assigneeAgentId } : {}),
    };
    steps.push(step);
  }
  return validateStructuralGateReadinessForSteps({
    db: input.db,
    companyId: input.companyId,
    steps,
  });
}
