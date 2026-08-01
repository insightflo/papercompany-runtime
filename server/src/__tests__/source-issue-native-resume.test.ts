import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, agents, companies, createDb, issues, workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { dispatchSourceIssueNativeResume } from "../services/workflow/source-issue-native-resume.js";

// [목적] owner-action 회복(Unblock 완료 · app.ts owner-decision retry callback)이 공유하는 검증된
//   native DAG 헬퍼(dispatchSourceIssueNativeResume → wakeExistingWorkflowStepIssue) 의 계약 검증.
//   (1) run/definition/step/stepRun 이 모두 증명되면 workflow_step_runnable/workflow_resume native wake,
//   (2) 이미 native wake 이 있으면 already_in_flight, (3) link 증명 불가능하면 report-only (wake 안 함).
//   이 헬퍼가 app.ts onOwnerDecisionRetrySourceIssueApplied 의 native 경로 그 자체다.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres source-issue-native-resume tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("dispatchSourceIssueNativeResume (validated native DAG path)", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-native-resume-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Native Resume Co",
      issuePrefix: `NR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId, companyId, name: "Worker", role: "writer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
  }, 60_000);

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  // source(running) + definition + step + stepRun(issueId=source) fixture. stepId/definition steps 일치.
  async function seedLinkedSource({
    runStatus = "running",
    stepStatus = "running",
    stepId = "src",
  }: { runStatus?: string; stepStatus?: string; stepId?: string } = {}) {
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const stepRunId = randomUUID();
    await db.insert(workflowDefinitions).values({
      id: workflowId, companyId, name: "Native resume workflow",
      stepsJson: [{ id: stepId, name: "Source step", agentId, dependencies: [] }],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId, workflowId, companyId, triggeredBy: "system", status: runStatus, startedAt: new Date(),
    });
    const [source] = await db
      .insert(issues)
      .values({ companyId, title: "linked source", status: "blocked", originKind: "workflow_execution", assigneeAgentId: agentId })
      .returning({ id: issues.id });
    await db.insert(workflowStepRuns).values({
      id: stepRunId,
      workflowRunId,
      stepId,
      issueId: source.id,
      status: stepStatus,
      startedAt: new Date(),
      completedAt: stepStatus === "failed" ? new Date() : null,
    });
    return { source, workflowRunId, stepRunId, stepId, workflowId };
  }

  it("dispatches a native workflow_resume wake when run(running)/definition/step/stepRun are all provable", async () => {
    const { source, workflowRunId, stepRunId, stepId, workflowId } = await seedLinkedSource();

    const outcome = await dispatchSourceIssueNativeResume(db, {
      companyId, issueId: source.id, allowBlockedIssue: true, agentId,
    });

    expect(outcome).toEqual({ kind: "dispatched", workflowRunId, workflowDefinitionId: workflowId, stepId, workflowStepRunId: stepRunId });

    // wakeExistingWorkflowStepIssue 가 만든 REAL row: reason=workflow_step_runnable + payload mutation=workflow_resume.
    const [wake] = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.issueId, source.id), eq(agentWakeupRequests.agentId, agentId)))
      .orderBy(agentWakeupRequests.requestedAt)
      .limit(1);
    expect(wake?.reason).toBe("workflow_step_runnable");
    const payload = (wake?.payload ?? {}) as Record<string, unknown>;
    expect(payload.mutation).toBe("workflow_resume");
    expect(payload.workflowRunId).toBe(workflowRunId);
    expect(payload.workflowStepRunId).toBe(stepRunId);

    // [req] helper performs NO direct checkout/status mutation — the native heartbeat wake may
    //   legitimately transition the source to in_progress, but the helper must never force "todo"
    //   (the legacy missions-service reopen contract). Asserting no "todo" reopen + the real wake
    //   row above is the validated-path / no-direct-mutation proof.
    const [after] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, source.id)).limit(1);
    expect(after?.status).not.toBe("todo");
  });

  it("returns report_only (no_step_run) and wakes nothing when the source has no workflow step run", async () => {
    const [source] = await db
      .insert(issues)
      .values({ companyId, title: "unlinked source", status: "blocked", originKind: "workflow_execution", assigneeAgentId: agentId })
      .returning({ id: issues.id });

    const outcome = await dispatchSourceIssueNativeResume(db, {
      companyId, issueId: source.id, allowBlockedIssue: true, agentId,
    });

    expect(outcome.kind).toBe("report_only");
    if (outcome.kind === "report_only") expect(outcome.reason).toBe("no_step_run");
    const wakes = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(eq(agentWakeupRequests.issueId, source.id));
    expect(wakes).toHaveLength(0);
  });

  it("returns report_only (run_not_running) when the linked workflow run is not running", async () => {
    const { source, workflowRunId, stepRunId, stepId } = await seedLinkedSource({ runStatus: "completed" });

    const outcome = await dispatchSourceIssueNativeResume(db, {
      companyId, issueId: source.id, allowBlockedIssue: true, agentId,
    });

    expect(outcome).toEqual({ kind: "report_only", reason: "run_not_running", workflowRunId, workflowStepRunId: stepRunId, stepId });
    const wakes = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(eq(agentWakeupRequests.issueId, source.id));
    expect(wakes).toHaveLength(0);
  });

  it("revives a failed run and failed step, then queues exactly one native workflow_resume", async () => {
    const { source, workflowRunId, stepRunId, stepId, workflowId } = await seedLinkedSource({
      runStatus: "failed",
      stepStatus: "failed",
    });

    const outcome = await dispatchSourceIssueNativeResume(db, {
      companyId, issueId: source.id, allowBlockedIssue: true, agentId,
    });

    expect(outcome).toEqual({ kind: "dispatched", workflowRunId, workflowDefinitionId: workflowId, stepId, workflowStepRunId: stepRunId });
    await expect(db.select().from(workflowRuns).where(eq(workflowRuns.id, workflowRunId)).then((rows) => rows[0])).resolves.toEqual(
      expect.objectContaining({ status: "running", completedAt: null }),
    );
    await expect(db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId)).then((rows) => rows[0])).resolves.toEqual(
      expect.objectContaining({ status: "running", completedAt: null }),
    );
    const wakes = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.issueId, source.id),
      eq(agentWakeupRequests.workflowRunId, workflowRunId),
      eq(agentWakeupRequests.workflowStepRunId, stepRunId),
      eq(agentWakeupRequests.requestKind, "workflow_resume"),
    ));
    expect(wakes).toHaveLength(1);
    const issueAfterQueue = await db.select().from(issues).where(eq(issues.id, source.id)).then((rows) => rows[0]);
    expect(issueAfterQueue?.status).not.toBe("todo");
    expect(["blocked", "in_progress"]).toContain(issueAfterQueue?.status);
  });

  it("returns already_in_flight when a native workflow_resume wake already covers the source", async () => {
    const { source, workflowRunId, stepRunId } = await seedLinkedSource();
    // existing queued workflow_resume wake (runId null → counts as live per findExistingWorkflowResumeWake).
    const [existing] = await db.insert(agentWakeupRequests).values({
      companyId, agentId, issueId: source.id, source: "automation", status: "queued", requestedAt: new Date(),
      reason: "workflow_step_runnable",
      requestKind: "workflow_resume",
      workflowRunId,
      workflowStepRunId: stepRunId,
      payload: { issueId: source.id, mutation: "workflow_resume" },
    }).returning({ id: agentWakeupRequests.id });

    const outcome = await dispatchSourceIssueNativeResume(db, {
      companyId, issueId: source.id, allowBlockedIssue: true, agentId,
    });

    expect(outcome.kind).toBe("already_in_flight");
    if (outcome.kind === "already_in_flight") expect(outcome.workflowWakeupRequestId).toBe(existing.id);
    // no duplicate wake beyond the seeded one.
    const wakes = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(eq(agentWakeupRequests.issueId, source.id));
    expect(wakes).toHaveLength(1);
  });
});
