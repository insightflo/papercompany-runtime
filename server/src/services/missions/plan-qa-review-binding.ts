// server/src/services/missions/plan-qa-review-binding.ts
//
// [파일 목적] T7 PLAN-QA 검토 binding. 검토 issue 생성·서버 표식(issues.qualityPlanQaBinding)·
//   명세 연결을 한 tx 에서 확정하고, 같은 세대 재사용은 저장 명세를 읽는다. plan 내용/실행 단위가
//   바뀌면(투영 hash 불일치) 새 reviewGeneration+명세로 이전 판정을 무효화한다(이전 issue supersede).
//   완료된 검토에는 binding 을 덧붙이지 않고, 진행 중 명세는 절대 바꾸지 않는다.
// [외부 연결] plan-qa-reviewer-assignment 가 ensurePlanQaReviewBinding 호출 후 wake 하고,
//   mission-owner-plan-decisions 가 조회 전에 readPlanQaReviewBinding 으로 고정 값을 읽는다.
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  activityLog, issues, missionPlanArtifacts, type Db,
} from "@paperclipai/db";
import { artifactRefSchema, uuidSchema, type ArtifactRef } from "@paperclipai/shared";
import { unprocessable } from "../../errors.js";
import { issueService } from "../issues.js";
import type { QualityTx } from "../quality/contract.js";
import { buildPlanQaReviewDescription } from "./mission-plan-review-description.js";
import {
  attachPlanQaManifest, blockedPlanQaTemplates, planQaInputHashForPlan, planQaOriginId,
  preparePlanQaManifest, readPlanQaManifestForIssue, type PlanQaManifest,
} from "./plan-qa-addendum-manifest.js";

const nonNegativeInteger = z.number().int().safe().min(0);
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "quality_invalid_sha256");

export const planQaReviewBindingMarkerSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("plan_qa_review_binding"),
  companyId: uuidSchema,
  missionId: uuidSchema,
  planArtifactId: uuidSchema,
  decisionHash: sha256Hex,
  reviewGeneration: nonNegativeInteger,
  manifestRef: artifactRefSchema,
  inputHash: sha256Hex,
  pinnedAt: z.string().datetime(),
  supersededAt: z.string().datetime().nullable(),
}).strict();
export type PlanQaReviewBindingMarker = z.infer<typeof planQaReviewBindingMarkerSchema>;

export type PlanQaBindingContext = {
  db: Db;
  companyId: string;
  missionId: string;
  planArtifactId: string;
  decisionHash: string;
  missionTitle: string;
  missionDescription: string | null;
  missionGoal?: string | null;
  planningIssueId: string | null;
  reviewerUnavailableHint?: boolean;
  /** 의사결정 자체가 mission_plan_qa 이슈에서 온 경우: 그 이슈를 검토 이슈로 재사용한다. */
  existingIssueId?: string | null;
};

export type PlanQaBindingState = {
  kind: "bound";
  issueId: string;
  reviewGeneration: number;
  manifestRef: ArtifactRef;
  manifest: PlanQaManifest;
  blockedTemplateIds: string[];
  created: boolean;
  supersededIssueId: string | null;
};

const bindingError = (code: string): never => { throw unprocessable(code, { code }); };

function pinnedSelectedTemplates(manifest: PlanQaManifest) {
  return manifest.templates
    .filter((template) => manifest.selectedTemplateIds.includes(template.templateId))
    .map((template) => ({ id: template.templateId, name: template.name, instructions: template.instructions }));
}

function newTypeDescription(input: PlanQaBindingContext, manifest: PlanQaManifest, generation: number): string {
  let description = buildPlanQaReviewDescription({
    missionTitle: input.missionTitle,
    missionDescription: input.missionDescription,
    missionGoal: input.missionGoal,
    selectedPlanTemplates: pinnedSelectedTemplates(manifest),
    reviewGeneration: generation,
  });
  const blocked = blockedPlanQaTemplates(manifest);
  if (blocked.length) {
    description += `\n\n## Review execution blocked\n- Required addendum target base changed (quality_plan_qa_base_changed_required). Templates: ${blocked.join(", ")}.\n- The plan gate stays on hold until a policy approved for the current template base is activated. Base template checks above remain informational.`;
  }
  if (input.reviewerUnavailableHint) {
    description += "\n\nQA reviewer assignment required (no runnable plan-selected QA or qa/reviewer/validator agent on this mission yet).";
  }
  return description;
}

