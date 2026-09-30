import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterAll, beforeAll, expect, it } from "vitest";
import { agents, companies, createDb, issues, workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { workProductService } from "../services/work-products.js";
import { admittedProducer } from "./helpers/admitted-producer.js";
let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, dir: string;
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("producer-v31-"); db = createDb(temp.connectionString); dir = await mkdtemp(path.join(os.tmpdir(), "producer-")); }, 60000);
afterAll(async () => { await temp?.cleanup(); await rm(dir, { recursive: true, force: true }); });
it("official registration overwrites caller provenance with DB attempt and prevents patch forgery", async () => {
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), stepId = randomUUID(), heartbeatId = randomUUID(), workflowId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Producer", issuePrefix: "PRD" });
  await db.insert(agents).values({ id: agentId, companyId, name: "Writer" });
  await db.insert(issues).values({ id: issueId, companyId, title: "Write" });
  await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "Producer", stepsJson: [] });
  await db.insert(workflowRuns).values({ id: runId, workflowId, companyId, triggeredBy: "board" });
  await db.insert(workflowStepRuns).values({ id: stepId, workflowRunId: runId, stepId: "write", issueId, status: "running",
    startedAt: new Date("2026-01-01"), executionGeneration: 4, retryCount: 2, iterationIndex: 1 });
  await admittedProducer(db, { companyId, agentId, issueId, stepRunId: stepId, heartbeatId, status: "running" });
  const file = path.join(dir, "content.json"); await writeFile(file, "{}");
  const svc = workProductService(db);
  const product = await svc.createForIssue(issueId, companyId, { provider: "local_file", type: "document", title: "content.json", status: "active",
    createdByRunId: heartbeatId, metadata: { path: file, workflowProducer: { executionGeneration: 999 } } });
  expect(product?.metadata?.workflowProducer).toMatchObject({ stepRunId: stepId, executionGeneration: 4, retryCount: 2, iterationIndex: 1, heartbeatRunId: heartbeatId });
  const updated = await svc.update(product!.id, { metadata: { path: file, workflowProducer: { executionGeneration: 999 } } });
  expect(updated?.metadata?.workflowProducer).toEqual(product?.metadata?.workflowProducer);
});
