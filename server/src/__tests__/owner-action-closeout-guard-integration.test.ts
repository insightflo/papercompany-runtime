import { randomUUID } from "node:crypto";
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
});
