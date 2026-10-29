import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { buildMissionOwnerHumanInputDecisionCard, createMissionOwnerHumanInputDecisionCard,
  type MissionOwnerHumanInputCardSpec } from "../services/missions/mission-owner-human-input-card.js";
import { buildHistoricalDefaultOwnerHumanInputVariant } from "../services/missions/mission-owner-human-default-definition.js";
import { lockOwnerHumanCurrentCard } from "../services/missions/owner-human-request-card.js";
import { readOwnerHumanCurrent, type OwnerHumanCurrentRecord } from "../services/missions/owner-human-request-state.js";
import { OWNER_HUMAN_LAYER, OWNER_HUMAN_SOURCE, type OwnerHumanTx } from "../services/missions/owner-human-request-contract.js";
import type { OwnerHumanAuthority } from "../services/missions/owner-human-request-authority.js";
import { validateAndHashOperatorDecisionCreate } from "../services/operator-decision-result.js";
import { operatorDecisionWriteService } from "../services/operator-decisions-write.js";
import { operatorDecisionReadService } from "../services/operator-decisions-read.js";
import { startWorkflowRestartFromOperatorDecision } from "../services/missions/approved-workflow-restart.js";
import { WORKFLOW_RESTART_FROM_START_OPTION_ID } from "../services/missions/workflow-restart-option.js";
import { workflowService } from "../services/workflow/engine.js";

vi.mock("../services/workflow/engine.js", () => ({ workflowService: { trigger: vi.fn() } }));
vi.mock("../services/missions/owner-human-request-state.js", () => ({ readOwnerHumanCurrent: vi.fn() }));
vi.mock("../services/operator-decisions-write.js", () => ({ operatorDecisionWriteService: vi.fn() }));
vi.mock("../services/operator-decisions-read.js", () => ({ operatorDecisionReadService: vi.fn() }));

const trigger = vi.mocked(workflowService.trigger);
const ids = () => ({
  companyId: randomUUID(), missionId: randomUUID(), sourceWorkflowRunId: randomUUID(),
  operatorDecisionId: randomUUID(), issueId: randomUUID(), resolvedByUserId: "board-user",
});
const ownerSpec = (overrides: Partial<MissionOwnerHumanInputCardSpec> = {}): MissionOwnerHumanInputCardSpec => ({
  companyId: randomUUID(), missionId: randomUUID(), decisionEventId: randomUUID(), decision: "request_input",
  ownerActionIssueId: randomUUID(), ownerActionIssueStatus: "blocked", requestedByAgentId: randomUUID(),
  sourceIssueId: randomUUID(), workflowRunId: randomUUID(), ...overrides,
});

function ownerGuardWorld(spec: MissionOwnerHumanInputCardSpec, storedInput: ReturnType<typeof buildMissionOwnerHumanInputDecisionCard> | null,
  options: { missingLink?: boolean; wrongLink?: boolean; stalePointer?: boolean; cardId?: string } = {}) {
  const lifetimeId = spec.lifetimeId!;
  const cardInput = { ...spec, lifetimeId: undefined };
  const scope = { companyId: spec.companyId, missionId: spec.missionId,
    target: { kind: "source_issue" as const, issueId: spec.sourceIssueId! } };
  const cardId = options.cardId ?? randomUUID();
  const storedHash = storedInput ? validateAndHashOperatorDecisionCreate(storedInput).requestHash : null;
  const current = {
    pointerEventId: randomUUID(), pointer: { recoveryNeeded: true, anchorIssueId: options.stalePointer ? randomUUID() : spec.ownerActionIssueId },
    lifetime: { lifetimeId, scope, anchorIssueId: spec.ownerActionIssueId, heartbeatRunId: randomUUID(),
      authorAgentId: spec.requestedByAgentId, decisionEventId: spec.decisionEventId, cardInput },
  } as unknown as OwnerHumanCurrentRecord;
  const heartbeatRunId = current.lifetime.heartbeatRunId;
  const mission = { status: "active", ownerAgentId: spec.requestedByAgentId };
  const link = storedInput && !options.missingLink ? {
    companyId: spec.companyId, missionId: spec.missionId, issueId: spec.ownerActionIssueId, heartbeatRunId,
    workflowRunId: spec.workflowRunId, workflowStepRunId: null, eventType: "owner_human_card_v1",
    layer: OWNER_HUMAN_LAYER, reason: OWNER_HUMAN_SOURCE, reasonCode: OWNER_HUMAN_SOURCE,
    idempotencyKey: `owner-human-card:v1:${lifetimeId}`,
    payload: { schemaVersion: 1, kind: "owner_human_card_v1", lifetimeId,
      decisionEventId: spec.decisionEventId, operatorDecisionId: options.wrongLink ? randomUUID() : cardId },
  } : null;
  const card = storedInput ? { ...storedInput, id: cardId, companyId: spec.companyId, status: "pending",
    requestHash: storedHash, requestedByAgentId: spec.requestedByAgentId, requestedByUserId: null,
    qualityActionId: null, qualityBinding: null,
    sourceContext: { ...storedInput.sourceContext, planDecisionHash: "server-context" } } : null;
  const query = (rows: unknown[]) => ({ from: () => ({ where: () => ({ for: async () => rows }) }) });
  const tx = { select: vi.fn()
    .mockImplementationOnce(() => ({ from: () => ({ where: async () => [mission] }) }))
    .mockImplementationOnce(() => query(link ? [link] : []))
    .mockImplementationOnce(() => query(card ? [card] : [])) } as unknown as OwnerHumanTx;
  const auth = { tx, scope, purpose: "settle", anchor: { id: spec.ownerActionIssueId,
    status: "blocked", assigneeAgentId: spec.requestedByAgentId }, agentId: spec.requestedByAgentId,
    heartbeatRunId, recoveryTarget: undefined } as unknown as OwnerHumanAuthority;
  return { auth, current, cardId };
}

