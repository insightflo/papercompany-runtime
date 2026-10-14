import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { agents, agentToolGrants, companies, createDb, heartbeatRuns, issues, issueWorkProducts,
  missions, toolDefinitions, workflowDefinitions, workflowRecoveryAuthorities, workflowRuns,
  workflowStepRuns, workflowTerminalDecisions, workflowTransitionEvents } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createFrozenRun } from "./helpers/workflow-frozen-execution-fixture.js";
import { workProductService } from "../services/work-products.js";
import { executeCoreWorkflowTool } from "../services/workflow/core-tool-executor.js";
import { completeWorkflowToolStepFromResult, processQueuedWorkflowToolStepRuns,
  setWorkflowToolStepExecutor, syncWorkflowRunState } from "../services/workflow/dag-engine.js";
import { getMissionOwnerActionResult } from "../services/missions/mission-owner-execute.js";
import { selectOfficialWorkProduct } from "../services/workflow/workproduct-selector.js";
import { promoteDelegatedProducerProvenance } from "../services/workflow/producer-provenance-rebind.js";
import { missionOwnerExecuteSchema } from "@paperclipai/shared/validators/mission-owner-authority";
import { buildToolStepRecoveryDescription } from "../services/missions/tool-step-recovery-description.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
const roots: string[] = [];
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("owner-promotion-"); db = createDb(temp.connectionString); }, 60_000);
afterAll(async () => { setWorkflowToolStepExecutor(null); await temp?.cleanup();
  for (const root of roots) await rm(root, { recursive: true, force: true }); });
const stepRow = async (id: string) => (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, id)))[0]!;

async function seed() {
  const companyId = randomUUID(), ownerAgentId = randomUUID(), missionId = randomUUID(), workflowId = randomUUID();
  const sourceIssueId = randomUUID(), unblockIssueId = randomUUID(), ownerIssueId = randomUUID();
  const delegatedHeartbeatId = randomUUID(), heartbeatRunId = randomUUID();
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "owner-promotion-files-"))); roots.push(root);
  const file = path.join(root, "report.json"); await writeFile(file, '{"report":"rescued"}');
  await db.insert(companies).values({ id: companyId, name: "Owner promotion", issuePrefix: companyId.slice(0, 8), workProductRoot: root });
  await db.insert(agents).values({ id: ownerAgentId, companyId, name: "Owner", status: "active" });
  await db.insert(missions).values({ id: missionId, companyId, title: "Rescued report", ownerAgentId, status: "active" });
  await db.insert(issues).values([
    { id: sourceIssueId, companyId, missionId, title: "Report", originKind: "workflow_execution", status: "done" },
    { id: unblockIssueId, companyId, missionId, title: "Unblock report", originKind: "mission_main_executor_unblock",
      originId: sourceIssueId, assigneeAgentId: ownerAgentId, status: "in_progress" },
    { id: ownerIssueId, companyId, missionId, title: "Consumer recovery", originKind: "mission_main_executor_unblock",
      originId: sourceIssueId, assigneeAgentId: ownerAgentId, status: "done" },
  ]);
  await db.insert(heartbeatRuns).values([
    { id: delegatedHeartbeatId, companyId, agentId: ownerAgentId, issueId: unblockIssueId, status: "succeeded" },
    { id: heartbeatRunId, companyId, agentId: ownerAgentId, issueId: ownerIssueId, status: "succeeded" },
  ]);
  await db.update(issues).set({ checkoutRunId: delegatedHeartbeatId }).where(eq(issues.id, unblockIssueId));
  const product = (await workProductService(db).createForIssue(sourceIssueId, companyId, {
    type: "document", title: "report.json", provider: "local_file", status: "active", metadata: { path: file },
    createdByRunId: delegatedHeartbeatId,
  }, { kind: "mission_owner_unblock_source", issueId: unblockIssueId }))!;
  // A prior unblock has settled: its live checkout is released, but immutable provenance remains.
  await db.update(issues).set({ status: "done", checkoutRunId: null }).where(eq(issues.id, unblockIssueId));
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
  await db.insert(workflowStepRuns).values({ workflowRunId: run.id, stepId: "report", issueId: sourceIssueId, status: "completed" });
  const [consumer] = await db.insert(workflowStepRuns).values({ workflowRunId: run.id, stepId: "inspect", status: "pending" }).returning();
  setWorkflowToolStepExecutor(async r => {
    const result = await executeCoreWorkflowTool({ db, companyId: r.companyId, agentId: r.agentId,
      toolName: r.toolName, parameters: r.args ?? {}, requestId: r.requestId,
      workflowRunId: r.workflowRunId, stepRunId: r.stepRunId, stepId: r.stepId });
    await completeWorkflowToolStepFromResult(db, { companyId: r.companyId, workflowRunId: r.workflowRunId,
      stepRunId: r.stepRunId, stepId: r.stepId, requestId: r.requestId, toolName: r.toolName,
      success: result.status === 200, data: result.body.data, stdout: result.body.content ?? "", error: result.body.error });
    return { accepted: true };
  });
  await syncWorkflowRunState(db, run.id);
  const failed = await stepRow(consumer.id);
  expect(failed.status).toBe("failed");
  expect(failed.metadata.toolInvocation).toMatchObject({ dispatchError: "workproduct_selector_provenance_missing" });
  await db.update(workflowRuns).set({ status: "failed" }).where(eq(workflowRuns.id, run.id));
  const [failedRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id));
  const decisions = await db.select().from(workflowTerminalDecisions).where(eq(workflowTerminalDecisions.workflowRunId, run.id));
  if (!decisions.length) await db.insert(workflowTerminalDecisions).values({ companyId, workflowRunId: run.id,
    decidedAuthorityVersion: failedRun.dispatchAuthorityVersion, decision: "failed", policyCause: "recovery_deadline_hard",
    discoveryPath: "stuck_diagnostic", origin: "reconciler" });
  const body = { schemaVersion: 1 as const, missionId, ownerActionIssueId: ownerIssueId,
    actionRequestId: randomUUID(), expectedIntentEventId: null, ownerDecisionEventId: null,
    action: { operation: "promote_unblock_product" as const, productId: product.id, producerStepId: "report",
      target: { kind: "tool_step" as const, workflowRunId: run.id, stepRunId: consumer.id,
        expectedAuthorityVersion: failedRun.dispatchAuthorityVersion, expectedExecutionGeneration: failed.executionGeneration,
        failedDispatchRequestId: failed.lastDispatchRequestId } } };
  const call = (parameters: unknown = body) => executeCoreWorkflowTool({ db, companyId, agentId: ownerAgentId,
    heartbeatRunId, toolName: "mission_owner_execute", requestId: randomUUID(), parameters });
  const readProduct = async () => (await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, product.id)))[0]!;
  const events = () => db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowRunId, run.id));
  const authorities = () => db.select().from(workflowRecoveryAuthorities).where(eq(workflowRecoveryAuthorities.workflowRunId, run.id));
  return { companyId, missionId, ownerAgentId, sourceIssueId, unblockIssueId, ownerIssueId, heartbeatRunId,
    delegatedHeartbeatId, run, consumer, product, file, body, call, readProduct, events, authorities };
}

