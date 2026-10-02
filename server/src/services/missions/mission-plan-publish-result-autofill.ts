import { buildDependencyIndex, unitDependsOn } from "./mission-plan-unit-dependencies.js";
import { selectedArtifactContracts, hasPlanArtifactRole, type PlanningArtifactTool } from "./mission-plan-publication-contract.js";

export type PublishResultAutofillResult = {
  units: Array<Record<string, unknown>>;
  applied: null | { publisherUnitId: string; verifierUnitId: string; field: string };
};
/** One unambiguous pair, declared receipt parameter, missing value only; never rewrite dependencies. */
export function autofillPublicationResult(units: ReadonlyArray<Record<string, unknown>>, tools: readonly PlanningArtifactTool[] = []): PublishResultAutofillResult {
  const copied = units.map(unit => ({ ...unit }));
  const publishers = copied.map((unit, index) => ({ unit, index })).filter(({ unit }) => hasPlanArtifactRole(unit, tools, "publication"));
  const verifiers = copied.map((unit, index) => ({ unit, index })).filter(({ unit }) => hasPlanArtifactRole(unit, tools, "publication-verify"));
  const unchanged = { units: copied, applied: null };
  if (publishers.length !== 1 || verifiers.length !== 1) return unchanged;
  const publisher = publishers[0]!, verifier = verifiers[0]!;
  const publisherId = typeof publisher.unit.id === "string" ? publisher.unit.id.trim() : "";
  const verifierId = typeof verifier.unit.id === "string" ? verifier.unit.id.trim() : "";
  if (!publisherId || !verifierId || publisher.index === verifier.index || copied.filter(unit => unit.id === publisherId).length !== 1
    || copied.filter(unit => unit.id === verifierId).length !== 1) return unchanged;
  if (!unitDependsOn(buildDependencyIndex(copied), verifier.index, publisher.index)) return unchanged;
  const contracts = selectedArtifactContracts(verifier.unit, tools).filter(contract => contract.role === "publication-verify");
  if (contracts.length !== 1 || !contracts[0]?.consumerParams?.receipt) return unchanged;
  const field = contracts[0].consumerParams.receipt;
  const args = verifier.unit.toolArgs;
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.hasOwn(args, field)) return unchanged;
  copied[verifier.index] = { ...verifier.unit, toolArgs: { ...args, [field]: `{$steps.${publisherId}.workProductPath}` } };
  return { units: copied, applied: { publisherUnitId: publisherId, verifierUnitId: verifierId, field } };
}
