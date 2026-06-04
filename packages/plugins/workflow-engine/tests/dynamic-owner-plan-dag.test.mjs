import assert from "node:assert/strict";
import test from "node:test";

import {
  getNextSteps,
  getWorkflowLaunchSteps,
  isDynamicOwnerPlanWorkflowDefinition,
  validateDag,
  validateWorkflowLaunchability,
} from "../dist/dag-engine.js";

const staticResearchSteps = [
  { id: "plan", title: "Plan", dependsOn: [] },
  { id: "collect", title: "Collect", dependsOn: ["plan"] },
  { id: "synthesize", title: "Synthesize", dependsOn: ["collect"] },
];

test("dynamic owner-plan workflows launch only bootstrap root steps", () => {
  const launched = getWorkflowLaunchSteps(staticResearchSteps, {
    dynamicOwnerPlan: true,
  });

  assert.deepEqual(launched.map((step) => step.id), ["plan"]);
});

test("dynamic owner-plan workflows complete after the launched plan step finishes", () => {
  const result = getNextSteps(
    staticResearchSteps,
    new Set(["plan"]),
    new Set(),
    new Set(),
    {
      dynamicOwnerPlan: true,
      launchedStepIds: new Set(["plan"]),
    },
  );

  assert.deepEqual(result.readyStepIds, []);
  assert.equal(result.isWorkflowComplete, true);
});

test("static DAG workflows still activate downstream steps after plan finishes", () => {
  const result = getNextSteps(
    staticResearchSteps,
    new Set(["plan"]),
    new Set(),
    new Set(),
  );

  assert.deepEqual(result.readyStepIds, ["collect"]);
  assert.equal(result.isWorkflowComplete, false);
});

test("explicit dynamic owner-plan marker is recognized on workflow definitions", () => {
  assert.equal(
    isDynamicOwnerPlanWorkflowDefinition({
      name: "research-daily",
      executionMode: "dynamic_owner_plan",
      steps: staticResearchSteps,
    }),
    true,
  );

  assert.equal(
    isDynamicOwnerPlanWorkflowDefinition({
      name: "static-release-workflow",
      executionMode: "static_dag",
      steps: staticResearchSteps,
    }),
    false,
  );
});

test("legacy tech research daily workflows are treated as dynamic owner-plan bootstrap", () => {
  assert.equal(
    isDynamicOwnerPlanWorkflowDefinition({
      name: "tech-ai-news",
      steps: staticResearchSteps,
    }),
    true,
  );

  assert.equal(
    isDynamicOwnerPlanWorkflowDefinition({
      name: "tech-scout",
      steps: staticResearchSteps,
    }),
    true,
  );
});

test("removing a root plan step while leaving dependencies produces no activatable root", () => {
  const steps = [
    { id: "collect-evidence", title: "Collect Evidence", dependsOn: ["plan-scout"] },
    { id: "synthesize-report", title: "Synthesize Report", dependsOn: ["collect-evidence"] },
  ];

  assert.equal(
    isDynamicOwnerPlanWorkflowDefinition({ name: "tech-scout", steps }),
    false,
  );
  assert.deepEqual(getWorkflowLaunchSteps(steps, { dynamicOwnerPlan: false }).filter((step) => step.dependsOn.length === 0).map((step) => step.id), []);

  const validation = validateDag(steps);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join("\n"), /depends on missing step "plan-scout"/);

  const launchability = validateWorkflowLaunchability({ name: "tech-scout", steps });
  assert.equal(launchability.valid, false);
  assert.match(launchability.errors.join("\n"), /missing step "plan-scout"/);
});

test("workflow launchability rejects active workflows with no normal root step", () => {
  const launchability = validateWorkflowLaunchability({
    name: "rootless-static",
    steps: [
      { id: "collect", title: "Collect", dependsOn: ["synthesize"] },
      { id: "synthesize", title: "Synthesize", dependsOn: ["collect"] },
    ],
  });

  assert.equal(launchability.valid, false);
  assert.match(launchability.errors.join("\n"), /no activatable root step/i);
});
