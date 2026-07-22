import type { Request } from "express";
import { forbidden } from "../errors.js";
import { assertCompanyAccess } from "./authz.js";

type AgentReader = {
  getById(id: string): Promise<{ id: string; companyId: string; permissions?: Record<string, unknown> | null } | null>;
};

type AccessReader = {
  canUser(companyId: string, userId: string, permission: string): Promise<boolean>;
  hasPermission(companyId: string, principalType: "agent", principalId: string, permission: string): Promise<boolean>;
};

function canCreateAgents(agent: { permissions?: Record<string, unknown> | null }) {
  return Boolean(agent.permissions && typeof agent.permissions === "object" && agent.permissions.canCreateAgents);
}

export async function assertCanMutateCompanyInstructions(input: {
  req: Request;
  companyId: string;
  agents: AgentReader;
  access: AccessReader;
}) {
  const { req, companyId, agents, access } = input;
  assertCompanyAccess(req, companyId);
  if (req.actor.type === "board") {
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    if (!req.actor.userId) throw forbidden("Board authentication required");
    const allowed = await access.canUser(companyId, req.actor.userId, "agents:create");
    if (!allowed) throw forbidden("Missing permission: agents:create");
    return;
  }

  if (!req.actor.agentId) throw forbidden("Agent authentication required");
  const actorAgent = await agents.getById(req.actor.agentId);
  if (!actorAgent || actorAgent.companyId !== companyId) throw forbidden("Agent key cannot access another company");
  const allowedByGrant = await access.hasPermission(companyId, "agent", actorAgent.id, "agents:create");
  if (allowedByGrant || canCreateAgents(actorAgent)) return;
  throw forbidden("Missing permission: can create agents");
}
