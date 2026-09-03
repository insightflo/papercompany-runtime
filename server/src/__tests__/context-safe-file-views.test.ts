import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildContextSafeFileViews,
  evaluateFileViewFreshness,
} from "../services/context-safe-file-views.js";

const sha256Of = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("buildContextSafeFileViews", () => {
  it("extracts safe relative file references from the wake comment only", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-file-views-"));
    tempDirs.push(root);
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "server.ts"), "export const x = 1;", "utf8");

    const views = await buildContextSafeFileViews({
      text: "Please inspect src/server.ts, docs/missing.md, and ../secrets.env before continuing.",
      workspaceCwd: root,
      workspaceId: "workspace-1",
    });

    expect(views).toEqual([
      {
        workspaceId: "workspace-1",
        relativePath: "src/server.ts",
        source: "wake_comment",
        exists: true,
        contentHash: sha256Of("export const x = 1;"),
      },
      {
        workspaceId: "workspace-1",
        relativePath: "docs/missing.md",
        source: "wake_comment",
        exists: false,
        contentHash: null,
      },
    ]);
  });

  it("records the sha-256 content hash of each existing file at view time", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-file-views-"));
    tempDirs.push(root);
    await fs.writeFile(path.join(root, "notes.md"), "hello paperclip", "utf8");

    const [view] = await buildContextSafeFileViews({
      text: "check notes.md",
      workspaceCwd: root,
      workspaceId: null,
    });

    expect(view?.exists).toBe(true);
    expect(view?.contentHash).toBe(sha256Of("hello paperclip"));
  });

  it("records a different hash when the file content changes between builds", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-file-views-"));
    tempDirs.push(root);
    const file = path.join(root, "notes.md");
    await fs.writeFile(file, "first version", "utf8");

    const [first] = await buildContextSafeFileViews({
      text: "check notes.md",
      workspaceCwd: root,
      workspaceId: null,
    });
    await fs.writeFile(file, "second version", "utf8");
    const [second] = await buildContextSafeFileViews({
      text: "check notes.md",
      workspaceCwd: root,
      workspaceId: null,
    });

    expect(first?.contentHash).toBe(sha256Of("first version"));
    expect(second?.contentHash).toBe(sha256Of("second version"));
    expect(first?.contentHash).not.toBe(second?.contentHash);
  });

  it("skips hashing files larger than the fingerprint byte cap", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-file-views-"));
    tempDirs.push(root);
    await fs.writeFile(path.join(root, "big.bin"), Buffer.alloc(4 * 1024 * 1024 + 1, 1));

    const [view] = await buildContextSafeFileViews({
      text: "check big.bin",
      workspaceCwd: root,
      workspaceId: null,
    });

    expect(view?.exists).toBe(true);
    expect(view?.contentHash).toBeNull();
  });
});

describe("evaluateFileViewFreshness", () => {
  it("flags a view current when the recorded hash matches the file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-file-views-"));
    tempDirs.push(root);
    await fs.writeFile(path.join(root, "stable.ts"), "export const stable = true;", "utf8");
    const [recorded] = await buildContextSafeFileViews({
      text: "check stable.ts",
      workspaceCwd: root,
      workspaceId: null,
    });

    const [freshness] = await evaluateFileViewFreshness({
      views: [recorded],
      workspaceCwd: root,
    });

    expect(freshness).toEqual({
      relativePath: "stable.ts",
      status: "current",
      recordedContentHash: sha256Of("export const stable = true;"),
      currentContentHash: sha256Of("export const stable = true;"),
    });
  });

  it("flags a view stale when the file content changed after the view was recorded", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-file-views-"));
    tempDirs.push(root);
    const file = path.join(root, "changed.ts");
    await fs.writeFile(file, "original", "utf8");
    const [recorded] = await buildContextSafeFileViews({
      text: "check changed.ts",
      workspaceCwd: root,
      workspaceId: null,
    });
    await fs.writeFile(file, "rewritten", "utf8");

    const [freshness] = await evaluateFileViewFreshness({
      views: [recorded],
      workspaceCwd: root,
    });

    expect(freshness?.status).toBe("stale");
    expect(freshness?.recordedContentHash).toBe(sha256Of("original"));
    expect(freshness?.currentContentHash).toBe(sha256Of("rewritten"));
  });

  it("flags a view missing when the file no longer exists", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-file-views-"));
    tempDirs.push(root);
    const file = path.join(root, "gone.ts");
    await fs.writeFile(file, "bye", "utf8");
    const [recorded] = await buildContextSafeFileViews({
      text: "check gone.ts",
      workspaceCwd: root,
      workspaceId: null,
    });
    await fs.rm(file);

    const [freshness] = await evaluateFileViewFreshness({
      views: [recorded],
      workspaceCwd: root,
    });

    expect(freshness).toEqual({
      relativePath: "gone.ts",
      status: "missing",
      recordedContentHash: sha256Of("bye"),
      currentContentHash: null,
    });
  });

  it("flags a view created when a previously missing file now exists", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-file-views-"));
    tempDirs.push(root);
    const [recorded] = await buildContextSafeFileViews({
      text: "check later.md",
      workspaceCwd: root,
      workspaceId: null,
    });
    expect(recorded?.exists).toBe(false);
    await fs.writeFile(path.join(root, "later.md"), "appeared", "utf8");

    const [freshness] = await evaluateFileViewFreshness({
      views: [recorded],
      workspaceCwd: root,
    });

    expect(freshness?.status).toBe("created");
    expect(freshness?.currentContentHash).toBe(sha256Of("appeared"));
  });

  it("flags a recorded-but-unfingerprinted view unknown", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-file-views-"));
    tempDirs.push(root);
    await fs.writeFile(path.join(root, "present.ts"), "present", "utf8");

    const [freshness] = await evaluateFileViewFreshness({
      views: [{ relativePath: "present.ts", exists: true, contentHash: null }],
      workspaceCwd: root,
    });

    expect(freshness).toEqual({
      relativePath: "present.ts",
      status: "unknown",
      recordedContentHash: null,
      currentContentHash: null,
    });
  });

  it("rejects out-of-workspace paths in recorded views as invalid_path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-file-views-"));
    tempDirs.push(root);

    const freshness = await evaluateFileViewFreshness({
      views: [
        { relativePath: "../../secrets.env", exists: true, contentHash: "deadbeef" },
        { relativePath: "/etc/passwd", exists: true, contentHash: "deadbeef" },
      ],
      workspaceCwd: root,
    });

    expect(freshness).toEqual([
      {
        relativePath: "../../secrets.env",
        status: "invalid_path",
        recordedContentHash: "deadbeef",
        currentContentHash: null,
      },
      {
        relativePath: "/etc/passwd",
        status: "invalid_path",
        recordedContentHash: "deadbeef",
        currentContentHash: null,
      },
    ]);
  });

  it("returns an empty list for non-array or empty recorded views", async () => {
    expect(await evaluateFileViewFreshness({ views: null, workspaceCwd: "/tmp" })).toEqual([]);
    expect(await evaluateFileViewFreshness({ views: {}, workspaceCwd: "/tmp" })).toEqual([]);
    expect(await evaluateFileViewFreshness({ views: [], workspaceCwd: "/tmp" })).toEqual([]);
    expect(
      await evaluateFileViewFreshness({
        views: [{ relativePath: "a.ts", exists: false, contentHash: null }],
        workspaceCwd: null,
      }),
    ).toEqual([]);
  });
});;
