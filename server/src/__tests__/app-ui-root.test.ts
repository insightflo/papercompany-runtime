import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { mountStaticUi, resolveUiRoot } from "../app.js";

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

describe("mountStaticUi", () => {
  it("serves SPA routes as HTML but does not fallback missing assets to HTML", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "paperclip-static-ui-"));
    tempDirs.push(root);

    const assetsDir = path.join(root, "assets");
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(path.join(root, "index.html"), "<!doctype html><div id=\"root\"></div>", "utf8");
    writeFileSync(path.join(assetsDir, "app.js"), "export const ok = true;\n", "utf8");

    const app = express();
    mountStaticUi(app, root, "<!doctype html><div id=\"root\">App</div>");

    const route = await request(app).get("/workflows").expect(200);
    expect(route.headers["content-type"]).toContain("text/html");
    expect(route.headers["cache-control"]).toContain("no-store");
    expect(route.text).toContain("App");

    const asset = await request(app).get("/assets/app.js").expect(200);
    expect(asset.headers["content-type"]).toContain("javascript");
    expect(asset.text).toContain("ok");

    const missingAsset = await request(app).get("/assets/missing.js").expect(404);
    expect(missingAsset.headers["content-type"]).not.toContain("text/html");
    expect(missingAsset.headers["cache-control"]).toBe("no-store");
    expect(missingAsset.text).not.toContain("<!doctype html>");
  });
});
