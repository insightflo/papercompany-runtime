import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPANY_ID,
  WORKFLOW_ID,
  WORKFLOW_NAME,
  buildConceptRadarMigrationPlan,
  migrateConceptRadarSteps,
} from "./migrate-agent-team-concept-radar-native-branch.mjs";

const STEP_IDS = [
  "collect-arxiv-candidates",
  "scout-social-ai-concepts",
  "select-novel-concept",
  "validate-novelty-decision",
  "research-selected-concept",
  "draft-beginner-concept",
  "validate-concept-content",
  "build-beginner-concept-html",
  "validate-concept-html",
  "publish-concept-conditionally",
  "verify-concept-conditionally",
];

const SKIP_SENTENCE = "If status is skip with SKIP_NO_NOVEL_TOPIC, register skip-receipt.json and complete normally.";

function fixtureSteps() {
  return STEP_IDS.map((id, index) => ({
    id,
    name: id,
    type: id === "collect-arxiv-candidates" ? "tool" : "agent",
    dependsOn: index === 0 || index === 1 ? [] : [STEP_IDS[index - 1]],
    dependencies: index === 0 || index === 1 ? [] : [STEP_IDS[index - 1]],
    description: index >= 4 ? `Keep substantive instructions. ${SKIP_SENTENCE}` : "Keep selection instructions.",
    ...(id === "select-novel-concept" ? {
      dependsOn: ["collect-arxiv-candidates", "scout-social-ai-concepts"],
      dependencies: ["collect-arxiv-candidates", "scout-social-ai-concepts"],
      conditionalDependencies: [{ stepId: "validate-novelty-decision", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 }],
    } : {}),
    ...(id === "research-selected-concept" ? {
      dependsOn: ["validate-novelty-decision"],
      dependencies: ["validate-novelty-decision"],
    } : {}),
  }));
}

test("inserts native IF/Complete and rewires only the concept-radar branch", () => {
  const before = fixtureSteps();
  const after = migrateConceptRadarSteps(before);

  assert.equal(after.length, 13);
  assert.deepEqual(after.find((step) => step.id === "if-has-selected-topic"), {
    id: "if-has-selected-topic",
    name: "Has selected topic?",
    type: "if",
    dependencies: ["validate-novelty-decision"],
    conditionGroup: {
      combinator: "all",
      conditions: [{
        source: { kind: "work_product_json", stepId: "select-novel-concept", title: "topic-decision.json", path: "$.status" },
        dataType: "string",
        operator: "equals",
        rightValue: "selected",
      }],
    },
  });
  assert.deepEqual(after.find((step) => step.id === "complete-no-novel-topic"), {
    id: "complete-no-novel-topic",
    name: "Complete: no novel topic",
    type: "complete",
    dependencies: [],
    conditionalDependencies: [{ stepId: "if-has-selected-topic", when: "condition_false" }],
    completionReason: "No novel concept passed selection for this run.",
  });
  const research = after.find((step) => step.id === "research-selected-concept");
  assert.deepEqual(research.dependsOn, []);
  assert.deepEqual(research.dependencies, []);
  assert.deepEqual(research.conditionalDependencies, [{ stepId: "if-has-selected-topic", when: "condition_true" }]);
  assert.deepEqual(
    after.find((step) => step.id === "select-novel-concept").conditionalDependencies,
    before.find((step) => step.id === "select-novel-concept").conditionalDependencies,
  );
  assert.match(research.description, /Keep substantive instructions/);
  assert.doesNotMatch(research.description, /skip-receipt/);
  assert.deepEqual(migrateConceptRadarSteps(after), after);
});

test("refuses an unexpected workflow shape", () => {
  assert.throws(() => migrateConceptRadarSteps(fixtureSteps().slice(1)), /unexpected step IDs/i);
  assert.throws(() => migrateConceptRadarSteps([...fixtureSteps(), { id: "surprise" }]), /unexpected step IDs/i);
});

test("requires the exact live updatedAt value for apply", () => {
  const workflow = {
    id: WORKFLOW_ID,
    companyId: COMPANY_ID,
    name: WORKFLOW_NAME,
    updatedAt: "2026-07-20T00:08:04.941Z",
    steps: fixtureSteps(),
  };
  assert.throws(
    () => buildConceptRadarMigrationPlan(workflow, { apply: true, expectedUpdatedAt: "2026-07-20T00:00:00.000Z" }),
    /updatedAt mismatch/,
  );
  assert.throws(
    () => buildConceptRadarMigrationPlan(workflow, { apply: true }),
    /expected-updated-at/,
  );
  const plan = buildConceptRadarMigrationPlan(workflow, { apply: true, expectedUpdatedAt: workflow.updatedAt });
  assert.equal(plan.summary.timestampMatches, true);
});
