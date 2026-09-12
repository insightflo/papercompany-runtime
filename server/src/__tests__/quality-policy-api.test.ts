import express, { type Request } from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { activityLog, companyMemberships, qualityPolicyVersions, type Db } from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { qualityPolicyRoutes } from "../routes/quality-policies.js";
import { errorHandler } from "../middleware/error-handler.js";
import { createQualityTestDb, describeQualityDb } from "./helpers/quality-db.js";
import { buildFixturePolicy, seedQualityFixture, type QualityFixture } from "./helpers/quality-fixture.js";

describeQualityDb("quality policy board API (isolated real DB)", () => {
  let db: Db;
  let fixture: QualityFixture;
  let owned: Awaited<ReturnType<typeof createQualityTestDb>>;
  beforeAll(async () => { owned = await createQualityTestDb(); db = owned.db; }, 120_000);
  afterAll(async () => { await owned?.close(); });
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(async () => {
    vi.stubEnv("WORKFLOW_NATIVE_SCHEDULER_ENABLED", "true");
    vi.stubEnv("WORKFLOW_PLUGIN_RECONCILER_DISABLED", "true");
    await db.execute(sql`truncate companies cascade`); fixture = await seedQualityFixture(db);
  });
  function app(actor: Request["actor"] = { type: "board", source: "local_implicit", userId: "local-board" }) {
    const value = express();
    value.use(express.json());
    value.use((req, _res, next) => { req.actor = actor; next(); });
    value.use("/api", qualityPolicyRoutes(db));
    value.use(errorHandler);
    return value;
  }
  const endpoint = () => `/api/companies/${fixture.companyId}/quality/policies`;
  it("stores inactive then activates with expected-current CAS and real audit rows", async () => {
    const created = await request(app()).post(endpoint()).send({ policy: buildFixturePolicy(fixture) });
    expect(created.status).toBe(201);
    const id = created.body.policyVersionId;
    const [row] = await db.select().from(qualityPolicyVersions).where(eq(qualityPolicyVersions.id, id));
    expect(row?.enabledAt).toBeNull();
    const stale = await request(app()).post(`${endpoint()}/${id}/activate`).send({ expectedActivePolicyVersionId: null });
    expect(stale.status).toBe(409);
    const result = await request(app()).post(`${endpoint()}/${id}/activate`).send({ expectedActivePolicyVersionId: fixture.policyVersionId });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ policyVersionId: id });
    expect((await db.select().from(activityLog).where(eq(activityLog.entityId, id))).map((r) => r.action).sort())
      .toEqual(["quality_policy.activated", "quality_policy.created"]);
  });
  it.each([
    ["plugin-active", "false", "false"],
    ["native-shadow", "true", "false"],
  ])("keeps the server's %s ownership after environment changes and rejects activation without writes", async (_mode, native, disabled) => {
    vi.stubEnv("WORKFLOW_NATIVE_SCHEDULER_ENABLED", native);
    vi.stubEnv("WORKFLOW_PLUGIN_RECONCILER_DISABLED", disabled);
    const server = app();
    const created = await request(server).post(endpoint()).send({ policy: buildFixturePolicy(fixture) });
    expect(created.status).toBe(201);
    const beforePolicies = await db.select().from(qualityPolicyVersions).orderBy(qualityPolicyVersions.id);
    const beforeAudit = await db.select().from(activityLog).orderBy(activityLog.id);
    vi.stubEnv("WORKFLOW_NATIVE_SCHEDULER_ENABLED", "true");
    vi.stubEnv("WORKFLOW_PLUGIN_RECONCILER_DISABLED", "true");
    const response = await request(server).post(`${endpoint()}/${created.body.policyVersionId}/activate`)
      .send({ expectedActivePolicyVersionId: fixture.policyVersionId });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("quality_policy_native_ownership_required");
    expect(await db.select().from(qualityPolicyVersions).orderBy(qualityPolicyVersions.id)).toEqual(beforePolicies);
    expect(await db.select().from(activityLog).orderBy(activityLog.id)).toEqual(beforeAudit);
  });
  it("rejects absent auth, agents, foreign boards and body-authority spoofing without writes", async () => {
    const before = await db.select().from(qualityPolicyVersions);
    for (const [actor, status] of [
      [{ type: "none" }, 401],
      [{ type: "agent", companyId: fixture.companyId, agentId: fixture.authorAgentId }, 403],
      [{ type: "board", source: "session", userId: "quality-reviewer-1", companyIds: [fixture.otherCompanyId] }, 403],
    ] as const) {
      const response = await request(app(actor as Request["actor"])).post(endpoint()).send({ policy: buildFixturePolicy(fixture) });
      expect(response.status).toBe(status);
    }
    const spoof = await request(app()).post(endpoint()).send({ policy: buildFixturePolicy(fixture), companyId: fixture.otherCompanyId, actor: { source: "local_implicit" } });
    expect(spoof.status).toBe(400);
    expect((await db.select().from(qualityPolicyVersions)).length).toBe(before.length);
  });
  it("rechecks current membership even when auth snapshot claims company access", async () => {
    await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.principalId, "quality-reviewer-1"));
    const response = await request(app({ type: "board", source: "session", userId: "quality-reviewer-1", companyIds: [fixture.companyId] }))
      .post(endpoint()).send({ policy: buildFixturePolicy(fixture) });
    expect(response.status).toBe(403);
  });
});
