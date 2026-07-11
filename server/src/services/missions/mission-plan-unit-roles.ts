import { classifyWorkflowStepRole } from "../workflow-step-role.js";
import { hasDeliveryActionRole } from "./mission-plan-artifact-contract.js";
import { buildDependencyIndex, unitDependsOn } from "./mission-plan-unit-dependencies.js";
import { missionPlanUnitText } from "./mission-plan-unit-text.js";

export type PlanQaUnitRole = {
  readonly publish: boolean;
  readonly readbackQa: boolean;
  readonly audienceSplit: boolean;
  readonly scenario: boolean;
};

type MutablePlanQaUnitRole = {
  -readonly [Key in keyof PlanQaUnitRole]: PlanQaUnitRole[Key];
};

const UNIT_ROLE_SIGNALS: ReadonlyArray<readonly [regexp: RegExp, role: keyof PlanQaUnitRole]> = [
  [/^\s*\[qa\]/iu, "readbackQa"],
  [/\bread[-\s]?back\b|\bverif(y|ied|ication)\b|\bvalid(?:ation|ate|ated)?\b|\bqa\b|\bcheck(?:ed|ing)?\b|검증|리뷰|확인\s*리포트|회독/u, "readbackQa"],
  [/\baudience[s]?\b|대상별|분기|각각|경우에?\s*따라|타겟별|타깃별/u, "audienceSplit"],
  [/\bAI\b|디자이너|개발자|비개발자|초보자|기획자|마케터/u, "audienceSplit"],
  [/\bscenario[s]?\b|\bcases?\b|상황별|케이스별|여러\s*가지\s*상황|다양한\s*상황|경우의?\s*수/u, "scenario"],
];

export function extractUnitRoles(unit: Record<string, unknown>): PlanQaUnitRole {
  const text = missionPlanUnitText(unit);
  const stepRole = classifyWorkflowStepRole(unit);
  const role: MutablePlanQaUnitRole = { publish: hasDeliveryActionRole(unit), readbackQa: false, audienceSplit: false, scenario: false };
  for (const [regexp, key] of UNIT_ROLE_SIGNALS) {
    if (key === "readbackQa" && stepRole !== "qa") continue;
    if (regexp.test(text)) role[key] = true;
  }
  return role;
}

export function hasPostDeliveryReadbackQa(units: ReadonlyArray<Record<string, unknown>>): boolean {
  const deliveryIndexes = units
    .map((unit, index) => ({ unit, index }))
    .filter(({ unit }) => hasDeliveryActionRole(unit))
    .map(({ index }) => index);
  const qaIndexes = units
    .map((unit, index) => ({ unit, index }))
    .filter(({ unit }) => extractUnitRoles(unit).readbackQa)
    .map(({ index }) => index);
  const dependencyIndex = buildDependencyIndex(units);
  return deliveryIndexes.length > 0 && deliveryIndexes.every((deliveryIndex) =>
    qaIndexes.some((qaIndex) => unitDependsOn(dependencyIndex, qaIndex, deliveryIndex)));
}
