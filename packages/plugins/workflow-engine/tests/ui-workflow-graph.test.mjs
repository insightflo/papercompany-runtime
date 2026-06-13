import assert from "node:assert/strict";
import test from "node:test";

import * as workflowGraph from "../dist/ui/workflow-graph.js";
import {
  appendStepAfter,
  applyStepRunsToGraphSteps,
  assignStepsToContainer,
  assignStepsToGroup,
  applyWorkflowGraphFailureRoute,
  buildWorkflowGraphContainerSummary,
  buildWorkflowGraphDataFlowMap,
  buildWorkflowGraphDefinitionNavigator,
  buildWorkflowGraphEdgeImpactPreview,
  buildWorkflowGraphExecutionEvidenceSummary,
  buildWorkflowGraphFocusLensSummary,
  buildWorkflowGraphFailureRouteSummary,
  buildWorkflowGraphInspectorSummary,
  buildWorkflowGraphManagementSummary,
  buildWorkflowGraphReleaseReview,
  buildWorkflowGraphRunDebugSummary,
  buildWorkflowGraphStructurePaletteSummary,
  buildWorkflowGraphTestDrawerSummary,
  buildWorkflowGraphWorkbenchSummary,
  buildWorkflowGraphSelectionSummary,
  buildWorkflowGraphIterationTestPreview,
  buildWorkflowGraphModel,
  buildWorkflowGraphRepairPlan,
  buildWorkflowGraphRestartPreview,
  buildWorkflowGraphRequestFillPreview,
  buildWorkflowGraphSingleStepTestPreview,
  buildWorkflowGraphTestExecutionPreview,
  buildWorkflowGraphTestRequestPreview,
  buildWorkflowGraphTestPlan,
  clearWorkflowContainer,
  connectSteps,
  disconnectSteps,
  duplicateWorkflowContainer,
  duplicateWorkflowStep,
  expandWorkflowGraphSelection,
  getWorkflowGraphStepContext,
  insertWorkflowStepFromPalette,
  renameWorkflowStep,
  removeWorkflowStep,
  searchWorkflowGraphNodes,
  setStepGraphRunStatus,
  summarizeWorkflowGraphTestInputLibrary,
  summarizeWorkflowGraphTriggers,
  setGraphGroupCollapsed,
  updateGraphGroupMetadata,
  updateGraphEdgeMetadata,
  updateStepAdvancedMetadata,
  updateStepApprovalMetadata,
  updateStepDataFlowMetadata,
  updateStepExecutionMetadata,
  updateStepResourceMetadata,
  updateStepTestingMetadata,
  updateContainerMetadata,
  updateStepNote,
} from "../dist/ui/workflow-graph.js";

const steps = [
  { id: "screen", title: "Screen", type: "tool", dependsOn: "" },
  { id: "select", title: "Select", type: "agent", dependsOn: "screen" },
  { id: "report", title: "Report", type: "agent", dependsOn: "select" },
  { id: "sync", title: "Sync", type: "tool", dependsOn: "report" },
];

test("summarizeWorkflowGraphDraftDiff compares saved and draft graphs for Windmill-style diff preview", () => {
  assert.equal(typeof workflowGraph.summarizeWorkflowGraphDraftDiff, "function");

  const diff = workflowGraph.summarizeWorkflowGraphDraftDiff(steps, [
    { id: "screen", title: "Screen", type: "tool", dependsOn: "" },
    { id: "select", title: "Select", type: "agent", dependsOn: "screen" },
    { id: "report", title: "Report v2", type: "agent", dependsOn: "screen", graphRestartBoundary: true },
    { id: "publish", title: "Publish", type: "tool", dependsOn: "report" },
  ]);

  assert.equal(diff.hasChanges, true);
  assert.deepEqual(diff.addedSteps, ["publish"]);
  assert.deepEqual(diff.removedSteps, ["sync"]);
  assert.deepEqual(diff.changedSteps, [
    { id: "report", fields: ["dependsOn", "graphRestartBoundary", "title"] },
  ]);
  assert.deepEqual(diff.addedEdges, ["screen->report", "report->publish"]);
  assert.deepEqual(diff.removedEdges, ["select->report", "report->sync"]);
  assert.deepEqual(diff.changedEdges, []);
  assert.deepEqual(diff.summary, [
    "1 added step",
    "1 removed step",
    "1 changed step",
    "2 added edges",
    "2 removed edges",
  ]);
});

test("summarizeWorkflowGraphInterface normalizes flow inputs and env variables", () => {
  assert.equal(typeof workflowGraph.summarizeWorkflowGraphInterface, "function");

  const summary = workflowGraph.summarizeWorkflowGraphInterface({
    legacyMetadata: {
      graphFlowInputs: [
        { name: " ticker ", type: " string ", required: true, defaultValue: "005930", description: " Market ticker " },
        { name: "ticker", type: "number", required: false },
        { name: "", type: "string" },
      ],
      graphFlowEnvVariables: [
        { name: " SLACK_WEBHOOK ", type: "secret", value: "hooks", secret: true },
        { name: "REGION", value: "KR" },
        { name: " ", value: "skip" },
      ],
    },
  });

  assert.deepEqual(summary.inputs, [
    { name: "ticker", type: "string", required: true, defaultValue: "005930", description: "Market ticker" },
  ]);
  assert.deepEqual(summary.envVariables, [
    { name: "SLACK_WEBHOOK", type: "secret", value: "hooks", secret: true },
    { name: "REGION", type: "string", value: "KR", secret: false },
  ]);
  assert.deepEqual(summary.badges, ["1 input", "1 required input", "2 env vars", "1 secret env"]);
});

test("buildWorkflowGraphExportSnapshot serializes workflow metadata settings interface and steps", () => {
  assert.equal(typeof workflowGraph.buildWorkflowGraphExportSnapshot, "function");
  assert.equal(typeof workflowGraph.serializeWorkflowGraphExportSnapshot, "function");

  const snapshot = workflowGraph.buildWorkflowGraphExportSnapshot({
    id: "workflow-1",
    name: "Daily Signal",
    description: "Collect and publish",
    status: "active",
    schedule: "0 7 * * 1-5",
    timezone: "Asia/Seoul",
    triggerLabels: ["daily", "signals"],
    legacyMetadata: {
      graphFlowInputs: [{ name: "market", type: "string", required: true }],
      graphFlowEnvVariables: [{ name: "SLACK_WEBHOOK", type: "secret", secret: true }],
    },
    steps,
  });

  assert.deepEqual(snapshot.metadata, {
    id: "workflow-1",
    name: "Daily Signal",
    description: "Collect and publish",
    status: "active",
  });
  assert.deepEqual(snapshot.settings, {
    schedule: "0 7 * * 1-5",
    timezone: "Asia/Seoul",
    triggerLabels: ["daily", "signals"],
  });
  assert.deepEqual(snapshot.flowInterface.inputs, [
    { name: "market", type: "string", required: true, defaultValue: "", description: "" },
  ]);
  assert.deepEqual(snapshot.flowInterface.envVariables, [
    { name: "SLACK_WEBHOOK", type: "secret", value: "", secret: true },
  ]);
  assert.deepEqual(snapshot.steps, steps);

  const json = workflowGraph.serializeWorkflowGraphExportSnapshot(snapshot, "json");
  assert.equal(JSON.parse(json).metadata.name, "Daily Signal");

  const yaml = workflowGraph.serializeWorkflowGraphExportSnapshot(snapshot, "yaml");
  assert.match(yaml, /metadata:/);
  assert.match(yaml, /name: Daily Signal/);
  assert.match(yaml, /flowInterface:/);
  assert.match(yaml, /steps:/);
});

test("parseWorkflowGraphYamlDraft applies Windmill-style YAML edits to workflow draft fields", () => {
  assert.equal(typeof workflowGraph.parseWorkflowGraphYamlDraft, "function");

  const draft = workflowGraph.parseWorkflowGraphYamlDraft(`
formatVersion: 1
metadata:
  id: workflow-1
  name: Daily Signal v2
  description: Updated from YAML
  status: paused
settings:
  schedule: "15 8 * * 1-5"
  timezone: Asia/Seoul
  triggerLabels:
    - daily
    - yaml
flowInterface:
  inputs:
    - name: market
      type: string
      required: true
      defaultValue: KR
      description: Market scope
  envVariables:
    - name: REGION
      type: string
      value: KR
      secret: false
steps:
  - id: screen
    title: Screen v2
    type: tool
    dependsOn: []
  - id: publish
    title: Publish
    type: agent
    dependsOn:
      - screen
`);

  assert.equal(draft.error, "");
  assert.equal(draft.snapshot.metadata.name, "Daily Signal v2");
  assert.equal(draft.snapshot.metadata.status, "paused");
  assert.deepEqual(draft.snapshot.settings.triggerLabels, ["daily", "yaml"]);
  assert.deepEqual(draft.snapshot.flowInterface.inputs, [
    { name: "market", type: "string", required: true, defaultValue: "KR", description: "Market scope" },
  ]);
  assert.deepEqual(draft.snapshot.flowInterface.envVariables, [
    { name: "REGION", type: "string", value: "KR", secret: false },
  ]);
  assert.deepEqual(draft.snapshot.steps, [
    { id: "screen", title: "Screen v2", type: "tool", dependsOn: [] },
    { id: "publish", title: "Publish", type: "agent", dependsOn: ["screen"] },
  ]);
});

test("buildWorkflowGraphTestPlan scopes a Windmill-style test run up to a target step", () => {
  assert.equal(typeof workflowGraph.buildWorkflowGraphTestPlan, "function");

  const plan = buildWorkflowGraphTestPlan(steps, "report");

  assert.equal(plan.targetStepId, "report");
  assert.deepEqual(plan.stepIds, ["screen", "select", "report"]);
  assert.deepEqual(plan.excludedStepIds, ["sync"]);
  assert.deepEqual(plan.missingDependencyIds, []);
  assert.equal(plan.blocked, false);
  assert.deepEqual(plan.badges, ["Test 3 steps", "Stop at report", "Skip 1 downstream"]);
  assert.equal(plan.summary, "Test will run 3 steps through report and skip 1 downstream step.");
});

test("buildWorkflowGraphTestRequestPreview builds safe flow input and env payloads for editor tests", () => {
  assert.equal(typeof workflowGraph.buildWorkflowGraphTestRequestPreview, "function");

  const preview = buildWorkflowGraphTestRequestPreview({
    graphFlowInputs: [
      { name: "market", type: "string", required: true, defaultValue: "KR", description: "Market scope" },
      { name: "limit", type: "number", defaultValue: "5" },
      { name: "dryRun", type: "boolean", defaultValue: "true" },
      { name: "filters", type: "json", defaultValue: "{\"sector\":\"tech\"}" },
    ],
    graphFlowEnvVariables: [
      { name: "REGION", type: "string", value: "KR" },
      { name: "SLACK_WEBHOOK", type: "secret", value: "https://hooks.example.test/secret" },
    ],
  });

  assert.deepEqual(preview.arguments, {
    market: "KR",
    limit: 5,
    dryRun: true,
    filters: { sector: "tech" },
  });
  assert.deepEqual(preview.envPreview, {
    REGION: "KR",
    SLACK_WEBHOOK: "<secret>",
  });
  assert.deepEqual(preview.requiredInputNames, ["market"]);
  assert.deepEqual(preview.badges, ["4 args", "1 required", "2 env vars", "1 secret"]);
  assert.equal(
    preview.requestJson,
    "{\n  \"args\": {\n    \"market\": \"KR\",\n    \"limit\": 5,\n    \"dryRun\": true,\n    \"filters\": {\n      \"sector\": \"tech\"\n    }\n  },\n  \"env\": {\n    \"REGION\": \"KR\",\n    \"SLACK_WEBHOOK\": \"<secret>\"\n  }\n}\n",
  );
});

test("summarizeWorkflowGraphTestInputLibrary normalizes saved inputs and applies them to request preview", () => {
  assert.equal(typeof workflowGraph.summarizeWorkflowGraphTestInputLibrary, "function");

  const input = {
    graphFlowInputs: [
      { name: "market", type: "string", defaultValue: "US" },
      { name: "limit", type: "number", defaultValue: "5" },
      { name: "dryRun", type: "boolean", defaultValue: "false" },
    ],
    legacyMetadata: {
      graphTestInputPresets: [
        { name: "KR close", args: { market: "KR", limit: 10 } },
        { name: "  ", args: { market: "skip" } },
        { name: "KR close", args: { market: "duplicate" } },
        { title: "US smoke", request: { args: { dryRun: true } } },
      ],
    },
  };

  const library = summarizeWorkflowGraphTestInputLibrary(input);

  assert.deepEqual(library.presets.map((preset) => preset.name), ["KR close", "US smoke"]);
  assert.deepEqual(library.presets[0].args, { market: "KR", limit: 10 });
  assert.deepEqual(library.presets[1].args, { dryRun: true });
  assert.deepEqual(library.badges, ["2 saved inputs"]);

  const preview = buildWorkflowGraphTestRequestPreview(input, "KR close");
  assert.deepEqual(preview.arguments, { market: "KR", limit: 10, dryRun: false });
  assert.deepEqual(preview.badges, ["3 args", "Preset KR close"]);
  assert.match(preview.requestJson, /"market": "KR"/);
  assert.match(preview.requestJson, /"limit": 10/);
});

