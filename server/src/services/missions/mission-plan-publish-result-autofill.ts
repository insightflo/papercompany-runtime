import { buildDependencyIndex, unitDependsOn } from "./mission-plan-unit-dependencies.js";

const PUBLISH_TOOL = "manual-onboarding-publish";
const VERIFY_TOOL = "manual-onboarding-verify";
const CAMEL_CASE_FIELD = "publishResultPath";
const DASHED_FIELD = "publish-result-path";
const CANONICAL_REFERENCE_PREFIX = "{$steps.";
const CANONICAL_REFERENCE_SUFFIX = ".workProductPath}";

export type PublishResultAutofillResult = {
  units: Array<Record<string, unknown>>;
  applied: null | {
    publisherUnitId: string;
    verifierUnitId: string;
    field: "publishResultPath";
  };
};

type UnitIndex = { index: number; unit: Record<string, unknown> };

function unitToolNames(unit: Record<string, unknown>): string[] {
  const values = [unit.toolName, ...(Array.isArray(unit.toolNames) ? unit.toolNames : [])];
  return values.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function readId(unit: Record<string, unknown>): string {
  return typeof unit.id === "string" ? unit.id.trim() : "";
}

function toolArgsObject(unit: Record<string, unknown>): Record<string, unknown> | null {
  const args = unit.toolArgs;
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  return args as Record<string, unknown>;
}

function canonicalReference(publisherId: string): string {
  return `${CANONICAL_REFERENCE_PREFIX}${publisherId}${CANONICAL_REFERENCE_SUFFIX}`;
}

function findUnitsWithTool(units: ReadonlyArray<Record<string, unknown>>, tool: string): UnitIndex[] {
  return units
    .map((unit, index) => ({ index, unit, tools: unitToolNames(unit) }))
    .filter(({ tools }) => tools.includes(tool));
}

function verifierDependsOnPublisher(
  dependencyIndex: number[][],
  verifierIndex: number,
  publisherIndex: number,
): boolean {
  return unitDependsOn(dependencyIndex, verifierIndex, publisherIndex);
}

/**
 * Apply one bounded, immutable normalization: when exactly one
 * `manual-onboarding-publish` unit and one `manual-onboarding-verify` unit
 * exist, the verifier depends on the publisher (directly or transitively), and neither the
 * camelCase nor dashed field is already present on the verifier's toolArgs,
 * add `publishResultPath: "{$steps.<publish-unit-id>.workProductPath}"`.
 *
 * Never repairs a conflicting value, never rewrites the dependency graph,
 * and returns copied unit objects in every path.
 */
export function autofillManualOnboardingPublishResult(
  units: ReadonlyArray<Record<string, unknown>>,
): PublishResultAutofillResult {
  const copied = units.map((unit) => ({ ...unit }));

  const publishers = findUnitsWithTool(copied, PUBLISH_TOOL);
  const verifiers = findUnitsWithTool(copied, VERIFY_TOOL);
  if (publishers.length !== 1 || verifiers.length !== 1) {
    return { units: copied, applied: null };
  }

  const publisher = publishers[0]!;
  const verifier = verifiers[0]!;
  const publisherId = readId(publisher.unit);
  const verifierId = readId(verifier.unit);
  if (!publisherId || !verifierId || publisher.index === verifier.index) {
    return { units: copied, applied: null };
  }

  const dependencyIndex = buildDependencyIndex(copied);
  if (!verifierDependsOnPublisher(dependencyIndex, verifier.index, publisher.index)) {
    return { units: copied, applied: null };
  }

  const args = toolArgsObject(verifier.unit);
  if (!args) {
    return { units: copied, applied: null };
  }

  if (Object.prototype.hasOwnProperty.call(args, CAMEL_CASE_FIELD)
      || Object.prototype.hasOwnProperty.call(args, DASHED_FIELD)) {
    return { units: copied, applied: null };
  }

  const nextArgs = { ...args, [CAMEL_CASE_FIELD]: canonicalReference(publisherId) };
  const nextVerifier: Record<string, unknown> = {
    ...verifier.unit,
    toolArgs: nextArgs,
  };
  const nextUnits = copied.map((unit, index) => (index === verifier.index ? nextVerifier : unit));

  return {
    units: nextUnits,
    applied: {
      publisherUnitId: publisherId,
      verifierUnitId: verifierId,
      field: CAMEL_CASE_FIELD,
    },
  };
}
