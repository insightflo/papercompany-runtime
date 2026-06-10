import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { channelConfigs, type Db } from "@paperclipai/db";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { logActivity, secretService } from "../services/index.js";

type ChannelConfigRow = typeof channelConfigs.$inferSelect;

interface TelegramGetMeResponse {
  ok: boolean;
  result?: {
    username?: string;
    first_name?: string;
  };
  description?: string;
}

export async function validateTelegramBotConnection(input: {
  botToken: string;
  botUsername?: string | null;
}) {
  const token = input.botToken.trim();
  if (!token) {
    return { ok: false, error: "Telegram bot token is empty" };
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
    method: "POST",
  });
  const data = (await response.json()) as TelegramGetMeResponse;
  if (!data.ok) {
    return {
      ok: false,
      error: data.description ?? "Telegram getMe failed",
    };
  }

  const actualUsername = data.result?.username ?? null;
  const expectedUsername = input.botUsername?.trim() ?? "";
  if (
    expectedUsername &&
    actualUsername &&
    expectedUsername.toLowerCase() !== actualUsername.toLowerCase()
  ) {
    return {
      ok: false,
      botUsername: actualUsername,
      error: `Bot username mismatch: token belongs to @${actualUsername}`,
    };
  }

  return {
    ok: true,
    botUsername: actualUsername ?? (expectedUsername || undefined),
  };
}

function serializeChannelConfig(row: ChannelConfigRow) {
  const config = row.configJson ?? {};
  const botUsername = typeof config.botUsername === "string" ? config.botUsername : null;
  const botTokenSecretId = typeof config.botTokenSecretId === "string" ? config.botTokenSecretId : null;

  return {
    id: row.id,
    companyId: row.companyId,
    kind: "telegram" as const,
    botUsername,
    botTokenSecretId,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
  };
}

export function channelConfigRoutes(db: Db) {
  const router = Router();

  router.get("/companies/:companyId/channel/config", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const [row] = await db
      .select()
      .from(channelConfigs)
      .where(and(eq(channelConfigs.companyId, companyId), eq(channelConfigs.kind, "telegram")))
      .limit(1);

    res.json(row ? serializeChannelConfig(row) : null);
  });

  router.put("/companies/:companyId/channel/config", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const body = req.body as {
      botUsername?: unknown;
      botTokenSecretId?: unknown;
      enabled?: unknown;
    };
    const botUsername = typeof body.botUsername === "string" ? body.botUsername.trim() : "";
    const botTokenSecretId = typeof body.botTokenSecretId === "string" ? body.botTokenSecretId.trim() : "";
    const enabled = typeof body.enabled === "boolean" ? body.enabled : true;

    if (!botUsername) {
      res.status(422).json({ error: "botUsername is required" });
      return;
    }
    if (!botTokenSecretId) {
      res.status(422).json({ error: "botTokenSecretId is required" });
      return;
    }

    const [row] = await db
      .insert(channelConfigs)
      .values({
        companyId,
        kind: "telegram",
        enabled,
        configJson: { botUsername, botTokenSecretId },
      })
      .onConflictDoUpdate({
        target: [channelConfigs.companyId, channelConfigs.kind],
        set: {
          enabled,
          configJson: { botUsername, botTokenSecretId },
        },
      })
      .returning();

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "channel.config.updated",
      entityType: "channel_config",
      entityId: row.id,
      details: { kind: "telegram", botUsername, enabled },
    });

    res.json(serializeChannelConfig(row));
  });

  router.post("/companies/:companyId/channel/test", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const [row] = await db
      .select()
      .from(channelConfigs)
      .where(and(eq(channelConfigs.companyId, companyId), eq(channelConfigs.kind, "telegram")))
      .limit(1);

    const config = row ? serializeChannelConfig(row) : null;
    if (!config?.botTokenSecretId) {
      res.json({ ok: false, error: "Telegram channel is not configured" });
      return;
    }

    try {
      const token = await secretService(db).resolveSecretValue(
        companyId,
        config.botTokenSecretId,
        "latest",
      );
      const result = await validateTelegramBotConnection({
        botToken: token,
        botUsername: config.botUsername,
      });
      res.json(result);
    } catch (err) {
      res.json({
        ok: false,
        botUsername: config.botUsername ?? undefined,
        error: err instanceof Error ? err.message : "Telegram channel test failed",
      });
    }
  });

  return router;
}
