import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildContextSafeFileViews } from "../services/context-safe-file-views.js";

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
      },
      {
        workspaceId: "workspace-1",
        relativePath: "docs/missing.md",
        source: "wake_comment",
        exists: false,
      },
    ]);
  });
});
