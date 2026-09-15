// server/src/__tests__/quality-decision-generations.test.ts
//
// [purpose] T5 결정 세대·순수 계약 회귀(quality-decisions.test.ts 300행 분리 형제 파일):
//   source attempt 해시 권위 불이행, createsIntent, 세대 승계(supersedesDecisionId),
//   TTL 만료(알림·재확인만), reevaluate 승인 requirement version 한정, CAS 이후 검증 실패 시
//   결정 pending 롤백.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { operatorDecisions, qualityActions, type Db } from "@paperclipai/db";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { seedQualityFixture, type QualityFixture } from "./helpers/quality-fixture.js";
import { hashContract } from "../services/quality/contract.js";
import { createsIntent } from "../services/quality/targets.js";
import {
  createQualityDecisionCard,
  qualityDecisionBindingSchema,
  resolveQualityDecision,
} from "../services/quality/decisions.js";

const reviewer = { userId: "quality-reviewer-1", source: "session" as const, keyId: null };

describe("hashContract source attempt authority", () => {
  it("does not transfer source attempt authority", () => {
    const a = { issueId: "issue", heartbeatRunId: "attempt-a", generation: 1 };
    expect(hashContract(a)).not.toBe(hashContract({ ...a, heartbeatRunId: "attempt-b" }));
  });
});

describe("createsIntent", () => {
  it("is false only for hold and reject", () => {
    expect(createsIntent("repair_supported_output")).toBe(true);
    expect(createsIntent("evaluate_candidate")).toBe(true);
    expect(createsIntent("select_candidate")).toBe(true);
    expect(createsIntent("reevaluate_requirements")).toBe(true);
    expect(createsIntent("hold")).toBe(false);
    expect(createsIntent("reject")).toBe(false);
  });
});

