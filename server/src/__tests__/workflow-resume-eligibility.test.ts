import { describe, expect, it } from "vitest";
import { checkStepEligibility } from "../services/workflow/resume/eligibility.js";
import type { StepEligibilityBlocker, StepHistory } from "../services/workflow/resume/types.js";

/**
 * [purpose] Task5b step 단위 적격성 순수 함수 계약 테스트 — 상태 게이트, 현재 소유권,
 *   agent/tool 기록 이력 플래그 각각의 refused, executionGeneration 단독은 이력 아님,
 *   미실행 agent/tool 의 알려진 effect(external 포함) 허용, unknown effect 차단,
 *   control 의 issue/외부결과/effect 규칙과 재평가 허용 범위. null 은 오직 per-step 적격.
 */

function history(overrides: Partial<StepHistory> = {}): StepHistory {
  return {
    stepId: "step-1",
    status: "pending",
    issueId: null,
    startedAt: null,
    executionGeneration: 0,
    hasAttempt: false,
    hasQueue: false,
    hasOwner: false,
    hasExternalResult: false,
    effect: "none",
    kind: "agent",
    ...overrides,
  };
}

const KINDS = ["agent", "tool", "control"] as const;
const RESUMABLE = ["pending", "failed", "skipped"] as const;

describe("checkStepEligibility — status and ownership gates", () => {
  it("blocks running as active_work for every kind", () => {
    for (const kind of KINDS) {
      expect(checkStepEligibility(history({ kind, status: "running" }))).toBe("active_work");
    }
  });

  it("blocks completed as executed_step (cannot rewind, even control with residue)", () => {
    for (const kind of KINDS) {
      expect(checkStepEligibility(history({ kind, status: "completed" }))).toBe("executed_step");
    }
    expect(
      checkStepEligibility(
        history({ kind: "control", status: "completed", startedAt: "t", hasAttempt: true }),
      ),
    ).toBe("executed_step");
  });

  it("blocks statuses outside pending/failed/skipped as unsupported_status", () => {
    for (const status of ["cancelled", "canceled", "unknown"]) {
      expect(checkStepEligibility(history({ status }))).toBe("unsupported_status");
    }
  });

  it("blocks current ownership as active_work for every kind even when unexecuted", () => {
    for (const kind of KINDS) {
      expect(checkStepEligibility(history({ kind, hasOwner: true }))).toBe("active_work");
    }
  });
});

describe("checkStepEligibility — agent/tool recorded history", () => {
  const flagCases: Array<[string, Partial<StepHistory>]> = [
    ["issueId", { issueId: "issue-7" }],
    ["startedAt", { startedAt: "2026-09-07T00:00:00.000Z" }],
    ["hasAttempt", { hasAttempt: true }],
    ["hasQueue", { hasQueue: true }],
    ["hasExternalResult", { hasExternalResult: true }],
  ];

  for (const kind of ["agent", "tool"] as const) {
    for (const [label, flag] of flagCases) {
      it(`refuses ${kind} with ${label}-only history as executed_step`, () => {
        expect(checkStepEligibility(history({ kind, ...flag }))).toBe("executed_step");
      });
    }
  }

  it("allows executionGeneration alone (it is not history)", () => {
    for (const kind of ["agent", "tool"] as const) {
      expect(checkStepEligibility(history({ kind, executionGeneration: 4 }))).toBeNull();
    }
  });

  it("allows every resumable status when unexecuted with known effects", () => {
    for (const kind of ["agent", "tool"] as const) {
      for (const status of RESUMABLE) {
        for (const effect of ["none", "read_only", "external"] as const) {
          expect(checkStepEligibility(history({ kind, status, effect }))).toBeNull();
        }
      }
    }
  });

  it("blocks unknown effect as external_effect_unknown when unexecuted", () => {
    for (const kind of ["agent", "tool"] as const) {
      for (const status of RESUMABLE) {
        expect(
          checkStepEligibility(history({ kind, status, effect: "unknown" })),
        ).toBe("external_effect_unknown");
      }
    }
  });
});