function humanInputDb(pendingRows: unknown[], historicalRows: unknown[] = []) {
  const query = (rows: unknown[]) => ({ from: () => ({ where: () => ({
    orderBy: () => ({ limit: async () => rows }), limit: async () => rows,
  }) }) });
  return { select: vi.fn().mockImplementationOnce(() => query(pendingRows))
    .mockImplementationOnce(() => query(historicalRows)), insert: vi.fn(), update: vi.fn() } as unknown as Db;
}

function dbWithSource(source: Record<string, unknown>) {
  const forUpdate = vi.fn().mockResolvedValue([source]);
  const sourceLimit = vi.fn(() => ({ for: forUpdate }));
  const replacementLimit = vi.fn().mockResolvedValue([]);
  const updateWhere = vi.fn().mockResolvedValue([]);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const insertValues = vi.fn().mockResolvedValue([]);
  const db = {
    select: vi.fn()
      .mockImplementationOnce(() => ({ from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: sourceLimit })),
      })) }))
      .mockImplementationOnce(() => ({ from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: replacementLimit })),
      })) })),
    update: vi.fn(() => ({ set: updateSet })),
    insert: vi.fn(() => ({ values: insertValues })),
  } as unknown as Db;
  return { db, updateSet, updateWhere, insertValues };
}

