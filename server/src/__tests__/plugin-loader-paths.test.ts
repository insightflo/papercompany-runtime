import { describe, expect, it } from "vitest";
import { resolveDevTsxLoaderPath } from "../services/plugin-loader.js";

describe("resolveDevTsxLoaderPath", () => {
  it("uses the direct tsx loader path when it resolves cleanly", () => {
    const resolved = resolveDevTsxLoaderPath(
      (specifier) => {
        if (specifier === "tsx/dist/loader.mjs") return "/repo/node_modules/tsx/dist/loader.mjs";
        throw new Error(`unexpected specifier: ${specifier}`);
      },
      (filePath) => filePath === "/repo/node_modules/tsx/dist/loader.mjs",
    );

    expect(resolved).toBe("/repo/node_modules/tsx/dist/loader.mjs");
  });

  it("falls back to a loader next to the resolved package entrypoint", () => {
    const resolved = resolveDevTsxLoaderPath(
      (specifier) => {
        if (specifier === "tsx/dist/loader.mjs") throw new Error("deep import blocked");
        if (specifier === "tsx") return "/repo/node_modules/tsx/dist/cli.mjs";
        throw new Error(`unexpected specifier: ${specifier}`);
      },
      (filePath) => filePath === "/repo/node_modules/tsx/dist/loader.mjs",
    );

    expect(resolved).toBe("/repo/node_modules/tsx/dist/loader.mjs");
  });

  it("returns null when tsx cannot be resolved", () => {
    expect(resolveDevTsxLoaderPath(() => { throw new Error("missing"); }, () => false)).toBeNull();
  });
});
