import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  missionPlanTemplates,
  qualityActionGroups,
  qualityPolicyUsage,
  qualityPolicyVersions,
  toolDefinitions,
  type Db,
} from "@paperclipai/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashContract } from "../services/quality/contract.js";
import {
  activateQualityPolicy,
  createQualityPolicy,
  finiteCount,
  parseQualityPolicy,
} from "../services/quality/policy.js";
import { readPolicyUsageTotals } from "../services/quality/policy-usage.js";
import { sameTarget } from "../services/quality/targets.js";
import { createQualityTestDb, describeQualityDb } from "./helpers/quality-db.js";
import { QUALITY_TEST_POLICY_NUMBERS, qualityFixtureBoardActor, seedQualityFixture, type QualityFixture } from "./helpers/quality-fixture.js";

const fixtureBoardActor = qualityFixtureBoardActor;

function buildPolicyInput(fixture: {
  companyId: string;
  templateId: string;
  baseHash: string;
  authorAgentId: string;
  verifierAgentId: string;
}) {
  const periodStart = new Date();
  return {
    targets: [
      {
        companyId: fixture.companyId,
        templateId: fixture.templateId,
        baseHash: fixture.baseHash,
        required: [
          {
            checkId: "check-policy-test",
            requirementRefs: [{ attachmentId: randomUUID(), sha256: "41".repeat(32) }],
            applicability: { op: "selected_templates_all" as const, templateIds: [fixture.templateId] },
            expectedEvidenceKinds: ["evaluation_receipt"],
            instructions: "정책 저장 테스트용 검사항목이다.",
          },
        ],      },
    ],
    authorAgentIds: [fixture.authorAgentId],
    verifierAgentIds: [fixture.verifierAgentId],
    allowedToolIds: [],
    reviewerUserIds: ["quality-reviewer-1"],
    rollbackUserIds: ["quality-rollback-1"],
    requirementSourceRefs: [{ attachmentId: randomUUID(), sha256: "42".repeat(32) }],
    caseOracleRefs: [{ attachmentId: randomUUID(), sha256: "43".repeat(32) }],
    nativeOwnership: "native-active-plugin-disabled" as const,
    ...QUALITY_TEST_POLICY_NUMBERS,
    periodStart: periodStart.toISOString(),
    periodEnd: new Date(periodStart.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

describe("finiteCount", () => {
  it("rejects absent or unlimited counts without a default", () => {
    for (const n of [undefined, Infinity, -1, 1.5, "2"]) {
      expect(() => finiteCount(n, true)).toThrow("quality_invalid_limit");
    }
    expect(finiteCount(0, true)).toBe(0);
    expect(() => finiteCount(0, false)).toThrow("quality_invalid_limit");
  });
});

describe("parseQualityPolicy (pure contract)", () => {
  const base = buildPolicyInput({
    companyId: "11111111-1111-4111-8111-111111111111",
    templateId: "22222222-2222-4222-8222-222222222222",
    baseHash: "ab".repeat(32),
    authorAgentId: "33333333-3333-4333-8333-333333333333",
    verifierAgentId: "44444444-4444-4444-8444-444444444444",
  });

  it("parses an explicit finite policy", () => {
    expect(parseQualityPolicy(base).maxExecutionAttempts).toBe(4);
  });

  it("rejects missing values, unlimited/negative/fractional counts, empty targets, and role overlap", () => {
    const { maxActions: _m, ...missing } = base;
    expect(() => parseQualityPolicy(missing)).toThrow();
    for (const bad of [Infinity, -1, 1.5]) {
      expect(() => parseQualityPolicy({ ...base, maxExecutionAttempts: bad })).toThrow("quality_invalid_limit");
    }
    expect(() => parseQualityPolicy({ ...base, targets: [] })).toThrow();
    expect(() => parseQualityPolicy({ ...base, verifierAgentIds: base.authorAgentIds })).toThrow();
  });
});

describe("hashContract", () => {
  it("does not change identity when JSON field order changes", () => {
    expect(hashContract({ a: 1, b: [2, 3] })).toBe(hashContract({ b: [2, 3], a: 1 }));
    expect(hashContract({ a: 1, b: [2, 3] })).not.toBe(hashContract({ a: 1, b: [3, 2] }));
  });

  it("rejects non-finite numbers", () => {
    expect(() => hashContract({ a: Infinity })).toThrow("quality_invalid_json");
    expect(() => hashContract(undefined)).toThrow("quality_invalid_json");
  });
});
describe("sameTarget", () => {
  const qaTarget = {
    kind: "qa_addendum" as const,
    companyId: "11111111-1111-4111-8111-111111111111",
    templateId: "22222222-2222-4222-8222-222222222222",
    baseHash: "ab".repeat(32),
    requirementVersionId: "req-v1",
    inputHash: "cd".repeat(32),
    candidateVersionId: null,
    evaluationId: null,
    intentKey: "quality-test-intent",
    execution: { kind: "not_yet_accepted" as const, reason: "new_improvement_execution" as const },
  };
  const outputTarget = {
    kind: "current_output" as const,
    source: {
      companyId: "11111111-1111-4111-8111-111111111111",
      issueId: "33333333-3333-4333-8333-333333333333",
      heartbeatRunId: "44444444-4444-4444-8444-444444444444",
      executionEpoch: 1,
      inputHash: "ef".repeat(32),
      mission: { kind: "mission" as const, id: "55555555-5555-4555-8555-555555555555" },
      workflow: { kind: "not_applicable" as const, reason: "not_a_workflow_source" as const },
    },
  };

  it("matches identical targets but distinguishes phase-evolved fixed targets", () => {
    expect(sameTarget(qaTarget, qaTarget)).toBe(true);
    expect(sameTarget(qaTarget, { ...qaTarget, candidateVersionId: "66666666-6666-4666-8666-666666666666" })).toBe(false);
    expect(sameTarget(outputTarget, outputTarget)).toBe(true);
  });
  it("distinguishes identity fields, attempts, and kinds", () => {
    expect(sameTarget(qaTarget, { ...qaTarget, inputHash: "99".repeat(32) })).toBe(false);
    expect(sameTarget(qaTarget, { ...qaTarget, intentKey: "other" })).toBe(false);
    expect(sameTarget(outputTarget, { ...outputTarget, source: { ...outputTarget.source, executionEpoch: 2 } })).toBe(false);
    expect(sameTarget(qaTarget, outputTarget as never)).toBe(false);
    expect(() => sameTarget(qaTarget, { ...qaTarget, baseHash: "short" })).toThrow();
  });
});
describeQualityDb("quality policy storage and activation", () => {
  let db!: Db;
  let testDb!: Awaited<ReturnType<typeof createQualityTestDb>>;
  let fixture!: QualityFixture;

  beforeAll(async () => {
    testDb = await createQualityTestDb();
    db = testDb.db;
  }, 120_000);
  afterAll(async () => {
    await testDb?.close();
  });
  beforeEach(async () => {
    await db.execute(sql`truncate companies cascade`);
    fixture = await seedQualityFixture(db);
  }, 60_000);

  it("createQualityPolicy stores an inactive immutable policy row with audit trail", async () => {
    const input = buildPolicyInput(fixture);
    const { policyVersionId } = await createQualityPolicy(db, fixtureBoardActor, { companyId: fixture.companyId, policy: input });
    const [row] = await db.select().from(qualityPolicyVersions).where(eq(qualityPolicyVersions.id, policyVersionId));
    expect(row).toBeDefined();
    expect(row!.companyId).toBe(fixture.companyId);
    expect(row!.enabledAt).toBeNull();
    expect(row!.approvedAt).toBeNull();
    expect(row!.definition).toMatchObject({ maxExecutionAttempts: 4, maxCostCentsPerPeriod: 1000 });
    const [audit] = await db.select().from(activityLog).where(eq(activityLog.entityId, policyVersionId));
    expect(audit?.action).toBe("quality_policy.created");
    expect(audit?.actorId).toBe(fixtureBoardActor.userId);
  });

  it("monotonically numbers versions and rejects malformed input without writing", async () => {
    const input = buildPolicyInput(fixture);
    const first = await createQualityPolicy(db, fixtureBoardActor, { companyId: fixture.companyId, policy: input });
    const second = await createQualityPolicy(db, fixtureBoardActor, { companyId: fixture.companyId, policy: input });
    const rows = await db.select().from(qualityPolicyVersions).where(eq(qualityPolicyVersions.companyId, fixture.companyId));
    expect(rows.map((r) => r.version).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    await expect(
      createQualityPolicy(db, fixtureBoardActor, { companyId: fixture.companyId, policy: { ...input, maxActions: Infinity } }),
    ).rejects.toThrow("quality_invalid_limit");
    await expect(
      createQualityPolicy(db, fixtureBoardActor, { companyId: fixture.otherCompanyId, policy: input }),
    ).rejects.toThrow();
    expect((await db.select().from(qualityPolicyVersions).where(eq(qualityPolicyVersions.companyId, fixture.companyId))).length).toBe(3);
  });

  it("activateQualityPolicy enforces expected-active CAS and single activation per company", async () => {
    const input = buildPolicyInput(fixture);
    const { policyVersionId: v2 } = await createQualityPolicy(db, fixtureBoardActor, { companyId: fixture.companyId, policy: input });
    const wrongExpected = { companyId: fixture.companyId, policyVersionId: v2, expectedActivePolicyVersionId: "stale-id" };
    await expect(activateQualityPolicy(db, fixtureBoardActor, wrongExpected)).rejects.toThrow();
    await expect(activateQualityPolicy(db, fixtureBoardActor, { ...wrongExpected, expectedActivePolicyVersionId: null })).rejects.toThrow();
    const [v2row] = await db.select().from(qualityPolicyVersions).where(eq(qualityPolicyVersions.id, v2));
    expect(v2row!.enabledAt).toBeNull();

    const activated = await activateQualityPolicy(db, fixtureBoardActor, { companyId: fixture.companyId, policyVersionId: v2, expectedActivePolicyVersionId: fixture.policyVersionId });
    expect(activated.policyVersionId).toBe(v2);
    const byVersion = await db.select().from(qualityPolicyVersions).where(eq(qualityPolicyVersions.companyId, fixture.companyId));
    const active = byVersion.filter((r) => r.enabledAt !== null && r.disabledAt === null);
    expect(active.map((r) => r.id)).toEqual([v2]);
    const [oldRow] = byVersion.filter((r) => r.id === fixture.policyVersionId);
    expect(oldRow!.disabledAt).not.toBeNull();
    expect(active[0]!.approvedByUserId).toBe(fixtureBoardActor.userId);
    expect(active[0]!.approvedAt).not.toBeNull();
    await expect(activateQualityPolicy(db, fixtureBoardActor, { companyId: fixture.companyId, policyVersionId: v2, expectedActivePolicyVersionId: v2 })).rejects.toThrow();
  });

  it("re-validates stored definitions, roles, tools, templates, and native ownership in the activation tx", async () => {
    const tamper = async (mutate: (definition: Record<string, unknown>) => Record<string, unknown>) => {
      const input = buildPolicyInput(fixture);
      const { policyVersionId } = await createQualityPolicy(db, fixtureBoardActor, { companyId: fixture.companyId, policy: input });
      const [row] = await db.select().from(qualityPolicyVersions).where(eq(qualityPolicyVersions.id, policyVersionId));
      await db.update(qualityPolicyVersions).set({ definition: sql`${JSON.stringify(mutate(row!.definition as unknown as Record<string, unknown>))}::jsonb` })
        .where(eq(qualityPolicyVersions.id, policyVersionId));
      await expect(activateQualityPolicy(db, fixtureBoardActor, { companyId: fixture.companyId, policyVersionId, expectedActivePolicyVersionId: fixture.policyVersionId })).rejects.toThrow();
      const [after] = await db.select().from(qualityPolicyVersions).where(eq(qualityPolicyVersions.id, policyVersionId));
      expect(after!.enabledAt).toBeNull();
    };

    await tamper((d) => ({ ...d, maxExecutionAttempts: -3 }));
    await tamper((d) => ({ ...d, nativeOwnership: "native-active" }));
    await tamper((d) => ({ ...d, authorAgentIds: [randomUUID(), randomUUID()] }));
    await tamper((d) => ({ ...d, allowedToolIds: [randomUUID()] }));
    await tamper((d) => ({ ...d, targets: [{ ...(d.targets as Record<string, unknown>[])[0], templateId: randomUUID() }] }));
  });

  it("supports tool/template activation checks against real rows and blocks cross-company activation", async () => {
    const toolId = randomUUID();
    await db.insert(toolDefinitions).values({
      id: toolId, companyId: fixture.companyId, name: "quality-fixture-tool", adapterType: "http",
    });
    const input = buildPolicyInput(fixture);
    const withTool = await createQualityPolicy(db, fixtureBoardActor, {
      companyId: fixture.companyId, policy: { ...input, allowedToolIds: [toolId] },
    });
    await expect(activateQualityPolicy(db, fixtureBoardActor, { companyId: fixture.companyId, policyVersionId: withTool.policyVersionId, expectedActivePolicyVersionId: fixture.policyVersionId }))
      .resolves.toMatchObject({ policyVersionId: withTool.policyVersionId });

    const plain = await createQualityPolicy(db, fixtureBoardActor, { companyId: fixture.companyId, policy: input });
    await expect(activateQualityPolicy(db, fixtureBoardActor, { companyId: fixture.otherCompanyId, policyVersionId: plain.policyVersionId, expectedActivePolicyVersionId: null })).rejects.toThrow();
    await db.delete(toolDefinitions).where(eq(toolDefinitions.id, toolId));
    const noTool = await createQualityPolicy(db, fixtureBoardActor, {
      companyId: fixture.companyId, policy: { ...input, allowedToolIds: [toolId] },
    });
    await expect(activateQualityPolicy(db, fixtureBoardActor, { companyId: fixture.companyId, policyVersionId: noTool.policyVersionId, expectedActivePolicyVersionId: fixture.policyVersionId })).rejects.toThrow();
  });

  it("preserves existing group usage when replacing the active policy", async () => {
    const windowStart = new Date();
    await db.insert(qualityPolicyUsage).values({
      companyId: fixture.companyId,
      policyVersionId: fixture.policyVersionId,
      windowStart,
      windowEnd: new Date(windowStart.getTime() + 60_000),
      reservedCostCents: 40,
      chargedCostCents: 25,
      executionAttempts: 2,
      revision: 3,
    });
    const [groupBefore] = await db.select().from(qualityActionGroups).where(eq(qualityActionGroups.id, fixture.groupId));

    const input = buildPolicyInput(fixture);
    const { policyVersionId: v2 } = await createQualityPolicy(db, fixtureBoardActor, { companyId: fixture.companyId, policy: input });
    await activateQualityPolicy(db, fixtureBoardActor, { companyId: fixture.companyId, policyVersionId: v2, expectedActivePolicyVersionId: fixture.policyVersionId });

    const totals = await readPolicyUsageTotals(db, {
      companyId: fixture.companyId,
      policyVersionId: fixture.policyVersionId,
      windowStart: new Date(windowStart.getTime() - 60_000),
      windowEnd: new Date(windowStart.getTime() + 120_000),
    });
    expect(totals).toEqual({ reservedCostCents: 40, chargedCostCents: 25, executionAttempts: 2 });
    const [groupAfter] = await db.select().from(qualityActionGroups).where(eq(qualityActionGroups.id, fixture.groupId));
    expect(groupAfter!.usage).toEqual(groupBefore!.usage);
    const usageRows = await db.select().from(qualityPolicyUsage).where(eq(qualityPolicyUsage.companyId, fixture.companyId));
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]!.revision).toBe(3);
  });
});
