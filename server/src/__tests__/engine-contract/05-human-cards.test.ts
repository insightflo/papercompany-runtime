// engine-contract S10·S11·S12 — 사람 결정 카드 계약 (#678·#680 회귀).
// seed: 순수 DB 행 → entry: createMissionOwnerHumanInputDecisionCard / runMissionTerminalCleanup /
//   admitHumanCardForSource → assert: operator_decisions / activity_log 최종 행만.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, issues, missions, operatorDecisions } from "@paperclipai/db";
import { createMissionOwnerHumanInputDecisionCard } from "../../services/missions/mission-owner-human-input-card.js";
import {
  admitHumanCardForSource,
  evaluateHumanCardAdmission,
  loadSourceTerminalRun,
} from "../../services/missions/human-card-admission.js";
import { runMissionTerminalCleanup } from "../../services/missions/terminal-cleanup-fence.js";
import {
  MIN,
  describeEP,
  seedHeartbeatRun,
  seedPendingHumanCard,
  startContractDb,
  type ContractDb,
} from "./helpers.js";

let w: ContractDb;

beforeAll(async () => {
  w = await startContractDb("contract-cards-", { finalizationV1: true });
}, 120_000);

afterAll(async () => {
  await w.temp.cleanup();
});

async function pendingCards(missionId: string) {
  return w.db
    .select()
    .from(operatorDecisions)
    .where(and(
      eq(operatorDecisions.companyId, w.companyId),
      eq(operatorDecisions.status, "pending"),
      eq(operatorDecisions.sourceType, "mission_owner_human_input"),
      sql`${operatorDecisions.sourceContext}->>'missionId' = ${missionId}`,
    ));
}

