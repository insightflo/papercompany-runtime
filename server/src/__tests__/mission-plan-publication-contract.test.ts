import { describe, expect, it } from "vitest";
import { reviewPublicationVerificationTopology as review } from "../services/missions/mission-plan-publication-contract.js";
import { publicationTools, publicationUnits } from "./helpers/mission-publication-fixture.js";

describe("publication topology", () => {
  it("accepts downstream declared receipt binding", () => {
    const units = publicationUnits();
    units[1]!.toolArgs = { receiptInput: "{$steps.p.workProductPath}" };
    expect(review(units, publicationTools)).toEqual([]);
  });
  it.each([{}, { receiptInput: "https://example.test/guessed" }, { receiptInput: "{$steps.other.workProductPath}" },
    { publishResultPath: "{$steps.p.workProductPath}" }])("rejects missing, guessed, foreign, or undeclared binding %j", toolArgs => {
    const units = publicationUnits();
    units[1]!.toolArgs = toolArgs;
    expect(review(units, publicationTools)).toMatchObject([{ code: "missing_publication_verify_tool" }]);
  });
  it("requires dependency as well as the binding", () => {
    const units = publicationUnits();
    units[1]!.toolArgs = { receiptInput: "{$steps.p.workProductPath}" };
    units[1]!.dependsOn = [];
    expect(review(units, publicationTools)).toHaveLength(1);
  });
  it("does not derive contracts from suggestive tool names", () => {
    expect(review([{ id: "p", toolName: "publish" }, { id: "v", toolName: "verify" }])).toEqual([]);
  });
});
