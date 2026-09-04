// [machine-check gates] PAQO materialization — contract.machineChecks 첨부와
// synthetic structural gate 스텝 삽입·의존 리와이어링을 검증한다.
import { describe, expect, it } from "vitest";
import { buildPaqoWorkflowSteps } from "../services/mission-owner-plan-decisions.js";
import { STEP_MACHINE_CHECKS_TOOL } from "../services/workflow/step-machine-checks.js";

const mission = {
  id: "11111111-1111-4111-8111-111111111111",
  companyId: "22222222-2222-4222-8222-222222222222",
  ownerAgentId: "33333333-3333-4333-8333-333333333333",
  title: "2026-07-24 machine-check mission",
} as never;

function makeDraft(units: Record<string, unknown>[], steps: Record<string, unknown>[]) {
  return {
    missionGoal: "machine check report",
    successCriteria: [],
    refs: { selectedExecutionUnits: units },
    steps,
  } as never;
}

describe("buildPaqoWorkflowSteps machine-check gate materialization", () => {
  it("appends a [GATE] structural step after a producer with machineChecks and attaches contract.machineChecks", () => {
    const draft = makeDraft(
      [
        {
          id: "unit-produce",
          title: "[ACTION] 리포트 생성",
          assigneeAgentId: "44444444-4444-4444-8444-444444444444",
          machineChecks: [
            { kind: "file_exists", path: "{$steps.unit-produce.workProductPath}" },
            { kind: "file_glob", dir: "{$steps.unit-produce.siblingAssetsDir}", glob: "*.png", minCount: 2 },
          ],
          sourceRef: { id: "unit-produce", type: "mission_plan_unit" },
        },
        {
          id: "unit-consume",
          title: "[ACTION] 후속 처리",
          dependencies: ["unit-produce"],
          assigneeAgentId: "44444444-4444-4444-8444-444444444444",
          sourceRef: { id: "unit-consume", type: "mission_plan_unit" },
        },
      ],
      [
        { unitId: "unit-produce", dependencies: [] },
        { unitId: "unit-consume", dependencies: ["unit-produce"] },
      ],
    );

    const steps = buildPaqoWorkflowSteps(draft, mission, {});

    const producer = steps.find((step) => step.name.includes("리포트 생성"))!;
    expect(producer.contract?.machineChecks).toHaveLength(2);
    expect(producer.contract?.machineChecks?.[0]).toMatchObject({ kind: "file_exists" });

    const producerIndex = steps.indexOf(producer);
    const gate = steps[producerIndex + 1]!;
    expect(gate.id).toBe(`${producer.id}-mc`);
    expect(gate.name).toBe(`[GATE] ${producer.name} machine checks`);
    expect(gate.type).toBe("tool");
    expect(gate.qaType).toBe("structural");
    expect(gate.agentId).toBe("");
    expect(gate.toolNames).toEqual([STEP_MACHINE_CHECKS_TOOL]);
    expect(gate.dependencies).toEqual([producer.id]);
    expect(gate.contract).toBeUndefined();
    expect(gate.toolArgs).toMatchObject({ producerStepId: producer.id });
    // unit-id 토큰이 스텝 id 토큰으로 재작성된다(기존 toolArgs 재작성 기계 재사용).
    const gateChecks = (gate.toolArgs as { machineChecks: Array<Record<string, unknown>> }).machineChecks;
    expect(gateChecks[0]!.path).toBe(`{$steps.${producer.id}.workProductPath}`);
    expect(gateChecks[1]!.dir).toBe(`{$steps.${producer.id}.siblingAssetsDir}`);
    expect(gateChecks[1]!).toMatchObject({ glob: "*.png", minCount: 2 });

    // 가산 리와이어링: 생산자 직계 의존자는 생산자를 유지하고 gate 도 기다린다.
    const consumer = steps.find((step) => step.name.includes("후속 처리"))!;
    expect(consumer.dependencies).toContain(producer.id);
    expect(consumer.dependencies).toContain(gate.id);
  });

  it("keeps a machineChecks-only contract (no text sections) on the producer", () => {
    const draft = makeDraft(
      [
        {
          id: "unit-mc-only",
          title: "[ACTION] 산출물 생산",
          machineChecks: [{ kind: "min_size_bytes", path: "out.html", minBytes: 0 }],
          sourceRef: { id: "unit-mc-only", type: "mission_plan_unit" },
        },
      ],
      [{ unitId: "unit-mc-only", dependencies: [] }],
    );
    const steps = buildPaqoWorkflowSteps(draft, mission, {});
    const producer = steps.find((step) => step.name.includes("산출물 생산"))!;
    expect(producer.contract).toBeDefined();
    expect(producer.contract?.machineChecks).toHaveLength(1);
    expect(producer.contract?.preconditions).toBeUndefined();
  });

  it("materializes no gate for units without machineChecks", () => {
    const draft = makeDraft(
      [
        {
          id: "unit-plain",
          title: "[ACTION] 단순 작업",
          assigneeAgentId: "44444444-4444-4444-8444-444444444444",
          sourceRef: { id: "unit-plain", type: "mission_plan_unit" },
        },
      ],
      [{ unitId: "unit-plain", dependencies: [] }],
    );
    const steps = buildPaqoWorkflowSteps(draft, mission, {});
    expect(steps.filter((step) => step.id.endsWith("-mc"))).toHaveLength(0);
    expect(steps.filter((step) => step.toolNames?.includes(STEP_MACHINE_CHECKS_TOOL))).toHaveLength(0);
  });

  it("rewires QA-like dependents additively and keeps structural topology valid", () => {
    const draft = makeDraft(
      [
        {
          id: "unit-produce",
          title: "[ACTION] 리포트 생성",
          machineChecks: [{ kind: "content_sha256", path: "out.html", sha256: "a".repeat(64) }],
          sourceRef: { id: "unit-produce", type: "mission_plan_unit" },
        },
        {
          id: "unit-qa",
          title: "[QA] 결과 검수",
          dependencies: ["unit-produce"],
          assigneeAgentId: "44444444-4444-4444-8444-444444444444",
          sourceRef: { id: "unit-qa", type: "mission_plan_unit" },
        },
      ],
      [
        { unitId: "unit-produce", dependencies: [] },
        { unitId: "unit-qa", dependencies: ["unit-produce"] },
      ],
    );

    // validateStructuralTopology 이 buildPaqoWorkflowSteps 내부에서 실행된다 —
    // 토폴로지 위반 시 이 호출이 throw 하므로, 성공 자체가 위계 검증이다.
    const steps = buildPaqoWorkflowSteps(draft, mission, {});
    const producer = steps.find((step) => step.name.includes("리포트 생성"))!;
    const gate = steps.find((step) => step.id === `${producer.id}-mc`)!;
    expect(gate).toBeDefined();

    const qaLike = steps.find((step) => step.name.includes("결과 검수"))!;
    expect(qaLike.dependencies).toContain(producer.id);
    expect(qaLike.dependencies).toContain(gate.id);

    // 최종 QA 스텝도 생산자와 gate 양쪽 모두에 의존한다.
    const finalQa = steps.find((step) => step.name === "[QA] Verify mission result")!;
    expect(finalQa.dependencies).toContain(producer.id);
    expect(finalQa.dependencies).toContain(gate.id);
  });

  it("coexists with declared structural gate units", () => {
    const draft = makeDraft(
      [
        {
          id: "unit-produce",
          title: "[ACTION] 리포트 생성",
          machineChecks: [{ kind: "file_exists", path: "out.html" }],
          sourceRef: { id: "unit-produce", type: "mission_plan_unit" },
        },
        {
          id: "unit-declared-gate",
          title: "[QA] 기계 검증",
          type: "tool",
          qaType: "structural",
          toolNames: ["validate-report-html"],
          toolArgs: { dir: "{$steps.unit-produce.workProductDir}", glob: "*.html" },
          sourceRef: { id: "unit-declared-gate", type: "mission_plan_unit" },
        },
      ],
      [
        { unitId: "unit-produce", dependencies: [] },
        { unitId: "unit-declared-gate", dependencies: ["unit-produce"] },
      ],
    );

    const steps = buildPaqoWorkflowSteps(draft, mission, {});
    const producer = steps.find((step) => step.name.includes("리포트 생성"))!;
    const machineGate = steps.find((step) => step.toolNames?.[0] === STEP_MACHINE_CHECKS_TOOL)!;
    const declaredGate = steps.find((step) => step.toolNames?.[0] === "validate-report-html")!;

    expect(machineGate).toBeDefined();
    expect(declaredGate).toBeDefined();
    // 선언된 structural gate 도 생산자 의존을 유지하고 machine gate 를 추가로 기다린다.
    expect(declaredGate.dependencies).toContain(producer.id);
    expect(declaredGate.dependencies).toContain(machineGate.id);
    // 선언된 gate 의 toolArgs 는 건드리지 않는다.
    expect(declaredGate.toolArgs).toMatchObject({ glob: "*.html" });
  });
});
