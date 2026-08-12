import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { and, eq, inArray } from "drizzle-orm";
import { listWorkflowToolCatalog } from "../workflow/tool-catalog.js";
import type { WorkflowToolPlanningMetadata } from "../workflow/tool-catalog.js";

export type MissionPlanExecutionPlacementDiagnostic = {
  readonly code: string;
  readonly message: string;
};

export type MissionPlanWorkflowToolPlacement = {
  readonly name: string;
  readonly enabled: boolean;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly planningMetadata?: WorkflowToolPlanningMetadata;
  readonly unavailableReason?: string;
};

export type MissionPlanExecutionAgentSkillProfile = {
  readonly id: string;
  readonly desiredSkills: readonly string[];
};

export type MissionPlanExecutionPlacementContext = {
  readonly workflowToolsByName: ReadonlyMap<string, MissionPlanWorkflowToolPlacement>;
  readonly workflowToolGrantKeys: ReadonlySet<string>;
  readonly agentNamesById: ReadonlyMap<string, string>;
  readonly agentSkillProfilesById: ReadonlyMap<string, MissionPlanExecutionAgentSkillProfile>;
};

type UnitPlacement = {
  readonly index: number;
  readonly label: string;
  readonly assigneeAgentId: string;
  readonly toolNames: readonly string[];
};

const MISSION_PLAN_UNIT_SOURCE_TYPES = new Set(["mission_plan_unit", "mission_plan_step"]);
const WORKFLOW_TOOL_PLACEMENT_EXEMPTIONS = new Set(["delegate_to_company"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value));
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(readString).filter((entry) => entry.length > 0);
}

function readToolNames(unit: Record<string, unknown>): string[] {
  return Array.from(new Set([
    ...readStringArray(unit.toolNames),
    ...readStringArray(unit.tools),
    readString(unit.toolName),
  ].filter((toolName) => toolName.length > 0 && !WORKFLOW_TOOL_PLACEMENT_EXEMPTIONS.has(toolName))));
}

function readUnitLabel(unit: Record<string, unknown>, index: number): string {
  return readString(unit.title) || readString(unit.name) || readString(unit.id) || `selectedExecutionUnits[${index}]`;
}

function readAssigneeAgentId(unit: Record<string, unknown>): string {
  return readString(unit.assigneeAgentId) || readString(unit.agentId);
}

function readPaperclipDesiredSkills(adapterConfig: unknown): string[] {
  const config = asRecord(adapterConfig);
  const skillSync = asRecord(config?.paperclipSkillSync);
  return Array.from(new Set(readStringArray(skillSync?.desiredSkills)));
}

function readSkillRefs(unit: Record<string, unknown>): string[] {
  return Array.from(new Set([
    ...readStringArray(unit.skillRefs),
    ...readStringArray(unit.skillKeys),
    ...readStringArray(unit.skills),
  ]));
}

function readDependencyIds(unit: Record<string, unknown>): string[] {
  return readStringArray(unit.dependsOn);
}

function unitArtifactKinds(unit: Record<string, unknown>): string[] {
  const text = [
    unit.title,
    unit.reason,
    unit.expectedOutput,
    ...(Array.isArray(unit.acceptanceCriteria) ? unit.acceptanceCriteria : []),
    ...(Array.isArray(unit.evidenceRequired) ? unit.evidenceRequired : []),
  ]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  const kinds = new Set<string>();
  if (/\bhtml\b|\.html\b|web page|웹 페이지|렌더링|render(?:ing)?/iu.test(text)) kinds.add("html");
  if (/\bmarkdown\b|\.md\b|markdown report|마크다운/iu.test(text)) kinds.add("markdown");
  return Array.from(kinds);
}

function readAcceptedInputKinds(tool: MissionPlanWorkflowToolPlacement): string[] {
  return (tool.planningMetadata?.acceptedInputKinds ?? [])
    .map((kind) => kind.trim().toLowerCase())
    .filter(Boolean);
}