async function findReviewIssue(db: Db, companyId: string, missionId: string, decisionHash: string, existingIssueId?: string | null) {
  const [issue] = await db.select({
    id: issues.id, status: issues.status, marker: issues.qualityPlanQaBinding,
  }).from(issues).where(and(
    eq(issues.companyId, companyId), eq(issues.originKind, "mission_plan_qa"),
    ...(existingIssueId
      ? [eq(issues.id, existingIssueId)]
      : [eq(issues.originId, planQaOriginId(missionId, decisionHash))]),
    isNull(issues.hiddenAt),
  )).limit(1);
  return issue ?? null;
}

/** refs.planQa 서버 전용 인덱스(세대·명세 참조)를 같은 tx 로 확정한다. guard 미통과(0행)는
 *  조용한 no-op 가 아니라 충돌로 제출한다(이중 생성/refs 무결성 분기 방어). */
async function writePlanQaRefIndex(tx: QualityTx, input: {
  companyId: string; planArtifactId: string; planQa: Record<string, unknown>; expectedIssueId: string | null;
}): Promise<void> {
  const guard = input.expectedIssueId === null
    ? sql`(${missionPlanArtifacts.refs} -> 'planQa' ->> 'issueId') is null`
    : sql`((${missionPlanArtifacts.refs} -> 'planQa' ->> 'issueId') is null or (${missionPlanArtifacts.refs} -> 'planQa' ->> 'issueId') = ${input.expectedIssueId})`;
  const updated = await tx.update(missionPlanArtifacts).set({
    refs: sql`jsonb_set(${missionPlanArtifacts.refs}, '{planQa}', ${JSON.stringify(input.planQa)}::jsonb, true)`,
    updatedAt: new Date(),
  }).where(and(
    eq(missionPlanArtifacts.companyId, input.companyId),
    eq(missionPlanArtifacts.id, input.planArtifactId),
    eq(missionPlanArtifacts.status, "active"),
    sql`${missionPlanArtifacts.refs} -> 'ownerPlanDecision' ->> 'decisionHash' = ${input.planQa.decisionHash}`,
    guard,
  )).returning({ id: missionPlanArtifacts.id });
  if (!updated.length) bindingError("quality_plan_qa_binding_conflict");
}

async function refsGeneration(db: Db, companyId: string, planArtifactId: string): Promise<number> {
  const [plan] = await db.select({ planQa: sql<string | null>`${missionPlanArtifacts.refs} -> 'planQa' ->> 'reviewGeneration'` })
    .from(missionPlanArtifacts)
    .where(and(eq(missionPlanArtifacts.companyId, companyId), eq(missionPlanArtifacts.id, planArtifactId)))
    .limit(1);
  const parsed = nonNegativeInteger.safeParse(plan?.planQa === null ? undefined : Number(plan?.planQa));
  return parsed.success ? parsed.data : 0;
}

/** 소비자(owner-plan)용 읽기 전용 조회: 현재 세대가 고정 입력과 아직 일치하는지 판정한다. */
export async function readPlanQaReviewBinding(db: Db, input: {
  companyId: string; missionId: string; issueId: string; decisionHash: string; planArtifactId: string;
}): Promise<{ status: "current" | "stale"; marker: PlanQaReviewBindingMarker; manifest: PlanQaManifest | null } | null> {
  const [row] = await db.select({ marker: issues.qualityPlanQaBinding }).from(issues)
    .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))).limit(1);
  if (!row?.marker) return null;
  const marker = planQaReviewBindingMarkerSchema.safeParse(row.marker);
  if (!marker.success) return null;
  const [plan] = await db.select().from(missionPlanArtifacts).where(and(
    eq(missionPlanArtifacts.companyId, input.companyId), eq(missionPlanArtifacts.missionId, input.missionId),
    eq(missionPlanArtifacts.id, input.planArtifactId),
  )).limit(1);
  if (!plan) bindingError("quality_plan_qa_plan_not_found");
  const fresh = planQaInputHashForPlan(plan, input.decisionHash);
  const stale = marker.data.supersededAt !== null
    || marker.data.decisionHash !== input.decisionHash
    || marker.data.planArtifactId !== input.planArtifactId
    || marker.data.inputHash !== fresh;
  if (stale) return { status: "stale", marker: marker.data, manifest: null };
  const manifest = await readPlanQaManifestForIssue(db, input.companyId, input.issueId, marker.data.manifestRef);
  return { status: "current", marker: marker.data, manifest };
}

