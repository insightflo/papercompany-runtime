// Stage 1 — mission owner request_input/escalate → operator decision card bridge.
// Contracts under test (plan 2026-10-17-human-decision-escalation-contract):
// D2 requestKey=`moi1:{decisionEventId}` + sourceId=decisionEventId (sourceContext never carries it),
// D3 default approve/hold/reject options + required comment (reject included) + humanReview packet,
// D4 card creation is post-commit and fail-closed 5xx with ledger dedup replay reuse,
// D5 targetSnapshot anchors owner-action issueId+issueStatus; workflowRunId only with a real row.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  missions,
  operatorDecisions,
  workflowDefinitions,
  workflowRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { submitMissionOwnerDecision } from "../services/missions/mission-owner-recovery-agent-api.js";
import {
  buildMissionOwnerHumanInputDecisionCard,
  createMissionOwnerHumanInputDecisionCard,
  MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE,
  type MissionOwnerHumanInputCardSpec,
} from "../services/missions/mission-owner-human-input-card.js";
import { createOperatorDecisionSchema } from "@paperclipai/shared/validators/operator-decision";
import { publishLiveEvent } from "../services/live-events.js";

vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));
// The create step is wrapped so the D4 post-commit failure path can be injected without
// touching the deterministic builder, which stays the real implementation.
vi.mock("../services/missions/mission-owner-human-input-card.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/missions/mission-owner-human-input-card.js")>();
  return { ...actual, createMissionOwnerHumanInputDecisionCard: vi.fn(actual.createMissionOwnerHumanInputDecisionCard) };
});

function humanAlertPublishes() {
  return vi.mocked(publishLiveEvent).mock.calls.filter((call) => (call[0] as { type?: string })?.type === "mission.human_input_requested");
}

// ---------- Part A: pure builder (D2/D3/D5 shape) ----------

function spec(overrides: Partial<MissionOwnerHumanInputCardSpec> = {}): MissionOwnerHumanInputCardSpec {
  return {
    companyId: randomUUID(),
    missionId: randomUUID(),
    decisionEventId: randomUUID(),
    decision: "request_input",
    ownerActionIssueId: randomUUID(),
    ownerActionIssueStatus: "in_progress",
    requestedByAgentId: randomUUID(),
    reason: "사람 승인이 필요합니다",
    nextAction: "운영자 승인 후 다음 단계를 진행해 주세요",
    evidence: "근거 원문 https://example.com/evidence/1",
    issueTitle: "Owner oversight",
    issueIdentifier: "GAZ-1",
    sourceIssueId: null,
    workflowRunId: null,
    ...overrides,
  };
}

