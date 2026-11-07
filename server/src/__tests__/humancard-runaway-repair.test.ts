// [휴먼카드 남발 수리 2026-11-08] R1~R4 회귀 시험.
// 각 케이스는 수정 전(2bb51042 WIP 상태) 실패 / 수정 후 통과를 검증한다:
//   R1 시스템 갱신 카드 억제(자동 복구 원인), R1 에이전트 제출 거부(422),
//   R2 미션 단위 열린 카드 1장 병합, R3 종료 미션 카드 회수(전이 시·주기 스윕) + 앵커 종결 카드 생존/해결,
//   R4 카드 대기 중 stale-source 자동 wakeup 보류.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, missions,
  operatorDecisions, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { missionService, type MissionServiceDeps } from "../services/missions.js";
import { createOwnerActions } from "../services/missions/owner-actions.js";
import { submitMissionOwnerDecision } from "../services/missions/mission-owner-recovery-agent-api.js";
import { operatorDecisionWriteService } from "../services/operator-decisions-write.js";
vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
const submission = { decision: "request_input" as const, reason: "원작성 요청",
  nextAction: "사람 확인", evidence: "원작성 근거" };

describeDb("human card runaway repair (R1–R4)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("humancard-runaway-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 5 }); await database?.cleanup();
  });

  async function world(human = true, legacy = false, terminal = true, sourceStatus = "blocked", requestKey = randomUUID()) {
    const companyId = randomUUID(), missionId = randomUUID(), agentId = randomUUID(),
      sourceId = randomUUID(), oldId = randomUUID(), heartbeatId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Runaway repair", issuePrefix: randomUUID(),
      requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner", status: "active" });
    const [mission] = await db.insert(missions).values({ id: missionId, companyId,
      ownerAgentId: agentId, title: "Runaway repair mission", status: "active" }).returning();
    const [source] = await db.insert(issues).values({ id: sourceId, companyId, missionId,
      title: "Source", status: sourceStatus }).returning();
    await db.insert(issues).values({ id: oldId, companyId, missionId, title: "Old anchor", status: "todo",
      assigneeAgentId: agentId, originKind: "mission_main_executor_unblock", originId: sourceId });
    await db.insert(heartbeatRuns).values({ id: heartbeatId, companyId, agentId, issueId: oldId, status: "running" });
    await issueService(db).checkout(oldId, agentId, ["todo"], heartbeatId);
    const actor = { actorType: "agent" as const, actorId: agentId, agentId, runId: heartbeatId };
    if (human) await submitMissionOwnerDecision({ db, issueId: oldId, actor, data: {
      ...submission, ...(legacy ? {} : { humanRequest: { schemaVersion: 1 as const,
        requestKey, expectedCurrentLifetimeId: null } }),
    } });
    if (terminal) await issueService(db).update(oldId, { status: "cancelled" });
    return { companyId, missionId, agentId, sourceId, oldId, heartbeatId, mission: mission!, source: source!, actor };
  }
  type World = Awaited<ReturnType<typeof world>>;
  const produce = (w: World, deps: MissionServiceDeps = {}) =>
    createOwnerActions({ db, deps }).ensureMainExecutorUnblockIssue(w.mission, w.source);
  const cards = async (w: World) => db.select().from(operatorDecisions).where(
    eq(operatorDecisions.companyId, w.companyId)).orderBy(operatorDecisions.createdAt);
  const resolveCard = async (w: World) => {
    const [pending] = (await cards(w)).filter((row) => row.status === "pending");
    if (pending) await operatorDecisionWriteService(db).resolve(pending.id,
      { actionId: "approve", selectedOptionIds: ["approve"], comment: "승인" }, "board");
  };
  // 원천 이슈에 terminal 실패 런을 심는다 — 자동 복구 분류(R1)의 직접 원인.
  const seedSourceRun = (w: World, run: { errorCode: string | null; settled: boolean; status?: string }) =>
    db.insert(heartbeatRuns).values({ id: randomUUID(), companyId: w.companyId, agentId: w.agentId,
      issueId: w.sourceId, status: run.status ?? "failed", errorCode: run.errorCode,
      error: run.errorCode ? `simulated ${run.errorCode}` : null,
      settledAt: run.settled ? new Date() : null,
      startedAt: new Date(), finishedAt: new Date() }).returning();
  const answeredWorld = async () => {
    const w = await world(true, false, false);
    await resolveCard(w);
    await issueService(db).update(w.oldId, { status: "cancelled" });
    return w;
  };

  // ── R1: 자동 복구 가능 원인에는 시스템 갱신 카드를 발행하지 않는다 ──────────────────
  it("R1a: suppresses the renewal human card when the source failure is auto-recoverable (429 adapter_failed, unsettled)", async () => {
    const w = await answeredWorld();
    await seedSourceRun(w, { errorCode: "adapter_failed", settled: false }); // 429 파도와 동일 분류
    const beforeCards = (await cards(w)).length;
    const beforeAnchors = (await db.select({ id: issues.id }).from(issues).where(and(
      eq(issues.companyId, w.companyId), eq(issues.originKind, "mission_main_executor_unblock")))).length;
    const anchor = await produce(w);
    // 앵커(오너 작업 표면)는 여전히 만들 수 있지만 —
    expect((await db.select({ id: issues.id }).from(issues).where(and(
      eq(issues.companyId, w.companyId), eq(issues.originKind, "mission_main_executor_unblock")))).length)
      .toBe(beforeAnchors + 1);
    expect(anchor.id).not.toBe(w.oldId);
    // 사람 결정 카드는 새로 발행되지 않는다(수정 전: 갱신마다 +1 — 남발의 직접 경로).
    expect((await cards(w))).toHaveLength(beforeCards);
  });

  it("R1a: suppresses the renewal human card while settlement is still pending (errorCode null, settledAt null)", async () => {
    const w = await answeredWorld();
    await seedSourceRun(w, { errorCode: null, settled: false, status: "cancelled" });
    const beforeCards = (await cards(w)).length;
    await produce(w);
    expect((await cards(w))).toHaveLength(beforeCards);
  });

  it("R1a control: still renews the human card for a non-auto-recoverable settled failure", async () => {
    const w = await answeredWorld();
    await seedSourceRun(w, { errorCode: "commandcode_permission_denied", settled: true });
    const beforeCards = (await cards(w)).length;
    await produce(w);
    // 사람이 판단해야 하는 원인은 기존대로 카드를 발행한다(위축 금지).
    expect((await cards(w))).toHaveLength(beforeCards + 1);
  });

  it("R1b: rejects an agent escalate/request_input submission for an auto-recoverable source failure with 422", async () => {
    const w = await world(false, false, false); // 열린 앵커, 제출 없음
    await seedSourceRun(w, { errorCode: "issue_status_blocked", settled: false });
    await expect(submitMissionOwnerDecision({ db, issueId: w.oldId, actor: w.actor, data: {
      decision: "escalate", reason: "429 로 막혔다고 판단", evidence: "run error",
    } })).rejects.toMatchObject({ status: 422,
      details: expect.objectContaining({ code: "mission_owner_human_input_auto_recoverable" }) });
    expect((await cards(w)).filter((row) => row.status === "pending")).toHaveLength(0);
  });

  it("R1b control: accepts an escalation when the failure is not auto-recoverable", async () => {
    const w = await world(false, false, false);
    await seedSourceRun(w, { errorCode: "commandcode_permission_denied", settled: true });
    await submitMissionOwnerDecision({ db, issueId: w.oldId, actor: w.actor, data: {
      decision: "escalate", reason: "권한 거부로 진행 불가", evidence: "permission denied",
    } });
    expect((await cards(w)).filter((row) => row.status === "pending")).toHaveLength(1);
  });

  // ── R2: 같은 미션에 열린 사람 카드가 있으면 새 카드 대신 기존 카드에 사유를 붙인다 ──
  it("R2: a repeat human request while the mission's card is pending is rejected and folds into the existing card", async () => {
    const w = await world(true, false, false); // moi2 pending 카드(keyed lifetime)
    const [existing] = (await cards(w)).filter((row) => row.status === "pending");
    expect(existing).toBeTruthy();
    // 새 요청 키로 같은 미션에 재요청 — 수정 전에는 두 번째 lifetime+카드가 발행됐다.
    await expect(submitMissionOwnerDecision({ db, issueId: w.oldId, actor: w.actor, data: {
      ...submission, reason: "같은 미션 반복 요청",
      humanRequest: { schemaVersion: 1 as const, requestKey: randomUUID(), expectedCurrentLifetimeId: null },
    } })).rejects.toMatchObject({ status: 422,
      details: expect.objectContaining({ code: "mission_owner_human_input_card_pending" }) });
    expect((await cards(w))).toHaveLength(1); // 카드는 1장 그대로
    const [after] = (await cards(w)).filter((row) => row.id === existing!.id);
    expect(after?.sourceContext?.missionOwnerHumanInput?.repeatCount).toBe(1); // 기존 카드에 사유 누적
  });

  it("R2: an exact replay of the current request still passes the pending-card gate (idempotent resubmission)", async () => {
    const requestKey = randomUUID();
    const w = await world(true, false, false, "blocked", requestKey);
    const first = await submitMissionOwnerDecision({ db, issueId: w.oldId, actor: w.actor, data: {
      ...submission, humanRequest: { schemaVersion: 1 as const, requestKey, expectedCurrentLifetimeId: null },
    } });
    expect((await cards(w)).filter((row) => row.status === "pending")).toHaveLength(1);
    const replay = await submitMissionOwnerDecision({ db, issueId: w.oldId, actor: w.actor, data: {
      ...submission, humanRequest: { schemaVersion: 1 as const, requestKey,
        expectedCurrentLifetimeId: first.lifetimeId ?? null },
    } });
    expect(replay.lifetimeId).toBe(first.lifetimeId); // 게이트가 재전송을 막지 않는다
    expect((await cards(w))).toHaveLength(1);
  });

  it("R2: renewal is deferred while any pending human card exists for the mission (cross-lifetime)", async () => {
    const w = await world(true, false, false); // moi2 pending 카드, 열린 앵커
    const [pending] = (await cards(w)).filter((row) => row.status === "pending");
    expect(pending).toBeTruthy();
    const anchor = await produce(w);
    expect(anchor.id).toBe(w.oldId); // 갱신 없이 현재 앵커 재사용
    expect((await cards(w)).filter((row) => row.status === "pending")).toHaveLength(1);
  });

  // ── R3: 취소·완료 미션의 카드는 자동으로 닫힌다(전이 시 + 주기 스윕) ────────────────
  it("R3: mission completion now withdraws the pending human card at the terminal fence", async () => {
    const w = await world(true, false, false);
    const [pending] = (await cards(w)).filter((row) => row.status === "pending");
    expect(pending).toBeTruthy(); // 수정 전: completed 전이는 카드를 회수하지 않았다(11-02 라이브 방치 사례)
    await missionService(db).update(w.missionId, { status: "completed" });
    const [after] = (await cards(w)).filter((row) => row.id === pending!.id);
    expect(after?.status).toBe("cancelled");
    expect(after?.cancelledAt).not.toBeNull();
  });

  it("R3: mission cancellation still withdraws the pending human card", async () => {
    const w = await world(true, false, false);
    const [pending] = (await cards(w)).filter((row) => row.status === "pending");
    await missionService(db).update(w.missionId, { status: "cancelled" });
    const [after] = (await cards(w)).filter((row) => row.id === pending!.id);
    expect(after?.status).toBe("cancelled");
  });

  it("R3 periodic: the stale sweep closes leftover cards on already-terminal missions (completed too)", async () => {
    const w = await world(true, false, false);
    const [pending] = (await cards(w)).filter((row) => row.status === "pending");
    // 전이 정리를 거치지 못한 채(크래시 창) 이미 종료된 미션을 흉내 낸다.
    await db.update(missions).set({ status: "completed", completedAt: new Date() })
      .where(eq(missions.id, w.missionId));
    await operatorDecisionWriteService(db).sweepStalePendingCards(new Date());
    const [after] = (await cards(w)).filter((row) => row.id === pending!.id);
    expect(after?.status).toBe("cancelled");
  });

  it("R3 runaway engine: the sweep no longer cancels a pending card just because its anchor issue closed while the mission lives", async () => {
    const w = await world(true, false, true); // 카드 pending, 앵커 cancelled, 미션 active
    const [pending] = (await cards(w)).filter((row) => row.status === "pending");
    expect(pending).toBeTruthy();
    await operatorDecisionWriteService(db).sweepStalePendingCards(new Date());
    const [after] = (await cards(w)).filter((row) => row.id === pending!.id);
    // 수정 전: 앵커 종결 → 즉시 취소 → 5분 tick 재발행 루프(40장 남발의 엔진).
    expect(after?.status).toBe("pending");
  });

  it("R3 runaway engine: a human can still resolve the pending card after its anchor closed (no 409 target_changed)", async () => {
    const w = await world(true, false, true); // 앵커 종결 상태에서도 사람이 답할 수 있어야 한다
    const [pending] = (await cards(w)).filter((row) => row.status === "pending");
    expect(pending).toBeTruthy();
    await operatorDecisionWriteService(db).resolve(pending!.id,
      { actionId: "approve", selectedOptionIds: ["approve"], comment: "앵커 종결 후 응답" }, "board");
    const [after] = (await cards(w)).filter((row) => row.id === pending!.id);
    expect(after?.status).toBe("resolved");
  });

  // ── R4: 카드 대기 중에는 오너 자동 회수 wakeup을 보류한다(이중 경로 금지) ───────────
  it("R4: defers the stale-source auto wakeup while the mission holds a pending human decision card", async () => {
    const companyId = randomUUID(), ownerAgentId = randomUUID(), workerAgentId = randomUUID(),
      missionId = randomUUID(), sourceId = randomUUID(), anchorId = randomUUID(), failedRunId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "R4 defer", issuePrefix: randomUUID(),
      requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active",
        adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active",
        adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId,
      title: "R4 defer mission", status: "active" });
    const staleAt = new Date("2026-06-02T00:00:00.000Z");
    await db.insert(issues).values({ id: sourceId, companyId, missionId, title: "R4 source",
      status: "in_progress", assigneeAgentId: workerAgentId, originKind: "workflow_execution",
      createdAt: staleAt, updatedAt: staleAt });
    await db.insert(issues).values({ id: anchorId, companyId, missionId, title: "R4 anchor",
      status: "todo", assigneeAgentId: ownerAgentId, originKind: "mission_main_executor_unblock",
      originId: sourceId, createdAt: staleAt, updatedAt: staleAt });
    await db.insert(heartbeatRuns).values({ id: failedRunId, companyId, agentId: workerAgentId,
      issueId: sourceId, status: "failed", errorCode: "process_lost", error: "crash",
      settledAt: new Date(), startedAt: new Date("2026-06-02T00:01:00.000Z"),
      finishedAt: new Date("2026-06-02T00:02:00.000Z") });
    // 미션에 pending 사람 결정 카드 1장(앵커 이슈에 연결).
    await db.insert(operatorDecisions).values({ companyId, requestKey: `moi1:${randomUUID()}`,
      requestHash: "r4", interactionType: "single_select", priority: "high",
      title: "사람 결정 승인 요청 — 입력·승인 요청(request_input)", description: "r4",
      sourceType: "mission_owner_human_input", sourceId: randomUUID(),
      sourceContext: { missionId, targetSnapshot: { issueId: anchorId, issueStatus: "todo" } },
      issueId: anchorId, status: "pending",
      definition: { options: [], actions: [], selection: null,
        comment: { mode: "disabled", label: null, placeholder: null, maxLength: 0 },
        approvedScope: [], forbiddenScope: [] } });
    const onStaleSourceIssueWakeupRequested = vi.fn();
    const svc = missionService(db, { onStaleSourceIssueWakeupRequested });
    await svc.ensureMissionExecutionPlan({ companyId, missionId, sourceHints: { workflowName: "R4 Defer Workflow" } });
    const result = await svc.runActiveMissionOwnerSupervision({ companyId, staleAfterMinutes: 1,
      dispatchStaleSourceIssueWakeups: true, now: new Date("2026-06-02T00:10:00.000Z") });
    const findings = result.missions.find((row) => row.missionId === missionId)?.findings ?? [];
    // 수정 전: 카드가 있어도 wakeup 판정이 진행됐다(requires_diagnosis) — 이중 경로.
    expect(findings).toEqual(expect.arrayContaining([
      expect.stringContaining("stale_source_wakeup_deferred_human_card_pending"),
    ]));
    expect(onStaleSourceIssueWakeupRequested).not.toHaveBeenCalled();
  });
});
