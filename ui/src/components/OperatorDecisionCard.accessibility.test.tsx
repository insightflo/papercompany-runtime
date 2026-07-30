// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { OperatorDecisionView } from "@paperclipai/shared/types/operator-decision";
import { OperatorDecisionCard } from "./OperatorDecisionCard";

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
  },
  result: null,
  issueId: null,
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
