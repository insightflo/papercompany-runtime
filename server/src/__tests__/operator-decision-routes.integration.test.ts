import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activityLog, agentRuntimeState, agentTaskSessions, agentWakeupRequests, agents, companies, companySkills, createDb, heartbeatRunEvents, heartbeatRuns, issueComments, issues, operatorDecisionContinuations, operatorDecisions } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { operatorDecisionRoutes } from "../routes/operator-decisions.js";
import { operatorDecisionWriteService } from "../services/operator-decisions-write.js";
import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
const definition = {
  options: [],
  actions: [
    { id: "hold", label: "Hold", outcome: "hold", tone: "neutral", requiresSelection: false },
    { id: "reject", label: "Reject", outcome: "reject", tone: "danger", requiresSelection: false },
  ],
  selection: null,
  comment: { mode: "disabled", label: null, placeholder: null, maxLength: 0 },
  approvedScope: [],
  forbiddenScope: [],
  humanReview: {
    schemaVersion: "human-review-v1" as const,
    decisionSubject: "Hold or reject this work?",
    evidence: [{ label: "Decision request", href: "/operator-decisions/fixture", location: "Decision fixture > request" }],
    interpretation: "The operator is choosing whether this fixture work should remain stopped.",
    impact: { ifApproved: "The selected action is recorded.", ifRejected: "The alternate action is recorded.", ifWrong: "The wrong work state could be retained." },
    unresolvedFacts: [],
    questions: ["Does the requested action match the linked work?"],
    recommendedNextStep: "Review the request and choose one action.",
    requiredReviewer: "Human Operator",
  },
};

function body(requestKey: string) {
  return {
    schemaVersion: 1,
    requestKey,
    priority: "medium",
    interactionType: "action",
    title: "Hold work?",
    description: "",
    sourceType: "system",
    sourceId: "fixture",
    sourceContext: { missionId: null, workflowId: null, workflowRunId: null, artifactRefs: [] },
    definition,
    issueId: null,
    continuationMode: "none",
  };
}

