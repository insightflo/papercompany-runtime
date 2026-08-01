import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issueWorkProducts,
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

describeEmbeddedPostgres("mission recovery search permissions", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mission-search-recovery-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(issueWorkProducts);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 }); await tempDb?.cleanup();
  });

  it("exposes active local workProducts from the same mission to owner recovery issues", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const recoveryIssueId = randomUUID();
    const producerIssueId = randomUUID();
    const workProductPath = "/srv/papercompany/projects/research-company/produced_work/missions/m1/index.html";

    await db.insert(companies).values({
      id: companyId,
      name: "Mission Search Recovery",
      issuePrefix: `MS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({ id: agentId, companyId, name: "Research Director" });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Daily tech scout",
      status: "active",
    });
    await db.insert(issues).values([
      {
        id: recoveryIssueId,
        companyId,
        missionId,
        title: "[Owner Action] Tool step failed",
        originKind: "mission_main_executor_unblock",
      },
      {
        id: producerIssueId,
        companyId,
        missionId,
        title: "Build HTML",
        originKind: "workflow_step",
      },
    ]);
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId: producerIssueId,
      title: "index.html",
      type: "document",
      provider: "local_file",
      externalId: workProductPath,
      status: "active",
      metadata: { path: workProductPath },
    });

    const permissions = await buildRuntimeSearchPathPermissions({
      db,
      companyId,
      issueId: recoveryIssueId,
      workingDirectory: "/srv/papercompany/projects/research-company",
    });

    expect(permissions).toMatchObject({
      allowedSearchScopes: ["workProduct"],
      dependencyFiles: [workProductPath],
      dependencyDirectories: [
        "/srv/papercompany/projects/research-company/produced_work/missions/m1",
      ],
    });
  });
});
