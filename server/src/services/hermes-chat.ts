import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, hermesChatMessages, hermesChatSessions } from "@paperclipai/db";
import type {
  HermesChatMessage,
  HermesChatMessageStatus,
  HermesChatSession,
  HermesChatSessionDetail,
  HermesChatSessionStatus,
} from "@paperclipai/shared";
import { and, desc, eq, sql } from "drizzle-orm";

const MAX_CHAT_RESPONSE_CHARS = 100_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNestedString(value: unknown, path: string[]): string | null {
  let cursor: unknown = value;
  for (const key of path) {
    const record = asRecord(cursor);
    if (!record) return null;
    cursor = record[key];
  }
  return typeof cursor === "string" && cursor.trim().length > 0 ? cursor.trim() : null;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function serializeSession(row: typeof hermesChatSessions.$inferSelect & {
  messageCount?: number | null;
  latestRunStatus?: string | null;
}): HermesChatSession {
  return {
    id: row.id,
    companyId: row.companyId,
    agentId: row.agentId ?? null,
    title: row.title,
    status: row.status as HermesChatSessionStatus,
    createdByUserId: row.createdByUserId ?? null,
    lastMessageAt: toIso(row.lastMessageAt),
    createdAt: toIso(row.createdAt)!,
    updatedAt: toIso(row.updatedAt)!,
    messageCount: row.messageCount ?? undefined,
    latestRunStatus: (row.latestRunStatus as HermesChatSession["latestRunStatus"]) ?? null,
  };
}

function serializeMessage(row: typeof hermesChatMessages.$inferSelect): HermesChatMessage {
  return {
    id: row.id,
    companyId: row.companyId,
    sessionId: row.sessionId,
    agentId: row.agentId ?? null,
    runId: row.runId ?? null,
    role: row.role as HermesChatMessage["role"],
    body: row.body,
    status: row.status as HermesChatMessageStatus,
    metadata: row.metadata ?? null,
    createdAt: toIso(row.createdAt)!,
    updatedAt: toIso(row.updatedAt)!,
  };
}

function titleFromMessage(body: string) {
  const normalized = body.replace(/\s+/g, " ").trim();
  if (!normalized) return "New Hermes chat";
  return normalized.length > 64 ? `${normalized.slice(0, 61)}...` : normalized;
}

function readRunTextField(resultJson: Record<string, unknown> | null | undefined, key: string): string | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) return null;
  const value = resultJson[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function limitChatResponseText(value: string): string {
  if (value.length <= MAX_CHAT_RESPONSE_CHARS) return value;
  return [
    value.slice(0, MAX_CHAT_RESPONSE_CHARS),
    "",
    `[Paperclip truncated this Hermes response after ${MAX_CHAT_RESPONSE_CHARS} characters. Open the linked run log for the full raw transcript.]`,
  ].join("\n");
}

export function responseTextFromRun(row: Pick<typeof heartbeatRuns.$inferSelect, "status" | "resultJson" | "error">) {
  const resultText =
    readRunTextField(row.resultJson ?? null, "result") ??
    readRunTextField(row.resultJson ?? null, "summary") ??
    readRunTextField(row.resultJson ?? null, "message") ??
    readRunTextField(row.resultJson ?? null, "error") ??
    (typeof row.error === "string" && row.error.trim() ? row.error.trim() : null);

  if (resultText) return limitChatResponseText(resultText);
  return row.status === "succeeded"
    ? "Hermes run completed, but it did not return a text response."
    : `Hermes run ${row.status}.`;
}

export function hermesChatService(db: Db) {
  async function findOperationsAgent(companyId: string) {
    const rows = await db
      .select({
        id: agents.id,
        name: agents.name,
        status: agents.status,
        adapterType: agents.adapterType,
        runtimeConfig: agents.runtimeConfig,
        metadata: agents.metadata,
      })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.adapterType, "hermes_local")));

    return rows.find((row) => {
      if (row.status === "terminated" || row.status === "pending_approval") return false;
      const purpose = readNestedString(row.metadata, ["purpose"]);
      const mode = readNestedString(row.runtimeConfig, ["operatingMode"]);
      const telegram = asRecord(asRecord(row.runtimeConfig)?.telegram);
      return (
        row.name === "Hermes Operations Manager" ||
        purpose === "research-company-hermes-management" ||
        mode === "independent_management_operator" ||
        telegram?.directConversation === true
      );
    }) ?? null;
  }

  async function listSessions(companyId: string): Promise<HermesChatSession[]> {
    const rows = await db
      .select({
        id: hermesChatSessions.id,
        companyId: hermesChatSessions.companyId,
        agentId: hermesChatSessions.agentId,
        title: hermesChatSessions.title,
        status: hermesChatSessions.status,
        createdByUserId: hermesChatSessions.createdByUserId,
        lastMessageAt: hermesChatSessions.lastMessageAt,
        createdAt: hermesChatSessions.createdAt,
        updatedAt: hermesChatSessions.updatedAt,
        messageCount: sql<number>`count(${hermesChatMessages.id})::int`,
        latestRunStatus: sql<string | null>`max(${heartbeatRuns.status})`,
      })
      .from(hermesChatSessions)
      .leftJoin(hermesChatMessages, eq(hermesChatMessages.sessionId, hermesChatSessions.id))
      .leftJoin(heartbeatRuns, eq(heartbeatRuns.id, hermesChatMessages.runId))
      .where(eq(hermesChatSessions.companyId, companyId))
      .groupBy(
        hermesChatSessions.id,
        hermesChatSessions.companyId,
        hermesChatSessions.agentId,
        hermesChatSessions.title,
        hermesChatSessions.status,
        hermesChatSessions.createdByUserId,
        hermesChatSessions.lastMessageAt,
        hermesChatSessions.createdAt,
        hermesChatSessions.updatedAt,
      )
      .orderBy(desc(hermesChatSessions.updatedAt));

    return rows.map(serializeSession);
  }

  async function createSession(companyId: string, input: {
    title?: string | null;
    agentId?: string | null;
    createdByUserId?: string | null;
  }): Promise<HermesChatSession> {
    const agentId = input.agentId ?? (await findOperationsAgent(companyId))?.id ?? null;
    const [row] = await db.insert(hermesChatSessions).values({
      companyId,
      agentId,
      title: input.title?.trim() || "New Hermes chat",
      createdByUserId: input.createdByUserId ?? null,
      lastMessageAt: new Date(),
    }).returning();
    if (!row) throw new Error("Failed to create Hermes chat session");
    return serializeSession(row);
  }

  async function getOrCreateTelegramSession(companyId: string, input: {
    chatId: number;
    title?: string | null;
    agentId?: string | null;
  }): Promise<HermesChatSession> {
    const createdByUserId = `telegram:chat:${input.chatId}`;
    const [existing] = await db
      .select()
      .from(hermesChatSessions)
      .where(and(
        eq(hermesChatSessions.companyId, companyId),
        eq(hermesChatSessions.createdByUserId, createdByUserId),
        eq(hermesChatSessions.status, "active"),
      ))
      .orderBy(desc(hermesChatSessions.updatedAt))
      .limit(1);
    if (existing) return serializeSession(existing);

    return createSession(companyId, {
      title: input.title ?? `Telegram chat ${input.chatId}`,
      agentId: input.agentId ?? null,
      createdByUserId,
    });
  }

  async function getSession(companyId: string, sessionId: string): Promise<HermesChatSessionDetail | null> {
    const [session] = await db
      .select()
      .from(hermesChatSessions)
      .where(and(eq(hermesChatSessions.companyId, companyId), eq(hermesChatSessions.id, sessionId)))
      .limit(1);
    if (!session) return null;

    const messages = await db
      .select()
      .from(hermesChatMessages)
      .where(and(eq(hermesChatMessages.companyId, companyId), eq(hermesChatMessages.sessionId, sessionId)))
      .orderBy(hermesChatMessages.createdAt);

    return {
      session: serializeSession(session),
      messages: messages.map(serializeMessage),
    };
  }

  async function updateSession(companyId: string, sessionId: string, input: {
    title?: string | null;
    status?: HermesChatSessionStatus;
  }): Promise<HermesChatSession | null> {
    const patch: Partial<typeof hermesChatSessions.$inferInsert> = { updatedAt: new Date() };
    if (input.title !== undefined) patch.title = input.title?.trim() || "New Hermes chat";
    if (input.status !== undefined) patch.status = input.status;
    const [row] = await db
      .update(hermesChatSessions)
      .set(patch)
      .where(and(eq(hermesChatSessions.companyId, companyId), eq(hermesChatSessions.id, sessionId)))
      .returning();
    return row ? serializeSession(row) : null;
  }

  async function addUserMessage(
    companyId: string,
    sessionId: string,
    body: string,
    metadata?: Record<string, unknown> | null,
  ): Promise<HermesChatMessage> {
    const now = new Date();
    const [message] = await db.insert(hermesChatMessages).values({
      companyId,
      sessionId,
      role: "user",
      body,
      status: "sent",
      metadata: metadata ?? undefined,
      createdAt: now,
      updatedAt: now,
    }).returning();
    if (!message) throw new Error("Failed to create Hermes chat message");

    const detail = await getSession(companyId, sessionId);
    const session = detail?.session;
    const updates: Partial<typeof hermesChatSessions.$inferInsert> = {
      updatedAt: now,
      lastMessageAt: now,
    };
    if (session && session.title === "New Hermes chat") updates.title = titleFromMessage(body);
    await db
      .update(hermesChatSessions)
      .set(updates)
      .where(and(eq(hermesChatSessions.companyId, companyId), eq(hermesChatSessions.id, sessionId)));

    return serializeMessage(message);
  }

  async function addAssistantPlaceholder(companyId: string, sessionId: string, agentId: string | null) {
    const [message] = await db.insert(hermesChatMessages).values({
      companyId,
      sessionId,
      agentId,
      role: "assistant",
      body: "Hermes is thinking...",
      status: "queued",
    }).returning();
    if (!message) throw new Error("Failed to create Hermes assistant message");
    return serializeMessage(message);
  }

  async function attachRunToAssistantMessage(messageId: string, runId: string) {
    await db
      .update(hermesChatMessages)
      .set({ runId, status: "running", updatedAt: new Date() })
      .where(eq(hermesChatMessages.id, messageId));
  }

  async function markAssistantMessage(messageId: string, input: {
    body: string;
    status: HermesChatMessageStatus;
    runId?: string | null;
  }) {
    const [message] = await db
      .update(hermesChatMessages)
      .set({
        body: input.body,
        status: input.status,
        runId: input.runId ?? undefined,
        updatedAt: new Date(),
      })
      .where(eq(hermesChatMessages.id, messageId))
      .returning();
    if (!message) return null;
    await db
      .update(hermesChatSessions)
      .set({ updatedAt: new Date(), lastMessageAt: new Date() })
      .where(eq(hermesChatSessions.id, message.sessionId));
    return serializeMessage(message);
  }

  async function recentConversation(companyId: string, sessionId: string, limit = 12) {
    const rows = await db
      .select()
      .from(hermesChatMessages)
      .where(and(eq(hermesChatMessages.companyId, companyId), eq(hermesChatMessages.sessionId, sessionId)))
      .orderBy(desc(hermesChatMessages.createdAt))
      .limit(limit);
    return rows.reverse().map((row) => ({
      role: row.role,
      body: row.body,
      status: row.status,
      createdAt: toIso(row.createdAt),
    }));
  }

  async function finalizeRunResponse(runId: string) {
    const [run] = await db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        status: heartbeatRuns.status,
        resultJson: heartbeatRuns.resultJson,
        error: heartbeatRuns.error,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .limit(1);
    if (!run) return null;

    const context = asRecord(run.contextSnapshot);
    const chat = asRecord(context?.paperclipHermesChat);
    const assistantMessageId =
      typeof chat?.assistantMessageId === "string" && chat.assistantMessageId.trim()
        ? chat.assistantMessageId.trim()
        : null;
    if (!assistantMessageId) return null;

    const terminalStatus = run.status as HermesChatMessageStatus;
    return markAssistantMessage(assistantMessageId, {
      runId,
      status: terminalStatus,
      body: responseTextFromRun(run),
    });
  }

  return {
    findOperationsAgent,
    listSessions,
    createSession,
    getOrCreateTelegramSession,
    getSession,
    updateSession,
    addUserMessage,
    addAssistantPlaceholder,
    attachRunToAssistantMessage,
    markAssistantMessage,
    recentConversation,
    finalizeRunResponse,
  };
}

export async function finalizeHermesChatRun(db: Db, runId: string) {
  return hermesChatService(db).finalizeRunResponse(runId);
}
