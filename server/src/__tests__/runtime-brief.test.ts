import { describe, expect, it } from "vitest";
import { buildPaperclipRuntimeBrief } from "@paperclipai/adapter-utils";

describe("buildPaperclipRuntimeBrief", () => {
  it("surfaces exact workflow tool-call contract and recent controller comments", () => {
    const brief = buildPaperclipRuntimeBrief({
      paperclipWorkflowStepToolContract: {
        workflowRunId: "workflow-run-1",
        workflowId: "workflow-1",
        stepId: "collect",
        stepName: "Collect Tech Scout Top25",
        toolNames: ["generic-cli-executor"],
        tools: [
          {
            name: "generic-cli-executor",
            description: "Execute an approved CLI tool registered in Tool Registry.",
            adapterType: "plugin",
          },
        ],
      },
      paperclipIssueRecentComments: [
        {
          id: "comment-2",
          authorType: "controller",
          body: "Use generic-cli-executor with toolName=daily-tech-scout and args { command: daily-tech-scout }. Force fresh session.",
        },
      ],
      paperclipStepInputManifest: {
        version: 1,
        taskKey: "issue:tech-scout",
        issueId: "issue-tech-scout",
        projectId: null,
        allowedContextKeys: ["paperclipWorkflowStepToolContract", "paperclipIssueRecentComments"],
        guardrails: { broadScanAllowed: false },
        inputs: {
          workspace: { available: true, source: "project_primary", workspaceId: "ws-1", projectId: "project-1" },
          runtimeServices: { available: false, count: 0, primaryUrl: null },
          tools: { available: true, count: 1, names: ["generic-cli-executor"] },
        },
      },
    });

    expect(brief).toContain("Workflow tool-call contract:");
    expect(brief).toContain("Step: Collect Tech Scout Top25");
    expect(brief).toContain("generic-cli-executor");
    expect(brief).toContain('{"toolName":"<registered-tool-name>","args":{...}}');
    expect(brief).toContain("Recent issue comments:");
    expect(brief).toContain("Use generic-cli-executor with toolName=daily-tech-scout");
  });

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
          missionOwnerPlanningContext: {
            available: true,
            planningIssueId: "issue-plan-1",
            missionId: "mission-1",
            activePlanAvailable: true,
            selectedExecutionUnitCount: 4,
            executionSourceUnitCount: 7,
            planningDossierAvailable: true,
            planningDossierAssetCounts: {
              workflowCandidates: 2,
              tools: 0,
              runtimeServices: 0,
              ruleRefs: 2,
              kbRefs: 1,
              agentRoster: 3,
              fileViews: 0,
              executionSourceUnits: 7,
            },
            planningDossierGapCount: 2,
            planningDossierSevereGapCount: 1,
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
    expect(brief).toContain("Owner planning protocol:");
    expect(brief).toContain("Before executing, produce a Mission Planning Assessment.");
    expect(brief).toContain("You must inspect: objective; available workflows, tools, runtime services, rules, KB, agents, and files; active plan and prior execution refs; gaps and todo markers.");
    expect(brief).toContain("`research_needed`: list missing evidence and create/request research/delegation steps.");
    expect(brief).toContain("`blocked`: list required user input/approval.");
    expect(brief).toContain("`ready_to_plan`: emit the structured JSON block below.");
    expect(brief).toContain("### Mission owner plan decision");
    expect(brief).toContain("```json");
    expect(brief).toContain('"decisionType": "mission_owner_plan"');
    expect(brief).toContain('"missionId": "mission-1"');
    expect(brief).toContain('"assessment"');
    expect(brief).toContain('"selectedExecutionUnits": []');
    expect(brief).toContain("do not mark the planning issue done until a structured plan decision has been posted and materialized");
    expect(brief).toContain("This brief does not impose a hard completion block.");
    expect(brief).toContain("Asset counts and severe gap count are summaries only; tools/runtimeServices/fileViews may be bounded unavailable summaries, not actual discovery.");
    expect(brief).toContain("Planning dossier asset-count summary: workflows 2, tools 0, runtime services 0, rules 2, KB 1, agents 3, files 0, execution source units 7.");
    expect(brief).toContain("Planning dossier gaps: 2 total, 1 severe/blocking-or-research gaps.");
    expect(brief).toContain("Dynamic mission planning protocol:");
    expect(brief).toContain("Dynamic workflow means reducing uncertainty with evidence gates, not adding subagents or parallelism by default.");
    expect(brief).toContain("Mission Invariant:");
    expect(brief).toContain("Scope Hypothesis:");
    expect(brief).toContain("Execution Slice:");
    expect(brief).toContain("Evidence Required:");
    expect(brief).toContain("Gate:");
    expect(brief).toContain("Promotion / Asset Update:");
    expect(brief).toContain("SkillOpt-lite self-improvement:");
    expect(brief).toContain("propose a bounded add/delete/replace candidate");
    expect(brief).toContain("bounded internal asset adoption is automatic after evidence, bounded patch, and validation gate pass");
    expect(brief).toContain("do not wait for user approval");
    expect(brief).toContain("do not silently mutate skills/rules/KB/workflows/role harnesses outside the current issue scope");
    expect(brief).toContain("ACKs and self-reported completion are not evidence.");
    expect(brief).toContain("Report slice completion separately from end-to-end completion.");
    expect(brief).toContain("Do not promote stale session outcomes, PR numbers, issue IDs, commit hashes, or one-off logs.");
    expect(brief).toContain('"missionInvariant": []');
    expect(brief).toContain('"selfImprovementCandidates": []');
    expect(brief).toContain("Self-improvement candidate contract:");
    expect(brief).toContain("autoAdoptionResult must be accepted/rejected/queued_for_validation/repair_needed");
    expect(brief).toContain("rejectedEditNote is required only when autoAdoptionResult is rejected");
    expect(brief).toContain('"scopeHypothesis": "..."');
    expect(brief).toContain('"evidenceRequired": []');
    expect(brief).toContain('"approvalGates": []');
    expect(brief).toContain('"gate": {');
    expect(brief).toContain('"promotion": {');
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
