import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, issues, issueWorkProducts, workflowDefinitions,
  workflowRecoveryAuthorities, workflowRuns, workflowStepRuns, workflowTerminalDecisions,
  workflowTransitionEvents, type Db } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { workflowRoutes } from "../routes/workflows.js";
import { processQueuedWorkflowToolStepRuns, setWorkflowToolStepExecutor, syncWorkflowRunState } from "../services/workflow/dag-engine.js";
import * as automatic from "../services/workflow/automatic-producer-rebind.js";
import { workProductService } from "../services/work-products.js";
import { admittedProducer } from "./helpers/admitted-producer.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { setRunRecoveryFlags } from "./helpers/run-reopen-guard-fixture.js";
import { createFrozenRun } from "./helpers/workflow-frozen-execution-fixture.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let dir: string;
beforeAll(async () => {
  temp = await startEmbeddedPostgresTestDatabase("producer-rebind-rerun-");
  db = createDb(temp.connectionString);
  dir = await mkdtemp(path.join(os.tmpdir(), "producer-rebind-rerun-"));
  await setRunRecoveryFlags(db, true, true);
  // DB-generated transaction IDs prove issuance and consumer queue writes use distinct transactions.
  await db.execute(sql`CREATE TABLE test_rebind_transactions (company_id uuid, kind text, txid text);
    CREATE FUNCTION test_rebind_product_trace() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF OLD.metadata->'workflowProducerRebind' IS NULL AND NEW.metadata->'workflowProducerRebind' IS NOT NULL THEN
        INSERT INTO test_rebind_transactions VALUES (NEW.company_id, 'issuance', pg_current_xact_id()::text);
      END IF; RETURN NEW; END $$;
    CREATE TRIGGER test_rebind_product_trace AFTER UPDATE ON issue_work_products
      FOR EACH ROW EXECUTE FUNCTION test_rebind_product_trace();
    CREATE FUNCTION test_rebind_queue_trace() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.step_id = 'consume' AND OLD.status = 'pending' AND NEW.status = 'running' THEN
        INSERT INTO test_rebind_transactions SELECT company_id, 'queue', pg_current_xact_id()::text
          FROM workflow_runs WHERE id = NEW.workflow_run_id;
      END IF; RETURN NEW; END $$;
    CREATE TRIGGER test_rebind_queue_trace AFTER UPDATE ON workflow_step_runs
      FOR EACH ROW EXECUTE FUNCTION test_rebind_queue_trace()`);
}, 60_000);
afterEach(() => { vi.restoreAllMocks(); setWorkflowToolStepExecutor(null); });
afterAll(async () => {
  await db?.$client.end();
  await temp?.cleanup();
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function fixture() {
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), workflowId = randomUUID();
  const args = { source: "{$steps.write.workProductPath}" };
  const steps = [
    { id: "write", name: "Write", type: "agent", agentId, dependencies: [] },
    { id: "consume", name: "Consume", type: "tool", agentId: "", dependencies: ["write"],
      toolNames: ["consume-product"], toolArgs: args,
      workProductSelectors: { write: { type: "document", title: "content.json" } } },
  ];
  await db.insert(companies).values({ id: companyId, name: "Rerun Rebind", issuePrefix: companyId.slice(0, 8) });
  await db.insert(agents).values({ id: agentId, companyId, name: "Writer" });
  await db.insert(issues).values({ id: issueId, companyId, title: "Write", status: "done" });
  await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "Rerun Rebind", stepsJson: steps });
  const run = await createFrozenRun(db, { workflowId, companyId });
  const [producer] = await db.insert(workflowStepRuns).values({ workflowRunId: run.id, stepId: "write",
    issueId, status: "completed", executionGeneration: 0, startedAt: new Date("2026-01-01") }).returning();
  const admitted = await admittedProducer(db, { companyId, agentId, issueId,
    stepRunId: producer.id, heartbeatId: randomUUID() });
  // Admission helper claims the heartbeat, not the wake's lifecycle; model its completed delivery too.
  await db.update(agentWakeupRequests).set({ status: "completed", finishedAt: new Date() })
    .where(eq(agentWakeupRequests.id, admitted.wakeId));
  const file = path.join(dir, `${issueId}.json`);
  await writeFile(file, "{}");
  const product = await workProductService(db).createForIssue(issueId, companyId, {
    provider: "local_file", type: "document", title: "content.json", status: "active",
    createdByRunId: admitted.heartbeatId, metadata: { path: file },
  });
  expect(product).not.toBeNull();
  const [consumer] = await db.insert(workflowStepRuns).values({ workflowRunId: run.id, stepId: "consume",
    status: "failed", issueId: null, executionGeneration: 2, startedAt: new Date("2026-01-02"),
    completedAt: new Date("2026-01-02"), lastDispatchErrorSummary: "prior_tool_failure",
    metadata: { toolInvocation: { requestId: "prior", args, dispatchError: "prior_tool_failure" } },
  }).returning();
  await db.update(workflowStepRuns).set({ executionGeneration: 2 }).where(eq(workflowStepRuns.id, producer.id));
  await db.update(workflowRuns).set({ status: "failed", completedAt: new Date("2026-01-02") })
    .where(eq(workflowRuns.id, run.id));
  const terminal = (version: number) => db.insert(workflowTerminalDecisions).values({ companyId, workflowRunId: run.id,
    decidedAuthorityVersion: version, decision: "failed", policyCause: "recovery_deadline_hard",
    discoveryPath: "stuck_diagnostic", origin: "reconciler", reason: "test", recoveryGate: {} });
  await terminal(0);
  const executor = vi.fn().mockResolvedValue({ accepted: true });
  setWorkflowToolStepExecutor(executor);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "board", source: "local_implicit", userId: "test-board" } as typeof req.actor;
    next();
  });
  app.use("/api", workflowRoutes(db));
  app.use(errorHandler);
  const rerun = () => request(app).post(`/api/workflow-step-runs/${consumer.id}/rerun`).send({});
  const read = async () => ({
    step: (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, consumer.id)))[0],
    product: (await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, product!.id)))[0],
    authorities: await db.select().from(workflowRecoveryAuthorities).where(eq(workflowRecoveryAuthorities.workflowRunId, run.id)),
    events: (await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowRunId, run.id)))
      .filter(event => event.reason === "automatic_producer_provenance_rebind"),
  });
  return { companyId, run, producer, consumer, product: product!, file, args, executor, rerun, read, terminal };
}

