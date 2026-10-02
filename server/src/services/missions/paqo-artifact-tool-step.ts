import { qaConfigSchema } from "@paperclipai/shared";
import { normalizeWorkflowQaType } from "../workflow/workflow-qa-type.js";
import { selectedArtifactContracts, selectedUnitToolNames, type PlanningArtifactTool } from "./mission-plan-publication-contract.js";

/** Only company-resolved, validated tool declarations can select engine dispatch. */
export function paqoArtifactToolStep(unit: Record<string, unknown>, tools: readonly PlanningArtifactTool[] = []) {
  const toolNames = selectedUnitToolNames(unit).filter(toolName =>
    selectedArtifactContracts({ toolName }, tools).length > 0);
  if (toolNames.length === 0) return null;
  if (toolNames.length !== 1) {
    throw new Error(`paqo_artifact_tool_ambiguous: unit ${String(unit.id)} selects ${toolNames.join(", ")}; split into single-tool units`);
  }
  const [contract] = selectedArtifactContracts({ toolNames }, tools);
  // QA checks dependency artifacts; verification reads back the published result.
  // Structural/custom QA is explicit, never inferred from tool names or prose.
  const qaType = normalizeWorkflowQaType(unit.qaType)
    ?? (contract.role === "qa" ? "action" : contract.role === "publication-verify" ? "delivery" : undefined);
  return {
    type: "tool" as const, agentId: "", toolNames, graphWorkProductRequired: false,
    ...(qaType ? { qaType } : {}),
    ...(unit.qaConfig !== undefined ? { qaConfig: qaConfigSchema.parse(unit.qaConfig) } : {}),
  };
}
