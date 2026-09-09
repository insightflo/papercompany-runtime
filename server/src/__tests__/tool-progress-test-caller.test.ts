import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { toolDefinitions, toolExecutionHeartbeats } from "@paperclipai/db";
import { executeToolTest } from "../services/tools/test-executor.js";
import { event, httpConfig, policy, progressDatabase, progressTool } from "./helpers/tool-progress.js";
import { httpFixtures } from "./helpers/tool-progress-http.js";

let fixture: Awaited<ReturnType<typeof progressDatabase>>;
const http = httpFixtures();
beforeAll(async () => { fixture = await progressDatabase(); }, 60_000);
afterAll(async () => { await http.close(); await fixture?.cleanup(); });

describe("board test caller real DB/HTTP integration", () => {
  it("supplies HTTP progress DB context and creates an unscoped execution row", async () => {
    const callbackBaseUrl = await http.callback(fixture.db);
    const service = express(); let receipt: unknown; let producerError: unknown; let id = "";
    service.post("/tool", async (req, res) => {
      try {
        id = req.header("X-Papercompany-Execution-Id")!;
        const response = await fetch(req.header("X-Papercompany-Progress-Url")!, { method: "POST", headers: {
          "Content-Type": "application/json", "X-Papercompany-Progress-Token": req.header("X-Papercompany-Progress-Token")!,
        }, body: JSON.stringify(event(id)) });
        receipt = { status: response.status, body: await response.json() };
        res.json({ result: { ok: true } });
      } catch (error) { producerError = error; res.status(500).end(); }
    });
    const url = await http.listen(service);
    const adapterConfig = { ...httpConfig, url: `${url}/tool`, allowInsecureUrl: true, progress: policy };
    const scope = await progressTool(fixture.db, "http", adapterConfig);
    const [saved] = await fixture.db.select().from(toolDefinitions).where(eq(toolDefinitions.id, scope.toolId));
    const result = await executeToolTest({ db: fixture.db, companyId: scope.companyId,
      tool: { ...saved, description: saved.description ?? "", inputSchema: saved.inputSchema ?? {}, adapterType: "http", adapterConfig }, input: {},
      deps: { callbackBaseUrl, resolveSecretValue: async () => "fixture-auth" },
    });
    expect(producerError).toBeUndefined(); expect(result).toMatchObject({ ok: true, status: "success", httpStatus: 200, result: { ok: true } });
    expect(receipt).toEqual({ status: 200, body: { accepted: true } });
    const [row] = await fixture.reader.select().from(toolExecutionHeartbeats).where(eq(toolExecutionHeartbeats.id, id));
    expect(row).toMatchObject({ companyId: scope.companyId, toolId: scope.toolId, state: "succeeded", sequence: 1,
      workflowRunId: null, stepId: null, stepRunId: null, executionGeneration: null, retryCount: null, iterationIndex: null });
    expect(row.requestId).toMatch(/^tool-test-/); expect(JSON.stringify(result)).not.toContain(row.tokenHash!);
  });
});
