import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authUsers,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
  permissionGroupMembers,
  permissionGroups,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { accessService } from "../services/access.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(`Skipping access-service integration tests: ${support.reason ?? "unsupported environment"}`);
}

describeDb("accessService.canUser - group-aware permission resolution", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let access: ReturnType<typeof accessService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-access-service-");
    db = createDb(tempDb.connectionString);
    access = accessService(db);
  }, 60_000);

  afterAll(async () => {
    await db.$client.end({ timeout: 5 }); await tempDb?.cleanup();
  });

  async function setupCompany(): Promise<string> {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Access Co ${companyId.slice(0, 8)}`,
      issuePrefix: `AC${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      timezone: "UTC",
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function addActiveUserMember(companyId: string, userId: string): Promise<void> {
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
    });
  }

  async function addAuthUser(userId: string, name: string, email: string): Promise<void> {
    await db.insert(authUsers).values({
      id: userId,
      name,
      email,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  async function addDirectGrant(companyId: string, userId: string, key: string): Promise<void> {
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "user",
      principalId: userId,
      permissionKey: key,
    });
  }

  async function createGroup(companyId: string, name: string, status = "active"): Promise<{ id: string }> {
    const [row] = await db
      .insert(permissionGroups)
      .values({ companyId, name, status })
      .returning({ id: permissionGroups.id });
    return row;
  }

  async function addGroupMember(
    companyId: string,
    groupId: string,
    userId: string,
    status = "active",
  ): Promise<void> {
    await db.insert(permissionGroupMembers).values({ companyId, groupId, userId, status });
  }

  async function addGroupGrant(companyId: string, groupId: string, key: string): Promise<void> {
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "group",
      principalId: groupId,
      permissionKey: key,
    });
  }

  it("direct user grant passes", async () => {
    const companyId = await setupCompany();
    const userId = randomUUID();
    await addActiveUserMember(companyId, userId);
    await addDirectGrant(companyId, userId, "agents:create");
    expect(await access.canUser(companyId, userId, "agents:create")).toBe(true);
  });

  it("no grant fails", async () => {
    const companyId = await setupCompany();
    const userId = randomUUID();
    await addActiveUserMember(companyId, userId);
    expect(await access.canUser(companyId, userId, "agents:create")).toBe(false);
  });

  it("group grant is inherited via active membership", async () => {
    const companyId = await setupCompany();
    const userId = randomUUID();
    await addActiveUserMember(companyId, userId);
    const group = await createGroup(companyId, "editors");
    await addGroupMember(companyId, group.id, userId);
    await addGroupGrant(companyId, group.id, "agents:create");
    expect(await access.canUser(companyId, userId, "agents:create")).toBe(true);
  });

  it("removing a user from a group removes the inherited permission", async () => {
    const companyId = await setupCompany();
    const userId = randomUUID();
    await addActiveUserMember(companyId, userId);
    const group = await createGroup(companyId, "editors");
    await addGroupMember(companyId, group.id, userId);
    await addGroupGrant(companyId, group.id, "agents:create");
    await db
      .delete(permissionGroupMembers)
      .where(
        and(eq(permissionGroupMembers.groupId, group.id), eq(permissionGroupMembers.userId, userId)),
      );
    expect(await access.canUser(companyId, userId, "agents:create")).toBe(false);
  });

  it("a suspended group member does not inherit the group grant", async () => {
    const companyId = await setupCompany();
    const userId = randomUUID();
    await addActiveUserMember(companyId, userId);
    const group = await createGroup(companyId, "editors");
    await addGroupMember(companyId, group.id, userId, "suspended");
    await addGroupGrant(companyId, group.id, "agents:create");
    expect(await access.canUser(companyId, userId, "agents:create")).toBe(false);
  });

  it("a suspended group does not grant", async () => {
    const companyId = await setupCompany();
    const userId = randomUUID();
    await addActiveUserMember(companyId, userId);
    const group = await createGroup(companyId, "editors", "suspended");
    await addGroupMember(companyId, group.id, userId);
    await addGroupGrant(companyId, group.id, "agents:create");
    expect(await access.canUser(companyId, userId, "agents:create")).toBe(false);
  });

  it("instance_admin bypasses grant checks", async () => {
    const companyId = await setupCompany();
    const userId = randomUUID();
    await addActiveUserMember(companyId, userId);
    await db.insert(instanceUserRoles).values({ userId, role: "instance_admin" });
    expect(await access.canUser(companyId, userId, "agents:create")).toBe(true);
  });

  it("a cross-company group grant does not leak into another company", async () => {
    const companyA = await setupCompany();
    const companyB = await setupCompany();
    const userId = randomUUID();
    await addActiveUserMember(companyA, userId);
    const groupB = await createGroup(companyB, "b-editors");
    await addGroupMember(companyB, groupB.id, userId);
    await addGroupGrant(companyB, groupB.id, "agents:create");
    expect(await access.canUser(companyA, userId, "agents:create")).toBe(false);
  });

  it("a user without an active company membership is denied (rule 3)", async () => {
    const companyId = await setupCompany();
    const userId = randomUUID();
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "suspended",
    });
    const group = await createGroup(companyId, "editors");
    await addGroupMember(companyId, group.id, userId);
    await addGroupGrant(companyId, group.id, "agents:create");
    expect(await access.canUser(companyId, userId, "agents:create")).toBe(false);
  });

  it("searches auth users who do not already have active company membership", async () => {
    const companyId = await setupCompany();
    const activeUserId = randomUUID();
    const suspendedUserId = randomUUID();
    const candidateUserId = randomUUID();
    const searchToken = `picker-${randomUUID()}`;
    await addAuthUser(activeUserId, "Active Alice", `active@${searchToken}.test`);
    await addAuthUser(suspendedUserId, "Suspended Sam", `suspended@${searchToken}.test`);
    await addAuthUser(candidateUserId, "Candidate Cora", `candidate@${searchToken}.test`);
    await addActiveUserMember(companyId, activeUserId);
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: suspendedUserId,
      status: "suspended",
    });

    const results = await access.searchAvailableUsers(companyId, searchToken, 10);

    expect(results.map((user) => user.id)).toEqual([candidateUserId, suspendedUserId]);
    expect(results[0]).toEqual({
      id: candidateUserId,
      name: "Candidate Cora",
      email: `candidate@${searchToken}.test`,
    });
  });

  it("adds or reactivates a company user membership only for known auth users", async () => {
    const companyId = await setupCompany();
    const userId = randomUUID();
    await addAuthUser(userId, "Reactivated Robin", "robin@example.com");
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "suspended",
      membershipRole: "member",
    });

    const reactivated = await access.addUserMember(companyId, userId);
    const unchanged = await access.addUserMember(companyId, userId);
    const unknown = await access.addUserMember(companyId, randomUUID());

    expect(reactivated).toEqual({
      change: "reactivated",
      membership: expect.objectContaining({
        companyId,
        principalType: "user",
        principalId: userId,
        status: "active",
        membershipRole: "member",
      }),
    });
    expect(unchanged).toEqual({
      change: "unchanged",
      membership: expect.objectContaining({ principalId: userId, status: "active" }),
    });
    expect(unknown).toBeNull();
  });

  it("creates one membership for repeated add requests", async () => {
    const companyId = await setupCompany();
    const userId = randomUUID();
    await addAuthUser(userId, "New Nora", "nora@example.com");

    const created = await access.addUserMember(companyId, userId);
    const repeated = await access.addUserMember(companyId, userId);

    expect(created?.change).toBe("created");
    expect(repeated?.change).toBe("unchanged");
    const rows = await db
      .select()
      .from(companyMemberships)
      .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, userId)));
    expect(rows).toHaveLength(1);
  });

  it("keeps an active membership role unchanged when the user is added again", async () => {
    const companyId = await setupCompany();
    const userId = randomUUID();
    await addAuthUser(userId, "Owner Olivia", "owner@example.com");
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "owner",
    });

    const result = await access.addUserMember(companyId, userId);

    expect(result).toEqual({
      change: "unchanged",
      membership: expect.objectContaining({
        principalId: userId,
        status: "active",
        membershipRole: "owner",
      }),
    });
  });

  it("reactivates a suspended membership once under concurrent add requests", async () => {
    const companyId = await setupCompany();
    const userId = randomUUID();
    await addAuthUser(userId, "Concurrent Casey", "casey@example.com");
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "suspended",
      membershipRole: "owner",
    });

    const results = await Promise.all([
      access.addUserMember(companyId, userId),
      access.addUserMember(companyId, userId),
    ]);

    expect(results.map((result) => result?.change).sort()).toEqual(["reactivated", "unchanged"]);
    expect(results.every((result) => result?.membership.membershipRole === "owner")).toBe(true);
  });
});
