// server/src/__tests__/mission-owner-dead-target-retry-loop.test.ts
//
// [목적] "죽은 대상(dead target) 향한 owner retry 무한 no-op 순환" 방지 회귀 테스트.
//   2026-10-18 라이브 사고(mission ff703920, 17h+ 교착): 종결(done) 소스를 가리키는
//   retry_source_issue 가 매 감시 틱마다 not_applied 로 거부되면서 다른 행동 전환·실행·
//   에스컬레이션 없이 같은 순환만 반복했다. 이 테스트는 3가지 방어를 검증한다.
//   1) grace auto-default 선택기: 캐노니컬 소스가 종결/숨김/누락이면 retry 대신 escalate 자동 전환.
//   2) 적용 단계 회로 차단기: 같은 (owner-action, retry, 대상) 조합이 3회 not_applied 면 재적용 억제 + 진단.
//   3) tool recovery target_missing 대기 순환도 같은 차단기로 종결(사고 관측 로그 RES-8604).
//   불변 확인: 살아있는 대상 재시도는 기존 grace default retry 유지(3번째 케이스).
// [외부 연결] 대상: services/missions/supervision.ts, mission-owner-dead-target-loop.ts.
// [수정시 주의] 마커/카드는 companyId+combo 로만 구분(테스트마다 randomUUID) — 상호 오염 없음.
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  missions,
  operatorDecisions,
  workflowTransitionEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { missionService } from "../services/missions.js";
import { issueService } from "../services/issues.js";
import { recordMissionOwnerDecision } from "../services/missions/mission-owner-recovery-ledger.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`skip dead-target retry loop: ${support.reason ?? "unsupported"}`);

type Base = { companyId: string; ownerAgentId: string; workerAgentId: string; missionId: string };

async function seedBase(db: ReturnType<typeof createDb>, name: string): Promise<Base> {
  const companyId = randomUUID();
  const ownerAgentId = randomUUID();
  const workerAgentId = randomUUID();
  const missionId = randomUUID();
  await db.insert(companies).values({ id: companyId, name, status: "active" });
  await db.insert(agents).values([
    { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
  ]);
  await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: `${name} mission`, status: "active" });
  return { companyId, ownerAgentId, workerAgentId, missionId };
}

async function recordOwnerRetryDecision(db: ReturnType<typeof createDb>, base: Base, ownerActionIssueId: string, sourceIssueId: string) {
  const ownerWakeupId = randomUUID();
  await db.insert(agentWakeupRequests).values({
    id: ownerWakeupId, companyId: base.companyId, agentId: base.ownerAgentId, source: "test",
    status: "completed", issueId: ownerActionIssueId, missionId: base.missionId, reason: "test",
    requestKind: "workflow_resume", requestedAt: new Date(),
  });
  const [ownerRun] = await db.insert(heartbeatRuns).values({
    companyId: base.companyId, agentId: base.ownerAgentId, issueId: ownerActionIssueId,
    status: "succeeded", wakeupRequestId: ownerWakeupId, startedAt: new Date(), finishedAt: new Date(), createdAt: new Date(),
  }).returning({ id: heartbeatRuns.id });
  await recordMissionOwnerDecision({
    db,
    issue: { id: ownerActionIssueId, companyId: base.companyId, missionId: base.missionId },
    submission: { decision: "retry_source_issue", sourceIssueRef: sourceIssueId, reason: "retry the terminal source" },
    sourceIssueId,
    heartbeatRunId: ownerRun.id,
  });
}

