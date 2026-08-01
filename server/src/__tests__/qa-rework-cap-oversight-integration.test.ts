// [ scope ] This test verifies EXACT TARGET RESOLUTION ONLY — that the cap-oversight
//   description carries the producer issue ID as `Rework target` and that supervision
//   resolves the structured retry_source_issue decision to the producer, not the oversight issue.
//   It does NOT assert actual beyond-cap retry execution success (real callback + iteration/
//   run/queue/rollback). That end-to-end verification is deferred to final integration where
//   the real heartbeat callback and workflow engine participate.
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, heartbeatRuns, issues, missions } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  ensureQaReworkCapOversightIssue,
  isQaReworkCapOversightIssue,
} from "../services/missions/qa-rework-cap-oversight.js";
import { loadLatestMissionOwnerDecision, recordMissionOwnerDecision } from "../services/missions/mission-owner-recovery-ledger.js";
import { createOwnerActions } from "../services/missions/owner-actions.js";
import { missionService } from "../services/missions.js";
import {
  cleanQaCapFixture,
  loadQaCapStepRows,
  seedQaCapBase,
  seedQaCapWorkflow,
  seedStepHeartbeat,
  seedWorkflowVerdict,
  type QaCapTestDb,
} from "./helpers/qa-cap-oversight-fixture.js";
import { detectQaReworkCapExhaustion } from "../services/missions/qa-rework-cap-oversight-detection.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`skip qa-cap integration: ${support.reason ?? "unsupported"}`);

describeEP("QA cap oversight producer retry target resolution (scope: target only)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("qa-cap-integ-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterEach(async () => { await cleanQaCapFixture(db); });
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  it("description carries Rework target and retry dispatches to the producer issue", async () => {
    const base = await seedQaCapBase(db);
    const seed = await seedQaCapWorkflow(db, base, {
      iteration: 2, edges: [{ stepId: "qa-sem", maxIterations: 2 }],
    });
    const qa = seed.qas[0]!;
    const hb = await seedStepHeartbeat(db, base, {
      workflowRunId: seed.runId, workflowStepRunId: qa.stepRunId,
      issueId: qa.issueId, createdAt: new Date(Date.now() - 10_000),
    });
    await seedWorkflowVerdict(db, base, {
      workflowRunId: seed.runId, workflowStepRunId: qa.stepRunId,
      issueId: qa.issueId, heartbeatRunId: hb, createdAt: new Date(Date.now() - 9_000),
    });
    const detected = await detectQaReworkCapExhaustion({
      db, companyId: base.companyId, stepRows: await loadQaCapStepRows(db, base),
    });
    const exhaustion = detected[0]!;

    const [mission] = await db.select().from(missions).where(eq(missions.id, base.missionId));
    const [oversight] = await db.insert(issues).values({
      companyId: base.companyId, missionId: base.missionId,
      title: "[OVERSIGHT] Cap WF", status: "todo",
      originKind: "mission_main_executor_oversight", assigneeAgentId: base.agentId,
    }).returning();
    const createIssue = createOwnerActions({ db, deps: {} }).createMissionOwnerActionIssue;

    // Create a live wake row so dispatchCapWake coverage check passes.
    const capResult = await ensureQaReworkCapOversightIssue({
      db, mission, oversightIssue: oversight, exhaustion,
      workflowName: "Cap WF", createIssue,
      onOwnerActionCreated: async (input) => {
        if (input.reason !== "qa_rework_cap_oversight_created") return { id: "other" };
        const { agentWakeupRequests } = await import("@paperclipai/db");
        await db.insert(agentWakeupRequests).values({
          companyId: base.companyId, agentId: base.agentId,
          source: "assignment", status: "queued", reason: "mission_main_executor_unblock",
          issueId: input.issue.id, missionId: base.missionId,
        });
        return { id: "wake-ok" };
      },
    });
    expect(capResult?.created).toBe(true);

    // Description must carry the exact producer source issue as Rework target.
    expect(isQaReworkCapOversightIssue(capResult!.issue.description)).toBe(true);
    expect(capResult!.issue.description).toContain(`Rework target: ${seed.producerIssueId}`);

    const [ownerDecisionRun] = await db.insert(heartbeatRuns).values({
      companyId: base.companyId,
      agentId: base.agentId,
      issueId: capResult!.issue.id,
      status: "succeeded",
      startedAt: new Date(),
      finishedAt: new Date(),
    }).returning({ id: heartbeatRuns.id });
    // The structured event carries the exact producer source issue as Rework target.
    await recordMissionOwnerDecision({
      db,
      issue: { id: capResult!.issue.id, companyId: base.companyId, missionId: base.missionId },
      submission: {
        decision: "retry_source_issue",
        reworkTargetRef: seed.producerIssueId,
        reason: "owner override beyond cap",
      },
      heartbeatRunId: ownerDecisionRun!.id,
    });
    const decision = await loadLatestMissionOwnerDecision({
      db,
      companyId: base.companyId,
      ownerActionIssueId: capResult!.issue.id,
    });
    expect(decision?.decision.decision).toBe("retry_source_issue");
    expect(decision?.decision.reworkTargetRef).toBe(seed.producerIssueId);
    const retryWake = vi.fn().mockResolvedValue({ status: "dispatched" });
    const svc = missionService(db, {
      onOwnerActionCreated: async () => ({ id: "noop" }),
      onOwnerDecisionRetrySourceIssueApplied: retryWake,
    });
    await svc.runMainExecutorSupervision({
      missionId: base.missionId,
      applyOwnerDecisionActions: true,
      dispatchOwnerDecisionWakeups: true,
    });

    // SCOPE: verify exact target resolution only, not actual execution.
    expect(retryWake).toHaveBeenCalled();
    expect(retryWake.mock.calls[0]![0].sourceIssue.id).toBe(seed.producerIssueId);
  });
});
