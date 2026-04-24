import { describe, expect, it } from "vitest";
import {
  extractCompanyPrefixFromPath,
  isBoardPathWithoutPrefix,
  toCompanyRelativePath,
} from "./company-routes";

describe("company mission routes", () => {
  it("treats missions as a board route without a company prefix", () => {
    expect(isBoardPathWithoutPrefix("/missions")).toBe(true);
    expect(extractCompanyPrefixFromPath("/missions")).toBeNull();
  });

  it("converts company-prefixed plugin routes into company-relative paths", () => {
    expect(toCompanyRelativePath("/CMPA/tool-registry")).toBe("/tool-registry");
  });
});