function reviewToolInputKindCompatibility(
  unit: Record<string, unknown>,
  tool: MissionPlanWorkflowToolPlacement,
  selectedUnitsById: ReadonlyMap<string, Record<string, unknown>>,
): MissionPlanExecutionPlacementDiagnostic | null {
  const acceptedInputKinds = readAcceptedInputKinds(tool);
  if (acceptedInputKinds.length === 0) return null;

  const dependencyUnits = readDependencyIds(unit)
    .map((dependencyId) => selectedUnitsById.get(dependencyId))
    .filter((dependency): dependency is Record<string, unknown> => Boolean(dependency));
  const sourceUnits = dependencyUnits.length > 0 ? dependencyUnits : [unit];
  const producedKinds = Array.from(new Set(sourceUnits.flatMap(unitArtifactKinds)));
  const incompatibleKinds = producedKinds.filter((kind) => !acceptedInputKinds.includes(kind));
  if (incompatibleKinds.length === 0) return null;

  return {
    code: "workflow_tool_input_kind_mismatch",
    message: `Execution unit "${readUnitLabel(unit, 0)}" assigns workflow tool "${tool.name}" which accepts [${acceptedInputKinds.join(", ")}] input, but its dependency output is classified as [${incompatibleKinds.join(", ")}]. Review the tool description/input schema and assign a compatible tool or change the producer contract.`,
  };
}

function normalizeSkillKey(value: string): string {
  const parts = value.trim().toLowerCase().split("/").filter(Boolean);
  const leaf = parts[parts.length - 1] ?? value;
  return leaf.replace(/[^a-z0-9가-힣]+/giu, "");
}

function hasSkillRef(profile: MissionPlanExecutionAgentSkillProfile, skillRef: string): boolean {
  const wanted = normalizeSkillKey(skillRef);
  if (!wanted) return true;
  return profile.desiredSkills.some((desiredSkill) => normalizeSkillKey(desiredSkill) === wanted);
}

function collectToolPlacements(
  selectedExecutionUnits: readonly Record<string, unknown>[],
): UnitPlacement[] {
  const placements: UnitPlacement[] = [];
  selectedExecutionUnits.forEach((unit, index) => {
    const sourceRef = asRecord(unit.sourceRef);
    const sourceType = readString(sourceRef?.type);
    if (!MISSION_PLAN_UNIT_SOURCE_TYPES.has(sourceType)) return;

    const toolNames = readToolNames(unit);
    if (toolNames.length === 0) return;

    placements.push({
      index,
      label: readUnitLabel(unit, index),
      assigneeAgentId: readAssigneeAgentId(unit),
      toolNames,
    });
  });
  return placements;
}

function collectSkillBearingUnits(
  selectedExecutionUnits: readonly Record<string, unknown>[],
): Array<{ readonly unit: Record<string, unknown>; readonly index: number; readonly assigneeAgentId: string; readonly skillRefs: readonly string[] }> {
  return selectedExecutionUnits
    .map((unit, index) => ({ unit, index, assigneeAgentId: readAssigneeAgentId(unit), skillRefs: readSkillRefs(unit) }))
    .filter((entry) => entry.assigneeAgentId.length > 0 && entry.skillRefs.length > 0);
}

function workflowToolEntries(
  tools: ReadonlyArray<{
    readonly name: string;
    readonly enabled: boolean;
    readonly description?: string;
    readonly inputSchema?: Record<string, unknown>;
    readonly planningMetadata?: WorkflowToolPlanningMetadata;
    readonly unavailableReason?: string;
  }>,
): Array<readonly [string, MissionPlanWorkflowToolPlacement]> {
  const entries: Array<readonly [string, MissionPlanWorkflowToolPlacement]> = [];
  for (const tool of tools) {
    const name = tool.name.trim();
    if (!name) continue;
    entries.push([
      name,
      {
        name,
        enabled: tool.enabled,
        ...(tool.description ? { description: tool.description } : {}),
        ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
        ...(tool.planningMetadata ? { planningMetadata: tool.planningMetadata } : {}),
        ...(tool.unavailableReason ? { unavailableReason: tool.unavailableReason } : {}),
      },
    ]);
  }
  return entries;
}

function agentNameEntries(
  rows: ReadonlyArray<{ readonly id: string; readonly name: string }>,
): Array<readonly [string, string]> {
  const entries: Array<readonly [string, string]> = [];
  for (const row of rows) {
    const name = row.name.trim();
    if (name) entries.push([row.id, name]);
  }
  return entries;
}

