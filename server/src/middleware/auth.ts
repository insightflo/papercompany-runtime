import { createHash } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agentApiKeys, agents, companyMemberships, instanceUserRoles } from "@paperclipai/db";
import { normalizeAgentApiKeyScope, verifyLocalAgentJwt } from "../agent-auth-jwt.js";
import { resolveHermesOpsLiaisonIdentity } from "../services/missions/agent-role-boundaries.js";
import { isUuidLike, type DeploymentMode } from "@paperclipai/shared";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { logger } from "./logger.js";
import { boardAuthService } from "../services/board-auth.js";
import { forbidden, unprocessable } from "../errors.js";
import { loadAgentApiKeyResponsibleUser } from "../services/agent-api-key-policy.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function normalizeOptionalString(value: string | null | undefined) {
  return value?.trim() || null;
}

async function auditAuthFailure(
  db: Db,
  input: { companyId: string; agentId: string; action: string; entityId: string; details: Record<string, unknown> },
) {
  try {
    await db.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "agent",
      actorId: input.agentId,
      action: input.action,
      entityType: input.action.includes("run_header") ? "heartbeat_run" : "agent_api_key",
      entityId: input.entityId,
      ...(isUuidLike(input.agentId) ? { agentId: input.agentId } : {}),
      ...(isUuidLike(input.entityId) && input.action.includes("run_header") ? { runId: input.entityId } : {}),
      details: input.details,
    });
  } catch (err) {
    logger.warn({ err, ...input }, "Failed to audit rejected agent authentication");
  }
}

interface ActorMiddlewareOptions {
  deploymentMode: DeploymentMode;
  resolveSession?: (req: Request) => Promise<BetterAuthSessionResult | null>;
}

