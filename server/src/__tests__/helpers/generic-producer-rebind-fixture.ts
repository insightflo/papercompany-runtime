import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { agents, companies, heartbeatRuns, issues, issueWorkProducts, workflowDefinitions,
  workflowRuns, workflowStepRuns, workflowStepOutputBindings, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { admittedProducer } from "./admitted-producer.js";
import { workProductService } from "../../services/work-products.js";
import { selectSameRunWorkProduct } from "../../services/workflow/workproduct-same-run.js";
import { resolveWorkflowToolStepArgs } from "../../services/workflow/tool-step-args.js";

export async function genericProducerFixture(db: Db, dir: string, options: {
  role?: string; stepId?: string; sealed?: boolean; runStatus?: string;
} = {}) {
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), workflowId = randomUUID();
  const runId = randomUUID(), stepRunId = randomUUID(), consumerId = randomUUID(), heartbeatId = randomUUID();
  const stepId = options.stepId ?? "collect", file = path.join(dir, `${issueId}.json`);
  const steps = [{ id: stepId, agentId }, { id: "consume", dependencies: [stepId],
    toolArgs: { input: `{$steps.${stepId}.workProductPath}` },
    workProductSelectors: { [stepId]: { type: "document" as const, title: "data.json" } } }];
  await db.insert(companies).values({ id: companyId, name: "Generic", issuePrefix: companyId.slice(0, 8) });
  await db.insert(agents).values({ id: agentId, companyId, name: "Collector", role: options.role ?? "researcher" });
  await db.insert(issues).values({ id: issueId, companyId, title: "Collect" });
  await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "Generic", stepsJson: steps });
  await db.insert(workflowRuns).values({ id: runId, companyId, workflowId, status: "running", triggeredBy: "board" });
  await db.insert(workflowStepRuns).values([
    { id: stepRunId, workflowRunId: runId, stepId, issueId, status: "completed", executionGeneration: 1 },
    { id: consumerId, workflowRunId: runId, stepId: "consume", status: "pending", executionGeneration: 3 },
  ]);
  const admission = await admittedProducer(db, { companyId, agentId, issueId, stepRunId, heartbeatId });
  await writeFile(file, "{}");
  const product = (await workProductService(db).createForIssue(issueId, companyId, {
    provider: "local_file", type: "document", title: "data.json", status: "active", createdByRunId: heartbeatId,
    metadata: { path: file },
  }))!;
  const originalProducer = product.metadata!.workflowProducer as Record<string, unknown>;
  if (!options.sealed) {
    const { sha256: _hash, byteSize: _size, ...legacy } = originalProducer;
    await db.update(issueWorkProducts).set({ metadata: { ...product.metadata, workflowProducer: legacy } })
      .where(eq(issueWorkProducts.id, product.id));
  }
  const read = async () => (await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, product.id)))[0];
  const patchProduct = (patch: Partial<typeof issueWorkProducts.$inferInsert>) => db.update(issueWorkProducts).set(patch)
    .where(eq(issueWorkProducts.id, product.id));
  const patchProducer = async (patch: Record<string, unknown>) => {
    const row = await read();
    await patchProduct({ metadata: { ...row.metadata, workflowProducer: { ...(row.metadata!.workflowProducer as object), ...patch } } });
  };
  await db.update(workflowStepRuns).set({ executionGeneration: 3 }).where(eq(workflowStepRuns.id, stepRunId));
  await db.update(workflowRuns).set({ status: options.runStatus ?? "running" }).where(eq(workflowRuns.id, runId));
  const scope = { companyId, workflowRunId: runId, stepId, selector: { type: "document" as const, title: "data.json" } };
  const select = () => selectSameRunWorkProduct(db, scope);
  const resolve = () => resolveWorkflowToolStepArgs({ db, run: { id: runId, companyId }, step: steps[1],
    workflowSteps: steps, consumerStepRunId: consumerId });
  const events = () => db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowRunId, runId));
  const pins = () => db.select().from(workflowStepOutputBindings).where(eq(workflowStepOutputBindings.consumerStepRunId, consumerId));
  const patchHeartbeat = (patch: Partial<typeof heartbeatRuns.$inferInsert>) => db.update(heartbeatRuns).set(patch)
    .where(eq(heartbeatRuns.id, heartbeatId));
  return { db, companyId, issueId, runId, stepRunId, consumerId, heartbeatId, stepId, file, product, originalProducer,
    admission, scope, select, resolve, read, patchProduct, patchProducer, events, pins, patchHeartbeat };
}
