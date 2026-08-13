import type { IncomingMessage, Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import type { Duplex } from "node:stream";
import { and, asc, eq, gt } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRunEvents } from "@paperclipai/db";
import type { DeploymentMode, LiveEvent } from "@paperclipai/shared";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { logger } from "../middleware/logger.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import {
  authorizeUpgrade,
  parseHeartbeatReplayCursors,
  type HeartbeatReplayCursor,
  type UpgradeContext,
} from "./live-events-auth.js";

export { authorizeUpgrade, parseHeartbeatReplayCursors } from "./live-events-auth.js";
export type { HeartbeatReplayCursor, UpgradeContext } from "./live-events-auth.js";

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

interface IncomingMessageWithContext extends IncomingMessage {
  paperclipUpgradeContext?: UpgradeContext;
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