test("buildWorkflowGraphRequestFillPreview extracts flow args from a pasted request", () => {
  assert.equal(typeof workflowGraph.buildWorkflowGraphRequestFillPreview, "function");

  const preview = buildWorkflowGraphRequestFillPreview({
    graphFlowInputs: [
      { name: "market", type: "string", defaultValue: "US", required: true },
      { name: "limit", type: "number", defaultValue: "5" },
      { name: "dryRun", type: "boolean", defaultValue: "false" },
    ],
  }, JSON.stringify({
    body: {
      market: "KR",
      limit: 10,
      extra: "ignored",
    },
    query: {
      dryRun: true,
    },
  }));

  assert.equal(preview.error, undefined);
  assert.deepEqual(preview.arguments, { market: "KR", limit: 10, dryRun: true });
  assert.deepEqual(preview.matchedInputNames, ["market", "limit", "dryRun"]);
  assert.deepEqual(preview.extraArgumentNames, ["extra"]);
  assert.deepEqual(preview.missingRequiredInputNames, []);
  assert.deepEqual(preview.badges, ["3 matched", "1 extra ignored"]);
  assert.match(preview.requestJson, /"market": "KR"/);
  assert.match(preview.requestJson, /"dryRun": true/);

  const invalid = buildWorkflowGraphRequestFillPreview({ graphFlowInputs: [{ name: "market", type: "string", required: true }] }, "{");
  assert.match(invalid.error ?? "", /JSON 파싱 실패/);
  assert.deepEqual(invalid.missingRequiredInputNames, ["market"]);
  assert.deepEqual(invalid.badges, ["Invalid request JSON", "1 missing required"]);
});

test("buildWorkflowGraphSingleStepTestPreview pre-fills step inputs from flow args and upstream test results", () => {
  assert.equal(typeof workflowGraph.buildWorkflowGraphSingleStepTestPreview, "function");

  const preview = buildWorkflowGraphSingleStepTestPreview([
    {
      id: "screen",
      title: "Screen",
      type: "tool",
      dependsOn: "",
      graphMockEnabled: true,
      graphMockResult: '{ "symbols": ["005930"] }',
    },
    {
      id: "select",
      title: "Select",
      type: "agent",
      dependsOn: "screen",
      toolArgs: '{ "limit": 3 }',
      graphInputExpression: '{ "candidates": results.screen.symbols, "market": flow_input.market }',
    },
    {
      id: "publish",
      title: "Publish",
      type: "tool",
      dependsOn: "select",
      graphPinnedResultRunId: "run-123",
    },
  ], "select", {
    graphFlowInputs: [
      { name: "market", type: "string", defaultValue: "US", required: true },
      { name: "dryRun", type: "boolean", defaultValue: "false" },
    ],
  }, { market: "KR" });

  assert.equal(preview.stepId, "select");
  assert.equal(preview.blocked, false);
  assert.deepEqual(preview.upstreamContextStepIds, ["screen"]);
  assert.deepEqual(preview.downstreamStepIds, ["publish"]);
  assert.deepEqual(preview.flowArguments, { market: "KR", dryRun: false });
  assert.deepEqual(preview.stepArguments, { limit: 3 });
  assert.equal(preview.inputExpression, '{ "candidates": results.screen.symbols, "market": flow_input.market }');
  assert.deepEqual(preview.contextResults.map((result) => [result.stepId, result.mode, result.value]), [
    ["screen", "mocked", { symbols: ["005930"] }],
  ]);
  assert.deepEqual(preview.badges, ["Test step select", "1 upstream context", "1 mocked upstream", "1 downstream skipped"]);
  assert.match(preview.requestJson, /"market": "KR"/);
  assert.match(preview.requestJson, /"screen"/);

  const blocked = buildWorkflowGraphSingleStepTestPreview([
    { id: "orphan", title: "Orphan", type: "agent", dependsOn: "missing" },
  ], "orphan", {});
  assert.equal(blocked.blocked, true);
  assert.deepEqual(blocked.missingDependencyIds, ["missing"]);
  assert.deepEqual(blocked.badges, ["Test step orphan", "1 missing dependency", "Blocked"]);
});

test("buildWorkflowGraphIterationTestPreview scopes a Windmill-style loop iteration test", () => {
  assert.equal(typeof workflowGraph.buildWorkflowGraphIterationTestPreview, "function");

  const looped = assignStepsToContainer([
    { id: "collect", title: "Collect", type: "tool", dependsOn: "" },
    { id: "score", title: "Score", type: "agent", dependsOn: "collect" },
    { id: "publish", title: "Publish", type: "tool", dependsOn: "score" },
  ], ["score", "publish"], {
    id: "market-loop",
    type: "loop",
    title: "Market loop",
    mode: "for-each",
    iterator: "flow_input.markets",
    runInParallel: true,
    parallelism: 3,
    skipFailure: true,
  });

  const preview = buildWorkflowGraphIterationTestPreview(looped, "market-loop", 2, { market: "KR", date: "2026-06-13" });

  assert.equal(preview.containerId, "market-loop");
  assert.equal(preview.blocked, false);
  assert.equal(preview.iterationIndex, 2);
  assert.deepEqual(preview.iterationValue, { market: "KR", date: "2026-06-13" });
  assert.deepEqual(preview.stepIds, ["score", "publish"]);
  assert.deepEqual(preview.skippedStepIds, ["collect"]);
  assert.equal(preview.iteratorExpression, "flow_input.markets");
  assert.deepEqual(preview.badges, ["Iteration 2", "2 loop steps", "Iterator flow_input.markets", "Parallel x3", "Skip failure"]);
  assert.match(preview.requestJson, /"market": "KR"/);
  assert.match(preview.requestJson, /"score"/);

  const missing = buildWorkflowGraphIterationTestPreview(looped, "missing-loop", 0);
  assert.equal(missing.blocked, true);
  assert.deepEqual(missing.badges, ["No loop container", "Blocked"]);
});

test("buildWorkflowGraphTestExecutionPreview explains Windmill-style step test execution modes", () => {
  assert.equal(typeof workflowGraph.buildWorkflowGraphTestExecutionPreview, "function");

  const preview = buildWorkflowGraphTestExecutionPreview([
    { id: "screen", title: "Screen", type: "tool", dependsOn: "" },
    { id: "select", title: "Select", type: "agent", dependsOn: "screen", graphMockEnabled: true, graphMockResult: '{ "signal": "hold" }' },
    { id: "report", title: "Report", type: "agent", dependsOn: "select", graphPinnedResultRunId: "run-123" },
    { id: "sync", title: "Sync", type: "tool", dependsOn: "report" },
    { id: "orphan", title: "Orphan", type: "agent", dependsOn: "missing" },
  ], "report");

  assert.deepEqual(preview.steps.map((step) => [step.stepId, step.mode, step.badges]), [
    ["screen", "will-run", ["Runs in test"]],
    ["select", "mocked", ["Mocked", "Mock result"]],
    ["report", "pinned", ["Pinned result", "run-123"]],
    ["sync", "skipped", ["Skipped downstream"]],
    ["orphan", "blocked", ["Missing dependency"]],
  ]);
  assert.deepEqual(preview.badges, ["3 included", "1 mock", "1 pinned", "1 skipped", "1 blocked"]);
  assert.equal(preview.summary, "Test preview includes 3 steps, uses 1 mock, replays 1 pinned result, skips 1 downstream step, and blocks 1 step with missing dependencies.");
});

test("buildWorkflowGraphRestartPreview explains Windmill-style restart from step reuse and rerun boundaries", () => {
  assert.equal(typeof workflowGraph.buildWorkflowGraphRestartPreview, "function");

  const preview = buildWorkflowGraphRestartPreview([
    { id: "screen", title: "Screen", type: "tool", dependsOn: "" },
    { id: "select", title: "Select", type: "agent", dependsOn: "screen" },
    { id: "report", title: "Report", type: "agent", dependsOn: "select" },
    { id: "sync", title: "Sync", type: "tool", dependsOn: "report" },
    { id: "orphan", title: "Orphan", type: "agent", dependsOn: "missing" },
  ], "report");

  assert.equal(preview.restartStepId, "report");
  assert.deepEqual(preview.reusedStepIds, ["screen", "select"]);
  assert.deepEqual(preview.rerunStepIds, ["report", "sync"]);
  assert.deepEqual(preview.blockedStepIds, ["orphan"]);
  assert.equal(preview.blocked, false);
  assert.deepEqual(preview.steps.map((step) => [step.stepId, step.mode, step.badges]), [
    ["screen", "reused", ["Reuse previous result"]],
    ["select", "reused", ["Reuse previous result"]],
    ["report", "rerun", ["Restart here"]],
    ["sync", "rerun", ["Rerun downstream"]],
    ["orphan", "blocked", ["Missing dependency"]],
  ]);
  assert.deepEqual(preview.badges, ["Reuse 2 previous", "Rerun 2 steps", "1 blocked outside restart"]);
  assert.equal(preview.summary, "Restart from report will reuse 2 previous steps and rerun 2 steps.");

  const missingTarget = buildWorkflowGraphRestartPreview(steps, "missing");
  assert.equal(missingTarget.blocked, true);
  assert.deepEqual(missingTarget.badges, ["No restart step", "Blocked"]);
});

test("buildWorkflowGraphRunDebugSummary focuses failed running and unavailable run detail states", () => {
  assert.equal(typeof workflowGraph.buildWorkflowGraphRunDebugSummary, "function");

  const failed = buildWorkflowGraphRunDebugSummary({
    steps,
    stepRuns: [
      {
        id: "run-screen",
        stepId: "screen",
        status: "succeeded",
        issueId: "issue-1",
        workProducts: [{ id: "wp-1", title: "Report", type: "html" }],
      },
      { id: "run-select", stepId: "select", status: "succeeded", issueIdentifier: "PAP-1" },
      { id: "run-report", stepId: "report", status: "failed", lastDispatchErrorSummary: "Agent timeout" },
    ],
  });

  assert.equal(failed.available, true);
  assert.equal(failed.focusStepId, "report");
  assert.equal(failed.title, "Focus failed step");
  assert.equal(failed.tone, "danger");
  assert.deepEqual(failed.counts, {
    total: 4,
    planned: 1,
    running: 0,
    succeeded: 2,
    failed: 1,
    skipped: 0,
    paused: 0,
    issues: 2,
    workProducts: 1,
  });
  assert.equal(failed.restartPreview.restartStepId, "report");
  assert.deepEqual(failed.restartPreview.reusedStepIds, ["screen", "select"]);
  assert.deepEqual(failed.restartPreview.rerunStepIds, ["report", "sync"]);
  assert.deepEqual(failed.tiles.map((tile) => tile.id), ["completed", "failure", "restart", "evidence"]);
  assert.equal(failed.tiles[1].tone, "danger");
  assert.equal(failed.tiles[1].summary, "Agent timeout");
  assert.equal(failed.tiles[3].status, "2 issues");

  const running = buildWorkflowGraphRunDebugSummary({
    steps,
    stepRuns: [{ id: "run-select", stepId: "select", status: "running", agentName: "analyst" }],
  });

  assert.equal(running.available, true);
  assert.equal(running.focusStepId, "select");
  assert.equal(running.title, "Follow running step");
  assert.equal(running.tone, "info");
  assert.equal(running.tiles[1].tone, "info");

  const empty = buildWorkflowGraphRunDebugSummary({ steps, stepRuns: [] });
  assert.equal(empty.available, false);
  assert.equal(empty.title, "Run detail unavailable");
  assert.equal(empty.tone, "warning");
});

test("buildWorkflowGraphModel converts workflow step dependencies into layered graph nodes and edges", () => {
  const graph = buildWorkflowGraphModel(steps);

  assert.deepEqual(
    graph.edges.map((edge) => `${edge.source}->${edge.target}`),
    ["screen->select", "select->report", "report->sync"],
  );
  assert.deepEqual(
    graph.nodes.map((node) => [node.id, node.layer]),
    [
      ["screen", 0],
      ["select", 1],
      ["report", 2],
      ["sync", 3],
    ],
  );
});

test("buildWorkflowGraphModel preserves manually positioned graph nodes", () => {
  const graph = buildWorkflowGraphModel([
    { id: "screen", title: "Screen", type: "tool", graphPositionX: 320, graphPositionY: 180 },
    { id: "select", title: "Select", type: "agent", dependsOn: "screen", graphPositionX: "580", graphPositionY: "220" },
  ]);

  assert.deepEqual(
    graph.nodes.map((node) => [node.id, node.x, node.y]),
    [
      ["screen", 320, 180],
      ["select", 580, 220],
    ],
  );
});

test("buildWorkflowGraphModel ignores blank manual graph positions", () => {
  const graph = buildWorkflowGraphModel([
    { id: "screen", title: "Screen", type: "tool", graphPositionX: "", graphPositionY: "" },
    { id: "select", title: "Select", type: "agent", dependsOn: "screen", graphPositionX: "", graphPositionY: "" },
  ]);

  assert.deepEqual(
    graph.nodes.map((node) => [node.id, node.x, node.y]),
    [
      ["screen", 48, 44],
      ["select", 278, 44],
    ],
  );
});

test("buildWorkflowGraphModel exposes actionable graph diagnostics for flow management", () => {
  const graph = buildWorkflowGraphModel([
    { id: "entry", title: "Entry", type: "tool", dependsOn: "" },
    { id: "sink", title: "Sink", type: "agent", dependsOn: "entry" },
    { id: "orphan", title: "Orphan", type: "agent", dependsOn: "missing-upstream" },
    { id: "cycle-a", title: "Cycle A", type: "agent", dependsOn: "cycle-b" },
    { id: "cycle-b", title: "Cycle B", type: "agent", dependsOn: "cycle-a" },
    { id: "", title: "Untitled", type: "agent", dependsOn: "" },
  ]);

  assert.deepEqual(graph.diagnostics.entryStepIds, ["entry", "orphan"]);
  assert.deepEqual(graph.diagnostics.terminalStepIds, ["sink", "orphan"]);
  assert.deepEqual(graph.diagnostics.issueCountBySeverity, {
    error: 3,
    warning: 0,
    info: 0,
  });
  assert.deepEqual(
    graph.diagnostics.issues.map((issue) => [issue.code, issue.stepId, issue.sourceId]),
    [
      ["missing-dependency", "orphan", "missing-upstream"],
      ["missing-step-id", undefined, undefined],
      ["cycle", "cycle-a", undefined],
    ],
  );
  assert.deepEqual(graph.warnings, graph.diagnostics.issues.map((issue) => issue.message));
});

