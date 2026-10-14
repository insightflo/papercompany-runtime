import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentToolGrants, agentWakeupRequests, companies, createDb, heartbeatRuns, issues, issueWorkProducts,
  missions, toolDefinitions, workflowDefinitions, workflowRecoveryAuthorities, workflowRuns,
  workflowStepRuns, workflowTerminalDecisions, workflowTransitionEvents, type Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { executeCoreWorkflowTool } from "../services/workflow/core-tool-executor.js";
import { completeWorkflowToolStepFromResult, processQueuedWorkflowToolStepRuns,
  setWorkflowToolStepExecutor, syncWorkflowRunState } from "../services/workflow/dag-engine.js";
import { issueProducerRebind } from "../services/workflow/producer-rebind-issuance.js";
import { getMissionOwnerActionResult } from "../services/missions/mission-owner-execute.js";
import { workProductService } from "../services/work-products.js";
import { createFrozenRun } from "./helpers/workflow-frozen-execution-fixture.js";
import { admittedProducer } from "./helpers/admitted-producer.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;

const ORIGINAL = '{"report":"original"}';
const FIXED = '{"report":"fixed"}';
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

async function stepRow(id: string) {
  const [row] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, id));
  return row!;
}

let db!: Db;
let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
let dir: string;
const roots: string[] = [];

