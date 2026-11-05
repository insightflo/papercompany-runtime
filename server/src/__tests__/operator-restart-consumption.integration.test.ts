import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { and, eq, ne } from "drizzle-orm";
import {
  agentToolGrants, agents, companies, createDb, heartbeatRuns, issues, missions, operatorDecisions,
  toolDefinitions, workflowDefinitions, workflowRuns, workflowStepRuns,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { operatorDecisionWriteService } from "../services/operator-decisions-write.js";
import { WORKFLOW_RESTART_FROM_START_OPTION_ID } from "../services/missions/workflow-restart-option.js";
import { workflowService } from "../services/workflow/engine.js";
import { executeCoreWorkflowTool } from "../services/workflow/core-tool-executor.js";
import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";
import { createReplacementRootNotifications, withReplacementRootNotificationDb } from "../services/issue-assignment-wakeup.js";
import {
  completeWorkflowToolStepFromResult, processQueuedWorkflowToolStepRuns,
  setWorkflowToolStepExecutor, syncWorkflowRunState,
} from "../services/workflow/dag-engine.js";

let pg: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let root: string;

beforeAll(async () => {
  pg = await startEmbeddedPostgresTestDatabase("operator-restart-consume-");
  db = createDb(pg.connectionString);
  root = await mkdtemp(path.join(os.tmpdir(), "operator-restart-consume-"));
  setWorkflowToolStepExecutor(async request => {
    const result = await executeCoreWorkflowTool({ db, companyId: request.companyId,
      agentId: request.agentId, agentName: request.agentName, toolName: request.toolName,
      parameters: request.args ?? {}, requestId: request.requestId, workflowRunId: request.workflowRunId,
      stepRunId: request.stepRunId, stepId: request.stepId });
    await completeWorkflowToolStepFromResult(db, { companyId: request.companyId,
      stepRunId: request.stepRunId, workflowRunId: request.workflowRunId, stepId: request.stepId,
      requestId: request.requestId, toolName: request.toolName, success: result.status === 200,
      stdout: result.body.content ?? "", data: result.body.data, stderr: result.body.stderr ?? "",
      exitCode: result.status === 200 ? 0 : 1, error: result.body.error });
    return { accepted: true as const };
  });
}, 60_000);

afterAll(async () => {
  setWorkflowToolStepExecutor(null);
  if (db) await waitForHeartbeatExecutionsToDrain(db);
  await db?.$client.end({ timeout: 5 });
  await pg?.cleanup();
  if (root) await rm(root, { recursive: true, force: true });
});

it("rolls back a blocked restart and consumes the approved revised definition exactly once", async () => {
  const companyId = randomUUID(), agentId = randomUUID(), missionId = randomUUID();
  const workflowId = randomUUID(), sourceRunId = randomUUID(), issueId = randomUUID();
  const marker = path.join(root, "calls.txt"), script = path.join(root, "consume.mjs");
  const agentMarker = path.join(root, "agent-calls.txt"), agentScript = path.join(root, "agent.mjs");
  await writeFile(script, `import fs from 'node:fs';
const value=process.argv[process.argv.indexOf('--value')+1];
fs.appendFileSync(${JSON.stringify(marker)},value+'\\n');
console.log(JSON.stringify({consumed:value}));`);
  await writeFile(agentScript, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(agentMarker)},'started\\n'); console.log('completed');`);
  await db.insert(companies).values({ id: companyId, name: "Restart consumption", issuePrefix: "RSC", workProductRoot: root });
  await db.insert(agents).values({ id: agentId, companyId, name: "Owner", status: "idle", adapterType: "process",
    adapterConfig: { command: process.execPath, args: [agentScript], cwd: root } });
  await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId,
    title: "Restart mission", status: "active" });
  const [tool] = await db.insert(toolDefinitions).values({ companyId, name: "consume-replan",
    adapterType: "builtin", adapterConfig: { command: `${process.execPath} ${script}`, workingDirectory: root } }).returning();
  await db.insert(agentToolGrants).values({ companyId, agentId, toolId: tool!.id, grantedBy: "test" });
  await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "Restart workflow",
    stepsJson: [{ id: "old", name: "Old step", type: "agent", agentId, dependencies: [] }] });
  await db.insert(workflowRuns).values({ id: sourceRunId, workflowId, companyId, missionId,
    status: "failed", triggeredBy: "test", runDate: "2026-10-25", completedAt: new Date() });
  await db.insert(issues).values({ id: issueId, companyId, missionId, title: "[OVERSIGHT] Restart",
    status: "blocked", assigneeAgentId: agentId, originKind: "mission_main_executor_oversight" });

  // Exercise the definition update itself; no owner planning provider is invoked by this fixture.
  const revision = await workflowService.updateDefinition(db, workflowId, { steps: [
    { id: "produce", name: "Execute revised plan", type: "agent", agentId, dependencies: [] },
    { id: "consume", name: "Consume revised input", type: "tool", agentId: "",
      toolNames: ["consume-replan"], toolArgs: { value: "revised" }, dependencies: ["produce"] },
  ] });
  expect(revision?.steps).toEqual([expect.objectContaining({ id: "produce" }),
    expect.objectContaining({ id: "consume", toolNames: ["consume-replan"] })]);

  const definition = {
    options: [{ id: WORKFLOW_RESTART_FROM_START_OPTION_ID, label: "Restart", description: "Start again",
      facts: [], evidenceRefs: [] }],
    actions: [{ id: "approve", label: "Approve", outcome: "approve" as const,
      tone: "primary" as const, requiresSelection: true }],
    selection: { min: 1, max: 1 },
    comment: { mode: "optional" as const, label: "Reason", placeholder: null, maxLength: 100 },
    approvedScope: ["operator_decision.resolve", "workflow_run.restart_from_start"], forbiddenScope: [],
    humanReview: { schemaVersion: "human-review-v1" as const, decisionSubject: "Restart?",
      evidence: [{ label: "Failed run", href: `/runs/${sourceRunId}`, location: sourceRunId }],
      interpretation: "Start the revised definition.",
      impact: { ifApproved: "A fresh run starts.", ifRejected: "The mission remains blocked.",
        ifWrong: "Work can be repeated." }, unresolvedFacts: [], questions: ["Restart?"],
      recommendedNextStep: "Restart", requiredReviewer: "human-operator" },
  };
  const write = operatorDecisionWriteService(db);
  const create = (key: string) => write.create(companyId, {
    schemaVersion: 1, requestKey: key, priority: "high", interactionType: "single_select",
    title: "Restart?", description: "", sourceType: "workflow_restart_request_v1", sourceId: sourceRunId,
    sourceContext: { missionId, workflowId, workflowRunId: sourceRunId, artifactRefs: [] },
    definition, issueId, continuationMode: "none",
  }, { type: "user", id: "board-user" });
  const approval = { actionId: "approve", selectedOptionIds: [WORKFLOW_RESTART_FROM_START_OPTION_ID], comment: "approved" };
  const created = await create(`restart:${sourceRunId}`);
  const replacements = () => db.select().from(workflowRuns).where(and(
    eq(workflowRuns.missionId, missionId), ne(workflowRuns.id, sourceRunId)));
  const issue = async () => (await db.select().from(issues).where(eq(issues.id, issueId)))[0]!;
  const decision = async (id: string) => (await db.select().from(operatorDecisions).where(eq(operatorDecisions.id, id)))[0]!;

  // Real tool unavailability fails after resolving starts; the transaction must undo all three writes.
  await db.update(toolDefinitions).set({ enabled: false }).where(eq(toolDefinitions.id, tool!.id));
  await expect(write.resolve(created.decision.id, approval, "board-user"))
    .rejects.toThrow('Workflow tool "consume-replan" is unavailable.');
  expect((await decision(created.decision.id)).status).toBe("pending");
  expect((await issue()).status).toBe("blocked");
  expect(await replacements()).toHaveLength(0);
  await expect(readFile(agentMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

  await db.update(toolDefinitions).set({ enabled: true }).where(eq(toolDefinitions.id, tool!.id));
  // A savepoint without an owning notification scope must fail, never launch early.
  await expect(db.transaction(tx => operatorDecisionWriteService(tx as unknown as typeof db)
    .resolve(created.decision.id, approval, "board-user"))).rejects.toMatchObject({ code: "qa_correction_root_owner_required" });
  expect((await decision(created.decision.id)).status).toBe("pending");
  expect(await replacements()).toHaveLength(0);
  await expect(readFile(agentMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

  // A savepoint with an owner transfers the notification, but outer rollback discards the work.
  const outerNotifications = createReplacementRootNotifications();
  await expect(db.transaction(async tx => withReplacementRootNotificationDb(tx as unknown as typeof db, outerNotifications, async () => {
    expect((await operatorDecisionWriteService(tx as unknown as typeof db)
      .resolve(created.decision.id, approval, "board-user")).applied).toBe(true);
    expect(outerNotifications.agentIds.has(agentId)).toBe(true);
    await expect(readFile(agentMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    throw new Error("test outer rollback");
  }))).rejects.toThrow("test outer rollback");
  expect((await decision(created.decision.id)).status).toBe("pending");
  expect((await issue()).status).toBe("blocked");
  expect(await replacements()).toHaveLength(0);
  await expect(readFile(agentMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

  // Hold the actual transaction after it queues the first step but before commit.
  const lock = await db.$client.reserve(), lockKey = 78432312;
  const [{ pid }] = await lock`select pg_backend_pid() as pid`;
  await lock`select pg_advisory_lock(${lockKey})`;
  const trigger = `restart_gate_${companyId.replaceAll("-", "")}`;
  await db.$client.unsafe(`create function ${trigger}() returns trigger language plpgsql as $$ begin if NEW.company_id = '${companyId}' and NEW.action = 'workflow_run.created' then perform pg_advisory_xact_lock(${lockKey}); end if; return NEW; end $$`);
  await db.$client.unsafe(`create trigger ${trigger} before insert on activity_log for each row execute function ${trigger}()`);
  let lockHeld = true;
  const resolving = write.resolve(created.decision.id, approval, "board-user");
  void resolving.catch(() => {});
  try {
    const deadline = Date.now() + 20_000;
    let blocked = false;
    while (Date.now() < deadline && !blocked) {
      const rows = await db.$client`select pg_blocking_pids(pid) as blockers from pg_stat_activity where datname = current_database()`;
      blocked = rows.some(row => (row.blockers as number[]).includes(Number(pid)));
      if (!blocked) await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(blocked).toBe(true);
    expect((await decision(created.decision.id)).status).toBe("pending");
    expect((await issue()).status).toBe("blocked");
    expect(await replacements()).toHaveLength(0);
    await expect(readFile(agentMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await lock`select pg_advisory_unlock(${lockKey})`;
    lockHeld = false;
    expect((await resolving).applied).toBe(true);
  } finally {
    if (lockHeld) await lock`select pg_advisory_unlock(${lockKey})`;
    await resolving.catch(() => {});
    lock.release();
    await db.$client.unsafe(`drop trigger ${trigger} on activity_log`);
    await db.$client.unsafe(`drop function ${trigger}()`);
  }
  expect((await decision(created.decision.id)).status).toBe("resolved");
  expect((await issue()).status).toBe("todo");
  const [replacement] = await replacements();
  expect(await replacements()).toHaveLength(1);
  expect(replacement!.metadata).toMatchObject({ operatorDecisionRestart: {
    operatorDecisionId: created.decision.id, sourceWorkflowRunId: sourceRunId } });
  const stepRows = () => db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, replacement!.id));
  await waitForHeartbeatExecutionsToDrain(db);
  const agentRuns = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)));
  const producer = (await stepRows()).find(row => row.stepId === "produce");
  expect(producer?.issueId).toBeTruthy();
  expect(agentRuns).toHaveLength(1);
  expect(agentRuns[0]).toMatchObject({ status: "succeeded", issueId: producer!.issueId });
  expect(await readFile(agentMarker, "utf8")).toBe("started\n");
  await syncWorkflowRunState(db, replacement!.id);
  expect((await processQueuedWorkflowToolStepRuns(db)).executedCount).toBe(1);
  await syncWorkflowRunState(db, replacement!.id);
  const step = (await stepRows()).find(row => row.stepId === "consume");
  expect(step).toMatchObject({ stepId: "consume", status: "completed",
    metadata: { toolResult: { success: true, data: { consumed: "revised" } } } });
  expect(await readFile(marker, "utf8")).toBe("revised\n");
  expect((await replacements())[0]).toMatchObject({ id: replacement!.id, status: "completed" });

  const duplicate = await create(`restart-duplicate:${sourceRunId}`);
  await expect(write.resolve(duplicate.decision.id, approval, "board-user")).rejects.toMatchObject({
    status: 409, message: "workflow_restart_active_replacement_exists" });
  expect((await decision(duplicate.decision.id)).status).toBe("pending");
  expect(await replacements()).toHaveLength(1);
  await processQueuedWorkflowToolStepRuns(db);
  expect(await readFile(marker, "utf8")).toBe("revised\n");
  expect(await readFile(agentMarker, "utf8")).toBe("started\n");
  console.info("T16A_M06_EVIDENCE", JSON.stringify({ companyId, missionId, sourceRunId,
    decisionId: created.decision.id, replacementRunId: replacement!.id, producerStepRunId: producer!.id,
    consumerStepRunId: step!.id, heartbeatRunId: agentRuns[0]!.id,
    transactionBlockedBeforeCommit: true, agentCalls: 1, toolCalls: 1, replacementStatus: "completed" }));
}, 60_000);