test("buildWorkflowGraphRepairPlan converts diagnostics into graph editor repair actions", () => {
  assert.equal(typeof workflowGraph.buildWorkflowGraphRepairPlan, "function");

  const plan = buildWorkflowGraphRepairPlan([
    { id: "entry", title: "Entry", type: "tool", dependsOn: "" },
    { id: "sink", title: "Sink", type: "agent", dependsOn: "entry" },
    { id: "orphan", title: "Orphan", type: "agent", dependsOn: "missing-upstream" },
    { id: "cycle-a", title: "Cycle A", type: "agent", dependsOn: "cycle-b" },
    { id: "cycle-b", title: "Cycle B", type: "agent", dependsOn: "cycle-a" },
    { id: "", title: "Untitled", type: "agent", dependsOn: "" },
  ]);

  assert.equal(plan.blocked, true);
  assert.deepEqual(plan.badges, ["3 repairs", "3 blocking"]);
  assert.deepEqual(
    plan.items.map((item) => [item.issueCode, item.action, item.focusStepId, item.sourceStepId, item.targetStepId, item.badges]),
    [
      ["missing-dependency", "connect-or-remove-dependency", "orphan", "missing-upstream", "orphan", ["Missing upstream", "Blocks run"]],
      ["missing-step-id", "assign-step-id", "", undefined, undefined, ["Invalid step", "Blocks run"]],
      ["cycle", "disconnect-cycle-edge", "cycle-a", undefined, "cycle-a", ["Cycle", "Blocks run"]],
    ],
  );
  assert.match(plan.summary, /3 graph repairs needed before this workflow can run/);

  const clean = buildWorkflowGraphRepairPlan(steps);
  assert.equal(clean.blocked, false);
  assert.deepEqual(clean.items, []);
  assert.deepEqual(clean.badges, ["No repairs"]);
});

test("summarizeWorkflowGraphTriggers normalizes schedule, label triggers, and scheduler health for the graph header", () => {
  const summary = summarizeWorkflowGraphTriggers({
    schedule: " 0 9 * * 1-5 ",
    timezone: " Asia/Seoul ",
    triggerLabels: [" daily-close ", "", " gazua "],
    lastScheduledRunAt: "2026-06-13T09:00:00.000Z",
    lastScheduleError: "queue unavailable",
    lastScheduleErrorAt: "2026-06-13T09:01:00.000Z",
  });

  assert.equal(summary.enabled, true);
  assert.deepEqual(summary.schedule, {
    cron: "0 9 * * 1-5",
    timezone: "Asia/Seoul",
    lastRunAt: "2026-06-13T09:00:00.000Z",
    error: "queue unavailable",
    errorAt: "2026-06-13T09:01:00.000Z",
  });
  assert.deepEqual(summary.labels, ["daily-close", "gazua"]);
  assert.deepEqual(summary.badges, ["Cron", "Asia/Seoul", "2 labels", "Schedule error"]);
  assert.equal(summary.status, "error");
  assert.equal(summary.description, "Cron 0 9 * * 1-5 · Labels daily-close, gazua");

  assert.deepEqual(summarizeWorkflowGraphTriggers({}).badges, ["Manual"]);
});

test("getWorkflowGraphStepContext exposes direct and transitive dependency paths for selected steps", () => {
  const pathSteps = [
    { id: "screen", title: "Screen", type: "tool", dependsOn: "" },
    { id: "select", title: "Select", type: "agent", dependsOn: "screen" },
    { id: "report", title: "Report", type: "agent", dependsOn: "select" },
    { id: "validate", title: "Validate", type: "agent", dependsOn: "screen" },
    { id: "publish", title: "Publish", type: "tool", dependsOn: ["report", "validate"] },
    { id: "archive", title: "Archive", type: "tool", dependsOn: "publish" },
  ];

  const publishContext = getWorkflowGraphStepContext(pathSteps, "publish");
  assert.deepEqual(publishContext.directDependencyIds, ["report", "validate"]);
  assert.deepEqual(publishContext.upstreamStepIds, ["screen", "select", "report", "validate"]);
  assert.deepEqual(publishContext.directDependentIds, ["archive"]);
  assert.deepEqual(publishContext.downstreamStepIds, ["archive"]);
  assert.deepEqual(publishContext.missingDependencyIds, []);

  const screenContext = getWorkflowGraphStepContext(pathSteps, "screen");
  assert.deepEqual(screenContext.directDependencyIds, []);
  assert.deepEqual(screenContext.directDependentIds, ["select", "validate"]);
  assert.deepEqual(screenContext.downstreamStepIds, ["select", "report", "validate", "publish", "archive"]);

  const orphanContext = getWorkflowGraphStepContext([
    { id: "orphan", title: "Orphan", type: "agent", dependsOn: "missing" },
  ], "orphan");
  assert.deepEqual(orphanContext.directDependencyIds, []);
  assert.deepEqual(orphanContext.missingDependencyIds, ["missing"]);
});

test("connectSteps edits dependsOn while rejecting duplicate, self, and cyclic edges", () => {
  const connected = connectSteps(steps, "screen", "report");
  assert.equal(connected.find((step) => step.id === "report")?.dependsOn, "select, screen");

  assert.equal(connectSteps(connected, "screen", "report"), connected);
  assert.throws(() => connectSteps(steps, "report", "report"), /itself/);
  assert.throws(() => connectSteps(steps, "sync", "screen"), /cycle/);
});

test("buildWorkflowGraphEdgeImpactPreview explains add and remove edge impact before graph edits", () => {
  assert.equal(typeof workflowGraph.buildWorkflowGraphEdgeImpactPreview, "function");

  const add = buildWorkflowGraphEdgeImpactPreview(steps, "screen", "report", "connect");
  assert.equal(add.blocked, false);
  assert.equal(add.action, "connect");
  assert.deepEqual(add.impactedStepIds, ["report", "sync"]);
  assert.deepEqual(add.badges, ["Connect edge", "2 impacted"]);
  assert.match(add.summary, /Connecting screen -> report will affect report, sync/);

  const remove = buildWorkflowGraphEdgeImpactPreview(steps, "select", "report", "disconnect");
  assert.equal(remove.blocked, false);
  assert.equal(remove.action, "disconnect");
  assert.deepEqual(remove.impactedStepIds, ["report", "sync"]);
  assert.deepEqual(remove.badges, ["Remove edge", "2 impacted"]);

  const cycle = buildWorkflowGraphEdgeImpactPreview(steps, "sync", "screen", "connect");
  assert.equal(cycle.blocked, true);
  assert.deepEqual(cycle.badges, ["Cycle risk", "Blocked"]);

  const missing = buildWorkflowGraphEdgeImpactPreview(steps, "missing", "report", "connect");
  assert.equal(missing.blocked, true);
  assert.deepEqual(missing.badges, ["Missing step", "Blocked"]);
});

test("buildWorkflowGraphInspectorSummary keeps graph editor controls grouped by intent", () => {
  assert.equal(typeof workflowGraph.buildWorkflowGraphInspectorSummary, "function");

  const enriched = updateStepDataFlowMetadata(
    updateStepAdvancedMetadata(steps, "report", {
      onFailure: "retry",
      maxRetries: 2,
    }),
    "report",
    {
      inputExpression: "select.result",
      workProductRequired: true,
    },
  );

  const summary = buildWorkflowGraphInspectorSummary(enriched, "report", ["select", "report"]);

  assert.equal(summary.defaultMode, "overview");
  assert.deepEqual(summary.sections.map((section) => section.mode), ["overview", "edit", "policy", "raw"]);
  assert.deepEqual(summary.sections[0].badges, ["No repairs", "2 selected"]);
  assert.deepEqual(summary.sections[1].badges, ["1 upstream", "1 downstream"]);
  assert.deepEqual(summary.sections[2].badges, ["4 policies"]);
  assert.deepEqual(summary.sections[3].badges, ["JSON", "report"]);
  assert.match(summary.sections[0].summary, /Graph is structurally clear/);
  assert.match(summary.sections[1].summary, /report has 1 upstream and 1 downstream/);
  assert.match(summary.sections[2].summary, /4 advanced controls/);
  assert.match(summary.sections[3].summary, /Raw step JSON for report/);
});

test("buildWorkflowGraphFocusLensSummary compresses selected node path controls and runtime evidence", () => {
  assert.equal(typeof workflowGraph.buildWorkflowGraphFocusLensSummary, "function");

  const enriched = applyStepRunsToGraphSteps(
    updateStepDataFlowMetadata(
      updateStepAdvancedMetadata(steps, "report", {
        onFailure: "retry",
        maxRetries: 2,
      }),
      "report",
      {
        inputExpression: "select.result",
        workProductRequired: true,
      },
    ),
    [{
      id: "run-report",
      stepId: "report",
      status: "succeeded",
      issueIdentifier: "PAP-42",
      workProducts: [{ id: "wp-1", title: "HTML report" }],
    }],
  );

  const summary = buildWorkflowGraphFocusLensSummary(enriched, "report", ["select", "report"]);

  assert.equal(summary.selectedStepId, "report");
  assert.equal(summary.title, "Report");
  assert.equal(summary.detailsHiddenByDefault, true);
  assert.equal(summary.tone, "warning");
  assert.deepEqual(summary.metrics.map((metric) => metric.id), ["step", "path", "controls", "runtime"]);
  assert.deepEqual(summary.metrics.map((metric) => metric.value), ["agent", "1 upstream / 1 next", "4 policies", "1 outputs"]);
  assert.deepEqual(summary.actions.map((action) => [action.id, action.label, Boolean(action.disabled)]), [
    ["edit", "Edit", false],
    ["test", "Test", false],
    ["evidence", "Evidence", false],
    ["policy", "Policy", false],
    ["raw", "Raw", false],
    ["add-after", "Add after", false],
    ["diagnostics", "Health", false],
  ]);
  assert.ok(summary.badges.includes("issue PAP-42"));
  assert.match(summary.description, /Details stay available/);

  const failed = buildWorkflowGraphFocusLensSummary(
    applyStepRunsToGraphSteps(steps, [{ id: "run-report", stepId: "report", status: "failed" }]),
    "report",
  );
  assert.equal(failed.tone, "danger");
  assert.equal(failed.metrics.find((metric) => metric.id === "runtime")?.tone, "danger");

  const empty = buildWorkflowGraphFocusLensSummary([], "");
  assert.equal(empty.tone, "neutral");
  assert.equal(empty.actions.find((action) => action.id === "edit")?.disabled, true);
});

test("buildWorkflowGraphExecutionEvidenceSummary opens selected node run evidence without raw JSON", () => {
  assert.equal(typeof workflowGraph.buildWorkflowGraphExecutionEvidenceSummary, "function");

  const enriched = applyStepRunsToGraphSteps(steps, [{
    id: "run-report",
    stepId: "report",
    status: "succeeded",
    issueId: "issue-42",
    issueIdentifier: "PAP-42",
    startedAt: "2026-06-13T08:00:00.000Z",
    completedAt: "2026-06-13T08:01:00.000Z",
    lastDispatchAcceptedAt: "2026-06-13T08:00:03.000Z",
    lastDispatchRequestId: "dispatch-1",
    workProducts: [{ id: "wp-1", title: "HTML report", isPrimary: true, summary: "Published dashboard." }],
    metadata: {
      resultPreview: "{\"ok\":true}",
      logPreview: "registered work product",
    },
  }]);

  const summary = buildWorkflowGraphExecutionEvidenceSummary(enriched, "report");

  assert.equal(summary.selectedStepId, "report");
  assert.equal(summary.title, "Report");
  assert.equal(summary.available, true);
  assert.equal(summary.tone, "success");
  assert.ok(summary.badges.includes("step run run-report"));
  assert.ok(summary.badges.includes("issue PAP-42"));
  assert.ok(summary.badges.includes("1 output"));
  assert.deepEqual(summary.metrics.map((metric) => metric.id), ["status", "issue", "dispatch", "outputs"]);
  assert.deepEqual(summary.metrics.map((metric) => metric.value), ["succeeded", "PAP-42", "accepted", "1"]);
  assert.equal(summary.resultPreview, "{\"ok\":true}");
  assert.equal(summary.logPreview, "registered work product");
  assert.equal(summary.workProducts[0]?.title, "HTML report");

  const empty = buildWorkflowGraphExecutionEvidenceSummary(steps, "report");
  assert.equal(empty.available, false);
  assert.match(empty.summary, /no run evidence yet/);
});

test("buildWorkflowGraphTestDrawerSummary exposes graph-attached test modes without replacing the graph", () => {
  assert.equal(typeof workflowGraph.buildWorkflowGraphTestDrawerSummary, "function");

  const looped = assignStepsToContainer(steps, ["select", "report"], {
    id: "review_loop",
    type: "loop",
    title: "Review Loop",
    iterator: "input.items",
  });

  const summary = buildWorkflowGraphTestDrawerSummary(looped, "report", {
    graphTestInputPresets: [{ name: "KR daily", args: { market: "KR", runDate: "2026-06-13" } }],
  });

  assert.equal(summary.selectedStepId, "report");
  assert.equal(summary.title, "Report");
  assert.equal(summary.tone, "info");
  assert.ok(summary.badges.includes("test ready"));
  assert.ok(summary.badges.includes("restartable"));
  assert.ok(summary.badges.includes("1 saved input"));
  assert.deepEqual(summary.modes.map((mode) => mode.id), ["test-flow", "test-step", "restart", "iteration", "inputs"]);
  assert.match(summary.modes.find((mode) => mode.id === "test-flow")?.summary ?? "", /will run/);
  assert.match(summary.modes.find((mode) => mode.id === "restart")?.summary ?? "", /Restart/);
  assert.match(summary.modes.find((mode) => mode.id === "inputs")?.summary ?? "", /saved input preset/);
});

