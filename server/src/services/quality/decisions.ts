// server/src/services/quality/decisions.ts
//
// [purpose] T5 사람 결정 원자화. 카드 생성 tx: action+operator decision+불변 snapshot 연결 +
//   continuationMode=none 강제(DB check 와 이중 방어). resolve tx: 현재 membership/admin/key·
//   정책 reviewer role·snapshot/expiry·exact effect/target·evidence/current evaluation·원본 시도
//   liveness 확인 후 선택·감사·허용 intent 를 함께 저장. hold/reject 는 부작용 0.
// [ordering] §3.3: policy usage → group → action 잠금 후 decision CAS. 이후 실패는 전체 롤백
//   (결정도 pending). 커밋 전 깨우기 금지 — 전달은 라우트가 커밋 후 deliverQualityIntent 로.

import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  missionPlanTemplates,
  missions,
  operatorDecisions,
  qualityActionGroups,
  qualityActions,
  qualityPolicyUsage,
  qualityPolicyVersions,
  workflowRuns,
} from "@paperclipai/db";
import {
  qualityEffectSchema,
  qualityPolicySchema,
  qualityTargetSchema,
  retryEnvelopeSchema,
  uuidSchema,
  type QualityEffect,
  type QualityHumanActor,
  type QualityPolicy,
  type QualityTarget,
} from "@paperclipai/shared";
import { z } from "zod";
import { conflict, forbidden, notFound, unprocessable } from "../../errors.js";
import { hashContract, parseEvidence } from "./contract.js";
import { assertQualityHuman } from "./actor.js";
import { buildDefinition, buildOptions, decisionOptionIdSchema, sameTarget, qualityDecisionOptionSchema } from "./targets.js";
import { verifySourceAttempt } from "./evidence-verifier.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type ActionRow = typeof qualityActions.$inferSelect;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const bindingFields = {
  schemaVersion: z.literal(1),
  actionId: uuidSchema,
  groupId: uuidSchema,
  policyVersionId: uuidSchema,
  scopeVersion: z.number().int().min(1),
  targetHash: z.string().regex(/^[0-9a-f]{64}$/),
  effectHash: z.string().regex(/^[0-9a-f]{64}$/),
  evidenceRevision: z.string().min(1).max(200),
  evaluationId: uuidSchema.nullable(),
  decisionGeneration: z.number().int().min(1),
  supersedesDecisionId: uuidSchema.nullable(),
  expiresAt: z.string().datetime(),
  target: qualityTargetSchema,
  options: z.array(qualityDecisionOptionSchema).min(1).max(3).refine((o) => new Set(o.map((x) => x.optionId)).size === o.length, "quality_duplicate_entry"),
};
/** 저장 결정 세대·불변 스냅샷·허용 효과·만료(§3.1 operator_decisions.qualityBinding). */
export const qualityDecisionBindingSchema = z.object({ ...bindingFields, snapshotHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict()
  .refine((binding) => {
    const { snapshotHash: _hash, ...core } = binding;
    return hashContract(core) === binding.snapshotHash;
  }, "quality_decision_snapshot_invalid");
export type QualityDecisionBinding = z.infer<typeof qualityDecisionBindingSchema>;

export type ResolveQualityDecision = {
  schemaVersion: 1; actionId: string; operatorDecisionId: string;
  selectedOptionId: string; effectHash: string; targetHash: string;
  snapshotHash: string; evidenceRevision: string;
  policyVersionId: string; scopeVersion: string | number;
};
export const resolveQualityDecisionInputSchema = z.object({
  schemaVersion: z.literal(1),
  actionId: uuidSchema,
  operatorDecisionId: uuidSchema,
  selectedOptionId: decisionOptionIdSchema,
  effectHash: z.string().regex(/^[0-9a-f]{64}$/),
  targetHash: z.string().regex(/^[0-9a-f]{64}$/),
  snapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
  evidenceRevision: z.string().min(1).max(200),
  policyVersionId: uuidSchema,
  scopeVersion: z.coerce.number().int().min(1),
}).strict();

const evidenceRevisionOf = (action: ActionRow) => `rev:${action.revision}:${action.occurrenceSetHash}`;
const outcomeOf = { apply_effect: "submit", hold: "hold", reject: "reject" } as const;
async function lockAction(tx: Tx, companyId: string, actionId: string): Promise<ActionRow> {
  const [pre] = await tx.select({ groupId: qualityActions.groupId, policyVersionId: qualityActions.policyVersionId })
    .from(qualityActions).where(and(eq(qualityActions.companyId, companyId), eq(qualityActions.id, actionId)));
  if (!pre) throw notFound("quality_action_not_found");
  await tx.select({ id: qualityPolicyUsage.id }).from(qualityPolicyUsage)
    .where(and(eq(qualityPolicyUsage.companyId, companyId), eq(qualityPolicyUsage.policyVersionId, pre.policyVersionId)))
    .orderBy(asc(qualityPolicyUsage.windowStart), asc(qualityPolicyUsage.id)).for("update");
  await tx.select({ id: qualityActionGroups.id }).from(qualityActionGroups)
    .where(and(eq(qualityActionGroups.companyId, companyId), eq(qualityActionGroups.id, pre.groupId))).for("update");
  const [action] = await tx.select().from(qualityActions)
    .where(and(eq(qualityActions.companyId, companyId), eq(qualityActions.id, actionId))).for("update");
  if (!action) throw notFound("quality_action_not_found");
  return action;
}

async function loadActivePolicy(tx: Tx, companyId: string, policyVersionId: string): Promise<QualityPolicy> {
  const [row] = await tx.select().from(qualityPolicyVersions)
    .where(and(eq(qualityPolicyVersions.companyId, companyId), eq(qualityPolicyVersions.id, policyVersionId))).for("share");
  if (!row || !row.approvedAt || !row.enabledAt || row.disabledAt) throw conflict("quality_policy_inactive");
  const policy = parseEvidence(qualityPolicySchema, row.definition);
  const now = new Date();
  if (now < new Date(policy.periodStart) || now >= new Date(policy.periodEnd)) throw conflict("quality_policy_outside_period");
  return policy;
}

function assertFixedAction(action: ActionRow): { target: QualityTarget; effect: QualityEffect } {
  const target = parseEvidence(qualityTargetSchema, action.target);
  const effect = parseEvidence(qualityEffectSchema, action.effect);
  const envelope = parseEvidence(retryEnvelopeSchema, action.retryEnvelope);
  if (hashContract(target) !== action.targetHash || hashContract(effect) !== action.effectHash
    || envelope.targetHash !== action.targetHash || envelope.effectHash !== action.effectHash
    || envelope.intentKey !== action.intentKey || envelope.groupId !== action.groupId) {
    throw conflict("quality_action_contract_mismatch");
  }
  return { target, effect };
}

/** reevaluate 는 활성 정책 target+템플릿 해시가 일치하는 승인 requirement version 만 선택할 수 있다. */
async function assertApprovedRequirement(tx: Tx, companyId: string, policy: QualityPolicy, effect: QualityEffect, target: QualityTarget) {
  if (effect.kind !== "reevaluate_requirements" || target.kind !== "qa_addendum") return;
  const approved = policy.targets.some((entry) => entry.templateId === target.templateId && entry.baseHash === target.baseHash);
  const [template] = await tx.select().from(missionPlanTemplates)
    .where(and(eq(missionPlanTemplates.companyId, companyId), eq(missionPlanTemplates.id, target.templateId))).for("share");
  if (!approved || !template?.enabled || sha256(template.instructions) !== target.baseHash) {
    throw conflict("quality_requirement_version_unapproved");
  }
}

/** resolve 시점 원본 시도 liveness: terminal 원본은 원본 유지로 거절, 시도 정합성은 스키마 검증된 실제 DB 관계로만. */
async function reverifyLiveSource(tx: Tx, companyId: string, target: QualityTarget) {
  if (target.kind !== "current_output") return;
  const source = target.source;
  const [missionRow] = source.mission.kind === "mission"
    ? await tx.select({ status: missions.status }).from(missions).where(and(eq(missions.companyId, companyId), eq(missions.id, source.mission.id))).for("share")
    : [undefined];
  const [runRow] = source.workflow.kind === "workflow_step"
    ? await tx.select({ status: workflowRuns.status }).from(workflowRuns).where(and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.id, source.workflow.runId))).for("share")
    : [undefined];
  if ((missionRow && ["completed", "cancelled"].includes(missionRow.status))
    || (runRow && ["completed", "cancelled", "aborted", "failed", "timed-out"].includes(runRow.status ?? ""))) {
    throw conflict("quality_source_preserved");
  }
  try {
    await verifySourceAttempt(tx, companyId, source);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("quality_")) throw conflict("quality_current_output_binding_unavailable");
    throw error;
  }
}

