// @vitest-environment node

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { jsonToSteps } from "../step-draft.js";
import { GraphInspector } from "./GraphInspector.js";
import { GraphInspectorPolicyAdvanced } from "./GraphInspectorPolicyAdvanced.js";

describe("graph inspector retry policy controls", () => {
  it("shows fixed default copy and disables inactive advanced retry controls", () => {
    const [selectedStep] = jsonToSteps([{
      id: "step-1",
      title: "Step 1",
      onFailure: "skip",
      graphRetryDelaySeconds: 0,
      graphRetryBackoff: "linear",
      graphRetryJitter: true,
    }]);

    const markup = renderToStaticMarkup(createElement(GraphInspectorPolicyAdvanced, {
      selectedStep: selectedStep!,
      updateSelectedAdvanced: () => {},
    }));

    expect(markup).toContain("Fixed (default)");
    expect(markup.match(/\bdisabled=""/g)).toHaveLength(3);
    expect(markup).toContain('value="0"');
    expect(markup).toContain('value="linear" selected=""');
    expect(markup).toContain('checked=""');
  });

  it("disables max retries in the main inspector and keeps the additional attempts copy", () => {
    const [selectedStep] = jsonToSteps([{
      id: "step-1",
      title: "Step 1",
      type: "tool",
      toolName: "manual-onboarding-publish",
      toolArgs: {},
      onFailure: "skip",
      maxRetries: 4,
      graphRetryDelaySeconds: 0,
      graphRetryBackoff: "linear",
      graphRetryJitter: true,
    }]);

    const markup = renderToStaticMarkup(createElement(GraphInspector, {
      steps: [selectedStep!],
      selectedStep: selectedStep!,
      selectedContainerSummary: null,
      selectedDataFlowMap: null,
      selectedGroup: null,
      selectedPathSummary: {} as never,
      inspectorSummary: { sections: [{ mode: "policy", title: "Policy", summary: "Retry settings", badges: [] }] } as never,
      activeInspectorSection: { mode: "policy", title: "Policy", summary: "Retry settings", badges: [] } as never,
      evidenceSummary: {} as never,
      repairPlan: {} as never,
      diagnostics: {} as never,
      graphError: "",
      graphInspectorMode: "policy",
      inspectorAccent: "#fff",
      showOverviewInspector: false,
      showEditInspector: false,
      showPolicyInspector: true,
      showRawInspector: false,
      showGraphDetails: false,
      showGraphTestDrawer: false,
      showGraphEvidenceDrawer: false,
      rawStepJsonText: "",
      rawStepJsonFeedback: null,
      availableTools: [],
      availableToolGrants: [],
      graphAgents: [],
      qaCapAcceptancePolicy: { available: false, reason: "No QA loop" },
      testDrawerSlot: null,
      setGraphInspectorMode: vi.fn(),
      setShowGraphTestDrawer: vi.fn(),
      setShowGraphEvidenceDrawer: vi.fn(),
      setRawStepJsonText: vi.fn(),
      setRawStepJsonFeedback: vi.fn(),
      selectStep: vi.fn(),
      addAfter: vi.fn(),
      expandSelectedPath: vi.fn(),
      clearSelectedPath: vi.fn(),
      groupSelectedGraphSelection: vi.fn(),
      wrapSelectedGraphSelection: vi.fn(),
      wrapSelectedPathInContainer: vi.fn(),
      duplicateSelectedStep: vi.fn(),
      duplicateSelectedContainer: vi.fn(),
      clearSelectedContainer: vi.fn(),
      clearSelectedGroup: vi.fn(),
      groupSelectedWithDependencies: vi.fn(),
      setSelectedGroupCollapsed: vi.fn(),
      handleDeleteGraphObjectPointerDown: vi.fn(),
      renameSelectedStep: vi.fn(),
      updateSelected: vi.fn(),
      updateSelectedAdvanced: vi.fn(),
      updateSelectedApproval: vi.fn(),
      updateSelectedTesting: vi.fn(),
      updateSelectedExecution: vi.fn(),
      updateSelectedDataFlow: vi.fn(),
      updateSelectedResources: vi.fn(),
      updateSelectedGroupMetadata: vi.fn(),
      updateSelectedContainerMetadata: vi.fn(),
      setSelectedNote: vi.fn(),
      setQaLoopEnabled: vi.fn(),
      setQaCapAcceptance: vi.fn(),
      setQaReworkMaxIterations: vi.fn(),
      validateRawSelectedStepJson: vi.fn(),
      applyRawSelectedStepJson: vi.fn(),
    } as never));

    expect(markup).toContain('value="4"');
    expect(markup).toContain('placeholder="inactive"');
    expect(markup).toContain('aria-label="Maximum number of additional retry attempts after the initial attempt when retry is enabled. Zero disables retries."');
  });
});
