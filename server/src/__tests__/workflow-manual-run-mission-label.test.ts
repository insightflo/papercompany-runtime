import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issueComments,
  issueWorkProducts,
  issues,
  missionPlanArtifacts,
  missions,
  workflowDefinitions,
  workflowRunSlots,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { workflowService } from "../services/workflow/engine.js";

// Same wakeup-mock preamble as workflow-trigger-scheduled-mission-guard.test.ts:
// trigger() creates the step issue and enqueues assignment wakeups.
const { heartbeatWakeup } = vi.hoisted(() => ({
  heartbeatWakeup: vi.fn(),
}));

vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return {
    ...actual,
    heartbeatService: () => ({
      wakeup: heartbeatWakeup,
    }),
  };
});

vi.mock("../services/issue-assignment-wakeup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/issue-assignment-wakeup.js")>();
  return {
    ...actual,
    queueIssueAssignmentWakeup: (
      input: Parameters<typeof actual.queueIssueAssignmentWakeup>[0],
    ) => actual.queueIssueAssignmentWakeup({
      ...input,
      heartbeat: { wakeup: heartbeatWakeup },
    }),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping manual run mission label tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`);
}

// [manual run label] 수동 실행 대화상자의 "실행명"(runLabel)은 미션명에 접미되어
//   같은 날 같은 워크플로우의 반복 실행을 구분하게 한다.
//   - runLabel 있음: "{runDate} {workflowName} — {runLabel}"
//   - runLabel 없음/빈값: 기존 "{runDate} {workflowName}" 그대로 (스케줄/기존 동작 무변화)
describeEP("workflow trigger manual run label → mission title", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("wf-run-label-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueWorkProducts);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowRunSlots);
    await db.delete(workflowDefinitions);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(missionPlanArtifacts);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  async function seedWorkflow() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Manual Run Label Company",
      issuePrefix: `MRL${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Runner",
      role: "researcher",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "youtube-report",
      status: "active",
      stepsJson: [
        { id: "collect", name: "Collect", agentId, dependencies: [] },
      ],
    });
    return { companyId, workflowId };
  }

  it("appends the manual run label to the mission title and stores it on the run", async () => {
    heartbeatWakeup.mockResolvedValue({ id: "queued-run-label" });
    const { companyId, workflowId } = await seedWorkflow();

    const result = await workflowService.trigger(db, {
      workflowId,
      companyId,
      triggeredBy: "board",
      runDate: "2026-08-28",
      runLabel: "짧은 목줄 AI 코딩",
      metadata: { url: "https://youtu.be/-7ajktD8pOo" },
    });

    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, result.runId));
    expect(run?.runLabel).toBe("짧은 목줄 AI 코딩");

    const [mission] = await db.select().from(missions).where(eq(missions.id, run!.missionId!));
    expect(mission?.title).toBe("2026-08-28 youtube-report — 짧은 목줄 AI 코딩");
    heartbeatWakeup.mockReset();
  });

  it("keeps the legacy mission title when no run label is provided", async () => {
    heartbeatWakeup.mockResolvedValue({ id: "queued-run-nolabel" });
    const { companyId, workflowId } = await seedWorkflow();

    const result = await workflowService.trigger(db, {
      workflowId,
      companyId,
      triggeredBy: "board",
      runDate: "2026-08-28",
      metadata: {},
    });

    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, result.runId));
    const [mission] = await db.select().from(missions).where(eq(missions.id, run!.missionId!));
    expect(mission?.title).toBe("2026-08-28 youtube-report");
    heartbeatWakeup.mockReset();
  });

  it("ignores a whitespace-only run label", async () => {
    heartbeatWakeup.mockResolvedValue({ id: "queued-run-space" });
    const { companyId, workflowId } = await seedWorkflow();

    const result = await workflowService.trigger(db, {
      workflowId,
      companyId,
      triggeredBy: "board",
      runDate: "2026-08-28",
      runLabel: "   ",
      metadata: {},
    });

    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, result.runId));
    const [mission] = await db.select().from(missions).where(eq(missions.id, run!.missionId!));
    expect(mission?.title).toBe("2026-08-28 youtube-report");
    heartbeatWakeup.mockReset();
  });
});
