import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authUsers, companyMemberships, instanceUserRoles } from "@paperclipai/db";
import { forbidden } from "../errors.js";

export type AgentApiKeyResponsibilityAuthority =
  | "authenticated_user"
  | "local_implicit_board";

export type AgentApiKeyResponsibilityContext = {
  authority: AgentApiKeyResponsibilityAuthority;
};

function responsibleUserRequired() {
  return forbidden("A real responsible user is required for agent API keys", {
    code: "RESPONSIBLE_USER_REQUIRED",
  });
}

export function requireAgentApiKeyResponsibleUser(
  responsibleUserId: string | null | undefined,
  context: AgentApiKeyResponsibilityContext,
): string {
  const normalized = responsibleUserId?.trim() || null;
  if (!normalized) throw responsibleUserRequired();

  if (context.authority === "authenticated_user" && normalized === "local-board") {
    throw responsibleUserRequired();
  }

  if (context.authority === "local_implicit_board" && normalized !== "local-board") {
    throw forbidden("Local implicit responsibility must bind to local-board", {
      code: "RESPONSIBLE_USER_REQUIRED",
    });
  }

  return normalized;
}

export async function loadAgentApiKeyResponsibleUser(
  db: Db,
  companyId: string,
  responsibleUserId: string | null | undefined,
) {
  const normalized = responsibleUserId?.trim() || null;
  if (!normalized) return { user: null, memberships: [], isInstanceAdmin: false };

  const [user, memberships, instanceAdmin] = await Promise.all([
    db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.id, normalized))
      .then((rows) => rows[0] ?? null),
    db
      .select({
        companyId: companyMemberships.companyId,
        membershipRole: companyMemberships.membershipRole,
        status: companyMemberships.status,
      })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, normalized),
          eq(companyMemberships.status, "active"),
        ),
      ),
    db
      .select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, normalized), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows) => rows.length > 0),
  ]);

  return { user, memberships, isInstanceAdmin: instanceAdmin };
}

export async function requireAgentApiKeyResponsibleUserBinding(
  db: Db,
  companyId: string,
  responsibleUserId: string | null | undefined,
  context: AgentApiKeyResponsibilityContext,
): Promise<string> {
  const normalized = requireAgentApiKeyResponsibleUser(responsibleUserId, context);
  const binding = await loadAgentApiKeyResponsibleUser(db, companyId, normalized);
  if (!binding.user || (binding.memberships.length === 0 && !binding.isInstanceAdmin)) {
    throw forbidden("Responsible user is unavailable for this company", {
      code: "RESPONSIBLE_USER_UNAVAILABLE",
    });
  }
  return normalized;
}
