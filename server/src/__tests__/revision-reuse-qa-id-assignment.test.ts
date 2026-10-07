// [수정 재사용] 예약된 과거 QA ID 배정 — 한 과거 QA ID 를 여러 B QA 단위가 동시에 이어받으면 거부한다.
import { describe, expect, it } from "vitest";
import { assignReservedQaStepIds } from "../services/missions/revision-reuse-plan.js";

describe("assignReservedQaStepIds", () => {
  it("rejects two B QA units claiming the same reserved past QA step id", () => {
    const result = assignReservedQaStepIds({
      reservedQaStepIds: ["past-qa"],
      authoredUnits: [
        { id: "qa-1", type: "qa", sourceStepId: "past-qa" },
        { id: "qa-2", type: "qa", sourceStepId: "past-qa" },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map(d => d.code)).toEqual(["mission_revision_reuse_id_collision"]);
  });

  it("assigns a single claim to its unit and leaves the remaining id to final QA", () => {
    const result = assignReservedQaStepIds({
      reservedQaStepIds: ["past-qa", "past-final"],
      authoredUnits: [{ id: "qa-1", type: "qa", sourceStepId: "past-qa" }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect([...result.qaStepIdByUnitId]).toEqual([["qa-1", "past-qa"]]);
      expect(result.finalQaStepId).toBe("past-final");
    }
  });
});
