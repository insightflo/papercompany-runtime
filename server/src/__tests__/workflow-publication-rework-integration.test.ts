import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { agents, agentToolGrants, companies, toolDefinitions } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { workflowService } from "../services/workflow/engine.js";
import { setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";
import { createQualityTestDb, describeQualityDb } from "./helpers/quality-db.js";
import { publicationTools } from "./helpers/mission-publication-fixture.js";

// Definition writes do not dispatch work; run/queue/CAS paths are deliberately untouched.
describeQualityDb("general workflow publication rework", () => {
  let fixture: Awaited<ReturnType<typeof createQualityTestDb>>;
  beforeAll(async () => {
    fixture = await createQualityTestDb();
    setWorkflowToolStepExecutor(async () => { throw new Error("Definition writes must never dispatch tools"); });
  }, 60_000);
  afterAll(async () => { setWorkflowToolStepExecutor(null); await fixture?.close(); });

  async function world(declared: boolean) {
    const [company] = await fixture.db.insert(companies).values({ name: "Template fixture", issuePrefix: randomUUID() }).returning();
    const [agent] = await fixture.db.insert(agents).values({ companyId: company.id, name: "Worker", role: "engineer", adapterType: "process" }).returning();
    const tools = await fixture.db.insert(toolDefinitions).values(publicationTools.map(tool => ({
      ...tool, companyId: company.id, adapterType: "builtin", adapterConfig: declared ? tool.adapterConfig : {},
    }))).returning();
    await fixture.db.insert(agentToolGrants).values(tools.map(tool => ({ companyId: company.id, agentId: agent.id, toolId: tool.id, grantedBy: "board" })));
    const steps = [
      { id: "p", name: "First", type: "action", agentId: agent.id, dependencies: [], toolNames: ["alpha"] },
      { id: "v", name: "Second", type: "qa", agentId: agent.id, dependencies: ["p"], toolNames: ["beta"], toolArgs: { receiptInput: "{$steps.p.workProductPath}" } },
      { id: "q", name: "Third", type: "qa", agentId: agent.id, dependencies: ["v"] },
    ];
    return { companyId: company.id, steps, tools };
  }
  const replay = (steps: Array<{ id: string; conditionalDependencies?: Array<{ stepId: string; isBackEdge?: boolean }> }>) =>
    steps.filter(step => step.conditionalDependencies?.some(edge => edge.stepId === "q" && edge.isBackEdge)).map(step => step.id);

  it("persists publisher and receipt consumer replay at create and update using company declarations", async () => {
    const own = await world(true);
    const created = await workflowService.createDefinition(fixture.db, { ...own, name: "Neutral flow" });
    expect(replay(created.steps)).toEqual(["p", "v"]);
    const updated = await workflowService.updateDefinition(fixture.db, created.id, { steps: own.steps });
    expect(replay(updated!.steps)).toEqual(["p", "v"]);
  });

  it("does not borrow another company's declarations or malformed contracts", async () => {
    await world(true);
    const own = await world(false);
    const created = await workflowService.createDefinition(fixture.db, { ...own, name: "Publish verify QA" });
    expect(replay(created.steps)).toEqual(["p"]);
    await fixture.db.update(toolDefinitions).set({ adapterConfig: { artifactContract: { role: "publication" } } })
      .where(eq(toolDefinitions.id, own.tools[0].id));
    const updated = await workflowService.updateDefinition(fixture.db, created.id, { steps: own.steps });
    expect(replay(updated!.steps)).toEqual(["p"]);
  });
});
