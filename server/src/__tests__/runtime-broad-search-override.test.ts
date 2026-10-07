import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agents, companies, createDb, heartbeatRuns, instanceSettings, issueExecutionCards,
  issues, missions, type Db,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { buildRuntimeSearchPathPermissions } from "../services/runtime-search-path-permissions.js";
import { buildWorkflowIssueExecutionCard } from "../services/issue-execution-cards/builder.js";
import { buildStepInputManifest } from "../services/step-input-manifest.js";
import { missionSearchRoutes } from "../routes/mission-search.js";
import { errorHandler } from "../middleware/index.js";

const fullScopes = ["workProduct", "missionOutput", "repo", "logs", "config"];
const workingDirectory = "/repo";
const origins = ["card", "mission_main_executor_plan", "mission_plan_qa", "mission_main_executor_unblock"];

describe("broad search opt-in — durable settings and company-scoped issues", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let prefix = 0;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("broad-search-override-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  beforeEach(async () => { await db.delete(instanceSettings); });
  afterAll(async () => {
    if (db) await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  }, 30_000);

  async function seed(origin = "card", scopes = ["workProduct", "missionOutput"]) {
    const companyId = randomUUID(), agentId = randomUUID(), missionId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Search Company", issuePrefix: `BS${++prefix}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Running Agent" });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId, title: "Search Mission" });
    await db.insert(issues).values({
      id: issueId, companyId, missionId, title: "Search issue", assigneeAgentId: agentId,
      originKind: origin === "card" ? "workflow_execution" : origin,
    });
    if (origin === "card") {
      const cardJson = buildWorkflowIssueExecutionCard({
        title: "Search issue", description: "Discover mission files.", companyId, workflowDefinitionId: randomUUID(), workflowRunId: randomUUID(),
        step: { id: "search", dependencies: [], allowedSearchScopes: scopes }, isQaStep: false,
        stepOutputDir: "/repo/output",
      });
      // Intentionally omit card.missionId: the issue row, not the card, owns mission identity.
      await db.insert(issueExecutionCards).values({ companyId, issueId, contentHash: "search-test", cardJson });
    }
    return { companyId, agentId, missionId, issueId };
  }
  async function settings(experimental: Record<string, unknown>) {
    await db.insert(instanceSettings).values({ experimental });
  }
  function permissions(world: Awaited<ReturnType<typeof seed>>, overrides: Record<string, string> = {}) {
    return buildRuntimeSearchPathPermissions({ db, ...world, workingDirectory, ...overrides });
  }
  function expectFull(result: Awaited<ReturnType<typeof permissions>>) {
    expect(result).not.toBeNull();
    expect(result).toMatchObject({ allowedSearchScopes: fullScopes, broadScanRepoAllowed: true, broadSearchOverride: "experimental_allow" });
    const manifest = buildStepInputManifest({ taskKey: null, context: { paperclipRuntimeSearchPaths: result } });
    expect(manifest.guardrails.broadScanAllowed).toBe(true);
    expect(manifest.guardrails.allowedSearchScopes).toEqual(fullScopes);
    expect(manifest.inputs.missionSearch.guidance.join("\n")).toContain("repo broad-scan allowed");
  }

  it.each([
    ["card", ["workProduct", "missionOutput"], false],
    ["mission_main_executor_plan", ["repo"], false],
    ["mission_plan_qa", ["workProduct", "missionOutput"], false],
    ["mission_main_executor_unblock", ["workProduct"], false],
  ])("preserves default permissions for %s", async (origin, scopes, broad) => {
    const result = await permissions(await seed(origin as string));
    expect(result).toMatchObject({ allowedSearchScopes: scopes, broadScanRepoAllowed: broad, broadSearchOverride: null });
  });

  it("preserves explicit repo card permission without adding an experimental override", async () => {
    expect(await permissions(await seed("card", ["repo"]))).toMatchObject({
      allowedSearchScopes: ["repo"], broadScanRepoAllowed: true, broadSearchOverride: null,
    });
  });

  it.each(origins)("company allowlist fully releases %s", async (origin) => {
    const world = await seed(origin);
    await settings({ broadSearchAllowedCompanyIdsV1: [world.companyId] });
    expectFull(await permissions(world));
  });

  it.each(origins)("mission allowlist uses the scoped issue mission for %s", async (origin) => {
    const world = await seed(origin);
    await settings({ broadSearchAllowedMissionIdsV1: [world.missionId] });
    expectFull(await permissions(world));
  });

  it("agent allowlist uses the running agent rather than the issue assignee", async () => {
    const world = await seed();
    const runningAgentId = randomUUID();
    await db.insert(agents).values({ id: runningAgentId, companyId: world.companyId, name: "Replacement Runner" });
    await settings({ broadSearchAllowedAgentIdsV1: [runningAgentId] });
    expectFull(await permissions(world, { agentId: runningAgentId }));
    expect(await permissions(world)).toMatchObject({ broadScanRepoAllowed: false, broadSearchOverride: null });
  });

  it("unrelated company, mission and agent IDs grant nothing", async () => {
    const world = await seed(), other = await seed();
    await settings({
      broadSearchAllowedCompanyIdsV1: [other.companyId], broadSearchAllowedMissionIdsV1: [other.missionId],
      broadSearchAllowedAgentIdsV1: [other.agentId],
    });
    expect(await permissions(world)).toMatchObject({ broadScanRepoAllowed: false, broadSearchOverride: null });
  });

  it("does not derive a foreign issue's mission from an unscoped ID", async () => {
    const world = await seed(), foreign = await seed("mission_main_executor_plan");
    await settings({ broadSearchAllowedMissionIdsV1: [foreign.missionId] });
    expect(await permissions(world, { issueId: foreign.issueId })).toBeNull();
  });

  it("does not grant a running agent override when agentId is omitted", async () => {
    const world = await seed();
    await settings({ broadSearchAllowedAgentIdsV1: [world.agentId] });
    const { agentId: _agentId, ...withoutAgent } = world;
    expect(await buildRuntimeSearchPathPermissions({ db, ...withoutAgent, workingDirectory })).toMatchObject({
      broadScanRepoAllowed: false, broadSearchOverride: null,
    });
  });

  it.each([{}, { broadSearchAllowedCompanyIdsV1: "all" }, { broadSearchAllowedCompanyIdsV1: [123] },
    { broadSearchAllowedCompanyIdsV1: null }])("fails closed for absent or malformed lists %j", async (raw) => {
    const world = await seed();
    await settings(raw);
    expect(await permissions(world)).toMatchObject({ broadScanRepoAllowed: false, broadSearchOverride: null });
  });

  it("rejects mixed malformed entries even when one matches", async () => {
    const world = await seed();
    await settings({ broadSearchAllowedCompanyIdsV1: [world.companyId, 123] });
    expect(await permissions(world)).toMatchObject({ broadScanRepoAllowed: false, broadSearchOverride: null });
  });

  it.each(["mission_main_executor_oversight", "ordinary"])("keeps null permissions for unsupported %s even with company opt-in", async (origin) => {
    const world = await seed(origin);
    await settings({ broadSearchAllowedCompanyIdsV1: [world.companyId] });
    expect(await permissions(world)).toBeNull();
  });

  it("missionSearch fallback receives the owned run agent and releases config scope", async () => {
    const world = await seed("mission_main_executor_plan");
    await settings({ broadSearchAllowedAgentIdsV1: [world.agentId] });
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: world.companyId, agentId: world.agentId, issueId: world.issueId,
      contextSnapshot: { paperclipWorkspace: { cwd: workingDirectory } },
    }).returning();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "agent", agentId: world.agentId, companyId: world.companyId, source: "api-key" } as never;
      next();
    });
    app.use("/api", missionSearchRoutes(db));
    app.use(errorHandler);
    const response = await request(app).post("/api/agents/me/mission-search").send({
      scope: "config", runContext: { companyId: world.companyId, agentId: world.agentId, runId: run.id },
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ scope: "config", allowed: true, result: { scope: "config" } });
  });
});
