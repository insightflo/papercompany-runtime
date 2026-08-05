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
import {
  buildMissionSearchGuidance,
  missionSearchScopesAllowRepo,
} from "../services/runtime-search-scopes.js";

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
    await tempDb?.cleanup();
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

  it("grants PLAN-QA the default mission-search scopes with broad repo scans blocked", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    const missionId = randomUUID();
    const planQaIssueId = randomUUID();
    const workingDirectory = "/srv/papercompany/projects/plan-qa-company";

    await db.insert(companies).values({
      id: companyId,
      name: "Plan QA Search",
      issuePrefix: `QA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({ id: ownerAgentId, companyId, name: "Mission Owner" });
    await db.insert(agents).values({ id: reviewerAgentId, companyId, name: "Plan QA Reviewer" });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Review the plan",
      status: "active",
    });
    // PLAN-QA owns no execution card (it reviews a plan decision, it does not run a step).
    await db.insert(issues).values({
      id: planQaIssueId,
      companyId,
      missionId,
      title: "[PLAN-QA] Review active plan",
      originKind: "mission_plan_qa",
      originId: `plan-qa:${missionId}:abc123`,
      status: "todo",
      assigneeAgentId: reviewerAgentId,
    });

    const permissions = await buildRuntimeSearchPathPermissions({
      db,
      companyId,
      issueId: planQaIssueId,
      workingDirectory,
    });

    // PLAN-QA must receive declared permissions (not null).
    expect(permissions).not.toBeNull();
    // The declared review workspace is preserved.
    expect(permissions!.workingDirectory).toBe(workingDirectory);
    // mission-search scopes are available: the default scopes, NOT the "repo" scope.
    expect(permissions!.allowedSearchScopes).toEqual(["workProduct", "missionOutput"]);
    expect(missionSearchScopesAllowRepo(permissions!.allowedSearchScopes)).toBe(false);
    // Declared-path search is allowed: the broad-scan flag is false, so the runtime
    // broad-scan guard treats explicit declared file paths as allowed while blocking
    // repo-root recursion. missionSearch itself stays callable.
    expect(permissions!.broadScanRepoAllowed).toBe(false);
    const guidance = buildMissionSearchGuidance(permissions!.allowedSearchScopes, {
      broadScanRepoAllowed: permissions!.broadScanRepoAllowed,
    });
    // missionSearch API guidance is emitted (server-side declared discovery available).
    expect(guidance.some((line) => line.includes("missionSearch API (callable)"))).toBe(true);
    // Repo-root broad scans (grep -R ., find ., rg ... .) remain blocked: the guidance
    // explicitly states raw pathless rg/find/git-ls-files/tree/ls -R are blocked.
    expect(guidance.some((line) => line.includes("are blocked by the runtime guard"))).toBe(true);
    // And the "repo" scope is explicitly marked as NOT allowed this run.
    expect(guidance.some((line) => line.includes("repo (NOT allowed this run)"))).toBe(true);
  });
});
