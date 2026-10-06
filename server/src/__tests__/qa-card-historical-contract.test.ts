import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildHistoricalQaSourceDefectCard } from "../services/workflow/qa-source-defect-card-historical.js";
import { validateAndHashOperatorDecisionCreate } from "../services/operator-decision-result.js";

const frozen = JSON.parse(readFileSync(new URL("./fixtures/qa-card-history/payloads.json", import.meta.url), "utf8")) as Array<{
  revision: string; kind: string; input: Parameters<typeof buildHistoricalQaSourceDefectCard>[0]; payload: unknown;
}>;

describe("full pre-#329 producer contract reconstruction", () => {
  it.each(frozen.filter(({ revision }) => revision === "0efbe8ee3a96bbdd0b77773dd9b326b2e255a42e"))(
    "retains the immutable $kind contract needed to replay real historical rows", ({ input, payload }) => {
      // Independent, frozen output of git show c7a091cc^, not this helper as the oracle.
      const historical = validateAndHashOperatorDecisionCreate(payload);
      const reconstructed = validateAndHashOperatorDecisionCreate(buildHistoricalQaSourceDefectCard(input));
      expect(reconstructed).toEqual(historical);
    },
  );
});
