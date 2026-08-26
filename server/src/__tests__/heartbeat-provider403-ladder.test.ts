// server/src/__tests__/heartbeat-provider403-ladder.test.ts
//
// [purpose] provider 403 bounded backoff retry ladder 검증.
//   - 일시적 403(auth/forbidden·quota) 실패 후 기존 재시작 계기가 모두 소진된 지점(앵커)에서
//     PAPERCLIP_PROVIDER_403_RETRY_DELAYS_MIN(기본 5/15/30분) 간격으로 scheduled wakeup 사다리 구성.
//   - 결정적 설정 실패(400 param incorrect 등)·비-403 인증 실패는 사다리에 들어가지 않는다.
//   - 성공 회복 시 사다리 중단 + 기존 자동 정산 경로(closeResolvedWorkflowUnblocks)가 오픈 카드 정리.
//   - 사다리 소진 후 종단 에스컬레이션 payload에 시도 횟수/간격이 구조화로 포함된다.

import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  workflowTransitionEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  PROVIDER_403_LADDER_WAKEUP_REASON,
  reconcileProvider403LadderWakeups,
} from "../services/heartbeat-provider403-ladder.js";
import { resolveProvider403RetryDelaysMin } from "../services/heartbeat-stability.js";
import { emitTerminalMissionHumanOperatorReport } from "../services/missions/terminal-mission-human-operator-alert.js";
import { closeResolvedWorkflowUnblocks } from "../services/workflow/resolved-unblock-closeout.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip provider403 ladder tests: ${support.reason ?? "unsupported"}`);

type Db = ReturnType<typeof createDb>;
const ANCHOR_AT = new Date("2026-08-26T00:00:00.000Z");
const MIN = 60_000;

function at(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * MIN);
}
const DAY = 24 * 60 * MIN;
function nthBase(index: number): Date {
  return new Date(ANCHOR_AT.getTime() + index * DAY);
}

