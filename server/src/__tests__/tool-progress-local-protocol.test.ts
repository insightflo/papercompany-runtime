import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { toolExecutionHeartbeats as table } from "@paperclipai/db";
import { executeLocalToolWithProgress } from "../services/workflow/local-tool-progress-executor.js";
import { policy, progressDatabase, progressTool } from "./helpers/tool-progress.js";

let fixture: Awaited<ReturnType<typeof progressDatabase>>;
beforeAll(async () => { fixture = await progressDatabase(); }, 60_000);
afterAll(async () => { await fixture?.cleanup(); });
const prelude = `const fs = require('node:fs');
const id = process.env.PAPERCOMPANY_TOOL_EXECUTION_ID;
const event = (sequence, current, stage = 'copy') => ({version:1,executionId:id,sequence,stage,unit:'items',current});
const report = (sequence, current) => fs.writeSync(3, JSON.stringify(event(sequence, current)) + '\\n');`;
async function run(script: string, overrides: { executable?: string; idleTimeoutMs?: number } = {}) {
  const scope = await progressTool(fixture.db);
  const started = Date.now();
  const result = await executeLocalToolWithProgress({ db: fixture.db, scope,
    policy: { ...policy, idleTimeoutMs: overrides.idleTimeoutMs ?? 1000, maxDurationMs: 8000 },
    executable: overrides.executable ?? process.execPath, args: ["-e", prelude + script], cwd: process.cwd(),
    env: { ...process.env, PAPERCOMPANY_TOOL_EXECUTION_ID: "spoofed", PAPERCOMPANY_TOOL_PROGRESS_FD: "99" },
  }).then((value) => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
  const elapsed = Date.now() - started;
  const [row] = await fixture.reader.select().from(table).where(eq(table.toolId, scope.toolId));
  return { ...result, row, elapsed };
}

describe("real child fd3 protocol and output preservation", () => {
  it.each(["stdout", "same-count"])("%s activity cannot reset idle", async (mode) => {
    const r = await run(mode === "stdout"
      ? `setInterval(() => console.log(JSON.stringify(event(999,999))), 100);`
      : `report(1,1); let sequence=1; setInterval(() => report(++sequence,1), 100);`);
    expect(r.error).toMatchObject({ reason: "tool_progress_idle_timeout" });
    expect(r.elapsed).toBeLessThan(4000); expect(r.row.state).toBe("timed_out");
    expect(r.row.sequence).toBe(mode === "stdout" ? 0 : 1);
    if (mode === "stdout") expect(r.row.lastProgressAt).toEqual(r.row.startedAt);
  }, 10_000);

  it("handles split UTF8 and JSON frames without corrupting subsequent valid events", async () => {
    const r = await run(`
      const unicode = Buffer.from(JSON.stringify(event(1,1,'복사'))+'\\n');
      const split = unicode.indexOf(Buffer.from('복')) + 1;
      fs.writeSync(3,unicode.subarray(0,split));
      setTimeout(() => {
        fs.writeSync(3,unicode.subarray(split));
        const valid = Buffer.from(JSON.stringify(event(1,1))+'\\n');
        fs.writeSync(3,valid.subarray(0,17));
        setTimeout(() => { fs.writeSync(3,valid.subarray(17)); console.log('완료'); }, 30);
      }, 30);
    `, { idleTimeoutMs: 2500 });
    expect(r.error).toBeUndefined(); expect(r.value?.stdout).toBe("완료\n");
    // Unicode is valid framing, but undeclared stage is not progress authority.
    expect(r.row).toMatchObject({ state: "succeeded", sequence: 1, current: 1, stageIndex: 0 });
  });

  it.each(["malformed", "oversized", "incomplete", "invalid-utf8"])("%s fd3 record fails bounded", async (mode) => {
    const payload = mode === "malformed" ? `fs.writeSync(3, '{bad}\\n'); setInterval(() => {},100);`
      : mode === "oversized" ? `fs.writeSync(3, 'x'.repeat(4097)); setInterval(() => {},100);`
      : mode === "invalid-utf8" ? `fs.writeSync(3, Buffer.from([0xff,10])); setInterval(() => {},100);`
      : `fs.writeSync(3, JSON.stringify(event(1,1)));`;
    const r = await run(payload, { idleTimeoutMs: 2500 });
    expect(r.error).toMatchObject({ reason: "tool_progress_protocol_error" });
    expect(r.elapsed).toBeLessThan(4000); expect(r.row.state).toBe("failed"); expect(r.row.sequence).toBe(0);
  }, 10_000);

  it("nonzero exit is failure despite accepted progress and preserves final streams", async () => {
    const r = await run(`report(1,1); console.log('final output'); console.error('final diagnostic');
      setTimeout(() => { process.exitCode=7; }, 100);`, { idleTimeoutMs: 2500 });
    expect(r.error).toMatchObject({ reason: "tool_progress_child_failed", code: 7, stdout: "final output\n", stderr: "final diagnostic\n" });
    expect(r.row).toMatchObject({ state: "failed", sequence: 1, current: 1 });
  });

  it("successful exit drains stdout/stderr/fd3 and overrides reserved environment identity", async () => {
    const r = await run(`
      if (id==='spoofed' || process.env.PAPERCOMPANY_TOOL_PROGRESS_FD!=='3') process.exit(8);
      report(1,1);
      process.stdout.end('o'.repeat(256*1024)+'완료');
      process.stderr.end('e'.repeat(256*1024)+'진단');
    `, { idleTimeoutMs: 2500 });
    expect(r.error).toBeUndefined();
    expect(r.value?.stdout).toBe("o".repeat(256 * 1024) + "완료");
    expect(r.value?.stderr).toBe("e".repeat(256 * 1024) + "진단");
    expect(r.row).toMatchObject({ state: "succeeded", sequence: 1, current: 1 });
  });

  it("spawn failure settles owned lifecycle without waiting for an exit event", async () => {
    const r = await run("", { executable: "/nonexistent/tool-progress-fixture-executable" });
    expect(r.error).toMatchObject({ reason: "tool_progress_child_error" });
    expect(r.elapsed).toBeLessThan(2000); expect(r.row.state).toBe("failed");
  });
});
