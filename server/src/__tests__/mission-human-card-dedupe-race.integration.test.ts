// server/src/__tests__/mission-human-card-dedupe-race.integration.test.ts
//
// [C1 2026-11-08] 미션당 pending mission_owner_human_input 카드 1장 계약의 DB 수준 보장.
//   - #678 R2 게이트는 SELECT→INSERT 라 서로 다른 앵커의 동시 제출이 게이트를 동시에 통과하면
//     미션에 pending 카드가 2장 생길 수 있었다. 부분 고유 인덱스가 두 번째 insert 를 거부하고,
//     충돌 시 기존 카드에 사유(repeatCount)를 누적한다(R2 동작과 동일).
//   - renewal(renewOwnerHumanRequestWithCard)도 미션에 다른 pending 카드가 있으면
//     새 카드를 만들지 않고 갱신을 보류한다(anchor 사전검사와 같은 계약, 잠금 안에서).
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  missions,
  operatorDecisions,
  workflowTransitionEvents,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { submitMissionOwnerDecision } from "../services/missions/mission-owner-recovery-agent-api.js";
import { renewOwnerHumanRequestWithCard } from "../services/missions/owner-human-request-renew.js";
import { recordMissionOwnerDecision } from "../services/missions/mission-owner-recovery-ledger.js";
import { lockOwnerHumanRequestAuthority } from "../services/missions/owner-human-request-authority.js";
import { saveOwnerHumanRequest, type OwnerHumanCurrentRecord } from "../services/missions/owner-human-request-state.js";
vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
const submission = { decision: "request_input" as const, reason: "Race blocker",
  nextAction: "사람 확인", evidence: "동시 제출 근거" };
const PENDING_MOI_FILTER = (companyId: string) => and(
  eq(operatorDecisions.companyId, companyId),
  eq(operatorDecisions.sourceType, "mission_owner_human_input"),
  eq(operatorDecisions.status, "pending"),
);
const foreignPendingCard = (companyId: string, missionId: string) => ({
  id: randomUUID(), companyId, requestKey: `moi1:${randomUUID()}`, requestHash: "seed",
  status: "pending" as const, priority: "high" as const, interactionType: "single_select" as const,
  title: "Foreign pending card", sourceType: "mission_owner_human_input", sourceId: randomUUID(),
  sourceContext: { missionId, workflowId: null, workflowRunId: null, artifactRefs: [] },
  definition: { options: [], actions: [], selection: null, comment: {
    mode: "optional", label: null, placeholder: null, maxLength: 2000 } },
});

