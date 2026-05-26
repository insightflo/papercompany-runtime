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
    expect(brief).toContain("Before executing, produce a Mission Planning Assessment.");
    expect(brief).toContain("objective; available workflows, tools, runtime services, rules, KB, agents, and files; active plan and prior execution refs; gaps and todo markers");
    expect(brief).toContain("`research_needed`: list missing evidence and create/request research/delegation steps.");
    expect(brief).toContain("`blocked`: list required user input/approval.");
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
    expect(brief).toContain("do not mark the planning issue done until a structured plan decision has been posted and materialized");
    expect(brief).toContain("This brief does not impose a hard completion block.");
    expect(brief).toContain("Asset counts and severe gap count are summaries only; tools/runtimeServices/fileViews may be bounded unavailable summaries, not actual discovery.");
    expect(brief).toContain("Planning dossier asset-count summary: workflows 2, tools 0, runtime services 0, rules 1, KB 1, agents 2, files 0, execution source units 1.");
    expect(brief).toContain("Planning dossier gaps: 2 total, 1 severe/blocking-or-research gaps.");
    expect(JSON.stringify(brief)).not.toContain("raw private rationale");
    expect(JSON.stringify(brief)).not.toContain("raw private body");
    expect(JSON.stringify(brief)).not.toContain("secret-evidence");
  });
});