describe("mission owner human input decision card builder", () => {
  it("builds a contract-valid single-select card anchored on the owner-action issue", () => {
    const input = spec();
    const card = buildMissionOwnerHumanInputDecisionCard(input);
    expect(() => createOperatorDecisionSchema.parse(card)).not.toThrow();
    expect(card.requestKey).toBe(`moi1:${input.decisionEventId}`);
    expect(card.sourceType).toBe(MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE);
    expect(card.sourceId).toBe(input.decisionEventId);
    expect(card.issueId).toBe(input.ownerActionIssueId);
    expect(card.priority).toBe("high");
    expect(card.interactionType).toBe("single_select");
    expect(card.continuationMode).toBe("issue_current_assignee");
    // D2 — decisionEventId rides only on requestKey/sourceId, never inside sourceContext.
    expect(JSON.stringify(card.sourceContext)).not.toContain(input.decisionEventId);
    expect(card.sourceContext.missionId).toBe(input.missionId);
    expect(card.sourceContext.workflowRunId).toBeNull();
    // D5 — anchor is the owner-action issue id + status; no run identity without a real row.
    expect(card.sourceContext.targetSnapshot).toEqual({ issueId: input.ownerActionIssueId, issueStatus: "in_progress" });
    // D3 — default option set with a reject action forces a required comment.
    expect(card.definition.options.map((option) => option.id)).toEqual(["approve", "hold", "reject"]);
    expect(card.definition.actions.map((action) => action.outcome)).toEqual(["approve", "hold", "reject"]);
    expect(card.definition.selection).toEqual({ min: 1, max: 1 });
    expect(card.definition.comment.mode).toBe("required");
    // D3 — humanReview packet maps decision subject, evidence, impact, next step.
    const review = card.definition.humanReview!;
    expect(review.decisionSubject).toContain("request_input");
    expect(review.evidence.length).toBeGreaterThanOrEqual(1);
    expect(review.evidence[0]!.href).toBe(`/issues/${input.ownerActionIssueId}`);
    expect(review.evidence[0]!.location.length).toBeGreaterThan(0);
    expect(review.impact.ifApproved).toContain("오너");
    expect(review.impact.ifRejected.length).toBeGreaterThan(0);
    expect(review.impact.ifWrong.length).toBeGreaterThan(0);
    expect(review.recommendedNextStep).toBe(input.nextAction);
    // The free-text evidence URL becomes a resolvable evidence ref.
    expect(review.evidence.some((ref) => ref.href === "https://example.com/evidence/1")).toBe(true);
    expect(review.interpretation).toContain(input.reason!);
    expect(card.description).toContain("agent_required");
  });

  it("uses structured payload options first and keeps the submit action optional-comment", () => {
    const card = buildMissionOwnerHumanInputDecisionCard(spec({
      structuredOptions: [
        { id: "alpha", label: "옵션 알파", description: "알파로 진행" },
        { id: "beta", label: "옵션 베타", description: null },
      ],
    }));
    expect(() => createOperatorDecisionSchema.parse(card)).not.toThrow();
    expect(card.definition.options.map((option) => option.id)).toEqual(["alpha", "beta"]);
    expect(card.definition.actions).toHaveLength(1);
    expect(card.definition.actions[0]).toMatchObject({ id: "submit", outcome: "submit", requiresSelection: true });
    expect(card.definition.comment.mode).toBe("optional");
  });

  it("fails closed with 422 when structured options are malformed", () => {
    expect(() => buildMissionOwnerHumanInputDecisionCard(spec({ structuredOptions: [{ id: "", label: "x" }] })))
      .toThrow(expect.objectContaining({ status: 422 }));
  });

  it.each([
    ["decisionEventId", (draft: MissionOwnerHumanInputCardSpec) => ({ ...draft, decisionEventId: "" })],
    ["missionId", (draft: MissionOwnerHumanInputCardSpec) => ({ ...draft, missionId: "" })],
    ["ownerActionIssueId", (draft: MissionOwnerHumanInputCardSpec) => ({ ...draft, ownerActionIssueId: "" })],
    ["ownerActionIssueStatus", (draft: MissionOwnerHumanInputCardSpec) => ({ ...draft, ownerActionIssueStatus: "" })],
  ])("fails closed with 422 when the %s anchor cannot be interpreted", (_name, breakSpec) => {
    expect(() => buildMissionOwnerHumanInputDecisionCard(breakSpec(spec())))
      .toThrow(expect.objectContaining({ status: 422 }));
  });

  it("labels escalate decisions distinctly", () => {
    const card = buildMissionOwnerHumanInputDecisionCard(spec({ decision: "escalate" }));
    expect(card.definition.humanReview!.decisionSubject).toContain("escalate");
    expect(card.definition.humanReview!.recommendedNextStep).toBe(spec({ decision: "escalate" }).nextAction);
  });
});

// ---------- Part B: submission bridge (embedded Postgres) ----------

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

beforeAll(async () => { tempDb = await startEmbeddedPostgresTestDatabase("mission-owner-human-input-card-"); }, 60_000);
afterAll(async () => { await tempDb?.cleanup(); });

