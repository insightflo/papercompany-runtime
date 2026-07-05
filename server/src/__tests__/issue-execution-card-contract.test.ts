import { describe, expect, it } from "vitest";
import type { IssueExecutionCardJson } from "@paperclipai/db";
import { buildWorkflowIssueExecutionCard } from "../services/issue-execution-cards/builder.js";
import { resolveWorkProductRequirement } from "../services/issue-execution-cards/gate-contract.js";
import { extractProseIssueContract } from "../services/issue-execution-cards/prose-markers.js";
import { hashStructuredValue } from "../services/issue-execution-cards/hash.js";

function cardRow(card: IssueExecutionCardJson) {
  return {
    id: "card-1",
    companyId: "company-1",
    issueId: "issue-1",
    missionId: "mission-1",
    workflowRunId: "run-1",
    workflowStepRunId: "step-run-1",
    cardVersion: 1,
    contentHash: hashStructuredValue(card),
    cardJson: card,
    createdAt: new Date("2026-07-05T00:00:00.000Z"),
    updatedAt: new Date("2026-07-05T00:00:00.000Z"),
  };
}

describe("issue execution card contract", () => {
  it("preserves artifact, verdict, and delivery prose markers in the card", () => {
    const description = [
      "Deliverable output (use exactly this directory): /tmp/out",
      "Register the artifact in issue_work_products.",
      "Finish with exactly `PASS` or `REQUEST_CHANGES: <specific gaps>`.",
      "Delivery Verification:",
      "- Read back the public URL.",
      "[ARTIFACT]: <absolute path>",
    ].join("\n");

    const card = buildWorkflowIssueExecutionCard({
      title: "Publish report",
      description,
      companyId: "company-1",
      workflowDefinitionId: "workflow-1",
      workflowRunId: "run-1",
      step: { id: "publish", dependencies: [], graphWorkProductRequired: true },
      stepOutputDir: "/tmp/out",
      isQaStep: false,
    });

    expect(card.requiredOutputs.workProduct.required).toBe(true);
    expect(card.requiredOutputs.deliveryReadback.required).toBe(true);
    expect(card.preservedProseMarkers).toEqual(expect.arrayContaining([
      "[ARTIFACT]: <absolute path>",
      "PASS/REQUEST_CHANGES",
      "Delivery Verification:",
    ]));
  });

  it("uses the structured card before legacy step metadata or prose markers", () => {
    const card = buildWorkflowIssueExecutionCard({
      title: "QA only",
      description: "Validator step. Finish with exactly PASS or REQUEST_CHANGES.",
      companyId: "company-1",
      workflowDefinitionId: "workflow-1",
      workflowRunId: "run-1",
      step: { id: "qa", dependencies: [], graphWorkProductRequired: false },
      isQaStep: true,
    });

    const decision = resolveWorkProductRequirement({
      card: cardRow(card),
      linkedStepRuns: [{ stepId: "qa", metadata: { graphWorkProductRequired: true } }],
      issueDescription: "Deliverable output (use exactly this directory): /tmp/out\n[ARTIFACT]: <absolute path>",
    });

    expect(decision).toMatchObject({
      required: false,
      source: "card",
      stepId: "qa",
      cardHash: hashStructuredValue(card),
    });
  });

  it("falls back to step metadata when no card exists", () => {
    const decision = resolveWorkProductRequirement({
      card: null,
      linkedStepRuns: [{ stepId: "produce", metadata: { graphWorkProductRequired: true } }],
      issueDescription: "Plain issue body.",
    });

    expect(decision).toMatchObject({
      required: true,
      source: "step_metadata",
      stepId: "produce",
    });
  });

  it("falls back to prose markers for legacy issues without metadata", () => {
    const description = [
      "Deliverable output (use exactly this directory): /tmp/out",
      "FINAL LINE RULE: end with `[ARTIFACT]: <absolute path>`.",
    ].join("\n");

    expect(extractProseIssueContract(description).workProductRequired).toBe(true);
    expect(resolveWorkProductRequirement({
      card: null,
      linkedStepRuns: [],
      issueDescription: description,
    })).toMatchObject({
      required: true,
      source: "prose",
    });
  });

  it("treats card, metadata, and legacy prose as equivalent workProduct requirements", () => {
    const description = [
      "Deliverable output (use exactly this directory): /tmp/out",
      "WorkProduct registration contract:",
      "[ARTIFACT]: <absolute path>",
    ].join("\n");
    const card = buildWorkflowIssueExecutionCard({
      title: "Produce artifact",
      description,
      companyId: "company-1",
      workflowDefinitionId: "workflow-1",
      workflowRunId: "run-1",
      step: { id: "produce", dependencies: [], graphWorkProductRequired: false },
      isQaStep: false,
    });

    const decisions = [
      resolveWorkProductRequirement({
        card: cardRow(card),
        linkedStepRuns: [],
        issueDescription: "Plain issue body.",
      }),
      resolveWorkProductRequirement({
        card: null,
        linkedStepRuns: [{ stepId: "produce", metadata: { graphWorkProductRequired: true } }],
        issueDescription: "Plain issue body.",
      }),
      resolveWorkProductRequirement({
        card: null,
        linkedStepRuns: [],
        issueDescription: description,
      }),
    ];

    expect(decisions.map((decision) => decision.required)).toEqual([true, true, true]);
    expect(decisions.map((decision) => decision.source)).toEqual(["card", "step_metadata", "prose"]);
  });
});
