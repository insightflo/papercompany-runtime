import { describe, expect, it } from "vitest";
import { CORE_INTEGRATED_PLUGIN_KEYS } from "../plugins/core-integrated";

describe("Sidebar core-integrated plugin exclusions", () => {
  it("excludes Tool Registry plugin sidebar contributions", () => {
    expect(CORE_INTEGRATED_PLUGIN_KEYS).toEqual(expect.arrayContaining([
      "insightflo.workflow-engine",
      "insightflo.tool-registry",
    ]));
  });
});
