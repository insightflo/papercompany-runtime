import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issueWorkProducts,
  issues,
  missionPlanArtifacts,
  missions,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildRuntimeSearchPathPermissions } from "../services/runtime-search-path-permissions.js";
import {
  cleanupTempDirs,
  DECISION_HASH_A,
  makeTempDir,
  seedActivePlan,
} from "./plan-qa-work-product-fixtures.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const DECISION_HASH_B = "b".repeat(64);

describeEmbeddedPostgres("PLAN-QA search permissions integration", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plan-qa-search-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(issueWorkProducts);
    await db.delete(missionPlanArtifacts);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    cleanupTempDirs();
  });

  async function seedCompanyAgentsMission(root: string) {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    const missionId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Plan QA Search Int",
      workProductRoot: root,
      issuePrefix: `QI${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Owner" },
      { id: reviewerAgentId, companyId, name: "Reviewer" },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Research mission",
      status: "active",
    });
    return { companyId, ownerAgentId, reviewerAgentId, missionId };
  }

  async function seedPlanQaIssue(
    companyId: string,
    missionId: string,
    assigneeAgentId: string,
    decisionHash: string,
  ) {
    const planQaIssueId = randomUUID();
    await db.insert(issues).values({
      id: planQaIssueId,
      companyId,
      missionId,
      title: "[PLAN-QA] Review",
      originKind: "mission_plan_qa",
      originId: `plan-qa:${missionId}:${decisionHash}`,
      status: "todo",
      assigneeAgentId,
    });
    return planQaIssueId;
  }

  it("populates dependencyFiles/directories for the exact plan and keeps scopes/repo blocked", async () => {
    const root = makeTempDir();
    const { companyId, ownerAgentId, reviewerAgentId, missionId } = await seedCompanyAgentsMission(root);
    const planQaIssueId = await seedPlanQaIssue(companyId, missionId, reviewerAgentId, DECISION_HASH_A);
    await seedActivePlan(db, companyId, missionId, ownerAgentId, planQaIssueId, DECISION_HASH_A);

    const permissions = await buildRuntimeSearchPathPermissions({
      db,
      companyId,
      issueId: planQaIssueId,
      workingDirectory: "/srv/papercompany/projects/plan-qa-review",
    });

    expect(permissions).not.toBeNull();
    const expectedPath = path.join(root, "missions", missionId, "plan-qa", DECISION_HASH_A, "plan.json");
    expect(permissions!.dependencyFiles).toEqual([expectedPath]);
    expect(permissions!.dependencyDirectories).toEqual([path.dirname(expectedPath)]);
    expect(permissions!.allowedSearchScopes).toEqual(["workProduct", "missionOutput"]);
    expect(permissions!.broadScanRepoAllowed).toBe(false);
    expect(permissions!.outputDirectory).toBeNull();
    expect(existsSync(expectedPath)).toBe(true);
  });

  it("keeps safe minimal permissions (empty dependencies, no repo) when no plan matches", async () => {
    const root = makeTempDir();
    const { companyId, ownerAgentId, reviewerAgentId, missionId } = await seedCompanyAgentsMission(root);
    const planQaIssueId = await seedPlanQaIssue(companyId, missionId, reviewerAgentId, DECISION_HASH_A);
    // No matching active plan: the only plan references a different issue.
    await seedActivePlan(db, companyId, missionId, ownerAgentId, randomUUID(), DECISION_HASH_B);

    const permissions = await buildRuntimeSearchPathPermissions({
      db,
      companyId,
      issueId: planQaIssueId,
      workingDirectory: "/srv/papercompany/projects/plan-qa-review",
    });

    expect(permissions).not.toBeNull();
    expect(permissions!.dependencyFiles).toEqual([]);
    expect(permissions!.dependencyDirectories).toEqual([]);
    expect(permissions!.allowedSearchScopes).toEqual(["workProduct", "missionOutput"]);
    expect(permissions!.broadScanRepoAllowed).toBe(false);
  });
});
