import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { agents, companies, type createDb } from "@paperclipai/db";
import { missionService } from "../../services/missions.js";

export function registerMissionOwnerCreationCase(getDb: () => ReturnType<typeof createDb>) {
  it("creates a mission with the owner as a valid mission agent", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Create Mission Company",
      issuePrefix: `CM${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Mission Owner",
      role: "ceo",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const svc = missionService(db);
    const result = await svc.create({
      companyId,
      ownerAgentId,
      title: "QA launch readiness mission",
      description: "Regression coverage for mission creation from the UI.",
      status: "planning",
    });

    expect(result.title).toBe("QA launch readiness mission");
    expect(result.ownerAgentId).toBe(ownerAgentId);
    expect(result.agents).toEqual([
      expect.objectContaining({
        missionId: result.id,
        agentId: ownerAgentId,
        role: "executor",
      }),
    ]);
  });

}