describe("checkStepEligibility — control", () => {
  it("refuses prior issue or external result as executed_step", () => {
    expect(checkStepEligibility(history({ kind: "control", issueId: "issue-7" }))).toBe(
      "executed_step",
    );
    for (const status of RESUMABLE) {
      expect(
        checkStepEligibility(history({ kind: "control", status, hasExternalResult: true })),
      ).toBe("executed_step");
      expect(
        checkStepEligibility(history({ kind: "control", status, issueId: "issue-7" })),
      ).toBe("executed_step");
    }
  });

  it("blocks external/unknown effects as control_tool_effects_unverified", () => {
    for (const status of RESUMABLE) {
      expect(
        checkStepEligibility(history({ kind: "control", status, effect: "external" })),
      ).toBe("control_tool_effects_unverified");
      expect(
        checkStepEligibility(history({ kind: "control", status, effect: "unknown" })),
      ).toBe("control_tool_effects_unverified");
    }
  });

  it("refuses pending control with inconsistent unfinished past as executed_step", () => {
    expect(
      checkStepEligibility(history({ kind: "control", startedAt: "2026-09-07T00:00:00.000Z" })),
    ).toBe("executed_step");
    expect(checkStepEligibility(history({ kind: "control", hasAttempt: true }))).toBe(
      "executed_step",
    );
    expect(checkStepEligibility(history({ kind: "control", hasQueue: true }))).toBe(
      "executed_step",
    );
  });

  it("allows a fresh pending control with no history and none/read_only effect", () => {
    for (const effect of ["none", "read_only"] as const) {
      expect(checkStepEligibility(history({ kind: "control", effect }))).toBeNull();
    }
  });

  it("allows failed/skipped control reevaluation after prior read_only evaluation", () => {
    for (const status of ["failed", "skipped"] as const) {
      expect(
        checkStepEligibility(
          history({
            kind: "control",
            status,
            startedAt: "2026-09-07T00:00:00.000Z",
            hasAttempt: true,
            hasQueue: true,
            effect: "read_only",
          }),
        ),
      ).toBeNull();
    }
  });

  it("blocks control reevaluation when owner, external result, or issue is present", () => {
    for (const status of ["failed", "skipped"] as const) {
      expect(
        checkStepEligibility(
          history({ kind: "control", status, startedAt: "t", hasAttempt: true, hasOwner: true }),
        ),
      ).toBe("active_work");
      expect(
        checkStepEligibility(
          history({ kind: "control", status, hasAttempt: true, hasExternalResult: true }),
        ),
      ).toBe("executed_step");
      expect(
        checkStepEligibility(history({ kind: "control", status, hasQueue: true, issueId: "i-1" })),
      ).toBe("executed_step");
    }
  });
});

describe("checkStepEligibility — scope", () => {
  it("null is strictly per-step: identical histories judge identically regardless of stepId", () => {
    const a = history({ stepId: "a" });
    const b = history({ stepId: "b" });
    expect(checkStepEligibility(a)).toBeNull();
    expect(checkStepEligibility(b)).toBe(checkStepEligibility(a));
  });

  it("covers every declared blocker value", () => {
    const seen = new Set<StepEligibilityBlocker>();
    const samples: StepHistory[] = [
      history({ status: "cancelled" }),
      history({ status: "running" }),
      history({ status: "completed" }),
      history({ effect: "unknown" }),
      history({ kind: "control", effect: "external" }),
      history(),
    ];
    for (const sample of samples) {
      const verdict = checkStepEligibility(sample);
      if (verdict !== null) seen.add(verdict);
    }
    expect(seen).toEqual(
      new Set<StepEligibilityBlocker>([
        "unsupported_status",
        "active_work",
        "executed_step",
        "external_effect_unknown",
        "control_tool_effects_unverified",
      ]),
    );
  });
});