test("buildWorkflowGraphStructurePaletteSummary exposes Windmill-style graph structure commands", () => {
  assert.equal(typeof workflowGraph.buildWorkflowGraphStructurePaletteSummary, "function");

  const summary = buildWorkflowGraphStructurePaletteSummary(steps, "report", ["select", "report"], true);

  assert.equal(summary.selectedStepId, "report");
  assert.equal(summary.title, "Report");
  assert.equal(summary.tone, "info");
  assert.ok(summary.badges.includes("agent"));
  assert.ok(summary.badges.includes("2 selected"));
  assert.deepEqual(summary.addActions.map((action) => action.id), ["agent", "tool", "branch", "loop", "approval", "failure-handler"]);
  assert.deepEqual(summary.transformActions.map((action) => action.id), ["group", "branch-wrap", "loop-wrap", "route-failure"]);
  assert.equal(summary.addActions.find((action) => action.id === "approval")?.description, "Suspend execution for governed human review.");
  assert.equal(summary.transformActions.find((action) => action.id === "route-failure")?.disabled, true);
  assert.match(summary.transformActions.find((action) => action.id === "route-failure")?.description ?? "", /failure handler/);

  const empty = buildWorkflowGraphStructurePaletteSummary([], "", [], false);
  assert.equal(empty.tone, "warning");
  assert.equal(empty.addActions.find((action) => action.id === "agent")?.disabled, false);
  assert.equal(empty.transformActions.find((action) => action.id === "group")?.disabled, true);
  assert.match(empty.summary, /Start this workflow/);
});

test("buildWorkflowGraphWorkbenchSummary keeps graph-first command and status strips compact", () => {
  assert.equal(typeof workflowGraph.buildWorkflowGraphWorkbenchSummary, "function");

  const summary = buildWorkflowGraphWorkbenchSummary(steps, "report", ["screen", "select", "report"]);

  assert.equal(summary.selectedStepId, "report");
  assert.deepEqual(summary.commandGroups.map((group) => group.id), ["canvas", "add", "path"]);
  assert.deepEqual(summary.commandGroups[0].actions.map((action) => action.id), ["fit-canvas", "actual-size", "center-selected", "diagnostics"]);
  assert.deepEqual(summary.commandGroups[1].actions.map((action) => action.id), ["agent", "tool", "branch", "loop", "approval", "failure-handler"]);
  assert.deepEqual(summary.commandGroups[2].actions.map((action) => action.id), ["upstream", "downstream", "connected", "group", "branch-wrap", "loop-wrap", "route-failure"]);
  assert.deepEqual(summary.statusBadges, ["0 errors", "1 entry", "1 terminal", "3 selected"]);
  assert.match(summary.pathSummary, /screen to report/);
  assert.equal(summary.detailsHiddenByDefault, true);
});

test("buildWorkflowGraphManagementSummary surfaces draft test run and history operations for the selected workflow", () => {
  assert.equal(typeof workflowGraph.buildWorkflowGraphManagementSummary, "function");

  const draftSteps = [
    { id: "screen", title: "Screen", type: "tool", dependsOn: "" },
    { id: "select", title: "Select", type: "agent", dependsOn: "screen" },
    { id: "report", title: "Report v2", type: "agent", dependsOn: "select", graphMockEnabled: true },
    { id: "sync", title: "Sync", type: "tool", dependsOn: "report" },
  ];
  const summary = buildWorkflowGraphManagementSummary({
    workflowId: "workflow-1",
    savedSteps: steps,
    draftSteps,
    selectedStepId: "report",
    interfaceInput: {
      graphTestInputPresets: [
        { name: "KR", args: { market: "KR" } },
        { name: "US", args: { market: "US" } },
      ],
    },
    activeRuns: [
      { workflowId: "workflow-1", status: "running", runLabel: "run-1" },
      { workflowId: "other-workflow", status: "running", runLabel: "run-other" },
    ],
    recentRuns: [
      { workflowId: "workflow-1", status: "succeeded", runLabel: "recent-1" },
      { workflowId: "workflow-1", status: "failed", runLabel: "recent-2" },
    ],
  });

  assert.deepEqual(summary.tiles.map((tile) => tile.id), ["draft", "test", "runs", "history"]);
  assert.deepEqual(summary.tiles.map((tile) => tile.status), ["changed", "ready", "1 active", "2 recent"]);
  assert.equal(summary.tiles[0].tone, "warning");
  assert.equal(summary.tiles[1].tone, "info");
  assert.equal(summary.tiles[2].summary, "1 active run for this workflow.");
  assert.equal(summary.tiles[3].summary, "Latest recent run is succeeded.");
  assert.ok(summary.tiles[0].badges.some((badge) => badge.includes("changed step")));
  assert.ok(summary.tiles[1].badges.includes("2 saved inputs"));
  assert.ok(summary.badges.includes("test ready"));
  assert.equal(summary.hasBlockingIssue, false);

  const blocked = buildWorkflowGraphManagementSummary({
    workflowId: "workflow-1",
    savedSteps: steps,
    draftSteps: [{ id: "orphan", title: "Orphan", type: "agent", dependsOn: "missing" }],
    selectedStepId: "orphan",
    activeRuns: [{ workflowId: "workflow-1", status: "failed" }],
    recentRuns: [{ workflowId: "workflow-1", status: "failed" }],
  });
  assert.equal(blocked.tiles[1].status, "blocked");
  assert.equal(blocked.tiles[2].tone, "danger");
  assert.equal(blocked.tiles[3].tone, "danger");
  assert.equal(blocked.hasBlockingIssue, true);
});

test("buildWorkflowGraphDefinitionNavigator summarizes searchable workflow operations for the rail", () => {
  assert.equal(typeof workflowGraph.buildWorkflowGraphDefinitionNavigator, "function");

  const summary = buildWorkflowGraphDefinitionNavigator({
    search: "oracle",
    filter: "problems",
    workflows: [
      {
        id: "workflow-1",
        name: "gazua.oracle-data-sync",
        description: "Publish dashboard data",
        status: "active",
        schedule: "10 8 * * 1-5",
        timezone: "Asia/Seoul",
        triggerLabels: ["gazua", "daily"],
        lastScheduleError: "timeout",
        steps,
      },
      {
        id: "workflow-2",
        name: "gazua.macro-sentinel",
        description: "Macro events",
        status: "paused",
        steps: [{ id: "collect", title: "Collect", type: "tool", dependsOn: "" }],
      },
      {
        id: "workflow-3",
        name: "old-archived-flow",
        status: "archived",
        steps: [],
      },
    ],
    activeRuns: [
      { workflowId: "workflow-1", status: "running" },
      { workflowId: "workflow-2", status: "running" },
    ],
    recentRuns: [
      { workflowId: "workflow-1", status: "failed" },
      { workflowId: "workflow-1", status: "succeeded" },
    ],
  });

  assert.equal(summary.stats.total, 3);
  assert.equal(summary.stats.visible, 1);
  assert.equal(summary.stats.active, 1);
  assert.equal(summary.stats.scheduled, 1);
  assert.equal(summary.stats.activeRuns, 2);
  assert.equal(summary.stats.needsReview, 1);
  assert.equal(summary.stats.paused, 1);
  assert.equal(summary.stats.archived, 1);
  assert.deepEqual(summary.filters.map((filter) => [filter.id, filter.count]), [
    ["all", 2],
    ["active", 1],
    ["scheduled", 1],
    ["problems", 1],
    ["archived", 1],
  ]);
  assert.deepEqual(summary.visibleItems.map((item) => item.id), ["workflow-1"]);
  assert.equal(summary.visibleItems[0].stepCount, 4);
  assert.deepEqual(summary.visibleItems[0].miniSteps.map((step) => step.title), ["Screen", "Select", "Report", "Sync"]);
  assert.equal(summary.visibleItems[0].hasProblem, true);
  assert.equal(summary.visibleItems[0].failedRunCount, 1);
  assert.ok(summary.visibleItems[0].badges.includes("Cron"));
  assert.ok(summary.badges.includes("1 need review"));

  const archived = buildWorkflowGraphDefinitionNavigator({
    filter: "archived",
    workflows: summary.items,
  });
  assert.deepEqual(archived.visibleItems.map((item) => item.name), ["old-archived-flow"]);
});

test("buildWorkflowGraphReleaseReview connects draft diff test gate and run history into a save decision", () => {
  assert.equal(typeof workflowGraph.buildWorkflowGraphReleaseReview, "function");

  const changed = buildWorkflowGraphReleaseReview({
    workflowId: "workflow-1",
    savedSteps: steps,
    draftSteps: [
      { id: "screen", title: "Screen", type: "tool", dependsOn: "" },
      { id: "select", title: "Select", type: "agent", dependsOn: "screen" },
      { id: "report", title: "Report v2", type: "agent", dependsOn: "select" },
      { id: "sync", title: "Sync", type: "tool", dependsOn: "report" },
    ],
    selectedStepId: "report",
    activeRuns: [{ workflowId: "workflow-1", status: "running" }],
    recentRuns: [{ workflowId: "workflow-1", status: "succeeded" }],
  });

  assert.equal(changed.decision, "ready-to-save");
  assert.equal(changed.title, "Ready to save");
  assert.equal(changed.primaryAction, "Save changes");
  assert.deepEqual(changed.stages.map((stage) => stage.id), ["local-edit", "test-gate", "saved-definition", "run-history"]);
  assert.deepEqual(changed.stages.map((stage) => stage.status), ["changed", "ready", "pending save", "1 active"]);
  assert.equal(changed.hasBlockingIssue, false);

  const blocked = buildWorkflowGraphReleaseReview({
    workflowId: "workflow-1",
    savedSteps: steps,
    draftSteps: [{ id: "orphan", title: "Orphan", type: "agent", dependsOn: "missing" }],
    selectedStepId: "orphan",
    recentRuns: [{ workflowId: "workflow-1", status: "failed" }],
  });

  assert.equal(blocked.decision, "blocked");
  assert.equal(blocked.primaryAction, "Fix graph");
  assert.equal(blocked.stages[1].status, "blocked");
  assert.equal(blocked.stages[2].status, "blocked");
  assert.equal(blocked.stages[3].tone, "danger");
  assert.equal(blocked.hasBlockingIssue, true);

  const riskySynced = buildWorkflowGraphReleaseReview({
    workflowId: "workflow-1",
    savedSteps: steps,
    draftSteps: steps,
    recentRuns: [{ workflowId: "workflow-1", status: "failed" }],
  });

  assert.equal(riskySynced.decision, "risky-history");
  assert.equal(riskySynced.stages[0].status, "clean");
  assert.equal(riskySynced.stages[2].status, "synced");
  assert.equal(riskySynced.primaryAction, "Inspect history");

  const synced = buildWorkflowGraphReleaseReview({
    workflowId: "workflow-1",
    savedSteps: steps,
    draftSteps: steps,
  });

  assert.equal(synced.decision, "synced");
  assert.equal(synced.title, "Saved definition synced");
  assert.equal(synced.primaryAction, "Run workflow");
});

test("workflow graph edges preserve conditional and failure metadata", () => {
  const annotated = updateGraphEdgeMetadata(steps, "screen", "select", {
    kind: "conditional",
    label: "market open",
    condition: "result.market === 'KR'",
  });
  const withFailure = updateGraphEdgeMetadata(annotated, "select", "report", {
    kind: "failure",
    label: "fallback",
    condition: "on step error",
  });
  const graph = buildWorkflowGraphModel(withFailure);

  assert.deepEqual(
    graph.edges.map((edge) => [edge.source, edge.target, edge.kind, edge.label, edge.condition]),
    [
      ["screen", "select", "conditional", "market open", "result.market === 'KR'"],
      ["select", "report", "failure", "fallback", "on step error"],
      ["report", "sync", "normal", "", ""],
    ],
  );
  assert.equal(withFailure.find((step) => step.id === "select")?.graphEdgeMetadata?.screen?.kind, "conditional");
  assert.equal(withFailure.find((step) => step.id === "report")?.graphEdgeMetadata?.select?.kind, "failure");
  assert.equal(steps.find((step) => step.id === "select")?.graphEdgeMetadata, undefined);
});

test("disconnectSteps and appendStepAfter preserve graph continuity without dropping existing step fields", () => {
  const withExtra = [
    ...steps,
    { id: "audit", title: "Audit", type: "agent", dependsOn: "report", note: "Keep evidence" },
  ];

  const annotated = updateGraphEdgeMetadata(withExtra, "report", "audit", {
    kind: "early-stop",
    label: "stop after report",
    condition: "result.done === true",
  });
  const disconnected = disconnectSteps(annotated, "report", "audit");
  assert.equal(disconnected.find((step) => step.id === "audit")?.dependsOn, "");
  assert.equal(disconnected.find((step) => step.id === "audit")?.note, "Keep evidence");
  assert.equal(disconnected.find((step) => step.id === "audit")?.graphEdgeMetadata, undefined);

  const appended = appendStepAfter(withExtra, "report");
  const newStep = appended[3];
  assert.equal(newStep.dependsOn, "report");
  assert.equal(newStep.type, "agent");
  assert.match(newStep.id, /^step-/);
});

test("duplicateWorkflowStep creates an editable copy without carrying run overlay state", () => {
  const annotated = updateStepNote(
    updateStepAdvancedMetadata(
      updateGraphEdgeMetadata(steps, "select", "report", {
        kind: "conditional",
        label: "enough signal",
        condition: "result.score > 80",
      }),
      "report",
      {
        onFailure: "retry",
        maxRetries: 3,
      },
    ),
    "report",
    "Keep the copied node documented.",
  );
  const withRunOverlay = setStepGraphRunStatus(annotated, "report", {
    status: "running",
    issueIdentifier: "CMPA-999",
    updatedAt: "2026-06-13T01:00:00.000Z",
    summary: "live run state",
  });

  const duplicated = duplicateWorkflowStep(withRunOverlay, "report");
  const copy = duplicated.find((step) => step.id === "report-copy");

  assert.deepEqual(duplicated.map((step) => step.id), ["screen", "select", "report", "report-copy", "sync"]);
  assert.equal(copy?.title, "Report copy");
  assert.equal(copy?.dependsOn, "select");
  assert.equal(copy?.onFailure, "retry");
  assert.equal(copy?.maxRetries, 3);
  assert.equal(copy?.graphNote, "Keep the copied node documented.");
  assert.equal(copy?.graphEdgeMetadata?.select?.kind, "conditional");
  assert.equal(copy?.graphRunStatus, undefined);
  assert.equal(copy?.graphRunIssueIdentifier, undefined);
  assert.equal(copy?.graphRunUpdatedAt, undefined);
  assert.equal(copy?.graphRunSummary, undefined);
  assert.equal(withRunOverlay.find((step) => step.id === "report-copy"), undefined);
});

