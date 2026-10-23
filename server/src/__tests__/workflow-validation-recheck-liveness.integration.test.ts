import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issues, missions,
  workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { syncWorkflowRunForIssue, type WorkflowExecutionContext } from "../services/workflow/dag-engine.js";
import { finalizeWorkflowRunState } from "../services/workflow/workflow-run-finalization.js";
import { hasLiveValidationRecheck } from "../services/workflow/workflow-validation-recheck-liveness.js";
import { claimHeartbeatWithRecoveryGuard } from "../services/heartbeat-recovery-guard.js";
import { insertQueuedHeartbeat } from "../services/heartbeat-followup-promotion.js";
import { heartbeatService } from "../services/heartbeat.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping recheck integration: ${support.reason}`);
const describeDb = support.supported ? describe : describe.skip;
let db: ReturnType<typeof createDb>;
let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

describeDb("persisted workflow validation recheck liveness", () => {
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("validation-recheck-");
    db = createDb(temp.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 5 }); await temp?.cleanup(); });

  async function world() {
    const companyId = randomUUID(), producerAgentId = randomUUID(), qaAgentId = randomUUID();
    const workflowId = randomUUID(), runId = randomUUID(), missionId = randomUUID();
    const producerIssueId = randomUUID(), qaIssueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Recheck", issuePrefix: `R${companyId.replaceAll("-", "")}` });
    await db.insert(agents).values([
      { id: producerAgentId, companyId, name: "Producer", role: "engineer", status: "active", adapterType: "codex_local",
        runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } },
      { id: qaAgentId, companyId, name: "Validator", role: "qa", status: "paused", adapterType: "codex_local" },
    ]);
    // Block producer execution only; QA's pause admits a durable unlinked request without checkout.
    await db.insert(heartbeatRuns).values({ companyId, agentId: producerAgentId, status: "running" });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: producerAgentId, title: "Recheck", status: "active" });
    const steps = [
      { id: "produce", name: "Produce", agentId: producerAgentId, dependencies: [],
        conditionalDependencies: [{ stepId: "qa-validate", when: "qa_request_changes" as const, isBackEdge: true, maxIterations: 2 }] },
      { id: "qa-validate", qaType: "semantic" as const, name: "Validate", agentId: qaAgentId, dependencies: ["produce"] },
    ];
    const [definition] = await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "recheck", stepsJson: steps }).returning();
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId, missionId, status: "running", triggeredBy: "system" });
    await db.insert(issues).values([
      { id: producerIssueId, companyId, missionId, title: "Produce", assigneeAgentId: producerAgentId, status: "done",
        originKind: "workflow_execution", originId: runId, originRunId: runId,
        startedAt: new Date("2026-06-18T07:01:00Z"), completedAt: new Date("2026-06-18T07:05:00Z") },
      { id: qaIssueId, companyId, missionId, title: "Validate", assigneeAgentId: qaAgentId, status: "blocked",
        originKind: "workflow_execution", originId: runId, originRunId: runId, startedAt: new Date("2026-06-18T07:03:00Z") },
    ]);
    await db.insert(workflowStepRuns).values([
      { workflowRunId: runId, stepId: "produce", issueId: producerIssueId, status: "completed",
        startedAt: new Date("2026-06-18T07:01:00Z"), completedAt: new Date("2026-06-18T07:05:00Z") },
      { workflowRunId: runId, stepId: "qa-validate", issueId: qaIssueId, status: "failed",
        startedAt: new Date("2026-06-18T07:03:00Z"), completedAt: new Date("2026-06-18T07:10:00Z") },
    ]);
    const readRun = async () => (await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)))[0]!;
    const readSteps = () => db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    const qa = (await readSteps()).find(s => s.stepId === "qa-validate")!;
    const verdict = async (value: "pass" | "request_changes", at: string) => {
      const [heartbeat] = await db.insert(heartbeatRuns).values({ companyId, agentId: qaAgentId, issueId: qaIssueId,
        status: "succeeded", startedAt: new Date(at), finishedAt: new Date(at), createdAt: new Date(at) }).returning();
      await db.insert(workflowTransitionEvents).values({ companyId, missionId, workflowRunId: runId,
        workflowStepRunId: qa.id, issueId: qaIssueId, heartbeatRunId: heartbeat.id,
        eventType: "workflow_validation_verdict", layer: "workflow_validation", verdict: value, decision: value,
        reason: "workflow_api", reasonCode: "workflow_api", idempotencyKey: `verdict:${heartbeat.id}`,
        payload: { kind: "workflow_validation_verdict", workflowRunId: runId, stepRunId: qa.id, issueId: qaIssueId, verdict: value },
        createdAt: new Date(at) });
    };
    const converge = async (boundary = false, candidate = "failed") => {
      await db.update(workflowStepRuns).set({ status: candidate }).where(eq(workflowStepRuns.id, qa.id));
      const run = await readRun();
      await finalizeWorkflowRunState(db, { run, definition, steps } as WorkflowExecutionContext, await readSteps(), boundary, true, {
        normalizeRecord: v => v && typeof v === "object" ? v as Record<string, unknown> : {},
        getDynamicLaunchStepIds: () => undefined, buildWorkflowDefinitionExecutionShape: () => ({ stepsJson: steps }),
      });
      return readRun();
    };
    const admit = async (real = false) => {
      if (real) {
        await heartbeatService(db).wakeup(qaAgentId, { source: "assignment", triggerDetail: "system", reason: "workflow_step_runnable",
          payload: { issueId: qaIssueId, missionId, workflowRunId: runId, workflowStepRunId: qa.id, mutation: "workflow_resume" },
          contextSnapshot: { issueId: qaIssueId, missionId, workflowRunId: runId, workflowStepRunId: qa.id } });
        const [stored] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.workflowStepRunId, qa.id));
        expect(stored).toMatchObject({ status: "queued", runId: null, workflowExecutionGeneration: qa.executionGeneration });
        return stored;
      }
      const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId: qaAgentId, issueId: qaIssueId,
        workflowRunId: runId, workflowStepRunId: qa.id, workflowExecutionGeneration: qa.executionGeneration,
        requestKind: "workflow_resume", source: "automation", status: "queued" }).returning();
      return wake;
    };
    const link = async (wake: typeof agentWakeupRequests.$inferSelect, claim = false) => {
      const [agent] = await db.update(agents).set({ status: "active" }).where(eq(agents.id, qaAgentId)).returning();
      const heartbeat = await insertQueuedHeartbeat(db, { agent, issueId: qaIssueId, source: "automation", triggerDetail: null,
        wakeupRequestId: wake.id, taskKey: `issue:${qaIssueId}`, sessionBefore: null,
        contextSnapshot: { issueId: qaIssueId, missionId, workflowRunId: runId, workflowStepRunId: qa.id } });
      await db.update(agentWakeupRequests).set({ runId: heartbeat.id }).where(eq(agentWakeupRequests.id, wake.id));
      if (claim) {
        const claimed = await claimHeartbeatWithRecoveryGuard(db, heartbeat, new Date());
        expect(claimed).toMatchObject({ status: "running", workflowStepRunId: qa.id, workflowExecutionGeneration: qa.executionGeneration });
      }
      const [stored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, heartbeat.id));
      expect(stored).toMatchObject(claim ? { status: "running", workflowStepRunId: qa.id,
        workflowExecutionGeneration: qa.executionGeneration } : { status: "queued", workflowStepRunId: null, workflowExecutionGeneration: null });
      return stored;
    };
    const pass = async () => {
      await verdict("pass", "2026-06-18T07:40:00Z");
      await db.update(issues).set({ status: "done", completedAt: new Date("2026-06-18T07:40:00Z") }).where(eq(issues.id, qaIssueId));
      await syncWorkflowRunForIssue(db, qaIssueId);
    };
    const driveReworkAndAdmit = async () => {
      await verdict("request_changes", "2026-06-18T07:10:00Z");
      await syncWorkflowRunForIssue(db, producerIssueId);
      expect((await readSteps()).find(s => s.stepId === "produce")!.iterationIndex).toBe(1);
      // Completing producer work also retires its admitted execution, not just the issue display.
      const producerWakes = await db.update(agentWakeupRequests).set({ status: "completed", finishedAt: new Date() })
        .where(and(eq(agentWakeupRequests.workflowRunId, runId), eq(agentWakeupRequests.issueId, producerIssueId))).returning();
      for (const wake of producerWakes) if (wake.runId) await db.update(heartbeatRuns)
        .set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, wake.runId));
      await db.update(issues).set({ status: "done", startedAt: new Date("2026-06-18T07:11:00Z"),
        completedAt: new Date("2026-06-18T07:30:00Z"), cancelledAt: null }).where(eq(issues.id, producerIssueId));
      await syncWorkflowRunForIssue(db, producerIssueId);
      const [wake] = await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.workflowStepRunId, qa.id), eq(agentWakeupRequests.requestKind, "workflow_resume")));
      const currentQa = (await readSteps()).find(s => s.id === qa.id)!;
      expect(wake).toMatchObject({ companyId, workflowRunId: runId, workflowStepRunId: qa.id, issueId: qaIssueId,
        workflowExecutionGeneration: currentQa.executionGeneration, status: "queued", runId: null });
      expect((await db.select().from(issues).where(eq(issues.id, qaIssueId)))[0].status).toBe("blocked");
      return wake;
    };
    return { companyId, runId, qa, qaIssueId, producerIssueId, producerAgentId, readRun, readSteps, converge, admit, link, pass, driveReworkAndAdmit };
  }
  type World = Awaited<ReturnType<typeof world>>;
  const live = (f: World) => hasLiveValidationRecheck(db, { id: f.runId, companyId: f.companyId });
  const retire = (id: string) => db.update(agentWakeupRequests).set({ status: "completed", finishedAt: new Date() }).where(eq(agentWakeupRequests.id, id));

  it("real P4: persisted rework admission defers failure, later structured PASS completes at iteration 1", async () => {
    const f = await world(), wake = await f.driveReworkAndAdmit();
    expect(await live(f)).toBe(true);
    expect(await f.readRun()).toMatchObject({ status: "running", completedAt: null });
    await retire(wake.id);
    if (wake.runId) await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, wake.runId));
    await f.pass();
    expect((await f.readSteps()).find(s => s.id === f.qa.id)!.status).toBe("completed");
    expect((await f.readSteps()).find(s => s.stepId === "produce")!.iterationIndex).toBe(1);
    expect((await f.readRun()).status).toBe("completed");
  });

  for (const boundary of [false, true]) for (const candidate of ["failed", "completed"]) {
    it.each(["live", "absent", "retired"])(`boundary=${boundary} candidate=${candidate} %s`, async mode => {
      const f = await world();
      if (mode !== "absent") { const wake = await f.admit(); if (mode === "retired") await retire(wake.id); }
      expect(await live(f)).toBe(mode === "live");
      const result = await f.converge(boundary, candidate);
      expect(result.status).toBe(mode === "live" ? "running" : candidate);
      expect(result.completedAt === null).toBe(mode === "live");
    });
  }

  it.each(["queued", "deferred", "queued-heartbeat", "typed-queued", "claim-gap", "claimed"])("live form %s", async form => {
    const f = await world(), wake = await f.admit(true);
    if (form === "deferred") await db.update(agentWakeupRequests).set({ status: "deferred_issue_execution" }).where(eq(agentWakeupRequests.id, wake.id));
    if (["queued-heartbeat", "typed-queued", "claim-gap", "claimed"].includes(form)) {
      const hb = await f.link(wake, form === "claim-gap" || form === "claimed");
      if (form === "typed-queued") await db.update(heartbeatRuns).set({ workflowStepRunId: f.qa.id,
        workflowExecutionGeneration: f.qa.executionGeneration }).where(eq(heartbeatRuns.id, hb.id));
      if (form === "claimed") await db.update(agentWakeupRequests).set({ status: "claimed" }).where(eq(agentWakeupRequests.id, wake.id));
    }
    expect(await live(f)).toBe(true);
    expect(await f.converge()).toMatchObject({ status: "running", completedAt: null });
  });

  it.each(["completed", "consumed", "cancelled", "failed", "skipped", "coalesced", "timed_out", "unknown",
    "claimed-unlinked", "claimed-queued", "deferred-linked", "terminal-heartbeat", "terminal-authority", "finished",
    "missing-heartbeat", "reverse", "company", "agent", "issue", "step", "generation", "null-generation",
    "current-generation", "partial-typing", "stale-typing", "untyped-running", "prose-only"])("rejects %s and converges normally", async form => {
    const f = await world(), wake = await f.admit();
    const wp: Partial<typeof agentWakeupRequests.$inferInsert> = {};
    if (["completed", "consumed", "cancelled", "failed", "skipped", "coalesced", "timed_out", "unknown"].includes(form)) wp.status = form;
    else if (form === "claimed-unlinked") wp.status = "claimed";
    else if (form === "generation") wp.workflowExecutionGeneration = f.qa.executionGeneration + 1;
    else if (form === "null-generation") wp.workflowExecutionGeneration = null;
    else if (form === "current-generation") await db.update(workflowStepRuns).set({ executionGeneration: f.qa.executionGeneration + 1 }).where(eq(workflowStepRuns.id, f.qa.id));
    else if (form === "prose-only") {
      wp.workflowStepRunId = null; wp.workflowExecutionGeneration = null;
      wp.payload = { workflowStepRunId: f.qa.id, workflowExecutionGeneration: f.qa.executionGeneration, note: "QA recheck" };
    } else {
      const hb = await f.link(wake);
      const hp: Partial<typeof heartbeatRuns.$inferInsert> = {};
      if (form === "claimed-queued") wp.status = "claimed";
      if (form === "deferred-linked") wp.status = "deferred_issue_execution";
      if (form === "terminal-heartbeat") hp.status = "succeeded";
      if (form === "terminal-authority") hp.terminalOutcome = "failed";
      if (form === "finished") hp.finishedAt = new Date();
      if (form === "missing-heartbeat") wp.runId = randomUUID();
      if (form === "reverse") hp.wakeupRequestId = null;
      if (form === "company") {
        const [other] = await db.insert(companies).values({ name: "Foreign", issuePrefix: `F${randomUUID().replaceAll("-", "")}` }).returning();
        hp.companyId = other.id;
      }
      if (form === "agent") hp.agentId = f.producerAgentId;
      if (form === "issue") hp.issueId = f.producerIssueId;
      if (form === "step") { hp.workflowStepRunId = (await f.readSteps()).find(s => s.stepId === "produce")!.id; hp.workflowExecutionGeneration = f.qa.executionGeneration; }
      if (form === "partial-typing") hp.workflowStepRunId = f.qa.id;
      if (form === "stale-typing") { hp.workflowStepRunId = f.qa.id; hp.workflowExecutionGeneration = f.qa.executionGeneration + 1; }
      if (form === "untyped-running") hp.status = "running";
      if (Object.keys(hp).length) await db.update(heartbeatRuns).set(hp).where(eq(heartbeatRuns.id, hb.id));
    }
    if (Object.keys(wp).length) await db.update(agentWakeupRequests).set(wp).where(eq(agentWakeupRequests.id, wake.id));
    expect(await live(f)).toBe(false);
    expect((await f.converge()).status).toBe("failed");
  });

  for (const boundary of [false, true]) it.each(["failed", "completed", "cancelled"])(`terminal stickiness boundary=${boundary} %s`, async status => {
    const f = await world(), completedAt = new Date("2026-06-18T08:00:00Z");
    await db.update(workflowRuns).set({ status, completedAt }).where(eq(workflowRuns.id, f.runId));
    await f.admit();
    expect(await live(f)).toBe(false);
    expect(await f.converge(boundary, "completed")).toMatchObject({ status, completedAt });
  });

  it("retired admission permits failure; late PASS never resurrects the failed parent", async () => {
    const f = await world(), wake = await f.driveReworkAndAdmit();
    await retire(wake.id);
    const failed = await f.converge();
    expect(failed.status).toBe("failed");
    await f.pass();
    expect(await f.readRun()).toMatchObject({ status: "failed", completedAt: failed.completedAt });
  });
});