it("native issue-less rerun automatically rebinds recovery-bumped producer provenance before queueing", async () => {
  const f = await fixture(), issuer = vi.spyOn(automatic, "issueAutomaticProducerRebind");
  expect((await f.rerun()).status).toBe(200);
  const after = await f.read();
  expect(after.authorities).toHaveLength(1);
  expect(after.step.executionGeneration).toBe(3);
  expect(after.product.metadata?.workflowProducerRebind).toMatchObject({
    fromGeneration: 0, reboundAtGeneration: 3, reason: "automatic_producer_provenance_rebind",
    reboundBy: { actorType: "system", actorId: "workproduct-selector" },
  });
  expect(after.product.sourceExecutionGeneration).toBe(0);
  expect(after.events).toHaveLength(1);
  expect(after.events[0].payload).toMatchObject({ transition: "producer_provenance_rebound", productId: f.product.id });
  expect(after.step.lastDispatchErrorSummary).toBeNull();
  expect(after.step.metadata.toolInvocation).toMatchObject({ args: { source: f.file } });
  expect(after.step.metadata.toolQueue).toMatchObject({ status: "queued" });
  expect(after.step.status).toBe("running");
  expect(issuer.mock.calls.map(([issuerDb]) => issuerDb === db)).toEqual([true]);
  const trace = await db.execute(sql`SELECT kind, txid FROM test_rebind_transactions WHERE company_id = ${f.companyId}`);
  expect(trace.map(row => row.kind).sort()).toEqual(["issuance", "queue"]);
  expect(new Set(trace.map(row => row.txid)).size).toBe(2);
  // HTTP rerun materializes only; the separate native queue processor executes the resolved request.
  expect(f.executor).not.toHaveBeenCalled();
  await processQueuedWorkflowToolStepRuns(db);
  expect(f.executor.mock.calls.map(([input]) => input.args)).toEqual([{ source: f.file }]);
});

it("issuance failure preserves the eligible error string and records the underlying conflict", async () => {
  const f = await fixture(), issuer = vi.spyOn(automatic, "issueAutomaticProducerRebind");
  await writeFile(f.file, "changed bytes");
  expect((await f.rerun()).status).toBe(200);
  const after = await f.read();
  expect(after.step.status).toBe("failed");
  expect(after.step.lastDispatchErrorSummary).toBe("workproduct_selector_stale_producer");
  expect(after.step.metadata.toolInvocation).toMatchObject({ args: f.args,
    dispatchError: "workproduct_selector_stale_producer", producerRebindDiagnostic: {
      schemaVersion: "workflow.producer-rebind-diagnostic.v1", outcome: "issuance-failed",
      conflictReason: "producer_rebind_bytes_changed",
      scope: { companyId: f.companyId, workflowRunId: f.run.id, producerStepId: "write", productId: f.product.id },
    } });
  expect(after.product.metadata?.workflowProducerRebind).toBeUndefined();
  expect(after.events).toHaveLength(0); expect(after.authorities).toHaveLength(1);
  expect(issuer).toHaveBeenCalledTimes(1); expect(f.executor).not.toHaveBeenCalled();
});

