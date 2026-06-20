// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { MissionDetail } from "./MissionDetail";

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] === "missions" && queryKey[1] === "detail") {
      return {
        data: {
          id: "mission-1",
          companyId: "company-1",
          ownerAgentId: "agent-1",
          title: "Launch Mission",
          description: "Mission detail test",
          status: "active",
          createdAt: "2026-04-15T00:00:00.000Z",
          startedAt: null,
          completedAt: null,
          agents: [],
          sessionBindings: [],
          activeMissionPlan: {
            available: true,
            missionPlanId: "plan-1",
            revision: 2,
            status: "active",
            missionGoal: "Launch with supervised owner decisions",
            requiredInputsCount: 2,
            openRequiredInputs: ["owner-judgement", "vendor-confirmation"],
            successCriteriaCount: 1,
            riskCount: 1,
            stepCount: 3,
            stepSummary: ["Collect evidence", "Owner diagnosis", "Operator report"],
            executionUnitCount: 4,
            blockedOrFailedUnitCount: 1,
            selectedExecutionUnitCount: 4,
            selectedExecutionUnitSelectionStateCounts: {
              selected: 1,
              candidate: 1,
              excluded: 1,
              satisfied: 1,
            },
            selectedExecutionUnitExecutionStateCounts: {
              blocked: 1,
              failed: 1,
              cancelled: 1,
            },
            selectedExecutionUnitLabels: ["Collect data", "Write briefing", "Publish report", "Hidden fourth label"],
            ruleRefCount: 2,
            ruleNames: ["Vendor handoff rule", "Approval gate rule"],
            ruleModes: ["guidance", "approval_gate"],
            refs: {
              ruleRefs: [
                { name: "Vendor handoff rule", mode: "guidance", source: "worktree_rules" },
                { name: "Approval gate rule", mode: "approval_gate", source: "worktree_rules" },
              ],
              kbRefs: [{ title: "Launch KB", excerpt: "Use release notes as operator evidence." }],
              executionUnits: [
                {
                  kind: "plugin_workflow_step_run",
                  title: "Publish handoff step",
                  status: "failed",
                  sourceRef: { type: "plugin_workflow_step_run", id: "step-run-1" },
                },
              ],
              selectedExecutionUnits: [
                {
                  title: "Collect data",
                  selectionState: "selected",
                  executionState: "blocked",
                  body: "PRIVATE RAW BODY SHOULD NOT RENDER",
                  reason: "PRIVATE REASON SHOULD NOT RENDER",
                  evidenceRefs: [{ ref: "PRIVATE-EVIDENCE" }],
                },
              ],
              selfImprovementCandidates: [
                {
                  assetType: "skill",
                  assetRef: "papercompany-self-improvement-operations",
                  pattern: "Accepted candidates need operator-visible evidence.",
                  autoAdoptionResult: "accepted",
                  gateOwner: "peer-validator",
                  proposedEdit: { operation: "replace", section: "Candidate lifecycle" },
                  evidenceSource: ["mission closeout", { label: "peer PASS" }],
                },
                {
                  assetType: "kb",
                  assetRef: "mission-owner-kb",
                  pattern: "Rejected candidates keep diagnostics instead of silent omission.",
                  autoAdoptionResult: "repair_needed",
                  gateOwner: "mission-owner",
                  proposedEdit: { operation: "add", section: "Diagnostics" },
                  evidenceSource: ["invalid_candidate_contract"],
                  sensitiveBody: "PRIVATE CANDIDATE BODY SHOULD NOT RENDER",
                },
              ],
            },
          },
        },
        isLoading: false,
        isFetching: false,
        error: null,
      };
    }

    if (queryKey[0] === "missions" && queryKey[1] === "activity") {
      return {
        data: [
          {
            id: "activity-1",
            companyId: "company-1",
            actorType: "user",
            actorId: "local-board",
            action: "mission.supervision.run",
            entityType: "mission",
            entityId: "mission-1",
            agentId: null,
            runId: null,
            details: {
              findingCount: 1,
              recommendationCount: 1,
              appliedActionCount: 0,
            },
            createdAt: "2026-04-16T00:00:00.000Z",
          },
        ],
        isLoading: false,
        isFetching: false,
        error: null,
      };
    }

    if (queryKey[0] === "agents") {
      return {
        data: [{ id: "agent-1", name: "Planner" }],
        isLoading: false,
        isFetching: false,
        error: null,
      };
    }

    return { data: undefined, isLoading: false, isFetching: false, error: null };
  },
  useMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
  }),
}));

vi.mock("@/lib/router", () => ({
  useParams: () => ({ missionId: "mission-1" }),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../components/MissionExecutionOverview", () => ({
  MissionExecutionOverview: ({ missionId }: { missionId: string }) => (
    <section data-component="MissionExecutionOverview">Overview for {missionId}</section>
  ),
}));

vi.mock("../components/InlineEditor", () => ({
  InlineEditor: ({
    value,
    placeholder,
    className,
  }: {
    value?: string;
    placeholder?: string;
    className?: string;
  }) => (
    <span data-component="InlineEditor" className={className}>{value || placeholder}</span>
  ),
}));

vi.mock("../components/PageSkeleton", () => ({
  PageSkeleton: () => <div data-component="PageSkeleton" />,
}));

vi.mock("../components/MissionIssueTree", () => ({
  MissionIssueTree: ({ missionId }: { missionId: string }) => (
    <section data-component="MissionIssueTree">Issue tree for {missionId}</section>
  ),
}));