describeDb("operator decision routes", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;
  let issueId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("operator-decision-routes-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => {
    await waitForHeartbeatExecutionsToDrain(db);
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    await waitForHeartbeatExecutionsToDrain(db);
    // resolve route의 즉시 웨이크업이 남기는 heartbeat_runs·agent_wakeup_requests·
    // agent_runtime_state/agent_task_sessions(웨이크업 경로가 agents 참조 행을 만듦)·
    // company_skills(웨이크업 실행 준비가 번들 스킬을 upsert)·
    // activity_log(run_id) 행까지 정리(heartbeat_runs.wakeupRequestId FK → wakeup 행을 나중에 삭제)
    // [2026-10-23 경합 수리] 이전 테스트의 비동기 체인이 깨움 종료 후에도 런타임 확보로
    //   agent_runtime_state 를 늦게 삽입해 agents 삭제 FK 위반(라이브 CI 반복 관측) — 깨움 종료 +
    //   런타임 상태 행 수 안정(연속 2회 동일)까지 대기하고 남은 극단 경합은 agents 삭제 재시도로 흡수한다.
    const runtimeStateSettled = async () => {
      const before = await db.select({ agentId: agentRuntimeState.agentId }).from(agentRuntimeState);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const after = await db.select({ agentId: agentRuntimeState.agentId }).from(agentRuntimeState);
      return before.length === after.length
        && before.every((row) => after.some((other) => other.agentId === row.agentId));
    };
    const deadline = Date.now() + 10_000;
    for (;;) {
      const wakeups = await db.select({ status: agentWakeupRequests.status }).from(agentWakeupRequests);
      if (!wakeups.some((row) => ["queued", "claimed", "deferred_issue_execution"].includes(row.status))
        && await runtimeStateSettled()) break;
      if (Date.now() > deadline) throw new Error(`wakeup chains did not settle within 10s: ${JSON.stringify(wakeups)}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
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
    await db.delete(issues);
    // [경합 수리] 안정 대기 후에도 극단적으로 늦은 삽입이 남으면 agents 삭제가 FK 위반 — 최대 3회 재정리한다.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await db.delete(agents);
        break;
      } catch (error) {
        if (attempt >= 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200));
        await db.delete(agentRuntimeState);
      }
    }
    await db.delete(companies);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Routes", issuePrefix: `D${companyId.slice(0, 4)}` });
    agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Requester" });
    issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Task", assigneeAgentId: agentId, identifier: `${companyId.slice(0, 4).toUpperCase()}-1`, issueNumber: 1 });
  });

  function app(actor: "board" | "agent" | "none" = "board", actorAgentId: string = agentId) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      req.actor = actor === "board"
        ? { type: "board", userId: "board-user", companyIds: [], source: "local_implicit", isInstanceAdmin: true }
        : actor === "agent"
          ? { type: "agent", agentId: actorAgentId, companyId, runId: null }
          : { type: "none" };
      next();
    });
    server.use("/api", operatorDecisionRoutes(db));
    server.use(errorHandler);
    return server;
  }

  it("returns exact create and idempotent replay envelopes", async () => {
    const first = await request(app("agent")).post(`/api/companies/${companyId}/operator-decisions`).send(body("route-create"));
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ replayed: false, data: { requestedBy: { type: "agent", id: agentId } } });
    const replay = await request(app("agent")).post(`/api/companies/${companyId}/operator-decisions`).send(body("route-create"));
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ replayed: true, data: { id: first.body.data.id } });
  });

  it("rejects omitted nullable keys, unknown keys, and invalid query keys", async () => {
    const invalid = { ...body("invalid"), actorId: "spoof" } as Record<string, unknown>;
    delete invalid.issueId;
    expect((await request(app()).post(`/api/companies/${companyId}/operator-decisions`).send(invalid)).body)
      .toMatchObject({ error: "Validation error", details: expect.any(Array) });
    const query = await request(app()).get(`/api/companies/${companyId}/operator-decisions?unknown=yes`);
    expect(query.status).toBe(400);
    expect(query.body).toMatchObject({ error: "Validation error" });
  });

  it("derives board actor and action outcome on resolve", async () => {
    const created = await request(app("agent")).post(`/api/companies/${companyId}/operator-decisions`).send(body("resolve"));
    try {
      const resolved = await request(app()).post(`/api/operator-decisions/${created.body.data.id}/resolve`).send({
        actionId: "hold", selectedOptionIds: [], comment: null,
      });
      expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
      expect(resolved.body.data).toMatchObject({ applied: true, decision: { resolvedByUserId: "board-user", result: { outcome: "hold" } }, continuation: null });
    } finally {
      // agent 요청자 카드는 issueId 없이도 즉시 깨움이 발생한다 — 비동기 체인이 다음 테스트
      // 정리와 경합하지 않도록 종료를 기다린다.
      await waitForWakeupToSettle(created.body.data.id);
    }
  });

  it("enforces board-only list and resolution while allowing requester detail/cancel", async () => {
    const created = await request(app("agent")).post(`/api/companies/${companyId}/operator-decisions`).send(body("auth"));
    expect((await request(app("agent")).get(`/api/companies/${companyId}/operator-decisions`)).status).toBe(403);
    expect((await request(app("agent")).post(`/api/operator-decisions/${created.body.data.id}/resolve`).send({ actionId: "hold", selectedOptionIds: [], comment: null })).status).toBe(403);
    expect((await request(app("agent")).get(`/api/operator-decisions/${created.body.data.id}`)).status).toBe(200);
    const cancelled = await request(app("agent")).post(`/api/operator-decisions/${created.body.data.id}/cancel`).send({});
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data).toMatchObject({ applied: true, decision: { status: "cancelled" } });
  });

  it("returns 409 for a different terminal result", async () => {
    const created = await request(app()).post(`/api/companies/${companyId}/operator-decisions`).send(body("conflict"));
    await request(app()).post(`/api/operator-decisions/${created.body.data.id}/resolve`).send({ actionId: "hold", selectedOptionIds: [], comment: null });
    const conflict = await request(app()).post(`/api/operator-decisions/${created.body.data.id}/resolve`).send({ actionId: "reject", selectedOptionIds: [], comment: null });
    expect(conflict.status).toBe(409);
  });

  it("exposes board-only exact retry envelope", async () => {
    const linked = { ...body("retry-route"), issueId, continuationMode: "issue_current_assignee" };
    const created = await request(app("agent"))
      .post(`/api/companies/${companyId}/operator-decisions`)
      .send(linked);
    await request(app()).post(`/api/operator-decisions/${created.body.data.id}/resolve`).send({
      actionId: "hold", selectedOptionIds: [], comment: null,
    });
    await db.update(operatorDecisionContinuations).set({
      state: "exhausted", attemptCount: 3, errorCode: "attempts_exhausted",
    });
    expect((await request(app("agent"))
      .post(`/api/operator-decisions/${created.body.data.id}/retry-continuation`)
      .send({})).status).toBe(403);
    const retried = await request(app())
      .post(`/api/operator-decisions/${created.body.data.id}/retry-continuation`)
      .send({});
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body.data).toMatchObject({
      applied: true,
      continuation: { state: "pending", generation: 2, manualRetryCount: 1, attemptCount: 0 },
    });
    await waitForWakeupToSettle(created.body.data.id);
  });

  async function immediateWakeupRows(decisionId: string) {
    return db
      .select({ agentId: agentWakeupRequests.agentId, reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, `operator-decision-resolved:${decisionId}`));
  }

  // 즉시 깨움의 후처리까지 끝난 뒤 다음 beforeEach 정리를 허용한다.
  async function waitForWakeupToSettle(_decisionId: string) {
    await waitForHeartbeatExecutionsToDrain(db);
  }

  it("immediately wakes only the requesting agent when the requester differs from the assignee", async () => {
    // T1: agent 생성 카드 — 즉시 깨움 대상은 현재 담당자가 아니라 원 요청자다.
    const assigneeId = randomUUID();
    await db.insert(agents).values({ id: assigneeId, companyId, name: "Assignee" });
    await db.update(issues).set({ assigneeAgentId: assigneeId }).where(eq(issues.id, issueId));
    const created = await request(app("agent"))
      .post(`/api/companies/${companyId}/operator-decisions`)
      .send({ ...body("requester-wake"), issueId, continuationMode: "none" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    try {
      const resolved = await request(app())
        .post(`/api/operator-decisions/${created.body.data.id}/resolve`)
        .send({ actionId: "hold", selectedOptionIds: [], comment: null });
      expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
      expect(resolved.body.data).toMatchObject({ applied: true, decision: { status: "resolved" } });
      const wakes = await immediateWakeupRows(created.body.data.id);
      expect(wakes).toHaveLength(1);
      expect(wakes[0]).toMatchObject({ agentId, reason: "operator_decision_resolved_assignee_wakeup" });
      const assigneeWakes = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(and(eq(agentWakeupRequests.agentId, assigneeId), eq(agentWakeupRequests.reason, "operator_decision_resolved_assignee_wakeup")));
      expect(assigneeWakes).toHaveLength(0);
    } finally {
      await waitForWakeupToSettle(created.body.data.id);
    }
  });

  it("immediately wakes the current assignee for user-created cards", async () => {
    // T2: 사용자 생성 카드 회귀 보호 — 기존대로 현재 이슈 담당자를 깨운다.
    const created = await request(app())
      .post(`/api/companies/${companyId}/operator-decisions`)
      .send({ ...body("user-card-wake"), issueId, continuationMode: "issue_current_assignee" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    try {
      expect(created.body.data).toMatchObject({ requestedBy: { type: "user", id: "board-user" } });
      const resolved = await request(app())
        .post(`/api/operator-decisions/${created.body.data.id}/resolve`)
        .send({ actionId: "hold", selectedOptionIds: [], comment: null });
      expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
      const wakes = await immediateWakeupRows(created.body.data.id);
      expect(wakes).toHaveLength(1);
      expect(wakes[0]).toMatchObject({ agentId, reason: "operator_decision_resolved_assignee_wakeup" });
    } finally {
      await waitForWakeupToSettle(created.body.data.id);
    }
  });

  it("skips the immediate wakeup with a skip activity when the requester is unavailable", async () => {
    // T3: both-null 레거시 카드 — 즉시 깨움을 생략하고 사유를 activity로 남긴다.
    const [card] = await db.insert(operatorDecisions).values({
      companyId,
      requestKey: "both-null-wake",
      requestHash: "both-null-wake",
      interactionType: "action",
      title: "Legacy card",
      sourceType: "system",
      sourceId: "fixture",
      definition,
      issueId,
      requestedByAgentId: null,
      requestedByUserId: null,
      continuationMode: "none",
    }).returning();
    const resolved = await request(app())
      .post(`/api/operator-decisions/${card.id}/resolve`)
      .send({ actionId: "hold", selectedOptionIds: [], comment: null });
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    const wakes = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.reason, "operator_decision_resolved_assignee_wakeup"));
    expect(wakes).toHaveLength(0);
    const skips = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, card.id), eq(activityLog.action, "operator_decision.immediate_wakeup_skipped")));
    expect(skips).toHaveLength(1);
    expect(skips[0].details).toMatchObject({
      operatorDecisionId: card.id,
      issueId,
      reason: "requester_unavailable",
    });
  });

  // FIXME( follow-up ): resolve의 비동기 웨이크업(agent_wakeup_requests → heartbeat_runs →
  // activity_log/run_events 연쇄)이 다음 beforeEach 클린업과 경합한다. 웨이크업 완료 대기 또는
  // 클린업 순서 정리 후 스킵 해제.
  it.skip("attention projection carries operator context (issue identifier/title, mission, retry hint)", async () => {
    const linked = { ...body("attention-context"), issueId, continuationMode: "issue_current_assignee" };
    const created = await request(app("agent"))
      .post(`/api/companies/${companyId}/operator-decisions`)
      .send(linked);
    await request(app()).post(`/api/operator-decisions/${created.body.data.id}/resolve`).send({
      actionId: "hold", selectedOptionIds: [], comment: null,
    });
    // Force the same blocked state the 2026-08-25 GAZ morning run hit: issue in_progress, assignee cleared.
    await db.update(issues).set({ assigneeAgentId: null, status: "in_progress" }).where(eq(issues.id, issueId));
    await db.update(operatorDecisionContinuations).set({
      state: "blocked", errorCode: "issue_unassigned",
    });
    const attention = await request(app())
      .get(`/api/companies/${companyId}/operator-decisions?view=attention`);
    expect(attention.status).toBe(200);
    const row = attention.body.data.find(
      (entry: { id: string }) => entry.id === created.body.data.id,
    );
    expect(row?.continuation).toMatchObject({
      errorCode: "issue_unassigned",
      issueStatus: "in_progress",
      issueAssigneeAgentId: null,
      issueTitle: "Task",
    });
    expect(String(row?.continuation?.issueIdentifier ?? "")).toMatch(/-1$/);
    expect(row?.continuation?.retryHint).toContain("담당자");
  });

  // [4c outcome] 요청자 결과 회신 API — O1~O5. 회신은 activity 투영뿐이고 카드 행·
  //   continuation 은 불변이며 append-only(중복 보고 허용)다.
  async function outcomeActivities(decisionId: string) {
    return db.select().from(activityLog).where(and(
      eq(activityLog.entityId, decisionId),
      eq(activityLog.action, "operator_decision.outcome_reported"),
    ));
  }

  async function cardSnapshot(decisionId: string) {
    return db.select({
      status: operatorDecisions.status,
      result: operatorDecisions.result,
      resolvedAt: operatorDecisions.resolvedAt,
      updatedAt: operatorDecisions.updatedAt,
    }).from(operatorDecisions).where(eq(operatorDecisions.id, decisionId));
  }

  async function resolveViaBoard(decisionId: string) {
    const resolved = await request(app()).post(`/api/operator-decisions/${decisionId}/resolve`)
      .send({ actionId: "hold", selectedOptionIds: [], comment: null });
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
  }

  it("O1: requester agent reports completed on a resolved card and only an activity is appended", async () => {
    const created = await request(app("agent"))
      .post(`/api/companies/${companyId}/operator-decisions`)
      .send(body("outcome-o1"));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const decisionId = created.body.data.id;
    try {
      await resolveViaBoard(decisionId);
      const before = await cardSnapshot(decisionId);
      const outcome = await request(app("agent"))
        .post(`/api/operator-decisions/${decisionId}/outcome`)
        .send({ status: "completed", reason: "배치 완료", detail: "변경 3건 적용" });
      expect(outcome.status, JSON.stringify(outcome.body)).toBe(200);
      expect(outcome.body.data).toMatchObject({ applied: true, decision: { id: decisionId, status: "resolved" } });
      const activities = await outcomeActivities(decisionId);
      expect(activities).toHaveLength(1);
      expect(activities[0]).toMatchObject({
        companyId,
        actorType: "agent",
        actorId: agentId,
        agentId,
        entityType: "operator_decision",
        entityId: decisionId,
      });
      expect(activities[0].details).toMatchObject({
        schemaVersion: 1,
        operatorDecisionId: decisionId,
        requesterAgentId: agentId,
        status: "completed",
        reason: "배치 완료",
        detail: "변경 3건 적용",
        reportedAt: expect.any(String),
      });
      // 카드 행 불변 + continuation 미생성(회신은 activity 투영만).
      expect(await cardSnapshot(decisionId)).toEqual(before);
      expect(await db.select().from(operatorDecisionContinuations)
        .where(eq(operatorDecisionContinuations.operatorDecisionId, decisionId))).toHaveLength(0);
    } finally {
      await waitForWakeupToSettle(decisionId);
    }
  });

  it("O2: other agents and board users cannot report the outcome", async () => {
    const otherAgentId = randomUUID();
    await db.insert(agents).values({ id: otherAgentId, companyId, name: "Other" });
    const created = await request(app("agent"))
      .post(`/api/companies/${companyId}/operator-decisions`)
      .send(body("outcome-o2"));
    const decisionId = created.body.data.id;
    try {
      await resolveViaBoard(decisionId);
      const other = await request(app("agent", otherAgentId))
        .post(`/api/operator-decisions/${decisionId}/outcome`)
        .send({ status: "completed" });
      expect(other.status, JSON.stringify(other.body)).toBe(403);
      expect(other.body).toMatchObject({ error: "Only the card requester agent may report the outcome" });
      const board = await request(app())
        .post(`/api/operator-decisions/${decisionId}/outcome`)
        .send({ status: "completed" });
      expect(board.status, JSON.stringify(board.body)).toBe(403);
      expect(board.body).toMatchObject({ error: "Only the card requester agent may report the outcome" });
      expect(await outcomeActivities(decisionId)).toHaveLength(0);
    } finally {
      await waitForWakeupToSettle(decisionId);
    }
  });

  it("O3: outcome on a pending card conflicts", async () => {
    const created = await request(app("agent"))
      .post(`/api/companies/${companyId}/operator-decisions`)
      .send(body("outcome-o3"));
    const decisionId = created.body.data.id;
    const pending = await request(app("agent"))
      .post(`/api/operator-decisions/${decisionId}/outcome`)
      .send({ status: "in_progress" });
    expect(pending.status, JSON.stringify(pending.body)).toBe(409);
    expect(await outcomeActivities(decisionId)).toHaveLength(0);
  });

  it("O4: invalid status values are rejected with 422", async () => {
    const created = await request(app("agent"))
      .post(`/api/companies/${companyId}/operator-decisions`)
      .send(body("outcome-o4"));
    const decisionId = created.body.data.id;
    try {
      await resolveViaBoard(decisionId);
      const invalid = await request(app("agent"))
        .post(`/api/operator-decisions/${decisionId}/outcome`)
        .send({ status: "done" });
      expect(invalid.status, JSON.stringify(invalid.body)).toBe(422);
      expect(invalid.body).toMatchObject({ error: "Validation error" });
      expect(await outcomeActivities(decisionId)).toHaveLength(0);
    } finally {
      await waitForWakeupToSettle(decisionId);
    }
  });

  it("O5: consecutive reports are all appended (in_progress then completed)", async () => {
    const created = await request(app("agent"))
      .post(`/api/companies/${companyId}/operator-decisions`)
      .send(body("outcome-o5"));
    const decisionId = created.body.data.id;
    try {
      await resolveViaBoard(decisionId);
      const first = await request(app("agent"))
        .post(`/api/operator-decisions/${decisionId}/outcome`)
        .send({ status: "in_progress", detail: "실행 시작" });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const second = await request(app("agent"))
        .post(`/api/operator-decisions/${decisionId}/outcome`)
        .send({ status: "completed", detail: "실행 완료" });
      expect(second.status, JSON.stringify(second.body)).toBe(200);
      const activities = await outcomeActivities(decisionId);
      expect(activities).toHaveLength(2);
      // createdAt 동일 타임스탬프 가능성이 있어 순서 무관 집합 검증으로 2건 모두를 증명한다.
      expect(activities.map((row) => (row.details as { status: string }).status).sort())
        .toEqual(["completed", "in_progress"]);
      for (const row of activities) {
        expect(row.details).toMatchObject({
          schemaVersion: 1,
          operatorDecisionId: decisionId,
          requesterAgentId: agentId,
          reportedAt: expect.any(String),
        });
      }
    } finally {
      await waitForWakeupToSettle(decisionId);
    }
  });

  // [4b-1 투영] 카드 뷰에 요청자 outcome·취소 사유 투영 — V1~V4. GET 상세 응답의
  //   requesterOutcome(최신 1건)·cancellationReason 이 상태별로 정확히 노출되는지 검증한다.
  it("V1: resolved card view projects the latest requester outcome", async () => {
    const created = await request(app("agent"))
      .post(`/api/companies/${companyId}/operator-decisions`)
      .send(body("projection-v1"));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const decisionId = created.body.data.id;
    try {
      await resolveViaBoard(decisionId);
      const first = await request(app("agent"))
        .post(`/api/operator-decisions/${decisionId}/outcome`)
        .send({ status: "in_progress", detail: "실행 시작" });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      // 최신 1건 판정이 createdAt 내림차순 정렬에 의존한다 — 타이 스탬프 타이 방지 대기.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const second = await request(app("agent"))
        .post(`/api/operator-decisions/${decisionId}/outcome`)
        .send({ status: "completed", detail: "실행 완료" });
      expect(second.status, JSON.stringify(second.body)).toBe(200);
      const detail = await request(app()).get(`/api/operator-decisions/${decisionId}`);
      expect(detail.status, JSON.stringify(detail.body)).toBe(200);
      expect(detail.body.data.requesterOutcome).toMatchObject({
        status: "completed",
        reason: null,
        detail: "실행 완료",
        reportedAt: expect.any(String),
      });
      expect(detail.body.data.cancellationReason).toBeNull();
    } finally {
      await waitForWakeupToSettle(decisionId);
    }
  });

  it("V2: resolved card without outcomes projects null requester outcome", async () => {
    // 요청자 회신이 없는 resolved 카드 — 보드 생성(issue 없음)은 즉시 웨이크업도 만들지
    // 않는다(FIXME 클린업 경합 회피). 투영은 요청자 유형과 무관하게 null 이어야 한다.
    const created = await request(app())
      .post(`/api/companies/${companyId}/operator-decisions`)
      .send(body("projection-v2"));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const decisionId = created.body.data.id;
    await resolveViaBoard(decisionId);
    const detail = await request(app()).get(`/api/operator-decisions/${decisionId}`);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body.data.requesterOutcome).toBeNull();
    expect(detail.body.data.cancellationReason).toBeNull();
  });

  it("V3: cancelled card view projects the cancellation reason", async () => {
    // 취소 사유 activity 원본은 4a 스윕과 같은 writer(write.cancel 의 reason)가 남긴다.
    const created = await request(app())
      .post(`/api/companies/${companyId}/operator-decisions`)
      .send(body("projection-v3"));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const decisionId = created.body.data.id;
    const cancelled = await operatorDecisionWriteService(db)
      .cancel(decisionId, { type: "user", id: "board-user" }, "target_changed");
    expect(cancelled.applied).toBe(true);
    const detail = await request(app()).get(`/api/operator-decisions/${decisionId}`);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body.data.status).toBe("cancelled");
    expect(detail.body.data.cancellationReason).toBe("target_changed");
    expect(detail.body.data.requesterOutcome).toBeNull();
  });

  it("V4: pending card view projects null outcome and cancellation reason", async () => {
    const created = await request(app("agent"))
      .post(`/api/companies/${companyId}/operator-decisions`)
      .send(body("projection-v4"));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const detail = await request(app("agent")).get(`/api/operator-decisions/${created.body.data.id}`);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body.data.status).toBe("pending");
    expect(detail.body.data.requesterOutcome).toBeNull();
    expect(detail.body.data.cancellationReason).toBeNull();
  });
});
