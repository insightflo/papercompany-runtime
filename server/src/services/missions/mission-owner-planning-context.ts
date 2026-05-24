import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentKbGrants,
  agents,
  issues,
  knowledgeBases,
  missionAgents,
  missions,
  pluginEntities,
} from "@paperclipai/db";
import { notFound } from "../../errors.js";
import { missionPlanArtifactService, summarizeMissionPlanForRuntime } from "../mission-plan-artifacts.js";
import type { MissionPlanRuntimeSummary } from "../mission-plan-artifacts.js";
import { listWorkflowDefinitions } from "../workflow/workflow-store.js";
import { listMissionExecutionSourceSnapshots } from "./mission-execution-sources.js";
import type { MissionExecutionSourceSnapshot } from "./mission-execution-sources.js";
import { buildMissionRuleContext } from "./mission-rule-context.js";
import type { MissionRuleRef } from "./mission-rule-context.js";

export const MISSION_OWNER_PLANNING_SOURCE_REF_VOCABULARY = [
  "native_workflow_run",
  "native_workflow_step_run",
  "plugin_workflow_run",
  "plugin_workflow_step_run",
] as const;

export type MissionOwnerPlanningSourceRefType = typeof MISSION_OWNER_PLANNING_SOURCE_REF_VOCABULARY[number];

export type BuildMissionOwnerPlanningContextInput = {
  companyId: string;
  missionId: string;
};

export type MissionOwnerPlanningMission = {
  id: string;
  companyId: string;
  ownerAgentId: string;
  title: string;
  description: string | null;
  status: string;
  goalId: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type MissionOwnerPlanningActivePlan = Omit<MissionPlanRuntimeSummary, "refs">;

export type MissionOwnerPlanningWorkflowCandidate = {
  id: string;
  name: string;
  source: "native";
  stepCount: number;
  purposeMatched: boolean;
  matchedPurposeTokens: string[];
};

export type MissionOwnerPlanningKbRef = {
  id: string;
  name: string;
  type: string;
  source: "agent_kb_grant";
  agentId: string;
};

export type MissionOwnerPlanningAgentRosterEntry = {
  agentId: string;
  name: string | null;
  role: string;
  assignedAt: Date;
  capabilities: string | null;
};

export type MissionOwnerPlanningTodoMarker = {
  key: "kb_refs_unavailable" | "plugin_workflow_definition_reader_unconfirmed";
  reason: string;
};

export type MissionOwnerPlanningContext = {
  mission: MissionOwnerPlanningMission;
  planningIssueId: string | null;
  activePlan: MissionOwnerPlanningActivePlan;
  executionSourceSnapshot: MissionExecutionSourceSnapshot;
  ruleRefs: MissionRuleRef[];
  workflowCandidates: MissionOwnerPlanningWorkflowCandidate[];
  kbRefs: MissionOwnerPlanningKbRef[];
  agentRoster: MissionOwnerPlanningAgentRosterEntry[];
  todoMarkers: MissionOwnerPlanningTodoMarker[];
  sourceRefVocabulary: MissionOwnerPlanningSourceRefType[];
};

type PlanningIssueRow = Pick<typeof issues.$inferSelect, "id" | "title" | "description">;

const MAX_WORKFLOW_CANDIDATES = 12;
const MAX_KB_REFS = 20;
const MAX_PURPOSE_TOKENS = 10;
const PURPOSE_TOKEN_MIN_LENGTH = 3;

function stripRawRefs(summary: MissionPlanRuntimeSummary): MissionOwnerPlanningActivePlan {
  const { refs: _refs, ...safeSummary } = summary;
  return safeSummary;
}

function normalizePurposeToken(value: string): string {
  return value.trim().toLowerCase();
}

function buildPurposeTokens(...values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const value of values) {
    if (!value) continue;
    for (const rawToken of value.split(/[^\p{L}\p{N}_-]+/u)) {
      const token = normalizePurposeToken(rawToken);
      if (token.length < PURPOSE_TOKEN_MIN_LENGTH || seen.has(token)) continue;
      seen.add(token);
      tokens.push(token);
      if (tokens.length >= MAX_PURPOSE_TOKENS) return tokens;
    }
  }
  return tokens;
}

function matchedPurposeTokens(candidateName: string, purposeTokens: string[]): string[] {
  const normalizedName = normalizePurposeToken(candidateName);
  return purposeTokens.filter((token) => normalizedName.includes(token));
}

function countWorkflowSteps(steps: unknown): number {
  return Array.isArray(steps) ? steps.length : 0;
}

async function loadMission(db: Db, input: BuildMissionOwnerPlanningContextInput): Promise<MissionOwnerPlanningMission> {
  const [mission] = await db
    .select()
    .from(missions)
    .where(and(eq(missions.companyId, input.companyId), eq(missions.id, input.missionId)))
    .limit(1);

  if (!mission) throw notFound(`Mission not found: ${input.missionId}`);

  return {
    id: mission.id,
    companyId: mission.companyId,
    ownerAgentId: mission.ownerAgentId,
    title: mission.title,
    description: mission.description,
    status: mission.status,
    goalId: mission.goalId,
    startedAt: mission.startedAt,
    completedAt: mission.completedAt,
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
  };
}

async function findPlanningIssue(db: Db, input: BuildMissionOwnerPlanningContextInput): Promise<PlanningIssueRow | null> {
  const [issue] = await db
    .select({ id: issues.id, title: issues.title, description: issues.description })
    .from(issues)
    .where(and(
      eq(issues.companyId, input.companyId),
      eq(issues.missionId, input.missionId),
      eq(issues.originKind, "mission_main_executor_plan"),
    ))
    .orderBy(asc(issues.createdAt), asc(issues.id))
    .limit(1);

  return issue ?? null;
}

