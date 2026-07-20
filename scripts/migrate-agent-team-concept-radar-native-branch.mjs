#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const API_URL = "https://papercompany.showk.ing";
export const COMPANY_ID = "ff3e3efd-e30c-45c2-b893-497164405629";
export const WORKFLOW_ID = "6fa3f267-d00e-44d9-959d-bd161d1c4aeb";
export const WORKFLOW_NAME = "agent-team-concept-radar";

const AUTH_FILE = "/Users/kwak/.paperclip/auth.json";
const IF_STEP_ID = "if-has-selected-topic";
const COMPLETE_STEP_ID = "complete-no-novel-topic";
const ORIGINAL_STEP_IDS = [
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
const DOWNSTREAM_SKIP_RECEIPT_STEPS = new Set(ORIGINAL_STEP_IDS.slice(4));
const ACTIVE_RUN_STATUSES = new Set(["pending", "queued", "running", "paused"]);

const IF_STEP = {
  id: IF_STEP_ID,
  name: "Has selected topic?",
  type: "if",
  dependencies: ["validate-novelty-decision"],
  conditionGroup: {
    combinator: "all",
    conditions: [{
      source: {
        kind: "work_product_json",
        stepId: "select-novel-concept",
        title: "topic-decision.json",
        path: "$.status",
      },
      dataType: "string",
      operator: "equals",
      rightValue: "selected",
    }],
  },
};

const COMPLETE_STEP = {
  id: COMPLETE_STEP_ID,
  name: "Complete: no novel topic",
  type: "complete",
  dependencies: [],
  conditionalDependencies: [{ stepId: IF_STEP_ID, when: "condition_false" }],
  completionReason: "No novel concept passed selection for this run.",
};

function sameStringArray(value, expected) {
  return Array.isArray(value) && value.length === expected.length && value.every((entry, index) => entry === expected[index]);
}

function assertExactStepIds(steps) {
  if (!Array.isArray(steps)) throw new Error("Workflow steps are unavailable");
  const ids = steps.map((step) => step?.id);
  const original = ids.length === ORIGINAL_STEP_IDS.length && ids.every((id) => ORIGINAL_STEP_IDS.includes(id));
  const migratedIds = [...ORIGINAL_STEP_IDS, IF_STEP_ID, COMPLETE_STEP_ID];
  const migrated = ids.length === migratedIds.length && ids.every((id) => migratedIds.includes(id));
  if ((!original && !migrated) || new Set(ids).size !== ids.length) {
    throw new Error(`Refusing migration: unexpected step IDs (count=${ids.length})`);
  }
  return migrated;
}

function stripSkipReceiptInstruction(description) {
  if (typeof description !== "string" || !description.trim()) return description;
  const sentences = description.split(/(?<=[.!?])\s+|\n+/);
  return sentences
    .filter((sentence) => !(/skip/i.test(sentence) && /receipt/i.test(sentence)))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function assertOriginalPredecessors(steps) {
  const validate = steps.find((step) => step.id === "validate-novelty-decision");
  const research = steps.find((step) => step.id === "research-selected-concept");
  if (!validate || !sameStringArray(validate.dependsOn, ["select-novel-concept"]) || !sameStringArray(validate.dependencies, ["select-novel-concept"])) {
    throw new Error("Refusing migration: validate-novelty-decision predecessors changed");
  }
  if (!research || !sameStringArray(research.dependsOn, ["validate-novelty-decision"]) || !sameStringArray(research.dependencies, ["validate-novelty-decision"])) {
    throw new Error("Refusing migration: research-selected-concept predecessors changed");
  }
}

function assertMigratedTopology(steps) {
  const research = steps.find((step) => step.id === "research-selected-concept");
  const ifStep = steps.find((step) => step.id === IF_STEP_ID);
  const complete = steps.find((step) => step.id === COMPLETE_STEP_ID);
  const expectedResearchEdge = research?.conditionalDependencies?.filter((edge) => edge?.isBackEdge !== true) ?? [];
  if (!ifStep || !complete || !research || !sameStringArray(research.dependsOn, []) || !sameStringArray(research.dependencies, [])) {
    throw new Error("Refusing migration: existing native branch topology is malformed");
  }
  if (expectedResearchEdge.length !== 1 || expectedResearchEdge[0]?.stepId !== IF_STEP_ID || expectedResearchEdge[0]?.when !== "condition_true") {
    throw new Error("Refusing migration: existing native branch true edge is malformed");
  }
}

export function migrateConceptRadarSteps(steps) {
  const alreadyMigrated = assertExactStepIds(steps);
  if (alreadyMigrated) {
    assertMigratedTopology(steps);
    return steps.map((step) => DOWNSTREAM_SKIP_RECEIPT_STEPS.has(step.id)
      ? { ...step, description: stripSkipReceiptInstruction(step.description) }
      : step);
  }
  assertOriginalPredecessors(steps);

  const migrated = [];
  for (const step of steps) {
    if (step.id === "validate-novelty-decision") {
      migrated.push(step, structuredClone(IF_STEP), structuredClone(COMPLETE_STEP));
      continue;
    }
    if (step.id === "research-selected-concept") {
      const backEdges = Array.isArray(step.conditionalDependencies)
        ? step.conditionalDependencies.filter((edge) => edge?.isBackEdge === true)
        : [];
      migrated.push({
        ...step,
        dependsOn: [],
        dependencies: [],
        conditionalDependencies: [...backEdges, { stepId: IF_STEP_ID, when: "condition_true" }],
        description: stripSkipReceiptInstruction(step.description),
      });
      continue;
    }
    migrated.push(DOWNSTREAM_SKIP_RECEIPT_STEPS.has(step.id)
      ? { ...step, description: stripSkipReceiptInstruction(step.description) }
      : step);
  }
  return migrated;
}

export function buildConceptRadarMigrationPlan(workflow, { apply = false, expectedUpdatedAt } = {}) {
  if (workflow?.id !== WORKFLOW_ID || workflow?.companyId !== COMPANY_ID || workflow?.name !== WORKFLOW_NAME) {
    throw new Error("Refusing migration: workflow identity mismatch");
  }
  if (apply && !expectedUpdatedAt) {
    throw new Error("--apply requires --expected-updated-at=<ISO timestamp>");
  }
  const timestampMatches = expectedUpdatedAt ? workflow.updatedAt === expectedUpdatedAt : null;
  if (apply && !timestampMatches) {
    throw new Error(`updatedAt mismatch: expected ${expectedUpdatedAt}, current ${workflow.updatedAt}`);
  }
  const steps = migrateConceptRadarSteps(workflow.steps);
  return {
    steps,
    summary: {
      workflow: WORKFLOW_NAME,
      workflowId: WORKFLOW_ID,
      beforeStepIds: workflow.steps.map((step) => step.id),
      afterStepIds: steps.map((step) => step.id),
      addedStepIds: [IF_STEP_ID, COMPLETE_STEP_ID].filter((id) => !workflow.steps.some((step) => step.id === id)),
      edges: {
        true: `${IF_STEP_ID} -> research-selected-concept`,
        false: `${IF_STEP_ID} -> ${COMPLETE_STEP_ID}`,
      },
      currentUpdatedAt: workflow.updatedAt,
      expectedUpdatedAt: expectedUpdatedAt ?? null,
      timestampMatches,
    },
  };
}

async function loadToken() {
  const auth = JSON.parse(await readFile(AUTH_FILE, "utf8"));
  const token = auth.credentials?.[API_URL]?.token;
  if (!token) throw new Error("Papercompany CLI token is unavailable");
  return token;
}

async function api(token, pathname, options = {}) {
  const response = await fetch(`${API_URL}${pathname}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(options.headers ?? {}) },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${pathname} failed (${response.status}): ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const expectedUpdatedAt = process.argv.find((arg) => arg.startsWith("--expected-updated-at="))?.split("=").slice(1).join("=");
  const token = await loadToken();
  const [workflow, runs] = await Promise.all([
    api(token, `/api/workflows/${WORKFLOW_ID}`),
    api(token, `/api/workflows/${WORKFLOW_ID}/runs`),
  ]);
  const plan = buildConceptRadarMigrationPlan(workflow, { apply, expectedUpdatedAt });
  const activeRuns = Array.isArray(runs) ? runs.filter((run) => ACTIVE_RUN_STATUSES.has(run?.status)) : [];
  if (apply && activeRuns.length > 0) throw new Error(`Refusing migration: ${activeRuns.length} active workflow run(s)`);

  if (!apply) {
    console.log(JSON.stringify({ mode: "dry-run", activeRunCount: activeRuns.length, ...plan.summary }, null, 2));
    return;
  }
  const [current, currentRuns] = await Promise.all([
    api(token, `/api/workflows/${WORKFLOW_ID}`),
    api(token, `/api/workflows/${WORKFLOW_ID}/runs`),
  ]);
  const currentActiveRuns = Array.isArray(currentRuns)
    ? currentRuns.filter((run) => ACTIVE_RUN_STATUSES.has(run?.status))
    : [];
  if (currentActiveRuns.length > 0) {
    throw new Error(`Refusing migration: ${currentActiveRuns.length} active workflow run(s) appeared before apply`);
  }
  buildConceptRadarMigrationPlan(current, { apply: true, expectedUpdatedAt });
  await api(token, `/api/workflows/${WORKFLOW_ID}`, { method: "PATCH", body: JSON.stringify({ steps: plan.steps }) });
  console.log(JSON.stringify({ mode: "applied", activeRunCount: 0, ...plan.summary }, null, 2));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
