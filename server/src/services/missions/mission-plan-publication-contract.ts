import { artifactContractSchema, type ArtifactContract } from "@paperclipai/shared";
import { toolDefinitions, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { buildDependencyIndex, unitDependsOn } from "./mission-plan-unit-dependencies.js";

/** The caller resolves tools in the owning company. Unit prose never grants roles. */
export type PlanningArtifactTool = { name: string; adapterConfig: Record<string, unknown>; enabled?: boolean };
export function selectedUnitToolNames(unit: { toolName?: unknown; toolNames?: unknown; tools?: unknown }): string[] {
  return [...new Set([unit.toolName, ...(Array.isArray(unit.toolNames) ? unit.toolNames : []),
    ...(Array.isArray(unit.tools) ? unit.tools : [])].filter((name): name is string => typeof name === "string" && !!name.trim()).map(name => name.trim()))];
}
export function selectedArtifactContracts(unit: { toolName?: unknown; toolNames?: unknown; tools?: unknown }, tools: readonly PlanningArtifactTool[]): ArtifactContract[] {
  const names = selectedUnitToolNames(unit);
  return tools.flatMap(tool => {
    if (tool.enabled === false || !names.includes(tool.name)) return [];
    const parsed = artifactContractSchema.safeParse(tool.adapterConfig.artifactContract);
    return parsed.success ? [parsed.data] : [];
  });
}
export function hasPlanArtifactRole(unit: { toolName?: unknown; toolNames?: unknown; tools?: unknown }, tools: readonly PlanningArtifactTool[], role: ArtifactContract["role"]): boolean {
  return selectedArtifactContracts(unit, tools).some(contract => contract.role === role);
}
export async function listCompanyPlanningArtifactTools(db: Db, companyId: string): Promise<PlanningArtifactTool[]> {
  return db.select({ name: toolDefinitions.name, adapterConfig: toolDefinitions.adapterConfig })
    .from(toolDefinitions).where(and(eq(toolDefinitions.companyId, companyId), eq(toolDefinitions.enabled, true)));
}
export function consumesPublicationResult(unit: { toolArgs?: unknown; toolName?: unknown; toolNames?: unknown; tools?: unknown }, publisher: { id?: unknown }, tools: readonly PlanningArtifactTool[]): boolean {
  if (typeof publisher.id !== "string" || !publisher.id.trim() || !unit.toolArgs || typeof unit.toolArgs !== "object" || Array.isArray(unit.toolArgs)) return false;
  const args = unit.toolArgs as Record<string, unknown>;
  const reference = `{$steps.${publisher.id.trim()}.workProductPath}`;
  return selectedArtifactContracts(unit, tools).some(contract => contract.role === "publication-verify"
    && !!contract.consumerParams?.receipt && args[contract.consumerParams.receipt] === reference);
}
export function reviewPublicationVerificationTopology(units: ReadonlyArray<Record<string, unknown>>, tools: readonly PlanningArtifactTool[] = []):
  Array<{ code: "missing_publication_verify_tool"; severity: "invalid"; message: string }> {
  const dependencies = buildDependencyIndex(units);
  const valid = units.every((publisher, publisherIndex) => !hasPlanArtifactRole(publisher, tools, "publication")
    || units.some((consumer, consumerIndex) => unitDependsOn(dependencies, consumerIndex, publisherIndex)
      && consumesPublicationResult(consumer, publisher, tools)));
  return valid ? [] : [{ code: "missing_publication_verify_tool", severity: "invalid",
    message: "Each publication unit requires a downstream publication-verify tool whose declared artifactContract.consumerParams.receipt argument binds {$steps.<publication-unit-id>.workProductPath}. Use the registered result, not a guessed destination." }];
}