it("promotes prior unblock provenance and recovers the exact failed consumer through real dispatch, with idempotent replay", async () => {
  const s = await seed();
  const result = await s.call();
  expect(result.status).toBe(200);
  const action = result.body.data as { actionId: string; state: string };
  expect(action.state).toBe("executing");
  expect((await s.readProduct()).metadata!.workflowProducerDelegatedOrigin).toEqual(s.product.metadata!.workflowProducer);
  expect((await s.readProduct()).metadata!.workflowProducerPromotion).toMatchObject({
    promotedBy: { actorType: "mission_owner", actorId: s.ownerAgentId } });
  expect((await s.events()).filter(e => (e.payload as { transition?: string })?.transition === "delegated_producer_promoted")).toHaveLength(1);
  expect(await s.authorities()).toHaveLength(1);
  await processQueuedWorkflowToolStepRuns(db);
  const completed = await stepRow(s.consumer.id);
  expect(completed.status, JSON.stringify(completed.metadata)).toBe("completed");
  expect(completed.metadata.toolResult).toMatchObject({ success: true, data: { report: "rescued" } });
  expect((await getMissionOwnerActionResult({ db, companyId: s.companyId, agentId: s.ownerAgentId,
    heartbeatRunId: s.heartbeatRunId }, { schemaVersion: 1, missionId: s.missionId, actionId: action.actionId })).state).toBe("resolved");
  expect((await s.call()).body.data).toMatchObject({ actionId: action.actionId, state: "resolved" });
  expect(await s.authorities()).toHaveLength(1);
});

