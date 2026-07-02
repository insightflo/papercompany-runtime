import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accessRoutes } from "../routes/access.js";
import { errorHandler } from "../middleware/index.js";

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  listMembers: vi.fn(),
  listPrincipalGrants: vi.fn(),
  listGroups: vi.fn(),
  createGroup: vi.fn(),
  getGroup: vi.fn(),
  updateGroup: vi.fn(),
  deleteGroup: vi.fn(),
  listGroupMembers: vi.fn(),
  updateGroupMembers: vi.fn(),
  listUserGroupMemberships: vi.fn(),
  setPrincipalGrants: vi.fn(),
  setMemberPermissions: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({}));
const mockBoardAuthService = vi.hoisted(() => ({}));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  boardAuthService: () => mockBoardAuthService,
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
const GROUP = "group-1";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("permission-groups routes", () => {
  it("rejects group creation without users:manage_permissions (403)", async () => {
    mockAccessService.canUser.mockResolvedValue(false);
    const res = await request(createApp(boardActorWithPermission()))
      .post(`/api/companies/${COMPANY}/permission-groups`)
      .send({ name: "editors" });
    expect(res.status).toBe(403);
    expect(mockAccessService.createGroup).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("creates a group and logs activity when local_implicit bypasses", async () => {
    mockAccessService.createGroup.mockResolvedValue({ id: GROUP, name: "editors", companyId: COMPANY });
    const res = await request(createApp(localImplicitActor()))
      .post(`/api/companies/${COMPANY}/permission-groups`)
      .send({ name: "editors" });
    expect(res.status).toBe(201);
    expect(mockAccessService.createGroup).toHaveBeenCalledWith(
      COMPANY,
      expect.objectContaining({ name: "editors" }),
    );
    // local_implicit bypasses canUser, so the gate must not consult grants.
    expect(mockAccessService.canUser).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "permission_group.created", entityId: GROUP }),
    );
  });

  it("returns 404 for a cross-company group on PATCH (scoped update yields null)", async () => {
    mockAccessService.updateGroup.mockResolvedValue(null);
    const res = await request(createApp(localImplicitActor()))
      .patch(`/api/companies/${COMPANY}/permission-groups/${GROUP}`)
      .send({ name: "renamed" });
    expect(res.status).toBe(404);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("returns 404 for a cross-company group on DELETE (scoped delete yields false)", async () => {
    mockAccessService.deleteGroup.mockResolvedValue(false);
    const res = await request(createApp(localImplicitActor()))
      .delete(`/api/companies/${COMPANY}/permission-groups/${GROUP}`);
    expect(res.status).toBe(404);
  });

  it("returns 404 when adding members to a group not in this company", async () => {
    mockAccessService.getGroup.mockResolvedValue(null);
    const res = await request(createApp(localImplicitActor()))
      .put(`/api/companies/${COMPANY}/permission-groups/${GROUP}/members`)
      .send({ addUserIds: ["user-2"] });
    expect(res.status).toBe(404);
    expect(mockAccessService.updateGroupMembers).not.toHaveBeenCalled();
  });

  it("updates group grants, calls setPrincipalGrants with principalType group, and logs", async () => {
    mockAccessService.getGroup.mockResolvedValue({ id: GROUP, companyId: COMPANY });
    mockAccessService.listPrincipalGrants.mockResolvedValue([
      { permissionKey: "agents:create", principalType: "group", principalId: GROUP },
    ]);
    const res = await request(createApp(localImplicitActor()))
      .patch(`/api/companies/${COMPANY}/permission-groups/${GROUP}/permissions`)
      .send({ grants: [{ permissionKey: "agents:create" }] });
    expect(res.status).toBe(200);
    expect(mockAccessService.setPrincipalGrants).toHaveBeenCalledWith(
      COMPANY,
      "group",
      GROUP,
      expect.arrayContaining([expect.objectContaining({ permissionKey: "agents:create" })]),
      "local-board",
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "permission_group.grants_updated" }),
    );
  });

  it("enriches GET /members with grants and group memberships", async () => {
    mockAccessService.listMembers.mockResolvedValue([
      { id: "m1", principalType: "user", principalId: "user-1" },
    ]);
    mockAccessService.listPrincipalGrants.mockResolvedValue([{ permissionKey: "agents:create" }]);
    mockAccessService.listUserGroupMemberships.mockResolvedValue([{ groupId: GROUP, status: "active" }]);
    const res = await request(createApp(localImplicitActor())).get(`/api/companies/${COMPANY}/members`);
    expect(res.status).toBe(200);
    expect(res.body[0]).toEqual(
      expect.objectContaining({
        principalId: "user-1",
        grants: [{ permissionKey: "agents:create" }],
        groupMemberships: [{ groupId: GROUP, status: "active" }],
      }),
    );
  });

  it("creates a group when the actor is instance_admin without consulting grants", async () => {
    // instance_admin is a route-level bypass in assertCompanyPermission (distinct from local_implicit),
    // so canUser must not be consulted.
    mockAccessService.createGroup.mockResolvedValue({ id: GROUP, name: "editors", companyId: COMPANY });
    const actor = {
      type: "board",
      userId: "admin-1",
      companyIds: [COMPANY],
      source: "session",
      isInstanceAdmin: true,
    };
    const res = await request(createApp(actor))
      .post(`/api/companies/${COMPANY}/permission-groups`)
      .send({ name: "editors" });
    expect(res.status).toBe(201);
    expect(mockAccessService.canUser).not.toHaveBeenCalled();
    expect(mockAccessService.createGroup).toHaveBeenCalled();
  });

  it("lists groups (smoke)", async () => {
    mockAccessService.listGroups.mockResolvedValue([
      { id: GROUP, companyId: COMPANY, name: "editors", status: "active" },
    ]);
    const res = await request(createApp(localImplicitActor())).get(
      `/api/companies/${COMPANY}/permission-groups`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: GROUP, companyId: COMPANY, name: "editors", status: "active" }]);
  });

  it("returns group detail with members and grants (smoke)", async () => {
    mockAccessService.getGroup.mockResolvedValue({ id: GROUP, companyId: COMPANY, name: "editors" });
    mockAccessService.listGroupMembers.mockResolvedValue([
      { id: "mem-1", groupId: GROUP, userId: "user-1", status: "active" },
    ]);
    mockAccessService.listPrincipalGrants.mockResolvedValue([
      { permissionKey: "agents:create", principalType: "group", principalId: GROUP },
    ]);
    const res = await request(createApp(localImplicitActor())).get(
      `/api/companies/${COMPANY}/permission-groups/${GROUP}`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        id: GROUP,
        members: [{ id: "mem-1", groupId: GROUP, userId: "user-1", status: "active" }],
        grants: [{ permissionKey: "agents:create", principalType: "group", principalId: GROUP }],
      }),
    );
  });
});
