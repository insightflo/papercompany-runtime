import type { MissionPlanDependencyDiagnostic } from "./mission-plan-dependency-graph.js";

/** Agent PLAN authority never includes board-owned workflow policy, even on metadata units.
 * Reject presence (including null/invalid values), rather than silently discarding intent.
 */
export function readPlanPolicyDiagnostics(
  units: readonly Record<string, unknown>[],
  steps: readonly (string | Record<string, unknown>)[],
): MissionPlanDependencyDiagnostic[] {
  return [
    ...units.map((value, index) => ({ value, path: `selectedExecutionUnits[${index}]` })),
    ...steps.map((value, index) => ({ value, path: `steps[${index}]` })),
  ].flatMap(({ value, path }) => {
    if (typeof value === "string") return [];
    return ["deliveryVerification", "capAcceptance"].flatMap((field) =>
      Object.prototype.hasOwnProperty.call(value, field) ? [{
        code: "board_only_plan_policy" as const,
        message: `${path}.${field} is board-only and cannot be set by a mission plan. Remove it from the plan and configure it through the board workflow API.`,
      }] : []);
  });
}
