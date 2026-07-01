import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentKbGrants,
  agents,
  companySkills,
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
import { listWorkflowToolCatalog } from "../workflow/tool-catalog.js";
import { listMissionExecutionSourceSnapshots } from "./mission-execution-sources.js";
import type { MissionExecutionSourceSnapshot } from "./mission-execution-sources.js";
import { buildMissionRuleContext } from "./mission-rule-context.js";
import type { MissionRuleRef } from "./mission-rule-context.js";
import { extractMissionIntent, type MissionIntent } from "./mission-intent.js";
import { stat } from "node:fs/promises";
import { readPaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";

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
  desiredSkillKeys: string[];
};

export type MissionOwnerPlanningTodoMarker = {
  key: "kb_refs_unavailable" | "plugin_workflow_definition_reader_unconfirmed";
  reason: string;
};

export type MissionOwnerPlanningBoundedAssetSummary = {
  available: boolean;
  count: number;
  labels: string[];
  note?: string;
  entries?: Array<{
    name: string;
    displayName: string;
    source: string;
    enabled: boolean;
  }>;
};

/**
 * [목적] intent-scoped compressed capability manifest — planner 가 "어떤 publish capability 가 있는지"
 *   알게 해 publish unit 누락을 사전에 예방(mission-plan-qa gate 는 사후 검출). raw SKILL.md/tool schema
 *   전문은 넣지 않고 key/name/purpose 요약만. publish capability 는 intent.publish 일 때만 주입(과다 주입 방지).
 *   sitePublishTarget 은 path/env 기반 실데이터(boolean/source only, secret 값 미노출).
 */
export type MissionOwnerPlanningCapabilityEntry = {
  key: string;
  name: string;
  purpose: string;
};

/** site/cloudflare 게시 대상 감지 결과. secret 값은 절대 포함하지 않는다(presence/source 만). */
export type MissionOwnerPlanningSitePublishTarget = {
  available: boolean | null;
  note: string;
  siteRoot?: string;
  canStage?: boolean;
  cloudflare?: { hasApiToken: boolean; hasAccountId: boolean };
};

export type MissionOwnerPlanningCapabilityManifest = {
  publishCapabilities: MissionOwnerPlanningCapabilityEntry[];
  notableSkills: MissionOwnerPlanningCapabilityEntry[];
  sitePublishTarget: MissionOwnerPlanningSitePublishTarget;
};

export type MissionOwnerPlanningDossier = {
  objective: {
    title: string;
    description: string | null;
    extractedDeliverables: string[];
    successCriteriaSeeds: string[];
  };
  assets: {
    workflowCandidates: Array<{
      id: string;
      name: string;
      source: string;
      matchReason: string;
      fit: "candidate" | "weak";
    }>;
    tools: MissionOwnerPlanningBoundedAssetSummary;
    runtimeServices: MissionOwnerPlanningBoundedAssetSummary;
    ruleRefs: Array<Pick<MissionRuleRef, "id" | "key" | "name" | "mode" | "severity" | "action" | "reason">>;
    kbRefs: Array<{ id: string; name: string; type: string; reason: string }>;
    agentRoster: Array<{ agentId: string; name: string | null; role: string; capabilities: string | null; desiredSkillKeys: string[] }>;
    capabilityManifest: MissionOwnerPlanningCapabilityManifest;
    fileViews: MissionOwnerPlanningBoundedAssetSummary;
    executionSourceSummary: { unitCount: number; labels: string[] };
  };
  gaps: Array<{ key: string; severity: "info" | "needs_research" | "blocked"; reason: string }>;
  requiredAssessmentChecklist: string[];
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
  planningDossier: MissionOwnerPlanningDossier;
  sourceRefVocabulary: MissionOwnerPlanningSourceRefType[];
};

type PlanningIssueRow = Pick<typeof issues.$inferSelect, "id" | "title" | "description">;

const MAX_WORKFLOW_CANDIDATES = 12;
const MAX_KB_REFS = 20;
const MAX_PURPOSE_TOKENS = 10;
const PURPOSE_TOKEN_MIN_LENGTH = 3;
const MAX_DOSSIER_OBJECTIVE_FRAGMENTS = 5;
const MAX_DOSSIER_LABELS = 10;
// [capability manifest] company skills top-K 압축 한도. raw SKILL.md/tool schema 는 넣지 않는다.
const MAX_NOTABLE_SKILLS = 12;
const MAX_PUBLISH_CAPABILITIES = 8;
const MAX_SKILL_PURPOSE_LENGTH = 160;
const SUCCESS_CRITERIA_MARKER_RE = /\b(deliverable|delivery|output|result|report|summary|publish|send|channel|date|deadline|by|png|markdown|telegram|slack|email|완료|전송|발행|게시|보고|요약|산출|결과|채널|날짜|오늘|마감)\b|산출물|결과물|\d{1,2}:\d{2}|\d{4}-\d{2}-\d{2}/iu;

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

