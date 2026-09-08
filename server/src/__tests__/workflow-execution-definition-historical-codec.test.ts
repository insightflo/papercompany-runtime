import { describe, expect, it } from "vitest";
import {
  buildExecutionDefinitionPayload,
  hashExecutionDefinitionPayload,
  reviewedHistoricalProvenanceSchema,
  runCreationProvenanceSchema,
  validateExecutionDefinitionPayload,
  validateExecutionDefinitionProvenance,
  ExecutionDefinitionValidationError,
} from "../services/workflow/execution-definition-codec.js";

/**
 * [목적] provenance strict union 슬라이스의 순수 계약 검증(DB 없음).
 *   - run_creation provenance 의 해시가 슬라이스 전후로 바이트 등가임을 known fixture 로 고정.
 *   - reviewed_historical_import provenance: 유효 구조 수용, unknown key/review 누락/형식 위반 거부.
 *   - 두 origin 을 교차 오염시키는 입력(run_creation+review, historical+미상 키) 전부 거부.
 */

const WF_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const COMPANY_ID = "33333333-3333-4333-8333-333333333333";
const MISSION_ID = "44444444-4444-4444-8444-444444444444";
const STEPS_HASH = "a".repeat(64);

/** 슬라이스 이전 코드로 계산해 고정한 known hash — 회귀 시 즉시 적발된다. */
const RUN_CREATION_KNOWN_HASH = "e89f6b12bc97cb59f78375565c4e85a650640b468ac5ba882e7cf66f5437ec76";

const CREATION_PROVENANCE = {
  schemaVersion: 1,
  origin: "run_creation",
  workflowId: WF_ID,
  missionId: null,
  workflowName: "execdef-workflow",
  source: "native",
  sourceKind: "workflow",
  definitionUpdatedAt: "2025-09-07T00:00:00.000Z",
} as const;

function historicalProvenance(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    origin: "reviewed_historical_import",
    workflowId: WF_ID,
    missionId: MISSION_ID,
    workflowName: "shorts-pipeline",
    source: "native",
    sourceKind: "workflow",
    definitionUpdatedAt: "2026-09-05T16:29:42.067Z",
    review: {
      schemaVersion: 1,
      sourceStepsHash: STEPS_HASH,
      sourceRecord: "session:test.jsonl tool-lines:25544-25549",
      reviewedBy: "operator-a",
      reviewedAt: "2026-09-10T09:00:00.000Z",
    },
    ...overrides,
  };
}

function buildPayload(provenance: unknown, overrides: Record<string, unknown> = {}) {
  return buildExecutionDefinitionPayload({
    companyId: COMPANY_ID,
    workflowRunId: RUN_ID,
    executionMode: "static_dag",
    steps: [
      { id: "step-1", name: "Step 1", agentId: "", dependencies: [], graphWorkProductRequired: false },
      {
        id: "step-2",
        name: "Step 2",
        agentId: "agent-1",
        dependencies: ["step-1"],
        graphWorkProductRequired: true,
        dependsOn: "step-1",
        toolArgs: { query: "ai", options: { depth: 2 } },
      },
    ],
    provenance: provenance as never,
    ...overrides,
  });
}

describe("run_creation provenance byte-for-byte preservation", () => {
  it("keeps the known pre-union payload hash identical", () => {
    const hash = hashExecutionDefinitionPayload(buildPayload(CREATION_PROVENANCE));
    expect(hash).toBe(RUN_CREATION_KNOWN_HASH);
  });

  it("validates run_creation provenance exactly as before and rejects new keys on it", () => {
    expect(runCreationProvenanceSchema.safeParse(CREATION_PROVENANCE).success).toBe(true);
    expect(() => validateExecutionDefinitionPayload(buildPayload({
      ...CREATION_PROVENANCE,
      review: { schemaVersion: 1 },
    }))).toThrow(ExecutionDefinitionValidationError);
    expect(() => validateExecutionDefinitionPayload(buildPayload({
      ...CREATION_PROVENANCE,
      origin: "reviewed_historical_import",
    }))).toThrow(ExecutionDefinitionValidationError);
  });
});

