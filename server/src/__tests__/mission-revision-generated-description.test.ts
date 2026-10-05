// server/src/__tests__/mission-revision-generated-description.test.ts
//
// [회귀 교정 — TEST-FIRST] 생성 PAQO description 의 Mission 표시 제목이 원문 바이트 비교에
// 포함되어 Source→Revision 동일 실행 구성의 seed 후보/승인을 무효화한 회귀(mission-revision-paqo
// 후보 없음, mission-revision-paqo-artifacts incompatible_definition 3건)의 교정 계약을 순수
// 단위로 검증한다. 기존 DB 기대값과 description-change refusal/repeated-lineage 테스트는 그대로
// 두며 이 파일이 대체하지 않는다.
//   - 생성 시점 분리: missionTitle 은 typed 입력으로만 두 번째 표시 줄에 들어간다(문자열 필터링 아님).
//   - 결합 계약: typed 필드 전체 재구성 + 원문 description SHA + 실행 줄 SHA 를 모두 통과할 때만
//     실행 의미 SHA 로 비교하고, stale/missing/malformed/tampered 결합과 native description 은
//     원문 바이트 비교로 보수 거절한다.
import { describe, expect, it } from "vitest";
import { buildPaqoWorkflowSteps } from "../services/mission-owner-plan-decisions.js";
import { sha256Text } from "../services/issue-execution-cards/hash.js";
import { normalizeWorkflowStepsForExecution } from "../services/workflow/execution-steps.js";
import { revisionStepHash } from "../services/workflow/revision-step-config.js";
import {
  GENERATED_DESCRIPTION_BINDING_VERSION,
  buildPaqoStepDescription,
  readGeneratedExecutionDescriptionSha,
  type GeneratedDescriptionBinding,
} from "../services/workflow/revision-generated-description.js";

type PaqoMission = Parameters<typeof buildPaqoWorkflowSteps>[1];
type BoundStep = ReturnType<typeof buildPaqoWorkflowSteps>[number] & { revisionDescriptionBinding?: GeneratedDescriptionBinding };
const mission = (id: string, title: string): PaqoMission => ({
  id, companyId: "22222222-2222-4222-8222-222222222222",
  ownerAgentId: "33333333-3333-4333-8333-333333333333", title,
} as PaqoMission);
const sourceMission = mission("11111111-1111-4111-8111-111111111111", "Source");
const revisionMission = mission("44444444-4444-4444-8444-444444444444", "Revision");
const draft = (units: Record<string, unknown>[]) => ({ missionGoal: "report", successCriteria: [],
  steps: units.map((u, i) => ({ unitId: u.id, dependencies: i ? [units[i - 1].id] : [] })),
  refs: { selectedExecutionUnits: units } });
const writer = { id: "u", title: "Write", graphWorkProductRequired: true };
const buildFor = (missionFixture: PaqoMission, units: Record<string, unknown>[] = [writer]) =>
  buildPaqoWorkflowSteps(draft(units) as never, missionFixture);
const bindingOf = (step: BoundStep) => step.revisionDescriptionBinding!;
const nativeOf = (step: BoundStep): BoundStep => { const copy = { ...step }; delete copy.revisionDescriptionBinding; return copy; };

