// server/src/__tests__/workflow-resume-wake.test.ts
//
// [목적] findExistingWorkflowResumeWake 좁힘(RES-476) 검증.
//   - 과거 run 성공으로 status='completed' 가 된 stale wake 는 "이미 처리중" 에서 제외.
//   - in-flight(queued/coalesced/deferred_issue_execution) + runId null 또는 live run(queued/running) 만 인정.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agents, agentWakeupRequests, companies, heartbeatRuns, issues, missions, workflowDefinitions, workflowRuns } from "@paperclipai/db";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const heartbeatWakeup = vi.fn();

vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return {
    ...actual,
    heartbeatService: () => ({ wakeup: heartbeatWakeup }),
  };
});

import { findExistingWorkflowResumeWake } from "../services/workflow-resume-wake.js";
import { wakeExistingWorkflowStepIssue } from "../services/workflow/dag-engine.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping workflow-resume-wake tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("findExistingWorkflowResumeWake (RES-476 narrowing)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;
  let missionId: string;
  let issueId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workflow-resume-wake-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    missionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Resume Wake Co", issuePrefix: `RW${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId, title: "resume wake mission", status: "active" });
    const issue = await db.insert(issues).values({
      companyId,
      missionId,
      title: "resume wake source",
      status: "todo",
    }).returning().then((rows) => rows[0]!);
    issueId = issue.id;
  }, 60_000);

  afterEach(async () => {
    heartbeatWakeup.mockReset();
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRuns);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertWake(over: Partial<typeof agentWakeupRequests.$inferInsert> & { status: string; runId?: string | null }) {
    return db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      reason: "workflow_step_runnable",
      status: over.status,
      runId: over.runId ?? null,
      payload: { issueId, mutation: "workflow_resume" },
      ...over,
    }).returning().then((rows) => rows[0]!);
  }

  it("ignores a stale COMPLETED workflow_resume wake (RES-476)", async () => {
    await insertWake({ status: "completed" });
    const result = await findExistingWorkflowResumeWake(db, { companyId, agentId, issueId });
    expect(result).toBeNull();
  });

  it("matches a QUEUED wake with no run yet (runId null)", async () => {
    const wake = await insertWake({ status: "queued" });
    const result = await findExistingWorkflowResumeWake(db, { companyId, agentId, issueId });
    expect(result?.id).toBe(wake.id);
  });

  it("matches a COALESCED in-flight wake", async () => {
    const wake = await insertWake({ status: "coalesced" });
    const result = await findExistingWorkflowResumeWake(db, { companyId, agentId, issueId });
    expect(result?.id).toBe(wake.id);
  });

  it("ignores a queued wake whose runId points at a finished (non-live) run", async () => {
    const deadRun = await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "completed",
      invocationSource: "automation",
    }).returning().then((rows) => rows[0]!);
    await insertWake({ status: "queued", runId: deadRun.id });
    const result = await findExistingWorkflowResumeWake(db, { companyId, agentId, issueId });
    expect(result).toBeNull();
  });

  it("matches a queued wake whose runId points at a still-running run", async () => {
    const liveRun = await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "running",
      invocationSource: "automation",
    }).returning().then((rows) => rows[0]!);
    const wake = await insertWake({ status: "queued", runId: liveRun.id });
    const result = await findExistingWorkflowResumeWake(db, { companyId, agentId, issueId });
    expect(result?.id).toBe(wake.id);
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, liveRun.id));
  });

  it("carries a workflow rework contract into resume wake payload and context", async () => {
    heartbeatWakeup.mockResolvedValue({ id: "queued-rework-contract" });
    const workflowId = randomUUID();
    const runId = randomUUID();
    const stepRunId = randomUUID();
    const reworkIssueId = randomUUID();
    const step = { id: "produce", name: "Produce artifact", agentId, dependencies: [] };
    const [definition] = await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "rework-contract",
      stepsJson: [step],
    }).returning();
    const [run] = await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "system",
      status: "running",
    }).returning();
    await db.insert(issues).values({
      id: reworkIssueId,
      companyId,
      missionId,
      assigneeAgentId: agentId,
      title: "rework-contract: Produce artifact",
      status: "done",
    });

    const reworkContract = {
      kind: "workflow_qa_rework",
      producerStepId: "produce",
      currentIteration: 1,
      maxIterations: 2,
      iterationLabel: "2/2",
      qaFeedbacks: [{ qaStepId: "qa-validate", qaIssueId: "GAZ-228", feedback: "Fix Risk-Off starter action." }],
      dependencyArtifacts: null,
      requiredActions: ["Address the latest REQUEST_CHANGES feedback before completing."],
      createdAt: "2026-07-06T00:00:00.000Z",
    };

    const queued = await wakeExistingWorkflowStepIssue({
      db,
      run,
      definition,
      step,
      stepRunId,
      stepRunMetadata: { workflowReworkContract: reworkContract },
      issueId: reworkIssueId,
      allowCompletedIssue: true,
    });

    expect(queued).toBe(true);
    expect(heartbeatWakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      reason: "workflow_step_runnable",
      payload: expect.objectContaining({
        issueId: reworkIssueId,
        mutation: "workflow_resume",
        workflowStepRunId: stepRunId,
        paperclipWorkflowReworkContract: expect.objectContaining({
          producerStepId: "produce",
          qaFeedbacks: expect.arrayContaining([
            expect.objectContaining({ feedback: "Fix Risk-Off starter action." }),
          ]),
        }),
      }),
      contextSnapshot: expect.objectContaining({
        workflowStepId: "produce",
        workflowStepRunId: stepRunId,
        paperclipWorkflowReworkContract: expect.objectContaining({ iterationLabel: "2/2" }),
      }),
    }));
  });
});