async function seedScenario(
  db: Db,
  opts?: { errorText?: string; agentStatus?: string; stepId?: string; baseAt?: Date },
) {
  const baseAt = opts?.baseAt ?? ANCHOR_AT;
  const companyId = randomUUID();
  const agentId = randomUUID();
  const missionId = randomUUID();
  const issueId = randomUUID();
  const workflowRunId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: "P403Co",
    issuePrefix: `P4${companyId.replaceAll("-", "").slice(0, 5).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "p403-agent",
    role: "engineer",
    status: opts?.agentStatus ?? "active",
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  });
  await db.insert(missions).values({
    id: missionId,
    companyId,
    ownerAgentId: agentId,
    title: "p403 mission",
    status: "active",
  });
  await db.insert(issues).values({
    id: issueId,
    companyId,
    missionId,
    title: "produce report",
    status: "in_progress",
    assigneeAgentId: agentId,
  });
  const anchorRunId = randomUUID();
  await db.insert(heartbeatRuns).values({
    id: anchorRunId,
    companyId,
    agentId,
    issueId,
    invocationSource: "automation",
    triggerDetail: "system",
    status: "failed",
    errorCode: "adapter_failed",
    error: opts?.errorText ?? "provider request failed: HTTP 403 Forbidden from upstream provider",
    stderrExcerpt: opts?.errorText ?? "provider request failed: HTTP 403 Forbidden from upstream provider",
    startedAt: new Date(baseAt.getTime() - 120_000),
    finishedAt: baseAt,
    contextSnapshot: {
      issueId,
      missionId,
      workflowRunId,
      workflowStepId: opts?.stepId ?? "produce",
    },
  });
  return { companyId, agentId, missionId, issueId, workflowRunId, anchorRunId, baseAt };
}

/** 시나리오 종료 후 같은 임베디드 DB를 쓰는 뒤따른 스캔에서 이 회사가 다시 후보가 되지 않게 회복 처리. */
async function recoverScenario(db: Db, seed: { companyId: string; agentId: string; issueId: string; baseAt: Date }, atMinutes = 90) {
  await db.update(issues).set({ status: "done", completedAt: at(seed.baseAt, atMinutes) }).where(eq(issues.id, seed.issueId));
  await db.insert(heartbeatRuns).values({
    id: randomUUID(),
    companyId: seed.companyId,
    agentId: seed.agentId,
    issueId: seed.issueId,
    invocationSource: "automation",
    triggerDetail: "system",
    status: "succeeded",
    startedAt: at(seed.baseAt, atMinutes - 1),
    finishedAt: at(seed.baseAt, atMinutes),
  });
}

async function listLadderWakeups(db: Db, companyId: string) {
  return db.select().from(agentWakeupRequests)
    .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, PROVIDER_403_LADDER_WAKEUP_REASON)))
    .orderBy(asc(agentWakeupRequests.idempotencyKey));
}

describeDb("provider 403 backoff ladder", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("provider403-ladder-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  it("parses delay env: unset=default 5/15/30, empty/0/off=disabled, csv=custom, garbage=disabled", () => {
    expect(resolveProvider403RetryDelaysMin({} as NodeJS.ProcessEnv)).toEqual([5, 15, 30]);
    expect(resolveProvider403RetryDelaysMin({ PAPERCLIP_PROVIDER_403_RETRY_DELAYS_MIN: "" } as NodeJS.ProcessEnv)).toEqual([]);
    expect(resolveProvider403RetryDelaysMin({ PAPERCLIP_PROVIDER_403_RETRY_DELAYS_MIN: "0" } as NodeJS.ProcessEnv)).toEqual([]);
    expect(resolveProvider403RetryDelaysMin({ PAPERCLIP_PROVIDER_403_RETRY_DELAYS_MIN: "off" } as NodeJS.ProcessEnv)).toEqual([]);
    expect(resolveProvider403RetryDelaysMin({ PAPERCLIP_PROVIDER_403_RETRY_DELAYS_MIN: "2, 7" } as NodeJS.ProcessEnv)).toEqual([2, 7]);
    expect(resolveProvider403RetryDelaysMin({ PAPERCLIP_PROVIDER_403_RETRY_DELAYS_MIN: "abc" } as NodeJS.ProcessEnv)).toEqual([]);
  });

  it("does not schedule before the first delay elapses", async () => {
    const seed = await seedScenario(db, { baseAt: nthBase(1) });
    const result = await reconcileProvider403LadderWakeups(db, { now: at(seed.baseAt, 4) });
    expect(result.scheduled).toBe(0);
    expect(await listLadderWakeups(db, seed.companyId)).toHaveLength(0);
  });

  it("schedules the first rung at the due time with structured payload, idempotent key, and activity", async () => {
    const seed = await seedScenario(db, { baseAt: nthBase(2) });
    const result = await reconcileProvider403LadderWakeups(db, { now: new Date(at(seed.baseAt, 5).getTime() + 1000) });
    expect(result.scheduled).toBe(1);
    const wakeups = await listLadderWakeups(db, seed.companyId);
    expect(wakeups).toHaveLength(1);
    const wakeup = wakeups[0]!;
    expect(wakeup.status).toBe("queued");
    expect(wakeup.issueId).toBe(seed.issueId);
    expect(wakeup.missionId).toBe(seed.missionId);
    expect(wakeup.idempotencyKey).toMatch(/provider403-ladder:.+:0$/);
    const payload = wakeup.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      attempt: 1,
      totalAttempts: 3,
      delaysMin: [5, 15, 30],
      anchorRunId: seed.anchorRunId,
    });
    const activities = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, seed.companyId),
      eq(activityLog.action, "heartbeat.provider_403_retry_scheduled"),
    ));
    expect(activities).toHaveLength(1);
    expect(activities[0]?.entityId).toBe(seed.issueId);

    // duplicate scheduling (sequential + concurrent) stays idempotent
    await reconcileProvider403LadderWakeups(db, { now: new Date(at(seed.baseAt, 5).getTime() + 2000) });
    await Promise.all([
      reconcileProvider403LadderWakeups(db, { now: new Date(at(seed.baseAt, 5).getTime() + 3000) }),
      reconcileProvider403LadderWakeups(db, { now: new Date(at(seed.baseAt, 5).getTime() + 3000) }),
    ]);
    expect(await listLadderWakeups(db, seed.companyId)).toHaveLength(1);
    await recoverScenario(db, seed);
  });

  it("advances 5/15/30 from a stable anchor and stops after exhaustion", async () => {
    const seed = await seedScenario(db, { stepId: "ladder-progress", baseAt: nthBase(3) });
    // rung 1 consumed (ran and failed): wakeup completed + a later qualifying failure exists.
    await db.insert(agentWakeupRequests).values({
      companyId: seed.companyId,
      agentId: seed.agentId,
      source: "automation",
      triggerDetail: "system",
      reason: PROVIDER_403_LADDER_WAKEUP_REASON,
      requestKind: PROVIDER_403_LADDER_WAKEUP_REASON,
      status: "completed",
      requestedByActorType: "system",
      requestedByActorId: null,
      idempotencyKey: `provider403-ladder:${seed.issueId}:ladder-progress:0`,
      issueId: seed.issueId,
      missionId: seed.missionId,
      payload: { attempt: 1, totalAttempts: 3, delaysMin: [5, 15, 30], anchorRunId: seed.anchorRunId, anchorFinishedAt: seed.baseAt.toISOString() },
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: seed.companyId,
      agentId: seed.agentId,
      issueId: seed.issueId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "failed",
      errorCode: "adapter_failed",
      error: "provider request failed: HTTP 403 Forbidden from upstream provider",
      stderrExcerpt: "provider request failed: HTTP 403 Forbidden from upstream provider",
      startedAt: at(seed.baseAt, 6),
      finishedAt: new Date(at(seed.baseAt, 6).getTime() + 30_000),
      contextSnapshot: { issueId: seed.issueId, missionId: seed.missionId, workflowRunId: seed.workflowRunId, workflowStepId: "ladder-progress" },
    });

    // not yet due for rung 2 (anchor+15m)
    const early = await reconcileProvider403LadderWakeups(db, { now: at(seed.baseAt, 14) });
    expect(early.scheduled).toBe(0);

    const due = await reconcileProvider403LadderWakeups(db, { now: new Date(at(seed.baseAt, 15).getTime() + 1000) });
    expect(due.scheduled).toBe(1);
    let wakeups = await listLadderWakeups(db, seed.companyId);
    expect(wakeups).toHaveLength(2);
    expect((wakeups[1]!.payload as Record<string, unknown>).attempt).toBe(2);

    // rung 2 consumed: mark the scanner-created rung as completed (no duplicate insert).
    await db.update(agentWakeupRequests)
      .set({ status: "completed" })
      .where(eq(agentWakeupRequests.id, wakeups[1]!.id));
    const third = await reconcileProvider403LadderWakeups(db, { now: new Date(at(seed.baseAt, 30).getTime() + 1000) });
    expect(third.scheduled).toBe(1);
    wakeups = await listLadderWakeups(db, seed.companyId);
    expect(wakeups).toHaveLength(3);
    expect((wakeups[2]!.payload as Record<string, unknown>).attempt).toBe(3);

    // exhausted: no fourth rung ever
    const exhausted = await reconcileProvider403LadderWakeups(db, { now: at(seed.baseAt, 60) });
    expect(exhausted.scheduled).toBe(0);
    expect(await listLadderWakeups(db, seed.companyId)).toHaveLength(3);
    await recoverScenario(db, seed);
  });

  it("stops scheduling once the issue recovered and settles an open escalation card via the existing closeout path", async () => {
    const seed = await seedScenario(db, { baseAt: nthBase(4) });
    // open owner-action card pointing at the source issue (today's stale-card shape)
    const [card] = await db.insert(issues).values({
      companyId: seed.companyId,
      missionId: seed.missionId,
      parentId: seed.issueId,
      title: "[UNBLOCK] produce report",
      status: "todo",
      assigneeAgentId: seed.agentId,
      originKind: "mission_main_executor_unblock",
      originId: seed.issueId,
    }).returning({ id: issues.id });

    // recovery: ladder attempt succeeded → succeeded run + source done + completed workflow run
    await db.update(issues).set({ status: "done", completedAt: at(seed.baseAt, 20) }).where(eq(issues.id, seed.issueId));
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: seed.companyId,
      agentId: seed.agentId,
      issueId: seed.issueId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "succeeded",
      startedAt: at(seed.baseAt, 19),
      finishedAt: at(seed.baseAt, 20),
    });
    const result = await reconcileProvider403LadderWakeups(db, { now: at(seed.baseAt, 21) });
    expect(result.scheduled).toBe(0);
    expect(await listLadderWakeups(db, seed.companyId)).toHaveLength(0);

    // existing completion path settles the stale card (no special-casing)
    await closeResolvedWorkflowUnblocks({
      db,
      run: { id: seed.workflowRunId, status: "completed", companyId: seed.companyId, missionId: seed.missionId },
      stepRuns: [{ workflowRunId: seed.workflowRunId, issueId: seed.issueId }],
    });
    const [cardAfter] = await db.select().from(issues).where(eq(issues.id, card!.id));
    expect(cardAfter?.status).toBe("done");
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, card!.id));
    expect(comments.some((comment) => comment.body.includes("Resolved automatically"))).toBe(true);
  });

  it("ignores deterministic provider/model configuration failures", async () => {
    const seed = await seedScenario(db, {
      errorText: "API error: 400 - param incorrect: model `gpt-x` is not supported",
      baseAt: nthBase(5),
    });
    const result = await reconcileProvider403LadderWakeups(db, { now: at(seed.baseAt, 10) });
    expect(result.scheduled).toBe(0);
    expect(await listLadderWakeups(db, seed.companyId)).toHaveLength(0);
    await recoverScenario(db, seed);
  });

  it("ignores non-403 auth failures (permanent misconfiguration)", async () => {
    const seed = await seedScenario(db, {
      errorText: "authentication failed: invalid api key provided",
      baseAt: nthBase(6),
    });
    const result = await reconcileProvider403LadderWakeups(db, { now: at(seed.baseAt, 10) });
    expect(result.scheduled).toBe(0);
    expect(await listLadderWakeups(db, seed.companyId)).toHaveLength(0);
    await recoverScenario(db, seed);
  });

  it("is disabled when the delay env is empty", async () => {
    const seed = await seedScenario(db, { baseAt: nthBase(7) });
    const result = await reconcileProvider403LadderWakeups(db, {
      now: at(seed.baseAt, 30),
      env: { PAPERCLIP_PROVIDER_403_RETRY_DELAYS_MIN: "" } as NodeJS.ProcessEnv,
    });
    expect(result.scheduled).toBe(0);
    expect(await listLadderWakeups(db, seed.companyId)).toHaveLength(0);
  });

  it("honors custom delays from env", async () => {
    const seed = await seedScenario(db, { stepId: "custom-delays", baseAt: nthBase(8) });
    const early = await reconcileProvider403LadderWakeups(db, { now: new Date(at(seed.baseAt, 1).getTime() - 1000), env: { PAPERCLIP_PROVIDER_403_RETRY_DELAYS_MIN: "1,2" } as NodeJS.ProcessEnv });
    expect(early.scheduled).toBe(0);
    const due = await reconcileProvider403LadderWakeups(db, { now: new Date(at(seed.baseAt, 1).getTime() + 1000), env: { PAPERCLIP_PROVIDER_403_RETRY_DELAYS_MIN: "1,2" } as NodeJS.ProcessEnv });
    expect(due.scheduled).toBe(1);
    const wakeups = await listLadderWakeups(db, seed.companyId);
    expect((wakeups[0]!.payload as Record<string, unknown>)).toMatchObject({ totalAttempts: 2, delaysMin: [1, 2] });
    await recoverScenario(db, seed);
  });

  it("terminal escalation carries the ladder attempts structurally and derives display text from it", async () => {
    const seed = await seedScenario(db, { baseAt: nthBase(9) });
    const [card] = await db.insert(issues).values({
      companyId: seed.companyId,
      missionId: seed.missionId,
      parentId: seed.issueId,
      title: "[UNBLOCK] exhausted",
      status: "todo",
      assigneeAgentId: seed.agentId,
      originKind: "mission_main_executor_unblock",
      originId: seed.issueId,
    }).returning({ id: issues.id });

    const emitted = await emitTerminalMissionHumanOperatorReport(db, {
      expectedCompanyId: seed.companyId,
      expectedMissionId: seed.missionId,
      issue: {
        id: card!.id,
        companyId: seed.companyId,
        missionId: seed.missionId,
        originKind: "mission_main_executor_unblock",
        originId: seed.issueId,
        title: "[UNBLOCK] exhausted",
        identifier: null,
      },
      missionTitle: "p403 mission",
      sourceIssueIdentifier: null,
      workflowRunId: seed.workflowRunId,
      failedRuns: [{ id: seed.anchorRunId, status: "failed", errorCode: "adapter_failed" }],
      retryAttempts: null,
      retryMaxRetries: null,
      provider403Ladder: { attempts: 3, delaysMin: [5, 15, 30] },
    });
    expect(emitted.emitted).toBe(true);

    const events = await db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, seed.companyId),
      eq(workflowTransitionEvents.eventType, "terminal_mission_human_operator_report"),
    ));
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as Record<string, unknown>).provider403Ladder).toEqual({ attempts: 3, delaysMin: [5, 15, 30] });
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, card!.id));
    expect(comments[0]?.body).toContain("provider403-retries=3/5/15/30");
  });
});