describe("reviewed_historical_import provenance acceptance", () => {
  it("accepts a fully valid historical provenance and payload, returning data unmutated", () => {
    const provenance = historicalProvenance();
    expect(reviewedHistoricalProvenanceSchema.safeParse(provenance).success).toBe(true);
    const validated = validateExecutionDefinitionProvenance(provenance);
    expect(validated).toBe(provenance);
    const payload = validateExecutionDefinitionPayload(buildPayload(provenance));
    expect(payload.provenance).toBe(provenance);
    expect(payload.provenance.origin).toBe("reviewed_historical_import");
  });

  it("hashes the same historical payload identically regardless of key order", () => {
    const left = buildPayload(historicalProvenance());
    const right = buildPayload({
      review: {
        reviewedAt: "2026-09-10T09:00:00.000Z",
        reviewedBy: "operator-a",
        sourceRecord: "session:test.jsonl tool-lines:25544-25549",
        sourceStepsHash: STEPS_HASH,
        schemaVersion: 1,
      },
      definitionUpdatedAt: "2026-09-05T16:29:42.067Z",
      sourceKind: "workflow",
      source: "native",
      workflowName: "shorts-pipeline",
      missionId: MISSION_ID,
      workflowId: WF_ID,
      origin: "reviewed_historical_import",
      schemaVersion: 1,
    });
    expect(hashExecutionDefinitionPayload(left)).toBe(hashExecutionDefinitionPayload(right));
  });
});

describe("reviewed_historical_import provenance rejections", () => {
  const rejections: Array<[string, Record<string, unknown>]> = [
    ["missing review", { review: undefined }],
    ["review not an object", { review: "nope" }],
    ["unknown top-level key", { importedBy: "someone" }],
    ["unknown review key", { review: { ...(historicalProvenance().review as object), reason: "x" } }],
    ["review schemaVersion 2", { review: { ...(historicalProvenance().review as object), schemaVersion: 2 } }],
    ["uppercase sourceStepsHash", { review: { ...(historicalProvenance().review as object), sourceStepsHash: "A".repeat(64) } }],
    ["short sourceStepsHash", { review: { ...(historicalProvenance().review as object), sourceStepsHash: "a".repeat(63) } }],
    ["non-hex sourceStepsHash", { review: { ...(historicalProvenance().review as object), sourceStepsHash: `${"g".repeat(63)}0` } }],
    ["empty sourceRecord", { review: { ...(historicalProvenance().review as object), sourceRecord: "" } }],
    ["oversized sourceRecord", { review: { ...(historicalProvenance().review as object), sourceRecord: "x".repeat(1001) } }],
    ["empty reviewedBy", { review: { ...(historicalProvenance().review as object), reviewedBy: "" } }],
    ["oversized reviewedBy", { review: { ...(historicalProvenance().review as object), reviewedBy: "x".repeat(201) } }],
    ["bad reviewedAt", { review: { ...(historicalProvenance().review as object), reviewedAt: "2026-09-10" } }],
    ["wrong origin", { origin: "run_creation" }],
    ["bad workflowId", { workflowId: "nope" }],
    ["bad definitionUpdatedAt", { definitionUpdatedAt: "yesterday" }],
  ];
  for (const [label, override] of rejections) {
    it(`rejects ${label}`, () => {
      const value = historicalProvenance(override);
      expect(reviewedHistoricalProvenanceSchema.safeParse(value).success).toBe(false);
      expect(() => validateExecutionDefinitionProvenance(value)).toThrow(ExecutionDefinitionValidationError);
      expect(() => validateExecutionDefinitionPayload(buildPayload(value))).toThrow(ExecutionDefinitionValidationError);
    });
  }

  it("still rejects unknown legacy provenance origins through the union", () => {
    expect(() => validateExecutionDefinitionProvenance({
      ...CREATION_PROVENANCE,
      origin: "backfill",
    })).toThrow(ExecutionDefinitionValidationError);
  });

  it("accepts offset-form reviewedAt like definitionUpdatedAt", () => {
    const value = historicalProvenance({
      review: { ...(historicalProvenance().review as object), reviewedAt: "2026-09-10T18:00:00+09:00" },
    });
    expect(validateExecutionDefinitionProvenance(value)).toBe(value);
  });
});
