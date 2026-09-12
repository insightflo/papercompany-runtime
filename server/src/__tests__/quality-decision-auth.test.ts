// server/src/__tests__/quality-decision-auth.test.ts
//
// [purpose] T5 결정 권한·스코프 로더: Quality scoped loader 의 회사별 404(전역 authz 403 불변),
//   resolve 의 현재 membership/admin/key·정책 reviewer role 검사, local-board 암시 신원 비허용.

import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express, { type Request } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companyMemberships,
  operatorDecisions,
  qualityActions,
  type Db,
} from "@paperclipai/db";
import { qualityActionsRoutes } from "../routes/quality-actions.js";
import { errorHandler } from "../middleware/error-handler.js";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { seedQualityFixture, type QualityFixture } from "./helpers/quality-fixture.js";
import { hashContract } from "../services/quality/contract.js";
import { createQualityDecisionCard, qualityDecisionBindingSchema } from "../services/quality/decisions.js";

const { executeSpy } = vi.hoisted(() => ({ executeSpy: vi.fn() }));
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: executeSpy })),
  runningProcesses: new Map(),
}));

const boardHuman = { userId: "local-board", source: "local_implicit" as const, keyId: null };
const boardActor = { type: "board", source: "local_implicit", userId: "local-board" } as const;

