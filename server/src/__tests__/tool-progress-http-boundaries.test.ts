import express from "express";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, toolExecutionHeartbeats as table } from "@paperclipai/db";
import { executeHttpWorkflowTool } from "../services/workflow/http-tool-adapter.js";
import { event, httpConfig, policy, progressDatabase, progressTool } from "./helpers/tool-progress.js";
import { httpFixtures } from "./helpers/tool-progress-http.js";

let fixture: Awaited<ReturnType<typeof progressDatabase>>;
const http = httpFixtures();
beforeAll(async () => { fixture = await progressDatabase(); }, 60_000);
afterEach(async () => { await http.close(); });
afterAll(async () => { await fixture?.cleanup(); });
const read = async (toolId: string) => (await fixture.reader.select().from(table).where(eq(table.toolId, toolId)))[0];

describe("HTTP progress transport boundaries with real local fixtures", () => {
  it("rejects redirect and never forwards capability to the second server", async () => {
    const callbackBaseUrl = await http.callback(fixture.db);
    let targetHits = 0; let token = "";
    const target = express(); target.all("/target", (_req, res) => { targetHits++; res.json({ result: {} }); });
    const targetUrl = await http.listen(target);
    const source = express(); source.post("/tool", (req, res) => {
      token = req.header("X-Papercompany-Progress-Token") ?? "";
      res.redirect(307, `${targetUrl}/target`);
    });
    const sourceUrl = await http.listen(source); const scope = await progressTool(fixture.db, "http");
    const result = await executeHttpWorkflowTool({ ...scope, parameters: {}, adapterConfig: {
      ...httpConfig, url: `${sourceUrl}/tool`, allowInsecureUrl: true, progress: policy,
    } }, { resolveSecretValue: async () => "fixture-auth", progress: { db: fixture.db, toolId: scope.toolId, callbackBaseUrl } });
    expect(result.status).toBe(500); expect(targetHits).toBe(0); expect(token).toHaveLength(64);
    expect(JSON.stringify(result)).not.toContain(token); expect((await read(scope.toolId)).state).toBe("failed");
  });

  it.each(["envelope", "assertion"])("healthy callbacks do not make invalid final %s successful", async (mode) => {
    const callbackBaseUrl = await http.callback(fixture.db);
    const receipts: number[] = []; let producerError: unknown; let token = "";
    const service = express();
    service.post("/tool", async (req, res) => {
      try {
        const id = req.header("X-Papercompany-Execution-Id")!;
        token = req.header("X-Papercompany-Progress-Token")!;
        for (let n = 1; n <= 3; n++) {
          if (n > 1) await new Promise((resolve) => setTimeout(resolve, 1100));
          const response = await fetch(req.header("X-Papercompany-Progress-Url")!, { method: "POST",
            headers: { "Content-Type": "application/json", "X-Papercompany-Progress-Token": token }, body: JSON.stringify(event(id, n)),
          });
          receipts.push(response.status); await response.text();
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
        res.json(mode === "envelope" ? { notResult: {} } : { result: { ok: false } });
      } catch (error) { producerError = error; res.status(500).end(); }
    });
    const url = await http.listen(service); const scope = await progressTool(fixture.db, "http");
    const result = await executeHttpWorkflowTool({ ...scope, parameters: {}, adapterConfig: {
      ...httpConfig, url: `${url}/tool`, allowInsecureUrl: true, progress: policy,
      response: { resultField: "result", assertions: [{ field: "ok", equals: true }] },
    } }, { resolveSecretValue: async () => "fixture-auth", progress: { db: fixture.db, toolId: scope.toolId, callbackBaseUrl } });
    expect(producerError).toBeUndefined(); expect(receipts).toEqual([200, 200, 200]);
    expect(result.status).toBe(500);
    expect(result.body.error).toContain(mode === "envelope" ? "missing required fields" : "response contract violated");
    expect(await read(scope.toolId)).toMatchObject({ state: "failed", current: 3, sequence: 3 });
    expect(JSON.stringify(result)).not.toContain(token);
    const audit = await fixture.reader.select().from(activityLog).where(eq(activityLog.companyId, scope.companyId));
    expect(JSON.stringify(audit)).not.toContain(token);
  }, 15_000);

  it.each([[200, false], [500, false], [200, true], [500, true]] as const)("bounds real stalled body status=%s progress=%s", async (status, progress) => {
    const callbackBaseUrl = await http.callback(fixture.db);
    const service = express(); service.post("/tool", (_req, res) => {
      res.status(status).setHeader("Content-Type", "application/json"); res.flushHeaders(); res.write('{"partial":');
    });
    const url = await http.listen(service); const scope = await progressTool(fixture.db, "http");
    const started = Date.now();
    const result = await executeHttpWorkflowTool({ ...scope, parameters: {}, adapterConfig: {
      ...httpConfig, url: `${url}/tool`, allowInsecureUrl: true, timeoutMs: 1000,
      ...(progress ? { progress: { ...policy, idleTimeoutMs: 1000 } } : {}),
    } }, { resolveSecretValue: async () => "fixture-auth", progress: { db: fixture.db, toolId: scope.toolId, callbackBaseUrl } });
    expect(Date.now() - started).toBeLessThan(4000); expect(result.status).toBe(500);
    expect(result.body.error).toContain(progress ? "tool_progress_idle_timeout" : "timed out");
    if (progress) expect((await read(scope.toolId)).state).toBe("timed_out");
    else expect(await read(scope.toolId)).toBeUndefined();
  }, 10_000);

  it("late abort-ignoring injected response cannot publish an artifact or overwrite terminal DB", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tool-progress-late-artifact-"));
    const scope = await progressTool(fixture.db, "http");
    let resolve!: (response: Response) => void; let signal: AbortSignal | null | undefined;
    const delayed = new Promise<Response>((yes) => { resolve = yes; });
    try {
      const result = await executeHttpWorkflowTool({ ...scope, parameters: {}, stepOutputDir: dir, adapterConfig: {
        ...httpConfig, progress: { ...policy, idleTimeoutMs: 1000 }, response: { resultField: "result", artifactField: "artifact",
          artifactFileName: "late.json", artifactPathResultField: "path" },
      } }, { resolveSecretValue: async () => "fixture-auth",
        fetchImpl: async (_url, init) => { signal = init?.signal; return delayed; },
        progress: { db: fixture.db, toolId: scope.toolId, callbackBaseUrl: "http://127.0.0.1:1" },
      });
      expect(result.status).toBe(500); expect(signal?.aborted).toBe(true);
      const before = await read(scope.toolId); expect(before.state).toBe("timed_out");
      resolve(Response.json({ result: { ok: true }, artifact: { late: true } }));
      await new Promise((yes) => setTimeout(yes, 50));
      expect(await readdir(dir)).toEqual([]); expect(await read(scope.toolId)).toEqual(before);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 10_000);
});