export function reviewMissionPlanExecutionPlacementWithContext(input: {
  readonly selectedExecutionUnits: readonly Record<string, unknown>[];
  readonly context: MissionPlanExecutionPlacementContext;
}): MissionPlanExecutionPlacementDiagnostic[] {
  const diagnostics: MissionPlanExecutionPlacementDiagnostic[] = [];
  const placements = collectToolPlacements(input.selectedExecutionUnits);
  const selectedUnitsById = new Map(
    input.selectedExecutionUnits
      .map((unit) => [readString(unit.id), unit] as const)
      .filter(([id]) => id.length > 0),
  );

  for (const placement of placements) {
    if (!placement.assigneeAgentId) {
      diagnostics.push({
        code: "workflow_tool_unit_missing_assignee",
        message: `Execution unit "${placement.label}" selects workflow tools but has no assigneeAgentId. Assign the unit to the agent that will run those tools.`,
      });
      continue;
    }
    const agentName = input.context.agentNamesById.get(placement.assigneeAgentId);
    if (!agentName) {
      diagnostics.push({
        code: "workflow_tool_assignee_unknown",
        message: `Execution unit "${placement.label}" selects workflow tools for unknown agent ${placement.assigneeAgentId}. Assign it to an active company agent.`,
      });
      continue;
    }
    for (const toolName of placement.toolNames) {
      const tool = input.context.workflowToolsByName.get(toolName);
      if (!tool) {
        diagnostics.push({
          code: "workflow_tool_unavailable",
          message: `Execution unit "${placement.label}" selects unknown workflow tool "${toolName}". Use an enabled workflow tool from the planning dossier catalog.`,
        });
        continue;
      }
      if (!tool.enabled) {
        diagnostics.push({
          code: "workflow_tool_disabled",
          message: `Execution unit "${placement.label}" uses disabled workflow tool "${toolName}". ${tool.unavailableReason ?? "Enable it or remove the tool from this unit."}`,
        });
        continue;
      }
      if (!input.context.workflowToolGrantKeys.has(`${placement.assigneeAgentId}:${tool.name}`)) {
        diagnostics.push({
          code: "workflow_tool_not_granted_to_assignee",
          message: `Execution unit "${placement.label}" assigns workflow tool "${toolName}" to agent ${agentName}, but that agent does not have the tool grant. Grant the tool to that unit's assignee or reassign the unit.`,
        });
      }
      const compatibilityDiagnostic = reviewToolInputKindCompatibility(
        input.selectedExecutionUnits[placement.index] ?? {},
        tool,
        selectedUnitsById,
      );
      if (compatibilityDiagnostic) diagnostics.push(compatibilityDiagnostic);
    }
  }

  const skillBearingUnits = collectSkillBearingUnits(input.selectedExecutionUnits);
  for (const entry of skillBearingUnits) {
    const profile = input.context.agentSkillProfilesById.get(entry.assigneeAgentId);
    if (!profile || profile.desiredSkills.length === 0) continue;
    for (const skillRef of entry.skillRefs) {
      if (hasSkillRef(profile, skillRef)) continue;
      diagnostics.push({
        code: "skill_ref_not_assigned_to_assignee",
        message: `Execution unit "${readUnitLabel(entry.unit, entry.index)}" lists skillRef "${skillRef}" for agent ${entry.assigneeAgentId}, but that agent's desired skills do not include it.`,
      });
    }
  }

  return diagnostics;
}

export async function reviewMissionPlanExecutionPlacement(input: {
  readonly db: Db;
  readonly companyId: string;
  readonly selectedExecutionUnits: readonly Record<string, unknown>[];
}): Promise<MissionPlanExecutionPlacementDiagnostic[]> {
  const placements = collectToolPlacements(input.selectedExecutionUnits);
  const requestedToolNames = Array.from(new Set(placements.flatMap((placement) => placement.toolNames)));

  const skillBearingUnits = collectSkillBearingUnits(input.selectedExecutionUnits);
  const agentIds = Array.from(new Set([
    ...placements.map((placement) => placement.assigneeAgentId).filter((agentId) => agentId.length > 0),
    ...skillBearingUnits.map((entry) => entry.assigneeAgentId),
  ]));
  const [catalog, agentRows] = await Promise.all([
    requestedToolNames.length === 0 ? Promise.resolve({ tools: [], grants: [] }) : listWorkflowToolCatalog(input.db, input.companyId),
    agentIds.length === 0
      ? Promise.resolve([])
      : input.db
      .select({ id: agents.id, name: agents.name, adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(and(eq(agents.companyId, input.companyId), inArray(agents.id, agentIds))),
  ]);

  return reviewMissionPlanExecutionPlacementWithContext({
    selectedExecutionUnits: input.selectedExecutionUnits,
    context: {
      workflowToolsByName: new Map(workflowToolEntries(catalog.tools)),
      workflowToolGrantKeys: new Set(catalog.grants
        .filter((grant) => typeof grant.agentId === "string" && grant.agentId.trim().length > 0)
        .map((grant) => `${grant.agentId!.trim()}:${grant.toolName.trim()}`)),
      agentNamesById: new Map(agentNameEntries(agentRows)),
      agentSkillProfilesById: new Map(agentRows.map((agent) => [
        agent.id,
        { id: agent.id, desiredSkills: readPaperclipDesiredSkills(agent.adapterConfig) },
      ])),
    },
  });
}
