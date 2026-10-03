import { z } from "zod";

export const missionRevisionSourceSchema = z.object({
  sourceMissionId: z.string().uuid().nullable().optional(),
  sourceWorkflowRunId: z.string().uuid().nullable().optional(),
}).refine(value => !value.sourceWorkflowRunId || Boolean(value.sourceMissionId), {
  message: "sourceWorkflowRunId requires sourceMissionId", path: ["sourceMissionId"],
});

/** Structured plan-unit identity. Labels/descriptions are never source identity. */
export const missionRevisionUnitSchema = z.object({
  sourceStepId: z.string().min(1).max(200).optional(),
}).passthrough();
export type MissionRevisionUnit = z.infer<typeof missionRevisionUnitSchema>;

/**
 * [mission-revision-delta.v1] 버전 있는 수정 변경안 계약(변경지도 R1/R2, 슬라이스1).
 * 실행 권한은 이 구조화된 변경안뿐이며 문구·주석 파싱에서 실행 권위를 만들지 않는다(규칙 8).
 * 모순(reuse+변경), 별칭 모호성, 필수 입력 소비, 기능 충족, 기준 스냅샷 드리프트 등
 * 서버 도메인 검증은 services/missions/revision-plan-delta.ts 가 담당한다.
 */
export const MISSION_REVISION_DELTA_SCHEMA_VERSION = "mission-revision-delta.v1";

const deltaIdSchema = z.string().min(1).max(200);

export const missionRevisionDeltaOperationSchema = z.enum(["reuse", "rerun", "modify", "add", "clone", "blocked"]);

export const missionRevisionDeltaUnitSchema = z.object({
  unitId: deltaIdSchema,
  operation: missionRevisionDeltaOperationSchema,
  /** clone 의 재료 단계(현재 템플릿 좌표). 원본 매핑·재사용 승인이 아니다. */
  templateStepId: deltaIdSchema.optional(),
  /** 원본 실행 단계와의 서신 관계. 재사용/영수증 승인이 아니다. */
  sourceStepId: deltaIdSchema.optional(),
  instructions: z.string().min(1).optional(),
  interpretedInputs: z.record(z.unknown()).optional(),
  /** 이 단위가 반드시 소비해야 하는 다른 단위 산출물 연결. */
  requiredInputs: z.array(z.object({
    fromUnitId: deltaIdSchema,
    selector: z.record(z.unknown()),
  })).min(1).optional(),
});

export const missionRevisionDeltaCapabilityRequirementSchema = z.object({
  unitId: deltaIdSchema,
  requiredOutcomeId: deltaIdSchema,
  toolName: deltaIdSchema,
  capability: deltaIdSchema,
});

export const missionRevisionDeltaSchema = z.object({
  schemaVersion: z.literal(MISSION_REVISION_DELTA_SCHEMA_VERSION),
  /** 원본 실행(결과의 출처). 미션의 source 실행과 같아야 한다. */
  sourceWorkflowRunId: z.string().uuid(),
  /** 명시적으로 선택한 현재 템플릿 근거(같은 회사 정의 + 스냅샷 해시). */
  base: z.object({
    workflowDefinitionId: z.string().uuid(),
    snapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  units: z.array(missionRevisionDeltaUnitSchema).min(1),
  /** 요청 결과에 필요한 도구 기능. 등록만으로 충족되지 않는다. */
  capabilityRequirements: z.array(missionRevisionDeltaCapabilityRequirementSchema).min(1).optional(),
}).strict();
export type MissionRevisionDelta = z.infer<typeof missionRevisionDeltaSchema>;