describeEP("mission owner dead-target retry loop prevention", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dead-target-retry-loop-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(operatorDecisions);
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(workflowTransitionEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  it("grace auto-default escalates instead of retrying a terminal canonical source, once, with a human decision card", async () => {
    const base = await seedBase(db, "Grace Dead Target Co");
    const svc = missionService(db);
    const source = await issueService(db).create(base.companyId, {
      assigneeAgentId: base.workerAgentId, missionId: base.missionId,
      originKind: "workflow_execution", status: "done", title: "Terminal source",
    });
    await svc.runMainExecutorSupervision({ missionId: base.missionId, staleAfterMinutes: 1, now: new Date() });
    const ownerAction = await issueService(db).create(base.companyId, {
      assigneeAgentId: base.ownerAgentId, missionId: base.missionId,
      originKind: "mission_main_executor_unblock", originId: source.id, status: "todo",
      title: "Unblock for a terminal source",
    });
    await db.update(issues).set({ createdAt: new Date(Date.now() - 40 * 60 * 1000) })
      .where(eq(issues.id, ownerAction.id));

    const result = await svc.runMainExecutorSupervision({
      missionId: base.missionId, staleAfterMinutes: 1, now: new Date(),
      applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: false,
    });

    expect(result.findings.join("\n")).not.toContain("owner_action_grace_default_retry");
    expect(result.findings.join("\n")).toContain("owner_action_grace_default_dead_target");
    expect(result.findings.join("\n")).not.toContain("owner_action_decision_not_applied");
    expect(result.appliedActions.filter((action) => action.type === "owner_decision_retry_source_issue")).toEqual([]);
    expect(result.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "escalate_blocked" }),
    ]));

    const escalationEvents = await db.select({ id: workflowTransitionEvents.id })
      .from(workflowTransitionEvents)
      .where(and(
        eq(workflowTransitionEvents.companyId, base.companyId),
        eq(workflowTransitionEvents.eventType, "mission_owner_dead_target_escalation"),
      ));
    expect(escalationEvents).toHaveLength(1);
    const cards = await db.select({ id: operatorDecisions.id, sourceType: operatorDecisions.sourceType })
      .from(operatorDecisions)
      .where(and(
        eq(operatorDecisions.companyId, base.companyId),
        eq(operatorDecisions.sourceType, "mission_owner_human_input"),
      ));
    expect(cards).toHaveLength(1);

    // 반복 틱에도 카드/이벤트는 1회(알림 1회 불변) — 조용한 no-op 반복 없이 같은 진단만 유지된다.
    const second = await svc.runMainExecutorSupervision({
      missionId: base.missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 60_000),
      applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: false,
    });
    expect(second.findings.join("\n")).toContain("owner_action_grace_default_dead_target");
    expect((await db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, base.companyId),
      eq(workflowTransitionEvents.eventType, "mission_owner_dead_target_escalation"),
    ))).length).toBe(1);
    expect((await db.select({ id: operatorDecisions.id }).from(operatorDecisions).where(and(
      eq(operatorDecisions.companyId, base.companyId),
      eq(operatorDecisions.sourceType, "mission_owner_human_input"),
    ))).length).toBe(1);
  });

  it("keeps grace auto-default retry for a live source (regression guard)", async () => {
    const base = await seedBase(db, "Grace Live Target Co");
    const svc = missionService(db);
    const source = await issueService(db).create(base.companyId, {
      assigneeAgentId: base.workerAgentId, missionId: base.missionId,
      originKind: "workflow_execution", status: "blocked", title: "Live blocked source",
    });
    await svc.runMainExecutorSupervision({ missionId: base.missionId, staleAfterMinutes: 1, now: new Date() });
    const [ownerAction] = await db.select().from(issues).where(and(
      eq(issues.companyId, base.companyId), eq(issues.missionId, base.missionId),
      eq(issues.originKind, "mission_main_executor_unblock"), eq(issues.originId, source.id)));
    expect(ownerAction).toBeTruthy();
    await db.update(issues).set({ createdAt: new Date(Date.now() - 40 * 60 * 1000) })
      .where(eq(issues.id, ownerAction!.id));

    const result = await svc.runMainExecutorSupervision({
      missionId: base.missionId, staleAfterMinutes: 1, now: new Date(),
      applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: false,
    });

    expect(result.findings.join("\n")).toContain("owner_action_grace_default_retry");
    expect(result.findings.join("\n")).not.toContain("owner_action_grace_default_dead_target");
    expect((await db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, base.companyId),
      eq(workflowTransitionEvents.eventType, "mission_owner_dead_target_escalation"),
    ))).length).toBe(0);
  });

  it("breaks the recorded dead-target retry_source_issue loop after repeated not_applied", async () => {
    const base = await seedBase(db, "Breaker Dead Target Co");
    const svc = missionService(db);
    const source = await issueService(db).create(base.companyId, {
      assigneeAgentId: base.workerAgentId, missionId: base.missionId,
      originKind: "workflow_execution", status: "done", title: "Terminal breaker source",
    });
    await svc.runMainExecutorSupervision({ missionId: base.missionId, staleAfterMinutes: 1, now: new Date() });
    const ownerAction = await issueService(db).create(base.companyId, {
      assigneeAgentId: base.ownerAgentId, missionId: base.missionId,
      originKind: "mission_main_executor_unblock", originId: source.id, status: "done",
      title: "Recorded retry toward a terminal source",
    });
    await recordOwnerRetryDecision(db, base, ownerAction.id, source.id);

    const markers = () => db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, base.companyId),
      eq(workflowTransitionEvents.eventType, "mission_owner_decision_not_applied"),
    ));
    const baseTime = Date.now();
    for (const minute of [1, 2, 3]) {
      const run = await svc.runMainExecutorSupervision({
        missionId: base.missionId, staleAfterMinutes: 1, now: new Date(baseTime + minute * 60_000),
        applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: false,
      });
      expect(run.findings.join("\n")).toContain("owner_action_decision_not_applied");
      expect(run.findings.join("\n")).not.toContain("owner_action_retry_dead_target_breaker");
    }
    expect((await markers()).length).toBe(3);

    const fourth = await svc.runMainExecutorSupervision({
      missionId: base.missionId, staleAfterMinutes: 1, now: new Date(baseTime + 4 * 60_000),
      applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: false,
    });
    expect(fourth.findings.join("\n")).toContain("owner_action_retry_dead_target_breaker");
    expect(fourth.findings.join("\n")).not.toContain("owner_action_decision_not_applied");
    expect(fourth.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "escalate_blocked" }),
      expect.objectContaining({ type: "request_replan" }),
    ]));
    expect((await markers()).length).toBe(3);
    const cards = await db.select({ id: operatorDecisions.id, definition: operatorDecisions.definition }).from(operatorDecisions).where(and(
      eq(operatorDecisions.companyId, base.companyId),
      eq(operatorDecisions.sourceType, "mission_owner_human_input"),
    ));
    expect(cards).toHaveLength(1);
    // [추천 주입] 차단기 카드는 내부 진단(request_replan)에 근거해 replan 선택지에 추천+사유를 표시한다.
    const breakerOptions = (cards[0]!.definition as { options: { id: string; recommended?: boolean; recommendationReason?: string | null }[] }).options;
    const replanOption = breakerOptions.find((option) => option.id === "replan-the-mission");
    expect(replanOption?.recommended).toBe(true);
    expect(replanOption?.recommendationReason).toContain("dead target");
    expect(breakerOptions.filter((option) => option.id !== "replan-the-mission").every((option) => option.recommended !== true)).toBe(true);

    // 차단 후에도 owner 가 새 결정을 기록하면 새 eventId 로 즉시 다시 평가된다(수동 결정 자유 불변).
    const revived = await recordOwnerRetryDecision(db, base, ownerAction.id, source.id);
    void revived;
    const fifth = await svc.runMainExecutorSupervision({
      missionId: base.missionId, staleAfterMinutes: 1, now: new Date(baseTime + 5 * 60_000),
      applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: false,
    });
    expect(fifth.findings.join("\n")).toContain("owner_action_decision_not_applied");
  });

  it("escalates immediately when the recorded decision lacks a tool-step target (dead decision)", async () => {
    const base = await seedBase(db, "Tool Dead Decision Co");
    const svc = missionService(db);
    const source = await issueService(db).create(base.companyId, {
      assigneeAgentId: base.workerAgentId, missionId: base.missionId,
      originKind: "workflow_execution", status: "blocked", title: "Tool recovery source",
    });
    await svc.runMainExecutorSupervision({ missionId: base.missionId, staleAfterMinutes: 1, now: new Date() });
    const ownerAction = await issueService(db).create(base.companyId, {
      assigneeAgentId: base.ownerAgentId, missionId: base.missionId,
      originKind: "mission_main_executor_unblock", originId: source.id, status: "done",
      title: "Tool recovery card without a tool target",
    });
    await recordOwnerRetryDecision(db, base, ownerAction.id, source.id);
    // [2단계 2026-10-23] 결정이 기록됐는데 도구 대상이 없으면(죽은 결정) 3틱 대기 없이 첫 틱에 즉시
    //   사람 에스컬레이션 — no_op 재기록·재노출 금지(RES-9071 3회 반복 사고 방지).
    await db.insert(workflowTransitionEvents).values({
      companyId: base.companyId, missionId: base.missionId, issueId: ownerAction.id,
      eventType: "owner_tool_recovery_target_v1", layer: "mission_owner_recovery",
      idempotencyKey: `test-tool-card:${ownerAction.id}`,
      payload: { kind: "owner_tool_recovery_target_v1" },
    });
    const first = await svc.runMainExecutorSupervision({
      missionId: base.missionId, staleAfterMinutes: 1, now: new Date(),
      applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: false,
    });
    expect(first.findings.join("\n")).toContain("owner_tool_recovery_dead_target_breaker");
    expect(first.findings.join("\n")).not.toContain("tool_step_recovery_no_op");
    const cards = await db.select({ id: operatorDecisions.id }).from(operatorDecisions).where(and(
      eq(operatorDecisions.companyId, base.companyId),
      eq(operatorDecisions.sourceType, "mission_owner_human_input"),
    ));
    expect(cards).toHaveLength(1);
  });

  it("keeps the 3-strike breaker while the owner simply has not decided yet", async () => {
    const base = await seedBase(db, "Tool Undecided Co");
    const svc = missionService(db);
    const source = await issueService(db).create(base.companyId, {
      assigneeAgentId: base.workerAgentId, missionId: base.missionId,
      originKind: "workflow_execution", status: "blocked", title: "Tool recovery source",
    });
    await svc.runMainExecutorSupervision({ missionId: base.missionId, staleAfterMinutes: 1, now: new Date() });
    const [ownerAction] = await db.select().from(issues).where(and(
      eq(issues.companyId, base.companyId), eq(issues.missionId, base.missionId),
      eq(issues.originKind, "mission_main_executor_unblock"), eq(issues.originId, source.id)));
    expect(ownerAction).toBeTruthy();
    // 결정 기록 없음 + 도구 회복 카드만 존재 → 오너 응답 대기: 기존 3회 브레이컈 유지.
    await db.insert(workflowTransitionEvents).values({
      companyId: base.companyId, missionId: base.missionId, issueId: ownerAction!.id,
      eventType: "owner_tool_recovery_target_v1", layer: "mission_owner_recovery",
      idempotencyKey: `test-tool-card:${ownerAction!.id}`,
      payload: { kind: "owner_tool_recovery_target_v1" },
    });
    const baseTime = Date.now();
    for (const minute of [1, 2, 3]) {
      const run = await svc.runMainExecutorSupervision({
        missionId: base.missionId, staleAfterMinutes: 1, now: new Date(baseTime + minute * 60_000),
        applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: false,
      });
      expect(run.findings.join("\n")).toContain("tool_step_recovery_no_op");
    }
    const fourth = await svc.runMainExecutorSupervision({
      missionId: base.missionId, staleAfterMinutes: 1, now: new Date(baseTime + 4 * 60_000),
      applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: false,
    });
    expect(fourth.findings.join("\n")).toContain("owner_tool_recovery_dead_target_breaker");
  });
});
