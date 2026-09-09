import { createServer, type Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@paperclipai/db";
import { toolDefinitionRoutes } from "../routes/tool-definitions.js";
import { executeHttpWorkflowTool } from "../services/workflow/http-tool-adapter.js";
import { httpConfig, policy, progressDatabase, progressTool } from "./helpers/tool-progress.js";

let fixture: Awaited<ReturnType<typeof progressDatabase>>;
const servers: Server[] = [];
async function listen(app: express.Express) {
  const server = createServer(app); servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return `http://127.0.0.1:${address.port}`;
}
beforeAll(async () => { fixture = await progressDatabase(); }, 60_000);
afterAll(async () => {
  for (const server of servers) await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  await fixture?.cleanup();
});
describe("real HTTP progress callback", () => {
  it.each(["success", "idle", "max"])("handles %s while the final HTTP response stays open", async (mode) => {
    const callback = express();
    callback.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
    callback.use("/api", toolDefinitionRoutes(fixture.db));
    const callbackBaseUrl = await listen(callback);
    const service = express();
    const receipts: number[] = [];
    let executionId = "";
    let count = 0;
    let producerError = false;
    service.post("/tool", async (req, res) => {
      executionId = req.header("X-Papercompany-Execution-Id") ?? "";
      const url = req.header("X-Papercompany-Progress-Url");
      const token = req.header("X-Papercompany-Progress-Token");
      if (!url || !token) { res.status(400).json({ error: "missing progress headers" }); return; }
      const report = async () => {
        try {
          const response = await fetch(url, { method: "POST", headers: {
            "Content-Type": "application/json", "X-Papercompany-Progress-Token": token,
          }, body: JSON.stringify({ version: 1, executionId, sequence: ++count, stage: "copy", unit: "items", current: count }) });
          receipts.push(response.status);
        } catch { producerError = true; }
      };
      await report();
      const timer = mode === "idle" ? undefined : setInterval(() => void report(), 1100);
      const finish = setTimeout(() => res.json({ result: { ok: true } }), mode === "success" ? 3400 : 10000);
      res.on("close", () => { clearInterval(timer); clearTimeout(finish); });
    });
    const serviceUrl = await listen(service);
    const scope = await progressTool(fixture.db, "http");
    const result = await executeHttpWorkflowTool({ ...scope, parameters: {}, adapterConfig: {
      ...httpConfig, url: `${serviceUrl}/tool`, allowInsecureUrl: true,
      progress: { ...policy, maxDurationMs: mode === "max" ? 3000 : 15000 },
    } }, { resolveSecretValue: async () => "fixture-auth", progress: { db: fixture.db, toolId: scope.toolId, callbackBaseUrl } });
    expect(result.status).toBe(mode === "success" ? 200 : 500);
    if (mode === "success") expect(result.body.data).toEqual({ ok: true });
    else expect(result.body.error).toMatch(/tool_progress_(idle|max)_timeout/);
    expect(producerError).toBe(false);
    expect(receipts.filter((status) => status === 200).length).toBeGreaterThanOrEqual(mode === "idle" ? 1 : 3);
    const [row] = await fixture.reader.select().from(schema.toolExecutionHeartbeats).where(eq(schema.toolExecutionHeartbeats.id, executionId));
    expect(row.state).toBe(mode === "success" ? "succeeded" : "timed_out");
    expect(row.tokenHash).toMatch(/^[a-f0-9]{64}$/);
  }, 20_000);
});
