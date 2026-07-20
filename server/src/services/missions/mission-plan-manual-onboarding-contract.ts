import { buildDependencyIndex, unitDependsOn } from "./mission-plan-unit-dependencies.js";

function unitToolNames(unit: Record<string, unknown>): string[] {
  const values = [unit.toolName, ...(Array.isArray(unit.toolNames) ? unit.toolNames : [])];
  return values.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function consumesPublishResult(unit: Record<string, unknown>, publishUnit: Record<string, unknown>): boolean {
  const publishId = typeof publishUnit.id === "string" ? publishUnit.id.trim() : "";
  if (!publishId || !unit.toolArgs || typeof unit.toolArgs !== "object" || Array.isArray(unit.toolArgs)) return false;
  const args = unit.toolArgs as Record<string, unknown>;
  const value = args.publishResultPath ?? args["publish-result-path"];
  return value === `{$steps.${publishId}.workProductPath}`;
}

export function reviewManualOnboardingVerificationTopology(
  units: ReadonlyArray<Record<string, unknown>>,
): Array<{ code: "missing_manual_onboarding_verify_tool"; severity: "invalid"; message: string }> {
  const dependencyIndex = buildDependencyIndex(units);
  const publishIndexes = units
    .map((unit, index) => ({ index, tools: unitToolNames(unit) }))
    .filter(({ tools }) => tools.includes("manual-onboarding-publish"))
    .map(({ index }) => index);
  const verifyIndexes = units
    .map((unit, index) => ({ index, tools: unitToolNames(unit) }))
    .filter(({ tools }) => tools.includes("manual-onboarding-verify"))
    .map(({ index }) => index);
  const valid = publishIndexes.every((publishIndex) => verifyIndexes.some((verifyIndex) =>
    unitDependsOn(dependencyIndex, verifyIndex, publishIndex)
    && consumesPublishResult(units[verifyIndex]!, units[publishIndex]!)));
  return valid ? [] : [{
    code: "missing_manual_onboarding_verify_tool",
    severity: "invalid",
    message: "manual-onboarding-publish requires a downstream manual-onboarding-verify unit whose toolArgs.publishResultPath is {$steps.<publish-unit-id>.workProductPath}. Verification must consume the registered publish result URL; never use direct curl or a guessed R2 URL.",
  }];
}
