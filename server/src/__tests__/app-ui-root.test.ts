import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveUiRoot } from "../app.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveUiRoot", () => {
  it("prefers the runtime repo ui directory when it exists", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "paperclip-ui-root-"));
    tempDirs.push(root);

    const baseDir = path.join(root, "papercompany-runtime", "server", "src");
    const uiDir = path.join(root, "papercompany-runtime", "ui");
    mkdirSync(baseDir, { recursive: true });
    mkdirSync(uiDir, { recursive: true });
    writeFileSync(path.join(uiDir, "index.html"), "<!doctype html>", "utf8");

    expect(resolveUiRoot(baseDir, path.join(root, "papercompany-runtime"))).toBe(uiDir);
  });

  it("falls back to the current working tree ui directory when the source-relative path is missing", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "paperclip-ui-root-"));
    tempDirs.push(root);

    const baseDir = path.join(root, "legacy", "server", "dist");
    const uiDir = path.join(root, "papercompany-runtime", "ui");
    mkdirSync(baseDir, { recursive: true });
    mkdirSync(uiDir, { recursive: true });
    writeFileSync(path.join(uiDir, "index.html"), "<!doctype html>", "utf8");

    expect(resolveUiRoot(baseDir, path.join(root, "papercompany-runtime"))).toBe(uiDir);
  });
});
