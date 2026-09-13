import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, agents, boardApiKeys, companyMemberships, missionPlanTemplates, qualityPolicyUsage, qualityPolicyVersions, type Db } from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { activateQualityPolicy, createQualityPolicy } from "../services/quality/policy.js";
import { readPolicyUsageTotals } from "../services/quality/policy-usage.js";
import { createQualityTestDb, describeQualityDb } from "./helpers/quality-db.js";
import { buildFixturePolicy, qualityFixtureBoardActor as board, seedQualityFixture, type QualityFixture } from "./helpers/quality-fixture.js";

describeQualityDb("quality policy authority and transaction safety", () => {
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
  const save = () => createQualityPolicy(db, board, { companyId: fixture.companyId, policy: buildFixturePolicy(fixture) });
  const activation = (policyVersionId: string) => ({ companyId: fixture.companyId, policyVersionId, expectedActivePolicyVersionId: fixture.policyVersionId });

  it.each([
    ["plugin-active", "false", "false"],
    ["plugin-active (ineffective plugin disable)", "false", "true"],
    ["native-shadow", "true", "false"],
  ])("rejects %s ownership without changing approval, active policy, or audit", async (_mode, native, disabled) => {
    const { policyVersionId } = await save();
    const beforePolicies = await db.select().from(qualityPolicyVersions).orderBy(qualityPolicyVersions.id);
    const beforeAudit = await db.select().from(activityLog).orderBy(activityLog.id);
    vi.stubEnv("WORKFLOW_NATIVE_SCHEDULER_ENABLED", native);
    vi.stubEnv("WORKFLOW_PLUGIN_RECONCILER_DISABLED", disabled);
    await expect(activateQualityPolicy(db, board, activation(policyVersionId)))
      .rejects.toMatchObject({ status: 409, message: "quality_policy_native_ownership_required" });
    expect(await db.select().from(qualityPolicyVersions).orderBy(qualityPolicyVersions.id)).toEqual(beforePolicies);
    expect(await db.select().from(activityLog).orderBy(activityLog.id)).toEqual(beforeAudit);
  });
  it("accepts native-active/plugin-disabled ownership and atomically replaces the active policy", async () => {
    const { policyVersionId } = await save();
    await expect(activateQualityPolicy(db, board, activation(policyVersionId))).resolves.toEqual({ policyVersionId });
    const rows = await db.select().from(qualityPolicyVersions).where(eq(qualityPolicyVersions.companyId, fixture.companyId));
    expect(rows.find((row) => row.id === fixture.policyVersionId)?.disabledAt).toBeInstanceOf(Date);
    expect(rows.find((row) => row.id === policyVersionId)).toMatchObject({
      enabledAt: expect.any(Date), approvedAt: expect.any(Date), approvedByUserId: board.userId, disabledAt: null,
    });
    expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, policyVersionId), eq(activityLog.action, "quality_policy.activated"))))
      .toHaveLength(1);
  });
  it("serializes concurrent replacements and never resets usage across versions", async () => {
    const [a, b] = await Promise.all([save(), save()]);
    const results = await Promise.allSettled([activateQualityPolicy(db, board, activation(a.policyVersionId)), activateQualityPolicy(db, board, activation(b.policyVersionId))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const windowStart = new Date();
    const windowEnd = new Date(windowStart.getTime() + 60_000);
    await db.insert(qualityPolicyUsage).values([
      { companyId: fixture.companyId, policyVersionId: fixture.policyVersionId, windowStart, windowEnd, chargedCostCents: 40 },
      { companyId: fixture.companyId, policyVersionId: a.policyVersionId, windowStart, windowEnd, reservedCostCents: 30, executionAttempts: 1 },
    ]);
    expect(await readPolicyUsageTotals(db, { companyId: fixture.companyId, policyVersionId: a.policyVersionId, windowStart, windowEnd }))
      .toEqual({ chargedCostCents: 40, reservedCostCents: 30, executionAttempts: 1 });
    expect(await readPolicyUsageTotals(db, { companyId: fixture.otherCompanyId, policyVersionId: a.policyVersionId, windowStart, windowEnd }))
      .toEqual({ chargedCostCents: 0, reservedCostCents: 0, executionAttempts: 0 });
  });
  it("rolls back both replacement and approval if transactional audit insertion fails", async () => {
    const { policyVersionId } = await save();
    await db.execute(sql`create function quality_test_audit_failure() returns trigger language plpgsql as $$ begin if NEW.action = 'quality_policy.activated' then raise exception 'quality_test_audit_failure'; end if; return NEW; end $$`);
    await db.execute(sql`create trigger quality_test_audit_failure before insert on activity_log for each row execute function quality_test_audit_failure()`);
    try {
      await expect(activateQualityPolicy(db, board, activation(policyVersionId))).rejects.toThrow();
      const rows = await db.select().from(qualityPolicyVersions).where(eq(qualityPolicyVersions.companyId, fixture.companyId));
      expect(rows.find((row) => row.id === fixture.policyVersionId)?.disabledAt).toBeNull();
      expect(rows.find((row) => row.id === policyVersionId)?.enabledAt).toBeNull();
      expect(rows.find((row) => row.id === policyVersionId)?.approvedAt).toBeNull();
      expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, policyVersionId), eq(activityLog.action, "quality_policy.activated")))).toHaveLength(0);
    } finally {
      await db.execute(sql`drop trigger quality_test_audit_failure on activity_log`);
      await db.execute(sql`drop function quality_test_audit_failure()`);
    }
  });
  it("rejects fake local actors, missing sessions, revoked and expired board keys", async () => {
    const input = { companyId: fixture.companyId, policy: buildFixturePolicy(fixture) };
    await expect(createQualityPolicy(db, { userId: "pretend-local", source: "local_implicit", keyId: null }, input)).rejects.toThrow("quality_invalid_local_actor");
    await expect(createQualityPolicy(db, { userId: "missing-user", source: "session", keyId: null }, input)).rejects.toThrow("quality_human_unavailable");
    const id = randomUUID();
    const actor = { userId: "quality-reviewer-1", source: "board_key" as const, keyId: id };
    await db.insert(boardApiKeys).values({ id, userId: actor.userId, name: "test", keyHash: randomUUID() });
    await expect(createQualityPolicy(db, actor, input)).resolves.toHaveProperty("policyVersionId");
    await db.update(boardApiKeys).set({ revokedAt: new Date() }).where(eq(boardApiKeys.id, id));
    await expect(createQualityPolicy(db, actor, input)).rejects.toThrow("quality_board_key_unavailable");
    await db.update(boardApiKeys).set({ revokedAt: null, expiresAt: new Date(Date.now() - 1_000) }).where(eq(boardApiKeys.id, id));
    await expect(createQualityPolicy(db, actor, input)).rejects.toThrow("quality_board_key_unavailable");
  });
  it("rejects target content changes and subsequently unavailable agents and human reviewers", async () => {
    const { policyVersionId } = await save();
    await db.update(missionPlanTemplates).set({ instructions: "changed" }).where(eq(missionPlanTemplates.id, fixture.templateId));
    await expect(activateQualityPolicy(db, board, activation(policyVersionId))).rejects.toThrow("quality_policy_target_unavailable");
    await db.update(missionPlanTemplates).set({ instructions: "테스트용 템플릿 지침이다." }).where(eq(missionPlanTemplates.id, fixture.templateId));
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, fixture.verifierAgentId));
    await expect(activateQualityPolicy(db, board, activation(policyVersionId))).rejects.toThrow("quality_policy_agent_unavailable");
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, fixture.verifierAgentId));
    await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.principalId, "quality-rollback-1"));
    await expect(activateQualityPolicy(db, board, activation(policyVersionId))).rejects.toThrow("quality_human_unavailable");
  });
});
