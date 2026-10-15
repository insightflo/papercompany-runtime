import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issueComments,
  issues,
  operatorDecisionContinuations,
  operatorDecisions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import { operatorDecisionWriteService } from "../services/operator-decisions-write.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

const definition = {
  options: [{ id: "one", label: "One", description: null, facts: [], evidenceRefs: [] }],
  actions: [
    { id: "choose", label: "Choose", outcome: "submit" as const, tone: "primary" as const, requiresSelection: true },
    { id: "hold", label: "Hold", outcome: "hold" as const, tone: "neutral" as const, requiresSelection: false },
  ],
  selection: { min: 1, max: 1 },
  comment: { mode: "optional" as const, label: "Note", placeholder: null, maxLength: 100 },
  approvedScope: ["internal"],
  forbiddenScope: ["external"],
  humanReview: {
    schemaVersion: "human-review-v1" as const,
    decisionSubject: "Choose the next operation",
    evidence: [{ label: "Linked work", href: "/issues/fixture", location: "Issue detail > evidence" }],
    interpretation: "The operator must choose one bounded continuation.",
    impact: { ifApproved: "The selected continuation runs.", ifRejected: "The continuation remains stopped.", ifWrong: "The wrong continuation could run." },
    unresolvedFacts: [], questions: ["Is the selected continuation correct?"],
    recommendedNextStep: "Open the linked work, verify the evidence, and decide.", requiredReviewer: "Human Operator",
  },
};

function input(requestKey: string, issueId: string | null = null) {
  return {
    schemaVersion: 1 as const,
    requestKey,
    priority: "high" as const,
    interactionType: "single_select" as const,
    title: "Choose",
    description: "Choose one",
    sourceType: "workflow_step",
    sourceId: "step-1",
    sourceContext: { missionId: null, workflowId: null, workflowRunId: null, artifactRefs: [] },
    definition,
    issueId,
    continuationMode: issueId ? "issue_current_assignee" as const : "none" as const,
  };
}

