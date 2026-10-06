import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { runMissionTerminalCleanup } from "../services/missions/terminal-cleanup-fence.js";
import { schema, seedTerminal, terminalDatabase } from "./helpers/terminal-cleanup-fixture.js";

// [계약] 미션 cancel 터미널 정리는 해당 미션에 매달린 pending 승인요청을 cancel로 회수한다.
//   - 회수 대상: sourceContext.missionId 일치 또는 미션 이슈에 issueId 로 연결된 pending.
//   - 회수 제외: 다른 미션·회사 소속, 미션 무관 company-scope, 이미 resolved/cancelled.
//   - completed 종결에는 적용하지 않는다(종결 후 처리 요청은 유효할 수 있다).
function decisionSeed(companyId: string, overrides: Record<string, unknown>) {
  return {
    companyId,
    requestKey: `req-${randomUUID()}`,
    requestHash: `hash-${randomUUID()}`,
    status: "pending",
    priority: "critical",
    interactionType: "action",
    title: "승인 필요",
    sourceType: "workflow_recovery",
    sourceId: "seed",
    sourceContext: { missionId: null, workflowId: null, workflowRunId: null, artifactRefs: [] },
    definition: {
      options: [],
      actions: [{ id: "approve", label: "승인", outcome: "approve", tone: "primary", requiresSelection: false }],
      selection: null,
      comment: { mode: "optional", label: null, placeholder: null, maxLength: 1000 },
      approvedScope: [],
      forbiddenScope: [],
    },
    ...overrides,
  };
}

describe("terminal cleanup withdraws mission-scoped pending operator decisions on cancel", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => { ({ db, close } = await terminalDatabase()); }, 60_000);
  afterAll(async () => { await close?.(); });

  it("cancels pending decisions linked by sourceContext.missionId or mission issueId, preserving others", async () => {
    const f = await seedTerminal(db);
    const foreign = await seedTerminal(db);
    const [otherMission] = await db.insert(schema.missions).values({ companyId: f.company.id, ownerAgentId: f.agent.id, title: "Other mission", status: "active" }).returning();
    const [otherIssue] = await db.insert(schema.issues).values({ companyId: f.company.id, missionId: otherMission.id, title: "Other work", status: "todo" }).returning();

    const seeds = await db.insert(schema.operatorDecisions).values([
      decisionSeed(f.company.id, { sourceContext: { missionId: f.mission.id, workflowId: null, workflowRunId: null, artifactRefs: [] } }),
      decisionSeed(f.company.id, { issueId: f.issue.id }),
      decisionSeed(f.company.id, { sourceContext: { missionId: otherMission.id, workflowId: null, workflowRunId: null, artifactRefs: [] } }),
      decisionSeed(f.company.id, { issueId: otherIssue.id }),
      decisionSeed(f.company.id, {}),
      decisionSeed(foreign.company.id, { sourceContext: { missionId: f.mission.id, workflowId: null, workflowRunId: null, artifactRefs: [] } }),
      decisionSeed(f.company.id, {
        status: "resolved",
        sourceContext: { missionId: f.mission.id, workflowId: null, workflowRunId: null, artifactRefs: [] },
        result: { actionId: "approve", outcome: "approve", selectedOptionIds: [], comment: null },
        resolvedByUserId: "board-user",
        resolvedAt: f.input.now,
      }),
    ]).returning();
    const [missionScoped, issueLinked, otherMissionScoped, otherIssueLinked, companyScoped, foreignCompany, resolvedBefore] = seeds;

    const result = await runMissionTerminalCleanup(db, {
      ...f.input,
      status: "cancelled",
      completedAt: null,
      pendingMissionUpdates: { status: "cancelled", updatedAt: f.input.now },
    });
    expect(result.aborted).toBe(false);

    const rows = await db.select().from(schema.operatorDecisions).where(inArray(schema.operatorDecisions.id, seeds.map((row) => row.id)));
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const [label, seed, expected] of [
      ["mission-scoped", missionScoped, "cancelled"],
      ["mission-issue-linked", issueLinked, "cancelled"],
      ["other-mission-scoped", otherMissionScoped, "pending"],
      ["other-issue-linked", otherIssueLinked, "pending"],
      ["company-scoped", companyScoped, "pending"],
      ["foreign-company", foreignCompany, "pending"],
      ["resolved-before-cancel", resolvedBefore, "resolved"],
    ] as const) {
      const row = byId.get(seed.id)!;
      expect(row.status, label).toBe(expected);
      if (expected === "cancelled") {
        expect(row.cancelledAt, label).toEqual(f.input.now);
        expect(row.updatedAt, label).toEqual(f.input.now);
      } else {
        expect(row.cancelledAt, label).toBeNull();
      }
    }

    const activity = await db.select().from(schema.activityLog).where(inArray(schema.activityLog.entityId, [missionScoped.id, issueLinked.id]));
    expect(activity).toHaveLength(2);
    for (const entry of activity) {
      expect(entry.action).toBe("operator_decision.cancelled");
      expect(entry.actorType).toBe("system");
      expect(entry.details).toMatchObject({ missionId: f.mission.id, reason: "mission_cancelled" });
    }
  }, 60_000);

  it("leaves pending decisions untouched when the mission completes", async () => {
    const f = await seedTerminal(db);
    const [pending] = await db.insert(schema.operatorDecisions).values(
      decisionSeed(f.company.id, { sourceContext: { missionId: f.mission.id, workflowId: null, workflowRunId: null, artifactRefs: [] } }),
    ).returning();
    const result = await runMissionTerminalCleanup(db, f.input);
    expect(result.aborted).toBe(false);
    const [row] = await db.select().from(schema.operatorDecisions).where(eq(schema.operatorDecisions.id, pending.id));
    expect(row.status).toBe("pending");
    expect(row.cancelledAt).toBeNull();
  }, 60_000);

  it("second cancel through the real service path is idempotent — no double activity, no errors", async () => {
    const f = await seedTerminal(db);
    const [pending] = await db.insert(schema.operatorDecisions).values(
      decisionSeed(f.company.id, { sourceContext: { missionId: f.mission.id, workflowId: null, workflowRunId: null, artifactRefs: [] } }),
    ).returning();
    const cancelled = { status: "cancelled" as const, completedAt: null, pendingMissionUpdates: { status: "cancelled" as const, updatedAt: f.input.now } };
    await runMissionTerminalCleanup(db, { ...f.input, ...cancelled });
    // 실제 서비스 경로(update)는 재요청 시 미션 행을 다시 읽어 스냅숏을 만든다 — 낡은 스냅숏은 펜스가 거부한다.
    const [fresh] = await db.select().from(schema.missions).where(eq(schema.missions.id, f.mission.id));
    const second = await runMissionTerminalCleanup(db, {
      ...f.input,
      ...cancelled,
      missionSnapshot: fresh,
      pendingMissionUpdates: { status: "cancelled" as const, updatedAt: fresh.updatedAt },
    });
    expect(second.aborted).toBe(false);
    const [row] = await db.select().from(schema.operatorDecisions).where(eq(schema.operatorDecisions.id, pending.id));
    expect(row.status).toBe("cancelled");
    expect(row.cancelledAt).toEqual(f.input.now);
    const activity = await db.select().from(schema.activityLog).where(eq(schema.activityLog.entityId, pending.id));
    expect(activity).toHaveLength(1);
  }, 60_000);
});
