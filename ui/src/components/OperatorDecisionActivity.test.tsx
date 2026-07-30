// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "@paperclipai/shared";
import { OperatorDecisionActivity } from "./OperatorDecisionActivity";

function event(action: string, details: Record<string, unknown>): ActivityEvent {
  return {
    id: "event-1",
    companyId: "company-1",
    actorType: "user",
    actorId: "board",
    action,
    entityType: "operator_decision",
    entityId: "decision-1",
    agentId: null,
    runId: null,
    details,
    createdAt: new Date("2026-07-29T10:00:00Z"),
  };
}

describe("OperatorDecisionActivity", () => {
  it("projects only the exact structured resolved fields", () => {
    const html = renderToStaticMarkup(<OperatorDecisionActivity event={event("operator_decision.resolved", {
      schemaVersion: 1,
      operatorDecisionId: "decision-1",
      actionId: "choose",
      outcome: "submit",
      selectedOptionIds: ["candidate-1"],
      commentPresent: true,
      resolvedByUserId: "board",
      resolvedAt: "2026-07-29T10:00:00Z",
      issueId: "issue-1",
      continuationId: "continuation-1",
      comment: "secret raw comment",
      errorSummary: "private adapter error",
      sourcePayload: "unrestricted",
    })} />);
    expect(html).toContain("choose");
    expect(html).toContain("submit");
    expect(html).toContain("candidate-1");
    expect(html).toContain("Comment provided");
    expect(html).not.toContain("secret raw comment");
    expect(html).not.toContain("private adapter error");
    expect(html).not.toContain("unrestricted");
  });

  it("renders continuation effective status and safe error code", () => {
    const html = renderToStaticMarkup(<OperatorDecisionActivity event={event("operator_decision.continuation_blocked", {
      schemaVersion: 1,
      operatorDecisionId: "decision-1",
      continuationId: "continuation-1",
      generation: 1,
      attempt: 2,
      targetAgentId: "agent-1",
      wakeupRequestId: null,
      effectiveStatus: "blocked",
      errorCode: "issue_unassigned",
    })} />);
    expect(html).toContain("Continuation blocked");
    expect(html).toContain("issue unassigned");
    expect(html).toContain("Generation 1");
    expect(html).toContain("attempt 2");
  });
});
