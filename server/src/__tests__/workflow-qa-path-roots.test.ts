import { mkdtemp, realpath, rm, mkdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { evaluateQaRules } from "../services/workflow/qa-rules.js";
import { resolveQaInternalPathRoots } from "../services/workflow/qa-internal-paths.js";

const base = { provenanceValid: true, resultValid: true };
afterEach(() => vi.unstubAllEnvs());
// Generic path patterns reject tutorial examples; only runtime-owned roots are sensitive.
it.each(["~/.x/y", "~/.claude/skills/example", "/Users/username/.local/bin/uv", "/srv/tutorial/file"])(
  "allows tutorial paths unrelated to known runtime roots: %s", async text => {
    expect((await evaluateQaRules({ ...base, json: { text }, internalPathRoots: ["/runtime/private"] })).ok).toBe(true);
  });
it.each(["/runtime/private/output.json", "(/runtime/private)", '<p>&#47;runtime/private/output.json</p>',
  '<img src="/runtime/private/image.png">'])("rejects a known root in text or decoded HTML: %s", async text => {
  const result = await evaluateQaRules({ ...base, json: { text }, internalPathRoots: ["/runtime/private"] });
  expect(result.checks.find(c => c.id === "no-sensitive-data")?.ok).toBe(false);
});
it("matches root boundaries and escapes root punctuation without rejecting web URLs", async () => {
  for (const text of ["/runtime/private-other/a", "https://example.org/runtime/private/a", "/runtime/axb/a"]) {
    expect((await evaluateQaRules({ ...base, json: { text }, internalPathRoots: ["/runtime/private", "/runtime/a.b"] })).ok).toBe(true);
  }
});
it.each(["file:///unavailable/root", String.raw`C:\private\result`, String.raw`\\host\share\result`,
  "-----BEGIN PRIVATE KEY-----", "Bearer synthetic-token-value", "password=synthetic-value"])(
  "retains portable path and secret rejection even without roots: %s", async text => {
    expect((await evaluateQaRules({ ...base, json: { text } })).checks.find(c => c.id === "no-sensitive-data")?.ok).toBe(false);
  });
it("retains sensitive-key detection", async () => {
  expect((await evaluateQaRules({ ...base, json: { access_token: "synthetic" } })).ok).toBe(false);
});
it("resolves attempt, temporary, configured home/instance/storage roots and symlink real paths", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "qa-roots-")));
  try {
    const home = path.join(root, "runtime"), output = path.join(root, "output"), alias = path.join(root, "alias");
    await mkdir(output); await symlink(output, alias);
    vi.stubEnv("PAPERCLIP_HOME", home); vi.stubEnv("PAPERCLIP_INSTANCE_ID", "synthetic");
    vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", path.join(root, "storage"));
    const roots = await resolveQaInternalPathRoots([alias, path.join(output, "mission", "step", "attempt")]);
    for (const expected of [alias, output, home, path.join(home, "instances", "synthetic"),
      path.join(root, "storage"), os.tmpdir(), await realpath(os.tmpdir())]) {
      expect(roots).toContain(expected);
      const result = await evaluateQaRules({ ...base, json: { text: path.join(expected, "leaked.txt") }, internalPathRoots: roots });
      expect(result.checks.find(c => c.id === "no-sensitive-data")?.ok).toBe(false);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
