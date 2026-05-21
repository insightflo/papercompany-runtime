import { describe, expect, it } from "vitest";
import { buildPaperclipRuntimeBrief } from "@paperclipai/adapter-utils";

describe("buildPaperclipRuntimeBrief", () => {
  it("renders a compact brief from manifest and structured handoff", () => {
    const brief = buildPaperclipRuntimeBrief({
      issueId: "issue-1",
      projectId: "project-1",
      paperclipStepInputManifest: {
        version: 1,
        taskKey: "issue:123",
        issueId: "issue-1",
        projectId: "project-1",
        allowedContextKeys: ["issueId", "projectId", "paperclipWorkspace"],
        guardrails: { broadScanAllowed: false },
        inputs: {
          workspace: { available: true, source: "project_primary", workspaceId: "ws-1", projectId: "project-1" },
          workspaceHints: { available: false, count: 0 },
          runtimeServiceIntents: { available: false, count: 0 },
          runtimeServices: { available: true, count: 1, primaryUrl: "http://localhost:4000" },
          tools: { available: true, count: 2, names: ["search-docs", "fetch-spec"] },
          knowledge: { available: true, count: 1, names: ["Mission KB"] },
          maintenanceGuidance: {
            available: true,
            ruleCount: 1,
            knowledgeCount: 1,
            ruleNames: ["수신처 누락 시 보완 요청"],
            knowledgeNames: ["운영 응대 KB"],
            ruleExcerpts: ["수신처가 없으면 고객응대 담당에게 보완 요청"],
            knowledgeExcerpts: ["운영 응대는 증상, 시간대, 수신처를 확인한다."],
          },
          maintenanceDecision: {
            available: true,
            recommendedNextAction: "vendor_handoff",
            suggestedStatus: "in_progress",
            requiredInputs: [],
            warnings: [],
            handoffTarget: "vendor",
            roleContext: {
              roles: [
                { id: "customer_response", responsibilities: ["collect customer-facing intake"] },
                { id: "maintenance_triage", responsibilities: ["diagnose affected system"] },
                { id: "vendor_handoff", responsibilities: ["prepare external handoff"] },
                { id: "approver", responsibilities: ["review high-risk exceptions"], metadata: { aliases: ["operator"] } },
                { id: "incident_owner", responsibilities: ["coordinate outage response"] },
                { id: "srb_sync", kind: "system", responsibilities: ["mirror issue status"], metadata: { aliases: ["mirror_sync"] } },
              ],
              questions: [
                "What role am I acting as?",
                "Does this action fit the role responsibility/authority?",
                "Do I need rationale or override reason?",
                "Is this a hard-stop candidate or observation/escalation?",
              ],
            },
          },
          missionPlan: {
            available: true,
            revision: 2,
            status: "active",
            missionGoal: "Customer homepage rollout",
            requiredInputsCount: 1,
            openRequiredInputs: ["qa-owner"],
            successCriteriaCount: 2,
            riskCount: 1,
            stepCount: 3,
            stepSummary: ["Confirm owner", "Run QA", "Collect approval"],
            executionUnitCount: 4,
            blockedOrFailedUnitCount: 1,
            selectedExecutionUnitCount: 4,
            selectedExecutionUnitSelectionStateCounts: { selected: 1, excluded: 1, satisfied: 1, candidate: 1 },
            selectedExecutionUnitExecutionStateCounts: { blocked: 1, failed: 0, cancelled: 1 },
            selectedExecutionUnitLabels: ["Run preflight smoke", "Collect candidate QA owner", "Deploy production", "Ignored fourth"],
            ruleRefCount: 2,
            ruleNames: ["Approval before publish", "Observe budget"],
            ruleModes: ["approval_gate", "observation"],
            refs: { planningIssueId: "issue-plan-1", workflowRunIds: ["run-1"] },
          },
          fileViews: { available: true, count: 2, source: "wake_comment" },
          sessionHandoff: { available: true, previousSessionId: "sess-1", rotationReason: "budget" },
        },
      },
      paperclipSessionHandoff: {
        version: 1,
        previousSessionId: "sess-1",
        previousRunId: "run-1",
        issueId: "issue-1",
        rotationReason: "budget",
        lastRunSummaryText: "Last run summarized the issue state",
      },
      paperclipSessionHandoffMarkdown: "# old markdown fallback",
    });

    expect(brief).toContain("Paperclip runtime brief:");
    expect(brief).toContain("Task key: issue:123");
    expect(brief).toContain("Issue: issue-1");
    expect(brief).toContain("Broad scans: disallowed");
    expect(brief).toContain("Allowed tools: search-docs, fetch-spec");
    expect(brief).toContain("Knowledge: Mission KB");
    expect(brief).toContain("Maintenance guidance: 1 rules, 1 KB references");
    expect(brief).toContain("Rules: 수신처 누락 시 보완 요청");
    expect(brief).toContain("Rule excerpts: 수신처가 없으면 고객응대 담당에게 보완 요청");
    expect(brief).toContain("Guidance KB excerpts: 운영 응대는 증상, 시간대, 수신처를 확인한다.");
    expect(brief).toContain("Maintenance decision: vendor_handoff (suggested status: in_progress)");
    expect(brief).toContain("Handoff target: vendor");
    expect(brief).toContain("Required inputs: none");
    expect(brief).toContain("Decision warnings: none");
    expect(brief).toContain("Maintenance role context:");
    expect(brief).toContain("Mission plan: rev 2 active — Customer homepage rollout");
    expect(brief).toContain("Mission plan inputs: 1 required, open: qa-owner");
    expect(brief).toContain("Mission plan steps: 3 total — Confirm owner | Run QA | Collect approval");
    expect(brief).toContain("Mission execution units: 4 total, 1 blocked/failed");
    expect(brief).toContain("Mission selected units: 4 total — selected 1, candidate 1, excluded 1, satisfied 1; blocked 1, failed 0, cancelled 1 — Run preflight smoke | Collect candidate QA owner | Deploy production");
    expect(brief).not.toContain("Ignored fourth");
    expect(brief).toContain("Mission rules: 2 refs — Approval before publish, Observe budget (approval_gate, observation)");
    expect(brief).not.toContain("private assumption");
    expect(brief).toContain("customer_response");
    expect(brief).toContain("maintenance_triage");
    expect(brief).toContain("vendor_handoff");
    expect(brief).toContain("approver");
    expect(brief).toContain("operator");
    expect(brief).toContain("incident_owner");
    expect(brief).toContain("srb_sync");
    expect(brief).toContain("mirror_sync");
    expect(brief).toContain("role responsibility/authority");
    expect(brief).toMatch(/rationale|override/);
    expect(brief).toMatch(/hard-stop|observation|escalation/);
    expect(brief).toContain("File views: 2 available (wake_comment)");
    expect(brief).toContain("Previous session: sess-1");
    expect(brief).toContain("Last run summary: Last run summarized the issue state");
    expect(brief).not.toContain("# old markdown fallback");
  });
});
