import { describe, expect, it } from "vitest";
import {
  agents as agentsTable,
  agentApiKeys,
  authUsers,
  companyMemberships,
  costEvents,
  instanceUserRoles,
} from "@paperclipai/db";
import { requireAgentApiKeyResponsibleUser } from "../services/agent-api-key-policy.js";
import { agentService } from "../services/agents.js";

const authenticated = { authority: "authenticated_user" } as const;
const localImplicit = { authority: "local_implicit_board" } as const;

type ResponsibleBinding =
  | "member"
  | "missing-user"
  | "foreign-company"
  | "suspended"
  | "admin"
  | "role-without-user";

function fakeDb(options: { responsibleBinding?: ResponsibleBinding } = {}) {
  const responsibleBinding = options.responsibleBinding ?? "member";
  const agent = {
    id: "agent-1",
    companyId: "company-1",
    name: "Agent One",
    role: "general",
    status: "idle",
    permissions: {},
    metadata: null,
  };
  const createdKey = {
    id: "key-1",
    name: "test-key",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    revokedAt: null,
  };

  return {
    select: () => ({
      from(table: unknown) {
        return {
          where() {
            if (table === agentsTable) return Promise.resolve([agent]);
            if (table === costEvents) return { groupBy: async () => [] };
            if (
              table === authUsers &&
              responsibleBinding !== "missing-user" &&
              responsibleBinding !== "role-without-user"
            ) {
              return Promise.resolve([{ id: "user-1" }]);
            }
            if (table === companyMemberships && responsibleBinding === "member") {
              return Promise.resolve([
                {
                  companyId: "company-1",
                  membershipRole: "member",
                  status: "active",
                },
              ]);
            }
            if (
              table === instanceUserRoles &&
              (responsibleBinding === "admin" || responsibleBinding === "role-without-user")
            ) {
              return Promise.resolve([{ id: "role-1" }]);
            }
            return Promise.resolve([]);
          },
        };
      },
    }),
    insert: (table: unknown) => ({
      values(value: Record<string, unknown>) {
        return {
          returning: async () => {
            if (table !== agentApiKeys) throw new Error("unexpected insert table");
            return [{ ...createdKey, ...value }];
          },
        };
      },
    }),
  } as any;
}

describe("agent API key responsibility policy", () => {
  it("rejects missing and local identities under authenticated-user authority", () => {
    expect(() => requireAgentApiKeyResponsibleUser(null, authenticated)).toThrowError(
      /real responsible user/i,
    );
    expect(() => requireAgentApiKeyResponsibleUser("local-board", authenticated)).toThrowError(
      /real responsible user/i,
    );
  });

  it("allows only local-board under local implicit authority", () => {
    expect(requireAgentApiKeyResponsibleUser("local-board", localImplicit)).toBe("local-board");
    expect(() => requireAgentApiKeyResponsibleUser("ordinary-user", localImplicit)).toThrowError(
      /local implicit/i,
    );
  });

  it("keeps a real responsible-user identity under authenticated-user authority", () => {
    expect(requireAgentApiKeyResponsibleUser(" user-1 ", authenticated)).toBe("user-1");
  });

  it("preserves the required-user error contract", () => {
    expect(() => requireAgentApiKeyResponsibleUser(null, authenticated)).toThrowError(
      expect.objectContaining({
        status: 403,
        details: { code: "RESPONSIBLE_USER_REQUIRED" },
      }),
    );
  });

  it("rejects creation without a responsible user", async () => {
    const service = agentService(fakeDb());

    await expect(
      service.createApiKey("agent-1", "test-key", null, authenticated),
    ).rejects.toMatchObject({
      status: 403,
      details: { code: "RESPONSIBLE_USER_REQUIRED" },
    });
  });

  it("rejects creation when the responsible user row is missing", async () => {
    const service = agentService(fakeDb({ responsibleBinding: "missing-user" }));

    await expect(
      service.createApiKey("agent-1", "test-key", "user-1", authenticated),
    ).rejects.toMatchObject({
      status: 403,
      details: { code: "RESPONSIBLE_USER_UNAVAILABLE" },
    });
  });

  it("rejects creation with only a foreign-company membership", async () => {
    const service = agentService(fakeDb({ responsibleBinding: "foreign-company" }));

    await expect(
      service.createApiKey("agent-1", "test-key", "user-1", authenticated),
    ).rejects.toMatchObject({
      status: 403,
      details: { code: "RESPONSIBLE_USER_UNAVAILABLE" },
    });
  });

  it("rejects creation with only a suspended same-company membership", async () => {
    const service = agentService(fakeDb({ responsibleBinding: "suspended" }));

    await expect(
      service.createApiKey("agent-1", "test-key", "user-1", authenticated),
    ).rejects.toMatchObject({
      status: 403,
      details: { code: "RESPONSIBLE_USER_UNAVAILABLE" },
    });
  });

  it("allows an active same-company member to own a key", async () => {
    const service = agentService(fakeDb({ responsibleBinding: "member" }));

    await expect(
      service.createApiKey("agent-1", "test-key", " user-1 ", authenticated),
    ).resolves.toMatchObject({
      id: "key-1",
    });
  });

  it("rejects instance-admin role rows without an actual user", async () => {
    const service = agentService(fakeDb({ responsibleBinding: "role-without-user" }));

    await expect(
      service.createApiKey("agent-1", "test-key", "user-1", authenticated),
    ).rejects.toMatchObject({
      status: 403,
      details: { code: "RESPONSIBLE_USER_UNAVAILABLE" },
    });
  });

  it("allows an actual user with the exact instance_admin role to own a key", async () => {
    const service = agentService(fakeDb({ responsibleBinding: "admin" }));

    await expect(
      service.createApiKey("agent-1", "test-key", "user-1", authenticated),
    ).resolves.toMatchObject({
      id: "key-1",
    });
  });
});
