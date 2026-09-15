// server/src/__tests__/quality-decision-races.test.ts
//
// [purpose] T5 결정 경합: 같은 선택 동시 제출은 정확히 하나(나머지는 저장 snapshot 대비 재전송),
//   다른 선택 경합은 409, 동시 카드 생성은 한 행(결정적 requestKey 재전송).

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  operatorDecisions,
  qualityActions,
} from "@paperclipai/db";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { seedQualityFixture, type QualityFixture } from "./helpers/quality-fixture.js";
import { hashContract } from "../services/quality/contract.js";
import {
  createQualityDecisionCard,
  qualityDecisionBindingSchema,
  resolveQualityDecision,
  type ResolveQualityDecision,
} from "../services/quality/decisions.js";

const reviewer = { userId: "quality-reviewer-1", source: "session" as const, keyId: null };

async function seedEvaluateAction(db: import("@paperclipai/db").Db, f: QualityFixture) {
  const actionId = randomUUID();
  const intentKey = `t5-race-${actionId.slice(0, 8)}`;
  const target = {
    kind: "qa_addendum" as const,
    companyId: f.companyId,
    templateId: f.templateId,
    baseHash: f.baseHash,
    requirementVersionId: "req-fixture-1",
    inputHash: "33".repeat(32),
    candidateVersionId: randomUUID(),
    evaluationId: randomUUID(),
    intentKey,
    execution: { kind: "not_yet_accepted" as const, reason: "new_improvement_execution" as const },
  };
  const effect = { kind: "evaluate_candidate" as const, target };
  await db.insert(qualityActions).values({
    id: actionId,
    companyId: f.companyId,
    groupId: f.groupId,
    kind: "qa_addendum",
    occurrenceSetHash: "21".repeat(32),
    occurrenceIds: [],
    policyVersionId: f.policyVersionId,
    scopeVersion: 1,
    target,
    targetHash: hashContract(target),
    effect,
    effectHash: hashContract(effect),
    retryEnvelope: {
      intentKey,
      effectHash: hashContract(effect),
      targetHash: hashContract(target),
      maxExecutorAttempts: 4,
      deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
      groupId: f.groupId,
      policyVersionId: f.policyVersionId,
      maxCumulativeCostCents: 100,
    },
    revision: 1,
    state: "created",
    intentKey,
  });
  return actionId;
}

describeQualityDb("quality decision races", () => {
  let owned: QualityTestDb;
  let f: QualityFixture;
  beforeAll(async () => {
    owned = await createQualityTestDb();
    f = await seedQualityFixture(owned.db);
  }, 120_000);
  afterAll(async () => { await owned?.close(); });
  const db = () => owned.db;

  async function cardInput(actionId: string): Promise<{ decisionId: string; input: Omit<ResolveQualityDecision, "selectedOptionId"> }> {
    const card = await createQualityDecisionCard(db(), reviewer, { companyId: f.companyId, actionId });
    const [row] = await db().select().from(operatorDecisions).where(eq(operatorDecisions.id, card.operatorDecisionId));
    const binding = qualityDecisionBindingSchema.parse(row!.qualityBinding);
    return {
      decisionId: card.operatorDecisionId,
      input: {
        schemaVersion: 1,
        actionId,
        operatorDecisionId: card.operatorDecisionId,
        effectHash: binding.effectHash,
        targetHash: binding.targetHash,
        snapshotHash: binding.snapshotHash,
        evidenceRevision: binding.evidenceRevision,
        policyVersionId: binding.policyVersionId,
        scopeVersion: binding.scopeVersion,
      },
    };
  }

  it("admits exactly one of two concurrent identical submissions and replays the other", async () => {
    const actionId = await seedEvaluateAction(db(), f);
    const { decisionId, input } = await cardInput(actionId);
    const settled = await Promise.allSettled([
      resolveQualityDecision(db(), reviewer, { ...input, selectedOptionId: "proceed" }),
      resolveQualityDecision(db(), reviewer, { ...input, selectedOptionId: "proceed" }),
    ]);
    expect(settled.every((r) => r.status === "fulfilled")).toBe(true);
    const results = settled.map((r) => (r as PromiseFulfilledResult<{ replayed: boolean }>).value);
    expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
    const [action] = await db().select().from(qualityActions).where(eq(qualityActions.id, actionId));
    expect(action!.revision).toBe(2);
    expect(action!.state).toBe("authorized");
    const audits = await db().select().from(activityLog).where(eq(activityLog.entityId, decisionId));
    expect(audits.filter((a) => a.action === "quality.decision_authorized")).toHaveLength(1);
    const [decision] = await db().select().from(operatorDecisions).where(eq(operatorDecisions.id, decisionId));
    expect(decision!.status).toBe("resolved");
  });

  it("rejects the loser of two concurrent different selections with 409", async () => {
    const actionId = await seedEvaluateAction(db(), f);
    const { input } = await cardInput(actionId);
    const settled = await Promise.allSettled([
      resolveQualityDecision(db(), reviewer, { ...input, selectedOptionId: "proceed" }),
      resolveQualityDecision(db(), reviewer, { ...input, selectedOptionId: "reject" }),
    ]);
    const rejected = settled.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    const fulfilled = settled.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ replayed: boolean }>[];
    expect(rejected).toHaveLength(1);
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]!.value.replayed).toBe(false);
    expect((rejected[0]!.reason as { status: number }).status).toBe(409);
    const [action] = await db().select().from(qualityActions).where(eq(qualityActions.id, actionId));
    expect(["authorized", "rejected"]).toContain(action!.state);
  });

  it("creates exactly one card for concurrent identical card creations", async () => {
    const actionId = await seedEvaluateAction(db(), f);
    const settled = await Promise.allSettled([
      createQualityDecisionCard(db(), reviewer, { companyId: f.companyId, actionId }),
      createQualityDecisionCard(db(), reviewer, { companyId: f.companyId, actionId }),
    ]);
    expect(settled.every((r) => r.status === "fulfilled")).toBe(true);
    const ids = settled.map((r) => (r as PromiseFulfilledResult<{ operatorDecisionId: string }>).value.operatorDecisionId);
    expect(new Set(ids).size).toBe(1);
    const rows = await db().select().from(operatorDecisions).where(eq(operatorDecisions.qualityActionId, actionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.continuationMode).toBe("none");
  });
});