async function listWorkflowCandidates(
  db: Db,
  companyId: string,
  purposeTokens: string[],
): Promise<MissionOwnerPlanningWorkflowCandidate[]> {
  const definitions = await listWorkflowDefinitions(db, companyId);
  return definitions
    .map((definition) => {
      const matches = matchedPurposeTokens(definition.name, purposeTokens);
      return {
        id: definition.id,
        name: definition.name,
        source: "native" as const,
        stepCount: countWorkflowSteps(definition.steps),
        purposeMatched: matches.length > 0,
        matchedPurposeTokens: matches,
      };
    })
    .sort((left, right) => {
      if (left.purposeMatched !== right.purposeMatched) return left.purposeMatched ? -1 : 1;
      const nameDelta = left.name.localeCompare(right.name);
      if (nameDelta !== 0) return nameDelta;
      return left.id.localeCompare(right.id);
    })
    .slice(0, MAX_WORKFLOW_CANDIDATES);
}

async function hasPluginWorkflowDefinitionEntities(db: Db, companyId: string): Promise<boolean> {
  const rows = await db
    .select({ id: pluginEntities.id })
    .from(pluginEntities)
    .where(and(
      eq(pluginEntities.entityType, "workflow-definition"),
      eq(pluginEntities.scopeKind, "company"),
      eq(pluginEntities.scopeId, companyId),
    ))
    .limit(1);
  return rows.length > 0;
}

async function listAgentRoster(db: Db, missionId: string): Promise<MissionOwnerPlanningAgentRosterEntry[]> {
  const rows = await db
    .select({
      agentId: missionAgents.agentId,
      role: missionAgents.role,
      assignedAt: missionAgents.assignedAt,
      name: agents.name,
      capabilities: agents.capabilities,
    })
    .from(missionAgents)
    .leftJoin(agents, eq(missionAgents.agentId, agents.id))
    .where(eq(missionAgents.missionId, missionId))
    .orderBy(asc(missionAgents.assignedAt), asc(missionAgents.agentId));

  return rows.map((row) => ({
    agentId: row.agentId,
    name: row.name,
    role: row.role,
    assignedAt: row.assignedAt,
    capabilities: row.capabilities,
  }));
}

async function listKbRefs(
  db: Db,
  companyId: string,
  agentRoster: MissionOwnerPlanningAgentRosterEntry[],
): Promise<MissionOwnerPlanningKbRef[]> {
  const agentIds = Array.from(new Set(agentRoster.map((entry) => entry.agentId)));
  if (agentIds.length === 0) return [];

  const rows = await db
    .select({
      id: knowledgeBases.id,
      name: knowledgeBases.name,
      type: knowledgeBases.type,
      companyId: knowledgeBases.companyId,
      agentId: agentKbGrants.agentId,
    })
    .from(agentKbGrants)
    .innerJoin(knowledgeBases, eq(agentKbGrants.kbId, knowledgeBases.id))
    .where(and(
      eq(knowledgeBases.companyId, companyId),
      inArray(agentKbGrants.agentId, agentIds),
    ))
    .orderBy(asc(knowledgeBases.name), asc(agentKbGrants.agentId))
    .limit(MAX_KB_REFS);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    source: "agent_kb_grant" as const,
    agentId: row.agentId,
  }));
}

export async function buildMissionOwnerPlanningContext(
  db: Db,
  input: BuildMissionOwnerPlanningContextInput,
): Promise<MissionOwnerPlanningContext> {
  const mission = await loadMission(db, input);
  const planningIssue = await findPlanningIssue(db, input);
  const activePlanRow = await missionPlanArtifactService(db).getActiveMissionPlan({
    companyId: input.companyId,
    missionId: input.missionId,
  });
  const activePlan = stripRawRefs(summarizeMissionPlanForRuntime(activePlanRow));
  const executionSourceSnapshots = await listMissionExecutionSourceSnapshots(db, {
    companyId: input.companyId,
    missionIds: [input.missionId],
  });
  const executionSourceSnapshot = executionSourceSnapshots[input.missionId] ?? {
    missionId: input.missionId,
    companyId: input.companyId,
    units: [],
  };
  const ruleContext = await buildMissionRuleContext(db, { companyId: input.companyId });
  const purposeTokens = buildPurposeTokens(
    mission.title,
    mission.description,
    planningIssue?.title,
    planningIssue?.description,
    activePlan.missionGoal,
    ...(activePlan.stepSummary ?? []),
  );
  const workflowCandidates = await listWorkflowCandidates(db, input.companyId, purposeTokens);
  const agentRoster = await listAgentRoster(db, input.missionId);
  const kbRefs = await listKbRefs(db, input.companyId, agentRoster);
  const todoMarkers: MissionOwnerPlanningTodoMarker[] = [];

  if (agentRoster.length > 0 && kbRefs.length === 0) {
    todoMarkers.push({
      key: "kb_refs_unavailable",
      reason: "Mission agents have no company-scoped KB grants discoverable through agent_kb_grants.",
    });
  }
  if (await hasPluginWorkflowDefinitionEntities(db, input.companyId)) {
    todoMarkers.push({
      key: "plugin_workflow_definition_reader_unconfirmed",
      reason: "plugin_entities contains workflow-definition rows, but Slice 1 has no confirmed plugin workflow-definition reader contract; plugin candidates are intentionally omitted.",
    });
  }

  return {
    mission,
    planningIssueId: planningIssue?.id ?? null,
    activePlan,
    executionSourceSnapshot,
    ruleRefs: ruleContext.ruleRefs,
    workflowCandidates,
    kbRefs,
    agentRoster,
    todoMarkers,
    sourceRefVocabulary: [...MISSION_OWNER_PLANNING_SOURCE_REF_VOCABULARY],
  };
}
