import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  missionPlanArtifacts,
  missionPlanDecisionSubmissions,
  missions,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { closeSatisfiedReplanUnblockIssues } from "../services/missions/owner-replan-application.js";
import { recordMissionOwnerDecision } from "../services/missions/mission-owner-recovery-ledger.js";
import { evaluateRecoveryChannels } from "../services/workflow/run-terminal-recovery-gate.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping satisfied replan unblock closeout tests: ${support.reason ?? "unsupported host"}`);
}

let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
beforeAll(async () => {
  tempDb = await startEmbeddedPostgresTestDatabase("mission-replan-unblock-closeout-");
}, 60_000);
afterAll(async () => {
  await tempDb?.cleanup();
});

type Seed = {
  db: ReturnType<typeof createDb>;
  companyId: string;
  missionId: string;
  ownerAgentId: string;
  workerAgentId: string;
  sourceIssueId: string;
  unblockIssueId: string;
  initialPlanIssueId: string;
  decisionEventId: string;
};

/** A1 5207d3bf 재현 시드: blocked 소스 + blocked 언블록 이슈 + replan_mission 오너 결정.
 * 결정 전 시점의 종결 [PLAN](초기 플랜)까지 세팅해 ① 증거의 시간 방향을 검증한다. */
async function seedSatisfiedReplanMission(missionStatus: "active" | "paused"): Promise<Seed> {
  const db = createDb(tempDb!.connectionString);
  const companyId = randomUUID();
  const missionId = randomUUID();
  const ownerAgentId = randomUUID();
  const workerAgentId = randomUUID();
  const prefix = `RU${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

  await db.insert(companies).values({
    id: companyId,
    name: "Replan Unblock Closeout Company",
    issuePrefix: prefix,
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(agents).values([
    {
      id: ownerAgentId,
      companyId,
      name: "Mission Owner",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    },
    {
      id: workerAgentId,
      companyId,
      name: "Worker",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    },
  ]);
  await db.insert(missions).values({
    id: missionId,
    companyId,
    ownerAgentId,
    title: "Recover deferred finalization mission",
    description: "Close the satisfied replan unblock issue so the failed run can finalize.",
    status: missionStatus,
  });

  const issueSvc = issueService(db);
  // 결정 이전 종결 [PLAN]: ① 증거(createdAt >= 결정 시각)에 걸리지 않아야 한다.
  const initialPlanIssue = await issueSvc.create(companyId, {
    assigneeAgentId: ownerAgentId,
    missionId,
    originKind: "mission_main_executor_plan",
    status: "done",
    title: "[PLAN] Initial plan",
  });
  const sourceIssue = await issueSvc.create(companyId, {
    assigneeAgentId: workerAgentId,
    missionId,
    originKind: "workflow_execution",
    status: "blocked",
    title: "Blocked source work",
  });
  // 실서버 RES-11034 형: 미종결(blocked) 언블록 이슈가 회복 채널 (a)을 열어 둔다.
  const unblockIssue = await issueSvc.create(companyId, {
    assigneeAgentId: ownerAgentId,
    missionId,
    originKind: "mission_main_executor_unblock",
    originId: sourceIssue.id,
    status: "blocked",
    title: "Choose recovery action",
  });

  const now = new Date();
  const [heartbeat] = await db.insert(heartbeatRuns).values({
    companyId,
    agentId: ownerAgentId,
    issueId: unblockIssue.id,
    status: "succeeded",
    startedAt: now,
    finishedAt: now,
  }).returning({ id: heartbeatRuns.id });
  const decisionRecord = await recordMissionOwnerDecision({
    db,
    issue: { id: unblockIssue.id, companyId, missionId },
    submission: { decision: "replan_mission", reason: "The current plan cannot complete the mission." },
    sourceIssueId: sourceIssue.id,
    heartbeatRunId: heartbeat!.id,
  });

  return {
    db,
    companyId,
    missionId,
    ownerAgentId,
    workerAgentId,
    sourceIssueId: sourceIssue.id,
    unblockIssueId: unblockIssue.id,
    initialPlanIssueId: initialPlanIssue.id,
    decisionEventId: decisionRecord.eventId,
  };
}

/** 결정 이후 생성된 충족 증거: 잔존 [PLAN](todo) + rev-3 artifact + 구 [PLAN] 바인딩 제출. */
async function addSatisfiedEvidence(seed: Seed): Promise<void> {
  await issueService(seed.db).create(seed.companyId, {
    assigneeAgentId: seed.ownerAgentId,
    missionId: seed.missionId,
    originKind: "mission_main_executor_plan",
    status: "todo",
    title: "[PLAN] Recover deferred finalization mission",
  });
  await seed.db.insert(missionPlanArtifacts).values({
    companyId: seed.companyId,
    missionId: seed.missionId,
    revision: 3,
    status: "active",
    ownerAgentId: seed.ownerAgentId,
    missionGoal: "Regenerate the narrative pipeline with a reviewed revision plan.",
  });
  await seed.db.insert(missionPlanDecisionSubmissions).values({
    companyId: seed.companyId,
    missionId: seed.missionId,
    planningIssueId: seed.initialPlanIssueId,
    authorAgentId: seed.ownerAgentId,
    decisionHash: randomUUID(),
    decision: { revision: 3, summary: "Rev-3 plan decision" },
    status: "submitted",
  });
}

function gateStepRuns(seed: Seed) {
  return [{
    id: randomUUID(),
    stepId: "generate-report",
    issueId: seed.sourceIssueId,
    status: "failed",
    metadata: null,
  }];
}

async function fetchIssue(seed: Seed, issueId: string) {
  const [row] = await seed.db.select().from(issues).where(and(
    eq(issues.companyId, seed.companyId),
    eq(issues.id, issueId),
  )).limit(1);
  return row!;
}

describeEmbeddedPostgres("satisfied replan unblock closeout sweep", () => {
  it("closes a blocked unblock issue whose replan decision is satisfied and clears the recovery gate", async () => {
    const seed = await seedSatisfiedReplanMission("active");
    await addSatisfiedEvidence(seed);

    // 스윕 전: 미종결 언블록이 회복 채널 (a)을 열어 런 종결을 유예한다.
    const before = await evaluateRecoveryChannels(seed.db, {
      runId: randomUUID(),
      companyId: seed.companyId,
      missionId: seed.missionId,
      stepRuns: gateStepRuns(seed),
      now: new Date(),
    });
    expect(before).toEqual({
      kind: "open",
      evidence: [expect.objectContaining({
        channel: "unblock_owner_action",
        targetId: seed.unblockIssueId,
      })],
    });

    const first = await closeSatisfiedReplanUnblockIssues(seed.db);
    expect(first.closed).toBe(1);
    expect(first.failures).toEqual([]);

    const closedIssue = await fetchIssue(seed, seed.unblockIssueId);
    expect(closedIssue.status).toBe("done");
    expect(closedIssue.completedAt).not.toBeNull();

    const [activity] = await seed.db.select().from(activityLog).where(and(
      eq(activityLog.companyId, seed.companyId),
      eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, seed.unblockIssueId),
      eq(activityLog.action, "issue.updated"),
    )).limit(1);
    expect(activity).toEqual(expect.objectContaining({
      actorType: "system",
      details: expect.objectContaining({
        status: "done",
        source: "replan_satisfied_closeout",
        missionId: seed.missionId,
        decisionEventId: seed.decisionEventId,
      }),
    }));

    // 스윕 후: 회복 채널 (a)이 닫혀 런 종결(failed 확정)이 가능해진다.
    const after = await evaluateRecoveryChannels(seed.db, {
      runId: randomUUID(),
      companyId: seed.companyId,
      missionId: seed.missionId,
      stepRuns: gateStepRuns(seed),
      now: new Date(),
    });
    expect(after).toEqual({ kind: "clear", staleUnblockIssueIds: [] });

    // 2회차 실행은 완전 멱등: 이미 done 이므로 재조회 대상에서 제외된다.
    const second = await closeSatisfiedReplanUnblockIssues(seed.db);
    expect(second.closed).toBe(0);
    expect(second.failures).toEqual([]);
    expect((await fetchIssue(seed, seed.unblockIssueId)).status).toBe("done");
  });

  it("never closes an unblock issue while replanning is still in progress (no artifact, submission, or concluded plan)", async () => {
    const seed = await seedSatisfiedReplanMission("active");
    // 결정 이후 [PLAN]만 todo 로 열려 있고 ①·②·③ 충족 증거는 없다.
    await issueService(seed.db).create(seed.companyId, {
      assigneeAgentId: seed.ownerAgentId,
      missionId: seed.missionId,
      originKind: "mission_main_executor_plan",
      status: "todo",
      title: "[PLAN] Recover deferred finalization mission",
    });

    const result = await closeSatisfiedReplanUnblockIssues(seed.db);
    expect(result.closed).toBe(0);
    expect(result.failures).toEqual([]);

    const stillBlocked = await fetchIssue(seed, seed.unblockIssueId);
    expect(stillBlocked.status).toBe("blocked");
    expect(stillBlocked.completedAt).toBeNull();
  });

  it("skips missions that are not accepting work (paused) even when satisfaction evidence exists", async () => {
    const seed = await seedSatisfiedReplanMission("paused");
    await addSatisfiedEvidence(seed);

    const result = await closeSatisfiedReplanUnblockIssues(seed.db);
    expect(result.closed).toBe(0);
    expect(result.failures).toEqual([]);

    const unchanged = await fetchIssue(seed, seed.unblockIssueId);
    expect(unchanged.status).toBe("blocked");
    expect(unchanged.completedAt).toBeNull();
  });
});
