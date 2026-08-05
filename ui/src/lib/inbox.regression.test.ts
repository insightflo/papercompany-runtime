import { describe, expect, it } from "vitest";
import {
  shouldShowHeartbeatLoadMoreSection,
  isHeartbeatPageScopeCurrent,
} from "./inbox";

describe("shouldShowHeartbeatLoadMoreSection", () => {
  it("shows when there are work items", () => {
    expect(shouldShowHeartbeatLoadMoreSection(3, false, "recent", true)).toBe(true);
  });

  it("shows when all dismissed but more pages exist on recent tab", () => {
    expect(shouldShowHeartbeatLoadMoreSection(0, true, "recent", true)).toBe(true);
  });

  it("shows when all dismissed but more pages exist on all tab with failed category", () => {
    expect(shouldShowHeartbeatLoadMoreSection(0, true, "all", true)).toBe(true);
  });

  it("hides when no items, no more pages", () => {
    expect(shouldShowHeartbeatLoadMoreSection(0, false, "recent", true)).toBe(false);
  });

  it("hides when all tab excludes failed category and no other items", () => {
    expect(shouldShowHeartbeatLoadMoreSection(0, true, "all", false)).toBe(false);
  });
});

describe("isHeartbeatPageScopeCurrent", () => {
  it("matches same company", () => {
    expect(isHeartbeatPageScopeCurrent({ companyId: "co-1" }, { companyId: "co-1" })).toBe(true);
  });

  it("rejects different company", () => {
    expect(isHeartbeatPageScopeCurrent({ companyId: "co-1" }, { companyId: "co-2" })).toBe(false);
  });

  it("matches same company and agent", () => {
    expect(
      isHeartbeatPageScopeCurrent(
        { companyId: "co-1", agentId: "a-1" },
        { companyId: "co-1", agentId: "a-1" },
      ),
    ).toBe(true);
  });

  it("rejects same company different agent", () => {
    expect(
      isHeartbeatPageScopeCurrent(
        { companyId: "co-1", agentId: "a-2" },
        { companyId: "co-1", agentId: "a-1" },
      ),
    ).toBe(false);
  });

  it("works with undefined agentId on both sides (inbox case)", () => {
    expect(
      isHeartbeatPageScopeCurrent({ companyId: "co-1" }, { companyId: "co-1" }),
    ).toBe(true);
  });
});
