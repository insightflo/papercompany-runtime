import { describe, expect, it } from "vitest";
import {
  getPlaywrightSuiteConfigCandidates,
  normalizeForwardedPlaywrightArgs,
  resolvePlaywrightSuiteExecutionContext,
  resolvePlaywrightSuiteConfigPath,
} from "../../../scripts/playwright-suite-config.mjs";

describe("playwright suite config resolver", () => {
  it("prefers the root tests path when both candidates exist", () => {
    const existingPaths = new Set([
      "/repo/tests/release-smoke/playwright.config.ts",
      "/repo/paperclip-orginal/tests/release-smoke/playwright.config.ts",
    ]);

    const resolved = resolvePlaywrightSuiteConfigPath({
      suiteName: "release-smoke",
      cwd: "/repo",
      fileExists: (candidate) => existingPaths.has(candidate),
    });

    expect(resolved).toBe("/repo/tests/release-smoke/playwright.config.ts");
  });

  it("falls back to paperclip-orginal tests path when root tests path is absent", () => {
    const existingPaths = new Set(["/repo/paperclip-orginal/tests/release-smoke/playwright.config.ts"]);

    const resolved = resolvePlaywrightSuiteConfigPath({
      suiteName: "release-smoke",
      cwd: "/repo",
      fileExists: (candidate) => existingPaths.has(candidate),
    });

    expect(resolved).toBe("/repo/paperclip-orginal/tests/release-smoke/playwright.config.ts");
  });

  it("returns nested execution cwd when using paperclip-orginal fallback", () => {
    const existingPaths = new Set(["/repo/paperclip-orginal/tests/release-smoke/playwright.config.ts"]);

    const context = resolvePlaywrightSuiteExecutionContext({
      suiteName: "release-smoke",
      cwd: "/repo",
      fileExists: (candidate) => existingPaths.has(candidate),
    });

    expect(context).toEqual({
      configPath: "/repo/paperclip-orginal/tests/release-smoke/playwright.config.ts",
      configArg: "tests/release-smoke/playwright.config.ts",
      commandCwd: "/repo/paperclip-orginal",
    });
  });

  it("returns null when no known config path exists", () => {
    const resolved = resolvePlaywrightSuiteConfigPath({
      suiteName: "release-smoke",
      cwd: "/repo",
      fileExists: () => false,
    });

    expect(resolved).toBeNull();
  });
});

describe("playwright argument forwarding", () => {
  it("drops pnpm's '--' separator", () => {
    expect(normalizeForwardedPlaywrightArgs(["--", "--list"])).toEqual(["--list"]);
  });

  it("keeps regular argument arrays unchanged", () => {
    expect(normalizeForwardedPlaywrightArgs(["--list"])).toEqual(["--list"]);
  });

  it("exposes both supported config candidates for release-smoke", () => {
    expect(getPlaywrightSuiteConfigCandidates("release-smoke")).toEqual([
      "tests/release-smoke/playwright.config.ts",
      "paperclip-orginal/tests/release-smoke/playwright.config.ts",
    ]);
  });
});