describe("operator-decision workflow restart", () => {
  beforeEach(() => {
    trigger.mockReset();
    vi.mocked(readOwnerHumanCurrent).mockReset();
    vi.mocked(operatorDecisionWriteService).mockReset();
    vi.mocked(operatorDecisionReadService).mockReset();
  });

  it("adds an explicit restart option only when a workflow run is structurally bound", () => {
    const base = {
      companyId: randomUUID(), missionId: randomUUID(), decisionEventId: randomUUID(),
      decision: "request_input" as const, ownerActionIssueId: randomUUID(),
      ownerActionIssueStatus: "blocked", requestedByAgentId: randomUUID(),
    };
    const withoutRun = buildMissionOwnerHumanInputDecisionCard(base);
    expect(withoutRun.definition.options.map((option) => option.id))
      .not.toContain(WORKFLOW_RESTART_FROM_START_OPTION_ID);
    expect(withoutRun.definition.forbiddenScope).toContain("auto_execution");

    const workflowRunId = randomUUID();
    const withRun = buildMissionOwnerHumanInputDecisionCard({
      ...base, workflowRunId, nextAction: "restart the whole workflow from scratch",
    });
    const restartOption = withRun.definition.options.find((option) => option.id === WORKFLOW_RESTART_FROM_START_OPTION_ID);
    expect(restartOption).toBeDefined();
    expect(restartOption).not.toHaveProperty("recommended");
    expect(restartOption).not.toHaveProperty("recommendationReason");
    expect(withRun.definition.approvedScope).toContain("workflow_run.restart_from_start");
    expect(withRun.definition.forbiddenScope).not.toContain("auto_execution");
    expect(withRun.sourceContext.workflowRunId).toBe(workflowRunId);

    const ownerRecommended = buildMissionOwnerHumanInputDecisionCard({
      ...base, workflowRunId, recommendedOptionId: "approve", recommendationReason: "owner choice",
    });
    expect(ownerRecommended.definition.options.filter((option) => option.recommended))
      .toEqual([expect.objectContaining({ id: "approve", recommendationReason: "owner choice" })]);
    expect(buildHistoricalDefaultOwnerHumanInputVariant(ownerRecommended)).toBeNull();

    const ownerRecommendedRestart = buildMissionOwnerHumanInputDecisionCard({
      ...base, workflowRunId,
      recommendedOptionId: WORKFLOW_RESTART_FROM_START_OPTION_ID,
      recommendationReason: "explicitly selected restart",
    });
    expect(ownerRecommendedRestart.definition.options.filter((option) => option.recommended))
      .toEqual([expect.objectContaining({
        id: WORKFLOW_RESTART_FROM_START_OPTION_ID,
        recommendationReason: "explicitly selected restart",
      })]);
    expect(buildHistoricalDefaultOwnerHumanInputVariant(ownerRecommendedRestart)).toBeNull();
  });

  it("replays the exact historical moi1 default after a terminal card", async () => {
    const spec = ownerSpec(), neutral = buildMissionOwnerHumanInputDecisionCard(spec);
    const historical = buildHistoricalDefaultOwnerHumanInputVariant(neutral)!;
    const hash = validateAndHashOperatorDecisionCreate(historical).requestHash;
    const row = { ...historical, id: randomUUID(), companyId: spec.companyId, status: "resolved", requestHash: hash,
      requestedByAgentId: spec.requestedByAgentId, requestedByUserId: null, qualityActionId: null, qualityBinding: null };
    const db = humanInputDb([], [row]);
    const create = vi.fn().mockResolvedValue({ decision: row, replayed: true });
    vi.mocked(operatorDecisionWriteService).mockReturnValue({ create } as never);
    const result = await createMissionOwnerHumanInputDecisionCard(db, spec);
    expect(result.replayed).toBe(true);
    expect(create).toHaveBeenCalledWith(spec.companyId, historical, { type: "agent", id: spec.requestedByAgentId });
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("keeps pending same-event replay on its original definition and hash", async () => {
    const spec = ownerSpec(), historical = buildHistoricalDefaultOwnerHumanInputVariant(
      buildMissionOwnerHumanInputDecisionCard(spec))!;
    const row = { ...historical, id: randomUUID(), companyId: spec.companyId, status: "pending",
      requestHash: validateAndHashOperatorDecisionCreate(historical).requestHash };
    const getRequired = vi.fn().mockResolvedValue(row);
    vi.mocked(operatorDecisionReadService).mockReturnValue({ getRequired } as never);
    const db = humanInputDb([{ id: row.id, requestKey: row.requestKey, sourceContext: row.sourceContext }]);
    const result = await createMissionOwnerHumanInputDecisionCard(db, spec);
    expect(result).toMatchObject({ decision: { id: row.id, requestHash: row.requestHash, definition: row.definition }, replayed: true });
    expect(operatorDecisionWriteService).not.toHaveBeenCalled();
  });

  it.each(["evidence", "target", "option", "author"] as const)(
    "does not treat changed %s as a historical moi1 replay", async (damage) => {
      const spec = ownerSpec(), neutral = buildMissionOwnerHumanInputDecisionCard(spec);
      const historical = buildHistoricalDefaultOwnerHumanInputVariant(neutral)!;
      const row = { ...historical, id: randomUUID(), companyId: spec.companyId, status: "cancelled",
        requestHash: validateAndHashOperatorDecisionCreate(historical).requestHash,
        requestedByAgentId: spec.requestedByAgentId, requestedByUserId: null, qualityActionId: null, qualityBinding: null };
      if (damage === "evidence") row.definition.humanReview!.interpretation = "changed evidence";
      if (damage === "target") row.sourceContext.targetSnapshot!.issueId = randomUUID();
      if (damage === "option") row.definition.options[0]!.label = "changed option";
      if (damage === "author") row.requestedByAgentId = randomUUID();
      const db = humanInputDb([], [row]), create = vi.fn().mockResolvedValue({ decision: row, replayed: false });
      vi.mocked(operatorDecisionWriteService).mockReturnValue({ create } as never);
      await createMissionOwnerHumanInputDecisionCard(db, spec);
      expect(create).toHaveBeenCalledWith(spec.companyId, neutral, { type: "agent", id: spec.requestedByAgentId });
    });

  it("accepts old moi2 hashes only on their existing binding and keeps neutral creation", async () => {
    const spec = ownerSpec({ lifetimeId: randomUUID() });
    const neutral = buildMissionOwnerHumanInputDecisionCard(spec);
    const historical = buildHistoricalDefaultOwnerHumanInputVariant(neutral)!;
    const hash = validateAndHashOperatorDecisionCreate(historical).requestHash, cardId = randomUUID();
    for (const incoming of [neutral, historical]) {
      const world = ownerGuardWorld(spec, historical, { cardId });
      vi.mocked(readOwnerHumanCurrent).mockResolvedValue(world.current);
      const result = await lockOwnerHumanCurrentCard(world.auth, incoming, { type: "agent", id: spec.requestedByAgentId });
      expect(result.card?.id).toBe(cardId);
      expect(result.input).toEqual(historical);
    }
    expect(validateAndHashOperatorDecisionCreate(historical).requestHash).toBe(hash);
    const fresh = ownerGuardWorld(spec, null);
    vi.mocked(readOwnerHumanCurrent).mockResolvedValue(fresh.current);
    expect((await lockOwnerHumanCurrentCard(fresh.auth, neutral, { type: "agent", id: spec.requestedByAgentId })).card).toBeNull();
    const unboundHistorical = ownerGuardWorld(spec, null);
    vi.mocked(readOwnerHumanCurrent).mockResolvedValue(unboundHistorical.current);
    await expect(lockOwnerHumanCurrentCard(unboundHistorical.auth, historical, { type: "agent", id: spec.requestedByAgentId }))
      .rejects.toMatchObject({ status: 409 });
  });

  it.each(["missing-link", "wrong-link", "stale-pointer", "wrong-author", "changed-run", "changed-source", "changed-reason", "changed-option"] as const)(
    "rejects a %s mismatch on historical moi2 replay", async (damage) => {
      const spec = ownerSpec({ lifetimeId: randomUUID() }), neutral = buildMissionOwnerHumanInputDecisionCard(spec);
      const historical = buildHistoricalDefaultOwnerHumanInputVariant(neutral)!;
      const world = ownerGuardWorld(spec, historical, {
        missingLink: damage === "missing-link", wrongLink: damage === "wrong-link", stalePointer: damage === "stale-pointer",
      });
      vi.mocked(readOwnerHumanCurrent).mockResolvedValue(world.current);
      let incoming = neutral;
      if (damage === "changed-run") incoming = { ...neutral, sourceContext: { ...neutral.sourceContext, workflowRunId: randomUUID() } };
      if (damage === "changed-source") incoming = { ...neutral, sourceId: randomUUID() };
      if (damage === "changed-reason") incoming = { ...neutral, description: `${neutral.description} changed` };
      if (damage === "changed-option") incoming = { ...neutral, definition: { ...neutral.definition,
        options: neutral.definition.options.map((option, index) => index ? option : { ...option, label: "changed" }) } };
      const actorId = damage === "wrong-author" ? randomUUID() : spec.requestedByAgentId;
      await expect(lockOwnerHumanCurrentCard(world.auth, incoming, { type: "agent", id: actorId }))
        .rejects.toMatchObject({ status: 409 });
    });

  it("starts a fresh top-level run and reopens blocked oversight from the approved source run", async () => {
    const input = ids();
    const workflowId = randomUUID();
    const { db, updateSet, updateWhere, insertValues } = dbWithSource({
      id: input.sourceWorkflowRunId, companyId: input.companyId, missionId: input.missionId,
      workflowId, parentRunId: null, status: "failed", runDate: "2026-10-25",
    });
    trigger.mockResolvedValue({ runId: randomUUID(), status: "running", stepRuns: [] });

    const result = await startWorkflowRestartFromOperatorDecision(db, input);

    expect(trigger).toHaveBeenCalledWith(db, expect.objectContaining({
      companyId: input.companyId, missionId: input.missionId, workflowId,
      runDate: "2026-10-25", triggeredBy: "operator_decision_approval",
      triggerSource: "operator_decision",
      metadata: { operatorDecisionRestart: expect.objectContaining({
        operatorDecisionId: input.operatorDecisionId,
        sourceWorkflowRunId: input.sourceWorkflowRunId,
      }) },
    }), { actor: { type: "none" } });
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ status: "todo" }));
    expect(updateWhere).toHaveBeenCalledOnce();
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({
      action: "workflow_run.created", entityId: result.runId,
    }));
  });

  it("fails closed when the bound source run is no longer failed", async () => {
    const input = ids();
    const { db, updateSet, insertValues } = dbWithSource({
      id: input.sourceWorkflowRunId, companyId: input.companyId, missionId: input.missionId,
      workflowId: randomUUID(), parentRunId: null, status: "completed", runDate: "2026-10-25",
    });
    await expect(startWorkflowRestartFromOperatorDecision(db, input))
      .rejects.toThrow("workflow_restart_source_not_failed");
    expect(trigger).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });
});
