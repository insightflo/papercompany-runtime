import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns, issueComments, issues, missions, workflowTransitionEvents } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { missionOwnerDecisionSubmitSchema } from "@paperclipai/shared";
import { submitMissionOwnerDecision } from "../services/missions/mission-owner-recovery-agent-api.js";
import { loadLatestMissionOwnerDecision } from "../services/missions/mission-owner-recovery-ledger.js";
import { applyReassignSourceIssueDecision } from "../services/missions/mission-owner-reassign-source.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;

let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

beforeAll(async () => {
  tempDb = await startEmbeddedPostgresTestDatabase("owner-recovery-agent-api-");
}, 60_000);

afterAll(async () => {
  await tempDb?.cleanup();
});

describeEP("mission owner recovery decision API source scope", () => {
  let db!: ReturnType<typeof createDb>;

  beforeAll(() => {
    db = createDb(tempDb!.connectionString);
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(workflowTransitionEvents);
    await db.delete(issueComments);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  async function seedOwnerAction() {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const otherAgentId = randomUUID();
    const missionId = randomUUID();
    const sourceIssueId = randomUUID();
    const ownerActionIssueId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Owner recovery API company",
      issuePrefix: `OR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Mission owner",
        role: "operator",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "Target executor",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Recovery mission", status: "active" });
    await db.insert(issues).values([
      {
        id: sourceIssueId,
        companyId,
        missionId,
        title: "Scoped source",
        status: "blocked",
        originKind: "workflow_execution",
        assigneeAgentId: ownerAgentId,
      },
      {
        id: ownerActionIssueId,
        companyId,
        missionId,
        title: "Owner action",
        status: "in_progress",
        originKind: "mission_main_executor_unblock",
        originId: sourceIssueId,
        assigneeAgentId: ownerAgentId,
      },
    ]);
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: ownerAgentId, issueId: ownerActionIssueId, status: "running" });
    await db.update(issues).set({ checkoutRunId: runId }).where(eq(issues.id, ownerActionIssueId));
    return { companyId, ownerAgentId, otherAgentId, missionId, sourceIssueId, ownerActionIssueId, runId };
  }

  async function submit(seed: Awaited<ReturnType<typeof seedOwnerAction>>) {
    return submitMissionOwnerDecision({
      db,
      issueId: seed.ownerActionIssueId,
      actor: { actorType: "agent", actorId: seed.ownerAgentId, agentId: seed.ownerAgentId, runId: seed.runId },
      data: { decision: "recover_artifact" },
    });
  }

  it("fails closed for dangling, cross-company, and cross-mission owner-action sources", async () => {
    const seed = await seedOwnerAction();
    const missingSourceId = randomUUID();
    await db.update(issues).set({ originId: missingSourceId }).where(eq(issues.id, seed.ownerActionIssueId));
    await expect(submit(seed)).rejects.toThrow("requires a source issue in the same company and mission");

    const otherMissionId = randomUUID();
    const crossMissionSourceId = randomUUID();
    await db.insert(missions).values({ id: otherMissionId, companyId: seed.companyId, ownerAgentId: seed.ownerAgentId, title: "Other mission", status: "active" });
    await db.insert(issues).values({ id: crossMissionSourceId, companyId: seed.companyId, missionId: otherMissionId, title: "Cross mission", status: "todo" });
    await db.update(issues).set({ originId: crossMissionSourceId }).where(eq(issues.id, seed.ownerActionIssueId));
    await expect(submit(seed)).rejects.toThrow("requires a source issue in the same company and mission");

    const foreignCompanyId = randomUUID();
    const foreignAgentId = randomUUID();
    const foreignMissionId = randomUUID();
    const crossCompanySourceId = randomUUID();
    await db.insert(companies).values({ id: foreignCompanyId, name: "Foreign company", issuePrefix: "FOR", requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: foreignAgentId, companyId: foreignCompanyId, name: "Foreign owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(missions).values({ id: foreignMissionId, companyId: foreignCompanyId, ownerAgentId: foreignAgentId, title: "Foreign mission", status: "active" });
    await db.insert(issues).values({ id: crossCompanySourceId, companyId: foreignCompanyId, missionId: foreignMissionId, title: "Cross company", status: "todo" });
    await db.update(issues).set({ originId: crossCompanySourceId }).where(eq(issues.id, seed.ownerActionIssueId));
    await expect(submit(seed)).rejects.toThrow("requires a source issue in the same company and mission");
  });
  it("persists each revised same-run human decision before materializing its request", async () => {
    const seed = await seedOwnerAction();
    const actor = { actorType: "agent" as const, actorId: seed.ownerAgentId, agentId: seed.ownerAgentId, runId: seed.runId };
    const first = await submitMissionOwnerDecision({
      db, issueId: seed.ownerActionIssueId, actor,
      data: { decision: "request_input", reason: "Need a credential." },
    });
    const revised = await submitMissionOwnerDecision({
      db, issueId: seed.ownerActionIssueId, actor,
      data: { decision: "request_input", reason: "Need the production credential." },
    });
    expect(revised.eventId).not.toBe(first.eventId);
    const [event] = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, revised.eventId));
    expect(event?.payload).toMatchObject({ reason: "Need the production credential." });
    const requests = await db.select({ details: activityLog.details }).from(activityLog)
      .where(eq(activityLog.companyId, seed.companyId));
    expect(requests.some((request) => (
      (request.details as Record<string, unknown>).decisionEventId === revised.eventId
      && (request.details as Record<string, unknown>).reason === "Need the production credential."
    ))).toBe(true);
  });

  it("API-to-ledger: targetAgentId is required for reassign and drives reassignment", async () => {
    const seed = await seedOwnerAction();
    const actor = {
      actorType: "agent" as const,
      actorId: seed.ownerAgentId,
      agentId: seed.ownerAgentId,
      runId: seed.runId,
    };

    // Schema rejects reassign without targetAgentId even when nextAction names a UUID.
    expect(missionOwnerDecisionSubmitSchema.safeParse({
      decision: "reassign_source_issue",
      nextAction: `Target agent: ${seed.otherAgentId}`,
      reason: "prose only",
    }).success).toBe(false);
    expect(missionOwnerDecisionSubmitSchema.safeParse({
      decision: "retry_source_issue",
      nextAction: "retry without reassignment",
    }).success).toBe(true);

    const withTarget = await submitMissionOwnerDecision({
      db,
      issueId: seed.ownerActionIssueId,
      actor,
      data: missionOwnerDecisionSubmitSchema.parse({
        decision: "reassign_source_issue",
        targetAgentId: seed.otherAgentId,
        nextAction: `Target agent: ${seed.otherAgentId}`,
        reason: "structured target required",
      }),
    });
    expect(withTarget.submission.targetAgentId).toBe(seed.otherAgentId);

    const ledger = await loadLatestMissionOwnerDecision({
      db,
      companyId: seed.companyId,
      ownerActionIssueId: seed.ownerActionIssueId,
    });
    expect(ledger?.decision.targetAgentId).toBe(seed.otherAgentId);
    expect(ledger?.eventId).toBe(withTarget.eventId);

    const [mission, sourceIssue, ownerActionIssue] = await Promise.all([
      db.select().from(missions).where(eq(missions.id, seed.missionId)).then((rows) => rows[0]!),
      db.select().from(issues).where(eq(issues.id, seed.sourceIssueId)).then((rows) => rows[0]!),
      db.select().from(issues).where(eq(issues.id, seed.ownerActionIssueId)).then((rows) => rows[0]!),
    ]);
    const applied = await applyReassignSourceIssueDecision({
      db,
      mission,
      ownerActionIssue,
      ownerActionLabel: "Owner unblock",
      ownerDecision: { decision: "reassign_source_issue", nextAction: `Target agent: ${seed.otherAgentId}` },
      sourceIssue,
      sourceLabel: "Scoped source",
      sourceComments: [],
      sourceHasActiveHeartbeat: false,
      sourcePlanGateReason: null,
      now: new Date("2026-07-23T00:00:00.000Z"),
      dispatchWakeup: false,
    });
    expect(applied.findings).toEqual([]);
    expect(applied.appliedAction?.targetAgentId).toBe(seed.otherAgentId);
    const [updatedSource] = await db.select().from(issues).where(eq(issues.id, seed.sourceIssueId));
    expect(updatedSource?.assigneeAgentId).toBe(seed.otherAgentId);
  });

  it("QA-cap retry_source_issue derives reworkTargetRef from the structured producer line, keeps explicit targets, and rejects underivable ones", async () => {
    const seed = await seedOwnerAction();
    const actor = {
      actorType: "agent" as const,
      actorId: seed.ownerAgentId,
      agentId: seed.ownerAgentId,
      runId: seed.runId,
    };
    const qaCapDescription = [
      "## QA rework cap exhausted — owner decision required <!-- qa-cap-key:0123456789abcdef0123456789abcdef -->",
      "Mission: test mission",
      `Producer source issue: ${seed.sourceIssueId}`,
      "QA: step inspection",
    ].join("\n");

    // (1) 재작업 대상 미지출 + qa-cap 설명 → 설명의 구조 라인에서 기본값 채움(무음 정지 방지).
    await db.update(issues).set({ description: qaCapDescription }).where(eq(issues.id, seed.ownerActionIssueId));
    const derivedWithDescription = await submitMissionOwnerDecision({
      db, issueId: seed.ownerActionIssueId, actor,
      data: { decision: "retry_source_issue", reason: "approve producer rework" },
    });
    const [derivedEvent2] = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, derivedWithDescription.eventId));
    expect((derivedEvent2?.payload as Record<string, unknown>).reworkTargetRef).toBe(seed.sourceIssueId);

    // (2) 명시 대상은 덮어쓰지 않는다.
    const explicit = await submitMissionOwnerDecision({
      db, issueId: seed.ownerActionIssueId, actor,
      data: { decision: "retry_source_issue", reworkTargetRef: "GAZ-9999" },
    });
    const [explicitEvent] = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, explicit.eventId));
    expect((explicitEvent?.payload as Record<string, unknown>).reworkTargetRef).toBe("GAZ-9999");

    // (3) 마커는 있지만 producer 라인이 없으면 fail-fast 거부.
    await db.update(issues).set({
      description: "## QA rework cap exhausted <!-- qa-cap-key:0123456789abcdef0123456789abcdef -->\n(no producer line)",
    }).where(eq(issues.id, seed.ownerActionIssueId));
    await expect(submitMissionOwnerDecision({
      db, issueId: seed.ownerActionIssueId, actor,
      data: { decision: "retry_source_issue" },
    })).rejects.toThrow("reworkTargetRef");

    // (4) qa-cap 마커 없는 이슈의 재시도 결정은 종전대로 허용(비-프로듀서 self-retry 경로 호환).
    await db.update(issues).set({ description: null }).where(eq(issues.id, seed.ownerActionIssueId));
    const plain = await submitMissionOwnerDecision({
      db, issueId: seed.ownerActionIssueId, actor,
      data: { decision: "retry_source_issue" },
    });
    const [plainEvent] = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, plain.eventId));
    expect(plainEvent?.payload).toMatchObject({ decision: "retry_source_issue" });
  });
});
