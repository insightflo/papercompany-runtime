// server/src/services/missions/mission-execution-candidates.ts
//
// 회사 전체 runnable non-liaison execution candidate roster(req: PLAN candidate 정합).
// 정적 PLAN 설명 + 동적 planning context 에 동일 제공. mission_agents(missionId) 만 읽던 기존
// listAgentRoster 의 blank(새 수동 mission 은 Director 만 mission_agent) 보완.
// adapter config/secret 노출 ❌ — enabled granted toolNames 만. isMissionExecutionLiaisonAgent
// 가 adapterType(runtimeConfig/metadata)을 읽으므로 해당 필드 select 후 cast 없이 predicate 전달(codex review).

import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentToolGrants, agents, toolDefinitions } from "@paperclipai/db";
import { readPaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import { RUNNABLE_MISSION_EXECUTION_ASSIGNEE_STATUSES, isMissionExecutionLiaisonAgent } from "./agent-role-boundaries.js";

export interface MissionExecutionCandidate {
  agentId: string;
  name: string | null;
  role: string;
  capabilities: string | null;
  desiredSkillKeys: string[];
  toolNames: string[];
}

function readDesiredSkillKeys(adapterConfig: unknown): string[] {
  return readPaperclipSkillSyncPreference(
    adapterConfig && typeof adapterConfig === "object" && !Array.isArray(adapterConfig)
      ? adapterConfig as Record<string, unknown>
      : {},
  ).desiredSkills;
}

// 회사 전체 runnable non-liaison execution candidate + enabled granted toolNames + desiredSkillKeys.
// liaison(Hermes Ops / chief_of_staff_liaison) 제외, RUNNABLE_MISSION_EXECUTION_ASSIGNEE_STATUSES 만.
export async function listCompanyExecutionCandidates(db: Db, companyId: string): Promise<MissionExecutionCandidate[]> {
  const agentRows = await db
    .select({
      id: agents.id,
      name: agents.name,
      role: agents.role,
      capabilities: agents.capabilities,
      status: agents.status,
      adapterType: agents.adapterType,
      adapterConfig: agents.adapterConfig,
      runtimeConfig: agents.runtimeConfig,
      metadata: agents.metadata,
    })
    .from(agents)
    .where(and(
      eq(agents.companyId, companyId),
      inArray(agents.status, [...RUNNABLE_MISSION_EXECUTION_ASSIGNEE_STATUSES]),
    ))
    .orderBy(asc(agents.name), asc(agents.id))
    .then((rows) => rows.filter((a) => !isMissionExecutionLiaisonAgent(a)));

  if (agentRows.length === 0) return [];
  const agentIds = agentRows.map((a) => a.id);

  // 회사 경계 명시: agentToolGrants.companyId ∧ toolDefinitions.companyId(codex review).
  const grantRows = await db
    .select({ agentId: agentToolGrants.agentId, toolName: toolDefinitions.name })
    .from(agentToolGrants)
    .innerJoin(toolDefinitions, eq(agentToolGrants.toolId, toolDefinitions.id))
    .where(and(
      eq(agentToolGrants.companyId, companyId),
      eq(toolDefinitions.companyId, companyId),
      inArray(agentToolGrants.agentId, agentIds),
      eq(toolDefinitions.enabled, true),
    ))
    .orderBy(asc(toolDefinitions.name));

  const toolsByAgent = new Map<string, string[]>();
  for (const g of grantRows) {
    if (!g.toolName) continue;
    const arr = toolsByAgent.get(g.agentId) ?? [];
    if (!arr.includes(g.toolName)) arr.push(g.toolName);
    toolsByAgent.set(g.agentId, arr);
  }

  return agentRows.map((a) => ({
    agentId: a.id,
    name: a.name,
    role: a.role,
    capabilities: a.capabilities,
    desiredSkillKeys: readDesiredSkillKeys(a.adapterConfig),
    toolNames: toolsByAgent.get(a.id) ?? [],
  }));
}
