// server/src/__tests__/quality-decisions.test.ts
//
// [purpose] T5 사람 결정 원자화: 카드 생성 tx(action+decision+snapshot, continuationMode=none),
//   resolve tx(현재 권한·정책 role·snapshot·exact effect/target·evidence/current evaluation 검사 +
//   선택·감사·허용 intent 동시 저장), 재전송 무새권한, hold/reject 부작용 0.
//   세대·만료·순수 계약 회귀는 형제 파일 quality-decision-generations.test.ts 로 분리했다.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  issueComments,
  operatorDecisionContinuations,
  operatorDecisions,
  qualityActionGroups,
  qualityActions,
  type Db,
} from "@paperclipai/db";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { seedQualityFixture, type QualityFixture } from "./helpers/quality-fixture.js";
import { hashContract } from "../services/quality/contract.js";
import {
  createQualityDecisionCard,
  qualityDecisionBindingSchema,
  resolveQualityDecision,
} from "../services/quality/decisions.js";

const reviewer = { userId: "quality-reviewer-1", source: "session" as const, keyId: null };

function seedEvaluateAction(db: Db, f: QualityFixture, overrides: Record<string, unknown> = {}) {
  const actionId = randomUUID();
  const intentKey = `t5-eval-${actionId.slice(0, 8)}`;
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
    ...((overrides.target as Record<string, unknown>) ?? {}),
  };
  const effect = { kind: "evaluate_candidate" as const, target };
  return db.insert(qualityActions).values({
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
  }).returning({ id: qualityActions.id }).then((rows) => ({ actionId: rows[0]!.id, target, effect }));
}

async function loadBinding(db: Db, decisionId: string) {
  const [row] = await db.select().from(operatorDecisions).where(eq(operatorDecisions.id, decisionId));
  return qualityDecisionBindingSchema.parse(row!.qualityBinding);
}

function resolveInput(binding: { snapshotHash: string; evidenceRevision: string; targetHash: string; effectHash: string; policyVersionId: string; scopeVersion: number }, actionId: string, decisionId: string, selectedOptionId: string) {
  return {
    schemaVersion: 1 as const,
    actionId,
    operatorDecisionId: decisionId,
    selectedOptionId,
    effectHash: binding.effectHash,
    targetHash: binding.targetHash,
    snapshotHash: binding.snapshotHash,
    evidenceRevision: binding.evidenceRevision,
    policyVersionId: binding.policyVersionId,
    scopeVersion: binding.scopeVersion,
  };
}

