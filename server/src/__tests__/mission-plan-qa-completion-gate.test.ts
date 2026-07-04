import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySecrets,
  companySecretVersions,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  missionPlanArtifacts,
  missionPlanQaVerdicts,
  missions,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { issueService } from "../services/issues.ts";

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
  console.warn(
    `Skipping PLAN-QA completion gate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function successfulAdapterResult() {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    usage: null,
    provider: "test",
    model: "test-model",
    resultJson: null,
    runtimeServices: [],
  };
}

async function waitForRunTerminal(heartbeat: ReturnType<typeof heartbeatService>, runId: string) {
  for (let i = 0; i < 20; i += 1) {
    const run = await heartbeat.getRun(runId);
    if (run && ["succeeded", "failed", "timed_out", "cancelled"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for heartbeat run ${runId}`);
}

async function waitForIssueStatus(
  db: ReturnType<typeof createDb>,
  issueId: string,
  status: string,
) {
  for (let i = 0; i < 20; i += 1) {
    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    if (issue?.status === status) return issue;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for issue ${issueId} to become ${status}`);
}

describeEmbeddedPostgres("mission PLAN-QA completion gate", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plan-qa-completion-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    executeSpy.mockReset();
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueComments);
    await db.delete(missionPlanQaVerdicts);
    await db.delete(issues);
    await db.delete(missionPlanArtifacts);
    await db.delete(missions);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedPlanQaCase(input: {
    readonly activeHash?: string;
    readonly verdictHash?: string;
  }) {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    const missionId = randomUUID();
    const issueId = randomUUID();
    const activeHash = input.activeHash ?? "active-hash";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `PQ${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Mission Owner",
        role: "owner",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: reviewerAgentId,
        companyId,
        name: "Plan QA",
        role: "qa",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: { promptTemplate: "Review the plan." },
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "PLAN-QA ledger mission",
      status: "planning",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      missionId,
      identifier: "PAP-PLANQA",
      title: "[PLAN-QA] Review active plan",
      status: "in_progress",
      assigneeAgentId: reviewerAgentId,
      originKind: "mission_plan_qa",
    });
    await db.insert(missionPlanArtifacts).values({
      companyId,
      missionId,
      ownerAgentId,
      missionGoal: "Complete only after official PLAN-QA ledger evidence.",
      refs: { planQa: { issueId, decisionHash: activeHash } },
    });
    if (input.verdictHash) {
      await db.insert(missionPlanQaVerdicts).values({
        companyId,
        missionId,
        planQaIssueId: issueId,
        reviewerAgentId,
        decisionHash: input.verdictHash,
        verdict: "pass",
      });
    }

    return { companyId, missionId, issueId, reviewerAgentId };
  }

  it("rejects direct done when only a stale PLAN-QA verdict exists", async () => {
    const seeded = await seedPlanQaCase({ activeHash: "active-hash", verdictHash: "stale-hash" });

    await expect(issueService(db).update(seeded.issueId, { status: "done" })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("mission_plan_qa"),
    });

    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(issue?.status).toBe("in_progress");
  });

  it("allows direct done when the active PLAN-QA verdict exists", async () => {
    const seeded = await seedPlanQaCase({ activeHash: "active-hash", verdictHash: "active-hash" });

    const updated = await issueService(db).update(seeded.issueId, { status: "done" });

    expect(updated?.status).toBe("done");
    expect(updated?.completedAt).toBeInstanceOf(Date);
  });

  it("blocks heartbeat auto-completion when PLAN-QA verdict ledger is missing", async () => {
    const seeded = await seedPlanQaCase({ activeHash: "active-hash" });
    executeSpy.mockImplementation(async ({ runId }) => {
      await db.update(issues).set({ checkoutRunId: runId, executionRunId: runId }).where(eq(issues.id, seeded.issueId));
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      seeded.reviewerAgentId,
      "assignment",
      { taskKey: `issue:${seeded.issueId}`, issueId: seeded.issueId, missionId: seeded.missionId },
      "system",
      { actorType: "system", actorId: "test-suite" },
    );
    if (!run) throw new Error("Expected heartbeat run");

    expect((await waitForRunTerminal(heartbeat, run.id)).status).toBe("succeeded");
    const issue = await waitForIssueStatus(db, seeded.issueId, "blocked");
    expect(issue.completedAt).toBeNull();

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    expect(comments.some((comment) => comment.body.includes("plan_qa_verdict_missing"))).toBe(true);
  });

  it("allows heartbeat auto-completion when the active PLAN-QA verdict exists", async () => {
    const seeded = await seedPlanQaCase({ activeHash: "active-hash", verdictHash: "active-hash" });
    executeSpy.mockImplementation(async ({ runId }) => {
      await db.update(issues).set({ checkoutRunId: runId, executionRunId: runId }).where(eq(issues.id, seeded.issueId));
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      seeded.reviewerAgentId,
      "assignment",
      { taskKey: `issue:${seeded.issueId}`, issueId: seeded.issueId, missionId: seeded.missionId },
      "system",
      { actorType: "system", actorId: "test-suite" },
    );
    if (!run) throw new Error("Expected heartbeat run");

    expect((await waitForRunTerminal(heartbeat, run.id)).status).toBe("succeeded");
    const issue = await waitForIssueStatus(db, seeded.issueId, "done");
    expect(issue.completedAt).toBeInstanceOf(Date);

    const activities = await db.select().from(activityLog).where(eq(activityLog.runId, run.id));
    expect(activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "issue.run_succeeded_auto_completed", entityId: seeded.issueId }),
      ]),
    );
  });
});
