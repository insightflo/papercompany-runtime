import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { missionPlanTemplates, type Db } from "@paperclipai/db";
import { operatorDecisionDefinitionSchema } from "@paperclipai/shared/validators/operator-decision";
import { qualityTargetSchema, type QualityEffect, type QualityPolicy, type QualityTarget } from "@paperclipai/shared";
import { z } from "zod";
import { conflict } from "../../errors.js";
import { hashContract } from "./contract.js";

export type QualityTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** A later candidate/evaluation is a new fixed target, never a wildcard match. */
export function sameTarget(a: QualityTarget, b: QualityTarget): boolean {
  return hashContract(qualityTargetSchema.parse(a)) === hashContract(qualityTargetSchema.parse(b));
}

/** hold/reject 는 실행 intent 를 만들지 않는다(전달·깨우기·continuation 0). */
export function createsIntent(kind: QualityEffect["kind"]): boolean {
  return kind !== "hold" && kind !== "reject";
}

export const decisionOptionIdSchema = z.string().regex(/^(proceed|hold|reject)$/);
const optionId = decisionOptionIdSchema;

/** 허용 효과 strict union — 카드 문구(라벨·설명)는 표시용이며 권한의 원천이 아니다. */
export const qualityDecisionOptionSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("apply_effect"), optionId, effectHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  z.object({ op: z.literal("hold"), optionId }).strict(),
  z.object({ op: z.literal("reject"), optionId }).strict(),
]);
export type QualityDecisionOption = z.infer<typeof qualityDecisionOptionSchema>;

/** 고정 효과에서 카드 선택지를 만든다: intent 를 만드는 효과만 apply 선택지를 가진다. */
export function buildOptions(effect: QualityEffect): QualityDecisionOption[] {
  const options: QualityDecisionOption[] = [];
  if (createsIntent(effect.kind)) options.push({ op: "apply_effect", optionId: "proceed", effectHash: hashContract(effect) });
  options.push({ op: "hold", optionId: "hold" }, { op: "reject", optionId: "reject" });
  return options;
}

/** 카드 정의(표시용) — 발생/근거/결정 문구는 권위가 아니고 위 strict union 만이 허용 효과다. */
export function buildDefinition(effect: QualityEffect) {
  const actions: Array<{ id: string; label: string; outcome: "submit" | "hold" | "reject"; tone: "primary" | "neutral" | "danger"; requiresSelection: boolean }> = [];
  const options = buildOptions(effect).map((option) => {
    if (option.op === "apply_effect") actions.push({ id: "proceed", label: "승인", outcome: "submit", tone: "primary", requiresSelection: true });
    if (option.op === "hold") actions.push({ id: "hold", label: "보류", outcome: "hold", tone: "neutral", requiresSelection: false });
    if (option.op === "reject") actions.push({ id: "reject", label: "거절", outcome: "reject", tone: "danger", requiresSelection: false });
    const label = option.optionId === "proceed" ? `고정 효과 승인 (${effect.kind})` : option.optionId === "hold" ? "보류 후 재확인" : "거절";
    return { id: option.optionId, label, description: null, facts: [], evidenceRefs: [] };
  });
  return operatorDecisionDefinitionSchema.parse({
    options, actions, selection: { min: 1, max: 1 },
    comment: { mode: "disabled", label: null, placeholder: null, maxLength: 0 },
    approvedScope: [], forbiddenScope: [],
  });
}

export async function assertPolicyTargets(tx: QualityTx, companyId: string, policy: QualityPolicy): Promise<void> {
  for (const target of policy.targets) {
    if (target.companyId !== companyId) throw conflict("quality_policy_company_mismatch");
    const [template] = await tx.select().from(missionPlanTemplates).where(and(
      eq(missionPlanTemplates.companyId, companyId), eq(missionPlanTemplates.id, target.templateId),
    )).for("share");
    // Same hash convention as mission-plan-template-selection, not a JSON hash of the row.
    if (!template?.enabled || createHash("sha256").update(template.instructions).digest("hex") !== target.baseHash) {
      throw conflict("quality_policy_target_unavailable");
    }
    for (const check of target.required) {
      if (check.applicability.op !== "selected_templates_all") continue;
      for (const id of check.applicability.templateIds) {
        if (!policy.targets.some((entry) => entry.templateId === id)) throw conflict("quality_policy_target_unavailable");
      }
    }
  }
}
