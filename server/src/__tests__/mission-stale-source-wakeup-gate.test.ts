// [stale-source wakeup gate 2026-11-13] netdata 사고 회귀 시험.
//   (1) 같은 진단 3회 반복 + 구조화 판정 → 설정 없이도 자동 깨움,
//   (2) resolve+accepted 된 사람 승인 카드(request_input)를 구조화 판정으로 인정,
//   (3) 미션 허용 목록 게이트, (4) 앵커 보장으로 오너 회복 경로가 열림.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issues,
  missions,
  operatorDecisionContinuations,
  operatorDecisions,
  type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { missionService } from "../services/missions.js";
import { recordMissionOwnerDecision } from "../services/missions/mission-owner-recovery-ledger.js";
import { isStaleSourceWakeupEnabled } from "../services/missions/stale-source-wakeup-gate.js";
vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("stale-source wakeup gate (2026-11-13)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("stale-source-gate-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 5 }); await database?.cleanup();
  });

  const staleAt = new Date("2026-06-02T00:00:00.000Z");
  const runFinishedAt = new Date("2026-06-02T00:02:00.000Z");

  async function seedStaleInProgressSource() {
    const companyId = randomUUID(), ownerAgentId = randomUUID(), workerAgentId = randomUUID(),
      missionId = randomUUID(), failedRunId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Stale gate", issuePrefix: randomUUID().replace(/-/g, "").slice(0, 8),
      requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active",
        adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active",
        adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId,
      title: "Stale gate mission", status: "active" });
    const source = await issueService(db).create(companyId, {
      assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution",
      status: "in_progress", title: "In-progress source after failed run" });
    await db.update(issues).set({ createdAt: staleAt, updatedAt: staleAt }).where(eq(issues.id, source.id));
    await db.insert(heartbeatRuns).values({ id: failedRunId, companyId, agentId: workerAgentId,
      issueId: source.id, status: "failed", errorCode: "adapter_failed", error: "429 rate limited",
      settledAt: runFinishedAt, startedAt: staleAt, finishedAt: runFinishedAt });
    return { companyId, ownerAgentId, workerAgentId, missionId, failedRunId, source };
  }

  async function addStructuredVerdict(w: Awaited<ReturnType<typeof seedStaleInProgressSource>>) {
    const anchor = await issueService(db).create(w.companyId, {
      assigneeAgentId: w.ownerAgentId, missionId: w.missionId,
      originKind: "mission_main_executor_unblock", originId: w.source.id,
      status: "todo", title: "Unblock anchor" });
    const anchorRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: anchorRunId, companyId: w.companyId,
      agentId: w.ownerAgentId, issueId: anchor.id, status: "succeeded",
      startedAt: runFinishedAt, finishedAt: runFinishedAt });
    await recordMissionOwnerDecision({
      db,
      issue: { id: anchor.id, companyId: w.companyId, missionId: w.missionId },
      submission: { decision: "retry_source_issue", reason: "transient 429 quota failure",
        nextAction: "retry the source issue", evidence: "adapter 429 is transient" },
      sourceIssueId: w.source.id,
      heartbeatRunId: anchorRunId,
    });
    return anchor;
  }

  it("wakes a stale in_progress source automatically after the same diagnosis repeats 3x with a structured verdict", async () => {
    const w = await seedStaleInProgressSource();
    await addStructuredVerdict(w);
    const onStaleSourceIssueWakeupRequested = vi.fn().mockResolvedValue({ wakeupRequestId: "wake-1", runId: "run-1" });
    const svc = missionService(db, { onStaleSourceIssueWakeupRequested });
    const t0 = new Date("2026-06-02T01:00:00.000Z");

    await svc.runActiveMissionOwnerSupervision({ companyId: w.companyId, staleAfterMinutes: 1, now: t0 });
    expect(onStaleSourceIssueWakeupRequested).not.toHaveBeenCalled();
    await svc.runActiveMissionOwnerSupervision({ companyId: w.companyId, staleAfterMinutes: 1, now: new Date(t0.getTime() + 60_000) });
    expect(onStaleSourceIssueWakeupRequested).not.toHaveBeenCalled();

    const third = await svc.runActiveMissionOwnerSupervision({ companyId: w.companyId, staleAfterMinutes: 1, now: new Date(t0.getTime() + 120_000) });
    const idempotencyKey = `mission-stale-source-wakeup:${w.missionId}:${w.source.id}:${w.failedRunId}`;
    expect(onStaleSourceIssueWakeupRequested).toHaveBeenCalledTimes(1);
    expect(onStaleSourceIssueWakeupRequested).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({ id: w.missionId }),
      sourceIssue: expect.objectContaining({ id: w.source.id }),
      targetAgentId: w.workerAgentId,
      idempotencyKey,
    }));
    const findings = third.missions.find((row) => row.missionId === w.missionId)?.findings ?? [];
    expect(findings).toEqual(expect.arrayContaining([
      expect.stringContaining("stale_in_progress_after_failed_run"),
      expect.stringContaining("recovery_dispatched"),
    ]));
  });

  it("recognizes a resolved + accepted human input card as a structured recovery verdict and dispatches the wakeup", async () => {
    const w = await seedStaleInProgressSource();
    const decisionId = randomUUID(), continuationWakeId = randomUUID();
    await db.insert(operatorDecisions).values({
      id: decisionId, companyId: w.companyId, requestKey: `moi1:${randomUUID()}`, requestHash: "sg",
      interactionType: "single_select", priority: "high",
      title: "사람 결정 승인 요청 — 입력·승인 요청(request_input)", description: "approve retry",
      sourceType: "mission_owner_human_input", sourceId: randomUUID(),
      sourceContext: { missionId: w.missionId },
      issueId: w.source.id, status: "resolved", continuationMode: "issue_current_assignee",
      definition: { options: [], actions: [], selection: null,
        comment: { mode: "disabled", label: null, placeholder: null, maxLength: 0 },
        approvedScope: [], forbiddenScope: [] },
      result: { actionId: "approve", outcome: "approved", selectedOptionIds: ["approve"],
        comment: null, resolvedAt: "2026-06-02T00:34:00.000Z" },
      resolvedByUserId: "board", resolvedAt: new Date("2026-06-02T00:34:00.000Z"),
    });
    await db.insert(agentWakeupRequests).values({ id: continuationWakeId, companyId: w.companyId,
      agentId: w.workerAgentId, source: "system", triggerDetail: "system",
      reason: "operator_decision_continuation", payload: { issueId: w.source.id }, status: "accepted",
      requestedAt: new Date("2026-06-02T00:30:00.000Z") });
    await db.insert(operatorDecisionContinuations).values({
      companyId: w.companyId, operatorDecisionId: decisionId, issueId: w.source.id,
      state: "accepted", targetAgentId: w.workerAgentId, wakeupRequestId: continuationWakeId,
      idempotencyKey: `moi-cont:${randomUUID()}`,
      acceptedAt: new Date("2026-06-02T00:35:00.000Z"), // after failedRun.finishedAt
    });
    const onStaleSourceIssueWakeupRequested = vi.fn().mockResolvedValue({ wakeupRequestId: "wake-1", runId: "run-1" });
    const svc = missionService(db, { onStaleSourceIssueWakeupRequested });

    const result = await svc.runActiveMissionOwnerSupervision({ companyId: w.companyId,
      staleAfterMinutes: 1, dispatchStaleSourceIssueWakeups: true,
      now: new Date("2026-06-02T01:00:00.000Z") });

    expect(onStaleSourceIssueWakeupRequested).toHaveBeenCalledTimes(1);
    const findings = result.missions.find((row) => row.missionId === w.missionId)?.findings ?? [];
    expect(findings).toEqual(expect.arrayContaining([expect.stringContaining("recovery_dispatched")]));
    // [앵커 보장] 이 클래스에도 mission_main_executor_unblock 앵커가 만들어져 오너 회복 경로가 열린다.
    const anchors = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock"));
    expect(anchors).toEqual(expect.arrayContaining([
      expect.objectContaining({ originId: w.source.id, missionId: w.missionId }),
    ]));
  });

  it("resolves the instance/mission gate: global flag, mission allowlist, and fail-closed default", async () => {
    const missionId = randomUUID(), otherMissionId = randomUUID();
    const setExperimental = (experimental: Record<string, unknown>) =>
      db.insert(instanceSettings).values({ singletonKey: "default", experimental })
        .onConflictDoUpdate({ target: instanceSettings.singletonKey, set: { experimental } });
    await setExperimental({});
    expect(await isStaleSourceWakeupEnabled(db)).toBe(false);
    expect(await isStaleSourceWakeupEnabled(db, missionId)).toBe(false);
    await setExperimental({ staleSourceIssueWakeupAllowedMissionIdsV1: [missionId] });
    expect(await isStaleSourceWakeupEnabled(db)).toBe(false);
    expect(await isStaleSourceWakeupEnabled(db, missionId)).toBe(true);
    expect(await isStaleSourceWakeupEnabled(db, otherMissionId)).toBe(false);
    await setExperimental({ enableStaleSourceIssueWakeupV1: true });
    expect(await isStaleSourceWakeupEnabled(db)).toBe(true);
    await setExperimental({});
  });

  it("enables the wakeup for allowlisted missions even without an explicit dispatch flag", async () => {
    const w = await seedStaleInProgressSource();
    await addStructuredVerdict(w);
    await db.insert(instanceSettings).values({ singletonKey: "default",
      experimental: { staleSourceIssueWakeupAllowedMissionIdsV1: [w.missionId] } })
      .onConflictDoUpdate({ target: instanceSettings.singletonKey,
        set: { experimental: { staleSourceIssueWakeupAllowedMissionIdsV1: [w.missionId] } } });
    const onStaleSourceIssueWakeupRequested = vi.fn().mockResolvedValue({ wakeupRequestId: "wake-1", runId: "run-1" });
    const svc = missionService(db, { onStaleSourceIssueWakeupRequested });

    const result = await svc.runActiveMissionOwnerSupervision({ companyId: w.companyId,
      staleAfterMinutes: 1, now: new Date("2026-06-02T01:00:00.000Z") });

    expect(onStaleSourceIssueWakeupRequested).toHaveBeenCalledTimes(1);
    const findings = result.missions.find((row) => row.missionId === w.missionId)?.findings ?? [];
    expect(findings).toEqual(expect.arrayContaining([expect.stringContaining("recovery_dispatched")]));
  });
});
