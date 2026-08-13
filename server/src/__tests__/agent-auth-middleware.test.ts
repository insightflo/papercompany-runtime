import { createHash } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { activityLog, agentApiKeys, agents, authUsers, boardApiKeys, companyMemberships } from "@paperclipai/db";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function fakeDb(input: {
  agent: Record<string, unknown>;
  key?: Record<string, unknown> | null;
  users?: Record<string, unknown>[];
  memberships?: Record<string, unknown>[];
}) {
  const activity: Record<string, unknown>[] = [];
  const rows = new Map<unknown, Record<string, unknown>[]>([
    [boardApiKeys, []],
    [agents, [input.agent]],
    [agentApiKeys, input.key ? [input.key] : []],
    [authUsers, input.users ?? []],
    [companyMemberships, input.memberships ?? []],
  ]);
  const db = {
    select: () => ({
      from(table: unknown) {
        return { where: async () => rows.get(table) ?? [] };
      },
    }),
    update: () => ({ set: () => ({ where: async () => [] }) }),
    insert: (table: unknown) => ({
      values: async (value: Record<string, unknown>) => {
        if (table === activityLog) activity.push(value);
        return [];
      },
    }),
  } as any;
  return { db, activity };
}

function appFor(db: any) {
  const app = express();
  app.use(express.json());
  app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
  app.get("/actor", (req, res) => res.json(req.actor));
  app.use(errorHandler);
  return app;
}

describe("agent auth middleware", () => {
  it("rejects a run header that disagrees with the signed JWT and writes an audit event", async () => {
    const companyId = "company-1";
    const agentId = "agent-1";
    const runId = "run-1";
    const { db, activity } = fakeDb({ agent: { id: agentId, companyId, status: "active" } });
    const token = createLocalAgentJwt(agentId, companyId, "pi_local", runId, "user-1");

    const response = await request(appFor(db))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", "run-spoofed");

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ details: { code: "agent_jwt_run_id_mismatch" } });
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      action: "auth.agent_jwt_run_header_mismatch",
      details: { claimRunId: runId, headerRunId: "run-spoofed" },
    });
  });

  it("fails closed when an agent API key has no responsible user binding", async () => {
    const token = "agent-key";
    const { db } = fakeDb({
      agent: { id: "agent-1", companyId: "company-1", status: "active" },
      key: {
        id: "key-1",
        agentId: "agent-1",
        companyId: "company-1",
        keyHash: hashToken(token),
        revokedAt: null,
        responsibleUserId: null,
        scopeConfig: null,
      },
    });

    const response = await request(appFor(db))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ details: { code: "RESPONSIBLE_USER_UNAVAILABLE" } });
  });

  it("resolves the responsible user and key scope for an agent API key", async () => {
    const token = "agent-key";
    const { db } = fakeDb({
      agent: { id: "agent-1", companyId: "company-1", status: "active" },
      key: {
        id: "key-1",
        agentId: "agent-1",
        companyId: "company-1",
        keyHash: hashToken(token),
        revokedAt: null,
        responsibleUserId: "user-1",
        scopeConfig: { kind: "skill_test", issueId: "issue-1" },
      },
      users: [{ id: "user-1" }],
      memberships: [{ companyId: "company-1", principalId: "user-1", status: "active" }],
    });

    const response = await request(appFor(db))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      type: "agent",
      onBehalfOfUserId: "user-1",
      keyScope: { kind: "skill_test", issueId: "issue-1" },
    });
  });
});
