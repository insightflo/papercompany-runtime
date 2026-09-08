import { describe, expect, it } from "vitest";
import {
  EXECUTION_DEFINITION_NORMALIZER_VERSION,
  EXECUTION_DEFINITION_SCHEMA_VERSION,
  buildExecutionDefinitionPayload,
  hashExecutionDefinitionPayload,
  validateExecutionDefinitionPayload,
  validateExecutionDefinitionProvenance,
  ExecutionDefinitionValidationError,
} from "../services/workflow/execution-definition-codec.js";

/**
 * [목적] Task5a1 실행정의 codec 계약 검증 (순수 단위 — DB 없음).
 *   canonical payload 정확한 키 구성, machine-produced core 검증, 원본 데이터 무변형 반환,
 *   JSON key-order 불변 해시 안정성을 고정한다.
 */

const WF_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const COMPANY_ID = "33333333-3333-4333-8333-333333333333";
const MISSION_ID = "44444444-4444-4444-8444-444444444444";

const PROVENANCE = {
  schemaVersion: 1,
  origin: "run_creation",
  workflowId: WF_ID,
  missionId: null,
  workflowName: "execdef-workflow",
  source: "native",
  sourceKind: "workflow",
  definitionUpdatedAt: "2025-09-07T00:00:00.000Z",
} as const;

function validStep(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "step-1",
    name: "Step 1",
    agentId: "",
    dependencies: [],
    graphWorkProductRequired: false,
    ...overrides,
  };
}

function buildValidPayload(overrides: Record<string, unknown> = {}) {
  return buildExecutionDefinitionPayload({
    companyId: COMPANY_ID,
    workflowRunId: RUN_ID,
    executionMode: "static_dag",
    steps: [validStep()],
    provenance: { ...PROVENANCE },
    ...overrides,
  });
}

describe("buildExecutionDefinitionPayload", () => {
  it("produces exactly the canonical keys in canonical order", () => {
    const payload = buildValidPayload() as unknown as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual([
      "schemaVersion",
      "normalizerVersion",
      "companyId",
      "workflowRunId",
      "executionMode",
      "steps",
      "provenance",
    ]);
    expect(payload.schemaVersion).toBe(EXECUTION_DEFINITION_SCHEMA_VERSION);
    expect(payload.normalizerVersion).toBe(EXECUTION_DEFINITION_NORMALIZER_VERSION);
    expect(EXECUTION_DEFINITION_SCHEMA_VERSION).toBe(1);
    expect(EXECUTION_DEFINITION_NORMALIZER_VERSION).toBe(1);
  });
});