test("removeWorkflowStep deletes a selected node and cleans dependent edge references", () => {
  const withExtraEdge = updateGraphEdgeMetadata(
    connectSteps(steps, "screen", "report"),
    "screen",
    "report",
    {
      kind: "failure",
      label: "fallback",
    },
  );

  const removed = removeWorkflowStep(withExtraEdge, "screen");
  const select = removed.find((step) => step.id === "select");
  const report = removed.find((step) => step.id === "report");
  const graph = buildWorkflowGraphModel(removed);

  assert.deepEqual(removed.map((step) => step.id), ["select", "report", "sync"]);
  assert.equal(select?.dependsOn, "");
  assert.equal(report?.dependsOn, "select");
  assert.equal(report?.graphEdgeMetadata?.screen, undefined);
  assert.deepEqual(graph.diagnostics.issues, []);
  assert.deepEqual(graph.edges.map((edge) => `${edge.source}->${edge.target}`), ["select->report", "report->sync"]);
});

test("renameWorkflowStep preserves downstream dependencies and edge metadata", () => {
  const withEdgeMetadata = updateGraphEdgeMetadata(
    connectSteps(steps, "screen", "report"),
    "select",
    "report",
    { kind: "conditional", label: "quality pass", condition: "result.ok === true" },
  );

  const renamed = renameWorkflowStep(withEdgeMetadata, "select", "curate");
  const report = renamed.find((step) => step.id === "report");
  const graph = buildWorkflowGraphModel(renamed);

  assert.equal(renamed.find((step) => step.id === "select"), undefined);
  assert.equal(renamed.find((step) => step.id === "curate")?.title, "Select");
  assert.equal(report?.dependsOn, "curate, screen");
  assert.equal(report?.graphEdgeMetadata?.select, undefined);
  assert.deepEqual(report?.graphEdgeMetadata?.curate, {
    kind: "conditional",
    label: "quality pass",
    condition: "result.ok === true",
  });
  assert.deepEqual(
    graph.edges.map((edge) => `${edge.source}->${edge.target}:${edge.kind}`),
    ["screen->curate:normal", "curate->report:conditional", "screen->report:normal", "report->sync:normal"],
  );
  assert.throws(
    () => renameWorkflowStep(renamed, "curate", "report"),
    /already exists/,
  );
});

test("assignStepsToGroup and updateStepNote preserve visual graph metadata in the model", () => {
  const grouped = assignStepsToGroup(steps, ["select", "report"], {
    id: "analysis",
    title: "Analysis pass",
    color: "#0ea5e9",
  });
  const annotated = updateStepNote(grouped, "report", "Validator must check dashboard HTML.");
  const graph = buildWorkflowGraphModel(annotated);

  assert.equal(annotated.find((step) => step.id === "select")?.graphGroupId, "analysis");
  assert.equal(annotated.find((step) => step.id === "report")?.graphNote, "Validator must check dashboard HTML.");
  assert.deepEqual(graph.groups.map((group) => [group.id, group.title, group.stepIds]), [
    ["analysis", "Analysis pass", ["select", "report"]],
  ]);
  assert.equal(graph.groups[0]?.color, "#0ea5e9");
  assert.ok(graph.groups[0]?.x < graph.nodes.find((node) => node.id === "select")?.x);
  assert.ok(graph.groups[0]?.width > 172);

  const cleared = updateStepNote(annotated, "report", "  ");
  assert.equal(cleared.find((step) => step.id === "report")?.graphNote, undefined);
});

test("collapsed workflow groups render as a single subflow node while preserving external edges", () => {
  const grouped = assignStepsToGroup(steps, ["select", "report"], {
    id: "analysis",
    title: "Analysis pass",
    color: "#0ea5e9",
  });
  const collapsed = setGraphGroupCollapsed(grouped, "analysis", true);
  const graph = buildWorkflowGraphModel(collapsed);

  assert.equal(collapsed.find((step) => step.id === "select")?.graphGroupCollapsed, true);
  assert.equal(collapsed.find((step) => step.id === "report")?.graphGroupCollapsed, true);
  assert.deepEqual(
    graph.nodes.map((node) => [node.id, node.kind, node.label]),
    [
      ["screen", "tool", "Screen"],
      ["group:analysis", "group", "Analysis pass"],
      ["sync", "tool", "Sync"],
    ],
  );
  assert.deepEqual(
    graph.edges.map((edge) => `${edge.source}->${edge.target}`),
    ["screen->group:analysis", "group:analysis->sync"],
  );
  assert.equal(graph.groups[0]?.collapsed, true);
  assert.deepEqual(graph.groups[0]?.stepIds, ["select", "report"]);

  const expanded = setGraphGroupCollapsed(collapsed, "analysis", false);
  assert.equal(expanded.find((step) => step.id === "select")?.graphGroupCollapsed, false);
  assert.deepEqual(
    buildWorkflowGraphModel(expanded).nodes.map((node) => node.id),
    ["screen", "select", "report", "sync"],
  );
});

test("workflow group metadata updates apply to every grouped step and preserve collapsed-by-default state", () => {
  const grouped = assignStepsToGroup(steps, ["select", "report"], {
    id: "analysis",
    title: "Analysis pass",
    color: "#0ea5e9",
  });
  const updated = updateGraphGroupMetadata(grouped, "analysis", {
    title: "Editorial review",
    color: "#22c55e",
    collapsedByDefault: true,
  });
  const graph = buildWorkflowGraphModel(updated);

  assert.deepEqual(
    updated
      .filter((step) => step.graphGroupId === "analysis")
      .map((step) => [step.id, step.graphGroupTitle, step.graphGroupColor, step.graphGroupCollapsedByDefault]),
    [
      ["select", "Editorial review", "#22c55e", true],
      ["report", "Editorial review", "#22c55e", true],
    ],
  );
  assert.deepEqual(
    graph.nodes.map((node) => node.id),
    ["screen", "group:analysis", "sync"],
  );
  assert.equal(graph.groups[0]?.title, "Editorial review");
  assert.equal(graph.groups[0]?.color, "#22c55e");
  assert.equal(graph.groups[0]?.collapsed, true);
  assert.equal(graph.groups[0]?.collapsedByDefault, true);

  const expanded = setGraphGroupCollapsed(updated, "analysis", false);
  const expandedGraph = buildWorkflowGraphModel(expanded);
  assert.deepEqual(
    expandedGraph.nodes.map((node) => node.id),
    ["screen", "select", "report", "sync"],
  );
  assert.equal(expandedGraph.groups[0]?.collapsed, false);
  assert.equal(expandedGraph.groups[0]?.collapsedByDefault, true);
});

test("assignStepsToContainer models branch and loop containers without changing DAG edges", () => {
  const branched = assignStepsToContainer(steps, ["select", "report"], {
    id: "branch-news",
    type: "branch",
    title: "News branch",
    description: "Split signal collection by source quality.",
    mode: "branch-one",
    condition: "result.sourceQuality > 0.8",
  });
  const looped = assignStepsToContainer(branched, ["sync"], {
    id: "retry-sync",
    type: "loop",
    title: "Retry sync",
    iterator: "result.failedMarkets",
    skipFailure: true,
    runInParallel: true,
    parallelism: 4,
  });
  const updated = updateContainerMetadata(looped, "branch-news", {
    title: "Quality branch",
    description: "Run research only when source quality is high.",
    mode: "branch-all",
    condition: "result.sourceQuality >= 0.7",
  });
  const graph = buildWorkflowGraphModel(updated);

  assert.deepEqual(
    graph.edges.map((edge) => `${edge.source}->${edge.target}`),
    ["screen->select", "select->report", "report->sync"],
  );
  assert.deepEqual(
    graph.containers.map((container) => [container.id, container.type, container.title, container.stepIds, container.mode]),
    [
      ["branch-news", "branch", "Quality branch", ["select", "report"], "branch-all"],
      ["retry-sync", "loop", "Retry sync", ["sync"], "for-each"],
    ],
  );
  assert.equal(graph.containers[0]?.description, "Run research only when source quality is high.");
  assert.equal(graph.containers[0]?.condition, "result.sourceQuality >= 0.7");
  assert.deepEqual(graph.containers[0]?.badges, ["Branch all", "Conditional"]);
  assert.equal(graph.containers[1]?.iterator, "result.failedMarkets");
  assert.equal(graph.containers[1]?.skipFailure, true);
  assert.equal(graph.containers[1]?.runInParallel, true);
  assert.equal(graph.containers[1]?.parallelism, 4);
  assert.deepEqual(graph.containers[1]?.badges, ["For each", "Parallel x4", "Skip failure"]);
  assert.equal(updated.find((step) => step.id === "select")?.graphContainerType, "branch");
  assert.equal(updated.find((step) => step.id === "select")?.graphContainerMode, "branch-all");
  assert.equal(updated.find((step) => step.id === "select")?.graphContainerCondition, "result.sourceQuality >= 0.7");
  assert.equal(updated.find((step) => step.id === "sync")?.graphContainerType, "loop");
  assert.equal(updated.find((step) => step.id === "sync")?.graphContainerIterator, "result.failedMarkets");
  assert.equal(updated.find((step) => step.id === "sync")?.graphContainerSkipFailure, true);
  assert.equal(updated.find((step) => step.id === "sync")?.graphContainerRunInParallel, true);
  assert.equal(updated.find((step) => step.id === "sync")?.graphContainerParallelism, 4);
  assert.ok(graph.containers[0]?.width > 172);
});

test("buildWorkflowGraphContainerSummary explains container boundaries for canvas management", () => {
  assert.equal(typeof workflowGraph.buildWorkflowGraphContainerSummary, "function");

  const branched = assignStepsToContainer(steps, ["select", "report"], {
    id: "branch-news",
    type: "branch",
    title: "News branch",
    description: "Split signal collection by source quality.",
    mode: "branch-one",
    condition: "result.sourceQuality > 0.8",
  });
  const summary = buildWorkflowGraphContainerSummary(branched, "branch-news");

  assert.equal(summary.id, "branch-news");
  assert.equal(summary.type, "branch");
  assert.equal(summary.title, "News branch");
  assert.deepEqual(summary.stepIds, ["select", "report"]);
  assert.deepEqual(summary.entryStepIds, ["select"]);
  assert.deepEqual(summary.terminalStepIds, ["report"]);
  assert.deepEqual(summary.inboundStepIds, ["screen"]);
  assert.deepEqual(summary.outboundStepIds, ["sync"]);
  assert.deepEqual(summary.badges, ["Branch one", "Conditional", "2 steps", "1 inbound", "1 outbound"]);
  assert.equal(summary.blocked, false);
  assert.match(summary.summary, /News branch contains 2 steps from select to report/);

  const missing = buildWorkflowGraphContainerSummary(branched, "missing");
  assert.equal(missing.blocked, true);
  assert.deepEqual(missing.badges, ["Missing container", "Blocked"]);
});

test("duplicateWorkflowContainer clones a branch or loop block while preserving graph boundaries", () => {
  assert.equal(typeof workflowGraph.duplicateWorkflowContainer, "function");

  const branched = assignStepsToContainer(steps, ["select", "report"], {
    id: "branch-news",
    type: "branch",
    title: "News branch",
    description: "Split signal collection by source quality.",
    mode: "branch-one",
    condition: "result.sourceQuality > 0.8",
  });
  const duplicated = duplicateWorkflowContainer(branched, "branch-news");
  const graph = buildWorkflowGraphModel(duplicated);
  const copyContainer = graph.containers.find((container) => container.id === "branch-news-copy");

  assert.ok(copyContainer);
  assert.equal(copyContainer?.title, "News branch copy");
  assert.deepEqual(copyContainer?.stepIds, ["select-copy", "report-copy"]);
  assert.equal(duplicated.find((step) => step.id === "select-copy")?.dependsOn, "screen");
  assert.equal(duplicated.find((step) => step.id === "report-copy")?.dependsOn, "select-copy");
  assert.equal(duplicated.find((step) => step.id === "select-copy")?.graphContainerId, "branch-news-copy");
  assert.equal(duplicated.find((step) => step.id === "report-copy")?.graphContainerId, "branch-news-copy");
  assert.equal(duplicated.find((step) => step.id === "select-copy")?.graphContainerTitle, "News branch copy");
  assert.equal(duplicated.find((step) => step.id === "select-copy")?.graphRunStatus, undefined);
  assert.deepEqual(
    new Set(graph.edges.map((edge) => `${edge.source}->${edge.target}`)),
    new Set(["screen->select", "screen->select-copy", "select->report", "select-copy->report-copy", "report->sync"]),
  );
  assert.equal(duplicateWorkflowContainer(branched, "missing"), branched);
});

test("clearWorkflowContainer removes a selected container boundary without changing DAG continuity", () => {
  assert.equal(typeof workflowGraph.clearWorkflowContainer, "function");

  const branched = assignStepsToContainer(steps, ["select", "report"], {
    id: "branch-news",
    type: "branch",
    title: "News branch",
    description: "Split signal collection by source quality.",
    mode: "branch-all",
    condition: "result.sourceQuality > 0.8",
  });
  const cleared = clearWorkflowContainer(branched, "branch-news");
  const graph = buildWorkflowGraphModel(cleared);

  assert.deepEqual(graph.containers, []);
  assert.deepEqual(
    graph.edges.map((edge) => `${edge.source}->${edge.target}`),
    ["screen->select", "select->report", "report->sync"],
  );
  assert.equal(cleared.find((step) => step.id === "select")?.graphContainerId, undefined);
  assert.equal(cleared.find((step) => step.id === "report")?.graphContainerId, undefined);
  assert.equal(cleared.find((step) => step.id === "sync")?.graphContainerId, undefined);
  assert.equal(clearWorkflowContainer(branched, "missing"), branched);
});

test("expandWorkflowGraphSelection builds Windmill-style upstream and downstream path selections", () => {
  assert.equal(typeof workflowGraph.expandWorkflowGraphSelection, "function");

  assert.deepEqual(expandWorkflowGraphSelection(steps, ["select"], "upstream"), ["screen", "select"]);
  assert.deepEqual(expandWorkflowGraphSelection(steps, ["select"], "downstream"), ["select", "report", "sync"]);
  assert.deepEqual(expandWorkflowGraphSelection(steps, ["select"], "connected"), ["screen", "select", "report", "sync"]);
  assert.deepEqual(expandWorkflowGraphSelection(steps, ["missing"], "connected"), []);
  assert.deepEqual(expandWorkflowGraphSelection(steps, ["report", "select"], "self"), ["select", "report"]);
});