describeDb("operator decision write service", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let otherCompanyId: string;
  let agentId: string;
  let issueId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("operator-decisions-write-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  beforeEach(async () => {
    await db.delete(activityLog);
    await db.delete(operatorDecisionContinuations);
    await db.delete(operatorDecisions);
    // [delivery bridge] resolve 가 시스템 코멘트를 남기므로 issues 삭제 전에 정리한다(FK 순서).
    await db.delete(issueComments);
    // [currentness gate] 스냅샷 재검증 픽스처 — step→run→definition 순서로 정리한다(FK 연쇄).
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
    companyId = randomUUID();
    otherCompanyId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "One", issuePrefix: `O${companyId.slice(0, 4)}` },
      { id: otherCompanyId, name: "Two", issuePrefix: `T${otherCompanyId.slice(0, 4)}` },
    ]);
    agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent" });
    issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Work", assigneeAgentId: agentId, status: "todo" });
  });

  it("creates idempotently and rejects request hash conflicts", async () => {
    const service = operatorDecisionWriteService(db);
    const first = await service.create(companyId, input("same"), { type: "agent", id: agentId });
    const replay = await service.create(companyId, input("same"), { type: "agent", id: agentId });
    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({ replayed: true, decision: { id: first.decision.id } });
    await expect(service.create(companyId, { ...input("same"), title: "Different" }, { type: "agent", id: agentId }))
      .rejects.toMatchObject({ status: 409 });
  });

  it("publishes exactly one operator_decision.created live event and stays silent on replay", async () => {
    const service = operatorDecisionWriteService(db);
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
      events.push({ type: event.type, payload: event.payload });
    });
    try {
      const created = await service.create(companyId, input("card-alert"), { type: "user", id: "board-user" });
      expect(created.replayed).toBe(false);
      const published = events.filter((event) => event.type === "operator_decision.created");
      expect(published).toHaveLength(1);
      expect(published[0]!.payload).toMatchObject({
        operatorDecisionId: created.decision.id,
        issueId: null,
        missionId: null,
        title: "Choose",
        priority: "high",
      });

      // [card alert] replay 는 이미 알림을 받았으므로 재발행하지 않는다(멱등).
      const replay = await service.create(companyId, input("card-alert"), { type: "user", id: "board-user" });
      expect(replay.replayed).toBe(true);
      expect(events.filter((event) => event.type === "operator_decision.created")).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });

  it("enforces same-company requesters and linked issues", async () => {
    const service = operatorDecisionWriteService(db);
    await expect(service.create(otherCompanyId, input("agent-boundary"), { type: "agent", id: agentId }))
      .rejects.toMatchObject({ status: 403 });
    await expect(service.create(otherCompanyId, input("issue-boundary", issueId), { type: "user", id: "board" }))
      .rejects.toMatchObject({ status: 422 });
  });

  it("atomically stores result, activity, and exactly one explicit continuation", async () => {
    const service = operatorDecisionWriteService(db);
    const created = await service.create(companyId, input("resolve", issueId), { type: "agent", id: agentId });
    const resolved = await service.resolve(created.decision.id, {
      actionId: "choose",
      selectedOptionIds: ["one"],
      comment: " yes ",
    }, "board-user");
    expect(resolved).toMatchObject({ applied: true, decision: { status: "resolved", result: { outcome: "submit", comment: "yes" } } });
    expect(resolved.continuation).toMatchObject({ state: "pending", attemptCount: 0 });
    expect(await db.select().from(operatorDecisionContinuations)).toHaveLength(1);
    const activities = await db.select().from(activityLog).where(eq(activityLog.entityId, created.decision.id));
    expect(activities.map((row) => row.action)).toEqual(["operator_decision.created", "operator_decision.resolved"]);
    expect(activities[1]?.details).not.toHaveProperty("comment");
  });

  it("rejects packet-less creation; legacy packet-less rows stay unresolvable", async () => {
    const service = operatorDecisionWriteService(db);
    // [생성 게이트] 패킷 없는 신규 생성은 422로 거부된다(죽은 카드 원천 차단).
    await expect(service.create(companyId, {
      ...input("missing-review"), definition: { ...definition, humanReview: null },
    }, { type: "agent", id: agentId })).rejects.toMatchObject({ status: 422, details: { code: "human_review_packet_required" } });
    // [2차 방어] 게이트 이전 데이터(직접 삽입 행)는 resolve 도 여전히 거부한다.
    const [legacy] = await db.insert(operatorDecisions).values({
      companyId,
      requestKey: "missing-review-legacy",
      requestHash: randomUUID(),
      priority: "high",
      interactionType: "single_select",
      title: "Choose",
      description: "",
      sourceType: "workflow_step",
      sourceId: "x",
      sourceContext: { missionId: null, workflowId: null, workflowRunId: null, artifactRefs: [] },
      issueId: null,
      definition: { ...definition, humanReview: null },
    }).returning();
    await expect(service.resolve(legacy.id, {
      actionId: "choose", selectedOptionIds: ["one"], comment: null,
    }, "board-user")).rejects.toMatchObject({ status: 422, details: { code: "human_review_packet_required" } });
  });

  it("makes resolution immutable with identical replay and first-writer-wins", async () => {
    const service = operatorDecisionWriteService(db);
    const created = await service.create(companyId, input("immutable"), { type: "user", id: "board-user" });
    const body = { actionId: "choose", selectedOptionIds: ["one"], comment: null };
    const [one, two] = await Promise.all([
      service.resolve(created.decision.id, body, "board-user"),
      service.resolve(created.decision.id, body, "board-user"),
    ]);
    expect([one.applied, two.applied].sort()).toEqual([false, true]);
    await expect(service.resolve(created.decision.id, { actionId: "hold", selectedOptionIds: [], comment: null }, "board-user"))
      .rejects.toMatchObject({ status: 409 });
  });

  it("resolves after issue deletion and records a null-issue outbox", async () => {
    const service = operatorDecisionWriteService(db);
    const created = await service.create(companyId, input("deleted", issueId), { type: "user", id: "board" });
    await db.delete(issues).where(eq(issues.id, issueId));
    const resolved = await service.resolve(created.decision.id, {
      actionId: "choose", selectedOptionIds: ["one"], comment: null,
    }, "board");
    expect(resolved.decision.issueId).toBeNull();
    expect(resolved.continuation).toMatchObject({ state: "pending" });
  });

  // [currentness gate 2단계] 늦은 선택 보호 — 생성 시점 대상 스냅샷(targetSnapshot)과 resolve 시점
  //   현재 상태가 다르면 409 target_changed 로 거부하고, 상태가 원복되면 같은 카드로 다시 결정된다.
  describe("target snapshot currentness", () => {
    const resolveBody = { actionId: "choose", selectedOptionIds: ["one"], comment: null };

    function snapshotCard(requestKey: string, targetSnapshot: Record<string, unknown>) {
      const base = input(requestKey, issueId);
      return { ...base, sourceContext: { ...base.sourceContext, targetSnapshot } };
    }

    async function seedWorkflowFixture() {
      const workflowDefinitionId = randomUUID();
      const workflowRunId = randomUUID();
      const stepRunId = randomUUID();
      await db.insert(workflowDefinitions).values({ id: workflowDefinitionId, companyId, name: "Currentness fixture" });
      await db.insert(workflowRuns).values({
        id: workflowRunId, workflowId: workflowDefinitionId, companyId, triggeredBy: "test", status: "running",
      });
      await db.insert(workflowStepRuns).values({
        id: stepRunId, workflowRunId, stepId: "step-1", status: "running", executionGeneration: 3,
      });
      return { workflowRunId, stepRunId };
    }

    async function decisionRow(id: string) {
      return db.select().from(operatorDecisions).where(eq(operatorDecisions.id, id))
        .then((rows) => rows[0] ?? null);
    }

    it("T1: resolves with one continuation when the full snapshot still matches", async () => {
      const service = operatorDecisionWriteService(db);
      const { workflowRunId, stepRunId } = await seedWorkflowFixture();
      const created = await service.create(companyId, snapshotCard("snap-current", {
        issueId, issueStatus: "todo",
        workflowRunId, workflowRunStatus: "running",
        stepRunId, stepRunStatus: "running", executionGeneration: 3,
      }), { type: "user", id: "board" });
      const resolved = await service.resolve(created.decision.id, resolveBody, "board");
      expect(resolved).toMatchObject({ applied: true, decision: { status: "resolved" } });
      expect(await db.select().from(operatorDecisionContinuations)).toHaveLength(1);
    });

    it("T2: rejects a drifted issue status with 409 target_changed and keeps the card pending", async () => {
      const service = operatorDecisionWriteService(db);
      const created = await service.create(companyId, snapshotCard("snap-issue-drift", {
        issueId, issueStatus: "todo",
      }), { type: "agent", id: agentId });
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      await expect(service.resolve(created.decision.id, resolveBody, "board"))
        .rejects.toMatchObject({ status: 409, details: { code: "target_changed", mismatch: ["issueStatus"] } });
      // 거부는 트랜잭션에서 일어난다 — 결과·continuation·resolved 활동 로그·이슈 코멘트 모두 없다.
      expect(await decisionRow(created.decision.id)).toMatchObject({ status: "pending", result: null });
      expect(await db.select().from(operatorDecisionContinuations)).toHaveLength(0);
      const activities = await db.select().from(activityLog).where(eq(activityLog.entityId, created.decision.id));
      expect(activities.map((row) => row.action)).toEqual(["operator_decision.created"]);
      expect(await db.select().from(issueComments)).toHaveLength(0);
    });

    it("T3: rejects when the snapshotted workflow run no longer exists", async () => {
      const service = operatorDecisionWriteService(db);
      const { workflowRunId } = await seedWorkflowFixture();
      const created = await service.create(companyId, snapshotCard("snap-run-deleted", {
        workflowRunId, workflowRunStatus: "running",
      }), { type: "user", id: "board" });
      await db.delete(workflowRuns).where(eq(workflowRuns.id, workflowRunId));
      await expect(service.resolve(created.decision.id, resolveBody, "board"))
        .rejects.toMatchObject({ status: 409, details: { code: "target_changed", mismatch: ["workflowRunId"] } });
      expect(await decisionRow(created.decision.id)).toMatchObject({ status: "pending" });
      expect(await db.select().from(operatorDecisionContinuations)).toHaveLength(0);
    });

    it("T4: rejects a drifted step run execution generation", async () => {
      const service = operatorDecisionWriteService(db);
      const { stepRunId } = await seedWorkflowFixture();
      const created = await service.create(companyId, snapshotCard("snap-generation-drift", {
        stepRunId, stepRunStatus: "running", executionGeneration: 3,
      }), { type: "user", id: "board" });
      await db.update(workflowStepRuns).set({ executionGeneration: 4 }).where(eq(workflowStepRuns.id, stepRunId));
      await expect(service.resolve(created.decision.id, resolveBody, "board"))
        .rejects.toMatchObject({ status: 409, details: { code: "target_changed", mismatch: ["executionGeneration"] } });
      expect(await decisionRow(created.decision.id)).toMatchObject({ status: "pending" });
    });

    it("T5: rejects snapshot creation without an identifier field (422)", async () => {
      const service = operatorDecisionWriteService(db);
      await expect(service.create(companyId, snapshotCard("snap-empty", {}), { type: "user", id: "board" }))
        .rejects.toMatchObject({ status: 422, details: { code: "target_snapshot_identifier_required" } });
      await expect(service.create(companyId, snapshotCard("snap-no-identifier", { issueStatus: "todo" }), { type: "user", id: "board" }))
        .rejects.toMatchObject({ status: 422, details: { code: "target_snapshot_identifier_required" } });
      expect(await db.select().from(operatorDecisions)).toHaveLength(0);
    });

    it("T6: the same card resolves after the drifted state is restored", async () => {
      const service = operatorDecisionWriteService(db);
      const created = await service.create(companyId, snapshotCard("snap-restore", {
        issueId, issueStatus: "todo",
      }), { type: "agent", id: agentId });
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      await expect(service.resolve(created.decision.id, resolveBody, "board"))
        .rejects.toMatchObject({ status: 409, details: { code: "target_changed" } });
      await db.update(issues).set({ status: "todo" }).where(eq(issues.id, issueId));
      const resolved = await service.resolve(created.decision.id, resolveBody, "board");
      expect(resolved).toMatchObject({ applied: true, decision: { status: "resolved" } });
      expect(await db.select().from(operatorDecisionContinuations)).toHaveLength(1);
    });
  });
});
