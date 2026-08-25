// Pre-PLAN structural validation over the same canonical graph used by PLAN-QA
// and workflow materialization. It reports plan defects and never repairs them.

import {
  isMissionPlanUnitMaterialized,
  normalizeMissionPlanDependencyGraph,
} from "./mission-plan-dependency-graph.js";
import { isDeclaredStructuralUnit } from "./structural-materialization.js";

type PlanUnit = Record<string, unknown>;

export function validateDeclaredStructuralPlan(
  units: PlanUnit[],
  draftSteps: PlanUnit[] = [],
): string[] {
  const structuralIntentUnits = units.filter((unit) => readString(unit.qaType)?.toLowerCase() === "structural");
  if (structuralIntentUnits.length === 0) return [];

  const errors: string[] = [];
  for (const unit of structuralIntentUnits) {
    if (!isDeclaredStructuralUnit(unit)) {
      errors.push(`Structural unit "${readUnitLabel(unit)}" requires type:"tool".`);
      continue;
    }
    const toolNames = readUnitToolNames(unit);
    if (toolNames.length !== 1) {
      errors.push(`Structural gate "${readUnitLabel(unit)}" requires exactly one toolName, got ${toolNames.length}.`);
    } else if (toolNames[0] === "delegate_to_company") {
      errors.push(`Structural gate "${readUnitLabel(unit)}" cannot use delegate_to_company.`);
    }
  }

  const normalized = normalizeMissionPlanDependencyGraph(units, draftSteps);
  if (!normalized.ok) {
    const graphErrors = normalized.diagnostics.map((diagnostic) => diagnostic.message);
    for (const gate of structuralIntentUnits.filter(isDeclaredStructuralUnit)) {
      const dependencyRefs = rawEffectiveDependencies(gate, draftSteps);
      const producerCount = dependencyRefs.filter((ref) => units.some((candidate) =>
        isMissionPlanUnitMaterialized(candidate)
        && !isDeclaredStructuralUnit(candidate)
        && readAliases(candidate).includes(ref))).length;
      if (producerCount !== 1) {
        graphErrors.push(
          `Structural gate "${readUnitLabel(gate)}" must depend on exactly one non-gate producer, got ${producerCount}.`,
        );
      }
    }
    return [...errors, ...graphErrors];
  }

  const executableUnits = normalized.graph.materializedUnits;
  const byId = new Map(executableUnits.map((unit) => [readString(unit.id)!, unit]));
  const structuralUnits = executableUnits.filter(isDeclaredStructuralUnit);
  const dependencies = (unit: PlanUnit): string[] => readStringArray(unit.dependencies);

  for (const gate of structuralUnits) {
    const nonGateDependencies = dependencies(gate).filter((id) => {
      const owner = byId.get(id);
      return owner != null && !isDeclaredStructuralUnit(owner);
    });
    if (nonGateDependencies.length !== 1) {
      errors.push(
        `Structural gate "${readUnitLabel(gate)}" must depend on exactly one non-gate producer, got ${nonGateDependencies.length}.`,
      );
    }
  }

  for (const qa of executableUnits) {
    if (isDeclaredStructuralUnit(qa) || !isQaLikeUnit(qa)) continue;
    const qaDependencies = new Set(dependencies(qa));

    for (const producerId of qaDependencies) {
      const producer = byId.get(producerId);
      if (!producer || isDeclaredStructuralUnit(producer)) continue;
      const gatesForProducer = structuralUnits.filter((gate) => dependencies(gate).includes(producerId));
      const missingGates = gatesForProducer.filter((gate) => !qaDependencies.has(readString(gate.id)!));
      if (missingGates.length > 0) {
        errors.push(
          `QA unit "${readUnitLabel(qa)}" reviews producer "${producerId}" but does not depend on structural gate(s): ${missingGates.map(readUnitLabel).join(", ")}.`,
        );
      }
    }

    for (const gateId of qaDependencies) {
      const gate = byId.get(gateId);
      if (!gate || !isDeclaredStructuralUnit(gate)) continue;
      const missingProducers = dependencies(gate).filter((producerId) => {
        const producer = byId.get(producerId);
        return producer != null && !isDeclaredStructuralUnit(producer) && !qaDependencies.has(producerId);
      });
      if (missingProducers.length > 0) {
        errors.push(
          `QA unit "${readUnitLabel(qa)}" depends on structural gate "${gateId}" but omits its producer: ${missingProducers.map((id) => readUnitLabel(byId.get(id)!)).join(", ")}.`,
        );
      }
    }
  }

  return errors;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(readString).filter((value): value is string => value !== null);
}

function readUnitLabel(unit: PlanUnit): string {
  return readString(unit.id) ?? readString(unit.unitId) ?? readString(unit.stepId) ?? "?";
}

function readAliases(unit: PlanUnit): string[] {
  const sourceRef = typeof unit.sourceRef === "object" && unit.sourceRef !== null && !Array.isArray(unit.sourceRef)
    ? unit.sourceRef as PlanUnit
    : null;
  return Array.from(new Set([
    readString(unit.id), readString(unit.unitId), readString(unit.stepId),
    readString(unit.executionUnitId), readString(unit.selectedExecutionUnitId),
    readString(sourceRef?.id), readString(sourceRef?.issueId), readString(sourceRef?.stepId),
  ].filter((value): value is string => value !== null)));
}

function readDependencyForms(value: PlanUnit): string[] {
  return Array.from(new Set([
    ...readStringArray(value.dependencies),
    ...readStringArray(value.dependsOn),
    ...readStringArray(value.after),
  ]));
}

function rawEffectiveDependencies(unit: PlanUnit, draftSteps: PlanUnit[]): string[] {
  const aliases = new Set(readAliases(unit));
  const dependencies = readDependencyForms(unit);
  for (const step of draftSteps) {
    const targets = readStringArray(step.units).length > 0
      ? readStringArray(step.units)
      : [readString(step.unitId), readString(step.executionUnitId), readString(step.selectedExecutionUnitId), readString(step.id)]
        .filter((value): value is string => value !== null);
    if (targets.some((target) => aliases.has(target))) dependencies.push(...readDependencyForms(step));
  }
  return Array.from(new Set(dependencies));
}

function readUnitToolNames(unit: PlanUnit): string[] {
  return Array.from(new Set([
    ...readStringArray(unit.toolNames),
    ...readStringArray(unit.tools),
    ...(readString(unit.toolName) ? [readString(unit.toolName)!] : []),
  ]));
}

function isQaLikeUnit(unit: PlanUnit): boolean {
  const title = readString(unit.title) ?? readString(unit.name) ?? "";
  return /\[(qa|QA)\]/.test(title) || readString(unit.qaType) !== null;
}
