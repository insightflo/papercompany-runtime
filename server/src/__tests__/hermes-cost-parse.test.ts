import { describe, expect, it } from "vitest";

import { parseHermesOutput } from "../adapters/hermes-local-execute.js";

// [목적] COST_REGEX 의 `[\d.]+` 는 "cost." 같은 일반 산문의 마침표도 잡아낸다.
//   Number.parseFloat(".") === NaN 이며, NaN/Infinity 가 mission-runtime costCents
//   (bigint round) 지속 경로에 닿으면 안 된다. 유한 숫자 USD 값일 때만 costUsd 를
//   채택하고, 그 외에는 undefined 로 내보내는지 검증한다.
describe("parseHermesOutput cost extraction (NaN-safe)", () => {
  it("rejects trailing-dot prose like 'cost.'/'spent.' and yields no costUsd", () => {
    const prose = ["cost.", "spent.", "The cost. That is all.", "I spent. Then stopped."];
    for (const stdout of prose) {
      const parsed = parseHermesOutput(stdout, "");
      expect(parsed.costUsd).toBeUndefined();
    }
  });

  it("accepts finite numeric USD forms and preserves the exact value", () => {
    const cases: Array<[string, number]> = [
      ["Cost: $0.0123", 0.0123],
      ["cost: 0.05", 0.05],
      ["spent 1.23", 1.23],
      ["Cost: 0.5.", 0.5], // trailing sentence period after a valid number
    ];
    for (const [stdout, expected] of cases) {
      const parsed = parseHermesOutput(stdout, "");
      expect(parsed.costUsd).toBeCloseTo(expected, 7);
    }
  });

  it("extracts cost from either stdout or stderr", () => {
    expect(parseHermesOutput("", "Cost: $2.5").costUsd).toBeCloseTo(2.5, 7);
  });
});
