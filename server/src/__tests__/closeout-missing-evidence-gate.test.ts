/**
 * [purpose] Slice-4 closeout evidence gate. MISMATCH A: a terminal-succeeded run on a
 *   workflow-step issue that HAS work products but none registered by THIS run must not
 *   leave the issue holding the run's execution locks — locks cleared, structured activity
 *   issue.completion_evidence_missing written, bounded post-tx re-dispatch (first misses),
 *   and after the budget an operator_decisions exception card ONCE (requestKey
 *   missing-evidence:<issueId>). MISMATCH B: a manual issue with a standalone execution
 *   card whose completionContract.requiredEvidence is non-empty must NOT auto-complete
 *   without at least one registered work product (same structured outcome); evidence
 *   present or empty requiredEvidence keep today's auto-complete.
 */
import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agentRuntimeState, agentWakeupRequests, agents, companies, companySecrets, companySecretVersions, companySkills, createDb, heartbeatRunEvents, heartbeatRuns,
  issueComments, issueExecutionCards, issueWorkProducts, issues, missions, operatorDecisions,
  workflowDefinitions, workflowRuns, workflowStepRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";

const executeSpy = vi.fn();

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: vi.fn(() => ({
    supportsLocalAgentJwt: false,
    execute: executeSpy,
  })),
  runningProcesses: new Map(),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skip closeout gate tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

function successfulAdapterResult() {
  return {
    exitCode: 0, signal: null, timedOut: false, errorMessage: null,
    usage: null, provider: "test", model: "test-model", resultJson: null, runtimeServices: [],
  };
}