it.each(["wrong_product", "wrong_producer", "wrong_mission", "origin_mission", "origin_source", "source_kind",
  "unblock_kind", "unblock_source", "unblock_mission", "heartbeat_issue", "heartbeat_owner", "product_heartbeat",
  "current_checkout", "normal_product", "normal_with_origin", "archived", "nonlocal", "unreadable",
  "not_failed", "wrong_error", "stale_authority", "stale_generation", "stale_request", "retry_exhausted", "missing_decision",
  "wrong_selector_product"])('refuses %s without promotion, reset, queue or recovery authority', async variant => {
  const s = await seed();
  const body = { ...s.body, action: { ...s.body.action, target: { ...s.body.action.target } } };
  const metadata = { ...s.product.metadata! };
  const origin = metadata.workflowProducer as Record<string, unknown>;
  if (variant === "wrong_product") body.action.productId = randomUUID();
  if (variant === "wrong_producer") body.action.producerStepId = "missing";
  if (variant === "wrong_mission") body.missionId = randomUUID();
  if (variant === "origin_mission" || variant === "origin_source") metadata.workflowProducer = { ...origin,
    [variant === "origin_mission" ? "missionId" : "sourceIssueId"]: randomUUID() };
  if (variant === "normal_product" || variant === "normal_with_origin") {
    const producer = (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, s.run.id))).find(r => r.stepId === "report")!;
    metadata.workflowProducer = { schemaVersion: "workflow.work-product-producer.v1", companyId: s.companyId,
      missionId: s.missionId, workflowRunId: s.run.id, stepRunId: producer.id, stepId: "report",
      executionGeneration: producer.executionGeneration, retryCount: 0, iterationIndex: 0, heartbeatRunId: s.delegatedHeartbeatId };
    if (variant === "normal_with_origin") metadata.workflowProducerDelegatedOrigin = origin;
  }
  await db.update(issueWorkProducts).set({ metadata,
    ...(variant === "archived" ? { status: "archived" } : {}),
    ...(variant === "nonlocal" ? { provider: "remote" } : {}),
    ...(variant === "product_heartbeat" ? { createdByRunId: s.heartbeatRunId } : {}),
    ...(variant === "wrong_selector_product" ? { title: "other.json" } : {}),
  }).where(eq(issueWorkProducts.id, s.product.id));
  if (variant === "source_kind") await db.update(issues).set({ originKind: "manual" }).where(eq(issues.id, s.sourceIssueId));
  if (variant.startsWith("unblock_") || variant === "current_checkout") {
    await db.update(issues).set({
      ...(variant === "unblock_kind" ? { originKind: "manual" } : {}),
      ...(variant === "unblock_source" ? { originId: s.ownerIssueId } : {}),
      ...(variant === "unblock_mission" ? { missionId: null } : {}),
      ...(variant === "current_checkout" ? { status: "in_progress", checkoutRunId: s.heartbeatRunId } : {}),
    }).where(eq(issues.id, s.unblockIssueId));
  }
  if (variant === "heartbeat_issue") await db.update(heartbeatRuns).set({ issueId: s.ownerIssueId }).where(eq(heartbeatRuns.id, s.delegatedHeartbeatId));
  if (variant === "heartbeat_owner") {
    const other = randomUUID(); await db.insert(agents).values({ id: other, companyId: s.companyId, name: "Other" });
    await db.update(heartbeatRuns).set({ agentId: other }).where(eq(heartbeatRuns.id, s.delegatedHeartbeatId));
  }
  if (variant === "unreadable") await rm(s.file);
  if (variant === "not_failed") await db.update(workflowStepRuns).set({ status: "pending" }).where(eq(workflowStepRuns.id, s.consumer.id));
  if (variant === "wrong_error" || variant === "retry_exhausted") {
    const row = await stepRow(s.consumer.id);
    await db.update(workflowStepRuns).set({ metadata: { ...row.metadata,
      ...(variant === "wrong_error" ? { toolInvocation: { dispatchError: "workproduct_selector_stale_producer" } } : { workflowRetryExhaustion: {} }),
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
  expect(result.status).toBe(variant === "wrong_mission" ? 404 : 409);
  expect(await snapshot()).toBe(before);
});

it("concurrent identical requests consume one authority and write one promotion", async () => {
  const s = await seed();
  const results = await Promise.all([s.call(), s.call()]);
  expect(results.map(r => r.status)).toEqual([200, 200]);
  const first = results[0].body.data as { actionId: string };
  expect(results[1].body.data).toMatchObject({ actionId: first.actionId, state: "executing" });
  expect(await s.authorities()).toHaveLength(1);
  expect((await s.events()).filter(e => (e.payload as { transition?: string })?.transition === "delegated_producer_promoted")).toHaveLength(1);
  await processQueuedWorkflowToolStepRuns(db);
  expect((await stepRow(s.consumer.id)).status).toBe("completed");
});

it("replay delivers only the existing receipt after a delivery interruption", async () => {
  const s = await seed(); const first = await s.call(); expect(first.status).toBe(200);
  const row = await stepRow(s.consumer.id);
  await db.update(workflowStepRuns).set({ status: "pending", startedAt: null, lastDispatchRequestId: null,
    lastDispatchAcceptedAt: null, metadata: { ownerToolRetry: row.metadata.ownerToolRetry } }).where(eq(workflowStepRuns.id, row.id));
  const replay = await s.call(); expect(replay.status).toBe(200);
  expect(replay.body.data).toMatchObject({ actionId: (first.body.data as { actionId: string }).actionId, state: "executing" });
  expect(await s.authorities()).toHaveLength(1);
  expect((await stepRow(row.id)).executionGeneration).toBe(row.executionGeneration);
  await processQueuedWorkflowToolStepRuns(db); expect((await stepRow(row.id)).status).toBe("completed");
});

it("selector still rejects changed promoted bytes and board promotion remains unchanged", async () => {
  const s = await seed();
  await promoteDelegatedProducerProvenance(db, { companyId: s.companyId, workflowRunId: s.run.id,
    producerStepId: "report", productId: s.product.id, actor: { actorType: "board", actorId: "local-board" } });
  expect((await s.readProduct()).metadata!.workflowProducerPromotion).toMatchObject({ promotedBy: { actorType: "board" } });
  const select = () => selectOfficialWorkProduct(db, { companyId: s.companyId, workflowRunId: s.run.id,
    stepId: "report", selector: { type: "document", title: "report.json" } });
  await expect(select()).resolves.toMatchObject({ product: { id: s.product.id } });
  await writeFile(s.file, "changed"); await expect(select()).rejects.toThrow("workproduct_selector_promotion_bytes_mismatch");
  await writeFile(s.file, '{"report":"rescued"}');
  expect((await s.call()).status).toBe(200); // Valid existing board marker is reused, never rewritten as owner production.
  expect((await s.readProduct()).metadata!.workflowProducerPromotion).toMatchObject({ promotedBy: { actorType: "board" } });
  await processQueuedWorkflowToolStepRuns(db);
});

it("revalidates the failure identity after a competing locked mutation, without promotion", async () => {
  const s = await seed();
  let pending: ReturnType<typeof s.call> | undefined;
  await db.transaction(async tx => {
    await tx.select().from(workflowRuns).where(eq(workflowRuns.id, s.run.id)).for("update");
    pending = s.call();
    // Durable intent confirms preflight finished; application is blocked at the held run lock.
    for (let i = 0; i < 200; i++) {
      const intents = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.issueId, s.ownerIssueId));
      if (intents.some(e => e.eventType === "owner_execute_intent_v1")) break;
      if (i === 199) throw new Error("owner intent did not reach the locked application");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await tx.update(workflowStepRuns).set({ executionGeneration: s.body.action.target.expectedExecutionGeneration + 1 })
      .where(eq(workflowStepRuns.id, s.consumer.id));
  });
  const result = await pending!;
  expect(result.status).toBe(409); expect(result.body.error).toBe("stale_generation");
  expect((await s.readProduct()).metadata!.workflowProducerPromotion).toBeUndefined();
  expect(await s.authorities()).toHaveLength(0);
  expect((await stepRow(s.consumer.id)).status).toBe("failed");
});

it("does not promote another target on conflicting request replay or auto-complete a failed consumer execution", async () => {
  const s = await seed(); const first = await s.call(); expect(first.status).toBe(200);
  const conflict = await s.call({ ...s.body, action: { ...s.body.action, productId: randomUUID() } });
  expect(conflict.status).toBe(409); expect(conflict.body.error).toBe("action_request_conflict");
  await writeFile(path.join(path.dirname(s.file), "inspect.mjs"), "process.exit(1);");
  await processQueuedWorkflowToolStepRuns(db);
  expect((await stepRow(s.consumer.id)).status).toBe("failed");
  const result = await getMissionOwnerActionResult({ db, companyId: s.companyId, agentId: s.ownerAgentId,
    heartbeatRunId: s.heartbeatRunId }, { schemaVersion: 1, missionId: s.missionId, actionId: (first.body.data as { actionId: string }).actionId });
  expect(result.state).not.toBe("resolved"); expect(await s.authorities()).toHaveLength(1);
});

it("requires exact product, producer and tool failure identities and surfaces the atomic recovery operation", async () => {
  const s = await seed(); expect(missionOwnerExecuteSchema.safeParse(s.body).success).toBe(true);
  for (const key of ["productId", "producerStepId"] as const) {
    const action: Record<string, unknown> = { ...s.body.action }; delete action[key];
    expect(missionOwnerExecuteSchema.safeParse({ ...s.body, action }).success).toBe(false);
  }
  expect(missionOwnerExecuteSchema.safeParse({ ...s.body, action: { ...s.body.action,
    target: { ...s.body.action.target, kind: "issue_step", issueId: s.sourceIssueId } } }).success).toBe(false);
  const description = buildToolStepRecoveryDescription({ marker: "test", missionTitle: "test", workflowName: "test",
    workflowRunId: s.run.id, stepId: "inspect", displayStepName: "Inspect", toolNames: [],
    classification: { className: "input_contract", retryPolicy: "fix_input_contract_before_retry",
      rationale: "fixture", requiredAction: "fixture", evidence: [] } });
  expect(description).toContain("promote_unblock_product"); expect(description).toContain("a refused retry rolls promotion back");
});
