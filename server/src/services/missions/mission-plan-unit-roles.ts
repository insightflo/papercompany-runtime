import { classifyWorkflowStepRole } from "../workflow-step-role.js";
import { hasPlanArtifactRole, type PlanningArtifactTool } from "./mission-plan-publication-contract.js";
import { buildDependencyIndex, unitDependsOn } from "./mission-plan-unit-dependencies.js";
export type PlanQaUnitRole = { readonly publish: boolean; readonly readbackQa: boolean; readonly audienceSplit: boolean; readonly scenario: boolean };
export function extractUnitRoles(unit: Record<string, unknown>, tools: readonly PlanningArtifactTool[] = []): PlanQaUnitRole {
  return {
    publish: hasPlanArtifactRole(unit, tools, "publication"),
    readbackQa: classifyWorkflowStepRole(unit) === "qa" || hasPlanArtifactRole(unit, tools, "publication-verify"),
    audienceSplit: Array.isArray(unit.audiences) && unit.audiences.length > 1,
    scenario: Array.isArray(unit.scenarios) && unit.scenarios.length > 0,
  };
}
export function hasPostDeliveryReadbackQa(units: ReadonlyArray<Record<string, unknown>>, tools: readonly PlanningArtifactTool[] = []): boolean {
  const roles = units.map(unit => extractUnitRoles(unit, tools));
  const dependencies = buildDependencyIndex(units);
  return roles.some(role => role.publish) && roles.every((role, index) => !role.publish
    || roles.some((qa, qaIndex) => qa.readbackQa && unitDependsOn(dependencies, qaIndex, index)));
}