describeEP("mission owner adopt_producer_edits", () => {
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("owner-adopt-edits-");
    db = createDb(temp.connectionString);
    dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "owner-adopt-edits-")));
  }, 60_000);

  afterAll(async () => {
    setWorkflowToolStepExecutor(null);
    await db.$client.end({ timeout: 5 });
    await temp?.cleanup();
    await rm(dir, { recursive: true, force: true });
    for (const root of roots) await rm(root, { recursive: true, force: true });
  });

  async function seed() {
    const companyId = randomUUID(), ownerAgentId = randomUUID(), missionId = randomUUID(), workflowId = randomUUID();
    const sourceIssueId = randomUUID(), ownerIssueId = randomUUID();
    const producerHeartbeatId = randomUUID(), heartbeatRunId = randomUUID();
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "owner-adopt-files-"))); roots.push(root);
    const file = path.join(root, "report.json"); await writeFile(file, ORIGINAL);
    await db.insert(companies).values({ id: companyId, name: "Owner adopt", issuePrefix: companyId.slice(0, 8), workProductRoot: root });
    await db.insert(agents).values({ id: ownerAgentId, companyId, name: "Owner", status: "active" });
    await db.insert(missions).values({ id: missionId, companyId, title: "Edited report", ownerAgentId, status: "active" });
    await db.insert(issues).values([
      { id: sourceIssueId, companyId, missionId, title: "Report", originKind: "workflow_execution", status: "done" },
      { id: ownerIssueId, companyId, missionId, title: "Consumer recovery", originKind: "mission_main_executor_unblock",
        originId: sourceIssueId, assigneeAgentId: ownerAgentId, status: "done" },
    ]);
    await db.insert(heartbeatRuns).values([
      { id: heartbeatRunId, companyId, agentId: ownerAgentId, issueId: ownerIssueId, status: "succeeded" },
    ]);
    const script = path.join(root, "inspect.mjs");
    await writeFile(script, "import fs from 'node:fs';const file=process.argv[process.argv.indexOf('--report-path')+1];console.log(JSON.stringify({report:JSON.parse(fs.readFileSync(file,'utf8')).report}));");
    const tools = await db.insert(toolDefinitions).values([
      { companyId, name: "mission_owner_execute", adapterType: "builtin", adapterConfig: { kind: "mission-owner-execute" } },
      { companyId, name: "inspect-report", adapterType: "builtin", adapterConfig: {
        command: `${process.execPath} ${script}` } },
    ]).returning();
    await db.insert(agentToolGrants).values(tools.map(t => ({ companyId, agentId: ownerAgentId, toolId: t.id, grantedBy: "test" })));
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "Report QA", stepsJson: [
      { id: "report", name: "Report", type: "agent", agentId: ownerAgentId, dependencies: [] },
      { id: "inspect", name: "Inspect", type: "tool", agentId: "", toolNames: ["inspect-report"], dependencies: ["report"],
        toolArgs: { reportPath: "{$steps.report.workProductPath}" }, workProductSelectors: { report: { type: "document", title: "report.json" } } },
    ] });
    const run = await createFrozenRun(db, { companyId, workflowId, missionId });
    await db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, run.id));
    const [producer] = await db.insert(workflowStepRuns).values({ workflowRunId: run.id, stepId: "report", issueId: sourceIssueId, status: "completed" }).returning();
    // Producer provenance stamped at generation 0 over the ORIGINAL bytes via real admission machinery.
    // The admission wake is settled immediately: in the real incident the producer wake was consumed long
    // before the run reached terminal failed at a later generation, and retryIssueLessToolWorkflowStep's
    // replacementExecutionInFlight guard correctly refuses while a queued wake remains.
    const admission = await admittedProducer(db, { companyId, agentId: ownerAgentId, issueId: sourceIssueId,
      stepRunId: producer.id, heartbeatId: producerHeartbeatId });
    await db.update(agentWakeupRequests).set({ status: "completed" }).where(eq(agentWakeupRequests.id, admission.wakeId));
    const product = (await workProductService(db).createForIssue(sourceIssueId, companyId, {
      type: "document", title: "report.json", provider: "local_file", status: "active", metadata: { path: file },
      createdByRunId: producerHeartbeatId }))!;
    // Owner fixes the producer artifact in place; recovery has since advanced generations.
    await writeFile(file, FIXED);
    await db.update(workflowStepRuns).set({ executionGeneration: 3 }).where(eq(workflowStepRuns.id, producer.id));
    const [consumer] = await db.insert(workflowStepRuns).values({ workflowRunId: run.id, stepId: "inspect", status: "pending", executionGeneration: 3 }).returning();
    setWorkflowToolStepExecutor(async r => {
      const result = await executeCoreWorkflowTool({ db, companyId: r.companyId, agentId: r.agentId,
        toolName: r.toolName, parameters: r.args ?? {}, requestId: r.requestId,
        workflowRunId: r.workflowRunId, stepRunId: r.stepRunId, stepId: r.stepId });
      await completeWorkflowToolStepFromResult(db, { companyId: r.companyId, workflowRunId: r.workflowRunId,
        stepRunId: r.stepRunId, stepId: r.stepId, requestId: r.requestId, toolName: r.toolName,
        success: result.status === 200, data: result.body.data, stdout: result.body.content ?? "", error: result.body.error });
      return { accepted: true };
    });
    // Real selector + real auto-rebind failure records the incident shape: bytes-changed fence.
    await syncWorkflowRunState(db, run.id);
    const failed = await stepRow(consumer.id);
    expect(failed.status).toBe("failed");
    expect(failed.metadata.toolInvocation).toMatchObject({ dispatchError: "workproduct_selector_stale_producer" });
    expect((failed.metadata.toolInvocation as { producerRebindDiagnostic?: { conflictReason?: string } }).producerRebindDiagnostic)
      .toMatchObject({ conflictReason: "producer_rebind_bytes_changed" });
    await db.update(workflowRuns).set({ status: "failed" }).where(eq(workflowRuns.id, run.id));
    const [failedRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id));
    const decisions = await db.select().from(workflowTerminalDecisions).where(eq(workflowTerminalDecisions.workflowRunId, run.id));
    if (!decisions.length) await db.insert(workflowTerminalDecisions).values({ companyId, workflowRunId: run.id,
      decidedAuthorityVersion: failedRun.dispatchAuthorityVersion, decision: "failed", policyCause: "recovery_deadline_hard",
      discoveryPath: "stuck_diagnostic", origin: "reconciler" });
    const body = { schemaVersion: 1 as const, missionId, ownerActionIssueId: ownerIssueId,
      actionRequestId: randomUUID(), expectedIntentEventId: null, ownerDecisionEventId: null,
      action: { operation: "adopt_producer_edits" as const, productId: product.id, producerStepId: "report",
        attestation: { sha256: sha256(FIXED), byteSize: Buffer.byteLength(FIXED) },
        target: { kind: "tool_step" as const, workflowRunId: run.id, stepRunId: consumer.id,
          expectedAuthorityVersion: failedRun.dispatchAuthorityVersion, expectedExecutionGeneration: failed.executionGeneration,
          failedDispatchRequestId: failed.lastDispatchRequestId } } };
    const call = (parameters: unknown = body) => executeCoreWorkflowTool({ db, companyId, agentId: ownerAgentId,
      heartbeatRunId, toolName: "mission_owner_execute", requestId: randomUUID(), parameters });
    const readProduct = async () => (await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, product.id)))[0]!;
    const events = () => db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowRunId, run.id));
    const authorities = () => db.select().from(workflowRecoveryAuthorities).where(eq(workflowRecoveryAuthorities.workflowRunId, run.id));
    return { companyId, missionId, ownerAgentId, sourceIssueId, ownerIssueId, heartbeatRunId, run, consumer,
      product, file, body, call, readProduct, events, authorities };
  }

  it("adopts owner-attested edited bytes and recovers the exact failed consumer, with idempotent replay", async () => {
    const s = await seed();
    const result = await s.call();
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const action = result.body.data as { actionId: string; state: string };
    expect(action.state).toBe("executing");
    const row = await s.readProduct();
    expect((row.metadata!.workflowProducer as Record<string, unknown>).executionGeneration).toBe(0);
    expect(row.metadata!.workflowProducerRebind).toMatchObject({
      reason: "owner_attested_producer_rework",
      reboundBy: { actorType: "mission_owner", actorId: s.ownerAgentId },
      sha256: sha256(FIXED),
    });
    expect((await s.events()).filter(e => e.reason === "owner_attested_producer_rework")).toHaveLength(1);
    expect(await s.authorities()).toHaveLength(1);
    await processQueuedWorkflowToolStepRuns(db);
    const completed = await stepRow(s.consumer.id);
    expect(completed.status, JSON.stringify(completed.metadata)).toBe("completed");
    expect(completed.metadata.toolResult).toMatchObject({ success: true, data: { report: "fixed" } });
    expect((await getMissionOwnerActionResult({ db, companyId: s.companyId, agentId: s.ownerAgentId,
      heartbeatRunId: s.heartbeatRunId }, { schemaVersion: 1, missionId: s.missionId, actionId: action.actionId })).state).toBe("resolved");
    expect((await s.call()).body.data).toMatchObject({ actionId: action.actionId, state: "resolved" });
    expect(await s.authorities()).toHaveLength(1);
  });

  it.each(["attestation_mismatch", "wrong_product", "wrong_producer", "wrong_mission", "wrong_selector_product",
    "archived", "nonlocal", "unreadable", "not_failed", "wrong_error", "not_bytes_changed", "retry_exhausted",
    "missing_decision", "stale_authority", "stale_generation", "stale_request"])('refuses %s without adoption, reset, queue or recovery authority', async variant => {
    const s = await seed();
    const body = { ...s.body, action: { ...s.body.action,
      attestation: { ...s.body.action.attestation },
      target: { ...s.body.action.target } } };
    if (variant === "attestation_mismatch") body.action.attestation = { sha256: sha256(ORIGINAL), byteSize: Buffer.byteLength(ORIGINAL) };
    if (variant === "wrong_product") body.action.productId = randomUUID();
    if (variant === "wrong_producer") body.action.producerStepId = "missing";
    if (variant === "wrong_mission") body.missionId = randomUUID();
    if (variant === "wrong_selector_product") {
      await db.update(issueWorkProducts).set({ title: "other.json" }).where(eq(issueWorkProducts.id, s.product.id));
    }
    if (variant === "archived") await db.update(issueWorkProducts).set({ status: "archived" }).where(eq(issueWorkProducts.id, s.product.id));
    if (variant === "nonlocal") await db.update(issueWorkProducts).set({ provider: "remote" }).where(eq(issueWorkProducts.id, s.product.id));
    if (variant === "unreadable") await rm(s.file);
    if (variant === "not_failed") await db.update(workflowStepRuns).set({ status: "pending" }).where(eq(workflowStepRuns.id, s.consumer.id));
    if (variant === "wrong_error" || variant === "not_bytes_changed" || variant === "retry_exhausted") {
      const row = await stepRow(s.consumer.id);
      const invocation = { ...(row.metadata.toolInvocation as Record<string, unknown>) };
      if (variant === "wrong_error") {
        delete invocation.producerRebindDiagnostic;
        invocation.dispatchError = "workproduct_selector_provenance_missing";
      }
      if (variant === "not_bytes_changed") invocation.producerRebindDiagnostic = { schemaVersion: "workflow.producer-rebind-diagnostic.v1", outcome: "issuance-failed" };
      await db.update(workflowStepRuns).set({ metadata: { ...row.metadata,
        ...(variant === "retry_exhausted" ? { workflowRetryExhaustion: {} } : { toolInvocation: invocation }),
      } }).where(eq(workflowStepRuns.id, s.consumer.id));
    }
    if (variant === "stale_authority") body.action.target.expectedAuthorityVersion += 1;
    if (variant === "stale_generation") body.action.target.expectedExecutionGeneration += 1;
    if (variant === "stale_request") body.action.target.failedDispatchRequestId = "foreign-request";
    if (variant === "missing_decision") await db.delete(workflowTerminalDecisions).where(eq(workflowTerminalDecisions.workflowRunId, s.run.id));
    const snapshot = async () => JSON.stringify({ product: await s.readProduct(), consumer: await stepRow(s.consumer.id),
      run: await db.select().from(workflowRuns).where(eq(workflowRuns.id, s.run.id)), events: await s.events(), authorities: await s.authorities() });
    const before = await snapshot();
    const result = await s.call(body);
    expect(result.status, JSON.stringify(result.body)).toBe(variant === "wrong_mission" ? 404 : 409);
    expect(await snapshot()).toBe(before);
  });

  it("adopts idempotently when a board rebind marker already rebound the same bytes", async () => {
    const s = await seed();
    await issueProducerRebind(db, { companyId: s.companyId, workflowRunId: s.run.id,
      producerStepId: "report", productId: s.product.id,
      actor: { actorType: "board", actorId: "local-board" },
      expected: { sha256: sha256(FIXED), byteSize: Buffer.byteLength(FIXED) } });
    const boardMarker = (await s.readProduct()).metadata!.workflowProducerRebind as Record<string, unknown>;
    expect(boardMarker.reason).toBe("board_producer_provenance_rebind");
    const result = await s.call();
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const row = await s.readProduct();
    expect(row.metadata!.workflowProducerRebind).toEqual(boardMarker);
    expect((await s.events()).filter(e => e.reason === "owner_attested_producer_rework")).toHaveLength(0);
    expect(await s.authorities()).toHaveLength(1);
    await processQueuedWorkflowToolStepRuns(db);
    expect((await stepRow(s.consumer.id)).status).toBe("completed");
  });

  it("concurrent identical requests consume one authority and write one adoption marker", async () => {
    const s = await seed();
    const results = await Promise.all([s.call(), s.call()]);
    expect(results.map(r => r.status)).toEqual([200, 200]);
    const first = results[0].body.data as { actionId: string };
    expect(results[1].body.data).toMatchObject({ actionId: first.actionId, state: "executing" });
    expect(await s.authorities()).toHaveLength(1);
    expect((await s.events()).filter(e => e.reason === "owner_attested_producer_rework")).toHaveLength(1);
    await processQueuedWorkflowToolStepRuns(db);
    expect((await stepRow(s.consumer.id)).status).toBe("completed");
  });
});
