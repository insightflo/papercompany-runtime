import { describe, expect, it } from "vitest";
import { buildCommandCodeEffortOptions, shouldResetCommandCodeEffort } from "./commandcode-efforts.js";

describe("buildCommandCodeEffortOptions", () => {
  it("always leads with the Auto (no-override) option", () => {
    expect(buildCommandCodeEffortOptions([])).toEqual([{ id: "", label: "Auto" }]);
  });

  it("maps discovered efforts to capitalized labels in declared order", () => {
    expect(buildCommandCodeEffortOptions(["high", "max"])).toEqual([
      { id: "", label: "Auto" },
      { id: "high", label: "High" },
      { id: "max", label: "Max" },
    ]);
  });

  it("handles the full five-level effort ladder", () => {
    expect(buildCommandCodeEffortOptions(["low", "medium", "high", "xhigh", "max"])).toEqual([
      { id: "", label: "Auto" },
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
      { id: "xhigh", label: "XHigh" },
      { id: "max", label: "Max" },
    ]);
  });
});

describe("shouldResetCommandCodeEffort", () => {
  it("does not reset when no effort is selected", () => {
    expect(shouldResetCommandCodeEffort("", ["high", "max"], true)).toBe(false);
  });

  it("does not reset while efforts are still loading (undefined)", () => {
    expect(shouldResetCommandCodeEffort("high", undefined, false)).toBe(false);
  });

  it("does not reset when loaded is false even if data arrived", () => {
    expect(shouldResetCommandCodeEffort("max", ["high", "max"], false)).toBe(false);
  });

  it("does not reset when the effort is in the loaded set", () => {
    expect(shouldResetCommandCodeEffort("high", ["high", "max"], true)).toBe(false);
    expect(shouldResetCommandCodeEffort("max", ["high", "max"], true)).toBe(false);
  });

  it("resets when the effort is NOT in the loaded set after successful discovery", () => {
    expect(shouldResetCommandCodeEffort("max", ["low", "medium", "high"], true)).toBe(true);
  });

  it("does not reset against a legitimate empty list while loaded is false", () => {
    // Model has no adjustable effort → efforts [] is a valid result, but only
    // after isSuccess. Before that, preserve the selection.
    expect(shouldResetCommandCodeEffort("high", undefined, false)).toBe(false);
  });

  it("resets a stale effort when the model truly has no adjustable effort", () => {
    expect(shouldResetCommandCodeEffort("high", [], true)).toBe(true);
  });
});