vi.mock("../components/MissionIssueInspector", () => ({
  MissionIssueInspector: ({ issueId }: { issueId?: string | null }) => (
    <section data-component="MissionIssueInspector">Inspector for {issueId ?? "none"}</section>
  ),
}));

vi.mock("../components/WorkflowDagPanel", () => ({
  WorkflowDagPanel: ({ missionId }: { missionId: string }) => (
    <section data-component="WorkflowDagPanel">Workflow DAG for {missionId}</section>
  ),
}));

vi.mock("@/components/StatusBadge", () => ({
  StatusBadge: ({ status }: { status: string }) => <span data-testid="status-badge">{status}</span>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: ReactNode }) => <div data-testid="tabs">{children}</div>,
  TabsList: ({ children }: { children: ReactNode }) => <div data-testid="tabs-list">{children}</div>,
  TabsTrigger: ({ children, value }: { children: ReactNode; value: string }) => (
    <button data-testid={`tabs-trigger-${value}`}>{children}</button>
  ),
  TabsContent: ({ children, value }: { children: ReactNode; value: string }) => (
    <div data-testid={`tabs-content-${value}`}>{children}</div>
  ),
}));

vi.mock("@/components/ui/separator", () => ({
  Separator: () => <hr data-testid="separator" />,
}));

vi.mock("lucide-react", () => ({
  Rocket: () => <span>Rocket</span>,
  ListTree: () => <span>ListTree</span>,
  GitBranch: () => <span>GitBranch</span>,
  RefreshCw: () => <span>RefreshCw</span>,
  Settings: () => <span>Settings</span>,
  User: () => <span>User</span>,
}));

describe("MissionDetail", () => {
  it("renders mission work list and embedded issue inspector without leaving the mission screen", () => {
    const html = renderToStaticMarkup(<MissionDetail />);

    expect(html).toContain("Launch Mission");
    expect(html).toContain("Mission detail test");
    expect(html).toContain("max-h-[32dvh]");
    expect(html).toContain("overflow-y-auto");
    expect(html).toContain("overflow-x-hidden");
    expect(html).toContain("whitespace-pre-wrap");
    expect(html).toContain("break-words");
    expect(html).toContain("Main executor");
    expect(html).toContain("Planner");
    expect(html).toContain("Work");
    expect(html).toContain("Mission work items");
    expect(html).toContain('data-component="MissionIssueTree"');
    expect(html).toContain("Issue tree for mission-1");
    expect(html).toContain("Selected work item");
    expect(html).toContain('data-component="MissionIssueInspector"');
    expect(html).toContain("Inspector for none");
    expect(html).toContain("Execution Flow");
    expect(html).toContain('data-component="WorkflowDagPanel"');
    expect(html).toContain("Workflow DAG for mission-1");
    expect(html).toContain("Execution Rules");
    expect(html).toContain("RefreshCw");
    expect(html).toContain("Refresh mission detail");
    expect(html).toContain("Applied Worktree Rules");
    expect(html).toContain("Vendor handoff rule");
    expect(html).toContain("approval_gate");
    expect(html).toContain("Injected KB references/excerpts");
    expect(html).toContain("Launch KB");
    expect(html).toContain("Use release notes as operator evidence.");
    expect(html).toContain("Required inputs");
    expect(html).toContain("owner-judgement");
    expect(html).toContain("Suggested status/action");
    expect(html).toContain("Latest Maintenance Decision");
    expect(html).toContain("Plan steps");
    expect(html).toContain("Collect evidence");
    expect(html).toContain("Owner diagnosis");
    expect(html).toContain("Execution units");
    expect(html).toContain("Publish handoff step");
    expect(html).toContain("plugin_workflow_step_run:step-run-1");
    expect(html).toContain("failed");
    expect(html).toContain("Selected execution units");
    expect(html).toContain("4 total");
    expect(html).toContain("selected 1");
    expect(html).toContain("candidate 1");
    expect(html).toContain("excluded 1");
    expect(html).toContain("satisfied 1");
    expect(html).toContain("exceptions: blocked 1, failed 1, cancelled 1");
    expect(html).toContain("Collect data");
    expect(html).toContain("Write briefing");
    expect(html).toContain("Publish report");
    expect(html).not.toContain("Hidden fourth label");
    expect(html).not.toContain("PRIVATE RAW BODY SHOULD NOT RENDER");
    expect(html).not.toContain("PRIVATE REASON SHOULD NOT RENDER");
    expect(html).not.toContain("PRIVATE-EVIDENCE");
    expect(html).toContain("Audit timeline");
    expect(html).toContain("mission.supervision.run");
    expect(html).toContain("1 findings · 1 recommendations · 0 applied");
    expect(html).toContain("1 blocked/failed");
    expect(html).toContain("Self-improvement candidates");
    expect(html).toContain("2 candidates");
    expect(html).toContain("papercompany-self-improvement-operations");
    expect(html).toContain("skill");
    expect(html).toContain("accepted");
    expect(html).toContain("Accepted candidates need operator-visible evidence.");
    expect(html).toContain("replace · Candidate lifecycle");
    expect(html).toContain("peer-validator");
    expect(html).toContain("mission-owner-kb");
    expect(html).toContain("repair_needed");
    expect(html).toContain("add · Diagnostics");
    expect(html).toContain("mission-owner");
    expect(html).not.toContain("PRIVATE CANDIDATE BODY SHOULD NOT RENDER");
  });
});
