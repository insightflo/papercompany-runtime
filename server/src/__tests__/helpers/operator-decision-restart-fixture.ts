import { vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { OperatorDecisionResult } from "@paperclipai/shared/types/operator-decision";
import { validateAndHashOperatorDecisionCreate } from "../../services/operator-decision-result.js";
import { WORKFLOW_RESTART_FROM_START_OPTION_ID } from "../../services/missions/workflow-restart-option.js";

type RestartInput = {
  companyId: string;
  missionId: string;
  sourceWorkflowRunId: string;
  operatorDecisionId: string;
  resolvedByUserId: string;
  issueId: string | null;
  decisionRequestHash?: string;
  decisionResult?: OperatorDecisionResult;
};

export function workflowRestartDb(input: RestartInput, source: Record<string, unknown>) {
  const workflowId = String(source.workflowId);
  const definition = {
    options: [{ id: WORKFLOW_RESTART_FROM_START_OPTION_ID, label: "Restart", description: "Start again",
      facts: [], evidenceRefs: [] }],
    actions: [{ id: "approve", label: "Approve", outcome: "approve" as const,
      tone: "primary" as const, requiresSelection: true }],
    selection: { min: 1, max: 1 },
    comment: { mode: "optional" as const, label: "Reason", placeholder: null, maxLength: 100 },
    approvedScope: ["operator_decision.resolve", "workflow_run.restart_from_start"], forbiddenScope: [],
  };
  const created = validateAndHashOperatorDecisionCreate({
    schemaVersion: 1, requestKey: `restart:${input.sourceWorkflowRunId}`, priority: "high",
    interactionType: "single_select", title: "Restart?", description: "",
    sourceType: "workflow_restart_request_v1", sourceId: input.sourceWorkflowRunId,
    sourceContext: { missionId: input.missionId, workflowId, workflowRunId: input.sourceWorkflowRunId, artifactRefs: [] },
    definition, issueId: input.issueId, continuationMode: "none",
  });
  const decisionResult: OperatorDecisionResult = {
    actionId: "approve", outcome: "approve", selectedOptionIds: [WORKFLOW_RESTART_FROM_START_OPTION_ID], comment: "approved",
  };
  const decision = {
    ...created.input, id: input.operatorDecisionId, companyId: input.companyId, status: "resolved",
    requestedByAgentId: null, requestedByUserId: input.resolvedByUserId,
    qualityActionId: null, qualityBinding: null, requestHash: created.requestHash,
    result: decisionResult, resolvedByUserId: input.resolvedByUserId, resolvedAt: new Date(),
  };
  const sourceForUpdate = vi.fn().mockResolvedValue([source]);
  const sourceLimit = vi.fn(() => ({ for: sourceForUpdate }));
  const replacementLimit = vi.fn().mockResolvedValue([]);
  const updateWhere = vi.fn().mockResolvedValue([]);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const insertValues = vi.fn().mockResolvedValue([]);
  const db = {
    select: vi.fn()
      .mockImplementationOnce(() => ({ from: () => ({ where: async () => [decision] }) }))
      .mockImplementationOnce(() => ({ from: () => ({ where: () => ({ limit: sourceLimit }) }) }))
      .mockImplementationOnce(() => ({ from: () => ({ where: () => ({ limit: replacementLimit }) }) })),
    update: vi.fn(() => ({ set: updateSet })),
    insert: vi.fn(() => ({ values: insertValues })),
  } as unknown as Db;
  return {
    db,
    input: { ...input, decisionRequestHash: created.requestHash, decisionResult },
    decisionResult,
    updateSet,
    updateWhere,
    insertValues,
  };
}
