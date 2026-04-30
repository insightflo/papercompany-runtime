import { describe, expect, it, vi } from "vitest";
import {
  evaluateMaintenanceDecisionActionMismatch,
  logMaintenanceDecisionActionMismatch,
} from "../services/maintenance/decision-audit.js";

const logActivityMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/activity-log.js", () => ({
  logActivity: logActivityMock,
}));

const baseDecision = {
  version: 1 as const,
  matchedRules: [],
  recommendedNextAction: "investigate" as const,
  requiredInputs: [],
  suggestedStatus: null,
  handoffTarget: null,
  promptBlock: "Maintenance decision preflight",
  kbReferences: [],
  warnings: [],
};

describe("maintenance decision action soft audit", () => {
  it("flags missing input decisions when an actor attempts to close the issue", () => {
    const mismatch = evaluateMaintenanceDecisionActionMismatch({
      decision: {
        ...baseDecision,
        recommendedNextAction: "request_missing_input",
        suggestedStatus: "blocked",
        requiredInputs: ["affectedSystem", "symptom"],
      },
      attemptedStatus: "done",
      attemptedAction: "issue.patch",
    });

    expect(mismatch).toMatchObject({
      attemptedAction: "issue.patch",
      attemptedStatus: "done",
      mismatchReasons: ["required_inputs_missing_before_close"],
    });
  });

  it("flags vendor handoff and incident decisions when an actor attempts a normal close", () => {
    expect(
      evaluateMaintenanceDecisionActionMismatch({
        decision: { ...baseDecision, recommendedNextAction: "vendor_handoff", handoffTarget: "vendor" },
        attemptedStatus: "done",
        attemptedAction: "issue.patch",
      })?.mismatchReasons,
    ).toContain("vendor_handoff_required_before_close");

    expect(
      evaluateMaintenanceDecisionActionMismatch({
        decision: { ...baseDecision, recommendedNextAction: "escalate_incident" },
        attemptedStatus: "cancelled",
        attemptedAction: "issue.patch",
      })?.mismatchReasons,
    ).toContain("incident_escalation_required_before_close");
  });

  it("does not flag completion evidence warnings when the close comment includes evidence", () => {
    const mismatch = evaluateMaintenanceDecisionActionMismatch({
      decision: { ...baseDecision, recommendedNextAction: "verify_and_close", warnings: ["completion_evidence_missing"] },
      attemptedStatus: "done",
      attemptedAction: "issue.patch",
      attemptedComment: "Evidence: screenshot captured and verification passed.",
    });

    expect(mismatch).toBeNull();
  });

  it("logs a non-blocking mismatch audit payload with actor and recommendation details", async () => {
    await logMaintenanceDecisionActionMismatch({
      db: {} as never,
      companyId: "company-1",
      actor: {
        actorType: "agent",
        actorId: "agent-1",
        agentId: "agent-1",
        runId: "run-1",
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-1",
        projectId: "project-1",
      },
      decision: {
        ...baseDecision,
        recommendedNextAction: "request_missing_input",
        suggestedStatus: "blocked",
        requiredInputs: ["affectedSystem"],
        warnings: ["completion_evidence_missing"],
      },
      attemptedStatus: "done",
      attemptedAction: "issue.patch",
    });

    expect(logActivityMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        actorType: "agent",
        actorId: "agent-1",
        agentId: "agent-1",
        runId: "run-1",
        action: "maintenance_decision_action_mismatch",
        entityType: "issue",
        entityId: "issue-1",
        details: expect.objectContaining({
          issueId: "issue-1",
          issueIdentifier: "PAP-1",
          projectId: "project-1",
          attemptedAction: "issue.patch",
          attemptedStatus: "done",
          recommendedNextAction: "request_missing_input",
          suggestedStatus: "blocked",
          requiredInputs: ["affectedSystem"],
          warnings: ["completion_evidence_missing"],
          mismatchReasons: expect.arrayContaining([
            "required_inputs_missing_before_close",
            "completion_evidence_missing_before_close",
          ]),
        }),
      }),
    );
  });
});