/** 카드 생성: action+operator decision+snapshot 원자 연결. 결정 세대·group 계수는 새 카드로 초기화하지 않는다. */
export async function createQualityDecisionCard(db: Db, actor: QualityHumanActor, input: {
  companyId: string; actionId: string; supersedesDecisionId?: string | null; now?: Date;
}): Promise<{ operatorDecisionId: string; replayed: boolean; expiresAt: string }> {
  const parsedInput = parseEvidence(z.object({
    companyId: uuidSchema, actionId: uuidSchema,
    supersedesDecisionId: uuidSchema.nullable().optional(), now: z.date().optional(),
  }).strict(), input);
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const action = await lockAction(tx, parsedInput.companyId, parsedInput.actionId);
    if (action.cancelRequestedAt) throw conflict("quality_action_cancelled");
    if (["rejected", "corrected"].includes(action.state)) throw conflict("quality_action_not_decidable");
    const { target, effect } = assertFixedAction(action);
    const policy = await loadActivePolicy(tx, parsedInput.companyId, action.policyVersionId);
    await assertApprovedRequirement(tx, parsedInput.companyId, policy, effect, target);
    await assertQualityHuman(tx, parsedInput.companyId, actor);

    const existing = await tx.select().from(operatorDecisions)
      .where(and(eq(operatorDecisions.companyId, parsedInput.companyId), eq(operatorDecisions.qualityActionId, parsedInput.actionId)));
    const bindings = existing.map((row) => ({ row, binding: qualityDecisionBindingSchema.safeParse(row.qualityBinding) }));
    const requestHashFor = (generation: number) => hashContract({ actionId: parsedInput.actionId, generation, targetHash: action.targetHash, effectHash: action.effectHash, evidenceRevision: evidenceRevisionOf(action) });
    // 살아 있는 최신 세대가 현재 내용과 동일하면 멱등 재전송(해결/취소 카드는 다음 세대의 선행 조치).
    const parsed = bindings.filter((entry): entry is { row: typeof operatorDecisions.$inferSelect; binding: z.SafeParseSuccess<QualityDecisionBinding> } => entry.binding.success)
      .map((entry) => ({ row: entry.row, binding: entry.binding }));
    const latest = parsed
      .sort((a, b) => b.binding.data.decisionGeneration - a.binding.data.decisionGeneration)[0] ?? null;
    const latestLive = latest != null && latest.row.status === "pending"
      && Date.parse(latest.binding.data.expiresAt) > now.getTime();
    if (latestLive && latest.row.requestHash === requestHashFor(latest.binding.data.decisionGeneration)) {
      return { operatorDecisionId: latest.row.id, replayed: true, expiresAt: latest.binding.data.expiresAt };
    }
    for (const entry of parsed) {
      if (entry.row.status === "pending" && Date.parse(entry.binding.data.expiresAt) > now.getTime()) {
        throw conflict("quality_decision_pending_exists");
      }
    }
    const generation = Math.max(latest?.binding.data.decisionGeneration ?? 0, existing.length) + 1;
    const requestKey = `quality-decision:${parsedInput.actionId}:g${generation}`;
    const requestHash = requestHashFor(generation);
    let supersedes = latest?.row.id ?? null;
    if (parsedInput.supersedesDecisionId != null) {
      if (!existing.some((row) => row.id === parsedInput.supersedesDecisionId)) throw conflict("quality_decision_supersede_invalid");
      supersedes = parsedInput.supersedesDecisionId;
    }
    const options = buildOptions(effect);
    const core = {
      schemaVersion: 1 as const, actionId: action.id, groupId: action.groupId, policyVersionId: action.policyVersionId,
      scopeVersion: action.scopeVersion, targetHash: action.targetHash, effectHash: action.effectHash,
      evidenceRevision: evidenceRevisionOf(action), evaluationId: action.currentEvaluationId,
      decisionGeneration: generation, supersedesDecisionId: supersedes,
      expiresAt: new Date(now.getTime() + policy.decisionTtlSeconds * 1000).toISOString(),
      target, options,
    };
    const binding = { ...core, snapshotHash: hashContract(core) };
    qualityDecisionBindingSchema.parse(binding);
    const [created] = await tx.insert(operatorDecisions).values({
      id: randomUUID(), companyId: parsedInput.companyId, qualityActionId: parsedInput.actionId, qualityBinding: binding,
      requestKey, requestHash, schemaVersion: 1, priority: "high", interactionType: "single_select",
      title: `Quality decision: ${effect.kind}`, description: `Fixed quality action ${action.intentKey}`,
      sourceType: "quality_action", sourceId: parsedInput.actionId,
      sourceContext: { missionId: null, workflowId: null, workflowRunId: null, artifactRefs: [] },
      issueId: null, requestedByUserId: actor.userId, definition: buildDefinition(effect), continuationMode: "none",
    }).returning({ id: operatorDecisions.id });
    await tx.insert(activityLog).values({
      companyId: parsedInput.companyId, actorType: "user", actorId: actor.userId,
      action: "quality.decision_card_created", entityType: "operator_decision", entityId: created!.id,
      details: { schemaVersion: 1, actionId: parsedInput.actionId, generation, supersedesDecisionId: supersedes, expiresAt: binding.expiresAt },
    });
    return { operatorDecisionId: created!.id, replayed: false, expiresAt: binding.expiresAt };
  });
}