/** 검토 실행 시작 지점의 binding 보증. 완료 이슈는 binding 하지 않는다. */
export async function ensurePlanQaReviewBinding(input: PlanQaBindingContext): Promise<PlanQaBindingState | { kind: "completed"; issueId: string }> {
  const existing = await findReviewIssue(input.db, input.companyId, input.missionId, input.decisionHash, input.existingIssueId);
  if (existing && (existing.status === "done" || existing.status === "cancelled")) {
    return { kind: "completed", issueId: existing.id };
  }
  const marker = existing ? planQaReviewBindingMarkerSchema.safeParse(existing.marker) : null;
  if (existing && marker?.success) {
    const state = await readPlanQaReviewBinding(input.db, {
      companyId: input.companyId, missionId: input.missionId, issueId: existing.id,
      decisionHash: input.decisionHash, planArtifactId: input.planArtifactId,
    });
    if (state?.status === "current") {
      return {
        kind: "bound", issueId: existing.id, reviewGeneration: state.marker.reviewGeneration,
        manifestRef: state.marker.manifestRef, manifest: state.manifest!, blockedTemplateIds: blockedPlanQaTemplates(state.manifest!),
        created: false, supersededIssueId: null,
      };
    }
    return supersedeReview(input, existing.id, marker.data.reviewGeneration + 1);
  }
  if (existing) return bindExistingReview(input, existing.id);
  return createBoundReview(input, (await refsGeneration(input.db, input.companyId, input.planArtifactId)) + 1);
}

async function createBoundReview(input: PlanQaBindingContext, generation: number): Promise<PlanQaBindingState> {
  const prepared = await preparePlanQaManifest(input.db, bindingInput(input, generation));
  const blocked = blockedPlanQaTemplates(prepared.manifest);
  return input.db.transaction(async (tx) => {
    const created = await issueService(input.db).createFromSrb(tx, input.companyId, {
      missionId: input.missionId,
      originKind: "mission_plan_qa",
      originId: planQaOriginId(input.missionId, input.decisionHash),
      title: `[PLAN-QA] ${input.missionTitle}`,
      description: newTypeDescription(input, prepared.manifest, generation),
      status: "todo",
      priority: "high",
    });
    const ref = await attachPlanQaManifest(tx, { companyId: input.companyId, issueId: created.id, uploaded: prepared.uploaded });
    const pinnedAt = new Date().toISOString();
    const marker: PlanQaReviewBindingMarker = {
      schemaVersion: 1, kind: "plan_qa_review_binding",
      companyId: input.companyId, missionId: input.missionId, planArtifactId: input.planArtifactId,
      decisionHash: input.decisionHash, reviewGeneration: generation, manifestRef: ref,
      inputHash: prepared.manifest.inputHash, pinnedAt, supersededAt: null,
    };
    await tx.update(issues).set({ qualityPlanQaBinding: marker })
      .where(and(eq(issues.companyId, input.companyId), eq(issues.id, created.id), isNull(issues.qualityPlanQaBinding)));
    await writePlanQaRefIndex(tx, {
      companyId: input.companyId, planArtifactId: input.planArtifactId, expectedIssueId: null,
      planQa: { issueId: created.id, status: "pending", decisionHash: input.decisionHash, reviewGeneration: generation, manifestRef: ref, inputHash: prepared.manifest.inputHash },
    });
    await logBinding(tx, input, created.id, "mission.plan_qa.binding_created", { reviewGeneration: generation, manifestRef: ref, planArtifactId: input.planArtifactId });
    if (blocked.length) await logBinding(tx, input, created.id, "mission.plan_qa.binding_blocked", { reviewGeneration: generation, templateIds: blocked });
    return { kind: "bound" as const, issueId: created.id, reviewGeneration: generation, manifestRef: ref, manifest: prepared.manifest, blockedTemplateIds: blocked, created: true, supersededIssueId: null };
  });
}

async function bindExistingReview(input: PlanQaBindingContext, issueId: string): Promise<PlanQaBindingState> {
  const generation = (await refsGeneration(input.db, input.companyId, input.planArtifactId)) + 1;
  const prepared = await preparePlanQaManifest(input.db, bindingInput(input, generation));
  const blocked = blockedPlanQaTemplates(prepared.manifest);
  return input.db.transaction(async (tx) => {
    const ref = await attachPlanQaManifest(tx, { companyId: input.companyId, issueId, uploaded: prepared.uploaded });
    const marker: PlanQaReviewBindingMarker = {
      schemaVersion: 1, kind: "plan_qa_review_binding",
      companyId: input.companyId, missionId: input.missionId, planArtifactId: input.planArtifactId,
      decisionHash: input.decisionHash, reviewGeneration: generation, manifestRef: ref,
      inputHash: prepared.manifest.inputHash, pinnedAt: new Date().toISOString(), supersededAt: null,
    };
    const updated = await tx.update(issues).set({ qualityPlanQaBinding: marker })
      .where(and(eq(issues.companyId, input.companyId), eq(issues.id, issueId), isNull(issues.qualityPlanQaBinding)))
      .returning({ id: issues.id });
    if (!updated.length) bindingError("quality_plan_qa_binding_exists");
    await writePlanQaRefIndex(tx, {
      companyId: input.companyId, planArtifactId: input.planArtifactId, expectedIssueId: issueId,
      planQa: { issueId, status: "pending", decisionHash: input.decisionHash, reviewGeneration: generation, manifestRef: ref, inputHash: prepared.manifest.inputHash },
    });
    await logBinding(tx, input, issueId, "mission.plan_qa.binding_created", { reviewGeneration: generation, manifestRef: ref, planArtifactId: input.planArtifactId });
    if (blocked.length) await logBinding(tx, input, issueId, "mission.plan_qa.binding_blocked", { reviewGeneration: generation, templateIds: blocked });
    return { kind: "bound" as const, issueId, reviewGeneration: generation, manifestRef: ref, manifest: prepared.manifest, blockedTemplateIds: blocked, created: false, supersededIssueId: null };
  });
}