describeDb("one pending mission-owner human card per mission (race-safe)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("moi-card-dedupe-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 5 }); await database?.cleanup();
  });

  /** 미션 1개 + 원천 1개 + 서로 다른 앵커 2개(각자 heartbeat 로 checkout). */
  async function twoAnchorWorld() {
    const companyId = randomUUID(), missionId = randomUUID(), agentId = randomUUID(),
      sourceId = randomUUID(), anchorA = randomUUID(), anchorB = randomUUID(),
      runA = randomUUID(), runB = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "DedupeCo", issuePrefix: randomUUID() });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner", status: "active" });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId,
      title: "Dedupe mission", status: "active" });
    await db.insert(issues).values({ id: sourceId, companyId, missionId, title: "Source", status: "blocked" });
    for (const [anchorId, runId] of [[anchorA, runA], [anchorB, runB]] as const) {
      await db.insert(issues).values({ id: anchorId, companyId, missionId, title: `Anchor ${anchorId}`,
        status: "todo", assigneeAgentId: agentId, originKind: "mission_main_executor_unblock", originId: sourceId });
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId: anchorId, status: "running" });
      await issueService(db).checkout(anchorId, agentId, ["todo"], runId);
    }
    return { companyId, missionId, agentId, sourceId, anchorA, anchorB, runA, runB };
  }
  const submit = (w: Awaited<ReturnType<typeof twoAnchorWorld>>, anchorId: string, runId: string) =>
    submitMissionOwnerDecision({ db, issueId: anchorId,
      actor: { actorType: "agent" as const, actorId: w.agentId, agentId: w.agentId, runId },
      data: { ...submission } });
  const pendingCards = async (companyId: string) =>
    db.select().from(operatorDecisions).where(PENDING_MOI_FILTER(companyId));

  it("two concurrent submissions on different anchors leave exactly one pending card and fold the repeat into it", async () => {
    const w = await twoAnchorWorld();
    // legacy(moi1) 제출은 미션 lifetime CAS 대상이 아니므로 서로 다른 앵커의 동시 제출이
    // R2 게이트(카드 없음 통과)를 함께 통과한다 — SELECT→INSERT 레이스의 실제 표면.
    await Promise.all([
      submit(w, w.anchorA, w.runA),
      submit(w, w.anchorB, w.runB),
    ]);
    const pending = await pendingCards(w.companyId);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.sourceContext).toMatchObject({
      missionId: w.missionId,
      missionOwnerHumanInput: { repeatCount: 1 },
    });
  }, 30_000);

  it("the partial unique index rejects a second pending mission-owner human card row for the same mission", async () => {
    const companyId = randomUUID(), missionId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "IndexCo", issuePrefix: randomUUID() });
    await db.insert(agents).values({ id: agentId, companyId, name: "Idx", status: "active" });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId,
      title: "Index mission", status: "active" });
    await db.insert(operatorDecisions).values(foreignPendingCard(companyId, missionId));
    await expect(db.insert(operatorDecisions).values(foreignPendingCard(companyId, missionId)))
      .rejects.toMatchObject({ code: "23505" });
    expect(await pendingCards(companyId)).toHaveLength(1);
    // 다른 미션의 pending 카드는 영향을 받지 않는다.
    const otherMission = randomUUID();
    await db.insert(missions).values({ id: otherMission, companyId, ownerAgentId: agentId,
      title: "Other mission", status: "active" });
    await db.insert(operatorDecisions).values(foreignPendingCard(companyId, otherMission));
    expect(await pendingCards(companyId)).toHaveLength(2);
  }, 30_000);

  it("renewal defers (no new card, no new lifetime) while a different pending card holds the mission", async () => {
    // c08 style world: 종결 앵커 + keyed lifetime(card 미생성) + 대기 중 갱신 앵커.
    const companyId = randomUUID(), missionId = randomUUID(), agentId = randomUUID(),
      sourceId = randomUUID(), oldId = randomUUID(), nextId = randomUUID(), heartbeatId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "RenewDeferCo", issuePrefix: randomUUID() });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner", status: "active" });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId,
      title: "Renew defer mission", status: "active" });
    await db.insert(issues).values([
      { id: sourceId, companyId, missionId, title: "Source", status: "blocked" },
      { id: oldId, companyId, missionId, title: "Original", status: "in_progress",
        assigneeAgentId: agentId, originKind: "mission_main_executor_unblock", originId: sourceId },
      { id: nextId, companyId, missionId, title: "Next anchor", status: "todo",
        assigneeAgentId: agentId, originKind: "mission_main_executor_unblock", originId: sourceId },
    ]);
    await db.insert(heartbeatRuns).values({ id: heartbeatId, companyId, agentId, issueId: oldId, status: "running" });
    const original: OwnerHumanCurrentRecord = await db.transaction(async (tx) => {
      const auth = await lockOwnerHumanRequestAuthority(tx, { companyId, missionId, agentId,
        ownerActionIssueId: oldId, heartbeatRunId: heartbeatId });
      const decision = await recordMissionOwnerDecision({ db: tx,
        issue: { id: oldId, companyId, missionId }, submission, sourceIssueId: sourceId, heartbeatRunId: heartbeatId });
      return saveOwnerHumanRequest(auth, { schemaVersion: 1, requestKey: randomUUID(),
        expectedCurrentLifetimeId: null, identityMode: "keyed", decisionEventId: decision.eventId, submission });
    });
    await issueService(db).update(oldId, { status: "cancelled" });
    // 미션에 다른(레거시) pending 카드가 이미 있다.
    const foreign = foreignPendingCard(companyId, missionId);
    await db.insert(operatorDecisions).values(foreign);

    const result = await db.transaction((tx) => renewOwnerHumanRequestWithCard(tx, {
      companyId, previousLifetimeId: original.lifetime.lifetimeId, anchorIssueId: nextId,
      requestKey: `owner-anchor-renewal:v2:${original.lifetime.lifetimeId}`,
    }));

    const pending = await pendingCards(companyId);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.requestKey).toBe(foreign.requestKey);
    const lifetimes = await db.select({ id: workflowTransitionEvents.id })
      .from(workflowTransitionEvents)
      .where(and(eq(workflowTransitionEvents.companyId, companyId),
        eq(workflowTransitionEvents.eventType, "owner_human_lifetime_v1")));
    expect(lifetimes).toHaveLength(1);
    expect(result).toMatchObject({ deferred: true });
  }, 30_000);
});
