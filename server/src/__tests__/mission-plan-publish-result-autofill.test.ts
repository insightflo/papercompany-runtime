import { describe, expect, it } from "vitest";
import { autofillPublicationResult as autofill } from "../services/missions/mission-plan-publish-result-autofill.js";
import { reviewPublicationVerificationTopology as review } from "../services/missions/mission-plan-publication-contract.js";
import { publicationTools, publicationUnits, publicationContract } from "./helpers/mission-publication-fixture.js";

describe("bounded publication autofill", () => {
  it("adds the declared canonical argument and preserves other arguments", () => {
    const units = publicationUnits();
    units[1]!.toolArgs = { timeout: 5 };
    const result = autofill(units, publicationTools);
    expect(result.units[1]?.toolArgs).toEqual({ timeout: 5, receiptInput: "{$steps.p.workProductPath}" });
    expect(result.applied).toEqual({ publisherUnitId: "p", verifierUnitId: "v", field: "receiptInput" });
    expect(review(result.units, publicationTools)).toEqual([]);
  });
  it.each(["{$steps.p.workProductPath}", "conflicting", "", null])("preserves existing declared argument %j", value => {
    const units = publicationUnits();
    units[1]!.toolArgs = { receiptInput: value };
    const result = autofill(units, publicationTools);
    expect(result.applied).toBeNull();
    expect(result.units[1]?.toolArgs).toEqual({ receiptInput: value });
  });
  it("uses arbitrary dashed receipt parameter names", () => {
    const tools = [publicationTools[0]!, { name: "beta", adapterConfig: { artifactContract: publicationContract("publication-verify", "result-receipt") } }];
    expect(autofill(publicationUnits(), tools).units[1]?.toolArgs).toEqual({ "result-receipt": "{$steps.p.workProductPath}" });
  });
  it("requires exactly one publisher and verifier", () => {
    const units = publicationUnits();
    expect(autofill([...units, { ...units[0], id: "p2" }], publicationTools).applied).toBeNull();
    expect(autofill([...units, { ...units[1], id: "v2" }], publicationTools).applied).toBeNull();
  });
  it("does not autofill unrelated pairs", () => {
    const units = publicationUnits(); units[1]!.dependsOn = [];
    expect(autofill(units, publicationTools).applied).toBeNull();
  });
  it.each([undefined, null, "malformed", []])("does not invent an argument object for %j", toolArgs => {
    const units: Record<string, unknown>[] = publicationUnits(); units[1]!.toolArgs = toolArgs;
    expect(autofill(units, publicationTools).applied).toBeNull();
  });
  it("accepts transitive dependencies", () => {
    const units = publicationUnits(); units[1]!.dependsOn = ["middle"];
    expect(autofill([...units, { id: "middle", dependsOn: ["p"] }], publicationTools).applied).not.toBeNull();
  });
  it("rejects ambiguous selected verifier contracts", () => {
    const units = publicationUnits(); units[1]!.toolNames = ["beta", "gamma"];
    expect(autofill(units, [...publicationTools, { ...publicationTools[1]!, name: "gamma" }]).applied).toBeNull();
  });
  it("does not mutate inputs and returns copied units", () => {
    const units = publicationUnits(), snapshot = JSON.stringify(units);
    const result = autofill(units, publicationTools);
    expect(JSON.stringify(units)).toBe(snapshot);
    expect(result.units[0]).not.toBe(units[0]);
    expect(result.units[1]?.toolArgs).not.toBe(units[1]?.toolArgs);
  });
  it("does not act without scoped contracts", () => {
    expect(autofill(publicationUnits()).applied).toBeNull();
  });
});
