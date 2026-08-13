import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentApiKeys, agents, companyMemberships, instanceUserRoles } from "@paperclipai/db";
import type { DeploymentMode } from "@paperclipai/shared";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { loadAgentApiKeyResponsibleUser } from "../services/agent-api-key-policy.js";

export interface HeartbeatReplayCursor {
  runId: string;
  afterSeq: number;
}

export interface UpgradeContext {
  companyId: string;
  actorType: "board" | "agent";
  actorId: string;
  heartbeatReplayCursors: HeartbeatReplayCursor[];
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function parseHeartbeatReplayCursors(url: URL): HeartbeatReplayCursor[] {
  const out: HeartbeatReplayCursor[] = [];
  for (const raw of url.searchParams.getAll("heartbeatRun")) {
    if (!raw.includes(":")) continue;
    const [rawRunId, rawAfterSeq] = raw.split(":");
    const runId = rawRunId?.trim();
    if (!runId) continue;
    const parsedSeq = Number(rawAfterSeq ?? 0);
    out.push({
      runId,
      afterSeq: Number.isFinite(parsedSeq) && parsedSeq > 0 ? Math.floor(parsedSeq) : 0,
    });
  }
  return out;
}

function parseBearerToken(rawAuth: string | string[] | undefined) {
  const auth = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;
  if (!auth) return null;
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const token = auth.slice("bearer ".length).trim();
  return token.length > 0 ? token : null;
}

function headersFromIncomingMessage(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, raw] of Object.entries(req.headers)) {
    if (!raw) continue;
    if (Array.isArray(raw)) {
      for (const value of raw) headers.append(key, value);
      continue;
    }
    headers.set(key, raw);
  }
  return headers;
}

export async function authorizeUpgrade(
  db: Db,
  req: IncomingMessage,
  companyId: string,
  url: URL,
  opts: {
    deploymentMode: DeploymentMode;
    resolveSessionFromHeaders?: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
  },
): Promise<UpgradeContext | null> {
  const queryToken = url.searchParams.get("token")?.trim() ?? "";
  const authToken = parseBearerToken(req.headers.authorization);
  const token = authToken ?? (queryToken.length > 0 ? queryToken : null);

  if (!token) {
    if (opts.deploymentMode === "local_trusted") {
      return {
        companyId,
        actorType: "board",
        actorId: "board",
        heartbeatReplayCursors: parseHeartbeatReplayCursors(url),
      };
    }

    if (opts.deploymentMode !== "authenticated" || !opts.resolveSessionFromHeaders) return null;

    const session = await opts.resolveSessionFromHeaders(headersFromIncomingMessage(req));
    const userId = session?.user?.id;
    if (!userId) return null;

    const [roleRow, memberships] = await Promise.all([
      db
        .select({ id: instanceUserRoles.id })
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
        .then((rows) => rows[0] ?? null),
      db
        .select({ companyId: companyMemberships.companyId })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userId),
            eq(companyMemberships.status, "active"),
          ),
        ),
    ]);

    if (!roleRow && !memberships.some((row) => row.companyId === companyId)) return null;
    return {
      companyId,
      actorType: "board",
      actorId: userId,
      heartbeatReplayCursors: parseHeartbeatReplayCursors(url),
    };
  }

  const tokenHash = hashToken(token);
  const key = await db
    .select()
    .from(agentApiKeys)
    .where(and(eq(agentApiKeys.keyHash, tokenHash), isNull(agentApiKeys.revokedAt)))
    .then((rows) => rows[0] ?? null);
  if (!key || key.companyId !== companyId) return null;

  const agent = await db
    .select({ id: agents.id, companyId: agents.companyId, status: agents.status })
    .from(agents)
    .where(eq(agents.id, key.agentId))
    .then((rows) => rows[0] ?? null);
  if (
    !agent ||
    agent.companyId !== companyId ||
    agent.status === "terminated" ||
    agent.status === "pending_approval"
  ) {
    return null;
  }

  const responsibleBinding = await loadAgentApiKeyResponsibleUser(db, companyId, key.responsibleUserId);
  if (
    !key.responsibleUserId ||
    !responsibleBinding.user ||
    (responsibleBinding.memberships.length === 0 && !responsibleBinding.isInstanceAdmin)
  ) {
    return null;
  }

  await db
    .update(agentApiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(agentApiKeys.id, key.id));

  return {
    companyId,
    actorType: "agent",
    actorId: key.agentId,
    heartbeatReplayCursors: parseHeartbeatReplayCursors(url),
  };
}