export function actorMiddleware(db: Db, opts: ActorMiddlewareOptions): RequestHandler {
  const boardAuth = boardAuthService(db);
  return async (req, _res, next) => {
    req.actor =
      opts.deploymentMode === "local_trusted"
        ? { type: "board", userId: "local-board", isInstanceAdmin: true, source: "local_implicit" }
        : { type: "none", source: "none" };

    const runIdHeader = req.header("x-paperclip-run-id");

    const authHeader = req.header("authorization");
    if (!authHeader?.toLowerCase().startsWith("bearer ")) {
      if (opts.deploymentMode === "authenticated" && opts.resolveSession) {
        let session: BetterAuthSessionResult | null = null;
        try {
          session = await opts.resolveSession(req);
        } catch (err) {
          logger.warn(
            { err, method: req.method, url: req.originalUrl },
            "Failed to resolve auth session from request headers",
          );
        }
        if (session?.user?.id) {
          const userId = session.user.id;
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
          req.actor = {
            type: "board",
            userId,
            companyIds: memberships.map((row) => row.companyId),
            isInstanceAdmin: Boolean(roleRow),
            runId: runIdHeader ?? undefined,
            source: "session",
          };
          next();
          return;
        }
      }
      if (runIdHeader) req.actor.runId = runIdHeader;
      next();
      return;
    }

    const token = authHeader.slice("bearer ".length).trim();
    if (!token) {
      next();
      return;
    }

    const boardKey = await boardAuth.findBoardApiKeyByToken(token);
    if (boardKey) {
      const access = await boardAuth.resolveBoardAccess(boardKey.userId);
      if (access.user) {
        await boardAuth.touchBoardApiKey(boardKey.id);
        req.actor = {
          type: "board",
          userId: boardKey.userId,
          companyIds: access.companyIds,
          isInstanceAdmin: access.isInstanceAdmin,
          keyId: boardKey.id,
          runId: runIdHeader || undefined,
          source: "board_key",
        };
        next();
        return;
      }
    }

    const tokenHash = hashToken(token);
    const key = await db
      .select()
      .from(agentApiKeys)
      .where(and(eq(agentApiKeys.keyHash, tokenHash), isNull(agentApiKeys.revokedAt)))
      .then((rows) => rows[0] ?? null);

    if (!key) {
      const claims = verifyLocalAgentJwt(token);
      if (!claims) {
        next();
        return;
      }

      const agentRecord = await db
        .select()
        .from(agents)
        .where(eq(agents.id, claims.sub))
        .then((rows) => rows[0] ?? null);

      if (!agentRecord || agentRecord.companyId !== claims.company_id) {
        next();
        return;
      }

      if (agentRecord.status === "terminated" || agentRecord.status === "pending_approval") {
        next();
        return;
      }

      const normalizedRunIdHeader = normalizeOptionalString(runIdHeader);
      if (normalizedRunIdHeader && normalizedRunIdHeader !== claims.run_id) {
        await auditAuthFailure(db, {
          companyId: claims.company_id,
          agentId: claims.sub,
          action: "auth.agent_jwt_run_header_mismatch",
          entityId: claims.run_id,
          details: {
            claimRunId: claims.run_id,
            headerRunId: normalizedRunIdHeader,
            method: req.method,
            url: req.originalUrl,
          },
        });
        next(
          unprocessable("X-Paperclip-Run-Id does not match signed agent JWT run_id", {
            code: "agent_jwt_run_id_mismatch",
            claimRunId: claims.run_id,
            headerRunId: normalizedRunIdHeader,
          }),
        );
        return;
      }

      const responsibleUserId = normalizeOptionalString(claims.responsible_user_id);
      const responsibleBinding = await loadAgentApiKeyResponsibleUser(db, claims.company_id, responsibleUserId);
      req.actor = {
        type: "agent",
        agentId: claims.sub,
        companyId: claims.company_id,
        keyId: undefined,
        keyScope: normalizeAgentApiKeyScope(claims.key_scope),
        runId: claims.run_id,
        onBehalfOfUserId: responsibleUserId ?? undefined,
        onBehalfOfMemberships: responsibleBinding.memberships,
        source: "agent_jwt",
        // [P3] liaison identity(mode 포함)를 authn에서 한 번에 산출. hermes-ops-mutation-guard가 읽음.
        ...resolveHermesOpsLiaisonIdentity(agentRecord),
      };
      next();
      return;
    }

    await db
      .update(agentApiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(agentApiKeys.id, key.id));

    const agentRecord = await db
      .select()
      .from(agents)
      .where(eq(agents.id, key.agentId))
      .then((rows) => rows[0] ?? null);

    if (
      !agentRecord ||
      agentRecord.companyId !== key.companyId ||
      agentRecord.status === "terminated" ||
      agentRecord.status === "pending_approval"
    ) {
      next();
      return;
    }

    const keyRecord = key as typeof key & {
      responsibleUserId?: string | null;
      scopeConfig?: unknown;
    };
    const responsibleUserId = normalizeOptionalString(keyRecord.responsibleUserId);
    const responsibleBinding = await loadAgentApiKeyResponsibleUser(db, key.companyId, responsibleUserId);
    if (
      !responsibleUserId ||
      !responsibleBinding.user ||
      (responsibleBinding.memberships.length === 0 && !responsibleBinding.isInstanceAdmin)
    ) {
      await auditAuthFailure(db, {
        companyId: key.companyId,
        agentId: key.agentId,
        action: "auth.agent_key_missing_responsible_user",
        entityId: key.id,
        details: { method: req.method, url: req.originalUrl },
      });
      next(
        forbidden("Responsible user is unavailable for this agent key", {
          code: "RESPONSIBLE_USER_UNAVAILABLE",
        }),
      );
      return;
    }

    req.actor = {
      type: "agent",
      agentId: key.agentId,
      companyId: key.companyId,
      keyId: key.id,
      keyScope: normalizeAgentApiKeyScope(keyRecord.scopeConfig),
      onBehalfOfUserId: responsibleUserId,
      onBehalfOfMemberships: responsibleBinding.memberships,
      runId: runIdHeader || undefined,
      source: "agent_key",
      ...resolveHermesOpsLiaisonIdentity(agentRecord),
    };

    next();
  };
}

export function requireBoard(req: Express.Request) {
  return req.actor.type === "board";
}
