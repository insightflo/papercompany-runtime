import { createHash } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import type { Duplex } from "node:stream";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentApiKeys, companyMemberships, heartbeatRunEvents, instanceUserRoles } from "@paperclipai/db";
import type { DeploymentMode, LiveEvent } from "@paperclipai/shared";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { logger } from "../middleware/logger.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";

interface WsSocket {
  readyState: number;
  ping(): void;
  send(data: string): void;
  terminate(): void;
  close(code?: number, reason?: string): void;
  on(event: "pong", listener: () => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
}

interface WsServer {
  clients: Set<WsSocket>;
  on(event: "connection", listener: (socket: WsSocket, req: IncomingMessage) => void): void;
  on(event: "close", listener: () => void): void;
  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (ws: WsSocket) => void,
  ): void;
  emit(event: "connection", ws: WsSocket, req: IncomingMessage): boolean;
}

const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require("ws") as {
  WebSocket: { OPEN: number };
  WebSocketServer: new (opts: { noServer: boolean }) => WsServer;
};

interface UpgradeContext {
  companyId: string;
  actorType: "board" | "agent";
  actorId: string;
  heartbeatReplayCursors: HeartbeatReplayCursor[];
}

interface IncomingMessageWithContext extends IncomingMessage {
  paperclipUpgradeContext?: UpgradeContext;
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function rejectUpgrade(socket: Duplex, statusLine: string, message: string) {
  const safe = message.replace(/[\r\n]+/g, " ").trim();
  socket.write(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${safe}`);
  socket.destroy();
}

function parseCompanyId(pathname: string) {
  const match = pathname.match(/^\/api\/companies\/([^/]+)\/events\/ws$/);
  if (!match) return null;

  try {
    return decodeURIComponent(match[1] ?? "");
  } catch {
    return null;
  }
}

export interface HeartbeatReplayCursor {
  runId: string;
  afterSeq: number;
}

interface HeartbeatRunEventForReplay {
  id: number;
  companyId: string;
  runId: string;
  agentId: string;
  seq: number;
  eventType: string;
  stream: string | null;
  level: string | null;
  color: string | null;
  message: string | null;
  payload: Record<string, unknown> | null | undefined;
  createdAt: Date;
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

function heartbeatRunEventToLiveEvent(event: HeartbeatRunEventForReplay): LiveEvent {
  return {
    id: event.id,
    companyId: event.companyId,
    type: "heartbeat.run.event",
    createdAt: event.createdAt.toISOString(),
    payload: {
      runId: event.runId,
      agentId: event.agentId,
      seq: event.seq,
      eventType: event.eventType,
      stream: event.stream ?? null,
      level: event.level ?? null,
      color: event.color ?? null,
      message: event.message ?? null,
      payload: event.payload ?? null,
      replay: true,
    },
  };
}

export async function replayHeartbeatRunEvents(options: {
  companyId: string;
  cursors: HeartbeatReplayCursor[];
  listEvents: (runId: string, afterSeq: number, limit: number) => Promise<HeartbeatRunEventForReplay[]>;
  send: (event: LiveEvent) => void;
}): Promise<number> {
  let sent = 0;
  for (const cursor of options.cursors) {
    const events = await options.listEvents(cursor.runId, cursor.afterSeq, 250);
    for (const event of events) {
      if (event.companyId !== options.companyId) continue;
      options.send(heartbeatRunEventToLiveEvent(event));
      sent += 1;
    }
  }
  return sent;
}

async function listHeartbeatRunEventsForReplay(
  db: Db,
  companyId: string,
  runId: string,
  afterSeq: number,
  limit: number,
) {
  return db
    .select()
    .from(heartbeatRunEvents)
    .where(
      and(
        eq(heartbeatRunEvents.companyId, companyId),
        eq(heartbeatRunEvents.runId, runId),
        gt(heartbeatRunEvents.seq, afterSeq),
      ),
    )
    .orderBy(asc(heartbeatRunEvents.seq))
    .limit(Math.max(1, Math.min(limit, 250)));
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

async function authorizeUpgrade(
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

  // Browser board context has no bearer token in local_trusted and authenticated modes.
  if (!token) {
    if (opts.deploymentMode === "local_trusted") {
      return {
        companyId,
        actorType: "board",
        actorId: "board",
        heartbeatReplayCursors: parseHeartbeatReplayCursors(url),
      };
    }

    if (opts.deploymentMode !== "authenticated" || !opts.resolveSessionFromHeaders) {
      return null;
    }

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

    const hasCompanyMembership = memberships.some((row) => row.companyId === companyId);
    if (!roleRow && !hasCompanyMembership) return null;

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

  if (!key || key.companyId !== companyId) {
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

export function setupLiveEventsWebSocketServer(
  server: HttpServer,
  db: Db,
  opts: {
    deploymentMode: DeploymentMode;
    resolveSessionFromHeaders?: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
  },
) {
  const wss = new WebSocketServer({ noServer: true });
  const cleanupByClient = new Map<WsSocket, () => void>();
  const aliveByClient = new Map<WsSocket, boolean>();

  const pingInterval = setInterval(() => {
    for (const socket of wss.clients) {
      if (!aliveByClient.get(socket)) {
        socket.terminate();
        continue;
      }
      aliveByClient.set(socket, false);
      socket.ping();
    }
  }, 30000);

  wss.on("connection", (socket: WsSocket, req: IncomingMessage) => {
    const context = (req as IncomingMessageWithContext).paperclipUpgradeContext;
    if (!context) {
      socket.close(1008, "missing context");
      return;
    }

    const unsubscribe = subscribeCompanyLiveEvents(context.companyId, (event) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify(event));
    });

    if (context.heartbeatReplayCursors.length > 0) {
      void replayHeartbeatRunEvents({
        companyId: context.companyId,
        cursors: context.heartbeatReplayCursors,
        listEvents: (runId, afterSeq, limit) =>
          listHeartbeatRunEventsForReplay(db, context.companyId, runId, afterSeq, limit),
        send: (event) => {
          if (socket.readyState !== WebSocket.OPEN) return;
          socket.send(JSON.stringify(event));
        },
      }).catch((err) => {
        logger.warn({ err, companyId: context.companyId }, "failed to replay heartbeat run events");
      });
    }

    cleanupByClient.set(socket, unsubscribe);
    aliveByClient.set(socket, true);

    socket.on("pong", () => {
      aliveByClient.set(socket, true);
    });

    socket.on("close", () => {
      const cleanup = cleanupByClient.get(socket);
      if (cleanup) cleanup();
      cleanupByClient.delete(socket);
      aliveByClient.delete(socket);
    });

    socket.on("error", (err: Error) => {
      logger.warn({ err, companyId: context.companyId }, "live websocket client error");
    });
  });

  wss.on("close", () => {
    clearInterval(pingInterval);
  });

  server.on("upgrade", (req, socket, head) => {
    if (!req.url) {
      rejectUpgrade(socket, "400 Bad Request", "missing url");
      return;
    }

    const url = new URL(req.url, "http://localhost");
    const companyId = parseCompanyId(url.pathname);
    if (!companyId) {
      socket.destroy();
      return;
    }

    void authorizeUpgrade(db, req, companyId, url, {
      deploymentMode: opts.deploymentMode,
      resolveSessionFromHeaders: opts.resolveSessionFromHeaders,
    })
      .then((context) => {
        if (!context) {
          rejectUpgrade(socket, "403 Forbidden", "forbidden");
          return;
        }

        const reqWithContext = req as IncomingMessageWithContext;
        reqWithContext.paperclipUpgradeContext = context;

        wss.handleUpgrade(req, socket, head, (ws: WsSocket) => {
          wss.emit("connection", ws, reqWithContext);
        });
      })
      .catch((err) => {
        logger.error({ err, path: req.url }, "failed websocket upgrade authorization");
        rejectUpgrade(socket, "500 Internal Server Error", "upgrade failed");
      });
  });

  return wss;
}
