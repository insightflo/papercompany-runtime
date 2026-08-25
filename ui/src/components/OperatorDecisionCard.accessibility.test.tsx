// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { OperatorDecisionView } from "@paperclipai/shared/types/operator-decision";
import { OperatorDecisionCard } from "./OperatorDecisionCard";

vi.mock("../lib/router", () => ({
  Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => <a href={to} className={className}>{children}</a>,
}));

const decision: OperatorDecisionView = {
  id: "decision-a",
  companyId: "company-a",
  schemaVersion: 1,
  requestKey: "accessibility",
  status: "pending",
  priority: "critical",
  interactionType: "single_select",
  title: "Accessible choice",
  description: "Choose safely",
  sourceType: "system",
  sourceId: "source",
  sourceContext: {
    missionId: null,
    workflowId: null,
    workflowRunId: null,
    artifactRefs: [{ label: "Artifact", uri: "artifact:shortlist/1" }],
  },
  definition: {
    options: [{
      id: "one",
      label: "One",
      description: "Description",
      facts: [{ label: "Price", value: "Unknown", status: "unknown" }],
      evidenceRefs: [{ label: "Evidence", href: "https://example.com/evidence" }],
    }],
    actions: [{ id: "choose", label: "Choose", outcome: "submit", tone: "primary", requiresSelection: true }],
    selection: { min: 1, max: 1 },
    comment: { mode: "optional", label: "Comment", placeholder: null, maxLength: 100 },
    approvedScope: [],
    forbiddenScope: [],
    humanReview: {
      schemaVersion: "human-review-v1",
      decisionSubject: "Choose safely?",
      evidence: [{ label: "Linked evidence", description: "Supporting material for option one.", href: "https://example.com/evidence", location: "Evidence > option one" }],
      interpretation: "The operator must choose one option.",
      impact: { ifApproved: "The selected option proceeds.", ifRejected: "No option proceeds.", ifWrong: "The wrong option could proceed." },
      unresolvedFacts: [], questions: ["Is the evidence sufficient?"],
      recommendedNextStep: "Review the evidence and decide.", requiredReviewer: "Human Operator",
    },
  },
  result: null,
  issueId: null,
  issueIdentifier: null,
  issueTitle: null,
  missionTitle: null,
  continuationMode: "none",
  requestedBy: null,
  resolvedByUserId: null,
  resolvedAt: null,
  cancelledAt: null,
  createdAt: "2026-07-29T00:00:00.000Z",
  updatedAt: "2026-07-29T00:00:00.000Z",
  continuation: null,
};

describe("OperatorDecisionCard accessibility", () => {
  it("uses native grouped controls and labelled descriptions", () => {
    const html = renderToStaticMarkup(<OperatorDecisionCard decision={decision} onResolve={vi.fn()} />);
    expect(html).toContain("<fieldset");
    expect(html).toContain("<legend");
    expect(html).toContain('type="radio"');
    expect(html).toContain("aria-describedby");
    expect(html).toContain('role="alert"');
    expect(html).toContain("<textarea");
    expect(html).toContain('for="operator-decision-decision-a-comment"');
  });

  it("keeps sentence line breaks readable in the human review packet", () => {
    const html = renderToStaticMarkup(<OperatorDecisionCard decision={{
      ...decision,
      definition: {
        ...decision.definition,
        humanReview: {
          ...decision.definition.humanReview!,
          interpretation: "첫 문장입니다.\n둘째 문장입니다.",
          evidence: [{
            label: "QA 판정",
            href: "/issues/issue-9",
            location: "workflow run x",
            description: "- [source_data] 결함 1\n- [source_data] 결함 2",
          }],
        },
      },
    }} onResolve={vi.fn()} />);
    expect(html).toContain("whitespace-pre-line");
  });

  it("does not render the markdown description when a human review packet exists", () => {
    const html = renderToStaticMarkup(<OperatorDecisionCard decision={decision} onResolve={vi.fn()} />);
    expect(html).not.toContain("Choose safely</p>");
    expect(html).toContain("무엇을 판단하나요?");
  });

  it("renders external evidence with safe new-window attributes and no HTML injection", () => {
    const hostile = {
      ...decision,
      title: "<img src=x onerror=alert(1)>",
    };
    const html = renderToStaticMarkup(<OperatorDecisionCard decision={hostile} onResolve={vi.fn()} />);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
  });

  it("uses checkboxes for multi-select and no options for action cards", () => {
    const multi = { ...decision, interactionType: "multi_select" as const };
    expect(renderToStaticMarkup(<OperatorDecisionCard decision={multi} onResolve={vi.fn()} />)).toContain('type="checkbox"');
    const action = {
      ...decision,
      interactionType: "action" as const,
      definition: { ...decision.definition, options: [], selection: null, actions: [{ ...decision.definition.actions[0]!, requiresSelection: false }] },
    };
    const actionHtml = renderToStaticMarkup(<OperatorDecisionCard decision={action} onResolve={vi.fn()} />);
    expect(actionHtml).not.toContain("<fieldset");
    expect(actionHtml).not.toContain('type="radio"');
  });
});
