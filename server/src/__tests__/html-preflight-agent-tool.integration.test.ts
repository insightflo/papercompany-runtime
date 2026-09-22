import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentToolGrants, agents, companies, createDb, toolDefinitions } from "@paperclipai/db";
import { grantWorkflowToolToAgent } from "../services/workflow/tool-catalog.js";
import { executeCoreWorkflowTool } from "../services/workflow/core-tool-executor.js";
import { seedHtmlPreflightTool } from "../services/judgment/html-preflight-tool.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport().catch((error: unknown) => ({
  supported: false,
  reason: error instanceof Error ? error.message : String(error),
}));
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn("Skipping html-preflight tool tests: " + (support.reason ?? "unsupported"));

describeEP("html-preflight builtin workflow tool", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const agentId = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("html-preflight-tool-");
    db = createDb(tempDb!.connectionString);
    await db.insert(companies).values([
      { id: companyId, name: "HTML Preflight Co", status: "active", issuePrefix: "HPC1" },
      { id: otherCompanyId, name: "Other HTML Preflight Co", status: "active", issuePrefix: "HPC2" },
    ]);
    const firstSeed = await seedHtmlPreflightTool(db);
    const secondSeed = await seedHtmlPreflightTool(db);
    expect(firstSeed).toEqual({ companies: 2, toolsSeeded: 2 });
    expect(secondSeed).toEqual({ companies: 2, toolsSeeded: 0 });
    await db.insert(agents).values({ id: agentId, companyId, name: "html-preflight-agent", status: "idle" });
  }, 120_000);

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  it("seeds one enabled builtin tool per company without grants", async () => {
    const rows = await db.select().from(toolDefinitions).where(eq(toolDefinitions.name, "html-preflight"));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.adapterType === "builtin"
      && row.adapterConfig?.kind === "html-preflight"
      && row.enabled)).toBe(true);
    expect(await db.select().from(agentToolGrants)).toHaveLength(0);
  });

  it("dispatches the deterministic executor for a granted agent", async () => {
    await grantWorkflowToolToAgent(db, { companyId, agentId, toolName: "html-preflight", grantedBy: "test-board" });
    const result = await executeCoreWorkflowTool({
      db,
      companyId,
      agentId,
      toolName: "html-preflight",
      parameters: { document: "<html><body><p>판단 게이트 사전 점검을 위한 정상 문서입니다. 구조는 온전합니다.</p></body></html>" },
      requestId: randomUUID(),
    });

    expect(result.status).toBe(200);
    expect(result.body.data).toMatchObject({ ok: true, findings: [] });
  });

  it("keeps the agent identity guard outside workflow step context", async () => {
    const result = await executeCoreWorkflowTool({
      db,
      companyId,
      agentId: null,
      toolName: "html-preflight",
      parameters: { document: "<html><body><p>ready</p></body></html>" },
      requestId: randomUUID(),
    });

    expect(result.status).toBe(403);
    expect(result.body.error).toContain("Agent identity is required");
  });
});
