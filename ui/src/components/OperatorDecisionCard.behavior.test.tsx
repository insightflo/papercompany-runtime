/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperatorDecisionView } from "@paperclipai/shared/types/operator-decision";
import { OperatorDecisionCard } from "./OperatorDecisionCard";

const baseDecision: OperatorDecisionView = {
  id: "decision-1",
  companyId: "company-1",
  schemaVersion: 1,
  requestKey: "fixture",
  status: "pending",
  priority: "high",
  interactionType: "single_select",
  title: "Choose an opportunity",
  description: "Select the best candidate",
  sourceType: "workflow_step",
  sourceId: "step-1",
  sourceContext: { missionId: "mission-1", workflowId: null, workflowRunId: null, artifactRefs: [] },
  definition: {
    options: [
      { id: "one", label: "One", description: "First", facts: [], evidenceRefs: [] },
      { id: "two", label: "Two", description: null, facts: [], evidenceRefs: [] },
    ],
    actions: [
      { id: "choose", label: "Choose", outcome: "submit", tone: "primary", requiresSelection: true },
      { id: "hold", label: "Hold", outcome: "hold", tone: "neutral", requiresSelection: false },
    ],
    selection: { min: 1, max: 1 },
    comment: { mode: "optional", label: "Comment", placeholder: "Optional", maxLength: 100 },
    approvedScope: ["Internal draft"],
    forbiddenScope: ["External contact"],
    humanReview: {
      schemaVersion: "human-review-v1",
      decisionSubject: "Choose one opportunity?",
      evidence: [{ label: "Linked work", description: "The shortlist being reviewed.", href: "/issues/issue-1", location: "Issue > shortlist" }],
      interpretation: "One internal opportunity may be selected.",
      impact: { ifApproved: "The selected draft proceeds.", ifRejected: "No draft proceeds.", ifWrong: "The wrong draft could proceed." },
      unresolvedFacts: [], questions: ["Is the evidence sufficient?"],
      recommendedNextStep: "Review the linked work and decide.", requiredReviewer: "Human Operator",
    },
  },
  result: null,
  issueId: "issue-1",
  continuationMode: "issue_current_assignee",
  requestedBy: { type: "agent", id: "agent-1" },
  resolvedByUserId: null,
  resolvedAt: null,
  cancelledAt: null,
  createdAt: "2026-07-29T10:00:00.000Z",
  updatedAt: "2026-07-29T10:00:00.000Z",
  continuation: null,
};

let host: HTMLDivElement;
let root: Root;

async function renderCard(decision = baseDecision, onResolve = vi.fn().mockResolvedValue(undefined)) {
  await act(async () => {
    root.render(<OperatorDecisionCard decision={decision} onResolve={onResolve} />);
  });
  return onResolve;
}

function click(element: Element) {
  act(() => (element as HTMLElement).click());
}

describe("OperatorDecisionCard behavior", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("submits a single choice and trimmed optional comment", async () => {
    const onResolve = await renderCard();
    click(host.querySelector('input[value="two"]')!);
    const comment = host.querySelector("textarea")!;
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setValue.call(comment, "  reason  ");
      comment.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => click([...host.querySelectorAll("button")].find((button) => button.textContent === "Choose")!));
    expect(onResolve).toHaveBeenCalledWith("decision-1", {
      actionId: "choose", selectedOptionIds: ["two"], comment: "reason",
    });
  });

  it("submits hold immediately with no selection", async () => {
    const onResolve = await renderCard();
    await act(async () => click([...host.querySelectorAll("button")].find((button) => button.textContent === "Hold")!));
    expect(onResolve).toHaveBeenCalledWith("decision-1", {
      actionId: "hold", selectedOptionIds: [], comment: null,
    });
  });

  it("enforces multi-select cardinality and required comment", async () => {
    const multi: OperatorDecisionView = {
      ...baseDecision,
      interactionType: "multi_select",
      definition: {
        ...baseDecision.definition,
        selection: { min: 2, max: 2 },
        comment: { mode: "required", label: "Why", placeholder: null, maxLength: 20 },
      },
    };
    const onResolve = await renderCard(multi);
    click(host.querySelector('input[value="one"]')!);
    click([...host.querySelectorAll("button")].find((button) => button.textContent === "Choose")!);
    expect(onResolve).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Select 2");
    click(host.querySelector('input[value="two"]')!);
    click([...host.querySelectorAll("button")].find((button) => button.textContent === "Choose")!);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("comment");
  });

  it("preserves draft and focuses an announced mutation error", async () => {
    const onResolve = vi.fn().mockRejectedValue(new Error("Conflict"));
    await renderCard(baseDecision, onResolve);
    click(host.querySelector('input[value="one"]')!);
    await act(async () => click([...host.querySelectorAll("button")].find((button) => button.textContent === "Choose")!));
    const alert = host.querySelector('[role="alert"]') as HTMLElement;
    expect(alert.textContent).toContain("Conflict");
    expect(document.activeElement).toBe(alert);
    expect((host.querySelector('input[value="one"]') as HTMLInputElement).checked).toBe(true);
  });
});
