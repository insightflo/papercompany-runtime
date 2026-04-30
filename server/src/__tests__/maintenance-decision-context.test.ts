import { describe, expect, it } from "vitest";
import { buildMaintenanceDecisionContext } from "../services/maintenance/decision-context.js";

describe("buildMaintenanceDecisionContext", () => {
  it("surfaces missing-input decisions for heartbeat context", () => {
    const decision = buildMaintenanceDecisionContext({
      issue: {
        id: "issue-1",
        identifier: "M-1",
        title: "사용자 문의",
        description: "불편하다고만 전달됨",
        status: "todo",
      },
      guidance: null,
    });

    expect(decision).toMatchObject({
      version: 1,
      recommendedNextAction: "request_missing_input",
      suggestedStatus: "blocked",
      requiredInputs: expect.arrayContaining(["affectedSystem", "symptom", "timeWindow"]),
      handoffTarget: null,
    });
    expect(decision.promptBlock).toContain("request_missing_input");
    expect(decision.promptBlock).toContain("blocked");
  });

  it("surfaces customer-impact outage decisions for heartbeat context", () => {
    const decision = buildMaintenanceDecisionContext({
      issue: {
        id: "issue-2",
        identifier: "M-2",
        title: "키오스크 outage",
        description: "오늘 10:30부터 customer impact 발생, payment failed",
        status: "todo",
      },
      guidance: null,
    });

    expect(decision.recommendedNextAction).toBe("escalate_incident");
    expect(decision.suggestedStatus).toBe("in_progress");
  });

  it("surfaces vendor handoff decisions and target for heartbeat context", () => {
    const decision = buildMaintenanceDecisionContext({
      issue: {
        id: "issue-3",
        identifier: "M-3",
        title: "PG사 external API 오류",
        description: "오늘 11:00부터 결제 vendor timeout, 증상: approval failed",
        status: "todo",
      },
      guidance: null,
    });

    expect(decision.recommendedNextAction).toBe("vendor_handoff");
    expect(decision.handoffTarget).toBe("vendor");
  });

  it("surfaces completion evidence warning when done is requested without evidence", () => {
    const decision = buildMaintenanceDecisionContext({
      issue: {
        id: "issue-4",
        identifier: "M-4",
        title: "프린터 오류",
        description: "오늘 12:00 프린터 오류 재시도",
        status: "in_progress",
      },
      requestedStatus: "done",
      guidance: null,
    });

    expect(decision.recommendedNextAction).toBe("verify_and_close");
    expect(decision.suggestedStatus).toBe("in_review");
    expect(decision.warnings).toContain("completion_evidence_missing");
  });
});