async function supersedeReview(input: PlanQaBindingContext, previousIssueId: string, generation: number): Promise<PlanQaBindingState> {
  const prepared = await preparePlanQaManifest(input.db, bindingInput(input, generation));
  const blocked = blockedPlanQaTemplates(prepared.manifest);
  return input.db.transaction(async (tx) => {
    const supersededAt = new Date().toISOString();
    await tx.update(issues).set({
      status: "cancelled", hiddenAt: new Date(), updatedAt: new Date(),
      qualityPlanQaBinding: sql`jsonb_set(${issues.qualityPlanQaBinding}, '{supersededAt}', ${JSON.stringify(supersededAt)}::jsonb, true)`,
    }).where(and(eq(issues.companyId, input.companyId), eq(issues.id, previousIssueId)));
    await logBinding(tx, input, previousIssueId, "mission.plan_qa.binding_superseded", { reviewGeneration: generation, decisionHash: input.decisionHash });
    const created = await issueService(input.db).createFromSrb(tx, input.companyId, {
      missionId: input.missionId,
      originKind: "mission_plan_qa",
      originId: planQaOriginId(input.missionId, input.decisionHash),
      title: `[PLAN-QA] ${input.missionTitle}`,
      description: newTypeDescription(input, prepared.manifest, generation),
      status: "todo",
      priority: "high",
    });
    const ref = await attachPlanQaManifest(tx, { companyId: input.companyId, issueId: created.id, uploaded: prepared.uploaded });
    const marker: PlanQaReviewBindingMarker = {
      schemaVersion: 1, kind: "plan_qa_review_binding",
      companyId: input.companyId, missionId: input.missionId, planArtifactId: input.planArtifactId,
      decisionHash: input.decisionHash, reviewGeneration: generation, manifestRef: ref,
      inputHash: prepared.manifest.inputHash, pinnedAt: new Date().toISOString(), supersededAt: null,
    };
    await tx.update(issues).set({ qualityPlanQaBinding: marker })
      .where(and(eq(issues.companyId, input.companyId), eq(issues.id, created.id), isNull(issues.qualityPlanQaBinding)));
    await writePlanQaRefIndex(tx, {
      companyId: input.companyId, planArtifactId: input.planArtifactId, expectedIssueId: previousIssueId,
      planQa: { issueId: created.id, status: "pending", decisionHash: input.decisionHash, reviewGeneration: generation, manifestRef: ref, inputHash: prepared.manifest.inputHash },
    });
    await logBinding(tx, input, created.id, "mission.plan_qa.binding_created", { reviewGeneration: generation, manifestRef: ref, planArtifactId: input.planArtifactId });
    if (blocked.length) await logBinding(tx, input, created.id, "mission.plan_qa.binding_blocked", { reviewGeneration: generation, templateIds: blocked });
    return { kind: "bound" as const, issueId: created.id, reviewGeneration: generation, manifestRef: ref, manifest: prepared.manifest, blockedTemplateIds: blocked, created: true, supersededIssueId: previousIssueId };
  });
}

function bindingInput(input: PlanQaBindingContext, generation: number) {
  return {
    companyId: input.companyId, missionId: input.missionId, planArtifactId: input.planArtifactId,
    decisionHash: input.decisionHash, reviewGeneration: generation,
  };
}

async function logBinding(tx: QualityTx, input: PlanQaBindingContext, issueId: string, action: string, details: Record<string, unknown>) {
  await tx.insert(activityLog).values({
    companyId: input.companyId, actorType: "system", actorId: "mission-plan-qa",
    action, entityType: "issue", entityId: issueId,
    details: { schemaVersion: 1, missionId: input.missionId, planningIssueId: input.planningIssueId, decisionHash: input.decisionHash, ...details },
  });
}