describe("validateExecutionDefinitionPayload", () => {
  it("accepts the machine payload and returns the original data without mutation/reorder", () => {
    const payload = buildValidPayload();
    const serialized = JSON.stringify(payload);
    const validated = validateExecutionDefinitionPayload(payload);

    expect(validated).toBe(payload);
    expect(JSON.stringify(validated)).toBe(serialized);
    expect(validateExecutionDefinitionPayload(JSON.parse(serialized))).toEqual(payload);
  });

  it("keeps unknown step fields (toolArgs/conditionGroup/contract/raw aliases) untouched", () => {
    const step = validStep({
      agentId: "agent-1",
      dependsOn: "prev",
      toolArgs: { query: "ai", options: { depth: 2 } },
      conditionGroup: { kind: "if", expression: "a == b" },
      contract: { deliverable: "hub" },
      executionControls: { concurrencyLimit: 0 },
    });
    const validated = validateExecutionDefinitionPayload(buildValidPayload({ steps: [step] }));

    expect(validated.steps[0]).toBe(step);
    expect(Reflect.get(validated.steps[0] as object, "dependsOn")).toBe("prev");
    expect(Reflect.get(validated.steps[0] as object, "toolArgs")).toEqual({ query: "ai", options: { depth: 2 } });
    expect(Reflect.get(validated.steps[0] as object, "conditionGroup")).toEqual({ kind: "if", expression: "a == b" });
    expect(Reflect.get(validated.steps[0] as object, "executionControls")).toEqual({ concurrencyLimit: 0 });
  });

  it("allows empty agentId (normalizer default) and literal-true autoApproveTools", () => {
    const validated = validateExecutionDefinitionPayload(buildValidPayload({
      steps: [validStep({ autoApproveTools: true })],
    }));
    expect(Reflect.get(validated.steps[0] as object, "autoApproveTools")).toBe(true);
  });

  it("rejects unsupported payload versions, bad ids, bad mode, unknown keys", () => {
    expect(() => validateExecutionDefinitionPayload({ ...buildValidPayload(), schemaVersion: 2 }))
      .toThrow(ExecutionDefinitionValidationError);
    expect(() => validateExecutionDefinitionPayload({ ...buildValidPayload(), normalizerVersion: 2 }))
      .toThrow(ExecutionDefinitionValidationError);
    expect(() => validateExecutionDefinitionPayload({ ...buildValidPayload(), companyId: "not-a-uuid" }))
      .toThrow(ExecutionDefinitionValidationError);
    expect(() => validateExecutionDefinitionPayload({ ...buildValidPayload(), workflowRunId: "not-a-uuid" }))
      .toThrow(ExecutionDefinitionValidationError);
    expect(() => validateExecutionDefinitionPayload({ ...buildValidPayload(), executionMode: "other" }))
      .toThrow(ExecutionDefinitionValidationError);
    expect(() => validateExecutionDefinitionPayload({ ...buildValidPayload(), extraKey: 1 }))
      .toThrow(ExecutionDefinitionValidationError);
    expect(() => validateExecutionDefinitionPayload({ ...buildValidPayload(), steps: { nope: true } }))
      .toThrow(ExecutionDefinitionValidationError);
  });

  it("rejects steps failing the machine core contract", () => {
    const cases = [
      validStep({ id: "" }),
      validStep({ id: 7 }),
      { name: "no id", agentId: "", dependencies: [], graphWorkProductRequired: false },
      validStep({ agentId: 5 }),
      validStep({ dependencies: "prev" }),
      validStep({ dependencies: [3] }),
      validStep({ graphWorkProductRequired: "true" }),
      validStep({ autoApproveTools: "true" }),
      validStep({ autoApproveTools: 1 }),
      validStep({ conditionalDependencies: "qa-1" }),
    ];
    for (const step of cases) {
      expect(() => validateExecutionDefinitionPayload(buildValidPayload({ steps: [step] })))
        .toThrow(ExecutionDefinitionValidationError);
    }
  });

  it("validates conditional edges: known when, strict keys, back-edge caps, cap-acceptance only on back-edge", () => {
    const whenValues = ["success", "failure", "qa_request_changes", "always", "condition_true", "condition_false"];
    for (const when of whenValues) {
      const edges = [{ stepId: "qa-1", when }];
      expect(() => validateExecutionDefinitionPayload(buildValidPayload({
        steps: [validStep({ conditionalDependencies: edges })],
      }))).not.toThrow();
    }
    const rejections = [
      [{ stepId: "" }],
      [{ when: "failure" }],
      [{ stepId: "qa-1", when: "other" }],
      [{ stepId: "qa-1", isBackEdge: true }],
      [{ stepId: "qa-1", isBackEdge: "true", maxIterations: 2 }],
      [{ stepId: "qa-1", isBackEdge: true, maxIterations: 0 }],
      [{ stepId: "qa-1", isBackEdge: true, maxIterations: -1 }],
      [{ stepId: "qa-1", isBackEdge: true, maxIterations: 1.5 }],
      [{ stepId: "qa-1", allowCapAcceptance: true }],
      [{ stepId: "qa-1", when: "success", unexpectedKey: 1 }],
    ];
    for (const edges of rejections) {
      expect(() => validateExecutionDefinitionPayload(buildValidPayload({
        steps: [validStep({ conditionalDependencies: edges })],
      }))).toThrow(ExecutionDefinitionValidationError);
    }
    const backEdge = [{ stepId: "qa-1", when: "qa_request_changes", isBackEdge: true, maxIterations: 3, allowCapAcceptance: true }];
    expect(() => validateExecutionDefinitionPayload(buildValidPayload({
      steps: [validStep({ conditionalDependencies: backEdge })],
    }))).not.toThrow();
  });

  it("rejects malformed provenance", () => {
    const cases = [
      { ...PROVENANCE, origin: "backfill" },
      { ...PROVENANCE, missionId: "not-a-uuid" },
      { ...PROVENANCE, missionId: 5 },
      { ...PROVENANCE, extraKey: true },
      { ...PROVENANCE, workflowName: 7 },
      { ...PROVENANCE, source: 3 },
      { ...PROVENANCE, definitionUpdatedAt: null },
      { ...PROVENANCE, workflowId: "nope" },
    ];
    for (const provenance of cases) {
      expect(() => validateExecutionDefinitionPayload(buildValidPayload({ provenance })))
        .toThrow(ExecutionDefinitionValidationError);
    }
    const mission = { ...PROVENANCE, missionId: MISSION_ID };
    expect(() => validateExecutionDefinitionPayload(buildValidPayload({ provenance: mission }))).not.toThrow();
    expect(validateExecutionDefinitionProvenance(mission)).toBe(mission);
    expect(() => validateExecutionDefinitionProvenance({ ...PROVENANCE, schemaVersion: 2 }))
      .toThrow(ExecutionDefinitionValidationError);
  });

  it("rejects garbage/empty/date-only/malformed definitionUpdatedAt and accepts ISO with Z or offset", () => {
    const bad = ["", "not-a-timestamp", "2025-09-07", "2025-09-07 00:00:00Z", "2025-09-07T00:00"];
    for (const definitionUpdatedAt of bad) {
      const provenance = { ...PROVENANCE, definitionUpdatedAt };
      expect(() => validateExecutionDefinitionPayload(buildValidPayload({ provenance })))
        .toThrow(ExecutionDefinitionValidationError);
      expect(() => validateExecutionDefinitionProvenance(provenance))
        .toThrow(ExecutionDefinitionValidationError);
    }
    for (const definitionUpdatedAt of [
      "2025-09-07T00:00:00Z",
      new Date().toISOString(),
      "2025-09-07T09:00:00+09:00",
      "2025-09-07T00:00:00.123-05:00",
    ]) {
      const provenance = { ...PROVENANCE, definitionUpdatedAt };
      expect(validateExecutionDefinitionPayload(buildValidPayload({ provenance })).provenance.definitionUpdatedAt)
        .toBe(definitionUpdatedAt);
      expect(validateExecutionDefinitionProvenance(provenance)).toBe(provenance);
    }
  });
});