describe("paqo generated-description binding", () => {
  it("legacy display format: null/empty execution lines drop and Mission title is the second line only", () => {
    const built = buildPaqoStepDescription("Mission Title", ["header line", null, "", "assigned line"]);
    expect(built.description).toBe("header line\nMission: Mission Title\nassigned line");
    expect(built.revisionDescriptionBinding).toMatchObject({
      schemaVersion: GENERATED_DESCRIPTION_BINDING_VERSION,
      missionTitle: "Mission Title",
      executionLines: ["header line", "assigned line"],
      descriptionSha256: sha256Text("header line\nMission: Mission Title\nassigned line"),
      executionSha256: sha256Text("header line\nassigned line"),
    });
  });

  it("generated display description stays byte-identical to the legacy inline array format", () => {
    const steps = buildFor(revisionMission);
    expect(steps[0].description).toBe([
      "Mission-level PAQO ACTION issue materialized from an authorized PLAN decision.",
      "Mission: Revision",
      `Assigned by PLAN decision to agentId: ${revisionMission.ownerAgentId}`,
    ].join("\n"));
  });

  it("(a) different mission titles: display/SHA differ, execution SHA and seed hash match with sourceStepId kept", () => {
    const sourceSteps = buildFor(sourceMission);
    const targetSteps = buildFor(revisionMission, [{ ...writer, title: "Renamed", sourceStepId: sourceSteps[0].id }]);
    const source = sourceSteps[0] as BoundStep, target = targetSteps[0] as BoundStep;
    expect(target.id).not.toBe(source.id);
    expect(target).toHaveProperty("sourceStepId", source.id);
    expect(source.description).toContain("Mission: Source");
    expect(target.description).toContain("Mission: Revision");
    expect(source.description).not.toBe(target.description);
    expect(bindingOf(source).descriptionSha256).not.toBe(bindingOf(target).descriptionSha256);
    expect(bindingOf(source).executionSha256).toBe(bindingOf(target).executionSha256);
    expect(readGeneratedExecutionDescriptionSha(source)).toBe(bindingOf(source).executionSha256);
    expect(readGeneratedExecutionDescriptionSha(target)).toBe(bindingOf(target).executionSha256);
    expect(revisionStepHash(target, targetSteps)).toBe(revisionStepHash(source, sourceSteps, "seed", "current"));
  });

  it("(b) instruction/reason/skill/contract-line changes still change the generated seed hash", () => {
    const base = buildFor(revisionMission);
    for (const patch of [{ instructions: "delta" }, { reason: "why" }, { skills: ["skill-a"] }, { expectedOutput: "doc" }]) {
      const changed = buildFor(revisionMission, [{ ...writer, ...patch }]);
      expect(revisionStepHash(changed[0], changed)).not.toBe(revisionStepHash(base[0], base));
    }
  });

  it("(c) post-generation description byte changes invalidate the binding and the seed hash", () => {
    const steps = buildFor(revisionMission);
    const step = steps[0] as BoundStep;
    const description = step.description as string;
    const originalHash = revisionStepHash(step, steps);
    expect(readGeneratedExecutionDescriptionSha(step)).toBe(bindingOf(step).executionSha256);
    for (const mutated of [`${description}x`, `${description}\n`, description.replace("PLAN decision.", "PLAN decision. ")]) {
      const tampered = { ...step, description: mutated };
      expect(readGeneratedExecutionDescriptionSha(tampered)).toBeNull();
      expect(revisionStepHash(tampered, steps)).not.toBe(originalHash);
    }
  });

  it("(d) refreshing only descriptionSha256 over a tampered description cannot smuggle stale execution lines", () => {
    const steps = buildFor(revisionMission);
    const step = steps[0] as BoundStep;
    const forgedDescription = `${step.description}\ninjected instruction`;
    const tampered = { ...step, description: forgedDescription,
      revisionDescriptionBinding: { ...bindingOf(step), descriptionSha256: sha256Text(forgedDescription) } };
    expect(readGeneratedExecutionDescriptionSha(tampered)).toBeNull();
    expect(revisionStepHash(tampered, steps)).not.toBe(revisionStepHash(step, steps));
  });

  it("(e) missing/malformed/wrong-version/wrong-SHA bindings fall back to exact raw description comparison", () => {
    const steps = buildFor(revisionMission);
    const step = steps[0] as BoundStep;
    const native = nativeOf(step);
    const nativeHash = revisionStepHash(native, steps);
    expect(nativeHash).not.toBe(revisionStepHash(step, steps));
    for (const bad of [
      undefined,
      "not-an-object",
      { ...bindingOf(step), schemaVersion: "paqo.generated-description.v2" },
      { ...bindingOf(step), extra: 1 },
      { ...bindingOf(step), executionLines: "not-array" },
      { ...bindingOf(step), executionSha256: "ZZ" },
      { ...bindingOf(step), executionSha256: sha256Text("different execution") },
      { ...bindingOf(step), executionLines: [] },
      { ...bindingOf(step), missionTitle: "Forged" },
    ]) {
      const malformed = { ...native, revisionDescriptionBinding: bad };
      expect(readGeneratedExecutionDescriptionSha(malformed)).toBeNull();
      expect(revisionStepHash(malformed, steps)).toBe(nativeHash);
    }
  });

  it("(f) native descriptions compare exact raw bytes: Mission phrase, machine tokens, whitespace", () => {
    const base = { id: "a", name: "A", agentId: "agent", dependencies: [] as string[],
      description: "Mission: Source\nInstruction bytes\n{$steps.write.workProductPath}" };
    const hash = revisionStepHash(base, []);
    expect(hash).toBe(revisionStepHash({ ...base, description: `${base.description}` }, []));
    for (const description of [
      "Mission: Revision\nInstruction bytes\n{$steps.write.workProductPath}",
      "Mission: Source\nInstruction  bytes\n{$steps.write.workProductPath}",
      "Mission: Source\nInstruction bytes\n{$steps.other.workProductPath}",
      "Mission: Source\nInstruction bytes",
    ]) expect(revisionStepHash({ ...base, description }, [])).not.toBe(hash);
  });

  it("(g) normalizeWorkflowStepsForExecution and JSON roundtrip preserve the binding and comparison", () => {
    const sourceSteps = buildFor(sourceMission);
    const targetSteps = buildFor(revisionMission, [{ ...writer, title: "Renamed", sourceStepId: sourceSteps[0].id }]);
    const roundtrip = (steps: typeof targetSteps) => normalizeWorkflowStepsForExecution(JSON.parse(JSON.stringify(steps)));
    const normalizedSource = roundtrip(sourceSteps), normalizedTarget = roundtrip(targetSteps);
    expect((normalizedTarget[0] as BoundStep).description).toBe(targetSteps[0].description);
    expect(readGeneratedExecutionDescriptionSha(normalizedTarget[0])).toBe(bindingOf(targetSteps[0] as BoundStep).executionSha256);
    expect(revisionStepHash(normalizedTarget[0], normalizedTarget))
      .toBe(revisionStepHash(normalizedSource[0], normalizedSource, "seed", "current"));
  });

  it("(h) failure purpose keeps ignoring description and binding changes", () => {
    const steps = buildFor(revisionMission);
    const step = steps[0] as BoundStep;
    const failureHash = revisionStepHash(step, steps, "failure");
    expect(revisionStepHash({ ...step, description: "entirely different" }, steps, "failure")).toBe(failureHash);
    expect(revisionStepHash(nativeOf(step), steps, "failure")).toBe(failureHash);
    expect(revisionStepHash({ ...step, revisionDescriptionBinding: { ...bindingOf(step), executionSha256: sha256Text("forged") } },
      steps, "failure")).toBe(failureHash);
  });

  it("(i) sourceRef 실행줄은 키 순서 정규형을 쓴다; 값이 달라지면 여전히 seed 해시가 달라진다", () => {
    const withRef = (sourceRef: Record<string, unknown>) => [{ ...writer, sourceRef }];
    const canonicalLine = `Source ref: {"id":"write","type":"mission_plan_unit"}`;
    // [jsonb 키 순서 회귀] 원본 정의는 메모리 삽입 순서(type→id)로, revision 정의는 jsonb 저장·재독기
    // 순서(id→type)로 만들어져도 실행줄 바이트/SHA 는 같아야 한다. 삽입 순서 JSON.stringify 를 쓰면
    // 의미 동일 sourceRef 가 executionSha256 불일치로 workflow_seed_incompatible_definition 거짓 거절된다.
    const sourceSteps = buildFor(sourceMission, withRef({ type: "mission_plan_unit", id: "write" }));
    const targetSteps = buildFor(revisionMission, withRef({ id: "write", type: "mission_plan_unit" }));
    const source = sourceSteps[0] as BoundStep, target = targetSteps[0] as BoundStep;
    expect(source.description).toContain(canonicalLine);
    expect(target.description).toContain(canonicalLine);
    expect(bindingOf(source).executionSha256).toBe(bindingOf(target).executionSha256);
    expect(readGeneratedExecutionDescriptionSha(target)).toBe(bindingOf(source).executionSha256);
    expect(revisionStepHash(target, targetSteps)).toBe(revisionStepHash(source, sourceSteps, "seed", "current"));
    // 키 순서가 아니라 값이 달라지면(다른 id/타입/추가 키) 여전히 실행 해시가 달라 거절된다.
    for (const changed of [
      { type: "mission_plan_unit", id: "other" },
      { type: "mission_plan_template", id: "write" },
      { id: "write", type: "mission_plan_unit", extra: 1 },
    ]) {
      const changedSteps = buildFor(revisionMission, withRef(changed));
      expect(bindingOf(changedSteps[0] as BoundStep).executionSha256).not.toBe(bindingOf(source).executionSha256);
      expect(revisionStepHash(changedSteps[0], changedSteps)).not.toBe(revisionStepHash(source, sourceSteps, "seed", "current"));
    }
  });
});
