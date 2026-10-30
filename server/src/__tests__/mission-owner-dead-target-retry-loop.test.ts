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
import { rmSync } from "node:fs";
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
  workflowRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { seedToolRecoveryScenario } from "./helpers/tool-recovery-scenario.js";
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

async function recordOwnerRetryDecision(db: ReturnType<typeof createDb>, base: Pick<Base, "companyId" | "ownerAgentId" | "missionId">, ownerActionIssueId: string, sourceIssueId: string) {
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
  const roots: string[] = [];

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
    await db.delete(workflowRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => { for (const root of roots) rmSync(root, { recursive: true, force: true }); await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

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
    // 실행 가능한 workflow binding이 없는 fixture는 자연어 replan/retry를 만들지 않고 외부 입력을 요구한다.
    const breakerOptions = (cards[0]!.definition as { options: { id: string; recommended?: boolean; recommendationReason?: string | null }[] }).options;
    expect(breakerOptions).toHaveLength(1);
    expect(breakerOptions[0]).toMatchObject({ id: "missing-recovery-target", recommended: true });

    // 차단 후에도 owner 가 새 결정을 기록하면 새 eventId 로 즉시 다시 평가된다(수동 결정 자유 불변).
    const revived = await recordOwnerRetryDecision(db, base, ownerAction.id, source.id);
    void revived;
    const fifth = await svc.runMainExecutorSupervision({
      missionId: base.missionId, staleAfterMinutes: 1, now: new Date(baseTime + 5 * 60_000),
      applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: false,
    });
    expect(fifth.findings.join("\n")).toContain("owner_action_decision_not_applied");
  });

  // [C2 2026-10-30] 이하 2케이스는 실제 스냅샷 기반 실패 tool 소스 + 정상 v1 바인딩 카드로만 새 source proof 를 통과한다.
  async function seedSnapshotToolCard(cardStatus: "todo" | "done") {
    const s = await seedToolRecoveryScenario({ db, artifactExists: false, captureExecutionDefinitionSnapshot: true });
    roots.push(s.tempRoot);
    await db.update(issues).set({ status: cardStatus }).where(eq(issues.id, s.recoveryIssueId));
    await db.insert(workflowTransitionEvents).values({ companyId: s.companyId, missionId: s.missionId,
      issueId: s.recoveryIssueId, workflowRunId: s.workflowRunId, workflowStepRunId: s.stepRunId,
      layer: "mission_owner_recovery", eventType: "owner_tool_recovery_target_v1",
      idempotencyKey: `owner-tool-card:${s.stepRunId}`,
      payload: { schemaVersion: 1, kind: "tool_step", workflowRunId: s.workflowRunId, stepRunId: s.stepRunId } });
    return s;
  }
  const superviseOwner = (missionId: string, now: Date) => missionService(db).runMainExecutorSupervision({
    missionId, staleAfterMinutes: 1, now, applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: false });

  it("escalates immediately when the recorded decision lacks a tool-step target (dead decision)", async () => {
    const s = await seedSnapshotToolCard("done");
    // [2단계 2026-10-23] 죽은 결정(기록됐으나 도구 대상 없음)은 3틱 대기 없이 첫 틱에 즉시 에스컬레이션(RES-9071).
    await recordOwnerRetryDecision(db, { companyId: s.companyId, ownerAgentId: s.ownerAgentId, missionId: s.missionId },
      s.recoveryIssueId, s.oversightIssueId);
    const first = await superviseOwner(s.missionId, new Date());
    expect(first.findings.join("\n")).toContain("owner_tool_recovery_dead_target_breaker");
    expect(first.findings.join("\n")).not.toContain("tool_step_recovery_no_op");
    const cards = await db.select({ id: operatorDecisions.id }).from(operatorDecisions).where(and(
      eq(operatorDecisions.companyId, s.companyId), eq(operatorDecisions.sourceType, "mission_owner_human_input")));
    expect(cards).toHaveLength(1);
  });

  it("keeps the 3-strike breaker while the owner simply has not decided yet", async () => {
    const s = await seedSnapshotToolCard("todo");
    // 결정 기록 없음 + 도구 회복 카드만 존재 → 오너 응답 대기: 기존 3회 브레이컈 유지.
    const baseTime = Date.now();
    for (const minute of [1, 2, 3]) {
      const run = await superviseOwner(s.missionId, new Date(baseTime + minute * 60_000));
      expect(run.findings.join("\n")).toContain("tool_step_recovery_no_op");
    }
    expect((await superviseOwner(s.missionId, new Date(baseTime + 4 * 60_000))).findings.join("\n"))
      .toContain("owner_tool_recovery_dead_target_breaker");
  });
});
