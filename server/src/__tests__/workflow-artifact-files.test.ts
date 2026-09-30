import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, symlink, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { captureArtifactRoot, readArtifactBytes } from "../services/workflow/artifact-files.js";
const roots: string[] = [];
async function fixture() { const root = await mkdtemp(path.join(await import("node:fs/promises").then(f => f.realpath(os.tmpdir())), "qa-safe-")); roots.push(root); return root; }
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });
it("reads the bounded exact bytes under a pinned root", async () => {
  const root = await fixture(); await writeFile(path.join(root, "result"), "exact");
  expect((await readArtifactBytes(await captureArtifactRoot(root), "result", 20)).toString()).toBe("exact");
});
it.each(["leaf-link", "parent-link", "fifo", "oversize", "parent-swap", "traversal"])("refuses %s", async mode => {
  const base = await fixture(); const root = path.join(base, "root"); await mkdir(root);
  const snapshot = await captureArtifactRoot(root); let file = "result";
  if (mode === "leaf-link") { await writeFile(path.join(base, "outside"), "x"); await symlink(path.join(base, "outside"), path.join(root, file)); }
  if (mode === "parent-link") { await symlink(base, path.join(root, "link")); file = "link/outside"; await writeFile(path.join(base, "outside"), "x"); }
  if (mode === "fifo") execFileSync("mkfifo", [path.join(root, file)]);
  if (mode === "oversize") await writeFile(path.join(root, file), "123456");
  if (mode === "parent-swap") { await rename(root, `${root}-old`); await mkdir(root); await writeFile(path.join(root, file), "x"); }
  if (mode === "traversal") file = "../outside";
  await expect(readArtifactBytes(snapshot, file, 5)).rejects.toThrow();
}, 5000);