describeQualityDb("quality decision routes: scoped loader and human authority", () => {
  let owned: QualityTestDb;
  let f: QualityFixture;
  let actionId: string;
  let loaderActionId: string;
  let home: string;
  const originalHome = process.env.PAPERCLIP_HOME;
  const seedAction = (db: Db) => {
    const id = randomUUID();
    const intentKey = `t5-auth-${id.slice(0, 8)}`;
    const target = {
      kind: "qa_addendum" as const,
      companyId: f.companyId,
      templateId: f.templateId,
      baseHash: f.baseHash,
      requirementVersionId: "req-fixture-1",
      inputHash: "33".repeat(32),
      candidateVersionId: randomUUID(),
      evaluationId: randomUUID(),
      intentKey,
      execution: { kind: "not_yet_accepted" as const, reason: "new_improvement_execution" as const },
    };
    const effect = { kind: "evaluate_candidate" as const, target };
    return db.insert(qualityActions).values({
      id, companyId: f.companyId, groupId: f.groupId, kind: "qa_addendum",
      occurrenceSetHash: "21".repeat(32), occurrenceIds: [], policyVersionId: f.policyVersionId, scopeVersion: 1,
      target, targetHash: hashContract(target), effect, effectHash: hashContract(effect),
      retryEnvelope: {
        intentKey, effectHash: hashContract(effect), targetHash: hashContract(target), maxExecutorAttempts: 2,
        deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
        groupId: f.groupId, policyVersionId: f.policyVersionId, maxCumulativeCostCents: 100,
      },
      revision: 1, state: "created", intentKey,
    }).returning({ id: qualityActions.id }).then((rows) => rows[0]!.id);
  };
  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "quality-t5-auth-"));
    process.env.PAPERCLIP_HOME = home;
    executeSpy.mockResolvedValue({ exitCode: 0, signal: null, timedOut: false, errorMessage: null, usage: null, provider: "test", model: "test-model", resultJson: null, runtimeServices: [] });
    owned = await createQualityTestDb();
    f = await seedQualityFixture(owned.db);
    await owned.db.update(agents).set({
      adapterType: "codex_local", adapterConfig: { promptTemplate: "Test." }, runtimeConfig: {}, permissions: {},
    }).where(eq(agents.companyId, f.companyId));
    actionId = await seedAction(owned.db);
    loaderActionId = await seedAction(owned.db);
  }, 120_000);
  afterAll(async () => {
    if (originalHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalHome;
    await owned?.close();
  });
  const db = () => owned.db;

  function app(actor: Request["actor"] = boardActor) {
    const value = express();
    value.use(express.json());
    value.use((req, _res, next) => { req.actor = actor; next(); });
    value.use("/api", qualityActionsRoutes(db()));
    value.use(errorHandler);
    return value;
  }
  const sessionReviewer = (): Request["actor"] => ({
    type: "board", source: "session", userId: "quality-reviewer-1", isInstanceAdmin: false, companyIds: [f.companyId],
  }) as unknown as Request["actor"];

  async function reviewerCard() {
    const card = await createQualityDecisionCard(db(), boardHuman, { companyId: f.companyId, actionId });
    const [row] = await db().select().from(operatorDecisions).where(eq(operatorDecisions.id, card.operatorDecisionId));
    const binding = qualityDecisionBindingSchema.parse(row!.qualityBinding);
    return {
      operatorDecisionId: card.operatorDecisionId,
      body: {
        schemaVersion: 1,
        operatorDecisionId: card.operatorDecisionId,
        selectedOptionId: "proceed",
        effectHash: binding.effectHash,
        targetHash: binding.targetHash,
        snapshotHash: binding.snapshotHash,
        evidenceRevision: binding.evidenceRevision,
        policyVersionId: binding.policyVersionId,
        scopeVersion: binding.scopeVersion,
      },
    };
  }

  it("serves the scoped loader for the owning company and 404s other companies and missing actions", async () => {
    const card = await createQualityDecisionCard(db(), boardHuman, { companyId: f.companyId, actionId: loaderActionId });
    const same = await request(app()).get(`/api/companies/${f.companyId}/quality-actions/${loaderActionId}`);
    expect(same.status).toBe(200);
    expect(same.body.data.action).toMatchObject({ id: loaderActionId, companyId: f.companyId });
    expect(same.body.data.pendingDecision).toMatchObject({ operatorDecisionId: card.operatorDecisionId });
    // 다른 회사는 scoped loader 에서 404(새 동작). 기존 전역 authz 403 은 다른 엔드포인트에서 불변.
    const cross = await request(app()).get(`/api/companies/${f.otherCompanyId}/quality-actions/${loaderActionId}`);
    expect(cross.status).toBe(404);
    const missing = await request(app()).get(`/api/companies/${f.companyId}/quality-actions/${randomUUID()}`);
    expect(missing.status).toBe(404);
  });

  it("requires a live policy reviewer identity and records the decision via the dedicated route", async () => {
    const card = await reviewerCard();
    const rejected = await request(app()).post(`/api/companies/${f.companyId}/quality-actions/${actionId}/resolve`).send(card.body);
    expect(rejected.status).toBe(403);
    expect(String(rejected.body.error?.message ?? rejected.body.error)).toContain("quality_decision_role_required");
    // membership 회수 후에도 거부된다(현재 상태 재확인).
    await db().update(companyMemberships).set({ status: "revoked" })
      .where(eq(companyMemberships.principalId, "quality-reviewer-1"));
    const revoked = await request(app(sessionReviewer())).post(`/api/companies/${f.companyId}/quality-actions/${actionId}/resolve`).send(card.body);
    expect(revoked.status).toBe(403);
    await db().update(companyMemberships).set({ status: "active" })
      .where(eq(companyMemberships.principalId, "quality-reviewer-1"));
    // 403 시도는 쓰기를 만들지 않았으므로 같은 카드를 reviewer 가 마저 확정한다.
    const resolved = await request(app(sessionReviewer())).post(`/api/companies/${f.companyId}/quality-actions/${actionId}/resolve`).send(card.body);
    expect(resolved.status).toBe(200);
    expect(resolved.body.data).toMatchObject({ actionId, replayed: false });
    const [action] = await db().select().from(qualityActions).where(eq(qualityActions.id, actionId));
    // resolve 는 authorized 로 기록하고, 전달이 성공하면 기존 바인딩 파이프라인이 bound 로 옮긴다.
    expect(["authorized", "bound"]).toContain(action!.state);
    expect(action!.currentDecisionId).toBe(card.operatorDecisionId);
    expect((await db().select().from(activityLog).where(eq(activityLog.entityId, card.operatorDecisionId)))
      .map((a) => a.action)).toContain("quality.decision_authorized");
  });

  it("creates decision cards from the board route with strict bodies", async () => {
    const wakesBefore = (await db().select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).length;
    const created = await request(app()).post(`/api/companies/${f.companyId}/quality-actions/${actionId}/decision-card`).send({});
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ replayed: false });
    // 같은 내용 재생성은 멱등 재전송 — 카드가 하나 더 생기지 않는다.
    const replay = await request(app()).post(`/api/companies/${f.companyId}/quality-actions/${actionId}/decision-card`).send({});
    expect(replay.status).toBe(200);
    expect(replay.body.data.replayed).toBe(true);
    expect(replay.body.data.operatorDecisionId).toBe(created.body.data.operatorDecisionId);
    const cross = await request(app()).post(`/api/companies/${f.otherCompanyId}/quality-actions/${actionId}/decision-card`).send({});
    expect(cross.status).toBe(404);
    expect((await db().select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).length).toBe(wakesBefore);
  });
});
