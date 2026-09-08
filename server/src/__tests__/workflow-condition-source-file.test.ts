import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { readBoundedJsonFile } from "../services/workflow/control-flow/condition-source-file.js";
let root: string;
beforeAll(async () => { root = await mkdtemp(path.join(tmpdir(), "exact-if-reader-")); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
test("hash covers exact raw bytes, not normalized JSON or UTF8 re-encoding", async () => {
  const file = path.join(root, "result.json"), raw = Buffer.from('{ "value": "한글", "number": 2.0 }\n');
  await writeFile(file, raw);
  expect(await readBoundedJsonFile(file, "result", hash(raw))).toEqual({ value: "한글", number: 2 });
  const normalized = Buffer.from(JSON.stringify(JSON.parse(raw.toString())));
  await expect(readBoundedJsonFile(file, "result", hash(normalized)))
    .rejects.toThrow("does not match its verified hash");
});
test("regular/no-follow reader rejects directories and symlink files without paths in diagnostics", async () => {
  const target = path.join(root, "target.json"), link = path.join(root, "link.json");
  await writeFile(target, "{}"); await symlink(target, link);
  for (const file of [root, link]) {
    try { await readBoundedJsonFile(file, "result"); throw new Error("expected rejection"); }
    catch (error) {
      expect((error as Error).message).toMatch(/^Workflow IF condition failed:/);
      expect((error as Error).message).not.toContain(root);
    }
  }
});
test.each(["oversized", "invalid-utf8", "invalid-json"])("same-buffer reader retains %s rejection", async kind => {
  const file = path.join(root, kind);
  const raw = kind === "oversized" ? Buffer.alloc(1024 * 1024 + 1) : kind === "invalid-utf8" ? Buffer.from([0xff]) : Buffer.from("{");
  await writeFile(file, raw);
  await expect(readBoundedJsonFile(file, "result", hash(raw))).rejects.toThrow("Workflow IF condition failed:");
});
