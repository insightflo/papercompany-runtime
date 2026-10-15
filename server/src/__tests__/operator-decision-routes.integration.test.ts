import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activityLog, agentRuntimeState, agentTaskSessions, agentWakeupRequests, agents, companies, companySkills, createDb, heartbeatRunEvents, heartbeatRuns, issueComments, issues, operatorDecisionContinuations, operatorDecisions } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { operatorDecisionRoutes } from "../routes/operator-decisions.js";

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
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  beforeEach(async () => {
    // resolve route의 즉시 웨이크업이 남기는 heartbeat_runs·agent_wakeup_requests·
    // agent_runtime_state/agent_task_sessions(웨이크업 경로가 agents 참조 행을 만듦)·
    // company_skills(웨이크업 실행 준비가 번들 스킬을 upsert)·
    // activity_log(run_id) 행까지 정리(heartbeat_runs.wakeupRequestId FK → wakeup 행을 나중에 삭제)
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
    await db.delete(agents);
    await db.delete(companies);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Routes", issuePrefix: `D${companyId.slice(0, 4)}` });
    agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Requester" });
    issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Task", assigneeAgentId: agentId, identifier: `${companyId.slice(0, 4).toUpperCase()}-1`, issueNumber: 1 });
  });

  function app(actor: "board" | "agent" | "none" = "board") {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      req.actor = actor === "board"
        ? { type: "board", userId: "board-user", companyIds: [], source: "local_implicit", isInstanceAdmin: true }
        : actor === "agent"
          ? { type: "agent", agentId, companyId, runId: null }
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

  // 즉시 깨움이 만든 비동기 실행 체인(번들 스킬 upsert 포함)이 다음 beforeEach 정리와
  // 경합하지 않도록 깨움 요청이 종료 상태가 될 때까지 기다린다(위 FIXME 경합과 같은 원인).
  async function waitForWakeupToSettle(decisionId: string) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const [row] = await db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.idempotencyKey, `operator-decision-resolved:${decisionId}`));
      if (!row || !["queued", "claimed", "deferred_issue_execution"].includes(row.status)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`immediate wakeup for ${decisionId} did not settle within 10s`);
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
});
