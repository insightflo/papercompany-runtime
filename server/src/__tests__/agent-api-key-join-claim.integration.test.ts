import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
  invites,
  joinRequests,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import type { DeploymentMode } from "@paperclipai/shared";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { accessRoutes } from "../routes/access.js";

const CLAIM_SECRET = "claim-secret-MUST-NOT-LEAK";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const issuePrefix = () => `J${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`;

type ApprovalBinding = "member" | "admin" | "missing" | "foreign" | "suspended";

describe("agent join API-key claim responsibility", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("agent-key-join-claim-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(deploymentMode: DeploymentMode) {
    const instance = express();
    instance.use(express.json());
    instance.use(actorMiddleware(db, { deploymentMode, resolveSession: async () => null }));
    instance.use("/api", accessRoutes(db, {
      deploymentMode,
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }));
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

  async function addUser(userId: string) {
    const now = new Date();
    await db.insert(authUsers).values({
      id: userId,
      name: userId,
      email: `${userId}@paperclip.local`,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing();
  }

  async function seed(input: {
    approverId: string;
    binding?: ApprovalBinding;
    approvedAt?: Date | null;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const inviteId = randomUUID();
    const requestId = randomUUID();
    const binding = input.binding ?? "member";
    await db.insert(companies).values({ id: companyId, name: "Join company", issuePrefix: issuePrefix() });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Join agent ${agentId.slice(0, 6)}`,
      role: "engineer",
      status: "active",
      adapterType: "pi_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(invites).values({
      id: inviteId,
      companyId,
      tokenHash: hash(`invite-${inviteId}`),
      allowedJoinTypes: "agent",
      expiresAt: new Date(Date.now() + 60_000),
    });
    if (binding !== "missing") await addUser(input.approverId);
    if (binding === "member" || binding === "suspended") {
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: input.approverId,
        membershipRole: "owner",
        status: binding === "member" ? "active" : "suspended",
      });
    } else if (binding === "foreign") {
      const foreignCompanyId = randomUUID();
      await db.insert(companies).values({ id: foreignCompanyId, name: "Foreign", issuePrefix: issuePrefix() });
      await db.insert(companyMemberships).values({
        companyId: foreignCompanyId,
        principalType: "user",
        principalId: input.approverId,
        membershipRole: "owner",
        status: "active",
      });
    } else if (binding === "admin") {
      await db.insert(instanceUserRoles).values({ userId: input.approverId, role: "instance_admin" });
    }
    await db.insert(joinRequests).values({
      id: requestId,
      inviteId,
      companyId,
      requestType: "agent",
      status: "approved",
      requestIp: "127.0.0.1",
      claimSecretHash: hash(CLAIM_SECRET),
      claimSecretExpiresAt: new Date(Date.now() + 60_000),
      createdAgentId: agentId,
      approvedByUserId: input.approverId,
      approvedAt: input.approvedAt === undefined ? new Date() : input.approvedAt,
    });
    return { companyId, agentId, requestId, approverId: input.approverId };
  }

  async function claim(mode: DeploymentMode, requestId: string) {
    return request(app(mode))
      .post(`/api/join-requests/${requestId}/claim-api-key`)
      .send({ claimSecret: CLAIM_SECRET });
  }

  async function assertRejectedWithoutMutation(mode: DeploymentMode, fixture: Awaited<ReturnType<typeof seed>>) {
    const response = await claim(mode, fixture.requestId);
    expect(response.status).toBe(403);
    expect(JSON.stringify(response.body)).not.toContain(CLAIM_SECRET);
    const [row] = await db.select().from(joinRequests).where(eq(joinRequests.id, fixture.requestId));
    expect(row?.claimSecretConsumedAt).toBeNull();
    expect(await db.select().from(agentApiKeys).where(eq(agentApiKeys.agentId, fixture.agentId))).toHaveLength(0);
    const activities = await db.select().from(activityLog).where(eq(activityLog.companyId, fixture.companyId));
    expect(JSON.stringify(activities.map((item) => item.details))).not.toContain(CLAIM_SECRET);
  }

  it("claims a local approval, binds local-board, and authenticates the token", async () => {
    const fixture = await seed({ approverId: "local-board" });
    const response = await claim("local_trusted", fixture.requestId);

    expect(response.status).toBe(201);
    expect(JSON.stringify(response.body)).not.toContain(CLAIM_SECRET);
    const [createdRow] = await db.select().from(agentApiKeys).where(eq(agentApiKeys.agentId, fixture.agentId));
    expect(createdRow?.responsibleUserId).toBe("local-board");
    const authResponse = await request(authApp())
      .get("/actor")
      .set("Authorization", `Bearer ${response.body.token}`);
    expect(authResponse.body).toMatchObject({ type: "agent", agentId: fixture.agentId, companyId: fixture.companyId });
    const activities = await db.select().from(activityLog).where(eq(activityLog.entityId, response.body.keyId));
    expect(JSON.stringify(activities.map((item) => item.details))).not.toContain(CLAIM_SECRET);
  });

  it("rejects historical local-board approval in authenticated deployment", async () => {
    await assertRejectedWithoutMutation("authenticated", await seed({ approverId: "local-board" }));
  });

  it("rejects local approval without an approval timestamp", async () => {
    await assertRejectedWithoutMutation("local_trusted", await seed({ approverId: "local-board", approvedAt: null }));
  });

  it.each<[ApprovalBinding]>([["missing"], ["foreign"], ["suspended"]])(
    "rejects an approver with %s binding",
    async (binding) => {
      await assertRejectedWithoutMutation("authenticated", await seed({ approverId: `approver-${randomUUID()}`, binding }));
    },
  );

  it.each<[ApprovalBinding]>([["member"], ["admin"]])(
    "allows an actual authenticated approver with %s authority",
    async (binding) => {
      const fixture = await seed({ approverId: `approver-${randomUUID()}`, binding });
      const response = await claim("authenticated", fixture.requestId);
      expect(response.status).toBe(201);
      const [createdRow] = await db.select().from(agentApiKeys).where(eq(agentApiKeys.agentId, fixture.agentId));
      expect(createdRow?.responsibleUserId).toBe(fixture.approverId);
      const authResponse = await request(authApp()).get("/actor").set("Authorization", `Bearer ${response.body.token}`);
      expect(authResponse.body).toMatchObject({ type: "agent", agentId: fixture.agentId, companyId: fixture.companyId });
    },
  );
});
