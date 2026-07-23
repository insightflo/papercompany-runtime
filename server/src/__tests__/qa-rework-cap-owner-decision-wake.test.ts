import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  cleanQaCapFixture,
  seedQaCapBase,
  seedQaCapWorkflow,
  seedStepHeartbeat,
  seedWorkflowVerdict,
  type QaCapTestDb,
} from "./helpers/qa-cap-oversight-fixture.js";
import { missionService } from "../services/missions.js";
import { isQaReworkCapOversightIssue } from "../services/missions/qa-rework-cap-oversight.js";
import { MISSION_OWNER_DECISION_OPTIONS } from "../services/missions/mission-owner-recovery-events.js";
import { recordMissionOwnerDecision } from "../services/missions/mission-owner-recovery-ledger.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`skip qa-cap decision wake: ${support.reason ?? "unsupported"}`);
async function seedCapExhaustion(db: QaCapTestDb) {
  const base = await seedQaCapBase(db);
  const seed = await seedQaCapWorkflow(db, base, {
    iteration: 2,
    edges: [{ stepId: "qa-semantic", maxIterations: 2 }],
  });
  const qa = seed.qas[0]!;
  const heartbeatRunId = await seedStepHeartbeat(db, base, {
    workflowRunId: seed.runId,
    workflowStepRunId: qa.stepRunId,
    issueId: qa.issueId,
    createdAt: new Date(Date.now() - 10_000),
  });
  await seedWorkflowVerdict(db, base, {
    workflowRunId: seed.runId,
    workflowStepRunId: qa.stepRunId,
    issueId: qa.issueId,
    heartbeatRunId,
    createdAt: new Date(Date.now() - 9_000),
  });
  await db.insert(issues).values({
    companyId: base.companyId,
    missionId: base.missionId,
    title: "[OVERSIGHT] Cap WF",
    status: "todo",
    originKind: "mission_main_executor_oversight",
    assigneeAgentId: base.agentId,
  });
  return { base, producerIssueId: seed.producerIssueId };
}

describeEP("QA cap owner decision wake suppression", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("qa-cap-decision-wake-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterEach(async () => { await cleanQaCapFixture(db); });
  afterAll(async () => { await tempDb?.cleanup(); });

  it.each(MISSION_OWNER_DECISION_OPTIONS)(
    "wakes a truly undecided todo action, then does not re-wake after structured %s",
    async (decision) => {
      const { base, producerIssueId } = await seedCapExhaustion(db);
      const capWake = vi.fn(async (input: { issue: { id: string } }) => {
        await db.insert(agentWakeupRequests).values({
          companyId: base.companyId,
          agentId: base.agentId,
          source: "assignment",
          status: "queued",
          reason: "mission_main_executor_unblock",
          issueId: input.issue.id,
          missionId: base.missionId,
        });
        return { id: "wake-ok" };
      });
      const service = missionService(db, {
        onOwnerActionCreated: async (input) => input.reason === "qa_rework_cap_oversight_created"
          ? capWake(input)
          : { id: "other" },
      });

      await service.runMainExecutorSupervision({
        missionId: base.missionId,
        applyOwnerDecisionActions: false,
        dispatchOwnerDecisionWakeups: false,
      });
      expect(capWake).toHaveBeenCalledTimes(1);

      const capIssues = (await db.select().from(issues).where(and(
        eq(issues.companyId, base.companyId),
        eq(issues.missionId, base.missionId),
        eq(issues.originKind, "mission_main_executor_unblock"),
      ))).filter((issue) => isQaReworkCapOversightIssue(issue.description));
      expect(capIssues).toHaveLength(1);
      const capIssue = capIssues[0]!;

      await db.update(agentWakeupRequests).set({
        status: "completed",
        finishedAt: new Date(),
      }).where(and(
        eq(agentWakeupRequests.companyId, base.companyId),
        eq(agentWakeupRequests.issueId, capIssue.id),
      ));
      // structured owner decision requires a proven author heartbeat run bound to the owner-action
      // (cap) issue, exactly as the production API passes the checked-out owner run.
      const ownerWakeupId = randomUUID();
      await db.insert(agentWakeupRequests).values({ id: ownerWakeupId, companyId: base.companyId, agentId: base.agentId, source: "test", status: "completed", issueId: capIssue.id, missionId: base.missionId, reason: "test", requestKind: "workflow_resume", requestedAt: new Date() });
      const [ownerRun] = await db.insert(heartbeatRuns).values({ companyId: base.companyId, agentId: base.agentId, issueId: capIssue.id, status: "succeeded", wakeupRequestId: ownerWakeupId, startedAt: new Date(), finishedAt: new Date(), createdAt: new Date() }).returning({ id: heartbeatRuns.id });
      await recordMissionOwnerDecision({
        db,
        issue: { id: capIssue.id, companyId: base.companyId, missionId: base.missionId },
        submission: { decision, sourceIssueRef: producerIssueId },
        sourceIssueId: producerIssueId,
        heartbeatRunId: ownerRun.id,
      });

      const result = await service.runMainExecutorSupervision({
        missionId: base.missionId,
        applyOwnerDecisionActions: false,
        dispatchOwnerDecisionWakeups: false,
      });
      expect(capWake).toHaveBeenCalledTimes(1);
      expect(result.findings).not.toEqual(
        expect.arrayContaining([expect.stringContaining("owner_action_grace_default_retry")]),
      );
    },
  );

  it("re-wakes when a natural-language decision lacks a structured record", async () => {
    const { base } = await seedCapExhaustion(db);
    const capWake = vi.fn(async (input: { issue: { id: string } }) => {
      await db.insert(agentWakeupRequests).values({
        companyId: base.companyId,
        agentId: base.agentId,
        source: "assignment",
        status: "queued",
        reason: "mission_main_executor_unblock",
        issueId: input.issue.id,
        missionId: base.missionId,
      });
      return { id: "wake-ok" };
    });
    const service = missionService(db, {
      onOwnerActionCreated: async (input) => input.reason === "qa_rework_cap_oversight_created"
        ? capWake(input)
        : { id: "other" },
    });

    await service.runMainExecutorSupervision({
      missionId: base.missionId,
      applyOwnerDecisionActions: false,
      dispatchOwnerDecisionWakeups: false,
    });
    expect(capWake).toHaveBeenCalledTimes(1);

    const [capIssue] = (await db.select().from(issues).where(and(
      eq(issues.companyId, base.companyId),
      eq(issues.missionId, base.missionId),
      eq(issues.originKind, "mission_main_executor_unblock"),
    ))).filter((issue) => isQaReworkCapOversightIssue(issue.description));
    expect(capIssue).toBeDefined();

    await db.update(agentWakeupRequests).set({
      status: "completed",
      finishedAt: new Date(),
    }).where(and(
      eq(agentWakeupRequests.companyId, base.companyId),
      eq(agentWakeupRequests.issueId, capIssue!.id),
    ));
    await db.insert(issueComments).values({
      companyId: base.companyId,
      issueId: capIssue!.id,
      authorAgentId: base.agentId,
      body: "## Mission-owner adjudication recorded\nDecision: request_input",
    });

    await service.runMainExecutorSupervision({
      missionId: base.missionId,
      applyOwnerDecisionActions: false,
      dispatchOwnerDecisionWakeups: false,
    });
    expect(capWake).toHaveBeenCalledTimes(2);
  });
});
