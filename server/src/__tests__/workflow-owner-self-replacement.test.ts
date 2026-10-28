// [목적] 오너 자기 미션 실패 런에 대한 교정 메타데이터 replacement 자가 제안+승인
//   (ownerSelfReplacement) 서비스·라우트 계약 검증. 보드 경로(propose/approve)와의
//   분리 — agent actor 는 보드 경로를 통과할 수 없고, 오너 자가 승인은 기존
//   admitReplacement 경로로만 입장(admission)한다.
// [연결] services/workflow/owner-self-replacement.ts, routes/workflow-agent-api.ts,
//   services/workflow/replacement-admission.ts (ownerAgentSelfApproval 승인 수용).
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  approvals,
  createDb,
  heartbeatRuns,
  issues,
  missions,
  workflowRecoveryAuthorities,
  workflowRuns,
  workflowStepRuns,
  workflowTerminalDecisions,
  type Db,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedToolRecoveryScenario } from "./helpers/tool-recovery-scenario.js";
import { recordMissionOwnerDecision } from "../services/missions/mission-owner-recovery-ledger.js";
import { ownerSelfReplacement } from "../services/workflow/owner-self-replacement.js";
import { admitReplacement } from "../services/workflow/replacement-admission.js";
import { proposeReplacement } from "../services/workflow/replacement-approval.js";
import { workflowAgentApiRoutes } from "../routes/workflow-agent-api.js";
import { errorHandler } from "../middleware/index.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
const roots: string[] = [];
beforeAll(async () => {
  temp = await startEmbeddedPostgresTestDatabase("owner-self-replacement-");
  db = createDb(temp.connectionString);
}, 60_000);
afterAll(async () => {
  await db.$client.end();
  await temp.cleanup();
  roots.forEach((r) => rmSync(r, { recursive: true, force: true }));
});

type Scenario = Awaited<ReturnType<typeof seedScenario>>;
async function seedScenario() {
  const s = await seedToolRecoveryScenario({ db, artifactExists: false });
  roots.push(s.tempRoot);
  const heartbeatId = randomUUID();
  await db.insert(heartbeatRuns).values({ id: heartbeatId, companyId: s.companyId, agentId: s.ownerAgentId,
    issueId: s.recoveryIssueId, invocationSource: "manual", status: "running" });
  // 오너 액션 이슈는 체크아웃 상태(in_progress + checkoutRunId)여야 결정 API 체인과 동일하게 인가된다.
  await db.update(issues).set({ status: "in_progress", checkoutRunId: heartbeatId })
    .where(eq(issues.id, s.recoveryIssueId));
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, s.workflowRunId));
  await db.insert(workflowTerminalDecisions).values({ companyId: s.companyId, workflowRunId: run.id,
    decidedAuthorityVersion: 0, decision: "failed", policyCause: "recovery_deadline_hard",
    discoveryPath: "stuck_diagnostic", origin: "reconciler", reason: "test", recoveryGate: {} });
  const owner = await recordMissionOwnerDecision({ db, issue: { id: s.recoveryIssueId, companyId: s.companyId, missionId: s.missionId },
    heartbeatRunId: heartbeatId, submission: { decision: "restart_from_start", recoveryTarget: { kind: "tool_step",
      workflowRunId: run.id, stepRunId: s.stepRunId, expectedAuthorityVersion: 0, expectedExecutionGeneration: 0,
      failedDispatchRequestId: null } } });
  const actor = { actorType: "agent" as const, actorId: s.ownerAgentId, agentId: s.ownerAgentId, runId: heartbeatId };
  return {
    ...s, run, heartbeatId, decisionEventId: owner.eventId, actor,
    triggerActor: { type: "agent" as const, agentId: s.ownerAgentId, companyId: s.companyId },
    request: (over: Record<string, unknown> = {}) => ({ sourceRunId: run.id, decisionEventId: owner.eventId,
      idempotencyKey: "owner-self-1", metadata: {}, ...over }),
    admissionInput: (approvalId: string, key = "owner-self-1", metadata: Record<string, unknown> = {}) => ({ workflowId: run.workflowId,
      companyId: s.companyId, missionId: s.missionId, triggeredBy: "agent", metadata,
      replacementIntent: { schemaVersion: 1 as const, sourceRunId: run.id, expectedSourceAuthorityVersion: 0,
        decisionEventId: owner.eventId, approvalId, idempotencyKey: key } }),
  };
}

