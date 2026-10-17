// server/src/__tests__/mission-owner-human-input-e2e.integration.test.ts
//
// [목적] 사람 핸드오프 결정 전 구간 계약 E2E(계획 2026-10-17-human-decision-escalation-contract
//   Stage 3): 미션 오너 request_input/escalate 제출(POST /issues/:id/owner-recovery/decision) →
//   operator decision 카드 생성(requestKey=moi1:{eventId}) → 운영자 resolve → requester(오너)
//   웨이크 전달까지를 라우트 레벨로 증명한다. Stage 1 브리지(mission-owner-human-input-card)와
//   Stage 2 UI 바인딩 규약(행 evidenceRefs.decisionEventId ↔ 카드 requestKey)의 접합을 함께 검증한다.
// [시나리오] S1 풀 루프 / S2 중복 제출 멱등+알림 1회 / S3 카드 생성 실패 fail-closed(D4) /
//   S4 target_changed 409 후 복원 재해결(D5 앵커 issueId+issueStatus) / S5 escalate 동일 계약 /
//   S6 C4 인박스↔카드 연결 키가 라우트 응답에서 유지됨.
// [웨이크 모드] resolve 즉시 웨이크는 오너의 활성 checkout run 존재 여부에 따라 두 가지로 전달된다 —
//   run 종료 후: reason=operator_decision_resolved_assignee_wakeup(신규 queued wake),
//   run 실행 중: 기존 run 흡수(reason=issue_execution_same_name, status=coalesced) — 두 모두
//   멱등 키 operator-decision-resolved:{cardId} 와 수신자(오너)를 유지하는 기존 admission 계약이다.
// [주의] 서버 로직 변경은 이 테스트가 실제 결함을 잡았을 때만 한다. 인접 계약(dedup·알림 1회·
//   oversight 제한·agent_required·기존 카드 경로)은 수정하지 않는다.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  missions,
  operatorDecisionContinuations,
  operatorDecisions,
  workflowDefinitions,
  workflowRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { operatorDecisionRoutes } from "../routes/operator-decisions.js";
import { workflowAgentApiRoutes } from "../routes/workflow-agent-api.js";
import { publishLiveEvent } from "../services/live-events.js";
import { listCompanyHumanOperatorRequests } from "../services/missions/human-operator-requests.js";
import {
  buildMissionOwnerHumanInputDecisionCard,
  createMissionOwnerHumanInputDecisionCard,
  MISSION_OWNER_HUMAN_INPUT_CARD_MAPPING_FAILED,
  MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE,
  type MissionOwnerHumanInputCardSpec,
} from "../services/missions/mission-owner-human-input-card.js";

vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));
// [S3] D4 post-commit 실패 경로 주입용 — 결정적 빌더는 실제 구현을 유지한다(Stage 1 테스트와 동일 패턴).
vi.mock("../services/missions/mission-owner-human-input-card.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/missions/mission-owner-human-input-card.js")>();
  return { ...actual, createMissionOwnerHumanInputDecisionCard: vi.fn(actual.createMissionOwnerHumanInputDecisionCard) };
});