test("buildWorkflowGraphSelectionSummary explains selected path boundaries for bulk graph actions", () => {
  assert.equal(typeof workflowGraph.buildWorkflowGraphSelectionSummary, "function");

  const summary = buildWorkflowGraphSelectionSummary(steps, ["select", "report"]);

  assert.equal(summary.blocked, false);
  assert.deepEqual(summary.stepIds, ["select", "report"]);
  assert.deepEqual(summary.entryStepIds, ["select"]);
  assert.deepEqual(summary.terminalStepIds, ["report"]);
  assert.deepEqual(summary.inboundStepIds, ["screen"]);
  assert.deepEqual(summary.outboundStepIds, ["sync"]);
  assert.deepEqual(summary.badges, ["2 selected", "1 inbound", "1 outbound"]);
  assert.match(summary.summary, /Selection contains 2 steps from select to report/);

  const missing = buildWorkflowGraphSelectionSummary(steps, ["missing"]);
  assert.equal(missing.blocked, true);
  assert.deepEqual(missing.stepIds, []);
  assert.deepEqual(missing.badges, ["No selection", "Blocked"]);
});

test("applyWorkflowGraphFailureRoute connects selected path failures to a handler step", () => {
  assert.equal(typeof workflowGraph.applyWorkflowGraphFailureRoute, "function");
  assert.equal(typeof workflowGraph.buildWorkflowGraphFailureRouteSummary, "function");

  const routed = applyWorkflowGraphFailureRoute(steps, ["select", "report"], "sync", {
    label: "Recover selection",
    condition: "upstream step failed",
    handlerScope: "selected-path",
    handlerInput: "{{ error }}",
  });
  const graph = buildWorkflowGraphModel(routed);
  const failureEdges = graph.edges.filter((edge) => edge.kind === "failure");
  const summary = buildWorkflowGraphFailureRouteSummary(routed, ["select", "report"], "sync", {
    label: "Recover selection",
    condition: "upstream step failed",
  });

  assert.deepEqual(
    failureEdges.map((edge) => `${edge.source}->${edge.target}:${edge.label}:${edge.condition}`).sort(),
    [
      "report->sync:Recover selection:upstream step failed",
      "select->sync:Recover selection:upstream step failed",
    ],
  );
  assert.equal(routed.find((step) => step.id === "select")?.onFailure, "handler");
  assert.equal(routed.find((step) => step.id === "report")?.onFailure, "handler");
  assert.equal(routed.find((step) => step.id === "sync")?.graphErrorHandler, true);
  assert.equal(routed.find((step) => step.id === "sync")?.graphErrorHandlerScope, "selected-path");
  assert.equal(routed.find((step) => step.id === "sync")?.graphErrorHandlerInput, "{{ error }}");
  assert.equal(summary.blocked, false);
  assert.deepEqual(summary.sourceStepIds, ["select", "report"]);
  assert.deepEqual(summary.badges, ["2 failure sources", "handler sync", "Recover selection"]);
  assert.match(summary.summary, /2 selected steps will route failures to sync/);

  const blocked = buildWorkflowGraphFailureRouteSummary(steps, ["select"], "missing");
  assert.equal(blocked.blocked, true);
  assert.deepEqual(blocked.badges, ["Missing handler", "Blocked"]);
});

test("step advanced metadata surfaces retry timeout and early-stop policy on graph nodes", () => {
  const advanced = updateStepAdvancedMetadata(steps, "report", {
    onFailure: "retry",
    maxRetries: 5,
    retryDelaySeconds: 30,
    retryBackoff: "exponential",
    retryJitter: true,
    timeoutSeconds: 900,
    earlyStopCondition: "result.done === true",
    earlyStopLabelSkipped: true,
  });
  const graph = buildWorkflowGraphModel(advanced);
  const report = graph.nodes.find((node) => node.id === "report");

  assert.equal(advanced.find((step) => step.id === "report")?.onFailure, "retry");
  assert.equal(advanced.find((step) => step.id === "report")?.maxRetries, 5);
  assert.equal(advanced.find((step) => step.id === "report")?.graphRetryDelaySeconds, 30);
  assert.equal(advanced.find((step) => step.id === "report")?.graphRetryBackoff, "exponential");
  assert.equal(advanced.find((step) => step.id === "report")?.graphRetryJitter, true);
  assert.equal(advanced.find((step) => step.id === "report")?.timeoutSeconds, 900);
  assert.equal(advanced.find((step) => step.id === "report")?.graphEarlyStopCondition, "result.done === true");
  assert.equal(advanced.find((step) => step.id === "report")?.graphEarlyStopLabelSkipped, true);
  assert.deepEqual(report?.advanced.badges, ["Retry x5", "Retry delay 30s", "Backoff exponential", "Jitter", "Timeout 900s", "Early stop"]);
  assert.equal(report?.advanced.retryDelaySeconds, 30);
  assert.equal(report?.advanced.retryBackoff, "exponential");
  assert.equal(report?.advanced.retryJitter, true);
  assert.equal(report?.advanced.earlyStopCondition, "result.done === true");
  assert.equal(report?.advanced.earlyStopLabelSkipped, true);
  assert.deepEqual(
    searchWorkflowGraphNodes(graph, "exponential").map((result) => [result.nodeId, result.matchFields]),
    [["report", ["policy"]]],
  );

  const cleared = updateStepAdvancedMetadata(advanced, "report", {
    onFailure: "",
    maxRetries: undefined,
    retryDelaySeconds: undefined,
    retryBackoff: "",
    retryJitter: false,
    timeoutSeconds: undefined,
    earlyStopCondition: "  ",
    earlyStopLabelSkipped: false,
  });
  const clearedReport = buildWorkflowGraphModel(cleared).nodes.find((node) => node.id === "report");
  assert.equal(cleared.find((step) => step.id === "report")?.onFailure, undefined);
  assert.equal(cleared.find((step) => step.id === "report")?.maxRetries, undefined);
  assert.equal(cleared.find((step) => step.id === "report")?.graphRetryDelaySeconds, undefined);
  assert.equal(cleared.find((step) => step.id === "report")?.graphRetryBackoff, undefined);
  assert.equal(cleared.find((step) => step.id === "report")?.graphRetryJitter, undefined);
  assert.equal(cleared.find((step) => step.id === "report")?.timeoutSeconds, undefined);
  assert.equal(cleared.find((step) => step.id === "report")?.graphEarlyStopCondition, undefined);
  assert.deepEqual(clearedReport?.advanced.badges, []);
});

test("step approval metadata models Windmill-style suspend gates without changing DAG continuity", () => {
  const gated = updateStepApprovalMetadata(steps, "report", {
    required: true,
    prompt: "Approve the report before dashboard sync.",
    recipients: "research-lead, operator",
    timeoutSeconds: 3600,
    timeoutAction: "cancel",
  });
  const graph = buildWorkflowGraphModel(gated);
  const report = graph.nodes.find((node) => node.id === "report");

  assert.equal(gated.find((step) => step.id === "report")?.graphApprovalRequired, true);
  assert.equal(gated.find((step) => step.id === "report")?.graphApprovalPrompt, "Approve the report before dashboard sync.");
  assert.equal(gated.find((step) => step.id === "report")?.graphApprovalRecipients, "research-lead, operator");
  assert.equal(gated.find((step) => step.id === "report")?.graphApprovalTimeoutSeconds, 3600);
  assert.equal(gated.find((step) => step.id === "report")?.graphApprovalTimeoutAction, "cancel");
  assert.deepEqual(
    graph.edges.map((edge) => `${edge.source}->${edge.target}`),
    ["screen->select", "select->report", "report->sync"],
  );
  assert.deepEqual(report?.advanced.approval, {
    required: true,
    prompt: "Approve the report before dashboard sync.",
    recipients: ["research-lead", "operator"],
    timeoutSeconds: 3600,
    timeoutAction: "cancel",
    badges: ["Approval gate", "Approvers 2", "Timeout 3600s", "Cancel on timeout"],
  });
  assert.deepEqual(
    searchWorkflowGraphNodes(graph, "approval").map((result) => [result.nodeId, result.matchFields]),
    [["report", ["policy", "approval"]]],
  );

  const cleared = updateStepApprovalMetadata(gated, "report", {
    required: false,
    prompt: " ",
    recipients: "",
    timeoutSeconds: undefined,
    timeoutAction: "",
  });
  const clearedReport = buildWorkflowGraphModel(cleared).nodes.find((node) => node.id === "report");
  assert.equal(cleared.find((step) => step.id === "report")?.graphApprovalRequired, undefined);
  assert.equal(cleared.find((step) => step.id === "report")?.graphApprovalPrompt, undefined);
  assert.deepEqual(clearedReport?.advanced.approval.badges, []);
});

test("step wait metadata models passive sleep and external suspend without changing DAG continuity", () => {
  const waiting = updateStepAdvancedMetadata(steps, "report", {
    sleepSeconds: 120,
    suspendUntil: "webhook:dashboard-approved",
    suspendTimeoutSeconds: 3600,
    suspendTimeoutAction: "cancel",
  });
  const graph = buildWorkflowGraphModel(waiting);
  const report = graph.nodes.find((node) => node.id === "report");

  assert.equal(waiting.find((step) => step.id === "report")?.graphSleepSeconds, 120);
  assert.equal(waiting.find((step) => step.id === "report")?.graphSuspendUntil, "webhook:dashboard-approved");
  assert.equal(waiting.find((step) => step.id === "report")?.graphSuspendTimeoutSeconds, 3600);
  assert.equal(waiting.find((step) => step.id === "report")?.graphSuspendTimeoutAction, "cancel");
  assert.deepEqual(
    graph.edges.map((edge) => `${edge.source}->${edge.target}`),
    ["screen->select", "select->report", "report->sync"],
  );
  assert.equal(report?.advanced.sleepSeconds, 120);
  assert.equal(report?.advanced.suspendUntil, "webhook:dashboard-approved");
  assert.equal(report?.advanced.suspendTimeoutSeconds, 3600);
  assert.equal(report?.advanced.suspendTimeoutAction, "cancel");
  assert.deepEqual(report?.advanced.badges, ["Sleep 120s", "Suspend", "Suspend timeout 3600s", "Cancel on timeout"]);
  assert.deepEqual(
    searchWorkflowGraphNodes(graph, "dashboard-approved").map((result) => [result.nodeId, result.matchFields]),
    [["report", ["policy"]]],
  );

  const cleared = updateStepAdvancedMetadata(waiting, "report", {
    sleepSeconds: undefined,
    suspendUntil: "",
    suspendTimeoutSeconds: undefined,
    suspendTimeoutAction: "",
  });
  const clearedReport = buildWorkflowGraphModel(cleared).nodes.find((node) => node.id === "report");
  assert.equal(cleared.find((step) => step.id === "report")?.graphSleepSeconds, undefined);
  assert.equal(cleared.find((step) => step.id === "report")?.graphSuspendUntil, undefined);
  assert.equal(cleared.find((step) => step.id === "report")?.graphSuspendTimeoutSeconds, undefined);
  assert.equal(cleared.find((step) => step.id === "report")?.graphSuspendTimeoutAction, undefined);
  assert.deepEqual(clearedReport?.advanced.badges, []);
});

test("step early return metadata models synchronous webhook responses without changing DAG continuity", () => {
  const returning = updateStepAdvancedMetadata(steps, "report", {
    earlyReturn: true,
    earlyReturnContentType: "text/html",
    earlyReturnSchema: '{ "type": "object", "required": ["publicUrl"] }',
  });
  const graph = buildWorkflowGraphModel(returning);
  const report = graph.nodes.find((node) => node.id === "report");

  assert.equal(returning.find((step) => step.id === "report")?.graphEarlyReturn, true);
  assert.equal(returning.find((step) => step.id === "report")?.graphEarlyReturnContentType, "text/html");
  assert.equal(returning.find((step) => step.id === "report")?.graphEarlyReturnSchema, '{ "type": "object", "required": ["publicUrl"] }');
  assert.deepEqual(
    graph.edges.map((edge) => `${edge.source}->${edge.target}`),
    ["screen->select", "select->report", "report->sync"],
  );
  assert.equal(report?.advanced.earlyReturn, true);
  assert.equal(report?.advanced.earlyReturnContentType, "text/html");
  assert.equal(report?.advanced.earlyReturnSchema, '{ "type": "object", "required": ["publicUrl"] }');
  assert.deepEqual(report?.advanced.badges, ["Early return", "Return text/html", "Return schema"]);
  assert.deepEqual(
    searchWorkflowGraphNodes(graph, "publicUrl").map((result) => [result.nodeId, result.matchFields]),
    [["report", ["policy"]]],
  );

  const cleared = updateStepAdvancedMetadata(returning, "report", {
    earlyReturn: false,
    earlyReturnContentType: "",
    earlyReturnSchema: "",
  });
  const clearedReport = buildWorkflowGraphModel(cleared).nodes.find((node) => node.id === "report");
  assert.equal(cleared.find((step) => step.id === "report")?.graphEarlyReturn, undefined);
  assert.equal(cleared.find((step) => step.id === "report")?.graphEarlyReturnContentType, undefined);
  assert.equal(cleared.find((step) => step.id === "report")?.graphEarlyReturnSchema, undefined);
  assert.deepEqual(clearedReport?.advanced.badges, []);
});