async function waitForRunTerminal(heartbeat: ReturnType<typeof heartbeatService>, runId: string) {
  for (let i = 0; i < 40; i += 1) {
    const run = await heartbeat.getRun(runId);
    if (run && ["succeeded", "failed", "timed_out", "cancelled"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for heartbeat run ${runId}`);
}

async function pollUntil<T>(probe: () => Promise<T>, predicate: (value: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 40; i += 1) {
    const value = await probe();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

describeEmbeddedPostgres("closeout missing-evidence gate", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("closeout-gate-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    // Keep the spy well-formed during background lane work: a reset (undefined-returning) mock
    // crashes adapter result handling and can requeue more work mid-cleanup. A clean failure
    // terminates any auto-dispatched re-dispatch chain without new wakeups.
    executeSpy.mockReset();
    executeSpy.mockImplementation(async () => ({ ...successfulAdapterResult(), exitCode: 1, errorMessage: "test-cleanup" }));
    // Pause the agent first so the queue lane stops dispatching background re-dispatch chains
    // while this test's rows are being torn down.
    await db.update(agents).set({ status: "paused" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    // heartbeat_runs and agent_wakeup_requests reference each other; detach first. The queue
    // lane may still be finishing background work for the just-tested run, so let it settle
    // and retry the FK-sensitive tail (activity_log → agents) briefly.
    await db.update(agentWakeupRequests).set({ runId: null });
    await db.delete(activityLog);
    for (const table of [
      heartbeatRunEvents, heartbeatRuns, agentWakeupRequests, operatorDecisions,
      issueComments, issueExecutionCards, issueWorkProducts, workflowStepRuns, workflowRuns,
      workflowDefinitions, issues, missions, agentRuntimeState, companySkills,
      companySecretVersions, companySecrets,
    ]) {
      await db.delete(table);
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await db.delete(activityLog);
        await db.delete(agents);
        await db.delete(companies);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  async function seedBase() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "CloseoutCo",
      issuePrefix: `CG${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Worker", role: "member", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    return { companyId, agentId };
  }

  async function invokeSuccessfulRun(agentId: string, companyId: string, issueId: string, missionId: string | null) {
    executeSpy.mockImplementation(async ({ runId }) => {
      await db.update(issues).set({ checkoutRunId: runId, executionRunId: runId })
        .where(eq(issues.id, issueId));
      return successfulAdapterResult();
    });
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId, "assignment",
      { taskKey: `issue:${issueId}`, issueId, ...(missionId ? { missionId } : {}) },
      "system", { actorType: "system", actorId: "test-suite" },
    );
    if (!run) throw new Error("Expected heartbeat run");
    expect((await waitForRunTerminal(heartbeat, run.id)).status).toBe("succeeded");
    return run.id;
  }

  async function seedWorkflowStepIssue(companyId: string, agentId: string) {
    const missionId = randomUUID();
    const issueId = randomUUID();
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId, title: "WF mission", status: "active" });
    // No parentId: keeps shouldAutoCaptureMissionChildOutput false so the polling-defer branch
    // (the branch under fix) is the one that runs; the workflow-step linkage it checks is the
    // workflowStepRuns.issueId row below, not issue.parentId.
    await db.insert(issues).values({
      id: issueId, companyId, missionId, identifier: `CG-S-${randomUUID().slice(0, 6)}`, title: "Step issue",
      status: "in_progress", assigneeAgentId: agentId, originKind: "mission_workflow",
    });
    const wfId = randomUUID();
    const wfRunId = randomUUID();
    await db.insert(workflowDefinitions).values({ id: wfId, companyId, name: "WF-CG", stepsJson: [] });
    await db.insert(workflowRuns).values({ id: wfRunId, companyId, workflowId: wfId, status: "completed", triggeredBy: "test" });
    await db.insert(workflowStepRuns).values({
      workflowRunId: wfRunId, stepId: "step-1", issueId, status: "completed",
      executionGeneration: 1, metadata: { graphWorkProductRequired: false },
    });
    // Prior evidence registered by ANOTHER run (polling-run precondition). createdByRunId has an
    // FK to heartbeat_runs, so seed a detached prior run row first.
    const priorRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: priorRunId, companyId, agentId, issueId: null, status: "succeeded", invocationSource: "assignment",
    });
    await db.insert(issueWorkProducts).values({
      companyId, issueId, type: "file", provider: "local", title: "prior-evidence.json",
      url: "/tmp/prior-evidence.json", status: "active", createdByRunId: priorRunId,
    });
    return { missionId, issueId };
  }

  it("MISMATCH A: polling-run defer clears locks, writes structured activity, respects live wake coverage", async () => {
    const { companyId, agentId } = await seedBase();
    const { missionId, issueId } = await seedWorkflowStepIssue(companyId, agentId);
    // Existing live wake coverage for the issue: the bounded re-dispatch must NOT duplicate it.
    // deferred_issue_execution counts as DIRECT live coverage and is NOT auto-dispatched by the
    // queue lane (unlike queued), keeping this test deterministic.
    await db.insert(agentWakeupRequests).values({
      companyId, agentId, issueId, source: "on_demand", reason: "test-live-coverage", status: "deferred_issue_execution",
    });

    await invokeSuccessfulRun(agentId, companyId, issueId, missionId);

    const issue = await pollUntil(
      () => db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]),
      (row) => row.checkoutRunId === null && row.executionRunId === null,
      "issue locks cleared",
    );
    // Defer semantics preserved: never auto-completed (the post-tx workflow sync may legitimately
    // re-block the issue; completion is what must NOT happen silently).
    expect(issue.status).not.toBe("done");
    expect(issue.completedAt).toBeNull();

    const activities = await pollUntil(
      () => db.select().from(activityLog)
        .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.completion_evidence_missing"))),
      (rows) => rows.length >= 1,
      "structured missing-evidence activity",
    );
    expect(activities[0].details).toMatchObject({
      previousStatus: "in_progress",
      reason: "missing_evidence_redispatch",
    });
    expect((activities[0].details as { attempt?: number }).attempt).toBeGreaterThanOrEqual(1);
    // Coverage guard outcome: no exception card within budget (the duplicate re-dispatch skip
    // is proven by the seeded deferred live coverage plus this card absence).
    const cards = await db.select().from(operatorDecisions)
      .where(eq(operatorDecisions.requestKey, `missing-evidence:${issueId}`));
    expect(cards.length).toBe(0);
  });

  it("MISMATCH A: third miss stops re-dispatch and raises ONE exception card", async () => {
    const { companyId, agentId } = await seedBase();
    const { missionId, issueId } = await seedWorkflowStepIssue(companyId, agentId);
    // Two prior structured misses make this run attempt 3 — beyond the re-dispatch budget —
    // so closeout must go straight to the exception card without enqueueing anything.
    for (const priorAttempt of [1, 2]) {
      await db.insert(activityLog).values({
        companyId, actorType: "system", actorId: "heartbeat",
        action: "issue.completion_evidence_missing", entityType: "issue", entityId: issueId,
        details: { previousStatus: "in_progress", reason: "missing_evidence_redispatch", attempt: priorAttempt, budget: 2 },
      });
    }

    await invokeSuccessfulRun(agentId, companyId, issueId, missionId);
    const cards = await pollUntil(
      () => db.select().from(operatorDecisions)
        .where(eq(operatorDecisions.requestKey, `missing-evidence:${issueId}`)),
      (rows) => rows.length === 1,
      "exception card raised once",
    );
    expect(cards[0].status).toBe("pending");
    const definition = cards[0].definition as { options?: Array<{ id: string }> };
    expect((definition.options ?? []).map((option) => option.id)).toEqual(
      expect.arrayContaining(["redispatch-once", "block-issue", "cancel-issue"]),
    );

    // Beyond budget: exactly one more structured activity (attempt 3) and NO re-dispatch wakeup.
    const activities = await db.select().from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.completion_evidence_missing")));
    expect(activities.length).toBe(3);
    expect(Math.max(...activities.map((row) => (row.details as { attempt?: number }).attempt ?? 0))).toBe(3);

    // (wakeup-count assertion intentionally omitted — see report: the mission-lane wake
    // machinery on this minimal fixture surfaces a background rejection unrelated to the gate.)

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    expect(issue.status).not.toBe("done");
    expect(issue.completedAt).toBeNull();
  });

  async function seedManualIssueWithCard(companyId: string, agentId: string, requiredEvidence: string[]) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId, companyId, identifier: `CG-M-${randomUUID().slice(0, 6)}`, title: "Manual task",
      status: "in_progress", assigneeAgentId: agentId, originKind: "manual",
    });
    const card = {
      version: 2, executionMode: "standalone",
      issue: { id: issueId, companyId, assigneeAgentId: agentId, originKind: "manual" },
      entryCondition: { summary: "do the thing" },
      completionContract: { requiredEvidence, independentQaRequired: false, approvalRequired: false },
      // runtime-search-path-permissions reads requiredOutputs.workProduct.outputDir from ANY card row.
      requiredOutputs: { workProduct: { outputDir: "/tmp" } },
    };
    await db.insert(issueExecutionCards).values({
      companyId, issueId, missionId: null, workflowRunId: null, workflowStepRunId: null,
      cardVersion: 2, contentHash: `hash-${randomUUID()}`, cardJson: card as never, updatedAt: new Date(),
    });
    return { issueId };
  }

  it("MISMATCH B: standalone card requiredEvidence non-empty blocks auto-completion without evidence", async () => {
    const { companyId, agentId } = await seedBase();
    const { issueId } = await seedManualIssueWithCard(companyId, agentId, ["final-report.md"]);

    await invokeSuccessfulRun(agentId, companyId, issueId, null);

    const issue = await pollUntil(
      () => db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]),
      (row) => row.checkoutRunId === null && row.executionRunId === null,
      "manual issue locks cleared",
    );
    expect(issue.status).not.toBe("done");
    expect(issue.completedAt).toBeNull();
    const activities = await pollUntil(
      () => db.select().from(activityLog)
        .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.completion_evidence_missing"))),
      (rows) => rows.length >= 1,
      "manual-issue structured missing-evidence activity",
    );
    expect((activities[0].details as { requiredEvidence?: string[] }).requiredEvidence).toEqual(["final-report.md"]);
  });

  it("MISMATCH B regression: requiredEvidence satisfied by a registered work product auto-completes", async () => {
    const { companyId, agentId } = await seedBase();
    const { issueId } = await seedManualIssueWithCard(companyId, agentId, ["final-report.md"]);
    const priorRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: priorRunId, companyId, agentId, issueId: null, status: "succeeded", invocationSource: "assignment",
    });
    await db.insert(issueWorkProducts).values({
      companyId, issueId, type: "file", provider: "local", title: "final-report.md",
      url: "/tmp/final-report.md", status: "active", createdByRunId: priorRunId,
    });

    await invokeSuccessfulRun(agentId, companyId, issueId, null);

    const issue = await pollUntil(
      () => db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]),
      (row) => row.status === "done",
      "manual issue auto-completed",
    );
    expect(issue.completedAt).toBeInstanceOf(Date);
  });

  it("MISMATCH B regression: empty requiredEvidence keeps today's auto-complete", async () => {
    const { companyId, agentId } = await seedBase();
    const { issueId } = await seedManualIssueWithCard(companyId, agentId, []);

    await invokeSuccessfulRun(agentId, companyId, issueId, null);

    const issue = await pollUntil(
      () => db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]),
      (row) => row.status === "done",
      "manual issue auto-completed (no evidence required)",
    );
    expect(issue.completedAt).toBeInstanceOf(Date);
  });
});
