import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@paperclipai/db";
import { executeCoreWorkflowTool } from "../services/workflow/core-tool-executor.js";
import { policy, progressDatabase, progressTool } from "./helpers/tool-progress.js";

let fixture: Awaited<ReturnType<typeof progressDatabase>>;
beforeAll(async () => { fixture = await progressDatabase(); }, 60_000);
afterAll(async () => { await fixture?.cleanup(); });
const child = (mode: string) => `
  const fs = require('node:fs');
  const id = process.env.PAPERCOMPANY_TOOL_EXECUTION_ID;
  if (!id || process.env.PAPERCOMPANY_TOOL_PROGRESS_FD !== '3') process.exit(8);
  let count = 0;
  const report = () => fs.writeSync(3, JSON.stringify({version:1,executionId:id,sequence:++count,stage:'copy',unit:'items',current:count})+'\\n');
  report();
  const timer = setInterval(report, 1100);
  if ('${mode}' === 'idle') clearInterval(timer);
  setTimeout(() => { clearInterval(timer); console.log(JSON.stringify({ok:true})); }, ${mode === "success" ? 3400 : 10000});
`;
describe("real fd3 child progress", () => {
  it.each(["success", "idle", "max"])("handles %s without treating progress as output", async (mode) => {
    const scope = await progressTool(fixture.db, "builtin", {
      command: process.execPath, progress: { ...policy, maxDurationMs: mode === "max" ? 3000 : 15000 },
      env: { PAPERCOMPANY_TOOL_EXECUTION_ID: "cannot-override", PAPERCOMPANY_TOOL_PROGRESS_FD: "9" },
    });
    const result = await executeCoreWorkflowTool({ db: fixture.db, ...scope, parameters: ["-e", child(mode)] });
    expect(result.status).toBe(mode === "success" ? 200 : 500);
    if (mode === "success") expect(result.body.data).toEqual({ ok: true });
    else expect(result.body.error).toMatch(/tool_progress_(idle|max)_timeout/);
    const [row] = await fixture.reader.select().from(schema.toolExecutionHeartbeats)
      .where(eq(schema.toolExecutionHeartbeats.toolId, scope.toolId));
    expect(row.state).toBe(mode === "success" ? "succeeded" : "timed_out");
    expect(row.current).toBeGreaterThanOrEqual(mode === "idle" ? 1 : 3);
  }, 20_000);
});
