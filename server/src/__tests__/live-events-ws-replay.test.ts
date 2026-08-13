import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { agentApiKeys, agents, authUsers, companyMemberships } from "@paperclipai/db";
import {
  authorizeUpgrade,
  parseHeartbeatReplayCursors,
  replayHeartbeatRunEvents,
} from "../realtime/live-events-ws.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function fakeAuthDb(input: {
  key: Record<string, unknown>;
  agent: Record<string, unknown>;
  user?: Record<string, unknown>;
  membership?: Record<string, unknown>;
}) {
  const rows = new Map<unknown, Record<string, unknown>[]>([
    [agentApiKeys, [input.key]],
    [agents, [input.agent]],
    [authUsers, input.user ? [input.user] : []],
    [companyMemberships, input.membership ? [input.membership] : []],
  ]);
  return {
    select: () => ({
      from(table: unknown) {
        return { where: async () => rows.get(table) ?? [] };
      },
    }),
    update: () => ({ set: () => ({ where: async () => [] }) }),
  } as any;
}

function authRequest(token: string) {
  return { headers: { authorization: `Bearer ${token}` } } as IncomingMessage;
}

describe("live websocket authorization", () => {
  it("rejects an agent key without a valid responsible user binding", async () => {
    const token = "agent-key";
    const result = await authorizeUpgrade(
      fakeAuthDb({
        key: {
          id: "key-1",
          agentId: "agent-1",
          companyId: "company-1",
          keyHash: hashToken(token),
          revokedAt: null,
          responsibleUserId: null,
        },
        agent: { id: "agent-1", companyId: "company-1", status: "active" },
      }),
      authRequest(token),
      "company-1",
      new URL("http://localhost/api/companies/company-1/events/ws"),
      { deploymentMode: "authenticated" },
    );

    expect(result).toBeNull();
  });

  it("authorizes an active agent key with an active company member responsible user", async () => {
    const token = "agent-key";
    const result = await authorizeUpgrade(
      fakeAuthDb({
        key: {
          id: "key-1",
          agentId: "agent-1",
          companyId: "company-1",
          keyHash: hashToken(token),
          revokedAt: null,
          responsibleUserId: "user-1",
        },
        agent: { id: "agent-1", companyId: "company-1", status: "active" },
        user: { id: "user-1" },
        membership: {
          companyId: "company-1",
          principalType: "user",
          principalId: "user-1",
          membershipRole: "member",
          status: "active",
        },
      }),
      authRequest(token),
      "company-1",
      new URL("http://localhost/api/companies/company-1/events/ws?heartbeatRun=run-1:2"),
      { deploymentMode: "authenticated" },
    );

    expect(result).toEqual({
      companyId: "company-1",
      actorType: "agent",
      actorId: "agent-1",
      heartbeatReplayCursors: [{ runId: "run-1", afterSeq: 2 }],
    });
  });
});

describe("live websocket heartbeat run replay", () => {
  it("parses repeated heartbeatRun replay cursors from the websocket URL", () => {
    const url = new URL(
      "http://localhost/api/companies/company-1/events/ws?heartbeatRun=run-1:3&heartbeatRun=run-2:0&heartbeatRun=bad&heartbeatRun=run-3:not-a-number",
    );

    expect(parseHeartbeatReplayCursors(url)).toEqual([
      { runId: "run-1", afterSeq: 3 },
      { runId: "run-2", afterSeq: 0 },
      { runId: "run-3", afterSeq: 0 },
    ]);
  });

  it("replays durable heartbeat run events after the requested seq and skips other companies", async () => {
    const sent: unknown[] = [];

    const count = await replayHeartbeatRunEvents({
      companyId: "company-1",
      cursors: [
        { runId: "run-1", afterSeq: 1 },
        { runId: "run-2", afterSeq: 0 },
      ],
      listEvents: async (runId, afterSeq) => {
        if (runId === "run-1") {
          expect(afterSeq).toBe(1);
          return [
            {
              id: 10,
              companyId: "company-1",
              runId: "run-1",
              agentId: "agent-1",
              seq: 2,
              eventType: "progress",
              stream: "system",
              level: "info",
              color: null,
              message: "second event",
              payload: { ok: true },
              createdAt: new Date("2026-04-25T14:00:00.000Z"),
            },
            {
              id: 11,
              companyId: "other-company",
              runId: "run-1",
              agentId: "agent-1",
              seq: 3,
              eventType: "progress",
              stream: "system",
              level: "info",
              color: null,
              message: "wrong company",
              payload: {},
              createdAt: new Date("2026-04-25T14:00:01.000Z"),
            },
          ];
        }
        return [];
      },
      send: (event) => sent.push(event),
    });

    expect(count).toBe(1);
    expect(sent).toEqual([
      {
        id: 10,
        companyId: "company-1",
        type: "heartbeat.run.event",
        createdAt: "2026-04-25T14:00:00.000Z",
        payload: {
          runId: "run-1",
          agentId: "agent-1",
          seq: 2,
          eventType: "progress",
          stream: "system",
          level: "info",
          color: null,
          message: "second event",
          payload: { ok: true },
          replay: true,
        },
      },
    ]);
  });
});
