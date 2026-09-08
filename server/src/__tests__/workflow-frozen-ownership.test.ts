import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  createDb,
  heartbeatRuns,
  issues,
  type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { captureHttpError } from "./helpers/workflow-execution-definition-fixture.js";
import {
  cleanupFrozenTables,
  corruptSnapshotSteps,
  editLiveDefinition,
  seedFrozenHeartbeat,
  seedFrozenIssueStep,
  seedFrozenMissionGraph,
  seedFrozenStepRun,
  seedFrozenWakeup,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
  type RawSql,
} from "./helpers/workflow-frozen-mission-fixture.js";
import { shouldNoOpOversightWakeup } from "../services/missions/recovery-ownership-guard.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;

const FROZEN_QA_STEPS = [
  { id: "producer-a", name: "Produce A", agentId: "", dependencies: [] },
  { id: "qa-gate", name: "QA gate", agentId: "", type: "qa", dependencies: ["producer-a"] },
];
const FROZEN_NON_QA_STEPS = [{ id: "prepare", name: "Prepare pack", agentId: "", dependencies: [] }];

interface OwnershipSeed {
  companyId: string;
  missionId: string;
  runId: string;
  qaIssueId: string;
  unblockIssueId: string;
  promotedWakeupId: string;
}

describeEP("workflow frozen recovery ownership (frozen QA classification gates oversight noOp)", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("frozen-mission-ownership-");
    if (!started.supported) throw new Error(started.reason);
    fixture = started;
    db = createDb(fixture.connectionString);
  }, 60_000);

  afterEach(async () => {
    await cleanupFrozenTables(db);
  });

  afterAll(async () => {
    if (fixture?.supported) await fixture.cleanup();
  });

  /** QA issue + owner-action unblock(origin=QA issue) + promote 대상 wakeup 을 시딩한다. */
  async function seedOwnershipMission(input: {
    stepsJson: unknown[];
    liveStepsJson?: unknown[];
    liveHeartbeat?: boolean;
    liveQaWake?: boolean;
  }): Promise<OwnershipSeed> {
    const seed = await seedFrozenMissionGraph(fixture.sql, db, {
      issuePrefix: "FO" + randomUUID().slice(0, 4),
      name: "frozen-ownership-workflow",
      stepsJson: input.stepsJson,
    });
    const stepId = input.stepsJson === FROZEN_NON_QA_STEPS ? "prepare" : "qa-gate";
    const qaIssue = await seedFrozenIssueStep(db, {
      companyId: seed.companyId,
      missionId: seed.missionId,
      runId: seed.runId,
      stepId,
      title: "QA gate issue",
      issueStatus: "blocked",
      status: "failed",
      startedAt: new Date("2026-08-01T10:00:00.000Z"),
    });
    await seedFrozenStepRun(db, { runId: seed.runId, stepId: "producer-a", status: "completed" });
    const [unblock] = await db.insert(issues).values({
      companyId: seed.companyId,
      missionId: seed.missionId,
      title: "[Unblock] QA gate",
      status: "todo",
      originKind: "mission_main_executor_unblock",
      originId: qaIssue.issueId,
    }).returning();
    const promotedWakeupId = await seedFrozenWakeup(db, {
      companyId: seed.companyId,
      agentId: seed.agentId,
      issueId: qaIssue.issueId,
      missionId: seed.missionId,
      reason: "mission_owner_retry_source_issue",
      payload: { ownerActionIssueId: unblock!.id, issueId: qaIssue.issueId },
    });
    if (input.liveHeartbeat) {
      await seedFrozenHeartbeat(db, {
        companyId: seed.companyId,
        agentId: seed.agentId,
        issueId: qaIssue.issueId,
        status: "running",
        startedAt: new Date("2026-08-01T10:30:00.000Z"),
      });
    }
    if (input.liveQaWake) {
      await seedFrozenWakeup(db, {
        companyId: seed.companyId,
        agentId: seed.agentId,
        issueId: qaIssue.issueId,
        missionId: seed.missionId,
        reason: "mission_validation_request_changes",
      });
    }
    if (input.liveStepsJson) {
      await editLiveDefinition(db, seed.workflowId, { stepsJson: input.liveStepsJson });
    }
    return {
      companyId: seed.companyId,
      missionId: seed.missionId,
      runId: seed.runId,
      qaIssueId: qaIssue.issueId,
      unblockIssueId: unblock!.id,
      promotedWakeupId,
    };
  }

  function callGuard(f: OwnershipSeed) {
    return shouldNoOpOversightWakeup(db, {
      companyId: f.companyId,
      missionId: f.missionId,
      request: {
        id: f.promotedWakeupId,
        reason: "mission_owner_retry_source_issue",
        payload: { ownerActionIssueId: f.unblockIssueId, issueId: f.qaIssueId },
      },
      promotedIssue: { id: f.unblockIssueId, status: "todo" },
    });
  }

  it("still noOps on the frozen QA type after the live definition is edited to non-QA", async () => {
    const f = await seedOwnershipMission({
      stepsJson: FROZEN_QA_STEPS,
      liveHeartbeat: true,
      liveStepsJson: [
        { id: "producer-a", name: "Produce A", agentId: "", dependencies: [] },
        { id: "qa-gate", name: "Step X", agentId: "", type: "tool", dependencies: ["producer-a"] },
      ],
    });
    await expect(callGuard(f)).resolves.toMatchObject({
      noOp: true,
      qaSignal: "live_heartbeat",
      ownerActionIssueId: f.unblockIssueId,
    });
  });

  it("still noOps with a live matching QA wake even when the live graph removes the QA step", async () => {
    const f = await seedOwnershipMission({
      stepsJson: FROZEN_QA_STEPS,
      liveQaWake: true,
      liveStepsJson: [{ id: "producer-a", name: "Produce A", agentId: "", dependencies: [] }],
    });
    await expect(callGuard(f)).resolves.toMatchObject({ noOp: true, qaSignal: "live_wakeup" });
  });

  it("stored non-QA with a live QA lookalike stays an ordinary wakeup (noOp false)", async () => {
    const f = await seedOwnershipMission({
      stepsJson: FROZEN_NON_QA_STEPS,
      liveQaWake: true,
      liveStepsJson: [{ id: "prepare", name: "QA gate", agentId: "", type: "qa", dependencies: [] }],
    });
    await expect(callGuard(f)).resolves.toEqual({ noOp: false });
  });

  it("exclude-self keeps the chained promoted wakeup from forcing noOp (no new ownership rules)", async () => {
    const f = await seedOwnershipMission({ stepsJson: FROZEN_QA_STEPS });
    // promoted wakeup 자신이 live chain 매치지만 self-exclusion 으로 noOp false 여야 한다.
    await expect(callGuard(f)).resolves.toEqual({ noOp: false });
  });

  it("no-live recovery stays noOp false even with a frozen QA origin", async () => {
    const f = await seedOwnershipMission({
      stepsJson: FROZEN_QA_STEPS,
      liveStepsJson: [{ id: "producer-a", name: "Produce A", agentId: "", dependencies: [] }],
    });
    // seeded promoted wakeup 행을 지워 완전 no-live 상태를 만든다.
    await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.promotedWakeupId));
    await expect(callGuard(f)).resolves.toEqual({ noOp: false });
  });

  it.each(["missing", "corrupt"] as const)(
    "%s expected snapshot rejects before promotion and the guard performs no writes",
    async (state) => {
      const f = await seedOwnershipMission({ stepsJson: FROZEN_QA_STEPS, liveHeartbeat: true });
      const wakeupsBefore = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
      const heartbeatsBefore = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
      const issuesBefore = await db.select().from(issues).where(eq(issues.companyId, f.companyId));
      if (state === "missing") {
        await (fixture.sql as RawSql)`DELETE FROM workflow_run_definitions WHERE workflow_run_id = ${f.runId}`;
      } else {
        await corruptSnapshotSteps(fixture.sql, f.runId);
      }
      const error = await captureHttpError(callGuard(f));
      expect(error.status).toBe(422);
      expect(error.message).toBe("historical_definition_unproven");
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toEqual(wakeupsBefore);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toEqual(heartbeatsBefore);
      expect(await db.select().from(issues).where(eq(issues.companyId, f.companyId))).toEqual(issuesBefore);
    },
  );
});
