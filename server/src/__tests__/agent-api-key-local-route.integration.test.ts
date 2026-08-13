import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { agentRoutes } from "../routes/agents.js";

type Actor = Express.Request["actor"];

function issuePrefix() {
  return `K${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`;
}

describe("agent API-key local trusted route", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("agent-key-local-route-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentApiKeys);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(actor?: Actor) {
    const instance = express();
    instance.use(express.json());
    if (actor) {
      instance.use((req, _res, next) => {
        req.actor = actor;
        next();
      });
    } else {
      instance.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    }
    instance.use("/api", agentRoutes(db));
    instance.use(errorHandler);
    return instance;
  }

  function authApp() {
    const instance = express();
    instance.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    instance.get("/actor", (req, res) => res.json(req.actor));
    instance.use(errorHandler);
    return instance;
  }

  async function seed(status = "active", withLocalBoard = true) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Local key company",
      issuePrefix: issuePrefix(),
    });
    if (withLocalBoard) {
      const now = new Date();
      await db.insert(authUsers).values({
        id: "local-board",
        name: "Local Board",
        email: "local-board@paperclip.local",
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing();
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: "local-board",
        membershipRole: "owner",
        status: "active",
      });
    }
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Agent ${agentId.slice(0, 6)}`,
      role: "engineer",
      status,
      adapterType: "pi_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function keysFor(agentId: string) {
    return db.select().from(agentApiKeys).where(eq(agentApiKeys.agentId, agentId));
  }

  it("creates a local-board-bound key and authenticates the returned token", async () => {
    const { companyId, agentId } = await seed();

    const createResponse = await request(app())
      .post(`/api/agents/${agentId}/keys`)
      .send({ name: "local-key" });

    expect(createResponse.status).toBe(201);
    const [createdRow] = await keysFor(agentId);
    expect(createdRow?.responsibleUserId).toBe("local-board");
    const authResponse = await request(authApp())
      .get("/actor")
      .set("Authorization", `Bearer ${createResponse.body.token}`);
    expect(authResponse.body).toMatchObject({ type: "agent", agentId, companyId });
  });

  it("rejects a pseudo-local session actor even when its user ID is local-board", async () => {
    const { companyId, agentId } = await seed();
    const response = await request(app({
      type: "board",
      source: "session",
      userId: "local-board",
      isInstanceAdmin: true,
      companyIds: [companyId],
    })).post(`/api/agents/${agentId}/keys`).send({ name: "pseudo-local" });

    expect(response.status).toBe(403);
    expect(await keysFor(agentId)).toHaveLength(0);
  });

  it("rejects local issuance when the local-board user binding is absent", async () => {
    const { agentId } = await seed("active", false);
    expect(await db.select().from(authUsers).where(eq(authUsers.id, "local-board"))).toHaveLength(0);
    const response = await request(app())
      .post(`/api/agents/${agentId}/keys`)
      .send({ name: "missing-binding" });

    expect(response.status).toBe(403);
    expect(await keysFor(agentId)).toHaveLength(0);
  });

  it.each(["pending_approval", "terminated"])(
    "preserves the %s agent guard",
    async (status) => {
      const { agentId } = await seed(status);
      const response = await request(app())
        .post(`/api/agents/${agentId}/keys`)
        .send({ name: `${status}-key` });

      expect(response.status).toBe(409);
      expect(await keysFor(agentId)).toHaveLength(0);
    },
  );
});
