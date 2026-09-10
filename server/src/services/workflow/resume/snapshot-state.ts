import { z } from "zod";

/**
 * [파일 목적] Task5c1 signed snapshot 의 순수 상태 스키마 경계 — SnapshotState 의 strict
 *   Zod 스키마와 inferred 타입만 정의한다. 판독/조립은 FUTURE read-model 이 담당한다.
 * [불변식]
 *   - passthrough/coercion/default/transform 없음. 미지/과잉 키와 중복은 거부(dedup 없음).
 *   - 정수는 전부 nonnegative safe integer. UUID는 z.string().uuid, 해시는 64 lowercase hex.
 *   - 날짜는 canonical UTC ISO 문자열(new Date(v).toISOString() === v, invalid date 거부).
 *   - 값은 무손실 직렬화 가능(JSON-safe). 배열은 호출자 순서 보존, 최대 10000.
 *   - 이 모듈은 token 무결성만 인증하며 eligibility/provenance 를 판정하지 않는다.
 *     (예: approval.bindingHash null 허용 — signer 는 적격성 평가자가 아님.)
 */

export const snapshotHashSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const snapshotUuidSchema = z.string().uuid();
export const snapshotStepIdSchema = z.string().min(1).max(200);
export const snapshotStatusSchema = z.string().min(1).max(100);
export const snapshotNonNegSafeIntSchema = z.number().int().nonnegative().safe();

export const snapshotDateSchema = z.string().refine((value) => {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
});

export const snapshotScopeSchema = z
  .object({
    companyId: snapshotUuidSchema,
    missionId: snapshotUuidSchema,
    workflowRunId: snapshotUuidSchema,
    startStepId: snapshotStepIdSchema,
  })
  .strict();

export const snapshotMissionSchema = z
  .object({
    status: snapshotStatusSchema,
    updatedAt: snapshotDateSchema,
  })
  .strict();

export const snapshotRunSchema = z
  .object({
    status: snapshotStatusSchema,
    dispatchAuthorityVersion: snapshotNonNegSafeIntSchema,
    startedAt: snapshotDateSchema.nullable(),
    completedAt: snapshotDateSchema.nullable(),
  })
  .strict();

export const snapshotStepStateSchema = z
  .object({
    id: snapshotUuidSchema,
    stepId: snapshotStepIdSchema,
    status: snapshotStatusSchema,
    executionGeneration: snapshotNonNegSafeIntSchema,
    statusTransitionVersion: snapshotNonNegSafeIntSchema,
    dispatchOwnerWakeupRequestId: snapshotUuidSchema.nullable(),
    dispatchOwnerHeartbeatRunId: snapshotUuidSchema.nullable(),
    lastDispatchRequestId: z.string().min(1).max(500).nullable(),
  })
  .strict();

export const snapshotStepsSchema = z
  .array(snapshotStepStateSchema)
  .min(1)
  .max(10000)
  .superRefine((steps, ctx) => {
    const stepIds = new Set<string>();
    const ids = new Set<string>();
    for (const step of steps) {
      if (stepIds.has(step.stepId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate stepId" });
      }
      if (ids.has(step.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate id" });
      }
      stepIds.add(step.stepId);
      ids.add(step.id);
    }
  });

export const snapshotEvidenceSchema = z
  .object({ id: snapshotUuidSchema, sha256: snapshotHashSchema })
  .strict();
export const snapshotEvidenceListSchema = z
  .array(snapshotEvidenceSchema)
  .max(10000)
  .superRefine((evidence, ctx) => {
    const ids = new Set<string>();
    for (const item of evidence) {
      if (ids.has(item.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate evidence id" });
      }
      ids.add(item.id);
    }
  });

export const snapshotApprovalSchema = z
  .object({
    stepId: snapshotStepIdSchema,
    executionGeneration: snapshotNonNegSafeIntSchema,
    bindingHash: snapshotHashSchema.nullable(),
  })
  .strict();
export const snapshotApprovalsSchema = z
  .array(snapshotApprovalSchema)
  .max(10000)
  .superRefine((approvals, ctx) => {
    const stepIds = new Set<string>();
    for (const approval of approvals) {
      if (stepIds.has(approval.stepId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate approval stepId" });
      }
      stepIds.add(approval.stepId);
    }
  });

export const snapshotStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    scope: snapshotScopeSchema,
    definitionHash: snapshotHashSchema,
    mission: snapshotMissionSchema,
    run: snapshotRunSchema,
    steps: snapshotStepsSchema,
    evidence: snapshotEvidenceListSchema,
    approvals: snapshotApprovalsSchema,
    resumeEpoch: snapshotNonNegSafeIntSchema,
    factsHash: snapshotHashSchema,
  })
  .strict()
  .superRefine((state, ctx) => {
    if (!state.steps.some((step) => step.stepId === state.scope.startStepId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "startStepId not in steps" });
    }
    const stepIds = new Set(state.steps.map((step) => step.stepId));
    for (const approval of state.approvals) {
      if (!stepIds.has(approval.stepId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "approval stepId not in steps" });
      }
    }
  });

export type SnapshotState = z.infer<typeof snapshotStateSchema>;