export async function resolveQualityDecision(db: Db, actor: QualityHumanActor, input: ResolveQualityDecision): Promise<{ actionId: string; revision: number; replayed: boolean }> {
  const value = parseEvidence(resolveQualityDecisionInputSchema, input);
  return db.transaction(async (tx) => {
    const [seed] = await tx.select({ companyId: qualityActions.companyId }).from(qualityActions).where(eq(qualityActions.id, value.actionId));
    if (!seed) throw notFound("quality_action_not_found");
    const locked = await lockAction(tx, seed.companyId, value.actionId);
    const [decision] = await tx.select().from(operatorDecisions).where(eq(operatorDecisions.id, value.operatorDecisionId)).for("update");
    if (!decision || decision.companyId !== locked.companyId) throw notFound("quality_decision_not_found");
    if (decision.qualityActionId !== locked.id) throw conflict("quality_decision_binding_mismatch");

    const binding = parseEvidence(qualityDecisionBindingSchema, decision.qualityBinding);
    if (Date.now() >= Date.parse(binding.expiresAt)) throw conflict("quality_decision_expired");
    await assertQualityHuman(tx, locked.companyId, actor);
    const policy = await loadActivePolicy(tx, locked.companyId, binding.policyVersionId);
    if (!policy.reviewerUserIds.includes(actor.userId)) throw forbidden("quality_decision_role_required");

    const option = binding.options.find((entry) => entry.optionId === value.selectedOptionId);
    if (!option) throw unprocessable("quality_decision_option_invalid");
    const requestMatches = value.effectHash === binding.effectHash && value.targetHash === binding.targetHash
      && value.snapshotHash === binding.snapshotHash && value.evidenceRevision === binding.evidenceRevision
      && value.policyVersionId === binding.policyVersionId && value.scopeVersion === binding.scopeVersion;
    const snapshotMatches = requestMatches && locked.targetHash === binding.targetHash && locked.effectHash === binding.effectHash
      && locked.policyVersionId === binding.policyVersionId && locked.scopeVersion === binding.scopeVersion
      && locked.groupId === binding.groupId && locked.currentEvaluationId === binding.evaluationId
      && evidenceRevisionOf(locked) === binding.evidenceRevision
      && sameTarget(binding.target, parseEvidence(qualityTargetSchema, locked.target));
    const now = new Date();
    const [updated] = await tx.update(operatorDecisions).set({
      status: "resolved",
      result: { actionId: option.optionId, outcome: outcomeOf[option.op], selectedOptionIds: [option.optionId], comment: null },
      resolvedByUserId: actor.userId, resolvedAt: now, updatedAt: now,
    }).where(and(eq(operatorDecisions.id, decision.id), eq(operatorDecisions.status, "pending"))).returning();
    if (!updated) {
      // 동일 재전송: 저장 당시 snapshot 대비만 비교하고 새 권한을 발급하지 않는다.
      const [current] = await tx.select().from(operatorDecisions).where(eq(operatorDecisions.id, decision.id));
      const sameSelection = current?.result?.selectedOptionIds?.[0] === value.selectedOptionId;
      if (current?.status === "resolved" && sameSelection && requestMatches) {
        return { actionId: locked.id, revision: locked.revision, replayed: true };
      }
      throw conflict("quality_decision_conflict", { status: current?.status ?? "missing" });
    }
    if (!snapshotMatches) throw conflict("quality_decision_snapshot_stale");
    const { target } = assertFixedAction(locked);
    if (option.op === "apply_effect" && option.effectHash !== locked.effectHash) throw conflict("quality_decision_snapshot_stale");
    // 이미 정식 연결(bound)된 실행은 카드 거절로 되돌릴 수 없다 — 중단은 전용 cancel intent 경로다.
    if (option.op === "reject" && locked.canonicalBinding) throw conflict("quality_action_cancel_required", { actionId: locked.id });
    await reverifyLiveSource(tx, locked.companyId, target);

    let revision = locked.revision;
    if (option.op === "apply_effect" || option.op === "reject") {
      const nextState = option.op === "apply_effect" ? "authorized" : "rejected";
      const rows = await tx.update(qualityActions)
        .set({ state: nextState, currentDecisionId: decision.id, revision: locked.revision + 1, updatedAt: now })
        .where(and(eq(qualityActions.companyId, locked.companyId), eq(qualityActions.id, locked.id), eq(qualityActions.revision, locked.revision)))
        .returning({ revision: qualityActions.revision });
      if (rows.length !== 1) throw conflict("quality_decision_intent_conflict"); // 전체 롤백 — 결정도 pending
      revision = rows[0]!.revision;
    }
    await tx.insert(activityLog).values({
      companyId: locked.companyId, actorType: "user", actorId: actor.userId,
      action: option.op === "apply_effect" ? "quality.decision_authorized" : option.op === "hold" ? "quality.decision_held" : "quality.decision_rejected",
      entityType: "operator_decision", entityId: decision.id,
      details: { schemaVersion: 1, actionId: locked.id, optionId: option.optionId, revision, targetHash: binding.targetHash },
    });
    return { actionId: locked.id, revision, replayed: false };
  });
}
