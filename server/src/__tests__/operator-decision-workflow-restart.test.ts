import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { buildMissionOwnerHumanInputDecisionCard } from "../services/missions/mission-owner-human-input-card.js";
import { startWorkflowRestartFromOperatorDecision } from "../services/missions/approved-workflow-restart.js";
import { WORKFLOW_RESTART_FROM_START_OPTION_ID } from "../services/missions/workflow-restart-option.js";
import { workflowService } from "../services/workflow/engine.js";

vi.mock("../services/workflow/engine.js", () => ({ workflowService: { trigger: vi.fn() } }));

const trigger = vi.mocked(workflowService.trigger);
const ids = () => ({
  companyId: randomUUID(), missionId: randomUUID(), sourceWorkflowRunId: randomUUID(),
  operatorDecisionId: randomUUID(), issueId: randomUUID(), resolvedByUserId: "board-user",
});

function dbWithSource(source: Record<string, unknown>) {
  const limit = vi.fn().mockResolvedValue([source]);
  const updateWhere = vi.fn().mockResolvedValue([]);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const insertValues = vi.fn().mockResolvedValue([]);
  const db = {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit })) })) })),
    update: vi.fn(() => ({ set: updateSet })),
    insert: vi.fn(() => ({ values: insertValues })),
  } as unknown as Db;
  return { db, updateSet, updateWhere, insertValues };
}

describe("operator-decision workflow restart", () => {
  beforeEach(() => trigger.mockReset());

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
    const withRun = buildMissionOwnerHumanInputDecisionCard({ ...base, workflowRunId });
    expect(withRun.definition.options[0]).toMatchObject({
      id: WORKFLOW_RESTART_FROM_START_OPTION_ID, recommended: true,
    });
    expect(withRun.definition.approvedScope).toContain("workflow_run.restart_from_start");
    expect(withRun.definition.forbiddenScope).not.toContain("auto_execution");
    expect(withRun.sourceContext.workflowRunId).toBe(workflowRunId);

    const ownerRecommended = buildMissionOwnerHumanInputDecisionCard({
      ...base, workflowRunId, recommendedOptionId: "approve", recommendationReason: "owner choice",
    });
    expect(ownerRecommended.definition.options.filter((option) => option.recommended))
      .toEqual([expect.objectContaining({ id: "approve", recommendationReason: "owner choice" })]);
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
