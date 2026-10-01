import { classifyWorkflowStepRole } from "../workflow-step-role.js";
import { hasPlanArtifactRole, type PlanningArtifactTool } from "./mission-plan-publication-contract.js";

export function hasDeliveryActionRole(unit: Record<string, unknown>, tools: readonly PlanningArtifactTool[] = []): boolean {
  return hasPlanArtifactRole(unit, tools, "publication");
}
export function hasArtifactProducerRole(unit: Record<string, unknown>): boolean {
  return classifyWorkflowStepRole(unit) === "action" && unit.graphWorkProductRequired === true;
}
export function hasArtifactQaRole(unit: Record<string, unknown>): boolean {
  return classifyWorkflowStepRole(unit) === "qa";
}
export function reviewArtifactWorkProductMarkers(units: ReadonlyArray<Record<string, unknown>>, tools: readonly PlanningArtifactTool[] = []):
  Array<{ code: "invalid_artifact_workproduct_marker"; severity: "invalid"; message: string }> {
  return units.flatMap(unit => hasDeliveryActionRole(unit, tools) && unit.graphWorkProductRequired === false
    ? [{ code: "invalid_artifact_workproduct_marker" as const, severity: "invalid" as const,
      message: "Publication units must register their result: graphWorkProductRequired cannot be false." }] : []);
}
// Tool grants are validated against the scoped catalog during execution placement.
// Free-form descriptions cannot add a second preflight authority.
export function reviewDeliveryToolPreflightMarkers(_units: ReadonlyArray<Record<string, unknown>>):
  Array<{ code: "invalid_delivery_tool_preflight_unit"; severity: "invalid"; message: string }> {
  return [];
}