test("step error handler metadata models Windmill-style flow error handling without changing DAG continuity", () => {
  const handling = updateStepAdvancedMetadata(steps, "report", {
    errorHandler: true,
    errorHandlerScope: "flow",
    errorHandlerInput: "errored_step.error",
  });
  const graph = buildWorkflowGraphModel(handling);
  const report = graph.nodes.find((node) => node.id === "report");

  assert.equal(handling.find((step) => step.id === "report")?.graphErrorHandler, true);
  assert.equal(handling.find((step) => step.id === "report")?.graphErrorHandlerScope, "flow");
  assert.equal(handling.find((step) => step.id === "report")?.graphErrorHandlerInput, "errored_step.error");
  assert.deepEqual(
    graph.edges.map((edge) => `${edge.source}->${edge.target}`),
    ["screen->select", "select->report", "report->sync"],
  );
  assert.equal(report?.advanced.errorHandler, true);
  assert.equal(report?.advanced.errorHandlerScope, "flow");
  assert.equal(report?.advanced.errorHandlerInput, "errored_step.error");
  assert.deepEqual(report?.advanced.badges, ["Error handler", "Scope flow", "Error input"]);
  assert.deepEqual(
    searchWorkflowGraphNodes(graph, "errored_step").map((result) => [result.nodeId, result.matchFields]),
    [["report", ["policy"]]],
  );

  const cleared = updateStepAdvancedMetadata(handling, "report", {
    errorHandler: false,
    errorHandlerScope: "",
    errorHandlerInput: "",
  });
  const clearedReport = buildWorkflowGraphModel(cleared).nodes.find((node) => node.id === "report");
  assert.equal(cleared.find((step) => step.id === "report")?.graphErrorHandler, undefined);
  assert.equal(cleared.find((step) => step.id === "report")?.graphErrorHandlerScope, undefined);
  assert.equal(cleared.find((step) => step.id === "report")?.graphErrorHandlerInput, undefined);
  assert.deepEqual(clearedReport?.advanced.badges, []);
});

test("step restart boundary metadata models Windmill-style restart points without changing DAG continuity", () => {
  const restartable = updateStepAdvancedMetadata(steps, "report", {
    restartBoundary: true,
    restartStrategy: "copy-predecessors",
    restartInput: "branch:kr",
  });
  const graph = buildWorkflowGraphModel(restartable);
  const report = graph.nodes.find((node) => node.id === "report");

  assert.equal(restartable.find((step) => step.id === "report")?.graphRestartBoundary, true);
  assert.equal(restartable.find((step) => step.id === "report")?.graphRestartStrategy, "copy-predecessors");
  assert.equal(restartable.find((step) => step.id === "report")?.graphRestartInput, "branch:kr");
  assert.deepEqual(
    graph.edges.map((edge) => `${edge.source}->${edge.target}`),
    ["screen->select", "select->report", "report->sync"],
  );
  assert.equal(report?.advanced.restartBoundary, true);
  assert.equal(report?.advanced.restartStrategy, "copy-predecessors");
  assert.equal(report?.advanced.restartInput, "branch:kr");
  assert.deepEqual(report?.advanced.badges, ["Restart boundary", "Restart copy-predecessors", "Restart input"]);
  assert.deepEqual(
    searchWorkflowGraphNodes(graph, "branch:kr").map((result) => [result.nodeId, result.matchFields]),
    [["report", ["policy"]]],
  );

  const cleared = updateStepAdvancedMetadata(restartable, "report", {
    restartBoundary: false,
    restartStrategy: "",
    restartInput: "",
  });
  const clearedReport = buildWorkflowGraphModel(cleared).nodes.find((node) => node.id === "report");
  assert.equal(cleared.find((step) => step.id === "report")?.graphRestartBoundary, undefined);
  assert.equal(cleared.find((step) => step.id === "report")?.graphRestartStrategy, undefined);
  assert.equal(cleared.find((step) => step.id === "report")?.graphRestartInput, undefined);
  assert.deepEqual(clearedReport?.advanced.badges, []);
});

test("step testing metadata models Windmill-style mock and pinned results without changing DAG continuity", () => {
  const mocked = updateStepTestingMetadata(steps, "report", {
    mockEnabled: true,
    mockResult: '{ "summary": "fixture result" }',
    pinnedResultRunId: "run-2026-06-13",
  });
  const graph = buildWorkflowGraphModel(mocked);
  const report = graph.nodes.find((node) => node.id === "report");

  assert.equal(mocked.find((step) => step.id === "report")?.graphMockEnabled, true);
  assert.equal(mocked.find((step) => step.id === "report")?.graphMockResult, '{ "summary": "fixture result" }');
  assert.equal(mocked.find((step) => step.id === "report")?.graphPinnedResultRunId, "run-2026-06-13");
  assert.deepEqual(
    graph.edges.map((edge) => `${edge.source}->${edge.target}`),
    ["screen->select", "select->report", "report->sync"],
  );
  assert.deepEqual(report?.testing, {
    mockEnabled: true,
    mockResult: '{ "summary": "fixture result" }',
    pinnedResultRunId: "run-2026-06-13",
    badges: ["Mocked", "Pinned result"],
  });
  assert.deepEqual(
    searchWorkflowGraphNodes(graph, "fixture").map((result) => [result.nodeId, result.matchFields]),
    [["report", ["testing"]]],
  );

  const cleared = updateStepTestingMetadata(mocked, "report", {
    mockEnabled: false,
    mockResult: "",
    pinnedResultRunId: "",
  });
  const clearedReport = buildWorkflowGraphModel(cleared).nodes.find((node) => node.id === "report");
  assert.equal(cleared.find((step) => step.id === "report")?.graphMockEnabled, undefined);
  assert.equal(cleared.find((step) => step.id === "report")?.graphMockResult, undefined);
  assert.equal(cleared.find((step) => step.id === "report")?.graphPinnedResultRunId, undefined);
  assert.deepEqual(clearedReport?.testing.badges, []);
});

test("step execution metadata models concurrency priority cache and retention controls without changing DAG continuity", () => {
  const controlled = updateStepExecutionMetadata(steps, "report", {
    concurrencyKey: "market-report",
    concurrencyLimit: 2,
    priority: "high",
    cacheEnabled: true,
    cacheTtlSeconds: 600,
    deleteAfterUse: true,
  });
  const graph = buildWorkflowGraphModel(controlled);
  const report = graph.nodes.find((node) => node.id === "report");

  assert.equal(controlled.find((step) => step.id === "report")?.graphConcurrencyKey, "market-report");
  assert.equal(controlled.find((step) => step.id === "report")?.graphConcurrencyLimit, 2);
  assert.equal(controlled.find((step) => step.id === "report")?.graphPriority, "high");
  assert.equal(controlled.find((step) => step.id === "report")?.graphCacheEnabled, true);
  assert.equal(controlled.find((step) => step.id === "report")?.graphCacheTtlSeconds, 600);
  assert.equal(controlled.find((step) => step.id === "report")?.graphDeleteAfterUse, true);
  assert.deepEqual(
    graph.edges.map((edge) => `${edge.source}->${edge.target}`),
    ["screen->select", "select->report", "report->sync"],
  );
  assert.deepEqual(report?.execution, {
    concurrencyKey: "market-report",
    concurrencyLimit: 2,
    priority: "high",
    cacheEnabled: true,
    cacheTtlSeconds: 600,
    deleteAfterUse: true,
    badges: ["Concurrency x2", "Priority high", "Cache 600s", "Delete after use"],
  });
  assert.deepEqual(
    searchWorkflowGraphNodes(graph, "market-report").map((result) => [result.nodeId, result.matchFields]),
    [["report", ["execution"]]],
  );

  const cleared = updateStepExecutionMetadata(controlled, "report", {
    concurrencyKey: "",
    concurrencyLimit: undefined,
    priority: "",
    cacheEnabled: false,
    cacheTtlSeconds: undefined,
    deleteAfterUse: false,
  });
  const clearedReport = buildWorkflowGraphModel(cleared).nodes.find((node) => node.id === "report");
  assert.equal(cleared.find((step) => step.id === "report")?.graphConcurrencyKey, undefined);
  assert.equal(cleared.find((step) => step.id === "report")?.graphConcurrencyLimit, undefined);
  assert.equal(cleared.find((step) => step.id === "report")?.graphPriority, undefined);
  assert.equal(cleared.find((step) => step.id === "report")?.graphCacheEnabled, undefined);
  assert.equal(cleared.find((step) => step.id === "report")?.graphCacheTtlSeconds, undefined);
  assert.equal(cleared.find((step) => step.id === "report")?.graphDeleteAfterUse, undefined);
  assert.deepEqual(clearedReport?.execution.badges, []);
});

test("step data flow metadata models input transforms and output contracts without changing DAG continuity", () => {
  const contracted = updateStepDataFlowMetadata(steps, "report", {
    inputExpression: "select.result.summary",
    outputSchema: '{ "type": "object", "required": ["htmlPath"] }',
    workProductRequired: true,
    workProductPattern: "data/reports/*.html",
  });
  const graph = buildWorkflowGraphModel(contracted);
  const report = graph.nodes.find((node) => node.id === "report");

  assert.equal(contracted.find((step) => step.id === "report")?.graphInputExpression, "select.result.summary");
  assert.equal(contracted.find((step) => step.id === "report")?.graphOutputSchema, '{ "type": "object", "required": ["htmlPath"] }');
  assert.equal(contracted.find((step) => step.id === "report")?.graphWorkProductRequired, true);
  assert.equal(contracted.find((step) => step.id === "report")?.graphWorkProductPattern, "data/reports/*.html");
  assert.deepEqual(
    graph.edges.map((edge) => `${edge.source}->${edge.target}`),
    ["screen->select", "select->report", "report->sync"],
  );
  assert.deepEqual(report?.dataFlow, {
    inputExpression: "select.result.summary",
    outputSchema: '{ "type": "object", "required": ["htmlPath"] }',
    workProductRequired: true,
    workProductPattern: "data/reports/*.html",
    badges: ["Input map", "Output schema", "Requires output", "Output pattern"],
  });
  assert.deepEqual(
    searchWorkflowGraphNodes(graph, "htmlPath").map((result) => [result.nodeId, result.matchFields]),
    [["report", ["data"]]],
  );

  const cleared = updateStepDataFlowMetadata(contracted, "report", {
    inputExpression: "",
    outputSchema: "",
    workProductRequired: false,
    workProductPattern: "",
  });
  const clearedReport = buildWorkflowGraphModel(cleared).nodes.find((node) => node.id === "report");
  assert.equal(cleared.find((step) => step.id === "report")?.graphInputExpression, undefined);
  assert.equal(cleared.find((step) => step.id === "report")?.graphOutputSchema, undefined);
  assert.equal(cleared.find((step) => step.id === "report")?.graphWorkProductRequired, undefined);
  assert.equal(cleared.find((step) => step.id === "report")?.graphWorkProductPattern, undefined);
  assert.deepEqual(clearedReport?.dataFlow.badges, []);
});

test("buildWorkflowGraphDataFlowMap explains Windmill-style input transform references", () => {
  assert.equal(typeof workflowGraph.buildWorkflowGraphDataFlowMap, "function");

  const wired = updateStepResourceMetadata(updateStepDataFlowMetadata(steps, "report", {
    inputExpression: "flow_input.market + select.result.summary + resources.postgres_main + secrets.SLACK_TOKEN + missing.result",
    outputSchema: '{ "type": "object", "required": ["htmlPath"] }',
    workProductRequired: true,
    workProductPattern: "reports/*.html",
  }), "report", {
    resourceRefs: ["postgres_main"],
    secretRefs: ["SLACK_TOKEN"],
  });

  const map = buildWorkflowGraphDataFlowMap(wired, "report");

  assert.equal(map.stepId, "report");
  assert.equal(map.blocked, true);
  assert.deepEqual(map.upstreamStepIds, ["select"]);
  assert.deepEqual(map.missingStepIds, ["missing"]);
  assert.deepEqual(map.flowInputRefs, ["market"]);
  assert.deepEqual(map.resultRefs, [
    { stepId: "select", path: "summary", available: true },
    { stepId: "missing", path: "", available: false },
  ]);
  assert.deepEqual(map.resourceRefs, ["postgres_main"]);
  assert.deepEqual(map.secretRefs, ["SLACK_TOKEN"]);
  assert.deepEqual(map.outputContractBadges, ["Output schema", "Requires output", "Output pattern"]);
  assert.deepEqual(map.badges, ["1 flow input", "1 upstream result", "1 resource", "1 secret", "1 missing step", "Blocked"]);
  assert.match(map.summary, /report maps 1 flow input, 1 upstream result, 1 resource, and 1 secret/);

  const missingTarget = buildWorkflowGraphDataFlowMap(wired, "unknown");
  assert.equal(missingTarget.blocked, true);
  assert.deepEqual(missingTarget.badges, ["Missing step", "Blocked"]);
});

test("step resource metadata models external resources and secret references without changing DAG continuity", () => {
  const bound = updateStepResourceMetadata(steps, "report", {
    resourceRefs: ["postgres-main", "slack-webhook", "postgres-main"],
    secretRefs: "OPENAI_API_KEY, SLACK_BOT_TOKEN",
  });
  const graph = buildWorkflowGraphModel(bound);
  const report = graph.nodes.find((node) => node.id === "report");

  assert.deepEqual(bound.find((step) => step.id === "report")?.graphResourceRefs, ["postgres-main", "slack-webhook"]);
  assert.deepEqual(bound.find((step) => step.id === "report")?.graphSecretRefs, ["OPENAI_API_KEY", "SLACK_BOT_TOKEN"]);
  assert.deepEqual(
    graph.edges.map((edge) => `${edge.source}->${edge.target}`),
    ["screen->select", "select->report", "report->sync"],
  );
  assert.deepEqual(report?.resources, {
    resourceRefs: ["postgres-main", "slack-webhook"],
    secretRefs: ["OPENAI_API_KEY", "SLACK_BOT_TOKEN"],
    badges: ["Resources 2", "Secrets 2"],
  });
  assert.deepEqual(
    searchWorkflowGraphNodes(graph, "slack").map((result) => [result.nodeId, result.matchFields]),
    [["report", ["resources"]]],
  );

  const cleared = updateStepResourceMetadata(bound, "report", {
    resourceRefs: [],
    secretRefs: "",
  });
  const clearedReport = buildWorkflowGraphModel(cleared).nodes.find((node) => node.id === "report");
  assert.equal(cleared.find((step) => step.id === "report")?.graphResourceRefs, undefined);
  assert.equal(cleared.find((step) => step.id === "report")?.graphSecretRefs, undefined);
  assert.deepEqual(clearedReport?.resources.badges, []);
});