describe("hashExecutionDefinitionPayload", () => {
  it("is stable under JSON object key-order changes (including nested)", () => {
    const left = buildValidPayload({
      steps: [validStep({ toolArgs: { alpha: 1, beta: { y: 2, x: 1 } } })],
    });
    const right = buildValidPayload({
      steps: [validStep({ toolArgs: { beta: { x: 1, y: 2 }, alpha: 1 } })],
    });
    expect(hashExecutionDefinitionPayload(left)).toBe(hashExecutionDefinitionPayload(right));
  });

  it("changes when nested toolArgs, conditional edges, mode, or scope change", () => {
    const base = buildValidPayload({ steps: [validStep({ toolArgs: { q: "a" } })] });
    const baseHash = hashExecutionDefinitionPayload(base);

    const changedArgs = buildValidPayload({ steps: [validStep({ toolArgs: { q: "b" } })] });
    const changedEdge = buildValidPayload({
      steps: [validStep({ conditionalDependencies: [{ stepId: "qa-1", when: "failure" }] })],
    });
    const changedMode = buildValidPayload({ executionMode: "dynamic_owner_plan" });
    const changedCompany = buildValidPayload({ companyId: "55555555-5555-4555-8555-555555555555" });
    const changedRun = buildValidPayload({ workflowRunId: "66666666-6666-4666-8666-666666666666" });
    const changedName = buildValidPayload({
      provenance: { ...PROVENANCE, workflowName: "renamed" },
    });
    const changedMission = buildValidPayload({
      provenance: { ...PROVENANCE, missionId: MISSION_ID },
    });

    for (const variant of [changedArgs, changedEdge, changedMode, changedCompany, changedRun, changedName, changedMission]) {
      expect(hashExecutionDefinitionPayload(variant)).not.toBe(baseHash);
    }
  });
});
