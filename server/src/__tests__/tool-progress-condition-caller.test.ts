import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { toolExecutionHeartbeats } from "@paperclipai/db";
import { executeWorkflowConditionToolSource } from "../services/workflow/control-flow/condition-tool-source.js";
import { httpConfig, policy, progressDatabase, progressTool } from "./helpers/tool-progress.js";

let fixture: Awaited<ReturnType<typeof progressDatabase>>;
beforeAll(async () => { fixture = await progressDatabase(); }, 60_000);
afterAll(async () => { await fixture?.cleanup(); });

describe("condition caller with real DB and injected fetch", () => {
  it("removes saved progress, schedules fixed 30s deadline, sends no capability and creates no row", async () => {
    const scope = await progressTool(fixture.db, "http", { ...httpConfig, timeoutMs: 900_000, progress: policy });
    let headers: Headers | undefined;
    const timer = vi.spyOn(globalThis, "setTimeout");
    try {
      const result = await executeWorkflowConditionToolSource({ db: fixture.db, companyId: scope.companyId,
        runId: randomUUID(), ifStepId: "if", workflowSteps: [{ id: "if" }],
        source: { kind: "tool_json", stepId: "if", toolName: scope.toolName, parameters: {}, path: "$.ok" },
        deps: { resolveSecretValue: async () => "fixture-auth", fetchImpl: async (_url, init) => {
          headers = new Headers(init?.headers); return Response.json({ result: { ok: true } });
        } },
      });
      expect(result).toEqual({ ok: true });
      const delays = timer.mock.calls.map((call) => call[1]);
      expect(delays).toContain(30_000); expect(delays).not.toContain(900_000);
      expect(headers?.has("X-Papercompany-Progress-Token")).toBe(false);
      expect(headers?.has("X-Papercompany-Execution-Id")).toBe(false);
      expect(await fixture.reader.select().from(toolExecutionHeartbeats).where(eq(toolExecutionHeartbeats.toolId, scope.toolId))).toEqual([]);
    } finally { timer.mockRestore(); }
  });
});
