import { hasPlanArtifactRole, type PlanningArtifactTool } from "./mission-plan-publication-contract.js";

export type MissionIntentCategory = "publish" | "audience" | "scenario";
export interface MissionIntentSignal { category: MissionIntentCategory; token: string }
export interface MissionIntent {
  publish: boolean;
  audienceSplit: boolean;
  scenario: boolean;
  audiences: string[];
  beneficiary: string[];
  matchedSignals: MissionIntentSignal[];
}
export type StructuredMissionIntent = {
  selectedExecutionUnits?: ReadonlyArray<Record<string, unknown>>;
  tools?: readonly PlanningArtifactTool[];
  audiences?: string[];
  scenarios?: string[];
};
/** Legacy prose arguments are accepted but inert. Only structured selections carry authority. */
export function extractMissionIntent(input: StructuredMissionIntent | string, _description?: string | null): MissionIntent {
  const plan = typeof input === "object" ? input : {};
  const audiences = [...new Set((plan.audiences ?? []).filter(value => typeof value === "string" && !!value.trim()))];
  const scenarios = (plan.scenarios ?? []).filter(value => typeof value === "string" && !!value.trim());
  const publish = (plan.selectedExecutionUnits ?? []).some(unit => hasPlanArtifactRole(unit, plan.tools ?? [], "publication"));
  return {
    publish, audienceSplit: audiences.length > 1, scenario: scenarios.length > 0, audiences, beneficiary: [],
    matchedSignals: [
      ...(publish ? [{ category: "publish" as const, token: "publication" }] : []),
      ...audiences.map(token => ({ category: "audience" as const, token })),
      ...scenarios.map(token => ({ category: "scenario" as const, token })),
    ],
  };
}
export function intentSignalsByCategory(intent: MissionIntent, category: MissionIntentCategory): string[] {
  return [...new Set(intent.matchedSignals.filter(signal => signal.category === category).map(signal => signal.token))];
}
