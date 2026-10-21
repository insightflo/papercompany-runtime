import { randomUUID } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { and, eq, inArray, is, sql } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, costEvents, heartbeatRuns, issueComments, issueWorkProducts, issues, missions,
  workflowDefinitions, workflowRuns, workflowStepOutputBindings, workflowTerminalDecisions,
  agents, agentWakeupRequests, workflowStepRuns, workflowTransitionEvents, type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
const { heartbeatWakeup, actualDelivery, adapter } = vi.hoisted(() => ({
  heartbeatWakeup: vi.fn(), actualDelivery: { enabled: false }, adapter: vi.fn(),
}));
vi.mock("../adapters/index.js", async original => ({
  ...await original<typeof import("../adapters/index.js")>(),
  getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute: adapter }),
}));
vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return { ...actual, heartbeatService: (...args: Parameters<typeof actual.heartbeatService>) =>
    actualDelivery.enabled ? actual.heartbeatService(...args) : { wakeup: heartbeatWakeup } };
});
vi.mock("../services/issue-assignment-wakeup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/issue-assignment-wakeup.js")>();
  return {
    ...actual,
    queueIssueAssignmentWakeup: (input: Parameters<typeof actual.queueIssueAssignmentWakeup>[0]) =>
      actualDelivery.enabled ? actual.queueIssueAssignmentWakeup(input)
        : actual.queueIssueAssignmentWakeup({ ...input, heartbeat: { wakeup: heartbeatWakeup } }),
  };
});
import {
  cleanupFrozenTables, createFrozenRun, markRunStatus, seedCompanyWithMission,
  seedWorkflowDefinition, startExecutionDefinitionFixture, stepRunsOf,
  type ExecutionDefinitionFixture,
} from "./helpers/workflow-frozen-execution-fixture.js";
import { syncWorkflowRunForIssue, syncWorkflowRunState } from "../services/workflow/dag-engine.js";
import { createCommitSourceHarness, makeCommitSource, commitDbState } from "./qa-correction-commit-fixture.js";
import { appendQaVerdict } from "./helpers/qa-correction-fixture.js";
import { admittedProducer } from "./helpers/admitted-producer.js";
import { recordMissionOwnerDecision } from "../services/missions/mission-owner-recovery-ledger.js";
import { proposeReplacement, approveReplacement } from "../services/workflow/replacement-approval.js";
import { admitReplacement } from "../services/workflow/replacement-admission.js";
import { claimPlainWorkflowStart } from "../services/workflow/plain-start-claim.js";
import { activatePlanningMissionForWorkflowRun } from "../services/missions/mission-workflow-lifecycle.js";
import { parseQaCorrectionEventPayload, qaCorrectionDeliverySchema } from "../services/workflow/control-flow/qa-correction-contract.js";
import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";
import * as artifactWriter from "../services/workflow/artifact-writer.js";
const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping C02 extraction test: ${support.reason ?? "unsupported environment"}`);
describeEP("C02 stage 1: preserve validation recheck delivery boundary", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;
  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("c02-delivery-");
    if (!started.supported) throw new Error(started.reason);
    fixture = started;
    db = fixture.db;
  }, 60_000);
  afterEach(async () => {
    heartbeatWakeup.mockReset();
    await db.delete(heartbeatRuns);
    await cleanupFrozenTables(db);
  });
  afterAll(async () => {
    if (fixture?.supported) await fixture.cleanup();
  });
  // C02 stage-1 extraction map and workflow-dag-engine.test.ts recheck/current-workProduct/
  // succeeded-heartbeat cases define these preservation expectations; no queue/claim/QA proof is asserted.
  it("preserves fresh-session wake arguments, current artifact comments, activity and repeated sync behavior", async () => {
    const { companyId, agentId, missionId } = await seedCompanyWithMission(fixture.sql, "C02D");
    await db.update(missions).set({ status: "active" }).where(eq(missions.id, missionId));
    const workflowId = await seedWorkflowDefinition(fixture.sql, {
      companyId,
      name: "c02-validation-recheck",
      stepsJson: [
        { id: "produce", name: "Produce artifact", agentId, dependencies: [] },
        { id: "qa", type: "qa", qaType: "semantic", name: "[QA] Validate artifact", agentId, dependencies: ["produce"] },
        { id: "approve", name: "Approve artifact", agentId, dependencies: ["qa"] },
      ],
    });
    const run = await createFrozenRun(db, { workflowId, companyId, missionId });
    await markRunStatus(db, run.id, "running");
    const startedAt = new Date("2026-06-18T07:01:00.000Z");
    const oldCompletedAt = new Date("2026-06-18T07:05:00.000Z");
    const rejectedAt = new Date("2026-06-18T07:10:00.000Z");
    const producerCompletedAt = new Date("2026-06-18T07:15:00.000Z");
    const producerIssueId = randomUUID();
    const qaIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: producerIssueId, companyId, missionId, title: "Produce artifact",
        status: "done", assigneeAgentId: agentId, originKind: "workflow_execution",
        originId: run.id, originRunId: run.id, startedAt, completedAt: oldCompletedAt,
      },
      {
        id: qaIssueId, companyId, missionId, title: "[QA] Validate artifact",
        status: "blocked", assigneeAgentId: agentId, originKind: "workflow_execution",
        originId: run.id, originRunId: run.id, startedAt,
        description: "Dependency workProducts: none registered",
      },
    ]);
    const stepRows = await db.insert(workflowStepRuns).values([
      { workflowRunId: run.id, stepId: "produce", issueId: producerIssueId, status: "completed", startedAt, completedAt: oldCompletedAt },
      { workflowRunId: run.id, stepId: "qa", issueId: qaIssueId, status: "failed", startedAt, completedAt: rejectedAt },
      { workflowRunId: run.id, stepId: "approve", status: "pending" },
    ]).returning();
    const qaStepRunId = stepRows.find((row) => row.stepId === "qa")!.id;
    const verdictHeartbeatId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: verdictHeartbeatId, companyId, agentId, issueId: qaIssueId,
      status: "succeeded", startedAt, finishedAt: rejectedAt,
    });
    const priorFindings = [{ id: "refresh-source", summary: "Verify the revised source", layer: "artifact" }];
    // Structured workflow_api authority bound to this exact company/issue/run/step and QA heartbeat.
    await db.insert(workflowTransitionEvents).values({
      companyId, missionId, workflowRunId: run.id, workflowStepRunId: qaStepRunId,
      issueId: qaIssueId, heartbeatRunId: verdictHeartbeatId,
      eventType: "workflow_validation_verdict", layer: "workflow_validation",
      verdict: "request_changes", decision: "request_changes", reason: "workflow_api", reasonCode: "workflow_api",
      idempotencyKey: `c02-rejection:${qaStepRunId}`, createdAt: rejectedAt,
      payload: {
        kind: "workflow_validation_verdict", workflowRunId: run.id, stepRunId: qaStepRunId,
        issueId: qaIssueId, verdict: "request_changes", diagnostics: [], findings: priorFindings,
      },
    });
    heartbeatWakeup.mockResolvedValue({ id: "c02-boundary-only" });
    const recheckComments = async () => (await db.select().from(issueComments)
      .where(eq(issueComments.issueId, qaIssueId)))
      .filter((comment) => comment.body.includes("Workflow validation recheck"));
    const recheckActivities = async () => db.select().from(activityLog).where(and(
      eq(activityLog.entityId, qaIssueId),
      eq(activityLog.action, "workflow.validation_recheck_queued"),
    ));
    // Counterexample: completion predates the official rejection, so no fresh-input recheck.
    await syncWorkflowRunForIssue(db, producerIssueId);
    expect(heartbeatWakeup).not.toHaveBeenCalled();
    expect(await recheckComments()).toHaveLength(0);
    expect(await recheckActivities()).toHaveLength(0);
    const reportPath = "/srv/papercompany/produced_work/c02-current-report.md";
    await db.insert(issueWorkProducts).values({
      companyId, issueId: producerIssueId, type: "file", provider: "local",
      externalId: reportPath, title: "c02-current-report.md", status: "active",
      isPrimary: true, metadata: { path: reportPath },
    });
    await db.update(issues).set({ completedAt: producerCompletedAt }).where(eq(issues.id, producerIssueId));
    const result = await syncWorkflowRunForIssue(db, producerIssueId);
    expect(result?.status).toBe("running");
    expect(heartbeatWakeup).toHaveBeenCalledTimes(1);
    expect(heartbeatWakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      source: "assignment", triggerDetail: "system", reason: "workflow_step_runnable",
      requestedByActorType: "system", requestedByActorId: `workflow:${workflowId}`,
      payload: expect.objectContaining({
        issueId: qaIssueId, mutation: "workflow_resume", missionId,
        workflowRunId: run.id, workflowDefinitionId: workflowId,
        stepId: "qa", workflowStepRunId: qaStepRunId, forceFreshSession: true,
        priorQaFindings: priorFindings,
      }),
      contextSnapshot: expect.objectContaining({
        issueId: qaIssueId, taskId: qaIssueId, source: "workflow.resume", missionId,
        workflowRunId: run.id, workflowDefinitionId: workflowId,
        workflowStepId: "qa", stepId: "qa", workflowStepRunId: qaStepRunId,
        wakeReason: "workflow_step_runnable", forceFreshSession: true,
      }),
    }));
    const [comment] = await recheckComments();
    expect(await recheckComments()).toHaveLength(1);
    expect(comment!.body).toContain("c02-current-report.md [file/active]");
    expect(comment!.body).toContain(reportPath);
    expect(comment!.body).toContain("[artifact] refresh-source: Verify the revised source");
    expect(comment!.body).not.toContain("has no registered dependency workProduct");
    const [activity] = await recheckActivities();
    expect(await recheckActivities()).toHaveLength(1);
    expect(activity).toMatchObject({
      companyId, actorType: "system", actorId: "workflow:validation-recheck",
      entityType: "issue", entityId: qaIssueId,
      details: {
        workflowRunId: run.id, workflowStepRunId: qaStepRunId, stepId: "qa",
        dependencyStepIds: ["produce"], reason: "dependency_completed_after_request_changes",
        requestChangesObservedAt: rejectedAt.toISOString(),
      },
    });
    const [qaIssue] = await db.select().from(issues).where(eq(issues.id, qaIssueId));
    expect(qaIssue).toMatchObject({ status: "blocked", description: "Dependency workProducts: none registered" });
    expect((await stepRunsOf(db, run.id)).find((row) => row.stepId === "qa")?.status).toBe("failed");
    // Preserve today's boundary: a returned wake result alone does not suppress the next sync.
    await syncWorkflowRunForIssue(db, producerIssueId);
    expect(heartbeatWakeup).toHaveBeenCalledTimes(2);
    expect(await recheckComments()).toHaveLength(2);
    expect(await recheckActivities()).toHaveLength(2);
    // Existing succeeded-heartbeat suppression is preserved; it is not proof of current-input QA.
    await db.insert(heartbeatRuns).values({
      companyId, agentId, issueId: qaIssueId, status: "succeeded",
      startedAt: producerCompletedAt, finishedAt: new Date("2026-06-18T07:16:00.000Z"),
    });
    await syncWorkflowRunForIssue(db, producerIssueId);
    expect(heartbeatWakeup).toHaveBeenCalledTimes(2);
    expect(await recheckComments()).toHaveLength(2);
    expect(await recheckActivities()).toHaveLength(2);
  });
});
describeEP("C02 14A: real replacement rejection to immutable correction delivery", () => {
  let owned: Awaited<ReturnType<typeof createCommitSourceHarness>>; afterAll(async () => { if (owned) await owned.close(); });
  it("unwinds nested locks, retries storage and delivers one issued B after first-delivery commit", async () => {
    owned = await createCommitSourceHarness(); const peer = owned.connect(); const s = await makeCommitSource(owned.db, owned.root, "content-only"), original = await readFile(s.file);
    const [source] = await owned.db.select().from(workflowRuns).where(eq(workflowRuns.id, s.p.workflowRunId)); const [definition] = await owned.db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, source!.workflowId));
    const [producerHb] = await owned.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, s.f.producerHeartbeatId)); const [qaHb] = await owned.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, s.f.verdictHeartbeatId));
    const steps = (definition!.stepsJson as Array<Record<string, unknown>>).map(raw => {
      const { toolArtifactContract: _contract, ...step } = raw; return step; });
    await owned.db.update(workflowDefinitions).set({ stepsJson: steps }).where(eq(workflowDefinitions.id, definition!.id));
    await owned.db.update(workflowRuns).set({ status: "failed" }).where(eq(workflowRuns.id, source!.id));
    await owned.db.update(agentWakeupRequests).set({ status: "completed" }).where(eq(agentWakeupRequests.companyId, s.p.companyId));
    await owned.db.insert(workflowTerminalDecisions).values({ companyId: s.p.companyId, workflowRunId: source!.id,
      decidedAuthorityVersion: 0, decision: "failed", policyCause: "recovery_deadline_hard", discoveryPath: "stuck_diagnostic", origin: "reconciler", reason: "test", recoveryGate: {} });
    const owner = await recordMissionOwnerDecision({ db: owned.db, issue: { id: s.p.producer.issueId,
      companyId: s.p.companyId, missionId: s.p.missionId }, heartbeatRunId: s.f.producerHeartbeatId, submission: {
      decision: "restart_from_start", recoveryTarget: { kind: "tool_step", workflowRunId: source!.id, stepRunId: s.f.qa.id,
        expectedAuthorityVersion: 0, expectedExecutionGeneration: 0, failedDispatchRequestId: s.request.requestId } } });
    const board = { type: "board", source: "local_implicit", userId: "local-board", isInstanceAdmin: true } as const;
    const approval = await proposeReplacement(owned.db, s.p.companyId, board, { sourceRunId: source!.id,
      decisionEventId: owner.eventId, idempotencyKey: "c02-14a", metadata: {}, externalEffects: "operator_reconciled" });
    await approveReplacement(owned.db, s.p.companyId, approval.id, board); const target = (await admitReplacement(owned.db, { workflowId: source!.workflowId, companyId: s.p.companyId,
      missionId: s.p.missionId, triggeredBy: "agent", metadata: {}, replacementIntent: { schemaVersion: 1, sourceRunId: source!.id,
        expectedSourceAuthorityVersion: 0, decisionEventId: owner.eventId, approvalId: approval.id, idempotencyKey: "c02-14a" } },
      { type: "agent", agentId: producerHb!.agentId, companyId: s.p.companyId })).run;
    expect(await claimPlainWorkflowStart(owned.db, target.id, { activateMission: activatePlanningMissionForWorkflowRun } as never)).toBe("started");
    const before = new Date(Date.now() - 1000), now = new Date(); const issueRows = await owned.db.insert(issues).values([producerHb!, qaHb!].map((hb, i) => ({
      companyId: s.p.companyId, missionId: s.p.missionId, title: i ? "[QA] Check" : "Produce", status: "done",
      assigneeAgentId: hb.agentId, originKind: "workflow_execution", originRunId: target.id, completedAt: i ? now : before }))).returning();
    const rows = await owned.db.insert(workflowStepRuns).values(issueRows.map((issue, i) => ({
      workflowRunId: target.id, stepId: i ? "qa-check" : "produce", issueId: issue.id,
      status: i ? "running" : "completed", completedAt: i ? null : before }))).returning();
    const producer = rows.find(r => r.stepId === "produce")!, qa = rows.find(r => r.stepId === "qa-check")!, producerId = randomUUID();
    await admittedProducer(owned.db, { companyId: s.p.companyId, agentId: producerHb!.agentId, issueId: producer.issueId, stepRunId: producer.id, heartbeatId: producerId });
    await owned.db.update(agentWakeupRequests).set({ status: "completed" }).where(eq(agentWakeupRequests.companyId, s.p.companyId));
    await owned.db.update(issueWorkProducts).set({ issueId: producer.issueId!, createdByRunId: producerId,
      metadata: { path: s.file, workflowProducer: { ...s.producer, workflowRunId: target.id, stepRunId: producer.id, heartbeatRunId: producerId } } }).where(eq(issueWorkProducts.id, s.productId));
    await owned.db.insert(workflowStepOutputBindings).values({ companyId: s.p.companyId, workflowRunId: target.id,
      consumerStepRunId: qa.id, referencedStepId: "produce", workProductId: s.productId });
    const verdict = await appendQaVerdict(owned.db, { ...s.f, producer, qa, preparation: { ...s.p, workflowRunId: target.id } }, "request_changes");
    await owned.db.update(heartbeatRuns).set({ createdAt: now }).where(eq(heartbeatRuns.id, verdict.heartbeatRunId)); await owned.db.update(workflowTransitionEvents).set({ createdAt: now }).where(eq(workflowTransitionEvents.id, verdict.eventId));
    await owned.db.update(agentWakeupRequests).set({ status: "completed" }).where(eq(agentWakeupRequests.companyId, s.p.companyId));
    await owned.db.update(agents).set({ status: "active", adapterType: "codex_local", adapterConfig: { cwd: owned.root },
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(inArray(agents.id, [producerHb!.agentId, qaHb!.agentId]));
    actualDelivery.enabled = true; vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk"); vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", path.join(owned.root, "storage"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "11".repeat(32)); let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    const executed: Array<{ heartbeatRunId: string; agentId: string; wakeupRequestId: string | null; ref: unknown }> = [];
    const dbKinds = { root: owned.db.constructor.name, peer: peer.constructor.name, nested: "" }; expect(is(owned.db, PgTransaction)).toBe(false);
    let notifiedAfterCommit = false; adapter.mockImplementation(async (ctx: { runId: string; agent: { id: string } }) => {
      const [running] = await peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, ctx.runId)); const [wake] = running?.wakeupRequestId ? await peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, running.wakeupRequestId)) : [];
      executed.push({ heartbeatRunId: ctx.runId, agentId: ctx.agent.id, wakeupRequestId: running?.wakeupRequestId ?? null, ref: wake?.payload?.qaCorrectionFollowup ?? null });
      const [committed] = await peer.select().from(workflowRuns).where(eq(workflowRuns.id, target.id)); notifiedAfterCommit = Boolean((committed?.metadata.replacementStart as Record<string, unknown> | undefined)?.deliveredAt);
      await held; return { exitCode: 1, signal: null, timedOut: false, errorMessage: "isolated", usage: null, provider: "test", model: "test", resultJson: null, runtimeServices: [] };
    });
    const sync = (db: Db = owned.db) => syncWorkflowRunState(db, target.id); const events = () => peer.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowRunId, target.id));
    const receipt = async () => (await peer.select().from(workflowRuns).where(eq(workflowRuns.id, target.id)))[0]!.metadata.replacementStart as Record<string, unknown>;
    const originalWriter = artifactWriter.createArtifactDirectory, failure = Error("C02 storage fault"); let fail = true; const writer = vi.spyOn(artifactWriter, "createArtifactDirectory").mockImplementation(async (...args) => {
      await peer.transaction(async tx => { await tx.execute(sql`SET LOCAL lock_timeout='250ms'`);
        await tx.execute(sql`select id from missions where id=${s.p.missionId} for update nowait`);
        await tx.execute(sql`select id from workflow_runs where id=${target.id} for update nowait`); });
      if (fail) { fail = false; throw failure; } return originalWriter(...args);
    });
    try {
      await expect(owned.db.transaction(tx => { dbKinds.nested = tx.constructor.name; expect(is(tx, PgTransaction)).toBe(true); return sync(tx as unknown as Db); })).rejects.toMatchObject({ request: { runId: target.id, producerStepRunId: producer.id, qaStepRunIds: [qa.id], verdictEventIds: [verdict.eventId] } });
      expect((await events()).filter(e => e.eventType === "qa_correction_prepared")).toHaveLength(0); expect(writer).not.toHaveBeenCalled();
      await expect(sync()).rejects.toBe(failure); expect((await receipt()).deliveredAt).toBeNull();
      expect((await events()).filter(e => e.eventType === "qa_correction_followup_requested")).toHaveLength(0);
      const gate = "c02_" + randomUUID().replaceAll("-", "");
      await peer.execute(sql.raw(`CREATE FUNCTION ${gate}() RETURNS trigger LANGUAGE plpgsql AS $c02$ BEGIN IF NEW.workflow_run_id='${target.id}'::uuid AND NEW.request_kind <> 'workflow_resume' THEN RAISE EXCEPTION 'C02 queue fault'; END IF; RETURN NEW; END $c02$; CREATE TRIGGER ${gate} BEFORE INSERT ON agent_wakeup_requests FOR EACH ROW EXECUTE FUNCTION ${gate}();`));
      try { await sync(); expect((await receipt()).deliveredAt).toEqual(expect.any(String)); }
      finally { await peer.execute(sql.raw(`DROP TRIGGER ${gate} ON agent_wakeup_requests; DROP FUNCTION ${gate}();`)); }
      expect((await events()).filter(e => e.idempotencyKey?.startsWith("qa-correction-applied:"))).toHaveLength(1);
      await sync();
      await vi.waitFor(() => { expect(adapter).toHaveBeenCalledTimes(1); expect(notifiedAfterCommit).toBe(true); }, { timeout: 5000 });
      expect(await readFile(s.file)).toEqual(original); const issued = (await events()).find(e => e.idempotencyKey?.startsWith("qa-correction-applied:"))!;
      const applied = parseQaCorrectionEventPayload("qa_remediation_applied", issued.payload), revision = applied.revisions[0]!;
      expect(JSON.parse(await readFile(path.join(revision.root, revision.mainRelativePath), "utf8")).title).toBe("new");
      const requestedRows = (await events()).filter(e => e.eventType === "qa_correction_followup_requested"); expect(requestedRows).toHaveLength(1); const requested = parseQaCorrectionEventPayload("qa_correction_followup_requested", requestedRows[0]!.payload);
      const deliveries = (await events()).filter(e => e.eventType === "qa_correction_followup_delivered"); expect(deliveries).toHaveLength(1);
      const delivered = qaCorrectionDeliverySchema.parse(deliveries[0]!.payload);
      expect(delivered).toMatchObject({ ref: { companyId: s.p.companyId, workflowRunId: target.id, appliedEventId: issued.id, requestId: requested.requestId }, followupEventId: requestedRows[0]!.id });
      const [wake] = await peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, delivered.wakeupRequestId)); const [running] = await peer.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, delivered.heartbeatRunId));
      expect(wake).toMatchObject({ agentId: qaHb!.agentId, issueId: qa.issueId, workflowRunId: target.id, workflowStepRunId: qa.id, workflowExecutionGeneration: qa.executionGeneration, runId: delivered.heartbeatRunId, idempotencyKey: "qa-correction-wake:" + requested.requestId, requestedByActorId: "workflow:qa-remediation", payload: { qaCorrectionFollowup: delivered.ref } });
      expect(running).toMatchObject({ agentId: qaHb!.agentId, issueId: qa.issueId, workflowStepRunId: qa.id, workflowExecutionGeneration: qa.executionGeneration, wakeupRequestId: wake!.id }); expect(executed).toEqual([{ heartbeatRunId: running!.id, agentId: qaHb!.agentId, wakeupRequestId: wake!.id, ref: delivered.ref }]);
      expect((await peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.workflowRunId, target.id))).filter(w => w.issueId === qa.issueId)).toHaveLength(1);
      const costs = () => peer.select().from(costEvents).where(eq(costEvents.companyId, s.p.companyId)).orderBy(costEvents.id); const state = await commitDbState(s), costBefore = await costs(); await sync();
      const repeated = await commitDbState(s); expect(repeated.products).toEqual(state.products); expect(repeated.pins).toEqual(state.pins); expect(repeated.usage).toEqual(state.usage); expect(repeated.groups).toEqual(state.groups); expect(repeated.receipts).toEqual(state.receipts);
      expect(repeated.events.filter(e => e.idempotencyKey?.startsWith("qa-correction-applied:"))).toHaveLength(1); expect(repeated.events.filter(e => e.eventType === "qa_correction_prepared")).toHaveLength(1); expect(repeated.events.filter(e => e.eventType === "qa_correction_followup_requested")).toHaveLength(1); expect(repeated.events.filter(e => e.eventType === "qa_correction_followup_delivered")).toHaveLength(1);
      expect(repeated.wakes).toEqual(state.wakes); expect(repeated.heartbeats).toEqual(state.heartbeats); expect(adapter).toHaveBeenCalledTimes(1); expect(await costs()).toEqual(costBefore);
    } finally { writer.mockRestore(); release(); let drained = false; try { await waitForHeartbeatExecutionsToDrain(owned.db); drained = true;
      const wakes = await peer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.workflowRunId, target.id));
      const runs = await peer.select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, issueId: heartbeatRuns.issueId, wakeupRequestId: heartbeatRuns.wakeupRequestId, status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode, error: heartbeatRuns.error }).from(heartbeatRuns).where(eq(heartbeatRuns.issueId, qa.issueId!));
      console.info("C02 delivery execution evidence", JSON.stringify({ dbKinds, executed, drained, heartbeats: runs, wakes: wakes.map(w => ({ id: w.id, agentId: w.agentId, issueId: w.issueId, runId: w.runId, status: w.status, error: w.error, ref: w.payload?.qaCorrectionFollowup ?? null })) })); }
      catch (error) { console.info("C02 delivery execution evidence", JSON.stringify({ dbKinds, executed, drained, error: error instanceof Error ? error.message : String(error) })); throw error; }
      finally { actualDelivery.enabled = false; adapter.mockReset(); vi.unstubAllEnvs(); } }
  }, 120000);
});