describeQualityDb("quality decision generations", () => {
  let owned: QualityTestDb;
  let f: QualityFixture;
  beforeAll(async () => {
    owned = await createQualityTestDb();
    f = await seedQualityFixture(owned.db);
  }, 120_000);
  afterAll(async () => { await owned?.close(); });
  const db = () => owned.db;

  async function seedEvaluateAction(targetOverrides: Record<string, unknown> = {}) {
    const actionId = randomUUID();
    const intentKey = `t5-gen-${actionId.slice(0, 8)}`;
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
      ...targetOverrides,
    };
    const effect = { kind: "evaluate_candidate" as const, target };
    await db().insert(qualityActions).values({
      id: actionId, companyId: f.companyId, groupId: f.groupId, kind: "qa_addendum",
      occurrenceSetHash: "21".repeat(32), occurrenceIds: [], policyVersionId: f.policyVersionId, scopeVersion: 1,
      target, targetHash: hashContract(target), effect, effectHash: hashContract(effect),
      retryEnvelope: {
        intentKey, effectHash: hashContract(effect), targetHash: hashContract(target), maxExecutorAttempts: 4,
        deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
        groupId: f.groupId, policyVersionId: f.policyVersionId, maxCumulativeCostCents: 100,
      },
      revision: 1, state: "created", intentKey,
    });
    return { actionId, target };
  }

  async function loadBinding(db: Db, decisionId: string) {
    const [row] = await db.select().from(operatorDecisions).where(eq(operatorDecisions.id, decisionId));
    return qualityDecisionBindingSchema.parse(row!.qualityBinding);
  }

  function resolveInput(binding: Awaited<ReturnType<typeof loadBinding>>, actionId: string, decisionId: string, selectedOptionId: string) {
    return {
      schemaVersion: 1 as const, actionId, operatorDecisionId: decisionId, selectedOptionId,
      effectHash: binding.effectHash, targetHash: binding.targetHash, snapshotHash: binding.snapshotHash,
      evidenceRevision: binding.evidenceRevision, policyVersionId: binding.policyVersionId, scopeVersion: binding.scopeVersion,
    };
  }

  it("supersedes a decided card with a new snapshot instead of mutating it", async () => {
    const { actionId } = await seedEvaluateAction();
    const first = await createQualityDecisionCard(db(), reviewer, { companyId: f.companyId, actionId });
    const firstBinding = await loadBinding(db(), first.operatorDecisionId);
    await resolveQualityDecision(db(), reviewer, resolveInput(firstBinding, actionId, first.operatorDecisionId, "hold"));
    const second = await createQualityDecisionCard(db(), reviewer, { companyId: f.companyId, actionId });
    expect(second.operatorDecisionId).not.toBe(first.operatorDecisionId);
    const secondBinding = await loadBinding(db(), second.operatorDecisionId);
    expect(secondBinding.decisionGeneration).toBe(2);
    expect(secondBinding.supersedesDecisionId).toBe(first.operatorDecisionId);
    const [old] = await db().select().from(operatorDecisions).where(eq(operatorDecisions.id, first.operatorDecisionId));
    expect(old!.status).toBe("resolved");
  });

  it("expires cards by TTL; expiry only re-confirms via a fresh generation", async () => {
    const { actionId } = await seedEvaluateAction();
    const expired = await createQualityDecisionCard(db(), reviewer, {
      companyId: f.companyId, actionId, now: new Date(Date.now() - 2 * 3_600_000),
    });
    expect(expired.replayed).toBe(false);
    const binding = await loadBinding(db(), expired.operatorDecisionId);
    expect(Date.parse(binding.expiresAt)).toBeLessThan(Date.now());
    await expect(resolveQualityDecision(db(), reviewer, resolveInput(binding, actionId, expired.operatorDecisionId, "proceed")))
      .rejects.toMatchObject({ status: 409, message: "quality_decision_expired" });
    const [decision] = await db().select().from(operatorDecisions).where(eq(operatorDecisions.id, expired.operatorDecisionId));
    expect(decision!.status).toBe("pending");
    const fresh = await createQualityDecisionCard(db(), reviewer, { companyId: f.companyId, actionId });
    expect((await loadBinding(db(), fresh.operatorDecisionId)).decisionGeneration).toBe(2);
  });

  it("allows reevaluate only for a policy-approved requirement version", async () => {
    const { actionId, target } = await seedEvaluateAction({ templateId: randomUUID() });
    const effect = { kind: "reevaluate_requirements" as const, requirementVersionId: target.requirementVersionId, target };
    const [row] = await db().select().from(qualityActions).where(eq(qualityActions.id, actionId));
    await db().update(qualityActions).set({
      effect,
      effectHash: hashContract(effect),
      retryEnvelope: { ...row!.retryEnvelope, effectHash: hashContract(effect) },
    }).where(eq(qualityActions.id, actionId));
    await expect(createQualityDecisionCard(db(), reviewer, { companyId: f.companyId, actionId }))
      .rejects.toMatchObject({ status: 409, message: "quality_requirement_version_unapproved" });
  });

  it("does not relabel a bound execution as rejected — cancellation is the dedicated path", async () => {
    const { actionId } = await seedEvaluateAction();
    const card = await createQualityDecisionCard(db(), reviewer, { companyId: f.companyId, actionId });
    // 이미 정식 연결이 있는 조치: 거절은 표시 상태만 바꿔 살아 있는 실행을 가릴 수 없다.
    await db().update(qualityActions).set({
      state: "bound",
      canonicalBinding: { companyId: f.companyId, actionId, missionId: randomUUID(), workflowRunId: randomUUID(), stepRunId: randomUUID(), issueId: randomUUID() },
    }).where(eq(qualityActions.id, actionId));
    const binding = await loadBinding(db(), card.operatorDecisionId);
    await expect(resolveQualityDecision(db(), reviewer, resolveInput(binding, actionId, card.operatorDecisionId, "reject")))
      .rejects.toMatchObject({ status: 409, message: "quality_action_cancel_required" });
    const [decision] = await db().select().from(operatorDecisions).where(eq(operatorDecisions.id, card.operatorDecisionId));
    expect(decision!.status).toBe("pending");
  });

  it("keeps the decision pending when a post-CAS check fails in the same transaction", async () => {
    const actionId = randomUUID();
    const intentKey = `t5-co-${actionId.slice(0, 8)}`;
    const target = {
      kind: "current_output" as const,
      source: {
        companyId: f.companyId, issueId: randomUUID(), heartbeatRunId: randomUUID(), executionEpoch: 1,
        inputHash: "66".repeat(32),
        mission: { kind: "not_applicable" as const, reason: "no_source_mission" as const },
        workflow: { kind: "not_applicable" as const, reason: "not_a_workflow_source" as const },
      },
    };
    const effect = { kind: "repair_supported_output" as const, target };
    await db().insert(qualityActions).values({
      id: actionId, companyId: f.companyId, groupId: f.groupId, kind: "current_output",
      occurrenceSetHash: "21".repeat(32), occurrenceIds: [], policyVersionId: f.policyVersionId, scopeVersion: 1,
      target, targetHash: hashContract(target), effect, effectHash: hashContract(effect),
      retryEnvelope: {
        intentKey, effectHash: hashContract(effect), targetHash: hashContract(target), maxExecutorAttempts: 2,
        deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
        groupId: f.groupId, policyVersionId: f.policyVersionId, maxCumulativeCostCents: 100,
      },
      revision: 1, state: "created", intentKey,
    });
    const card = await createQualityDecisionCard(db(), reviewer, { companyId: f.companyId, actionId });
    const binding = await loadBinding(db(), card.operatorDecisionId);
    // CAS 성공 후 원본 시도 liveness 가 실제 DB 관계에서 실패 → 전체 롤백(결정도 pending 유지).
    await expect(resolveQualityDecision(db(), reviewer, resolveInput(binding, actionId, card.operatorDecisionId, "proceed")))
      .rejects.toMatchObject({ status: 409, message: "quality_current_output_binding_unavailable" });
    const [decision] = await db().select().from(operatorDecisions).where(eq(operatorDecisions.id, card.operatorDecisionId));
    expect(decision!.status).toBe("pending");
    expect(decision!.result).toBeNull();
    const [action] = await db().select().from(qualityActions).where(eq(qualityActions.id, actionId));
    expect(action!.state).toBe("created");
    expect(action!.currentDecisionId).toBeNull();
    expect(action!.revision).toBe(1);
  });
});