describeEP("mission owner human input submission creates decision cards", () => {
  let db!: ReturnType<typeof createDb>;
  beforeAll(() => { db = createDb(tempDb!.connectionString); });
  afterEach(async () => {
    vi.mocked(createMissionOwnerHumanInputDecisionCard).mockClear();
    vi.clearAllMocks();
    await db.delete(activityLog);
    await db.delete(operatorDecisions);
    await db.delete(workflowTransitionEvents);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  async function seedOversight() {
    const companyId = randomUUID(), ownerId = randomUUID(), missionId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Cards", issuePrefix: `CI${companyId.slice(0, 4)}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: ownerId, companyId, name: "owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: ownerId, title: "Human input mission", status: "active" });
    await db.insert(issues).values({ id: issueId, companyId, missionId, title: "Owner oversight", status: "in_progress", originKind: "mission_main_executor_oversight", assigneeAgentId: ownerId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: ownerId, issueId, status: "running" });
    await db.update(issues).set({ checkoutRunId: runId }).where(eq(issues.id, issueId));
    return { companyId, ownerId, missionId, issueId, runId };
  }

  async function seedUnblock(options: { withRunRow: boolean }) {
    const companyId = randomUUID(), ownerId = randomUUID(), missionId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), sourceId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Cards", issuePrefix: `CU${companyId.slice(0, 4)}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: ownerId, companyId, name: "owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: ownerId, title: "Unblock mission", status: "active" });
    const realRunId = randomUUID();
    if (options.withRunRow) {
      const [definition] = await db.insert(workflowDefinitions).values({ companyId, name: "Unblock flow" }).returning();
      await db.insert(workflowRuns).values({ id: realRunId, workflowId: definition!.id, companyId, missionId, triggeredBy: "test", status: "running" });
    }
    await db.insert(issues).values([
      { id: sourceId, companyId, missionId, title: "Source work", status: "blocked", originKind: "workflow_execution", originRunId: realRunId },
      { id: issueId, companyId, missionId, title: "Owner unblock", status: "in_progress", originKind: "mission_main_executor_unblock", originId: sourceId, assigneeAgentId: ownerId },
    ]);
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: ownerId, issueId, status: "running" });
    await db.update(issues).set({ checkoutRunId: runId }).where(eq(issues.id, issueId));
    return { companyId, ownerId, missionId, issueId, runId, sourceId, realRunId };
  }

  const actorOf = (s: { ownerId: string; runId: string }) => ({ actorType: "agent" as const, actorId: s.ownerId, agentId: s.ownerId, runId: s.runId });
  const submit = (s: Awaited<ReturnType<typeof seedOversight>> | Awaited<ReturnType<typeof seedUnblock>>, data: Record<string, unknown>) => submitMissionOwnerDecision({
    db, issueId: s.issueId, actor: actorOf(s), data: data as never,
  });

  it("creates one pending card per request_input event and keeps the single-alert contract", async () => {
    const s = await seedOversight();
    const result = await submit(s, { decision: "request_input", reason: "retry is not authority", nextAction: "Ask the operator.", evidence: "ledger trail" });
    const [card] = await db.select().from(operatorDecisions).where(eq(operatorDecisions.companyId, s.companyId));
    expect(card).toMatchObject({
      requestKey: `moi1:${result.eventId}`,
      sourceType: MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE,
      sourceId: result.eventId,
      requestedByAgentId: s.ownerId,
      issueId: s.issueId,
      status: "pending",
    });
    const sourceContext = card!.sourceContext as Record<string, unknown>;
    expect(sourceContext.missionId).toBe(s.missionId);
    expect(JSON.stringify(sourceContext)).not.toContain(result.eventId);
    expect(sourceContext.targetSnapshot).toEqual({ issueId: s.issueId, issueStatus: "in_progress" });
    const definition = card!.definition as { humanReview?: { evidence: { href: string }[] }; options: { id: string }[] };
    expect(definition.humanReview!.evidence[0]!.href).toBe(`/issues/${s.issueId}`);
    expect(definition.options.map((option) => option.id)).toEqual(["approve", "hold", "reject"]);
    // C4/inbox row stays, notification-once contract stays, and the card exists alongside it.
    expect(humanAlertPublishes()).toHaveLength(1);
    const [activity] = await db.select().from(activityLog).where(eq(activityLog.entityId, s.issueId));
    expect(activity?.action).toBe("mission.owner.human_input_requested");
  });

  it("reuses the same card on dedup replay of an identical resubmission", async () => {
    const s = await seedOversight();
    const data = { decision: "request_input", reason: "Need approval." };
    const first = await submit(s, data);
    const second = await submit(s, data);
    expect(second.eventId).toBe(first.eventId);
    const cards = await db.select().from(operatorDecisions).where(eq(operatorDecisions.companyId, s.companyId));
    expect(cards).toHaveLength(1);
    expect(cards[0]!.requestKey).toBe(`moi1:${first.eventId}`);
    expect(humanAlertPublishes()).toHaveLength(1);
  });

  it("fails closed 5xx when post-commit card creation fails, keeps the ledger, and recreates via requestKey on resubmission", async () => {
    const s = await seedOversight();
    const data = { decision: "request_input", reason: "Need approval." };
    vi.mocked(createMissionOwnerHumanInputDecisionCard).mockRejectedValueOnce(new Error("card write blew up"));
    await expect(submit(s, data)).rejects.toMatchObject({ status: 500 });
    // Ledger decision + inbox alert stay committed (D4 order), card row is absent.
    const [event] = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.issueId, s.issueId));
    expect(event).toMatchObject({ decision: "request_input", layer: "mission_owner_recovery" });
    expect(humanAlertPublishes()).toHaveLength(1);
    expect(await db.select().from(operatorDecisions)).toHaveLength(0);
    // Agent resubmits → ledger dedup returns the same eventId → requestKey idempotency creates the card.
    const replay = await submit(s, data);
    expect(replay.eventId).toBe(event!.id);
    const cards = await db.select().from(operatorDecisions).where(eq(operatorDecisions.companyId, s.companyId));
    expect(cards).toHaveLength(1);
    expect(cards[0]!.sourceId).toBe(event!.id);
    expect(humanAlertPublishes()).toHaveLength(1);
  });

  it("adds workflowRunId to the snapshot only when a real workflowRuns row exists", async () => {
    const linked = await seedUnblock({ withRunRow: true });
    const linkedResult = await submit(linked, { decision: "request_input", reason: "Need human input." });
    const [linkedCard] = await db.select().from(operatorDecisions).where(eq(operatorDecisions.companyId, linked.companyId));
    const linkedContext = linkedCard!.sourceContext as { targetSnapshot: { workflowRunId?: string }; workflowRunId: string | null };
    expect(linkedContext.targetSnapshot.workflowRunId).toBe(linked.realRunId);
    expect(linkedContext.workflowRunId).toBe(linked.realRunId);
    expect(linkedResult.eventId).toBeTruthy();

    const orphan = await seedUnblock({ withRunRow: false });
    await submit(orphan, { decision: "request_input", reason: "Need human input." });
    const [orphanCard] = await db.select().from(operatorDecisions).where(eq(operatorDecisions.companyId, orphan.companyId));
    const orphanContext = orphanCard!.sourceContext as { targetSnapshot: { issueId: string; issueStatus: string; workflowRunId?: string } };
    // The heartbeat run id is NOT a workflowRuns row id — it must never leak into the snapshot (D5).
    expect(orphanContext.targetSnapshot.workflowRunId).toBeUndefined();
    expect(orphanContext.targetSnapshot).toEqual({ issueId: orphan.issueId, issueStatus: "in_progress" });
  });

  it("creates a card for escalate submissions with the same idempotency key contract", async () => {
    const s = await seedOversight();
    const result = await submit(s, { decision: "escalate", reason: "Blocked beyond my authority." });
    const [card] = await db.select().from(operatorDecisions).where(eq(operatorDecisions.companyId, s.companyId));
    expect(card).toMatchObject({ requestKey: `moi1:${result.eventId}`, status: "pending", requestedByAgentId: s.ownerId });
    const definition = card!.definition as { humanReview?: { decisionSubject: string } };
    expect(definition.humanReview!.decisionSubject).toContain("escalate");
  });
});
