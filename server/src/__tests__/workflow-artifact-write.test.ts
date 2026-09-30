import { mkdtemp, mkdir, readdir, readFile, readlink, rename, rm, symlink, realpath, writeFile } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { captureArtifactRoot } from "../services/workflow/artifact-files.js";
import { createArtifactDirectory } from "../services/workflow/artifact-writer.js";
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) { execFileSync("chmod", ["-R", "u+w", root]); await rm(root, { recursive: true, force: true }); } });
async function fixture() {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), "artifact-write-"))); roots.push(temp);
  const base = path.join(temp, "base"), outside = path.join(temp, "outside"); await mkdir(base); await mkdir(outside);
  return { temp, base, outside, root: await captureArtifactRoot(base) };
}
it("writes exact bytes and exclusively owns the final directory", async () => {
  const f = await fixture(), bytes = Buffer.from([0, 128, 255]);
  const root = await createArtifactDirectory(f.root, "runs/qa/attempt", [{ relative: "input/content.json", bytes }], ["input/assets", "input"]);
  expect(await readFile(path.join(root.path, "input/content.json"))).toEqual(bytes);
  await expect(createArtifactDirectory(f.root, "runs/qa/attempt", [], [])).rejects.toThrow();
});
it("does not follow a symlink in an existing parent", async () => {
  const f = await fixture(); await symlink(f.outside, path.join(f.base, "runs"));
  await expect(createArtifactDirectory(f.root, "runs/qa/attempt", [], [])).rejects.toThrow();
  expect(await readdir(f.outside)).toEqual([]);
});
it("rejects a root replaced after capture without an external write", async () => {
  const f = await fixture(); await rename(f.base, f.base + "-pinned"); await symlink(f.outside, f.base);
  await expect(createArtifactDirectory(f.root, "attempt", [], [])).rejects.toThrow();
  expect(await readdir(f.outside)).toEqual([]);
});
it.each(["before-entry", "after-entry"] as const)(
  "contains writes when an external process swaps an ancestor %s", async (boundary) => {
    const f = await fixture();
    const runs = path.join(f.base, "runs"), pinned = path.join(f.base, "pinned");
    await mkdir(runs);
    // Delay only a real OS launch: no writer logic or filesystem operation is mocked.
    // Before entry, the opened inode and child's cwd disagree and must be rejected.
    // After entry, the child owns its cwd and must write into the renamed directory.
    const preload = path.join(f.temp, "swap-at-launch.cjs");
    const swapProgram = `
      const fs = require('node:fs');
      fs.renameSync(${JSON.stringify(runs)}, ${JSON.stringify(pinned)});
      fs.symlinkSync(${JSON.stringify(f.outside)}, ${JSON.stringify(runs)});
    `;
    await writeFile(preload, `
      const cp = require('node:child_process');
      const launch = cp.spawnSync;
      cp.spawnSync = function(command, args, options) {
        if (process.cwd() === ${JSON.stringify(boundary === "before-entry" ? f.base : runs)}
            && options.cwd === ${JSON.stringify(boundary === "before-entry" ? "runs" : "qa")}) {
          // Synchronous join: swap failure propagates, and no background task survives.
          cp.execFileSync(process.execPath, ['-e', ${JSON.stringify(swapProgram)}], {
            env: {...process.env, NODE_OPTIONS: ''}, timeout: 5000,
          });
        }
        return launch.call(this, command, args, options);
      };
    `);
    const { spawn: launch } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const spy = vi.mocked(spawn).mockImplementationOnce((command, args, options) =>
      launch(command, args as readonly string[], { ...options,
        env: { ...process.env, NODE_OPTIONS: `--require=${JSON.stringify(preload)}` },
      }));
    try {
      const write = createArtifactDirectory(f.root, "runs/qa/attempt", [
        { relative: "input/a", bytes: Buffer.from("verified") },
      ], []);
      if (boundary === "before-entry") {
        await expect(write).rejects.toThrow("artifact_root_replaced");
      } else {
        await write;
        expect(await readFile(path.join(pinned, "qa/attempt/input/a"), "utf8")).toBe("verified");
      }
      expect(await readlink(runs)).toBe(f.outside);
    } finally {
      spy.mockImplementation(launch);
      expect(await readdir(f.outside)).toEqual([]);
    }
  },
);
