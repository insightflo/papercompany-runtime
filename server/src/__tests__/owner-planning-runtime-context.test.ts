import { describe, expect, it } from "vitest";
import { buildStepInputManifest } from "../services/step-input-manifest.js";
import { buildPaperclipRuntimeBrief } from "@paperclipai/adapter-utils";

describe("owner planning runtime context surfaces", () => {
  it("summarizes owner-planning context in the Step Input Manifest without exposing raw execution-unit refs", () => {
    const manifest = buildStepInputManifest({
      taskKey: "mission:mission-1",
      context: {
        issueId: "issue-plan-1",
        missionId: "mission-1",
        paperclipMissionOwnerPlanningContext: {
          planningIssueId: "issue-plan-1",
          mission: { id: "mission-1", title: "Plan launch" },
          activePlan: { available: true, selectedExecutionUnitCount: 2 },
          executionSourceSnapshot: { units: [{ id: "unit-1" }] },
          planningDossier: {
            assets: {
              workflowCandidates: [{ id: "workflow-1" }, { id: "workflow-2" }],
              tools: { available: false, count: 0, labels: [] },
              runtimeServices: { available: false, count: 0, labels: [] },
              ruleRefs: [{ id: "rule-1" }],
              kbRefs: [{ id: "kb-1" }],
              agentRoster: [{ agentId: "agent-1" }, { agentId: "agent-2" }],
              fileViews: { available: false, count: 0, labels: [] },
              executionSourceSummary: { unitCount: 1, labels: ["unit-1"] },
            },
            gaps: [
              { key: "manual_planning_required", severity: "needs_research" },
              { key: "plugin_workflow_definition_reader_unconfirmed", severity: "info" },
            ],
          },
          refs: {
            selectedExecutionUnits: [
              {
                id: "unit-1",
                reason: "raw private rationale must not be mirrored in manifest",
                body: "raw private body must not be mirrored in manifest",
                evidenceRefs: ["secret-evidence"],
              },
            ],
          },
        },
      },
    });

    expect(manifest.allowedContextKeys).toContain("paperclipMissionOwnerPlanningContext");
    expect(manifest.inputs.missionOwnerPlanningContext).toEqual({
      available: true,
      planningIssueId: "issue-plan-1",
      missionId: "mission-1",
      activePlanAvailable: true,
      selectedExecutionUnitCount: 2,
      executionSourceUnitCount: 1,
      planningDossierAvailable: true,
      planningDossierAssetCounts: {
        workflowCandidates: 2,
        tools: 0,
        runtimeServices: 0,
        ruleRefs: 1,
        kbRefs: 1,
        agentRoster: 2,
        fileViews: 0,
        executionSourceUnits: 1,
      },
      planningDossierGapCount: 2,
      planningDossierSevereGapCount: 1,
    });
    expect(JSON.stringify(manifest)).not.toContain("raw private rationale");
    expect(JSON.stringify(manifest)).not.toContain("raw private body");
    expect(JSON.stringify(manifest)).not.toContain("secret-evidence");
  });

  it("summarizes owner-planning context in runtime brief without exposing raw execution-unit refs", () => {
    const brief = buildPaperclipRuntimeBrief({
      issueId: "issue-plan-1",
      missionId: "mission-1",
      paperclipStepInputManifest: buildStepInputManifest({
        taskKey: "mission:mission-1",
        context: {
          issueId: "issue-plan-1",
          missionId: "mission-1",
          paperclipMissionOwnerPlanningContext: {
            planningIssueId: "issue-plan-1",
            mission: { id: "mission-1", title: "Plan launch" },
            activePlan: { available: true, selectedExecutionUnitCount: 2 },
            executionSourceSnapshot: { units: [{ id: "unit-1" }] },
            planningDossier: {
              assets: {
                workflowCandidates: [{ id: "workflow-1" }, { id: "workflow-2" }],
                tools: { available: false, count: 0, labels: [] },
                runtimeServices: { available: false, count: 0, labels: [] },
                ruleRefs: [{ id: "rule-1" }],
                kbRefs: [{ id: "kb-1" }],
                agentRoster: [{ agentId: "agent-1" }, { agentId: "agent-2" }],
                fileViews: { available: false, count: 0, labels: [] },
                executionSourceSummary: { unitCount: 1, labels: ["unit-1"] },
              },
              gaps: [
                { key: "manual_planning_required", severity: "needs_research" },
                { key: "plugin_workflow_definition_reader_unconfirmed", severity: "info" },
              ],
            },
            refs: {
              selectedExecutionUnits: [
                {
                  id: "unit-1",
                  reason: "raw private rationale must not be mirrored in brief",
                  body: "raw private body must not be mirrored in brief",
                  evidenceRefs: ["secret-evidence"],
                },
              ],
            },
          },
        },
      }),
    });

    expect(brief).toContain("Mission owner planning context: mission mission-1, planning issue issue-plan-1, active plan yes, selected units 2, execution source units 1.");
    expect(brief).toContain("Owner planning protocol:");
    expect(brief).toContain("Produce a Mission Planning Assessment before acting beyond status discovery.");
    expect(brief).toContain("Missing tool/runtime-service assets do not prove that the Paperclip worker runtime is down.");
    expect(brief).toContain("Common operating boundary:");
    expect(brief).toContain("Director boundary:");
    expect(brief).toContain("internal Agent/Task/WebSearch/WebFetch/Bash as a source-research or report-production substitute");
    expect(brief).toContain("`research_needed`: name missing evidence and the intended delegation/escalation path.");
    expect(brief).toContain("`blocked`: name the missing input, authority, runtime path, or escalation path.");
    expect(brief).toContain("`ready_to_plan`: emit the structured JSON block below.");
    expect(brief).toContain("### Mission owner plan decision");
    expect(brief).toContain("```json");
    expect(brief).toContain('"decisionType": "mission_owner_plan"');
    expect(brief).toContain('"missionId": "mission-1"');
    expect(brief).toContain('"summary": "..."');
    expect(brief).toContain('"assessment"');
    expect(brief).toContain('"steps": []');
    expect(brief).toContain('"requiredInputs": []');
    expect(brief).toContain('"successCriteria": []');
    expect(brief).toContain('"risks": []');
    expect(brief).toContain('"selectedExecutionUnits": []');
    expect(brief).toContain('"ruleRefs": []');
    expect(brief).toContain('"kbRefs": []');
    expect(brief).toContain("mission-level sibling issues");
    expect(brief).toContain("Do not mark the planning issue done until a structured plan decision has been posted and materialized as mission-level sibling issues");
    expect(brief).toContain("Missing tool/runtime-service assets do not prove that the Paperclip worker runtime is down.");
    expect(brief).toContain("Planning dossier asset-count summary: workflows 2, tools 0, runtime service assets 0, rules 1, KB 1, agents 2, files 0, execution source units 1.");
    expect(brief).toContain("Planning dossier gaps: 2 total, 1 severe/blocking-or-research gaps.");
    expect(JSON.stringify(brief)).not.toContain("raw private rationale");
    expect(JSON.stringify(brief)).not.toContain("raw private body");
    expect(JSON.stringify(brief)).not.toContain("secret-evidence");
  });
});
