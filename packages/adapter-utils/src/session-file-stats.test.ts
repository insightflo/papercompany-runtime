import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { countSessionFileMessages } from "./session-file-stats.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function writeSessionFile(lines: unknown[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-session-stats-"));
  tempDirs.push(dir);
  const file = path.join(dir, "session.jsonl");
  await fs.writeFile(file, lines.map((line) => JSON.stringify(line)).join("\n"), "utf8");
  return file;
}

describe("countSessionFileMessages", () => {
  it("counts only top-level message entries in a pi session file", async () => {
    const file = await writeSessionFile([
      { type: "session", id: "s1" },
      { type: "message", id: "m1", role: "user" },
      { type: "message", id: "m2", role: "assistant" },
      { type: "model_change", id: "mc1" },
      { type: "message", id: "m3", role: "user" },
    ]);
    expect(await countSessionFileMessages(file)).toBe(3);
  });

  it("ignores malformed lines instead of failing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-session-stats-"));
    tempDirs.push(dir);
    const file = path.join(dir, "session.jsonl");
    await fs.writeFile(
      file,
      [
        JSON.stringify({ type: "message", id: "m1" }),
        "not-json{",
        "",
        JSON.stringify({ type: "message", id: "m2" }),
      ].join("\n"),
      "utf8",
    );
    expect(await countSessionFileMessages(file)).toBe(2);
  });

  it("returns 0 for an empty session file", async () => {
    const file = await writeSessionFile([]);
    expect(await countSessionFileMessages(file)).toBe(0);
  });

  it("returns null for non-file session ids and missing files", async () => {
    expect(await countSessionFileMessages("provider-session-abc")).toBeNull();
    expect(await countSessionFileMessages("ses_abc123")).toBeNull();
    expect(await countSessionFileMessages("/tmp/does-not-exist-session.jsonl")).toBeNull();
    expect(await countSessionFileMessages("")).toBeNull();
  });

  it("streams session files larger than 20 MB instead of skipping the message cap", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-session-stats-"));
    tempDirs.push(dir);
    const file = path.join(dir, "large-session.jsonl");
    const filler = `${JSON.stringify({ type: "note", body: "x".repeat(1_000) })}\n`;
    const handle = await fs.open(file, "w");
    try {
      await handle.write(`${JSON.stringify({ type: "message", id: "first" })}\n`);
      for (let index = 0; index < 21_000; index += 1) await handle.write(filler);
      await handle.write(`${JSON.stringify({ type: "message", id: "last" })}\n`);
    } finally {
      await handle.close();
    }
    expect((await fs.stat(file)).size).toBeGreaterThan(20 * 1024 * 1024);
    expect(await countSessionFileMessages(file)).toBe(2);
  });
});
