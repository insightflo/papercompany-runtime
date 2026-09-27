import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issues, missions, operatorDecisions } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { missionService } from "../services/missions.js";

// [approval-waiting marker] 감독(stale_in_progress) 오탐 면제 — pending 운영자 결정/승인이
// 있는 in_progress 이슈는 '사람 대기'로 분류되고, 회복(unblock) 이슈가 만들어지지 않는다.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const MINIMAL_DEFINITION = {
  options: [],
  actions: [{ id: "ok", label: "OK", outcome: "submit", tone: "primary", requiresSelection: false }],
  selection: null,
  comment: { mode: "disabled", label: null, placeholder: null, maxLength: 0 },
  approvedScope: [],
  forbiddenScope: [],
} as const;

describeEmbeddedPostgres("supervision stale_in_progress operator approval wait exemption", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-approval-wait-supervision-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedStaleInProgressMission() {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Approval Wait Supervision Co",
      issuePrefix: `WS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Approval wait mission", status: "active" });
    const [source] = await db
      .insert(issues)
      .values({
        companyId,
        missionId,
        assigneeAgentId: workerAgentId,
        originKind: "workflow_execution",
        status: "in_progress",
        title: "Source waiting on operator decision",
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        updatedAt: new Date("2026-06-01T00:00:00.000Z"),
      })
      .returning({ id: issues.id });
    await db.insert(issues).values({
      companyId,
      missionId,
      assigneeAgentId: ownerAgentId,
      originKind: "mission_main_executor_oversight",
      status: "todo",
      title: "[OVERSIGHT] Approval wait mission",
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    });
    return { companyId, missionId, sourceId: source.id };
  }

  async function seedPendingDecision(companyId: string, issueId: string) {
    const [row] = await db
      .insert(operatorDecisions)
      .values({
        companyId,
        requestKey: `supervision-${randomUUID()}`,
        requestHash: randomUUID(),
        status: "pending",
        priority: "high",
        interactionType: "action",
        title: "Waiting decision",
        description: "",
        sourceType: "issue",
        sourceId: `issue:${issueId}`,
        sourceContext: { missionId: null, workflowId: null, workflowRunId: null, artifactRefs: [] },
        issueId,
        definition: MINIMAL_DEFINITION,
        continuationMode: "issue_current_assignee",
      })
      .returning({ id: operatorDecisions.id });
    return row.id;
  }

  async function runSupervision(companyId: string) {
    return missionService(db).runActiveMissionOwnerSupervision({
      companyId,
      staleAfterMinutes: 1,
      now: new Date("2026-06-02T00:10:00.000Z"),
    });
  }

  it("classifies a pending-decision in_progress source as operator_approval_waiting, not stale", async () => {
    const { companyId, missionId, sourceId } = await seedStaleInProgressMission();
    await seedPendingDecision(companyId, sourceId);

    const result = await runSupervision(companyId);
    const missionResult = result.missions[0];
    const findings = missionResult?.findings ?? [];
    expect(findings).toEqual(expect.arrayContaining([
      expect.stringContaining("operator_approval_waiting"),
    ]));
    expect(findings.some((finding) => finding.includes("stale_in_progress_no_execution"))).toBe(false);
    expect((missionResult?.recommendations ?? []).some((rec) => rec.issueId === sourceId)).toBe(false);
    const missionIssueRows = await db
      .select({ originId: issues.originId, originKind: issues.originKind })
      .from(issues)
      .where(eq(issues.missionId, missionId));
    expect(missionIssueRows.some((row) => row.originKind === "mission_main_executor_unblock" && row.originId === sourceId)).toBe(false);
  });

  it("restores the stale verdict after the operator decision is resolved", async () => {
    const { companyId, missionId, sourceId } = await seedStaleInProgressMission();
    const decisionId = await seedPendingDecision(companyId, sourceId);

    const waiting = await runSupervision(companyId);
    expect(waiting.missions[0]?.findings?.some((finding) => finding.includes("stale_in_progress_no_execution"))).toBe(false);

    await db
      .update(operatorDecisions)
      .set({
        status: "resolved",
        result: { actionId: "ok", outcome: "submit", selectedOptionIds: [], comment: null },
        resolvedByUserId: "board",
        resolvedAt: new Date("2026-06-02T00:05:00.000Z"),
      })
      .where(eq(operatorDecisions.id, decisionId));

    const restored = await runSupervision(companyId);
    expect(restored.missions[0]?.findings?.some((finding) => finding.includes("stale_in_progress_no_execution"))).toBe(true);
    const missionIssueRows = await db
      .select({ originId: issues.originId, originKind: issues.originKind })
      .from(issues)
      .where(eq(issues.missionId, missionId));
    expect(missionIssueRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ originKind: "mission_main_executor_unblock", originId: sourceId }),
    ]));
  });
});