function boundedLabel(value: string | null | undefined): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function uniqueStrings(values: Array<string | null | undefined>, limit = MAX_DOSSIER_LABELS): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const label = boundedLabel(value);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    result.push(label);
    if (result.length >= limit) break;
  }
  return result;
}

function splitObjectiveFragments(...values: Array<string | null | undefined>): string[] {
  const text = values.filter((value): value is string => typeof value === "string" && value.trim().length > 0).join("\n");
  if (!text) return [];

  return uniqueStrings(
    text
      .replace(/(?:^|\n)\s*[-*•]\s+/gu, "\n")
      .split(/(?:[.;]|\n+|[。！？!?]|다\.|요\.|니다\.|함\.|됨\.)/u)
      .map((fragment) => fragment.replace(/^\s*\d+[.)]\s+/u, "").trim())
      .filter((fragment) => fragment.length >= 3),
    MAX_DOSSIER_OBJECTIVE_FRAGMENTS,
  );
}

function unavailableSummary(note: string): MissionOwnerPlanningBoundedAssetSummary {
  return { available: false, count: 0, labels: [], note };
}

async function listWorkflowToolSummary(db: Db, companyId: string): Promise<MissionOwnerPlanningBoundedAssetSummary> {
  const catalog = await listWorkflowToolCatalog(db, companyId);
  const usableTools = catalog.tools.filter((tool) => tool.enabled);
  if (usableTools.length === 0) {
    return {
      available: false,
      count: 0,
      labels: [],
      note: catalog.tools.length > 0
        ? "Workflow tools exist but none are currently enabled/selectable."
        : "No workflow tools are available for this company.",
    };
  }
  return {
    available: true,
    count: usableTools.length,
    labels: uniqueStrings(usableTools.map((tool) => `${tool.displayName} (${tool.name})`)),
    entries: usableTools.slice(0, MAX_DOSSIER_LABELS).map((tool) => ({
      name: tool.name,
      displayName: tool.displayName,
      source: tool.source,
      enabled: tool.enabled,
    })),
  };
}

function workflowCandidateMatchReason(candidate: MissionOwnerPlanningWorkflowCandidate): string {
  if (candidate.matchedPurposeTokens.length > 0) {
    return `Matched mission tokens: ${candidate.matchedPurposeTokens.join(", ")}.`;
  }
  return "No direct mission-token match; retained as a weak native workflow candidate for manual review.";
}

function executionUnitLabel(unit: MissionExecutionSourceSnapshot["units"][number]): string | null {
  return boundedLabel(unit.title ?? unit.workflowName ?? `${unit.kind}:${unit.id}`);
}

