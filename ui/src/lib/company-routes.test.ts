import { describe, expect, it } from "vitest";
import {
  applyCompanyPrefix,
  extractCompanyPrefixFromPath,
  isBoardPathWithoutPrefix,
  isGlobalPath,
  toCompanyRelativePath,
} from "./company-routes";

describe("company mission routes", () => {
  it("treats missions as a board route without a company prefix", () => {
    expect(isBoardPathWithoutPrefix("/missions")).toBe(true);
    expect(extractCompanyPrefixFromPath("/missions")).toBeNull();
  });

  it("applies a company prefix to quality board navigation", () => {
    expect(isBoardPathWithoutPrefix("/quality")).toBe(true);
    expect(extractCompanyPrefixFromPath("/quality")).toBeNull();
    expect(applyCompanyPrefix("/quality", "RES")).toBe("/RES/quality");
  });

  it("converts company-prefixed plugin routes into company-relative paths", () => {
    expect(toCompanyRelativePath("/CMPA/tool-registry")).toBe("/tool-registry");
  });

  it("keeps global utility pages out of company-prefix extraction", () => {
    for (const path of ["/channels", "/scheduler", "/worktree/rules", "/worktree/proposals"]) {
      expect(isGlobalPath(path)).toBe(true);
      expect(extractCompanyPrefixFromPath(path)).toBeNull();
      expect(applyCompanyPrefix(path, "CMPAA")).toBe(path);
    }
  });
});
