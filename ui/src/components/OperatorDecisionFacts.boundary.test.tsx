/** @vitest-environment jsdom */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { commonDecisionFacts, uniqueDecisionFacts, OperatorDecisionFacts } from "./OperatorDecisionFacts";
import type { OperatorDecisionView } from "@paperclipai/shared/types/operator-decision";

type Option = OperatorDecisionView["definition"]["options"][number];
const known = { label: "Same", value: "Raw fact", status: "known" as const };
const unknown = { ...known, status: "unknown" as const };
const option = (id: string, facts: Option["facts"]): Option => ({ id, label: id, description: null, facts, evidenceRefs: [] });

describe("exact common fact boundaries", () => {
  it("does not merge matching labels and values with different statuses", () => {
    const options = [option("a", [known]), option("b", [unknown])];
    expect(commonDecisionFacts(options)).toEqual([]);
    expect(uniqueDecisionFacts(options[0].facts, [])).toEqual([known]);
    expect(uniqueDecisionFacts(options[1].facts, [])).toEqual([unknown]);
  });
  it("intersects every option, not just the first two, without mutating input", () => {
    const partial = { label: "Partial", value: "Only two options", status: "known" as const };
    const options = [option("a", [known, partial]), option("b", [known, partial]), option("c", [known])];
    const original = structuredClone(options);
    const common = commonDecisionFacts(options);
    expect(common).toEqual([known]);
    expect(uniqueDecisionFacts(options[0].facts, common)).toEqual([partial]);
    expect(uniqueDecisionFacts(options[2].facts, common)).toEqual([]);
    expect(options).toEqual(original);
  });
  it("leaves facts on a single option even when they repeat", () => {
    expect(commonDecisionFacts([option("a", [known, known])])).toEqual([]);
    expect(uniqueDecisionFacts([known, known], [])).toEqual([known, known]);
  });
  it("keeps 200 UTF-16 units inline and folds 201 without splitting the preview emoji", () => {
    const value200 = "a".repeat(198) + "😀";
    const value201 = "b".repeat(119) + "😀" + "c".repeat(80);
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(<OperatorDecisionFacts facts={[{ ...known, value: value200 }, { ...known, value: value201 }]} />);
    expect(host.querySelectorAll("details")).toHaveLength(1);
    expect(host.querySelector("dd")?.textContent).toBe(value200);
    const details = host.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe(`${"b".repeat(119)}…`);
    expect(details.querySelector("p")?.textContent).toBe(value201);
  });
});
