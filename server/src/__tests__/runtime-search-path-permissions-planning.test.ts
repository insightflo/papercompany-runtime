import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issues,
  missions,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildRuntimeSearchPathPermissions } from "../services/runtime-search-path-permissions.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("mission planning search permissions", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mission-search-planning-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 }); await tempDb?.cleanup();
  });

  it("grants PLAN issues the minimum server-side repo discovery scope with broad scans blocked", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const planningIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Mission Search Planning",
      issuePrefix: `PL${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({ id: ownerAgentId, companyId, name: "Mission Owner" });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Plan the rollout",
      status: "active",
    });
    // PLAN issue owns no execution card (it is planning, not workflow_execution).
    await db.insert(issues).values({
      id: planningIssueId,
      companyId,
      missionId,
      title: "[PLAN] Rollout",
      originKind: "mission_main_executor_plan",
      status: "todo",
      assigneeAgentId: ownerAgentId,
    });

    const permissions = await buildRuntimeSearchPathPermissions({
      db,
      companyId,
      issueId: planningIssueId,
      workingDirectory: "/srv/papercompany/projects/plan-company",
    });

    // PLAN gets the minimum real server-side Mission Search repo-discovery scope.
    expect(permissions).not.toBeNull();
    expect(permissions!.allowedSearchScopes).toEqual(["repo"]);
    // The repo scope must NOT silently enable direct broad shell scans.
    expect(permissions!.broadScanRepoAllowed).toBe(false);
  });

  it("leaves non-PLAN, non-recovery issues without search permissions", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const oversightIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Mission Search Oversight",
      issuePrefix: `OV${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({ id: ownerAgentId, companyId, name: "Mission Owner" });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Oversee the rollout",
      status: "active",
    });
    await db.insert(issues).values({
      id: oversightIssueId,
      companyId,
      missionId,
      title: "[Oversight] Rollout",
      originKind: "mission_main_executor_oversight",
      status: "todo",
      assigneeAgentId: ownerAgentId,
    });

    const permissions = await buildRuntimeSearchPathPermissions({
      db,
      companyId,
      issueId: oversightIssueId,
      workingDirectory: "/srv/papercompany/projects/plan-company",
    });

    // Oversight (and other non-PLAN/non-recovery origins) get no scopes — preserved.
    expect(permissions).toBeNull();
  });
});
