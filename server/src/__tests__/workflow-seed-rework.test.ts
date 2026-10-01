import "./helpers/workflow-control-node-boundary.js";
import { mkdtemp, realpath, rm, mkdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, workflowDefinitions, workflowRuns, workflowRunSeeds, workflowStepRuns, issues, instanceSettings } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedWorld } from "./helpers/workflow-seed-world.js";
import { admittedProducer } from "./helpers/admitted-producer.js";
import { recordWorkflowValidationVerdict } from "../services/workflow/validation-verdict-ledger.js";
import { executeWorkflowRun, syncWorkflowRunState } from "../services/workflow/dag-engine.js";
import { applyBackEdgeReworkPass } from "../services/workflow/control-flow/loop-driver.js";
import { selectOfficialWorkProduct } from "../services/workflow/workproduct-selector.js";
import { resolveWorkflowToolStepArgs } from "../services/workflow/tool-step-args.js";
import { workProductService } from "../services/work-products.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("seed-rework-"); db = createDb(temp.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "seed-rework-"))); }, 60000);
afterAll(async () => { await temp?.cleanup(); await rm(root, { recursive: true, force: true }); });

it.each([false, true])("seed → QA rejects → admitted rework producer replaces seed authority (finalization=%s)", async enabled => {
  await db.insert(instanceSettings).values({ singletonKey: "default", general: {}, experimental: { enableHeartbeatFinalizationV1: enabled } })
    .onConflictDoUpdate({ target: instanceSettings.singletonKey, set: { experimental: { enableHeartbeatFinalizationV1: enabled } } });
  const f = await seedWorld(db, root);
  const steps = [{ ...f.steps[0], conditionalDependencies: [{ stepId: "use", when: "qa_request_changes" as const, isBackEdge: true, maxIterations: 2 }] },
    { ...f.steps[1], type: "qa", name: "[QA] Review" }];
  await db.update(workflowDefinitions).set({ stepsJson: steps }).where(eq(workflowDefinitions.id, f.definition.id));
  const target = await f.admit();
  await executeWorkflowRun(db, target.id);
  let rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, target.id));
  const producer = rows.find(s => s.stepId === "write")!, qa = rows.find(s => s.stepId === "use")!;
  const scope = { companyId: f.companyId, workflowRunId: target.id, stepId: "write", selector: { type: "document" as const, title: "content.json" } };
  expect((await selectOfficialWorkProduct(db, scope)).product.id).toBe(f.product.id);
  const audit = await db.select().from(workflowRunSeeds).where(eq(workflowRunSeeds.targetRunId, target.id));
  const [qaIssue] = await db.select().from(issues).where(eq(issues.id, qa.issueId!));
  await recordWorkflowValidationVerdict({ db, issue: qaIssue, verdict: "request_changes", source: "workflow_api", actorAgentId: f.agentId });
  await db.update(workflowStepRuns).set({ status: "failed" }).where(eq(workflowStepRuns.id, qa.id));
  rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, target.id));
  const reset = await applyBackEdgeReworkPass({ db, run: { ...target, status: "running" }, steps, stepRuns: rows,
    predsByStepId: new Map([["use", { status: "failed" as const, isQaGate: true, verdict: "request_changes" as const }]]) });
  expect(reset.reworkedCount).toBe(1);
  // Retirement cannot silently reuse the original product before a new target producer exists.
  await expect(selectOfficialWorkProduct(db, scope)).rejects.toThrow();
  await syncWorkflowRunState(db, target.id);
  const [attempt] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, producer.id));
  expect(attempt.iterationIndex).toBe(1);
  expect(attempt.issueId).toBeTruthy();
  const heartbeatId = randomUUID();
  await db.update(workflowStepRuns).set({ status: "running", startedAt: new Date() }).where(eq(workflowStepRuns.id, producer.id));
  await admittedProducer(db, { companyId: f.companyId, agentId: f.agentId, issueId: attempt.issueId, stepRunId: producer.id, heartbeatId });
  const dir = path.join(root, "missions", f.revision.id, "rework"); await mkdir(dir, { recursive: true });
  const file = path.join(dir, "content.json"), bytes = '{"blocks":["reworked"]}'; await writeFile(file, bytes);
  const product = await workProductService(db).createForIssue(attempt.issueId!, f.companyId, { provider: "local_file", type: "document",
    title: "content.json", status: "active", createdByRunId: heartbeatId,
    metadata: { path: file, sha256: createHash("sha256").update(bytes).digest("hex") } });
  await db.update(issues).set({ status: "done" }).where(eq(issues.id, attempt.issueId!));
  await db.update(workflowStepRuns).set({ status: "completed", completedAt: new Date() }).where(eq(workflowStepRuns.id, producer.id));
  // Changed source bytes must neither block new official output nor substitute for it.
  await writeFile(f.file, "source changed after legitimate rework");
  expect((await selectOfficialWorkProduct(db, scope)).product.id).toBe(product!.id);
  expect((await selectOfficialWorkProduct(db, scope)).producer).toMatchObject({ workflowRunId: target.id, iterationIndex: 1 });
  await expect(selectOfficialWorkProduct(db, { ...scope, pinnedId: f.product.id })).rejects.toThrow();
  const [consumer] = await db.insert(workflowStepRuns).values({ workflowRunId: target.id, stepId: "new-consumer", status: "running" }).returning();
  expect(await resolveWorkflowToolStepArgs({ db, run: target, step: { ...steps[1], id: "new-consumer" }, consumerStepRunId: consumer.id,
    workflowSteps: [...steps, { ...steps[1], id: "new-consumer" }] })).toEqual({ content: file });
  await expect(resolveWorkflowToolStepArgs({ db, run: target, step: { id: "legacy", dependencies: ["write"],
    toolArgs: { content: "{$steps.write.workProductPath}" } }, workflowSteps: [...steps, { id: "legacy", dependencies: ["write"] }] }))
    .rejects.toThrow("workflow_seed_explicit_selector_required");
  expect(await db.select().from(workflowRunSeeds).where(eq(workflowRunSeeds.targetRunId, target.id))).toEqual(audit);
});
