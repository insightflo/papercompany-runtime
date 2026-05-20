// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MissionGovernanceThreadPanel } from "./MissionGovernanceThreadPanel";

let scenario: "populated" | "empty" | "loading" | "error" = "populated";

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => {
    if (scenario === "loading") {
      return { data: undefined, isLoading: true, error: null };
    }

    if (scenario === "error") {
      return { data: undefined, isLoading: false, error: new Error("thread unavailable") };
    }

    if (scenario === "empty") {
      return {
        data: {
          missionId: "mission-1",
          companyId: "company-1",
          events: [],
          summary: {
            totalEventCount: 0,
            latestEvents: [],
            openDecisions: [],
          },
        },
        isLoading: false,
        error: null,
      };
    }

    return {
      data: {
        missionId: "mission-1",
        companyId: "company-1",
        events: [
          {
            id: "event-1",
            companyId: "company-1",
            scope: { missionId: "mission-1", issueId: "issue-1" },
            sourceRef: { type: "issue", id: "issue-1" },
            eventType: "evidence_missing",
            title: "Evidence gap detected",
            summary: "Operator needs deploy smoke evidence before approving the handoff.",
            timestamp: "2026-05-20T01:30:00.000Z",
            severity: "attention",
            actor: { type: "system", authorityRole: "system" },
            evidenceRefs: [{ type: "test", ref: "pnpm test:run", label: "Focused test" }],
          },
          {
            id: "event-2",
            companyId: "company-1",
            scope: { missionId: "mission-1", workflowRunId: "run-1" },
            sourceRef: { type: "workflow_run", id: "run-1" },
            eventType: "workflow_started",
            title: "Workflow started",
            summary: "Mission workflow run started by owner agent.",
            timestamp: "2026-05-20T01:00:00.000Z",
            severity: "info",
            actor: { type: "agent", id: "agent-owner", authorityRole: "mission_owner" },
          },
        ],
        summary: {
          totalEventCount: 2,
          latestEvents: [
            {
              id: "event-1",
              companyId: "company-1",
              scope: { missionId: "mission-1", issueId: "issue-1" },
              sourceRef: { type: "issue", id: "issue-1" },
              eventType: "evidence_missing",
              title: "Evidence gap detected",
              summary: "Operator needs deploy smoke evidence before approving the handoff.",
              timestamp: "2026-05-20T01:30:00.000Z",
              severity: "attention",
              actor: { type: "system", authorityRole: "system" },
            },
          ],
          openDecisions: [
            {
              id: "decision-1",
              companyId: "company-1",
              scope: { missionId: "mission-1", approvalId: "approval-1" },
              sourceRef: { type: "approval", id: "approval-1" },
              eventType: "approval_requested",
              title: "Approval gate waiting",
              summary: "Owner approval is required before proceeding.",
              timestamp: "2026-05-20T01:45:00.000Z",
              severity: "blocked",
              actor: { type: "board", authorityRole: "approver" },
            },
          ],
        },
      },
      isLoading: false,
      error: null,
    };
  },
}));

vi.mock("lucide-react", () => ({
  AlertTriangle: () => <span>AlertTriangle</span>,
  History: () => <span>History</span>,
  ShieldCheck: () => <span>ShieldCheck</span>,
}));

describe("MissionGovernanceThreadPanel", () => {
  it("renders event totals, latest events, and open decisions without action controls", () => {
    scenario = "populated";

    const html = renderToStaticMarkup(<MissionGovernanceThreadPanel missionId="mission-1" />);

    expect(html).toContain("Governance Thread");
    expect(html).toContain("2 total events");
    expect(html).toContain("1 latest events");
    expect(html).toContain("1 open decisions");
    expect(html).toContain("Evidence gap detected");
    expect(html).toContain("Operator needs deploy smoke evidence before approving the handoff.");
    expect(html).toContain("issue:issue-1");
    expect(html).toContain("Approval gate waiting");
    expect(html).toContain("Owner approval is required before proceeding.");
    expect(html).toContain("Diagnostic evidence and decision history only");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("href=");
    expect(html).not.toMatch(/wake|resume|retry|replan|apply/i);
  });

  it("renders an empty state when no governance events have been observed", () => {
    scenario = "empty";

    const html = renderToStaticMarkup(<MissionGovernanceThreadPanel missionId="mission-1" />);

    expect(html).toContain("No governance events observed yet.");
    expect(html).toContain("0 total events");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("href=");
  });

  it("renders loading and error states", () => {
    scenario = "loading";
    expect(renderToStaticMarkup(<MissionGovernanceThreadPanel missionId="mission-1" />)).toContain(
      "Loading governance thread",
    );

    scenario = "error";
    expect(renderToStaticMarkup(<MissionGovernanceThreadPanel missionId="mission-1" />)).toContain(
      "thread unavailable",
    );
  });
});