test("setStepGraphRunStatus preserves execution status metadata for graph overlays", () => {
  const withStatus = setStepGraphRunStatus(steps, "select", {
    status: "running",
    issueIdentifier: "CMPA-123",
    updatedAt: "2026-06-12T14:00:00.000Z",
  });
  const cleared = setStepGraphRunStatus(withStatus, "report", {
    status: "not-a-real-status",
    issueIdentifier: "CMPA-456",
  });
  const graph = buildWorkflowGraphModel(cleared);

  const selectNode = graph.nodes.find((node) => node.id === "select");
  const reportNode = graph.nodes.find((node) => node.id === "report");

  assert.equal(selectNode?.runStatus.status, "running");
  assert.equal(selectNode?.runStatus.issueIdentifier, "CMPA-123");
  assert.equal(selectNode?.runStatus.updatedAt, "2026-06-12T14:00:00.000Z");
  assert.equal(reportNode?.runStatus.status, "planned");
  assert.equal(reportNode?.step.graphRunIssueIdentifier, "CMPA-456");
});

test("applyStepRunsToGraphSteps overlays real workflow step runs without changing DAG definitions", () => {
  const withRuns = applyStepRunsToGraphSteps(steps, [
    {
      id: "step-run-select",
      stepId: "select",
      status: "in_progress",
      issueId: "issue-select",
      issueIdentifier: "CMPA-123",
      startedAt: "2026-06-13T00:10:00.000Z",
      lastDispatchAttemptAt: "2026-06-13T00:09:30.000Z",
      lastDispatchAcceptedAt: "2026-06-13T00:09:45.000Z",
      lastDispatchRequestId: "dispatch-req-select",
      workProducts: [
        {
          id: "work-product-1",
          title: "Signals brief",
          type: "document",
          url: "http://127.0.0.1:3200/artifacts/signals.html",
          status: "ready_for_review",
          summary: "Generated market signal brief.",
        },
      ],
      metadata: {
        resultPreview: '{ "ticker": "005930", "signal": "hold" }',
        logPreview: "loaded 48 market rows",
      },
      agentName: "signal-agent",
    },
    {
      id: "step-run-report",
      stepId: "report",
      status: "done",
      issueIdentifier: "CMPA-124",
      startedAt: "2026-06-13T00:12:00.000Z",
      completedAt: "2026-06-13T00:20:00.000Z",
    },
    {
      id: "step-run-sync",
      stepId: "sync",
      status: "backlog",
      lastDispatchErrorAt: "2026-06-13T00:21:00.000Z",
      lastDispatchErrorSummary: "tool queue unavailable",
    },
  ]);
  const graph = buildWorkflowGraphModel(withRuns);

  assert.deepEqual(
    graph.edges.map((edge) => `${edge.source}->${edge.target}`),
    ["screen->select", "select->report", "report->sync"],
  );
  assert.equal(graph.nodes.find((node) => node.id === "select")?.runStatus.status, "running");
  assert.equal(graph.nodes.find((node) => node.id === "select")?.runStatus.stepRunId, "step-run-select");
  assert.equal(graph.nodes.find((node) => node.id === "select")?.runStatus.issueId, "issue-select");
  assert.equal(graph.nodes.find((node) => node.id === "select")?.runStatus.issueIdentifier, "CMPA-123");
  assert.equal(graph.nodes.find((node) => node.id === "select")?.runStatus.updatedAt, "2026-06-13T00:10:00.000Z");
  assert.equal(graph.nodes.find((node) => node.id === "select")?.runStatus.startedAt, "2026-06-13T00:10:00.000Z");
  assert.equal(graph.nodes.find((node) => node.id === "select")?.runStatus.lastDispatchAttemptAt, "2026-06-13T00:09:30.000Z");
  assert.equal(graph.nodes.find((node) => node.id === "select")?.runStatus.lastDispatchAcceptedAt, "2026-06-13T00:09:45.000Z");
  assert.equal(graph.nodes.find((node) => node.id === "select")?.runStatus.lastDispatchRequestId, "dispatch-req-select");
  assert.deepEqual(graph.nodes.find((node) => node.id === "select")?.runStatus.workProducts, [
    {
      id: "work-product-1",
      title: "Signals brief",
      type: "document",
      url: "http://127.0.0.1:3200/artifacts/signals.html",
      status: "ready_for_review",
      summary: "Generated market signal brief.",
    },
  ]);
  assert.equal(graph.nodes.find((node) => node.id === "select")?.runStatus.resultPreview, '{ "ticker": "005930", "signal": "hold" }');
  assert.equal(graph.nodes.find((node) => node.id === "select")?.runStatus.logPreview, "loaded 48 market rows");
  assert.deepEqual(graph.nodes.find((node) => node.id === "select")?.runStatus.runtimeBadges, ["Result preview", "Log preview"]);
  assert.deepEqual(
    searchWorkflowGraphNodes(graph, "005930").map((result) => [result.nodeId, result.matchFields]),
    [["select", ["run"]]],
  );
  assert.deepEqual(
    searchWorkflowGraphNodes(graph, "market rows").map((result) => [result.nodeId, result.matchFields]),
    [["select", ["run"]]],
  );
  assert.equal(graph.nodes.find((node) => node.id === "select")?.runStatus.summary, "signal-agent");
  assert.equal(graph.nodes.find((node) => node.id === "report")?.runStatus.status, "succeeded");
  assert.equal(graph.nodes.find((node) => node.id === "report")?.runStatus.stepRunId, "step-run-report");
  assert.equal(graph.nodes.find((node) => node.id === "report")?.runStatus.startedAt, "2026-06-13T00:12:00.000Z");
  assert.equal(graph.nodes.find((node) => node.id === "report")?.runStatus.completedAt, "2026-06-13T00:20:00.000Z");
  assert.equal(graph.nodes.find((node) => node.id === "sync")?.runStatus.status, "planned");
  assert.equal(graph.nodes.find((node) => node.id === "sync")?.runStatus.lastDispatchErrorAt, "2026-06-13T00:21:00.000Z");
  assert.equal(graph.nodes.find((node) => node.id === "sync")?.runStatus.lastDispatchErrorSummary, "tool queue unavailable");
  assert.equal(steps.find((step) => step.id === "select")?.graphRunStatus, undefined);
});

test("applyStepRunsToGraphSteps exposes runtime concurrency and retention overlays", () => {
  const withRuns = applyStepRunsToGraphSteps(steps, [
    {
      id: "step-run-sync",
      stepId: "sync",
      status: "pending",
      metadata: {
        executionControls: {
          concurrencyKey: "market-data",
          concurrencyLimit: 1,
          priority: "low",
        },
        concurrencyBlocked: {
          concurrencyKey: "market-data",
          concurrencyLimit: 1,
          runningCount: 1,
          checkedAt: "2026-06-13T00:22:00.000Z",
        },
      },
    },
    {
      id: "step-run-report",
      stepId: "report",
      status: "completed",
      metadata: {
        executionControls: {
          deleteAfterUse: true,
        },
        retentionDeleted: {
          deleteAfterUse: true,
          toolName: "collect-sensitive-market-data",
          success: true,
          exitCode: 0,
          deletedAt: "2026-06-13T00:24:00.000Z",
        },
      },
    },
  ]);
  const graph = buildWorkflowGraphModel(withRuns);
  const sync = graph.nodes.find((node) => node.id === "sync");
  const report = graph.nodes.find((node) => node.id === "report");

  assert.deepEqual(sync?.runStatus.concurrencyBlocked, {
    concurrencyKey: "market-data",
    concurrencyLimit: 1,
    runningCount: 1,
    checkedAt: "2026-06-13T00:22:00.000Z",
  });
  assert.deepEqual(report?.runStatus.retentionDeleted, {
    deleteAfterUse: true,
    toolName: "collect-sensitive-market-data",
    success: true,
    exitCode: 0,
    deletedAt: "2026-06-13T00:24:00.000Z",
  });
  assert.deepEqual(sync?.runStatus.runtimeBadges, ["Concurrency blocked: market-data"]);
  assert.deepEqual(report?.runStatus.runtimeBadges, ["Deleted after use"]);
  assert.deepEqual(
    searchWorkflowGraphNodes(graph, "concurrency blocked").map((result) => [result.nodeId, result.matchFields]),
    [["sync", ["runtime"]]],
  );
  assert.deepEqual(
    searchWorkflowGraphNodes(graph, "delete after use").map((result) => [result.nodeId, result.matchFields]),
    [["report", ["runtime"]]],
  );
  assert.equal(steps.find((step) => step.id === "sync")?.graphRunConcurrencyBlocked, undefined);
});

test("searchWorkflowGraphNodes finds nodes by step, run, group, and container metadata", () => {
  const grouped = assignStepsToGroup(steps, ["select", "report"], {
    id: "analysis",
    title: "Editorial review",
    color: "#0ea5e9",
  });
  const contained = assignStepsToContainer(grouped, ["sync"], {
    id: "retry-sync",
    type: "loop",
    title: "Retry sync",
    iterator: "result.failedMarkets",
    runInParallel: true,
    parallelism: 3,
  });
  const annotated = updateStepNote(
    setStepGraphRunStatus(contained, "report", {
      status: "failed",
      issueIdentifier: "CMPA-321",
      summary: "validator requested changes",
    }),
    "select",
    "Curate source candidates for the editorial pass.",
  );
  const graph = buildWorkflowGraphModel(annotated);

  assert.deepEqual(
    searchWorkflowGraphNodes(graph, "editorial").map((result) => [result.nodeId, result.matchFields]),
    [
      ["select", ["note", "group"]],
      ["report", ["group"]],
    ],
  );
  assert.deepEqual(
    searchWorkflowGraphNodes(graph, "cmpa-321").map((result) => [result.nodeId, result.matchFields]),
    [["report", ["issue"]]],
  );
  assert.deepEqual(
    searchWorkflowGraphNodes(graph, "parallel").map((result) => [result.nodeId, result.matchFields]),
    [["sync", ["container"]]],
  );
  assert.deepEqual(searchWorkflowGraphNodes(graph, "   "), []);
});

test("insertWorkflowStepFromPalette creates typed nodes while preserving DAG continuity", () => {
  const withBranch = insertWorkflowStepFromPalette(steps, "select", "branch");
  const branch = withBranch.find((step) => step.id === "branch");
  const report = withBranch.find((step) => step.id === "report");

  assert.equal(branch?.title, "Branch");
  assert.equal(branch?.type, "agent");
  assert.equal(branch?.dependsOn, "select");
  assert.equal(branch?.graphContainerId, "branch-branch");
  assert.equal(branch?.graphContainerType, "branch");
  assert.equal(branch?.graphContainerMode, "branch-one");
  assert.equal(branch?.graphContainerTitle, "Branch");
  assert.equal(report?.dependsOn, "branch");

  const withLoop = insertWorkflowStepFromPalette(withBranch, "branch", "loop");
  const loop = withLoop.find((step) => step.id === "loop");
  assert.equal(loop?.dependsOn, "branch");
  assert.equal(loop?.graphContainerId, "loop-loop");
  assert.equal(loop?.graphContainerType, "loop");
  assert.equal(loop?.graphContainerMode, "for-each");
  assert.equal(loop?.graphContainerIterator, "result.items");
  assert.equal(loop?.graphContainerRunInParallel, true);
  assert.equal(withLoop.find((step) => step.id === "report")?.dependsOn, "loop");

  const withFailureHandler = insertWorkflowStepFromPalette(withLoop, "loop", "failure-handler");
  const failureHandler = withFailureHandler.find((step) => step.id === "failure-handler");
  assert.equal(failureHandler?.onFailure, "escalate");
  assert.equal(failureHandler?.graphEdgeMetadata?.loop?.kind, "failure");
  assert.equal(failureHandler?.graphEdgeMetadata?.loop?.label, "failure");
  assert.equal(withFailureHandler.find((step) => step.id === "report")?.dependsOn, "failure-handler");

  const withApproval = insertWorkflowStepFromPalette(withFailureHandler, "failure-handler", "approval");
  const approval = withApproval.find((step) => step.id === "approval");
  assert.equal(approval?.title, "Approval gate");
  assert.equal(approval?.dependsOn, "failure-handler");
  assert.equal(approval?.graphApprovalRequired, true);
  assert.equal(approval?.graphApprovalTimeoutAction, "cancel");
  assert.equal(withApproval.find((step) => step.id === "report")?.dependsOn, "approval");

  const graph = buildWorkflowGraphModel(withApproval);
  assert.deepEqual(
    graph.edges.map((edge) => [edge.source, edge.target, edge.kind]),
    [
      ["screen", "select", "normal"],
      ["select", "branch", "normal"],
      ["branch", "loop", "normal"],
      ["loop", "failure-handler", "failure"],
      ["failure-handler", "approval", "normal"],
      ["approval", "report", "normal"],
      ["report", "sync", "normal"],
    ],
  );
});

test("buildWorkflowGraphWorkbenchSummary keeps graph-first canvas commands in the default workbench", () => {
  const summary = buildWorkflowGraphWorkbenchSummary(steps, "select", ["select", "report"]);

  assert.deepEqual(
    summary.commandGroups.map((group) => group.id),
    ["canvas", "add", "path"],
  );
  assert.deepEqual(
    summary.commandGroups[0].actions.map((action) => [action.id, action.label, Boolean(action.disabled)]),
    [
      ["fit-canvas", "Fit", false],
      ["actual-size", "100%", false],
      ["center-selected", "Center", false],
      ["diagnostics", "Diagnostics", false],
    ],
  );
  assert.equal(summary.detailsHiddenByDefault, true);
  assert.equal(summary.pathSummary, "Selection contains 2 steps from select to report, receives 1 inbound step, and hands off to 1 outbound step.");
  assert.ok(summary.statusBadges.includes("2 selected"));

  const noSelection = buildWorkflowGraphWorkbenchSummary(steps, "", []);
  assert.equal(
    noSelection.commandGroups[0].actions.find((action) => action.id === "center-selected")?.disabled,
    true,
  );
});