function publishesOfType(type: string) {
  return vi.mocked(publishLiveEvent).mock.calls.filter((call) => (call[0] as { type?: string })?.type === type);
}

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("mission owner human-input decision card contract E2E", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let ownerId: string;
  let missionId: string;
  let issueId: string;
  let runId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("mission-owner-human-input-e2e-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  beforeEach(async () => {
    companyId = randomUUID();
    ownerId = randomUUID();
    missionId = randomUUID();
    issueId = randomUUID();
    runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "HumanInputE2E", issuePrefix: `E2${companyId.slice(0, 4)}`, requireBoardApprovalForNewAgents: false });
    // 어댑터 지정 없음(기본 process) — resolve 웨이크 실행 체인이 테스트 안에서 종료 상태까지
    //   도달해야 afterEach 정리와 경합하지 않는다(operator-decision-routes 시드와 동일).
    await db.insert(agents).values({ id: ownerId, companyId, name: "mission-owner", status: "active" });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: ownerId, title: "E2E mission", status: "active" });
    await db.insert(issues).values({ id: issueId, companyId, missionId, title: "Owner oversight", status: "in_progress", originKind: "mission_main_executor_oversight", assigneeAgentId: ownerId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: ownerId, issueId, status: "running" });
    await db.update(issues).set({ checkoutRunId: runId }).where(eq(issues.id, issueId));
  });

  afterEach(async () => {
    // resolve 즉시 웨이크의 비동기 실행 체인(번들 스킬 upsert·run 생성)이 다음 테이블 정리와
    // 경합하지 않도록 깨움이 종료 상태가 될 때까지 기다린다(operator-decision-routes 와 동일 원인).
    const deadline = Date.now() + 10_000;
    for (;;) {
      const rows = await db.select({ status: agentWakeupRequests.status }).from(agentWakeupRequests);
      if (!rows.some((row) => ["queued", "claimed", "deferred_issue_execution"].includes(row.status))) break;
      if (Date.now() > deadline) throw new Error(`wakeup chains did not settle within 10s: ${JSON.stringify(rows)}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    vi.clearAllMocks();
    await db.delete(workflowTransitionEvents);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agentTaskSessions);
    await db.delete(companySkills);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(operatorDecisionContinuations);
    await db.delete(operatorDecisions);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  }, 15_000);

  function app(actor: "board" | "owner" = "board") {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      req.actor = actor === "board"
        ? { type: "board", userId: "board-user", companyIds: [], source: "local_implicit", isInstanceAdmin: true }
        : { type: "agent", agentId: ownerId, companyId, runId };
      next();
    });
    server.use("/api", workflowAgentApiRoutes(db));
    server.use("/api", operatorDecisionRoutes(db));
    server.use(errorHandler);
    return server;
  }

  const decisionBody = (overrides: Record<string, unknown> = {}) => ({
    decision: "request_input",
    reason: "권한 밖 결정이라 사람 승인이 필요합니다",
    nextAction: "운영자 승인 후 다음 단계를 진행해 주세요",
    evidence: "실행 근거 https://example.com/run-log",
    ...overrides,
  });
  const submitDecision = (body: Record<string, unknown> = decisionBody()) =>
    request(app("owner")).post(`/api/issues/${issueId}/owner-recovery/decision`).send(body);
  const resolveCard = (cardId: string, body: Record<string, unknown> = { actionId: "approve", selectedOptionIds: ["approve"], comment: "승인합니다 — 진행하세요" }) =>
    request(app("board")).post(`/api/operator-decisions/${cardId}/resolve`).send(body);

  async function pendingCards() {
    const res = await request(app("board")).get(`/api/companies/${companyId}/operator-decisions`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.data as Array<{ id: string; requestKey: string; sourceId: string; status: string; sourceType: string; issueId: string | null; requestedBy: { type: string; id: string } | null }>;
  }
  async function moiCard(eventId: string) {
    const card = (await pendingCards()).find((row) => row.requestKey === `moi1:${eventId}`);
    expect(card, `pending card moi1:${eventId} missing`).toBeTruthy();
    return card!;
  }
  async function historyCard(eventId: string) {
    const res = await request(app("board")).get(`/api/companies/${companyId}/operator-decisions?view=history`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const card = (res.body.data as Array<{ id: string; requestKey: string; status: string; resolvedByUserId: string | null }>)
      .find((row) => row.requestKey === `moi1:${eventId}`);
    expect(card, `history card moi1:${eventId} missing`).toBeTruthy();
    return card!;
  }
  async function completeOwnerRun() {
    // run 종료 후 resolve → 즉시 웨이크가 새 queued 행으로 전달되는 표준 모드를 만든다.
    // "completed" 는 legacy(v1 플래그 무관) in-flight 절(queued/running + terminal-but-unsettled
    // succeeded/failed/cancelled/timed_out) 어느 쪽에도 걸리지 않는 값이라 플래그와 무관하게
    // 섹션 [B] mission-run dedup(queued 강제)을 피한다.
    await db.update(heartbeatRuns).set({ status: "completed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
  }
  async function wakeRowsByIdempotencyKey(cardId: string) {
    return db.select({
      agentId: agentWakeupRequests.agentId,
      reason: agentWakeupRequests.reason,
      status: agentWakeupRequests.status,
    }).from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, `operator-decision-resolved:${cardId}`));
  }

  it("S1: owner request_input submission creates the card, operator resolve wakes the mission owner", async () => {
    // 1) 오너 제출 — 라우트 201 + ledger eventId
    const submitted = await submitDecision();
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
    expect(submitted.body).toMatchObject({ decision: "request_input", eventId: expect.any(String) });
    const eventId: string = submitted.body.eventId;

    // 2) 카드 생성 확인 — GET 목록에서 requestKey=moi1:{eventId}
    const card = await moiCard(eventId);
    expect(card).toMatchObject({
      sourceType: MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE,
      sourceId: eventId,
      status: "pending",
      issueId,
      requestedBy: { type: "agent", id: ownerId },
    });
    const detail = await request(app("board")).get(`/api/operator-decisions/${card.id}`);
    expect(detail.status).toBe(200);
    const definition = detail.body.data.definition;
    expect(definition.options.map((option: { id: string }) => option.id)).toEqual(["approve", "hold", "reject"]);
    expect(definition.comment.mode).toBe("required");
    expect(definition.humanReview.evidence[0]).toMatchObject({ href: `/issues/${issueId}` });

    // 3) run 종료 후 운영자 resolve → 200 applied
    await completeOwnerRun();
    const resolved = await resolveCard(card.id);
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect(resolved.body.data).toMatchObject({
      applied: true,
      decision: { status: "resolved", resolvedByUserId: "board-user", result: { actionId: "approve", outcome: "approve", selectedOptionIds: ["approve"] } },
    });

    // 4) C3 — requester(미션 오너)에게 멱등 웨이크 전달
    const wakes = await wakeRowsByIdempotencyKey(card.id);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ agentId: ownerId, reason: "operator_decision_resolved_assignee_wakeup" });

    // 5) delivery bridge — owner-action 이슈에 결정 코멘트
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain(card.id);
  }, 30_000);

  it("S2: identical resubmission dedups to the same eventId, reuses the card, and alerts once", async () => {
    const first = await submitDecision();
    expect(first.status).toBe(201);
    const second = await submitDecision();
    expect(second.status).toBe(201);
    expect(second.body.eventId).toBe(first.body.eventId);

    const cards = await db.select().from(operatorDecisions).where(eq(operatorDecisions.companyId, companyId));
    expect(cards).toHaveLength(1);
    expect(cards[0]!.requestKey).toBe(`moi1:${first.body.eventId}`);
    expect(cards[0]!.sourceId).toBe(first.body.eventId);

    // 알림 1회 계약 — 사람 알림(mission.human_input_requested)도, 카드 생성 이벤트도 1회.
    expect(publishesOfType("mission.human_input_requested")).toHaveLength(1);
    expect(publishesOfType("operator_decision.created")).toHaveLength(1);
    const inboxActivities = await db.select().from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    expect(inboxActivities.filter((row) => row.action === "mission.owner.human_input_requested")).toHaveLength(1);
  });

  it("S3: card-write failure fails the submission closed (D4), keeps the ledger, and recovers by resubmission", async () => {
    // 매핑 실패 실제 모드 — 빌더는 앵커/옵션을 해석할 수 없으면 422(mapping_failed)로 fail-closed 한다.
    // 라우트 브리지는 이 경로가 커밋 전 가드로 차단되므로(앵커 무결성 검증) 라우트에서 관측되는
    // 실패는 post-commit 카드 생성 실패(500 card_failed)다 — D4 계약 그 자체.
    const spec: MissionOwnerHumanInputCardSpec = {
      companyId, missionId, decisionEventId: randomUUID(), decision: "request_input",
      ownerActionIssueId: issueId, ownerActionIssueStatus: "in_progress",
      requestedByAgentId: ownerId,
    };
    try {
      buildMissionOwnerHumanInputDecisionCard({ ...spec, structuredOptions: [{ id: "", label: "x" }] });
      expect.unreachable("mapping failure expected");
    } catch (error) {
      expect(error).toMatchObject({ status: 422, details: { code: MISSION_OWNER_HUMAN_INPUT_CARD_MAPPING_FAILED } });
    }

    // 라우트 레벨 D4 — 카드 생성 실패가 제출 실패(500)로 이어지고 카드는 남지 않는다.
    vi.mocked(createMissionOwnerHumanInputDecisionCard).mockRejectedValueOnce(new Error("injected card write failure"));
    const failed = await submitDecision();
    expect(failed.status, JSON.stringify(failed.body)).toBe(500);
    expect(failed.body).toMatchObject({
      details: {
        code: "mission_owner_human_input_card_failed",
        decisionEventId: expect.any(String),
        requestKey: expect.stringMatching(/^moi1:/),
      },
    });
    const eventId: string = failed.body.details.decisionEventId;
    expect(await db.select().from(operatorDecisions).where(eq(operatorDecisions.companyId, companyId))).toHaveLength(0);

    // ledger 결정과 사람 알림은 커밋 유지(D4 순서), 재제출 없이도 inbox 행이 존재한다.
    const [ledger] = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.issueId, issueId));
    expect(ledger).toMatchObject({ id: eventId, layer: "mission_owner_recovery" });
    expect(ledger?.payload).toMatchObject({ decision: "request_input" });
    expect(publishesOfType("mission.human_input_requested")).toHaveLength(1);

    // 재제출 → ledger dedup 동일 eventId → requestKey 멱등으로 카드 재생성, 알림 추가 없음.
    const replay = await submitDecision();
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    expect(replay.body.eventId).toBe(eventId);
    const cards = await db.select().from(operatorDecisions).where(eq(operatorDecisions.companyId, companyId));
    expect(cards).toHaveLength(1);
    expect(cards[0]!.requestKey).toBe(`moi1:${eventId}`);
    expect(publishesOfType("mission.human_input_requested")).toHaveLength(1);
  });

  it("S4: drifted owner-issue status rejects resolve with 409 target_changed and the restored card re-resolves", async () => {
    const submitted = await submitDecision();
    const eventId: string = submitted.body.eventId;
    const card = await moiCard(eventId);
    // D5 앵커 확인 — 스냅샷은 owner-action 이슈의 issueId+issueStatus 만 담는다.
    const [row] = await db.select().from(operatorDecisions).where(eq(operatorDecisions.id, card.id));
    expect((row!.sourceContext as { targetSnapshot: Record<string, unknown> }).targetSnapshot)
      .toEqual({ issueId, issueStatus: "in_progress" });

    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, issueId));
    const conflict = await resolveCard(card.id);
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({
      details: { code: "target_changed", mismatch: expect.arrayContaining(["issueStatus"]), operatorDecisionId: card.id },
    });
    const [stillPending] = await db.select().from(operatorDecisions).where(eq(operatorDecisions.id, card.id));
    expect(stillPending).toMatchObject({ status: "pending", result: null });

    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, issueId));
    await completeOwnerRun();
    const resolved = await resolveCard(card.id);
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect(resolved.body.data).toMatchObject({ applied: true, decision: { status: "resolved" } });
    const wakes = await wakeRowsByIdempotencyKey(card.id);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ agentId: ownerId, reason: "operator_decision_resolved_assignee_wakeup" });
  }, 30_000);

  it("S5: escalate submissions satisfy the same card contract and deliver the resolve wake", async () => {
    const submitted = await submitDecision({ decision: "escalate", reason: "외부 의존성 장애라 내 권한으로 돌파할 수 없습니다" });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
    expect(submitted.body).toMatchObject({ decision: "escalate", eventId: expect.any(String) });
    const eventId: string = submitted.body.eventId;

    const card = await moiCard(eventId);
    expect(card).toMatchObject({ sourceType: MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE, sourceId: eventId, issueId, requestedBy: { type: "agent", id: ownerId } });
    const detail = await request(app("board")).get(`/api/operator-decisions/${card.id}`);
    expect(detail.body.data.definition.humanReview.decisionSubject).toContain("escalate");

    // 오너 run 이 아직 실행 중인 resolve — 웨이크는 활성 run 에 흡수(coalesced)되어도
    // 같은 멱등 키·같은 수신자(오너)로 전달되는 것이 기존 admission 계약이다.
    const resolved = await resolveCard(card.id);
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect(resolved.body.data).toMatchObject({ applied: true, decision: { status: "resolved" } });
    const wakes = await wakeRowsByIdempotencyKey(card.id);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ agentId: ownerId, reason: "issue_execution_same_name", status: "coalesced" });
  }, 30_000);

  it("S6: the inbox row and the card keep the C4 join key (decisionEventId ↔ requestKey) on route responses", async () => {
    const submitted = await submitDecision();
    const eventId: string = submitted.body.eventId;

    // 인박스 행(UI requests 섹션)의 decisionEventId 참조
    const requests = await listCompanyHumanOperatorRequests(db, { companyId });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ issueId, missionId });
    expect(requests[0]!.event.evidenceRefs[0]).toMatchObject({ type: "log", ref: eventId });

    // 카드 쪽 — Stage 2 UI 바인딩 규약(requestKey=moi1:{eventId})이 라우트 GET 응답에 그대로 노출된다.
    const pendingBefore = await moiCard(eventId);
    expect(pendingBefore).toMatchObject({ sourceId: eventId, status: "pending", issueId });

    await completeOwnerRun();
    const resolved = await resolveCard(pendingBefore.id);
    expect(resolved.status).toBe(200);

    // 해결 후 양쪽 상태 일치 — pending 목록에서 사라지고 history 에 resolved 로 남는다(같은 requestKey).
    expect((await pendingCards()).some((row) => row.requestKey === `moi1:${eventId}`)).toBe(false);
    const after = await historyCard(eventId);
    expect(after).toMatchObject({ status: "resolved", resolvedByUserId: "board-user" });
    expect(after.requestKey).toBe(`moi1:${eventId}`);
  }, 30_000);
});
