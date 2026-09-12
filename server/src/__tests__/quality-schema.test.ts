import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import {
  agentWakeupRequests,
  agents,
  companies,
  evaluatorVersions,
  heartbeatRuns,
  issues,
  missionPlanTemplates,
  operatorDecisions,
  qualityActionGroups,
  qualityActions,
  qualityConsumerBindings,
  qualityOccurrences,
  qualityPolicyUsage,
  qualityPolicyVersions,
  qualityReviewItems,
  type Db,
} from "@paperclipai/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createQualityTestDb, describeQualityDb } from "./helpers/quality-db.js";

function errorCode(error: unknown): string {
  const typed = error as { code?: string; cause?: unknown };
  return typed.code ?? (typed.cause ? errorCode(typed.cause) : "unknown");
}

async function expectCode(promise: Promise<unknown>, code: string) {
  let caught: string | null = null;
  try {
    await promise;
  } catch (error) {
    caught = errorCode(error);
  }
  expect(caught, `expected rejection with ${code}`).toBe(code);
}

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs);

describeQualityDb("quality storage schema invariants (embedded PostgreSQL)", () => {
  let db!: Db;
  let testDb!: Awaited<ReturnType<typeof createQualityTestDb>>;
  let companyId!: string;
  let otherCompanyId!: string;
  let agentId!: string;
  let runId!: string;
  let reviewItemId!: string;
  let templateId!: string;
  let policyVersionId!: string;
  let groupId!: string;

  async function insertPolicy(companyId: string, version: number, enabled = false) {
    const [row] = await db.insert(qualityPolicyVersions).values({
      companyId, version,
      definition: { note: "schema-test-definition" } as never,
      ...(enabled ? { enabledAt: iso(0), approvedAt: iso(0), approvedByUserId: "schema-test" } : {}),
    }).returning({ id: qualityPolicyVersions.id });
    return row!.id;
  }

  async function insertAction(values: { companyId?: string; groupId?: string; kind?: string; intentKey?: string }, connection: Pick<Db, "insert"> = db) {
    const id = randomUUID();
    const target = {
      kind: "qa_addendum", companyId: values.companyId ?? companyId, templateId,
      baseHash: "ab".repeat(32), requirementVersionId: "req-schema", inputHash: "cd".repeat(32),
      candidateVersionId: null, evaluationId: null, intentKey: values.intentKey ?? `intent-${id.slice(0, 8)}`,
      execution: { kind: "not_yet_accepted", reason: "new_improvement_execution" },
    } as const;
    await connection.insert(qualityActions).values({
      id, companyId: values.companyId ?? companyId, groupId: values.groupId ?? groupId, kind: values.kind ?? "qa_addendum",
      occurrenceSetHash: "ef".repeat(32), occurrenceIds: [], policyVersionId, scopeVersion: 1,
      target, targetHash: "01".repeat(32), effect: { kind: "hold", remindAt: null, target }, effectHash: "02".repeat(32),
      retryEnvelope: { intentKey: target.intentKey, effectHash: "02".repeat(32), targetHash: "01".repeat(32), maxExecutorAttempts: 4, deadlineAt: iso(60_000).toISOString(), groupId: values.groupId ?? groupId, policyVersionId, maxCumulativeCostCents: 100 },
      revision: 1, state: "created", intentKey: target.intentKey,
    });
    return id;
  }

  beforeAll(async () => {
    testDb = await createQualityTestDb();
    db = testDb.db;
  }, 120_000);
  afterAll(async () => {
    await testDb?.close();
  });
  beforeEach(async () => {
    await db.execute(sql`truncate companies cascade`);

    companyId = randomUUID();
    otherCompanyId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "Schema Co", issuePrefix: `SC${companyId.slice(0, 4)}` },
      { id: otherCompanyId, name: "Other Co", issuePrefix: `OC${otherCompanyId.slice(0, 4)}` },
    ]);
    agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Schema Agent" });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded" }).returning({ id: heartbeatRuns.id });
    runId = run!.id;
    const [reviewItem] = await db.insert(qualityReviewItems).values({
      companyId, title: "Schema review item", targetType: "mission", triggerSource: "schema_test",
    }).returning({ id: qualityReviewItems.id });
    reviewItemId = reviewItem!.id;
    templateId = randomUUID();
    await db.insert(missionPlanTemplates).values({
      id: templateId, companyId, key: `schema-${templateId.slice(0, 8)}`, name: "Schema Template",
      selectionDescription: "schema", instructions: "schema",
    });
    policyVersionId = await insertPolicy(companyId, 1);
    const [group] = await db.insert(qualityActionGroups).values({
      companyId, policyVersionId, rootOccurrenceSetHash: "03".repeat(32), usage: { count: 1 }, revision: 1,
    }).returning({ id: qualityActionGroups.id });
    groupId = group!.id;
  }, 60_000);

  it("keeps drizzle parity for composite uniques, partial uniques, and checks", () => {
    const policyConfig = getTableConfig(qualityPolicyVersions);
    expect(policyConfig.indexes.map((i) => i.config.name)).toContain("quality_policy_versions_company_active_uq");
    expect(policyConfig.checks.map((c) => c.name)).toContain("quality_policy_versions_version_positive_check");
    const actionConfig = getTableConfig(qualityActions);
    expect(actionConfig.indexes.map((i) => i.config.name)).toContain("quality_actions_company_intent_uq");
    expect(actionConfig.checks.map((c) => c.name)).toContain("quality_actions_kind_check");
    const wakeupConfig = getTableConfig(agentWakeupRequests);
    const wakeIndex = wakeupConfig.indexes.find((i) => i.config.name === "agent_wakeup_requests_quality_action_wake_uq");
    expect(wakeIndex).toBeDefined();
    expect(new PgDialect().sqlToQuery(wakeIndex!.config.where!).sql).toContain("quality-action-wake");
  });

  it("rejects duplicate (companyId, version) and a second concurrently-active policy", async () => {
    await expectCode(db.insert(qualityPolicyVersions).values({
      companyId, version: 1, definition: {} as never,
    }), "23505");
    const enabledV2 = await insertPolicy(companyId, 2, true);
    await expectCode(db.insert(qualityPolicyVersions).values({
      companyId, version: 3, definition: {} as never, enabledAt: iso(0), approvedAt: iso(0), approvedByUserId: "x",
    }), "23505");
    await db.update(qualityPolicyVersions).set({ disabledAt: iso(0) }).where(eq(qualityPolicyVersions.id, enabledV2));
    await insertPolicy(companyId, 3, true);
    await expectCode(db.insert(qualityPolicyVersions).values({ companyId, version: 0, definition: {} as never }), "23514");
  });

  it("rejects duplicate action intents and unknown action kinds", async () => {
    const actionId = await insertAction({ intentKey: "intent-dup" });
    await expectCode(insertAction({ intentKey: "intent-dup" }), "23505");
    await expectCode(insertAction({ groupId, kind: "bogus" }), "23514");
    expect(actionId).toBeDefined();
  });

  it("blocks company mixing through composite foreign keys", async () => {
    await expectCode(insertAction({ companyId: otherCompanyId, groupId }), "23503");
    await expectCode(db.insert(qualityPolicyUsage).values({
      companyId: otherCompanyId, policyVersionId, windowStart: iso(0), windowEnd: iso(60_000),
    }), "23503");
    await expectCode(db.insert(qualityActionGroups).values({
      companyId: otherCompanyId, policyVersionId, rootOccurrenceSetHash: "06".repeat(32),
    }), "23503");
    await expectCode(db.insert(qualityConsumerBindings).values({
      companyId: otherCompanyId, templateId, baseHash: "ab".repeat(32),
    }), "23503");
    await db.insert(qualityConsumerBindings).values({ companyId, templateId, baseHash: "ab".repeat(32) });
    await expectCode(db.insert(qualityConsumerBindings).values({
      companyId, templateId, baseHash: "ab".repeat(32),
    }), "23505");
  });

  it("enforces occurrence and usage window uniques with window ordering", async () => {
    const occurrence = {
      companyId, reviewItemId, producerRunId: runId, submissionKey: "schema-submission",
      payloadHash: "07".repeat(32), sourceBinding: {} as never, evidenceRefIds: [],
      occurredAt: iso(-1_000), receivedAt: iso(0),
    };
    await db.insert(qualityOccurrences).values(occurrence);
    await expectCode(db.insert(qualityOccurrences).values(occurrence), "23505");
    await db.insert(qualityOccurrences).values({ ...occurrence, submissionKey: "schema-submission-2", payloadHash: "08".repeat(32) });

    const windowStart = iso(0);
    await db.insert(qualityPolicyUsage).values({
      companyId, policyVersionId, windowStart, windowEnd: iso(60_000),
    });
    await expectCode(db.insert(qualityPolicyUsage).values({
      companyId, policyVersionId, windowStart, windowEnd: iso(120_000),
    }), "23505");
    await expectCode(db.insert(qualityPolicyUsage).values({
      companyId, policyVersionId, windowStart: iso(120_000), windowEnd: iso(60_000),
    }), "23514");
  });

  it("applies the quality-action-wake idempotency unique across all statuses", async () => {
    const wakeKey = `quality-action-wake:${randomUUID()}:step:g1:a1`;
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "test", status: "queued", idempotencyKey: wakeKey });
    await expectCode(db.insert(agentWakeupRequests).values({ companyId, agentId, source: "test", status: "completed", idempotencyKey: wakeKey }), "23505");
    await db.insert(agentWakeupRequests).values({ companyId: otherCompanyId, agentId, source: "test", status: "queued", idempotencyKey: wakeKey });
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "test", status: "queued", idempotencyKey: `other-wake:${randomUUID()}` });
  });

  it("rolls back whole transactions and keeps legacy rows readable", async () => {
    const before = await db.select({ count: sql<number>`count(*)::int` }).from(qualityActions).where(eq(qualityActions.companyId, companyId));
    await expect(db.transaction(async (tx) => {
      await insertAction({ intentKey: "rollback-intent" }, tx);
      throw new Error("crash-before-commit");
    })).rejects.toThrow("crash-before-commit");
    const after = await db.select({ count: sql<number>`count(*)::int` }).from(qualityActions).where(eq(qualityActions.companyId, companyId));
    expect(after[0]!.count).toBe(before[0]!.count);

    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Legacy issue", status: "todo" });
    const [legacyDecision] = await db.insert(operatorDecisions).values({
      companyId, requestKey: `legacy-${randomUUID()}`, requestHash: "legacy", interactionType: "single_select",
      title: "Legacy decision", sourceType: "legacy", sourceId: "legacy",
      definition: { options: [], actions: [], selection: null, comment: { mode: "disabled", label: null, placeholder: null, maxLength: 0 }, approvedScope: [], forbiddenScope: [] },
    }).returning();
    expect(legacyDecision!.qualityActionId).toBeNull();
    expect(legacyDecision!.qualityBinding).toBeNull();
    const [legacyIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(legacyIssue!.qualityPlanQaBinding).toBeNull();
    const [legacyRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(legacyRun).toBeDefined();
    const [legacyVersion] = await db.insert(evaluatorVersions).values({
      companyId, name: "Legacy evaluator",
    }).returning();
    expect(legacyVersion!.qualityActionId).toBeNull();
    expect(legacyVersion!.qualityContract).toBeNull();
  });

  it("links operator decisions and evidence refs to actions within one company", async () => {
    const actionId = await insertAction({ intentKey: "link-intent" });
    const [decision] = await db.insert(operatorDecisions).values({
      companyId, requestKey: `link-${randomUUID()}`, requestHash: "link", interactionType: "single_select",
      title: "Linked decision", sourceType: "quality", sourceId: actionId,
      definition: { options: [], actions: [], selection: null, comment: { mode: "disabled", label: null, placeholder: null, maxLength: 0 }, approvedScope: [], forbiddenScope: [] },
      qualityActionId: actionId, qualityBinding: { generation: 1 },
    }).returning();
    expect(decision!.qualityBinding).toEqual({ generation: 1 });
    const [evidence] = await db.select().from(qualityReviewItems).where(eq(qualityReviewItems.id, reviewItemId));
    expect(evidence!.companyId).toBe(companyId);
    await expectCode(db.insert(qualityOccurrences).values({
      companyId: otherCompanyId, reviewItemId, producerRunId: runId, submissionKey: "mix",
      payloadHash: "09".repeat(32), sourceBinding: {} as never, evidenceRefIds: [], occurredAt: iso(0), receivedAt: iso(0),
    }), "23503");
  });
});
