import { describe, expect, it } from "vitest";
import { CORE_INTEGRATED_PLUGIN_KEYS } from "../plugins/core-integrated";
import { humanOperatorBadgeCount } from "./human-operator-badge-count";

describe("Sidebar core-integrated plugin exclusions", () => {
  it("excludes Tool Registry plugin sidebar contributions", () => {
    expect(CORE_INTEGRATED_PLUGIN_KEYS).toEqual(expect.arrayContaining([
      "insightflo.workflow-engine",
      "insightflo.tool-registry",
    ]));
  });

  it("adds pending Interactive Cards without dropping existing request counts", () => {
    expect(humanOperatorBadgeCount(3, 2)).toBe(5);
    expect(humanOperatorBadgeCount(undefined, undefined)).toBe(0);
  });
});
