import { describe, expect, it } from "vitest";
import { validatePluginApprovalCreate } from "../services/plugin-approval-validation.js";

describe("validatePluginApprovalCreate", () => {
  it("accepts a valid external_automation request and trims title/summary", () => {
    const result = validatePluginApprovalCreate({
      type: "external_automation",
      payload: { repository: "acme/runtime", commit: "deadbeef" },
      title: "  Deploy main  ",
      summary: "  All checks passed  ",
    });
    expect(result.type).toBe("external_automation");
    expect(result.payload.repository).toBe("acme/runtime");
    expect(result.title).toBe("Deploy main");
    expect(result.summary).toBe("All checks passed");
  });

  it("rejects an unsupported approval type", () => {
    expect(() => validatePluginApprovalCreate({ type: "not_real", payload: {} })).toThrow(/unsupported approval type/);
    expect(() => validatePluginApprovalCreate({ type: 123, payload: {} })).toThrow(/unsupported approval type/);
  });

  it("rejects a non-object payload (array, null, primitive)", () => {
    expect(() => validatePluginApprovalCreate({ type: "external_automation", payload: [] })).toThrow(/JSON object/);
    expect(() => validatePluginApprovalCreate({ type: "external_automation", payload: null })).toThrow(/JSON object/);
    expect(() => validatePluginApprovalCreate({ type: "external_automation", payload: "x" })).toThrow(/JSON object/);
  });

  it("rejects an oversized payload", () => {
    const huge = { blob: "x".repeat(70 * 1024) };
    expect(() => validatePluginApprovalCreate({ type: "external_automation", payload: huge })).toThrow(/exceeds/);
  });

  it("drops empty title to undefined and rejects over-long summary", () => {
    const result = validatePluginApprovalCreate({
      type: "external_automation",
      payload: {},
      title: "   ",
    });
    expect(result.title).toBeUndefined();
    expect(() => validatePluginApprovalCreate({
      type: "external_automation",
      payload: {},
      summary: "y".repeat(1001),
    })).toThrow(/summary exceeds/);
  });

  it("counts payload size in UTF-8 bytes and rejects non-string labels", () => {
    expect(() => validatePluginApprovalCreate({
      type: "external_automation",
      payload: { blob: "가".repeat(24 * 1024) },
    })).toThrow(/exceeds/);
    expect(() => validatePluginApprovalCreate({
      type: "external_automation",
      payload: {},
      title: 42,
    })).toThrow(/title must be a string/);
  });
});