it("a transactional sync without a recovery delivery boundary records skipped issuance diagnostics", async () => {
  const f = await fixture();
  await db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, f.run.id));
  await db.update(workflowStepRuns).set({ status: "pending", startedAt: null, completedAt: null, metadata: {} })
    .where(eq(workflowStepRuns.id, f.consumer.id));
  await db.transaction(tx => syncWorkflowRunState(tx as unknown as Db, f.run.id));
  const after = await f.read();
  expect(after.step.lastDispatchErrorSummary).toBe("workproduct_selector_stale_producer");
  expect(after.step.metadata.toolInvocation).toMatchObject({ producerRebindDiagnostic: {
    schemaVersion: "workflow.producer-rebind-diagnostic.v1", outcome: "skipped-in-transaction",
    scope: { companyId: f.companyId, workflowRunId: f.run.id, producerStepId: "write", productId: f.product.id },
  } });
  expect(after.events).toHaveLength(0); expect(f.executor).not.toHaveBeenCalled();
});

it("repeated native reruns preserve the original marker and unique authority event", async () => {
  const f = await fixture();
  expect((await f.rerun()).status).toBe(200);
  const first = await f.read();
  await db.update(workflowStepRuns).set({ status: "failed", completedAt: new Date(),
    metadata: { toolInvocation: { args: f.args, dispatchError: "fixture_tool_failure" } } })
    .where(eq(workflowStepRuns.id, f.consumer.id));
  await db.update(workflowRuns).set({ status: "failed" }).where(eq(workflowRuns.id, f.run.id));
  await f.terminal(1);
  expect((await f.rerun()).status).toBe(200);
  const after = await f.read();
  expect(after.step.executionGeneration).toBe(4);
  expect(after.step.lastDispatchErrorSummary).toBeNull();
  expect(after.product.metadata?.workflowProducerRebind).toEqual(first.product.metadata?.workflowProducerRebind);
  expect(after.events).toEqual(first.events); expect(after.authorities).toHaveLength(2);
});

it("a second typed request consumes no second issuance and fails with structured diagnostics", async () => {
  const f = await fixture(), issue = automatic.issueAutomaticProducerRebind;
  const issuer = vi.spyOn(automatic, "issueAutomaticProducerRebind").mockImplementation(async (writer, required) => {
    await issue(writer, required);
    // Deterministic interleaving: remove only this fixture's marker before the bounded delivery retry.
    const { product } = await f.read(), metadata = { ...product.metadata };
    delete metadata.workflowProducerRebind;
    await db.update(issueWorkProducts).set({ metadata }).where(eq(issueWorkProducts.id, f.product.id));
  });
  expect((await f.rerun()).status).toBe(200);
  const after = await f.read();
  expect(issuer).toHaveBeenCalledTimes(1);
  expect(after.step.lastDispatchErrorSummary).toBe("workproduct_selector_stale_producer");
  expect(after.step.metadata.toolInvocation).toMatchObject({ producerRebindDiagnostic: { outcome: "skipped-in-transaction" } });
  expect(after.authorities).toHaveLength(1); expect(after.events).toHaveLength(1);
});

it.each(["cancel", "new_receipt"])("%s between issuance and retry fences delivery without another reset", async variant => {
  const f = await fixture(), issue = automatic.issueAutomaticProducerRebind;
  vi.spyOn(automatic, "issueAutomaticProducerRebind").mockImplementation(async (writer, required) => {
    await issue(writer, required);
    if (variant === "cancel") await db.update(workflowRuns).set({ status: "cancelled" }).where(eq(workflowRuns.id, f.run.id));
    else {
      const { step } = await f.read();
      const receipt = step.metadata.ownerToolRetry as Record<string, unknown>;
      await db.update(workflowStepRuns).set({ executionGeneration: 4,
        metadata: { ...step.metadata, ownerToolRetry: { ...receipt, executionGeneration: 4 } } })
        .where(eq(workflowStepRuns.id, f.consumer.id));
    }
  });
  expect((await f.rerun()).status).toBe(422);
  const after = await f.read();
  expect(after.step.status).toBe("pending"); expect(after.step.lastDispatchRequestId).toBeNull();
  expect(after.authorities).toHaveLength(1); expect(after.events).toHaveLength(1);
  expect(f.executor).not.toHaveBeenCalled();
});
