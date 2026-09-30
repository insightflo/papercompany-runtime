import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, missions, issueWorkProducts,
  workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { workProductService } from "../services/work-products.js";
import { workProductProducerSchema } from "@paperclipai/shared/validators/workflow-artifact";
import { selectOfficialWorkProduct } from "../services/workflow/workproduct-selector.js";
let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("producer-delegation-"); db = createDb(temp.connectionString); }, 60000);
afterAll(async () => { await temp?.cleanup(); });
async function fixture() {
  const companyId = randomUUID(), agentId = randomUUID(), missionId = randomUUID(), issueId = randomUUID();
  const ownerId = randomUUID(), heartbeatId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Owner", issuePrefix: companyId.slice(0, 8) });
  await db.insert(agents).values({ id: agentId, companyId, name: "Owner" });
  await db.insert(missions).values({ id: missionId, companyId, title: "Mission", ownerAgentId: agentId });
  await db.insert(issues).values([
    { id: issueId, companyId, missionId, title: "Source", originKind: "workflow_execution", status: "blocked" },
    { id: ownerId, companyId, missionId, title: "Recover", originKind: "mission_main_executor_unblock", originId: issueId,
      assigneeAgentId: agentId, status: "in_progress" },
  ]);
  await db.insert(heartbeatRuns).values({ id: heartbeatId, companyId, agentId, issueId: ownerId, status: "running" });
  await db.update(issues).set({ checkoutRunId: heartbeatId }).where(eq(issues.id, ownerId));
  const delegation = { kind: "mission_owner_unblock_source" as const, issueId: ownerId, identifier: null };
  const data = { provider: "public_url", type: "preview_url", title: "Recovered", status: "active",
    createdByRunId: heartbeatId, metadata: { delegatedWorkflowApi: delegation.kind, delegatedFromIssueId: ownerId } };
  const register = () => workProductService(db).createForIssue(issueId, companyId, data, delegation);
  return { companyId, agentId, missionId, issueId, ownerId, heartbeatId, data, delegation, register };
}
it("registers authorized recovery as explicit delegated provenance, never direct producer", async () => {
  const f = await fixture(), p = await f.register();
  expect(p?.createdByRunId).toBe(f.heartbeatId);
  const [stored] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, p!.id));
  expect(stored.sourceExecutionGeneration).toBeNull();
  expect(p?.metadata.workflowProducer).toMatchObject({ schemaVersion: "workflow.delegated-work-product-producer.v1",
    companyId: f.companyId, missionId: f.missionId, sourceIssueId: f.issueId,
    delegatedFromIssueId: f.ownerId, heartbeatRunId: f.heartbeatId });
  expect(workProductProducerSchema.safeParse(p?.metadata.workflowProducer).success).toBe(false);
  const updated = await workProductService(db).update(p!.id, { metadata: { workflowProducer: { schemaVersion: "workflow.work-product-producer.v1" } } });
  expect(updated?.metadata.workflowProducer).toEqual(p?.metadata.workflowProducer);
});
it("selector never treats delegated recovery as the source step's direct attempt", async () => {
  const f = await fixture(); await f.register();
  const workflowId = randomUUID(), workflowRunId = randomUUID();
  await db.insert(workflowDefinitions).values({ id: workflowId, companyId: f.companyId, name: "Recovery", stepsJson: [] });
  await db.insert(workflowRuns).values({ id: workflowRunId, companyId: f.companyId, missionId: f.missionId, workflowId, triggeredBy: "board" });
  await db.insert(workflowStepRuns).values({ workflowRunId, stepId: "write", issueId: f.issueId, status: "completed" });
  await expect(selectOfficialWorkProduct(db, { companyId: f.companyId, workflowRunId, stepId: "write",
    selector: { type: "preview_url", title: "Recovered" } })).rejects.toThrow("workproduct_selector_provenance_missing");
});
it("metadata alone cannot authorize cross-issue registration", async () => {
  const f = await fixture();
  await expect(workProductService(db).createForIssue(f.issueId, f.companyId, f.data)).rejects.toThrow("workproduct_producer_scope_mismatch");
});
it.each(["origin", "mission", "company", "checkout", "agent", "status", "kind", "delegation-issue"])("rejects delegated %s mismatch with zero writes", async reason => {
  const f = await fixture();
  if (reason === "delegation-issue") f.delegation.issueId = randomUUID();
  else {
    const patch: Partial<typeof issues.$inferInsert> = reason === "origin" ? { originId: randomUUID() }
      : reason === "mission" ? { missionId: null }
      : reason === "checkout" ? { checkoutRunId: null }
      : reason === "agent" ? { assigneeAgentId: null }
      : reason === "status" ? { status: "done" }
      : reason === "kind" ? { originKind: "workflow_execution" } : {};
    if (reason === "company") {
      patch.companyId = randomUUID(); await db.insert(companies).values({ id: patch.companyId, name: "Other", issuePrefix: patch.companyId.slice(0, 8) });
    }
    await db.update(issues).set(patch).where(eq(issues.id, f.ownerId));
  }
  await expect(f.register()).rejects.toThrow("workproduct_producer_scope_mismatch");
  expect(await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, f.issueId))).toEqual([]);
});
