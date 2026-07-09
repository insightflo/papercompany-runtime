import { randomUUID } from "node:crypto";
import { vi } from "vitest";

// heartbeat.wakeup의 agent_runtime_state side effect가 embedded pg에서 pkey 충돌을 일으키므로 mock.
// completion service의 evidence re-query + comment + done flow는 실제 DB로 검증.
vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: vi.fn(() => ({
    wakeup: vi.fn(async () => null),
  })),
}));

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, companies, createDb, issueComments, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { hermesChatService } from "../services/hermes-chat.js";
import { completeUnblockActionWithSourceHandback } from "../services/missions/owner-action-completion.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

// [목적] mission_main_executor_unblock done closeout guard가 GAZ-315 silent success를 막는지 검증.
//   source(originId)가 blocked이고 wakeup도 없으면 done 거부; source 회복 또는 wakeup dispatch 시 허용.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres owner-action closeout guard tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("owner-action closeout guard (mission_main_executor_unblock)", () => {
  let db: ReturnType<typeof createDb>;
  let svc: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-owner-action-guard-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Owner Action Co",
      issuePrefix: `OA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    agentId = (await hermesChatService(db).ensureOperationsAgent(companyId)).id;
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertUnblockWithSource(sourceStatus: string) {
    const [source] = await db
      .insert(issues)
      .values({ companyId, title: "blocked source", status: sourceStatus, originKind: "workflow_execution" })
      .returning({ id: issues.id });
    const [unblock] = await db
      .insert(issues)
      .values({
        companyId,
        title: "unblock action",
        status: "todo",
        originKind: "mission_main_executor_unblock",
        originId: source.id,
      })
      .returning({ id: issues.id });
    return { sourceId: source.id, unblockId: unblock.id };
  }

  it("rejects done when the source is still blocked and no wakeup was dispatched (GAZ-315 silent success)", async () => {
    const { unblockId } = await insertUnblockWithSource("blocked");
    // source blocked + no wakeup → guard must reject.
    await expect(svc.update(unblockId, { status: "done" })).rejects.toThrow(/Cannot complete this owner-action/);
  });

  it("allows done when the source recovered (no longer blocked)", async () => {
    const { unblockId } = await insertUnblockWithSource("todo");
    const updated = await svc.update(unblockId, { status: "done" });
    expect(updated?.status).toBe("done");
  });

  it("allows done when a wakeup was dispatched to the source", async () => {
    const { sourceId, unblockId } = await insertUnblockWithSource("blocked");
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      issueId: sourceId,
      requestedAt: new Date(),
    });
    const updated = await svc.update(unblockId, { status: "done" });
    expect(updated?.status).toBe("done");
  });

  it("does not affect non-owner-action issue completion", async () => {
    const [leaf] = await db
      .insert(issues)
      .values({ companyId, title: "manual leaf", status: "todo", originKind: "manual" })
      .returning({ id: issues.id });
    const updated = await svc.update(leaf.id, { status: "done" });
    expect(updated?.status).toBe("done");
  });

  it("rejects done when only a skipped wakeup exists (skipped is not execution evidence)", async () => {
    const [source] = await db
      .insert(issues)
      .values({ companyId, title: "blocked source skipped-only", status: "blocked", originKind: "workflow_execution" })
      .returning({ id: issues.id });
    const [unblock] = await db
      .insert(issues)
      .values({ companyId, title: "unblock skipped-only", status: "todo", originKind: "mission_main_executor_unblock", originId: source.id })
      .returning({ id: issues.id });

    // skipped wakeup — not valid execution-queue evidence.
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      status: "skipped",
      issueId: source.id,
      requestedAt: new Date(),
    });

    // guard must reject: skipped is not queued/deferred/coalesced.
    await expect(svc.update(unblock.id, { status: "done" })).rejects.toThrow(/Cannot complete this owner-action/);
  });

  it("completion service creates source wakeup, records handback comment with wakeup id, then marks done", async () => {
    // [Phase 2] 정상 경로: done 전에 source wakeup 생성 → 댓글에 id → done(guard 통과).
    const [source] = await db
      .insert(issues)
      .values({ companyId, title: "blocked source for completion", status: "blocked", originKind: "workflow_execution", assigneeAgentId: agentId })
      .returning({ id: issues.id });
    const [unblock] = await db
      .insert(issues)
      .values({ companyId, title: "unblock for completion", status: "todo", originKind: "mission_main_executor_unblock", originId: source.id })
      .returning({ id: issues.id });

    // pre-seed a queued wakeup — in production heartbeat.wakeup creates queued; test env
    // (idle agent) produces skipped. The evidence re-query finds this queued row.
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      status: "queued",
      reason: "owner_action_completion_handback",
      issueId: source.id,
      requestedAt: new Date(),
    });

    const result = await completeUnblockActionWithSourceHandback(db, {
      unblockIssueId: unblock.id,
      companyId,
      actor: { agentId },
    });

    // [peer assert] wakeup row가 source issue를 타겟.
    expect(result.wakeupRequestId).toBeTruthy();
    const [wake] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, result.wakeupRequestId!))
      .limit(1);
    expect(wake?.issueId).toBe(source.id);
    expect(wake?.reason).toBe("owner_action_completion_handback");

    // unblock done 표시.
    const [doneRow] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, unblock.id)).limit(1);
    expect(doneRow?.status).toBe("done");

    // [peer assert] 완료 댓글에 wakeup id 기록.
    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, unblock.id));
    expect(comments.some((c) => c.body?.includes("handback") && c.body?.includes(result.wakeupRequestId!.slice(0, 8)))).toBe(true);
  });

  // [Phase 2 route] POST /issues/:id/owner-action/complete-with-handback
  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "test-board", isInstanceAdmin: true, source: "local_implicit" };
      next();
    });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    return app;
  }

  it("route happy path: creates source wakeup, completes, returns response fields", async () => {
    const [source] = await db
      .insert(issues)
      .values({ companyId, title: "source for route", status: "blocked", originKind: "workflow_execution", assigneeAgentId: agentId })
      .returning({ id: issues.id });
    const [unblock] = await db
      .insert(issues)
      .values({ companyId, title: "unblock for route", status: "todo", originKind: "mission_main_executor_unblock", originId: source.id })
      .returning({ id: issues.id });

    // pre-seed queued wakeup (test env produces skipped via heartbeat.wakeup).
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      status: "queued",
      issueId: source.id,
      requestedAt: new Date(),
    });

    const app = buildApp();
    const res = await request(app).post(`/api/issues/${unblock.id}/owner-action/complete-with-handback`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");
    expect(res.body.sourceIssueId).toBe(source.id);
    expect(res.body.wakeupRequestId).toBeTruthy();

    // [peer assert] DB wakeup row targets source.
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, res.body.wakeupRequestId)).limit(1);
    expect(wake?.issueId).toBe(source.id);
  });

  it("route rejects non-owner-action issue with 422", async () => {
    const [leaf] = await db
      .insert(issues)
      .values({ companyId, title: "manual leaf for route", status: "todo", originKind: "manual" })
      .returning({ id: issues.id });

    const app = buildApp();
    const res = await request(app).post(`/api/issues/${leaf.id}/owner-action/complete-with-handback`);
    expect(res.status).toBe(422);
  });
});
