import { isQaLikeStep } from "../workflow-step-role.js";
import type { MissionExecutionCandidate } from "./mission-execution-candidates.js";

const DEDICATED_QA_ROLES = new Set(["qa", "reviewer", "validator"]);
const CROSS_COMPANY_SOURCE_TYPES = new Set([
  "cross_company_mission",
  "cross_company_mission_request",
  "company_mission",
  "external_company_mission",
]);

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(readString).filter(Boolean);
}

function readUnitToolNames(unit: Record<string, unknown>): string[] {
  return Array.from(new Set([
    ...readStringArray(unit.toolNames),
    ...readStringArray(unit.tools),
    readString(unit.toolName),
  ].filter(Boolean)));
}

function readUnitSkillRefs(unit: Record<string, unknown>): string[] {
  return Array.from(new Set([
    ...readStringArray(unit.skillRefs),
    ...readStringArray(unit.skillKeys),
    ...readStringArray(unit.skills),
  ]));
}

function normalizeSkillKey(value: string): string {
  const parts = value.trim().toLowerCase().split("/").filter(Boolean);
  return (parts[parts.length - 1] ?? value).replace(/[^a-z0-9가-힣]+/giu, "");
}

function isAgentQaUnit(unit: Record<string, unknown>): boolean {
  const type = readString(unit.type).toLowerCase();
  const qaType = readString(unit.qaType).toLowerCase();
  const sourceRef = unit.sourceRef && typeof unit.sourceRef === "object" && !Array.isArray(unit.sourceRef)
    ? unit.sourceRef as Record<string, unknown>
    : {};
  const sourceType = readString(sourceRef.type).toLowerCase();
  const sourceKind = readString(sourceRef.kind).toLowerCase();
  if (CROSS_COMPANY_SOURCE_TYPES.has(sourceType) || CROSS_COMPANY_SOURCE_TYPES.has(sourceKind)) return false;
  return type !== "tool" && qaType !== "structural" && isQaLikeStep(unit);
}

function candidateSupportsTools(candidate: MissionExecutionCandidate, unit: Record<string, unknown>): boolean {
  const granted = new Set(candidate.toolNames);
  return readUnitToolNames(unit).every((toolName) => granted.has(toolName));
}

function matchingSkillRefs(candidate: MissionExecutionCandidate, unit: Record<string, unknown>): string[] {
  const desired = new Set(candidate.desiredSkillKeys.map(normalizeSkillKey));
  return readUnitSkillRefs(unit).filter((skillRef) => desired.has(normalizeSkillKey(skillRef)));
}

function candidateSupportsSkills(candidate: MissionExecutionCandidate, unit: Record<string, unknown>): boolean {
  return matchingSkillRefs(candidate, unit).length === readUnitSkillRefs(unit).length;
}

function candidateRank(candidate: MissionExecutionCandidate): number {
  const role = candidate.role.trim().toLowerCase();
  return DEDICATED_QA_ROLES.has(role) ? 0 : role === "researcher" ? 1 : 2;
}

export type QaAssigneeReplacement = {
  readonly unitId: string;
  readonly fromAgentId: string;
  readonly toAgentId: string;
};

export function reselectUnavailableQaAssignees(input: {
  readonly selectedExecutionUnits: readonly Record<string, unknown>[];
  readonly runnableCandidates: readonly MissionExecutionCandidate[];
  readonly excludedAgentIds?: readonly string[];
}): { units: Record<string, unknown>[]; replacements: QaAssigneeReplacement[] } {
  const candidatesById = new Map(input.runnableCandidates.map((candidate) => [candidate.agentId, candidate]));
  const nonQaAssigneeIds = new Set([
    ...(input.excludedAgentIds ?? []),
    ...input.selectedExecutionUnits
    .filter((unit) => !isAgentQaUnit(unit))
    .map((unit) => readString(unit.assigneeAgentId) || readString(unit.agentId))
    .filter(Boolean),
  ]);
  const replacements: QaAssigneeReplacement[] = [];

  const units = input.selectedExecutionUnits.map((unit) => {
    if (!isAgentQaUnit(unit)) return { ...unit };
    const currentAgentId = readString(unit.assigneeAgentId) || readString(unit.agentId);
    const currentCandidate = candidatesById.get(currentAgentId);
    if (
      !currentAgentId
      || (currentCandidate
        && !nonQaAssigneeIds.has(currentAgentId)
        && candidateSupportsTools(currentCandidate, unit)
        && candidateSupportsSkills(currentCandidate, unit))
    ) return { ...unit };

    const replacement = input.runnableCandidates
      .filter((candidate) => !nonQaAssigneeIds.has(candidate.agentId))
      .filter((candidate) => candidateSupportsTools(candidate, unit))
      .filter((candidate) => candidateSupportsSkills(candidate, unit))
      .map((candidate, index) => ({ candidate, index, rank: candidateRank(candidate) }))
      .sort((left, right) => left.rank - right.rank || left.index - right.index)[0]?.candidate;
    if (!replacement) return { ...unit };

    replacements.push({
      unitId: readString(unit.id) || readString(unit.title) || "qa-unit",
      fromAgentId: currentAgentId,
      toAgentId: replacement.agentId,
    });
    return {
      ...unit,
      assigneeAgentId: replacement.agentId,
      ...(Object.prototype.hasOwnProperty.call(unit, "agentId") ? { agentId: replacement.agentId } : {}),
    };
  });

  return { units, replacements };
}

export function selectedPlanQaReviewerAgentId(input: {
  readonly selectedExecutionUnits: readonly Record<string, unknown>[];
  readonly runnableCandidates: readonly MissionExecutionCandidate[];
  readonly excludedAgentIds?: readonly string[];
}): string | null | undefined {
  const candidatesById = new Map(input.runnableCandidates.map((candidate) => [candidate.agentId, candidate]));
  const excludedAgentIds = new Set([
    ...(input.excludedAgentIds ?? []),
    ...input.selectedExecutionUnits
      .filter((unit) => !isAgentQaUnit(unit))
      .map((unit) => readString(unit.assigneeAgentId) || readString(unit.agentId))
      .filter(Boolean),
  ]);
  let hasQaUnit = false;
  for (const unit of input.selectedExecutionUnits) {
    if (!isAgentQaUnit(unit)) continue;
    hasQaUnit = true;
    const assigneeAgentId = readString(unit.assigneeAgentId) || readString(unit.agentId);
    const candidate = candidatesById.get(assigneeAgentId);
    if (
      candidate
      && !excludedAgentIds.has(assigneeAgentId)
      && candidateSupportsTools(candidate, unit)
      && candidateSupportsSkills(candidate, unit)
    ) return assigneeAgentId;
  }
  return hasQaUnit ? null : undefined;
}
