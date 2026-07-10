import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { accessRoutes } from "../routes/access.js";

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  searchAvailableUsers: vi.fn(),
  addUserMember: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => ({}),
  boardAuthService: () => ({}),
  deduplicateAgentName: vi.fn((name: string) => name),
  logActivity: mockLogActivity,
  notifyHireApproved: vi.fn(),
}));

function createApp(actor: Record<string, unknown> = localImplicitActor()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use(
    "/api",
    accessRoutes({} as never, {
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }),
  );
  app.use(errorHandler);
  return app;
}

function localImplicitActor() {
  return {
    type: "board",
    userId: "local-board",
    companyIds: ["company-1"],
    source: "local_implicit",
    isInstanceAdmin: false,
  };
}

function boardActorWithPermission() {
  return {
    type: "board",
    userId: "user-1",
    companyIds: ["company-1"],
    source: "session",
    isInstanceAdmin: false,
  };
}

const COMPANY = "company-1";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("member picker routes", () => {
  it("searches available auth users with users:manage_permissions", async () => {
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.searchAvailableUsers.mockResolvedValue([
      { id: "user-2", name: "Candidate Cora", email: "candidate@example.com" },
    ]);
    const res = await request(await createApp(boardActorWithPermission())).get(
      `/api/companies/${COMPANY}/users/search?q=candidate&limit=99`,
    );
    expect(res.status).toBe(200);
    expect(mockAccessService.searchAvailableUsers).toHaveBeenCalledWith(COMPANY, "candidate", 25);
    expect(res.body).toEqual([
      { id: "user-2", name: "Candidate Cora", email: "candidate@example.com" },
    ]);
  });

  it("rejects available user search without users:manage_permissions", async () => {
    mockAccessService.canUser.mockResolvedValue(false);
    const res = await request(await createApp(boardActorWithPermission())).get(
      `/api/companies/${COMPANY}/users/search?q=candidate`,
    );
    expect(res.status).toBe(403);
    expect(mockAccessService.searchAvailableUsers).not.toHaveBeenCalled();
  });

  it("adds a known auth user as a member and logs activity", async () => {
    mockAccessService.addUserMember.mockResolvedValue({
      change: "created",
      membership: {
        id: "member-2",
        companyId: COMPANY,
        principalType: "user",
        principalId: "user-2",
        status: "active",
        membershipRole: "member",
      },
    });
    const res = await request(await createApp(localImplicitActor()))
      .post(`/api/companies/${COMPANY}/members`)
      .send({ userId: "user-2" });
    expect(res.status).toBe(201);
    expect(mockAccessService.addUserMember).toHaveBeenCalledWith(COMPANY, "user-2");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "company_member.added",
        entityType: "company_membership",
        entityId: "member-2",
      }),
    );
  });

  it("returns an existing active membership without duplicating activity", async () => {
    mockAccessService.addUserMember.mockResolvedValue({
      change: "unchanged",
      membership: {
        id: "member-2",
        companyId: COMPANY,
        principalType: "user",
        principalId: "user-2",
        status: "active",
        membershipRole: "member",
      },
    });
    const res = await request(await createApp(localImplicitActor()))
      .post(`/api/companies/${COMPANY}/members`)
      .send({ userId: "user-2" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ id: "member-2", principalId: "user-2" }));
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("returns 404 when adding an unknown auth user", async () => {
    mockAccessService.addUserMember.mockResolvedValue(null);
    const res = await request(await createApp(localImplicitActor()))
      .post(`/api/companies/${COMPANY}/members`)
      .send({ userId: "missing-user" });
    expect(res.status).toBe(404);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});
