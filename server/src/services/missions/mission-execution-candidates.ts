import { createHash } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentToolGrants, agents, toolDefinitions } from "@paperclipai/db";
import { readPaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import { RUNNABLE_MISSION_EXECUTION_ASSIGNEE_STATUSES, isMissionExecutionLiaisonAgent } from "./agent-role-boundaries.js";
import { mergeAgentConfig } from "../agents.js";

export interface MissionExecutionCandidate {
  agentId: string;
  name: string | null;
  role: string;
  capabilities: string | null;
  desiredSkillKeys: string[];
  toolNames: string[];
}

function readDesiredSkillKeys(agentRow: { adapterConfig: unknown; agentConfig?: unknown }): string[] {
  return readPaperclipSkillSyncPreference(mergeAgentConfig(agentRow)).desiredSkills;
}

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
      agentConfig: agents.agentConfig,
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
    desiredSkillKeys: readDesiredSkillKeys(a),
    toolNames: toolsByAgent.get(a.id) ?? [],
  }));
}

export function formatCandidateRosterLines(candidates: MissionExecutionCandidate[], ownerAgentId: string | null): string[] {
  return candidates.map((c) => `- ${c.name} (${c.role}) id=${c.agentId}${c.toolNames.length > 0 ? ` tools=${c.toolNames.join(",")}` : ""}${c.desiredSkillKeys.length > 0 ? ` skills=${c.desiredSkillKeys.join(",")}` : ""}${ownerAgentId && c.agentId === ownerAgentId ? " [mission owner]" : ""}`);
}

export function candidateRosterFingerprint(candidates: MissionExecutionCandidate[]): string {
  const sig = candidates
    .map((c) => `${c.agentId}:${c.name ?? ""}:${c.role}:${c.capabilities ?? ""}:${[...c.toolNames].sort().join("+")}:${[...c.desiredSkillKeys].sort().join("+")}`)
    .sort()
    .join("|");
  return createHash("sha256").update(sig).digest("hex").slice(0, 12);
}
