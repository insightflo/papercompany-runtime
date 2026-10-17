import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  issues,
  missions,
  operatorDecisionContinuations,
  operatorDecisions,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { operatorDecisionContinuationWorker } from "../services/operator-decision-continuation-worker.js";
import { operatorDecisionWriteService } from "../services/operator-decisions-write.js";
import { loadOperatorDecisionProjection } from "../services/operator-decision-view.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
// Match DB due time and JS poll time exactly; DB now() retains sub-millisecond precision.
const fixtureTime = new Date("2026-07-29T12:00:00Z");
const definition = {
  options: [{ id: "one", label: "One", description: null, facts: [], evidenceRefs: [] }],
  actions: [{ id: "choose", label: "Choose", outcome: "submit", tone: "primary", requiresSelection: true }],
  selection: { min: 1, max: 1 },
  comment: { mode: "disabled", label: null, placeholder: null, maxLength: 0 },
  approvedScope: [], forbiddenScope: [],
} as const;

describeDb("operator decision continuation worker", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;
  let issueId: string;
  let decisionId: string;

  // [requester delivery] 카드 원 요청자 픽스처 — requestedByAgentId 전달 경로 테스트 공용.
  async function insertRequesterAgent(agentCompanyId = companyId) {
    const requesterId = randomUUID();
    await db.insert(agents).values({ id: requesterId, companyId: agentCompanyId, name: "Requester" });
    return requesterId;
  }

  // [requester delivery] queued wakeup 행을 실제로 insert 하는 mock — 전달 증거(findProof) 경로 포함.
  function queuedWakeupMock() {
    return vi.fn(async (targetAgentId: string, options: Record<string, unknown>) => {
      await db.insert(agentWakeupRequests).values({
        companyId, agentId: targetAgentId, source: "automation", status: "queued",
        triggerDetail: "system", reason: "operator_decision_resolved",
        payload: options.payload as Record<string, unknown>,
        requestedByActorType: "user", requestedByActorId: "board",
        idempotencyKey: options.idempotencyKey as string,
        issueId,
      });
    });
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("operator-decision-worker-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });
  beforeEach(async () => {
    await db.delete(activityLog);
    await db.delete(operatorDecisionContinuations);
    await db.delete(operatorDecisions);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Worker", issuePrefix: `W${companyId.slice(0, 4)}` });
    agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Target" });
    issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Work", status: "todo", assigneeAgentId: agentId });
    decisionId = randomUUID();
    await db.insert(operatorDecisions).values({
      id: decisionId, companyId, requestKey: randomUUID(), requestHash: "hash", status: "resolved",
      interactionType: "single_select", title: "Choose", sourceType: "workflow_step", sourceId: "step",
      sourceContext: { missionId: null, workflowId: null, workflowRunId: null, artifactRefs: [] },
      issueId, definition, result: { actionId: "choose", outcome: "submit", selectedOptionIds: ["one"], comment: null },
      resolvedByUserId: "board", resolvedAt: fixtureTime, continuationMode: "issue_current_assignee",
      requestedByUserId: "board",
    });
    await db.insert(operatorDecisionContinuations).values({
      companyId, operatorDecisionId: decisionId, issueId, nextAttemptAt: fixtureTime,
    });
  });

  it("calls heartbeat with the exact envelope and accepts durable proof", async () => {
    const wakeup = vi.fn(async (targetAgentId: string, options: Record<string, unknown>) => {
      await db.insert(agentWakeupRequests).values({
        companyId, agentId: targetAgentId, source: "automation", status: "queued",
        triggerDetail: "system", reason: "operator_decision_resolved",
        payload: options.payload as Record<string, unknown>,
        requestedByActorType: "user", requestedByActorId: "board",
        idempotencyKey: options.idempotencyKey as string,
        issueId,
      });
    });
    const worker = operatorDecisionContinuationWorker(db, { wakeup, workerId: "test-worker" });
    expect(await worker.pollOnce(fixtureTime)).toBe(1);
    // [delivery bridge] payload/contextSnapshot 매칭에 paperclipOperatorDecisionResolution 키 추가 —
    //   기존 키의 의미는 변경 없음(신규 전달 필드 추가).
    expect(wakeup).toHaveBeenCalledWith(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "operator_decision_resolved",
      payload: {
        kind: "operator_decision_resolution",
        operatorDecisionId: decisionId,
        issueId,
        actionId: "choose",
        selectedOptionIds: ["one"],
        paperclipOperatorDecisionResolution: {
          operatorDecisionId: decisionId,
          options: [{ id: "one", label: "One", description: null }],
        },
      },
      contextSnapshot: {
        issueId,
        wakeReason: "operator_decision_resolved",
        operatorDecisionId: decisionId,
        paperclipOperatorDecisionResolution: {
          operatorDecisionId: decisionId,
          options: [{ id: "one", label: "One", description: null }],
        },
      },
      requestedByActorType: "user",
      requestedByActorId: "board",
      idempotencyKey: `operator-decision-wake:${decisionId}:g1:a1`,
    });
    const [continuation] = await db.select().from(operatorDecisionContinuations);
    expect(continuation).toMatchObject({ state: "accepted", targetAgentId: agentId, attemptCount: 1 });
    expect(continuation?.wakeupRequestId).toBeTruthy();
    expect((await db.select().from(activityLog)).map((row) => row.action)).toContain("operator_decision.continuation_accepted");
  });

  it.each([
    ["missing", null, "issue_missing"],
    ["unassigned", { status: "todo", assigneeAgentId: null }, "issue_unassigned"],
    ["terminal", { status: "done", assigneeAgentId: agentId }, "issue_terminal"],
  ])("blocks %s issue before heartbeat", async (_name, issueUpdate, errorCode) => {
    if (issueUpdate === null) await db.delete(issues).where(eq(issues.id, issueId));
    else await db.update(issues).set(issueUpdate).where(eq(issues.id, issueId));
    const wakeup = vi.fn();
    expect(await operatorDecisionContinuationWorker(db, { wakeup, workerId: "blocker" }).pollOnce(fixtureTime)).toBe(1);
    expect(wakeup).not.toHaveBeenCalled();
    expect((await db.select().from(operatorDecisionContinuations))[0]).toMatchObject({ state: "blocked", errorCode });
  });

  it("retries absent proof at 5s/30s and exhausts the third attempt", async () => {
    const wakeup = vi.fn().mockRejectedValue(new Error("no proof"));
    const worker = operatorDecisionContinuationWorker(db, { wakeup, workerId: "retry" });
    const times = [
      new Date("2026-07-29T12:00:00Z"),
      new Date("2026-07-29T12:00:06Z"),
      new Date("2026-07-29T12:00:37Z"),
    ];
    await db.update(operatorDecisionContinuations).set({ nextAttemptAt: times[0] }).where(eq(operatorDecisionContinuations.operatorDecisionId, decisionId));
    for (const time of times) expect(await worker.pollOnce(time)).toBe(1);
    expect((await db.select().from(operatorDecisionContinuations))[0]).toMatchObject({ state: "exhausted", attemptCount: 3 });
    expect(wakeup).toHaveBeenCalledTimes(3);
  });

  // [2026-09-24 CMP-199 사고 재발 방지] 활성 run 에 합병된 coalesced wake 는 전달 보장이 없다
  //   (해당 run 이 소비 없이 끝나면 영구 유실). 증거 불인정 → 재시도 → 정상 queued wake 로
  //   수렴해야 한다.
  it("does not accept a coalesced wakeup as durable proof and converges on a delivered attempt", async () => {
    await db.update(operatorDecisionContinuations)
      .set({ nextAttemptAt: new Date("2026-07-29T12:00:00Z") })
      .where(eq(operatorDecisionContinuations.operatorDecisionId, decisionId));
    const wakeups: Array<{ idempotencyKey: string; status: string }> = [];
    const wakeup = vi.fn(async (targetAgentId: string, options: Record<string, unknown>) => {
      const status = wakeups.length === 0 ? "coalesced" : "queued";
      await db.insert(agentWakeupRequests).values({
        companyId, agentId: targetAgentId, source: "automation", status,
        triggerDetail: "system", reason: "operator_decision_resolved",
        payload: options.payload as Record<string, unknown>,
        requestedByActorType: "user", requestedByActorId: "board",
        idempotencyKey: options.idempotencyKey as string,
        issueId,
      });
      wakeups.push({ idempotencyKey: options.idempotencyKey as string, status });
    });
    const worker = operatorDecisionContinuationWorker(db, { wakeup, workerId: "coal" });

    // a1: 활성 run 합병(coalesced) — 전달 증거 불인정, 5s 뒤 재시도 예약
    expect(await worker.pollOnce(new Date("2026-07-29T12:00:00Z"))).toBe(1);
    expect((await db.select().from(operatorDecisionContinuations))[0]).toMatchObject({
      state: "pending", attemptCount: 1, errorCode: "dispatch_failed",
    });

    // a2(+6s): 전용 queued run 이 만들어진 경우 — 전달 증거 인정
    expect(await worker.pollOnce(new Date("2026-07-29T12:00:06Z"))).toBe(1);
    const [continuation] = await db.select().from(operatorDecisionContinuations);
    expect(continuation).toMatchObject({ state: "accepted", attemptCount: 2 });
    expect(wakeups.map((w) => w.idempotencyKey)).toEqual([
      `operator-decision-wake:${decisionId}:g1:a1`,
      `operator-decision-wake:${decisionId}:g1:a2`,
    ]);
  });

  // [requester delivery] resolve 결과는 카드 생성 시점의 원 요청자 에이전트에게 전달된다.
  //   현재 담당자 전달은 사용자 생성 카드(requestedByUserId만 있음) 기존 계약으로 남는다.
  it("delivers to the card requester instead of the current assignee", async () => {
    const requesterId = await insertRequesterAgent();
    await db.update(operatorDecisions).set({ requestedByAgentId: requesterId }).where(eq(operatorDecisions.id, decisionId));
    const wakeup = queuedWakeupMock();
    expect(await operatorDecisionContinuationWorker(db, { wakeup, workerId: "requester-t1" }).pollOnce(fixtureTime)).toBe(1);
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup.mock.calls[0]?.[0]).toBe(requesterId);
    expect((await db.select().from(operatorDecisionContinuations))[0]).toMatchObject({
      state: "accepted", targetAgentId: requesterId, attemptCount: 1,
    });
  });

  it("keeps requester delivery when the issue becomes unassigned", async () => {
    const requesterId = await insertRequesterAgent();
    await db.update(operatorDecisions).set({ requestedByAgentId: requesterId }).where(eq(operatorDecisions.id, decisionId));
    await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, issueId));
    const wakeup = queuedWakeupMock();
    expect(await operatorDecisionContinuationWorker(db, { wakeup, workerId: "requester-t2" }).pollOnce(fixtureTime)).toBe(1);
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup.mock.calls[0]?.[0]).toBe(requesterId);
    expect((await db.select().from(operatorDecisionContinuations))[0]).toMatchObject({
      state: "accepted", targetAgentId: requesterId,
    });
  });

  it("blocks when the requester is unknown instead of proxying to the assignee", async () => {
    await db.update(operatorDecisions).set({ requestedByUserId: null }).where(eq(operatorDecisions.id, decisionId));
    const wakeup = vi.fn();
    expect(await operatorDecisionContinuationWorker(db, { wakeup, workerId: "requester-t3" }).pollOnce(fixtureTime)).toBe(1);
    expect(wakeup).not.toHaveBeenCalled();
    expect((await db.select().from(operatorDecisionContinuations))[0]).toMatchObject({
      state: "blocked", errorCode: "requester_unavailable",
    });
  });

  it("blocks when the requester belongs to another company", async () => {
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({ id: otherCompanyId, name: "Other", issuePrefix: `O${otherCompanyId.slice(0, 4)}` });
    const requesterId = await insertRequesterAgent(otherCompanyId);
    await db.update(operatorDecisions).set({ requestedByAgentId: requesterId }).where(eq(operatorDecisions.id, decisionId));
    const wakeup = vi.fn();
    expect(await operatorDecisionContinuationWorker(db, { wakeup, workerId: "requester-t4" }).pollOnce(fixtureTime)).toBe(1);
    expect(wakeup).not.toHaveBeenCalled();
    expect((await db.select().from(operatorDecisionContinuations))[0]).toMatchObject({
      state: "blocked", errorCode: "requester_unavailable",
    });
  });

  it("still blocks requester delivery when the issue is terminal", async () => {
    const requesterId = await insertRequesterAgent();
    await db.update(operatorDecisions).set({ requestedByAgentId: requesterId }).where(eq(operatorDecisions.id, decisionId));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
    const wakeup = vi.fn();
    expect(await operatorDecisionContinuationWorker(db, { wakeup, workerId: "requester-t5" }).pollOnce(fixtureTime)).toBe(1);
    expect(wakeup).not.toHaveBeenCalled();
    expect((await db.select().from(operatorDecisionContinuations))[0]).toMatchObject({
      state: "blocked", errorCode: "issue_terminal",
    });
  });

  it("projects requester delivery as queued, not assignee_changed", async () => {
    const requesterId = await insertRequesterAgent();
    await db.update(operatorDecisions).set({ requestedByAgentId: requesterId }).where(eq(operatorDecisions.id, decisionId));
    const wakeup = queuedWakeupMock();
    expect(await operatorDecisionContinuationWorker(db, { wakeup, workerId: "requester-t6" }).pollOnce(fixtureTime)).toBe(1);
    const [decisionRow] = await db.select().from(operatorDecisions).where(eq(operatorDecisions.id, decisionId));
    const projection = await loadOperatorDecisionProjection(db, decisionRow, fixtureTime);
    expect(projection?.view.continuation).toMatchObject({
      effectiveStatus: "queued", errorCode: null, targetAgentId: requesterId,
    });
  });

  it("projects requester_unavailable as blocked with an operator hint", async () => {
    await db.update(operatorDecisions).set({ requestedByUserId: null }).where(eq(operatorDecisions.id, decisionId));
    expect(await operatorDecisionContinuationWorker(db, { wakeup: vi.fn(), workerId: "requester-t7" }).pollOnce(fixtureTime)).toBe(1);
    const [decisionRow] = await db.select().from(operatorDecisions).where(eq(operatorDecisions.id, decisionId));
    const projection = await loadOperatorDecisionProjection(db, decisionRow, fixtureTime);
    expect(projection?.view.continuation).toMatchObject({
      effectiveStatus: "blocked", errorCode: "requester_unavailable",
    });
    expect(projection?.view.continuation?.retryHint).toContain("요청자");
  });

  // [stale-card sweep 4a] 선택 전 상태 변경 → 카드 자동 취소 정책(2026-10-15). pollOnce 뒷단에서
  //   스냅샷 불일치 pending 카드만 cancelled 로 만들고, 일치/스냅샷 없음/이미 종결 카드는 쓰지 않는다.
  //   스윕이 wakeup 이나 continuation 을 만들지 않는다.
  describe("stale pending card sweep", () => {
    // [moi sweep] missionStatus 판정용 missions fixture 정리 — ownerAgentId FK 가 바깥 afterEach 의
    //   agents 삭제를 막기 전에(안→밖 순서) 지운다.
    afterEach(async () => {
      await db.delete(missions);
    });

    async function insertSweepCard(options: {
      status?: "pending" | "resolved";
      targetSnapshot?: Record<string, unknown>;
      sourceType?: string;
      missionId?: string | null;
    } = {}) {
      const cardId = randomUUID();
      const status = options.status ?? "pending";
      await db.insert(operatorDecisions).values({
        id: cardId, companyId, requestKey: randomUUID(), requestHash: "hash", status,
        interactionType: "single_select", title: "Sweep", sourceType: options.sourceType ?? "workflow_step", sourceId: "step",
        sourceContext: {
          missionId: options.missionId ?? null, workflowId: null, workflowRunId: null, artifactRefs: [],
          ...(options.targetSnapshot ? { targetSnapshot: options.targetSnapshot } : {}),
        },
        issueId, definition, continuationMode: "none",
        requestedByAgentId: agentId,
        ...(status === "resolved" ? {
          result: { actionId: "choose", outcome: "submit", selectedOptionIds: ["one"], comment: null },
          resolvedByUserId: "board", resolvedAt: fixtureTime,
        } : {}),
      });
      return cardId;
    }

    async function cardRow(id: string) {
      return db.select().from(operatorDecisions).where(eq(operatorDecisions.id, id)).then((rows) => rows[0] ?? null);
    }

    async function cardActivities(id: string) {
      return db.select().from(activityLog).where(eq(activityLog.entityId, id));
    }

    it("S1: cancels a drifted pending card with a sweep-authored cancel activity and no wakeup", async () => {
      await db.delete(operatorDecisionContinuations);
      const cardId = await insertSweepCard({ targetSnapshot: { issueId, issueStatus: "todo" } });
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      const wakeup = vi.fn();
      expect(await operatorDecisionContinuationWorker(db, { wakeup, workerId: "sweep-s1" }).pollOnce(fixtureTime)).toBe(0);
      expect(await cardRow(cardId)).toMatchObject({ status: "cancelled", cancelledAt: fixtureTime });
      const [cancelActivity] = (await cardActivities(cardId)).filter((row) => row.action === "operator_decision.cancelled");
      expect(cancelActivity).toMatchObject({ actorType: "user", actorId: "system:operator-decision-stale-sweep" });
      expect(cancelActivity?.details).toMatchObject({
        cancelledByActorType: "user",
        cancelledByActorId: "system:operator-decision-stale-sweep",
        reason: "target_changed",
        mismatch: ["issueStatus"],
      });
      expect(wakeup).not.toHaveBeenCalled();
      expect(await db.select().from(operatorDecisionContinuations)).toHaveLength(0);

      // 직접 호출 집계 계약: {checked, cancelled} — 불일치 카드 1건만 남아 있다(첫 카드는 이미 cancelled).
      const secondCardId = await insertSweepCard({ targetSnapshot: { issueId, issueStatus: "todo" } });
      await expect(operatorDecisionWriteService(db).sweepStalePendingCards(fixtureTime))
        .resolves.toEqual({ checked: 1, cancelled: 1 });
      expect(await cardRow(secondCardId)).toMatchObject({ status: "cancelled" });
    });

    it("S2: keeps a pending card whose snapshot still matches", async () => {
      await db.delete(operatorDecisionContinuations);
      const cardId = await insertSweepCard({ targetSnapshot: { issueId, issueStatus: "todo" } });
      const wakeup = vi.fn();
      expect(await operatorDecisionContinuationWorker(db, { wakeup, workerId: "sweep-s2" }).pollOnce(fixtureTime)).toBe(0);
      expect(await cardRow(cardId)).toMatchObject({ status: "pending", cancelledAt: null });
      expect((await cardActivities(cardId)).filter((row) => row.action === "operator_decision.cancelled")).toHaveLength(0);
      expect(wakeup).not.toHaveBeenCalled();
    });

    it("S3: leaves a drifted resolved card untouched", async () => {
      await db.delete(operatorDecisionContinuations);
      const cardId = await insertSweepCard({ status: "resolved", targetSnapshot: { issueId, issueStatus: "todo" } });
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      expect(await operatorDecisionContinuationWorker(db, { wakeup: vi.fn(), workerId: "sweep-s3" }).pollOnce(fixtureTime)).toBe(0);
      expect(await cardRow(cardId)).toMatchObject({ status: "resolved" });
      expect((await cardActivities(cardId)).filter((row) => row.action === "operator_decision.cancelled")).toHaveLength(0);
    });

    it("S4: leaves a pending card without a snapshot untouched", async () => {
      await db.delete(operatorDecisionContinuations);
      const cardId = await insertSweepCard();
      expect(await operatorDecisionContinuationWorker(db, { wakeup: vi.fn(), workerId: "sweep-s4" }).pollOnce(fixtureTime)).toBe(0);
      expect(await cardRow(cardId)).toMatchObject({ status: "pending", cancelledAt: null });
      expect(await cardActivities(cardId)).toHaveLength(0);
    });

    // [moi terminal-anchor sweep 2026-10-17] 사람 결정(mission_owner_human_input) pending 카드는 앵커
    //   이슈가 종결(done/cancelled)되거나 미션이 cancelled 될 때만 취소된다 — 열린 상태 간 status
    //   churn(todo↔in_progress↔blocked)은 사람 응답 대기 중 정상 흐름이라 카드를 살려둔다(라이브 사고
    //   2026-10-17 14:30Z: 사람이 볼 새 없이 생성 2분 만에 자동 취소).
    async function insertMissionFixture(status: string) {
      const id = randomUUID();
      await db.insert(missions).values({ id, companyId, ownerAgentId: agentId, title: "moi sweep mission", status });
      return id;
    }

    it("SW-M1: keeps a moi pending card alive across open-state issue churn and reports cancelled=0", async () => {
      await db.delete(operatorDecisionContinuations);
      const missionFixtureId = await insertMissionFixture("active");
      const cardId = await insertSweepCard({
        sourceType: "mission_owner_human_input", missionId: missionFixtureId,
        targetSnapshot: { issueId, issueStatus: "in_progress" },
      });
      await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, issueId));
      const wakeup = vi.fn();
      expect(await operatorDecisionContinuationWorker(db, { wakeup, workerId: "sweep-moi-1" }).pollOnce(fixtureTime)).toBe(0);
      expect(await cardRow(cardId)).toMatchObject({ status: "pending", cancelledAt: null });
      expect((await cardActivities(cardId)).filter((row) => row.action === "operator_decision.cancelled")).toHaveLength(0);
      expect(wakeup).not.toHaveBeenCalled();
      // 직접 호출 집계 계약 — churn 후에도 checked 1·cancelled 0(생존).
      await expect(operatorDecisionWriteService(db).sweepStalePendingCards(fixtureTime))
        .resolves.toEqual({ checked: 1, cancelled: 0 });
    });

    it("SW-M2: cancels a moi pending card when the anchor issue is terminal (done)", async () => {
      await db.delete(operatorDecisionContinuations);
      const missionFixtureId = await insertMissionFixture("active");
      const cardId = await insertSweepCard({
        sourceType: "mission_owner_human_input", missionId: missionFixtureId,
        targetSnapshot: { issueId, issueStatus: "in_progress" },
      });
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      expect(await operatorDecisionContinuationWorker(db, { wakeup: vi.fn(), workerId: "sweep-moi-2" }).pollOnce(fixtureTime)).toBe(0);
      expect(await cardRow(cardId)).toMatchObject({ status: "cancelled", cancelledAt: fixtureTime });
      const [cancelActivity] = (await cardActivities(cardId)).filter((row) => row.action === "operator_decision.cancelled");
      expect(cancelActivity).toMatchObject({ actorId: "system:operator-decision-stale-sweep" });
      expect(cancelActivity?.details).toMatchObject({ reason: "target_changed", mismatch: ["issueStatus"] });
    });

    it("SW-M3: cancels a moi pending card when the mission is cancelled even if the issue stays open", async () => {
      await db.delete(operatorDecisionContinuations);
      const missionFixtureId = await insertMissionFixture("cancelled");
      const cardId = await insertSweepCard({
        sourceType: "mission_owner_human_input", missionId: missionFixtureId,
        targetSnapshot: { issueId, issueStatus: "in_progress" },
      });
      await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, issueId));
      expect(await operatorDecisionContinuationWorker(db, { wakeup: vi.fn(), workerId: "sweep-moi-3" }).pollOnce(fixtureTime)).toBe(0);
      expect(await cardRow(cardId)).toMatchObject({ status: "cancelled", cancelledAt: fixtureTime });
      const [cancelActivity] = (await cardActivities(cardId)).filter((row) => row.action === "operator_decision.cancelled");
      expect(cancelActivity?.details).toMatchObject({ reason: "target_changed", mismatch: ["missionStatus"] });
    });

    it("SW-M4: non-moi cards keep the exact-snapshot sweep on the same open-state churn", async () => {
      await db.delete(operatorDecisionContinuations);
      const cardId = await insertSweepCard({ targetSnapshot: { issueId, issueStatus: "todo" } });
      await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, issueId));
      expect(await operatorDecisionContinuationWorker(db, { wakeup: vi.fn(), workerId: "sweep-moi-4" }).pollOnce(fixtureTime)).toBe(0);
      expect(await cardRow(cardId)).toMatchObject({ status: "cancelled", cancelledAt: fixtureTime });
      const [cancelActivity] = (await cardActivities(cardId)).filter((row) => row.action === "operator_decision.cancelled");
      expect(cancelActivity?.details).toMatchObject({ reason: "target_changed", mismatch: ["issueStatus"] });
    });
  });
});