describe("owner self-approved replacement (isolated PostgreSQL)", () => {
  it("atomically records approval and admits the replacement run", async () => {
    const s = await seedScenario();
    const result = await ownerSelfReplacement(db, { issueId: s.recoveryIssueId, actor: s.actor,
      request: s.request({ metadata: { url: "https://example.com/feed" }, reason: "missing url scheme" }) });
    expect(result.replay).toBe(false);
    expect(result.approval).toMatchObject({ type: "workflow_replacement", status: "approved",
      requestedByAgentId: s.ownerAgentId, requestedByUserId: null, decidedByUserId: null });
    const payload = result.approval.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ ownerAgentSelfApproval: true, externalEffects: "owner_agent_reconciled",
      decisionEventId: s.decisionEventId, sourceRunId: s.run.id, metadata: { url: "https://example.com/feed" } });
    expect(result.approval.decisionNote).toContain(`owner-agent:${s.ownerAgentId}`);
    const [activity] = await db.select().from(activityLog)
      .where(and(eq(activityLog.companyId, s.companyId), eq(activityLog.action, "workflow.replacement_owner_approved")));
    expect(activity).toMatchObject({ actorType: "agent", actorId: s.ownerAgentId, entityType: "approval",
      entityId: result.approval.id });
    // 자가 승인 경로는 보드의 proposed 단계를 남기지 않는다.
    expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, s.companyId),
      eq(activityLog.action, "workflow.replacement_proposed")))).toHaveLength(0);
    const [target] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, result.targetRunId));
    expect(target).toMatchObject({ id: result.targetRunId, missionId: s.missionId, status: "pending" });
    const [authority] = await db.select().from(workflowRecoveryAuthorities)
      .where(eq(workflowRecoveryAuthorities.companyId, s.companyId));
    expect(authority).toMatchObject({ replacementRunId: result.targetRunId, status: "consumed",
      operatorApprovalId: result.approval.id });
    expect(await admitReplacement(db, s.admissionInput(result.approval.id, "owner-self-1",
      { url: "https://example.com/feed" }), s.triggerActor))
      .toMatchObject({ replay: true, run: { id: result.targetRunId } });
  });

  it("rejects non-owner agents, non-unblock issues, and cross-company route access", async () => {
    const s = await seedScenario();
    // 다른 에이전트는 미션 오너가 아니므로 결정 API 체인과 동일하게 거부.
    await expect(ownerSelfReplacement(db, { issueId: s.recoveryIssueId,
      actor: { actorType: "agent", actorId: "other", agentId: randomUUID(), runId: s.heartbeatId },
      request: s.request() })).rejects.toThrow("Only the mission owner agent may submit owner-recovery decisions");
    // 오버사이트 이슈는 오너 recovery replacement 경로로 쓸 수 없다.
    await expect(ownerSelfReplacement(db, { issueId: s.oversightIssueId, actor: s.actor, request: s.request() }))
      .rejects.toThrow("Owner-recovery replacement API can only be used for mission-owner unblock issues");
    expect(await db.select().from(approvals).where(eq(approvals.companyId, s.companyId))).toHaveLength(0);
    const app = (actor: Express.Request["actor"]) => {
      const a = express();
      a.use(express.json());
      a.use((req, _res, next) => { req.actor = actor; next(); });
      a.use("/api", workflowAgentApiRoutes(db));
      a.use(errorHandler);
      return a;
    };
    const agentActor = { type: "agent" as const, agentId: s.ownerAgentId, runId: s.heartbeatId, companyId: s.companyId };
    const ok = await request(app(agentActor)).post(`/api/issues/${s.recoveryIssueId}/owner-recovery/replacement`)
      .send(s.request({ idempotencyKey: "route-1" }));
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ status: "approved", replay: false, approvalId: expect.any(String), targetRunId: expect.any(String) });
    expect(await db.select().from(workflowRuns).where(eq(workflowRuns.id, ok.body.targetRunId))).toHaveLength(1);
    expect(await db.select().from(workflowRecoveryAuthorities)
      .where(eq(workflowRecoveryAuthorities.replacementRunId, ok.body.targetRunId))).toHaveLength(1);
    // 스키마 위반(400), 타 company 키(403), 보드 사용자(403 — 사람 경로 유지).
    expect((await request(app(agentActor)).post(`/api/issues/${s.recoveryIssueId}/owner-recovery/replacement`)
      .send({ sourceRunId: "not-a-uuid", decisionEventId: s.decisionEventId, idempotencyKey: "route-2" })).status).toBe(400);
    expect((await request(app({ ...agentActor, companyId: randomUUID() }))
      .post(`/api/issues/${s.recoveryIssueId}/owner-recovery/replacement`).send(s.request({ idempotencyKey: "route-3" }))).status).toBe(403);
    expect((await request(app({ type: "board" as const, source: "session" as const, userId: "human" }))
      .post(`/api/issues/${s.recoveryIssueId}/owner-recovery/replacement`).send(s.request({ idempotencyKey: "route-4" }))).status).toBe(403);
  });

  it("rejects a source run from another mission even with a valid decision event for it", async () => {
    const s = await seedScenario();
    // 같은 오너의 다른 미션 + 실패 런 + 그 미션의 유효한 restart 결정 이벤트를 만든다.
    const otherMissionId = randomUUID();
    const otherRunId = randomUUID(), otherStepRunId = randomUUID();
    await db.insert(missions).values({ id: otherMissionId, companyId: s.companyId, ownerAgentId: s.ownerAgentId,
      title: "Other mission", status: "active" });
    await db.insert(workflowRuns).values({ id: otherRunId, workflowId: s.run.workflowId, companyId: s.companyId,
      missionId: otherMissionId, triggeredBy: "test", status: "failed" });
    await db.insert(workflowStepRuns).values({ id: otherStepRunId, workflowRunId: otherRunId,
      stepId: "collect-us-stockflow", status: "failed" });
    await db.insert(workflowTerminalDecisions).values({ companyId: s.companyId, workflowRunId: otherRunId,
      decidedAuthorityVersion: 0, decision: "failed", policyCause: "recovery_deadline_hard",
      discoveryPath: "stuck_diagnostic", origin: "reconciler", reason: "test", recoveryGate: {} });
    const otherOwner = await recordMissionOwnerDecision({ db,
      issue: { id: s.recoveryIssueId, companyId: s.companyId, missionId: otherMissionId },
      heartbeatRunId: s.heartbeatId, submission: { decision: "restart_from_start", recoveryTarget: { kind: "tool_step",
        workflowRunId: otherRunId, stepRunId: otherStepRunId, expectedAuthorityVersion: 0,
        expectedExecutionGeneration: 0, failedDispatchRequestId: null } } });
    // 오너 액션 이슈(미션 A)로 미션 B의 런을 교체할 수 없다.
    await expect(ownerSelfReplacement(db, { issueId: s.recoveryIssueId, actor: s.actor,
      request: s.request({ sourceRunId: otherRunId, decisionEventId: otherOwner.eventId }) }))
      .rejects.toThrow("owner_replacement_mission_mismatch");
    expect(await db.select().from(approvals).where(eq(approvals.companyId, s.companyId))).toHaveLength(0);
  });

  it("reuses the board staleness and reserved-metadata guards", async () => {
    const s = await seedScenario();
    // 존재하지 않는 결정 이벤트.
    await expect(ownerSelfReplacement(db, { issueId: s.recoveryIssueId, actor: s.actor,
      request: s.request({ decisionEventId: randomUUID() }) })).rejects.toThrow("replacement_owner_decision_invalid");
    // 결정 이후 세대가 진행된 스태일 소스.
    await db.update(workflowStepRuns).set({ executionGeneration: 1 }).where(eq(workflowStepRuns.id, s.stepRunId));
    await expect(ownerSelfReplacement(db, { issueId: s.recoveryIssueId, actor: s.actor, request: s.request() }))
      .rejects.toThrow("replacement_generation_stale");
    await db.update(workflowStepRuns).set({ executionGeneration: 0 }).where(eq(workflowStepRuns.id, s.stepRunId));
    // reserved metadata 거부.
    await expect(ownerSelfReplacement(db, { issueId: s.recoveryIssueId, actor: s.actor,
      request: s.request({ metadata: { replacementAuthorityId: "x" } }) })).rejects.toThrow("replacement_reserved_metadata");
    expect(await db.select().from(approvals).where(eq(approvals.companyId, s.companyId))).toHaveLength(0);
  });

  it("replays idempotently and refuses idempotency key reuse across requests", async () => {
    const s = await seedScenario();
    const first = await ownerSelfReplacement(db, { issueId: s.recoveryIssueId, actor: s.actor, request: s.request() });
    const second = await ownerSelfReplacement(db, { issueId: s.recoveryIssueId, actor: s.actor, request: s.request() });
    expect(second.replay).toBe(true);
    expect(second.approval.id).toBe(first.approval.id);
    expect(second.targetRunId).toBe(first.targetRunId);
    expect(await db.select().from(approvals).where(and(eq(approvals.companyId, s.companyId),
      eq(approvals.type, "workflow_replacement")))).toHaveLength(1);
    expect(await db.select().from(workflowRuns).where(eq(workflowRuns.id, first.targetRunId))).toHaveLength(1);
    // 같은 키로 다른 요청(다른 소스 런)은 재사용 거부.
    await expect(ownerSelfReplacement(db, { issueId: s.recoveryIssueId, actor: s.actor,
      request: s.request({ sourceRunId: randomUUID() }) })).rejects.toThrow("replacement_idempotency_key_reuse");
    // 보드가 이미 쓴 키도 오너 자가 승인이 가져올 수 없다.
    const b = await seedScenario();
    const boardKey = "board-owned-key";
    const board = { type: "board", source: "local_implicit", userId: "local-board", isInstanceAdmin: true } as const;
    await proposeReplacement(db, b.companyId, board, { sourceRunId: b.run.id, decisionEventId: b.decisionEventId,
      idempotencyKey: boardKey, metadata: {}, externalEffects: "operator_reconciled" });
    await expect(ownerSelfReplacement(db, { issueId: b.recoveryIssueId, actor: b.actor,
      request: b.request({ idempotencyKey: boardKey }) })).rejects.toThrow("replacement_idempotency_key_reuse");
  });

  it("materializes a replacement from a legacy approval-only replay", async () => {
    const s = await seedScenario();
    const first = await ownerSelfReplacement(db, { issueId: s.recoveryIssueId, actor: s.actor, request: s.request() });
    await db.delete(workflowRecoveryAuthorities)
      .where(eq(workflowRecoveryAuthorities.replacementRunId, first.targetRunId));
    await db.delete(workflowRuns).where(eq(workflowRuns.id, first.targetRunId));

    const healed = await ownerSelfReplacement(db, { issueId: s.recoveryIssueId, actor: s.actor, request: s.request() });
    expect(healed).toMatchObject({ replay: true, targetRunId: first.targetRunId });
    expect(await db.select().from(workflowRuns).where(eq(workflowRuns.id, first.targetRunId))).toHaveLength(1);
    expect(await db.select().from(workflowRecoveryAuthorities)
      .where(eq(workflowRecoveryAuthorities.replacementRunId, first.targetRunId))).toHaveLength(1);
  });

  it("admission still requires the mission owner for a self-approved replacement", async () => {
    const s = await seedScenario();
    const result = await ownerSelfReplacement(db, { issueId: s.recoveryIssueId, actor: s.actor, request: s.request() });
    const otherAgent = { type: "agent" as const, agentId: randomUUID(), companyId: s.companyId };
    await expect(admitReplacement(db, s.admissionInput(result.approval.id), otherAgent))
      .rejects.toThrow("replacement_authority_consumed");
  });
});