describeEP("engine-contract S10/S11/S12 — human decision cards (#678/#680)", () => {
  it("S10: 미션당 pending 카드는 정확히 1장 — 재발행은 접히고 고유 인덱스는 두 번째 insert 를 거부한다", async () => {
    const [mission] = await w.db.insert(missions).values({
      companyId: w.companyId, title: "card mission", status: "active", ownerAgentId: w.agentId,
    }).returning();
    const [issue] = await w.db.insert(issues).values({
      companyId: w.companyId, missionId: mission.id, title: "owner issue", status: "in_progress",
      assigneeAgentId: w.agentId,
    }).returning();

    const spec = (eventId: string) => ({
      companyId: w.companyId,
      missionId: mission.id,
      decisionEventId: eventId,
      decision: "request_input" as const,
      ownerActionIssueId: issue.id,
      ownerActionIssueStatus: "in_progress",
      requestedByAgentId: w.agentId,
      reason: "contract dedupe check",
    });
    const first = await createMissionOwnerHumanInputDecisionCard(w.db, spec(randomUUID()));
    expect(first.decision.status).toBe("pending");

    // 재발행(다른 decision event)은 새 카드가 아니라 기존 pending 카드로 접힌다.
    const second = await createMissionOwnerHumanInputDecisionCard(w.db, spec(randomUUID()));
    expect(second.decision.id).toBe(first.decision.id);
    const cards = await pendingCards(mission.id);
    expect(cards.length).toBe(1);
    const repeat = cards[0]!.sourceContext.missionOwnerHumanInput?.repeatCount;
    expect(repeat).toBeGreaterThanOrEqual(1);

    // DB 부분 고유 인덱스 자체도 같은 계약 — 직접 insert 는 23505 로 거부된다.
    let indexError: unknown = null;
    try {
      await seedPendingHumanCard(w.db, { companyId: w.companyId, missionId: mission.id });
    } catch (error) {
      indexError = error;
    }
    expect(indexError).not.toBeNull();
    expect(String(indexError)).toContain("pending_mission_human_input");
    expect((await pendingCards(mission.id)).length).toBe(1);

    // 다른 미션의 pending 카드는 영향 없이 발행 가능하다(스코프 계약).
    const [otherMission] = await w.db.insert(missions).values({
      companyId: w.companyId, title: "other mission", status: "active", ownerAgentId: w.agentId,
    }).returning();
    const other = await seedPendingHumanCard(w.db, { companyId: w.companyId, missionId: otherMission.id });
    expect(other.status).toBe("pending");
  });

  it("S11: 미션 종결 cleanup 은 pending 사람 카드를 회수하고 다른 미션 카드는 남긴다", async () => {
    const [mission] = await w.db.insert(missions).values({
      companyId: w.companyId, title: "withdraw mission", status: "completed", ownerAgentId: w.agentId,
    }).returning();
    const [otherMission] = await w.db.insert(missions).values({
      companyId: w.companyId, title: "keep mission", status: "active", ownerAgentId: w.agentId,
    }).returning();
    const card = await seedPendingHumanCard(w.db, { companyId: w.companyId, missionId: mission.id });
    const otherCard = await seedPendingHumanCard(w.db, { companyId: w.companyId, missionId: otherMission.id });

    const now = new Date();
    const [snapshot] = await w.db.select().from(missions).where(eq(missions.id, mission.id));
    const result = await runMissionTerminalCleanup(w.db, {
      companyId: w.companyId,
      missionId: mission.id,
      status: "completed",
      now,
      completedAt: now,
      missionSnapshot: snapshot!,
      pendingMissionUpdates: { status: "completed", updatedAt: now },
    });
    expect(result.aborted).toBe(false);

    const [after] = await w.db.select().from(operatorDecisions).where(eq(operatorDecisions.id, card.id));
    expect(after.status).toBe("cancelled");
    expect(after.cancelledAt).not.toBeNull();
    const [other] = await w.db.select().from(operatorDecisions).where(eq(operatorDecisions.id, otherCard.id));
    expect(other.status).toBe("pending");

    const audit = await w.db.select().from(activityLog).where(and(
      eq(activityLog.companyId, w.companyId),
      eq(activityLog.entityType, "operator_decision"),
      eq(activityLog.entityId, card.id),
    ));
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });

  it("S12: admission 게이트 — 자동 복구 가능·미정산 원인에는 카드를 열지 않고 사람 필요 원인만 허용한다", async () => {
    const mkIssue = async (title: string) => {
      const [issue] = await w.db.insert(issues).values({
        companyId: w.companyId, title, status: "in_progress", assigneeAgentId: w.agentId,
      }).returning();
      return issue;
    };

    // (a) 자동 복구 가능 error_code — 카드 거부.
    const issueA = await mkIssue("recoverable");
    await seedHeartbeatRun(w.db, {
      companyId: w.companyId, agentId: w.agentId, issueId: issueA.id,
      status: "failed", terminalOutcome: "failed", error: "429", errorCode: "adapter_failed",
      finishedAt: new Date(Date.now() - 5 * MIN), settledAt: new Date(Date.now() - 5 * MIN),
    });
    const runA = await loadSourceTerminalRun(w.db, w.companyId, issueA.id);
    expect(evaluateHumanCardAdmission(runA).admit).toBe(false);
    const admissionA = await admitHumanCardForSource(w.db, w.companyId, issueA.id);
    expect(admissionA.admit).toBe(false);
    expect(admissionA.cause).toBe("auto_recoverable_error_code");

    // (b) terminal 이지만 미정산 — 정산 회수가 먼저이므로 카드 거부.
    const issueB = await mkIssue("unsettled");
    await seedHeartbeatRun(w.db, {
      companyId: w.companyId, agentId: w.agentId, issueId: issueB.id,
      status: "failed", terminalOutcome: "failed", error: "boom", errorCode: "unexpected",
      finishedAt: new Date(Date.now() - 5 * MIN), settledAt: null,
      finalizationVersion: 1,
    });
    const admissionB = await admitHumanCardForSource(w.db, w.companyId, issueB.id);
    expect(admissionB.admit).toBe(false);
    expect(admissionB.cause).toBe("settlement_pending");

    // (c) 정산 완료 + 비자동복구 원인 — 사람 카드 허용.
    const issueC = await mkIssue("human-needed");
    await seedHeartbeatRun(w.db, {
      companyId: w.companyId, agentId: w.agentId, issueId: issueC.id,
      status: "failed", terminalOutcome: "failed", error: "needs human", errorCode: "unexpected",
      finishedAt: new Date(Date.now() - 5 * MIN), settledAt: new Date(Date.now() - 5 * MIN),
    });
    const admissionC = await admitHumanCardForSource(w.db, w.companyId, issueC.id);
    expect(admissionC.admit).toBe(true);
  });
});