describeQualityDb("quality decision card + resolve", () => {
  let owned: QualityTestDb;
  let f: QualityFixture;
  beforeAll(async () => {
    owned = await createQualityTestDb();
    f = await seedQualityFixture(owned.db);
  }, 120_000);
  afterAll(async () => { await owned?.close(); });
  const db = () => owned.db;

  it("creates a card linking action+decision+snapshot with continuationMode none; identical re-create replays", async () => {
    const { actionId } = await seedEvaluateAction(db(), f);
    const first = await createQualityDecisionCard(db(), reviewer, { companyId: f.companyId, actionId });
    expect(first.replayed).toBe(false);
    // 같은 내용 재생성은 멱등 재전송(같은 카드, 새 권한 없음).
    const replay = await createQualityDecisionCard(db(), reviewer, { companyId: f.companyId, actionId });
    expect(replay).toMatchObject({ replayed: true, operatorDecisionId: first.operatorDecisionId });
    // 내용이 달라진(새 evidence revision) 생성은 살아 있는 pending 때문에 거부된다.
    await db().update(qualityActions).set({ revision: 9 }).where(eq(qualityActions.id, actionId));
    await expect(createQualityDecisionCard(db(), reviewer, { companyId: f.companyId, actionId }))
      .rejects.toMatchObject({ status: 409, message: "quality_decision_pending_exists" });
    const rows = await db().select().from(operatorDecisions).where(eq(operatorDecisions.qualityActionId, actionId));
    expect(rows).toHaveLength(1);
    const [decision] = rows;
    expect(decision!.continuationMode).toBe("none");
    expect(decision!.qualityActionId).toBe(actionId);
    expect(decision!.status).toBe("pending");
    const binding = qualityDecisionBindingSchema.parse(decision!.qualityBinding);
    expect(binding.actionId).toBe(actionId);
    expect(binding.decisionGeneration).toBe(1);
    expect(binding.options.map((o) => o.op).sort()).toEqual(["apply_effect", "hold", "reject"]);
    const { snapshotHash: _hash, ...core } = binding;
    expect(hashContract(core)).toBe(binding.snapshotHash);
    expect(Date.parse(binding.expiresAt)).toBeGreaterThan(Date.now());
    // group 계수·거절은 새 카드로 초기화되지 않는다: 카드 생성은 usage 를 쓰지 않는다.
    const [group] = await db().select().from(qualityActionGroups).where(eq(qualityActionGroups.id, f.groupId));
    expect(group!.usage).toEqual({});
  });

  it("omits the apply option when the fixed effect creates no intent", async () => {
    const card = await createQualityDecisionCard(db(), reviewer, { companyId: f.companyId, actionId: f.actionId });
    const binding = await loadBinding(db(), card.operatorDecisionId);
    expect(binding.options.map((o) => o.op)).toEqual(["hold", "reject"]);
  });

  it("stores selection, audit, and allowed intent together on apply", async () => {
    const { actionId } = await seedEvaluateAction(db(), f);
    const card = await createQualityDecisionCard(db(), reviewer, { companyId: f.companyId, actionId });
    const binding = await loadBinding(db(), card.operatorDecisionId);
    const result = await resolveQualityDecision(db(), reviewer, resolveInput(binding, actionId, card.operatorDecisionId, "proceed"));
    expect(result).toEqual({ actionId, revision: 2, replayed: false });
    const [decision] = await db().select().from(operatorDecisions).where(eq(operatorDecisions.id, card.operatorDecisionId));
    expect(decision!.status).toBe("resolved");
    expect(decision!.result).toMatchObject({ selectedOptionIds: ["proceed"], outcome: "submit" });
    const [action] = await db().select().from(qualityActions).where(eq(qualityActions.id, actionId));
    expect(action!.state).toBe("authorized");
    expect(action!.currentDecisionId).toBe(card.operatorDecisionId);
    const audits = await db().select().from(activityLog).where(eq(activityLog.entityId, card.operatorDecisionId));
    expect(audits.map((a) => a.action)).toEqual(["quality.decision_card_created", "quality.decision_authorized"]);
  });

  it("replays an identical submission against the stored snapshot without new authority", async () => {
    const { actionId } = await seedEvaluateAction(db(), f);
    const card = await createQualityDecisionCard(db(), reviewer, { companyId: f.companyId, actionId });
    const binding = await loadBinding(db(), card.operatorDecisionId);
    await resolveQualityDecision(db(), reviewer, resolveInput(binding, actionId, card.operatorDecisionId, "proceed"));
    const before = (await db().select().from(activityLog).where(eq(activityLog.entityId, card.operatorDecisionId))).length;
    const replay = await resolveQualityDecision(db(), reviewer, resolveInput(binding, actionId, card.operatorDecisionId, "proceed"));
    expect(replay.replayed).toBe(true);
    const [action] = await db().select().from(qualityActions).where(eq(qualityActions.id, actionId));
    expect(action!.revision).toBe(2);
    expect((await db().select().from(activityLog).where(eq(activityLog.entityId, card.operatorDecisionId))).length).toBe(before);
    await expect(resolveQualityDecision(db(), reviewer, resolveInput(binding, actionId, card.operatorDecisionId, "reject")))
      .rejects.toMatchObject({ status: 409 });
  });

  it("rejects snapshot drift: new evidence revision, changed evaluation, or replaced target A→B", async () => {
    const { actionId, target } = await seedEvaluateAction(db(), f);
    const card = await createQualityDecisionCard(db(), reviewer, { companyId: f.companyId, actionId });
    const binding = await loadBinding(db(), card.operatorDecisionId);
    await db().update(qualityActions).set({ revision: 3 }).where(eq(qualityActions.id, actionId));
    await expect(resolveQualityDecision(db(), reviewer, resolveInput(binding, actionId, card.operatorDecisionId, "proceed")))
      .rejects.toMatchObject({ status: 409, message: "quality_decision_snapshot_stale" });
    await db().update(qualityActions).set({ revision: 1, currentEvaluationId: randomUUID() }).where(eq(qualityActions.id, actionId));
    await expect(resolveQualityDecision(db(), reviewer, resolveInput(binding, actionId, card.operatorDecisionId, "proceed")))
      .rejects.toMatchObject({ status: 409, message: "quality_decision_snapshot_stale" });
    const movedTarget = { ...target, inputHash: "44".repeat(32) };
    await db().update(qualityActions).set({ currentEvaluationId: null, target: movedTarget, targetHash: hashContract(movedTarget) })
      .where(eq(qualityActions.id, actionId));
    await expect(resolveQualityDecision(db(), reviewer, resolveInput(binding, actionId, card.operatorDecisionId, "proceed")))
      .rejects.toMatchObject({ status: 409, message: "quality_decision_snapshot_stale" });
    const [decision] = await db().select().from(operatorDecisions).where(eq(operatorDecisions.id, card.operatorDecisionId));
    expect(decision!.status).toBe("pending");
  });

  it("keeps hold and reject side-effect free and makes rejection durable", async () => {
    const { actionId } = await seedEvaluateAction(db(), f);
    const card = await createQualityDecisionCard(db(), reviewer, { companyId: f.companyId, actionId });
    const binding = await loadBinding(db(), card.operatorDecisionId);
    for (const optionId of ["hold", "reject"]) {
      const before = {
        wakes: (await db().select().from(agentWakeupRequests)).length,
        continuations: (await db().select().from(operatorDecisionContinuations)).length,
        comments: (await db().select().from(issueComments)).length,
      };
      const seed = optionId === "hold" ? await seedEvaluateAction(db(), f) : null;
      const targetAction = seed ? seed.actionId : actionId;
      const targetCard = seed
        ? await createQualityDecisionCard(db(), reviewer, { companyId: f.companyId, actionId: targetAction })
        : card;
      const targetBinding = seed ? await loadBinding(db(), targetCard.operatorDecisionId) : binding;
      const result = await resolveQualityDecision(db(), reviewer, resolveInput(targetBinding, targetAction, targetCard.operatorDecisionId, optionId));
      expect(result.replayed).toBe(false);
      expect((await db().select().from(agentWakeupRequests)).length).toBe(before.wakes);
      expect((await db().select().from(operatorDecisionContinuations)).length).toBe(before.continuations);
      expect((await db().select().from(issueComments)).length).toBe(before.comments);
      const [after] = await db().select().from(qualityActions).where(eq(qualityActions.id, targetAction));
      expect(after!.cancelRequestedAt).toBeNull();
      expect(after!.canonicalBinding).toBeNull();
      expect(after!.state).toBe(optionId === "hold" ? "created" : "rejected");
    }
    // 같은 효과를 새 카드로 포장해도 거절은 초기화되지 않는다.
    await expect(createQualityDecisionCard(db(), reviewer, { companyId: f.companyId, actionId }))
      .rejects.toMatchObject({ status: 409, message: "quality_action_not_decidable" });
  });
});