function buildPlanningDossier(input: {
  mission: MissionOwnerPlanningMission;
  executionSourceSnapshot: MissionExecutionSourceSnapshot;
  ruleRefs: MissionRuleRef[];
  workflowCandidates: MissionOwnerPlanningWorkflowCandidate[];
  kbRefs: MissionOwnerPlanningKbRef[];
  agentRoster: MissionOwnerPlanningAgentRosterEntry[];
  capabilityManifest: MissionOwnerPlanningCapabilityManifest;
  tools: MissionOwnerPlanningBoundedAssetSummary;
  todoMarkers: MissionOwnerPlanningTodoMarker[];
}): MissionOwnerPlanningDossier {
  const extractedDeliverables = splitObjectiveFragments(input.mission.title, input.mission.description);
  const successCriteriaSeeds = extractedDeliverables.filter((fragment) => SUCCESS_CRITERIA_MARKER_RE.test(fragment));
  const workflowCandidates = input.workflowCandidates.map((candidate) => ({
    id: candidate.id,
    name: candidate.name,
    source: candidate.source,
    matchReason: workflowCandidateMatchReason(candidate),
    fit: candidate.purposeMatched ? "candidate" as const : "weak" as const,
  }));
  const gaps: MissionOwnerPlanningDossier["gaps"] = input.todoMarkers.map((marker) => ({
    key: marker.key,
    severity: "info" as const,
    reason: marker.reason,
  }));

  if (!input.workflowCandidates.some((candidate) => candidate.purposeMatched)) {
    gaps.push({
      key: "manual_planning_required",
      severity: "needs_research",
      reason: "No native workflow candidate matched mission objective tokens; owner should research or draft an explicit execution plan before claiming control-plane readiness.",
    });
  }
  if (input.agentRoster.length === 0) {
    gaps.push({
      key: "agent_roster_empty",
      severity: "blocked",
      reason: "No mission agents are assigned; the owner must assign or confirm an executor before planning execution units.",
    });
  }

  return {
    objective: {
      title: input.mission.title,
      description: input.mission.description,
      extractedDeliverables,
      successCriteriaSeeds,
    },
    assets: {
      workflowCandidates,
      tools: input.tools,
      runtimeServices: unavailableSummary("No runtime-service summary is available inside MissionOwnerPlanningContext; Slice 4B does not start or discover services."),
      ruleRefs: input.ruleRefs.map(({ id, key, name, mode, severity, action, reason }) => ({ id, key, name, mode, severity, action, reason })),
      kbRefs: input.kbRefs.map(({ id, name, type, agentId }) => ({
        id,
        name,
        type,
        reason: `Granted to mission agent ${agentId}.`,
      })),
      agentRoster: input.agentRoster.map(({ agentId, name, role, capabilities, desiredSkillKeys }) => ({ agentId, name, role, capabilities, desiredSkillKeys })),
      capabilityManifest: input.capabilityManifest,
      fileViews: unavailableSummary("No file-view summary is available inside MissionOwnerPlanningContext; Slice 4B does not scan repositories or files."),
      executionSourceSummary: {
        unitCount: input.executionSourceSnapshot.units.length,
        labels: uniqueStrings(input.executionSourceSnapshot.units.map(executionUnitLabel)),
      },
    },
    gaps,
    requiredAssessmentChecklist: [
      "Restate the mission objective and expected deliverables before selecting execution units.",
      "Assess workflow candidates, rules, KB refs, agent roster, execution sources, tools, runtime services, and file views explicitly.",
      "Mark each gap as info, needs_research, or blocked and resolve blocked gaps before claiming readiness.",
      "Post a structured Mission owner plan decision JSON comment; Markdown-only comments are behavioral notes, not structured control-plane success.",
    ],
  };
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

/** publish capability 식별 정규식(skill key/slug/name 매칭). mission-intent publish 토큰과 의미 정렬. */
const PUBLISH_CAPABILITY_RE = /manual[-_\s]?onboarding|publisher|cloudflare|\bpublish\b|\bdeploy\b|\bonboard/iu;

function compressSkillEntry(input: {
  key: string;
  slug: string | null;
  name: string | null;
  description: string | null;
}): MissionOwnerPlanningCapabilityEntry {
  const name = (input.name ?? input.slug ?? input.key ?? "").toString().trim() || input.key;
  const purposeRaw = (input.description ?? input.name ?? "").toString().trim();
  const purpose = purposeRaw.length > MAX_SKILL_PURPOSE_LENGTH
    ? `${purposeRaw.slice(0, MAX_SKILL_PURPOSE_LENGTH - 1).trimEnd()}…`
    : purposeRaw;
  return { key: input.key, name, purpose };
}

/**
 * [목적] company skill row 들 → intent-scoped compressed capability manifest(pure).
 *   - intent 가 주어지면: intent.publish 일 때만 publishCapabilities 주입(non-publish 미션에 과다 주입 방지).
 *     intent 가 없으면 backward-compat 로 publish 포함.
 *   - notableSkills 는 top-K capped 요약(raw SKILL.md/schema 전문 미포함).
 *   - sitePublishTarget 은 호출자가 resolveSitePublishTarget() 결과를 전달(순수성 유지).
 */
export function buildCapabilityManifest(
  skills: ReadonlyArray<{ key: string; slug: string | null; name: string | null; description: string | null }>,
  options: {
    intent?: MissionIntent;
    sitePublishTarget?: MissionOwnerPlanningSitePublishTarget;
  } = {},
): MissionOwnerPlanningCapabilityManifest {
  const publishWanted = !options.intent || options.intent.publish;
  const publishCapabilities: MissionOwnerPlanningCapabilityEntry[] = [];
  const notableSkills: MissionOwnerPlanningCapabilityEntry[] = [];
  for (const skill of skills) {
    const entry = compressSkillEntry(skill);
    if (notableSkills.length < MAX_NOTABLE_SKILLS) notableSkills.push(entry);
    if (!publishWanted) continue;
    const haystack = `${skill.key} ${skill.slug ?? ""} ${skill.name ?? ""}`;
    if (PUBLISH_CAPABILITY_RE.test(haystack) && publishCapabilities.length < MAX_PUBLISH_CAPABILITIES) {
      publishCapabilities.push(entry);
    }
  }
  return {
    publishCapabilities,
    notableSkills,
    sitePublishTarget: options.sitePublishTarget ?? { available: null, note: "sitePublishTarget resolver 가 전달되지 않음." },
  };
}

/**
 * [목적] site/cloudflare 게시 대상 감지(실데이터). path 존재 + Cloudflare env presence. secret 값은 절대
 *   읽지 않고 boolean/source 만. A1(/srv/...) 과 local dev(env override) 모두 깨지지 않게 fallback.
 *   - siteRoot: env MANUAL_ONBOARDING_SITE_ROOT 우선, 없으면 /srv/manual-onboarding-cloudflare 기본.
 *   - cloudflare env: CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID 존재 여부(boolean).
 * [주의] fs/env 조회는 전부 가드 — 어떤 환경에서도 throw 하지 않는다.
 */
export async function resolveSitePublishTarget(): Promise<MissionOwnerPlanningSitePublishTarget> {
  const siteRoot = process.env.MANUAL_ONBOARDING_SITE_ROOT ?? "/srv/manual-onboarding-cloudflare";
  let siteExists = false;
  try {
    await stat(siteRoot);
    siteExists = true;
  } catch {
    siteExists = false;
  }
  const hasApiToken = Boolean(process.env.CLOUDFLARE_API_TOKEN);
  const hasAccountId = Boolean(process.env.CLOUDFLARE_ACCOUNT_ID);
  const cloudflare = { hasApiToken, hasAccountId };
  const available = siteExists || hasApiToken ? true : null;
  const note = available
    ? `site root=${siteRoot} exists=${siteExists}; cloudflare token=${hasApiToken} account=${hasAccountId}.`
    : `site root(${siteRoot}) 미확인 + cloudflare env 미구성. local/A1 어느 쪽도 아니면 게시 불가.`;
  return { available, note, siteRoot, canStage: siteExists, cloudflare };
}

/**
 * [목적] 회사 companySkills + intent + site target → compressed capability manifest 구성.
 *   intent 로 publish capability 스코핑, resolveSitePublishTarget 으로 site 실데이터 주입.
 */
async function listCompanySkillSummaries(
  db: Db,
  companyId: string,
  intent?: MissionIntent,
): Promise<MissionOwnerPlanningCapabilityManifest> {
  const [rows, sitePublishTarget] = await Promise.all([
    db
      .select({
        key: companySkills.key,
        slug: companySkills.slug,
        name: companySkills.name,
        description: companySkills.description,
      })
      .from(companySkills)
      .where(eq(companySkills.companyId, companyId))
      .orderBy(asc(companySkills.key)),
    resolveSitePublishTarget(),
  ]);
  return buildCapabilityManifest(rows, { intent, sitePublishTarget });
}

async function listAgentRoster(db: Db, missionId: string): Promise<MissionOwnerPlanningAgentRosterEntry[]> {
  const rows = await db
    .select({
      agentId: missionAgents.agentId,
      role: missionAgents.role,
      assignedAt: missionAgents.assignedAt,
      name: agents.name,
      capabilities: agents.capabilities,
      adapterConfig: agents.adapterConfig,
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
    desiredSkillKeys: readPaperclipSkillSyncPreference(
      row.adapterConfig && typeof row.adapterConfig === "object" && !Array.isArray(row.adapterConfig)
        ? row.adapterConfig as Record<string, unknown>
        : {},
    ).desiredSkills,
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
  // [P3] intent 로 capability 를 스코핑 — non-publish 미션에 publish capability 가 과다 주입되지 않게.
  const missionIntent = extractMissionIntent(mission.title, mission.description);
  const capabilityManifest = await listCompanySkillSummaries(db, input.companyId, missionIntent);
  const tools = await listWorkflowToolSummary(db, input.companyId);
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

  const planningDossier = buildPlanningDossier({
    mission,
    executionSourceSnapshot,
    ruleRefs: ruleContext.ruleRefs,
    workflowCandidates,
    kbRefs,
    agentRoster,
    capabilityManifest,
    tools,
    todoMarkers,
  });

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
    planningDossier,
    sourceRefVocabulary: [...MISSION_OWNER_PLANNING_SOURCE_REF_VOCABULARY],
  };
}
