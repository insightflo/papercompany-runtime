/**
 * DAG Engine
 *
 * Validates and executes Directed Acyclic Graph (DAG) workflows.
 * A workflow is a DAG where each step has dependencies on other steps.
 */

import { and, asc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues, issueComments, issueWorkProducts, workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import type { DagValidationResult, WorkflowExecutionResult } from "./types.js";
import { issueService } from "../issues.js";
import { heartbeatService } from "../heartbeat.js";
import { applyIssueCreatedSideEffects } from "../issue-create-side-effects.js";
import { queueIssueAssignmentWakeup } from "../issue-assignment-wakeup.js";
import { stopMissionRuntimesForMission, TERMINAL_WORKFLOW_STATUSES } from "../missions/mission-runtime-manager.js";

/**
 * Workflow step definition.
 */
export interface WorkflowStep {
  id: string;
  name: string;
  agentId: string;
  dependencies: string[]; // step IDs this step depends on
  description?: string;
  toolNames?: string[];
  knowledgeBaseIds?: string[];
  triggerOn?: "normal" | "escalation";
  /**
   * Dynamic owner-plan marker. In this mode the native workflow engine only
   * launches bootstrap/root planning steps; the owner plan creates concrete
   * mission child issues dynamically rather than the static DAG activating
   * every declared downstream step.
   */
  dynamicChildren?: boolean | string;
  ownerPlanBootstrapOnly?: boolean | string;
  bootstrapOnly?: boolean | string;
  executionMode?: "static_dag" | "dynamic_owner_plan" | string;
  workflowMode?: "static_dag" | "dynamic_owner_plan" | string;
}

export type WorkflowExecutionMode = "static_dag" | "dynamic_owner_plan";

type PersistedWorkflowStep = WorkflowStep & {
  title?: unknown;
  dependsOn?: unknown;
  tools?: unknown;
  toolName?: unknown;
  toolArgs?: unknown;
  type?: unknown;
  agentName?: unknown;
};

const WORKFLOW_STEP_TERMINAL_STATUSES = new Set(["completed", "failed", "skipped"]);
const WORKFLOW_STEP_SUCCESS_STATUSES = new Set(["completed"]);

export type WorkflowToolStepExecutionRequest = {
  companyId: string;
  workflowRunId: string;
  workflowId: string;
  stepId: string;
  stepRunId: string;
  toolName: string;
  args: unknown;
  requestId: string;
};

export type WorkflowToolStepExecutionResult = {
  accepted?: boolean;
  duplicate?: boolean;
};

export type WorkflowToolStepExecutor = (
  request: WorkflowToolStepExecutionRequest,
) => Promise<WorkflowToolStepExecutionResult | void>;

let workflowToolStepExecutor: WorkflowToolStepExecutor | null = null;

export function setWorkflowToolStepExecutor(executor: WorkflowToolStepExecutor | null): void {
  workflowToolStepExecutor = executor;
}

type WorkflowExecutionContext = {
  run: typeof workflowRuns.$inferSelect;
  definition: typeof workflowDefinitions.$inferSelect;
  steps: WorkflowStep[];
  stepRuns: (typeof workflowStepRuns.$inferSelect)[];
};

type WorkflowDefinitionExecutionShape = {
  name?: unknown;
  executionMode?: unknown;
  dynamicPlanBootstrapOnly?: unknown;
  workflowMode?: unknown;
  steps?: WorkflowStep[];
};

function normalizeStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const strings = value
      .map((item) => typeof item === "string" ? item.trim() : "")
      .filter(Boolean);
    return strings.length > 0 ? strings : undefined;
  }
  if (typeof value === "string") {
    const strings = value.split(",").map((item) => item.trim()).filter(Boolean);
    return strings.length > 0 ? strings : undefined;
  }
  return undefined;
}

export function normalizeWorkflowStepsForExecution(rawSteps: unknown): WorkflowStep[] {
  if (!Array.isArray(rawSteps)) return [];
  return rawSteps.map((rawStep) => {
    const step = (rawStep && typeof rawStep === "object" ? rawStep : {}) as PersistedWorkflowStep;
    const dependencies = normalizeStringArray(step.dependencies) ?? normalizeStringArray(step.dependsOn) ?? [];
    const toolNames = normalizeStringArray(step.toolNames)
      ?? normalizeStringArray(step.tools)
      ?? normalizeStringArray(step.toolName);
    return {
      ...step,
      id: typeof step.id === "string" && step.id.trim() ? step.id.trim() : crypto.randomUUID(),
      name: typeof step.name === "string" && step.name.trim()
        ? step.name.trim()
        : typeof step.title === "string" && step.title.trim()
          ? step.title.trim()
          : typeof step.id === "string" && step.id.trim()
            ? step.id.trim()
            : "Untitled step",
      agentId: typeof step.agentId === "string" ? step.agentId : "",
      dependencies,
      ...(toolNames ? { toolNames } : {}),
    };
  });
}

function isTruthyBooleanMarker(value: unknown): boolean {
  return value === true || value === "true" || value === "1";
}

function getNormalWorkflowSteps(steps: WorkflowStep[]): WorkflowStep[] {
  return steps.filter((step) => step.triggerOn !== "escalation");
}

function isDynamicOwnerPlanStep(step: WorkflowStep): boolean {
  return isTruthyBooleanMarker(step.dynamicChildren)
    || isTruthyBooleanMarker(step.ownerPlanBootstrapOnly)
    || isTruthyBooleanMarker(step.bootstrapOnly)
    || step.executionMode === "dynamic_owner_plan"
    || step.workflowMode === "dynamic_owner_plan";
}

function hasRootPlanningStep(steps: WorkflowStep[]): boolean {
  return steps.some((step) => {
    if (step.triggerOn === "escalation" || step.dependencies.length > 0) {
      return false;
    }
    const id = step.id.toLowerCase();
    const name = step.name.toLowerCase();
    return id === "plan" || id.endsWith("-plan") || name.includes("plan") || name.includes("계획");
  });
}

function isLegacyResearchDailyWorkflowName(name: unknown): boolean {
  if (typeof name !== "string") return false;
  const normalized = name.trim().toLowerCase();
  return normalized === "tech-scout"
    || normalized === "tech-ai-news"
    || normalized === "daily-tech-scout"
    || normalized === "daily-tech-ai-news";
}

export function isDynamicOwnerPlanWorkflowDefinition(
  definition: WorkflowDefinitionExecutionShape,
): boolean {
  if (definition.executionMode === "static_dag" || definition.workflowMode === "static_dag") {
    return false;
  }

  if (
    definition.executionMode === "dynamic_owner_plan"
    || definition.workflowMode === "dynamic_owner_plan"
    || isTruthyBooleanMarker(definition.dynamicPlanBootstrapOnly)
  ) {
    return true;
  }

  const steps = Array.isArray(definition.steps) ? definition.steps : [];
  if (steps.some(isDynamicOwnerPlanStep)) {
    return true;
  }

  return isLegacyResearchDailyWorkflowName(definition.name) && hasRootPlanningStep(steps);
}

function getWorkflowLaunchSteps(
  steps: WorkflowStep[],
  options: { dynamicOwnerPlan?: boolean } = {},
): WorkflowStep[] {
  if (!options.dynamicOwnerPlan) return steps;
  return steps.filter((step) => step.triggerOn !== "escalation" && step.dependencies.length === 0);
}

function buildWorkflowDefinitionExecutionShape(context: WorkflowExecutionContext): WorkflowDefinitionExecutionShape {
  const definitionMeta = context.definition as typeof workflowDefinitions.$inferSelect & {
    executionMode?: unknown;
    dynamicPlanBootstrapOnly?: unknown;
    workflowMode?: unknown;
  };
  return {
    name: context.definition.name,
    executionMode: definitionMeta.executionMode,
    dynamicPlanBootstrapOnly: definitionMeta.dynamicPlanBootstrapOnly,
    workflowMode: definitionMeta.workflowMode,
    steps: context.steps,
  };
}

function getDynamicLaunchStepIds(context: WorkflowExecutionContext): Set<string> | undefined {
  const dynamicOwnerPlan = isDynamicOwnerPlanWorkflowDefinition(buildWorkflowDefinitionExecutionShape(context));
  if (!dynamicOwnerPlan) return undefined;
  return new Set(getWorkflowLaunchSteps(context.steps, { dynamicOwnerPlan }).map((step) => step.id));
}


/**
 * Validates that a workflow DAG is acyclic and well-formed.
 *
 * @param steps - The workflow steps to validate.
 * @returns Validation result with any errors or warnings.
 */
export function validateDag(steps: WorkflowStep[]): DagValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const stepIds = new Set(steps.map((s) => s.id));

  // Check for duplicate step IDs
  if (stepIds.size !== steps.length) {
    errors.push("Duplicate step IDs detected");
  }

  // Check for orphan dependencies
  for (const step of steps) {
    for (const dep of step.dependencies) {
      if (!stepIds.has(dep)) {
        errors.push(`Step "${step.id}" depends on non-existent step "${dep}"`);
      }
    }
  }

  // Check for cycles using depth-first search
  const hasCycle = detectCycle(steps);
  if (hasCycle) {
    errors.push("Workflow contains a cycle (circular dependency)");
  }

  // Check for steps with no dependencies (entry points)
  const entryPoints = steps.filter((s) => s.dependencies.length === 0);
  if (entryPoints.length === 0 && steps.length > 0) {
    errors.push("Workflow has no entry points (all steps have dependencies)");
  }

  // Check for unreachable steps
  if (entryPoints.length > 0) {
    const reachable = new Set<string>();
    for (const entry of entryPoints) {
      dfsReachable(entry, steps, reachable);
    }
    for (const step of steps) {
      if (!reachable.has(step.id)) {
        warnings.push(`Step "${step.id}" is unreachable from any entry point`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Detects cycles in a DAG using DFS with coloring.
 */
function detectCycle(steps: WorkflowStep[]): boolean {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;

  const color = new Map<string, number>();
  for (const step of steps) {
    color.set(step.id, WHITE);
  }

  function dfs(stepId: string): boolean {
    const c = color.get(stepId);
    if (c === GRAY) return true; // back edge -> cycle
    if (c === BLACK) return false;

    color.set(stepId, GRAY);

    const step = steps.find((s) => s.id === stepId);
    if (step) {
      for (const dep of step.dependencies) {
        if (dfs(dep)) return true;
      }
    }

    color.set(stepId, BLACK);
    return false;
  }

  for (const step of steps) {
    if (color.get(step.id) === WHITE) {
      if (dfs(step.id)) return true;
    }
  }

  return false;
}

/**
 * Marks all steps reachable from the given step.
 */
function dfsReachable(step: WorkflowStep, allSteps: WorkflowStep[], visited: Set<string>): void {
  if (visited.has(step.id)) return;
  visited.add(step.id);

  for (const depId of step.dependencies) {
    const dep = allSteps.find((s) => s.id === depId);
    if (dep) {
      dfsReachable(dep, allSteps, visited);
    }
  }
}

async function loadWorkflowExecutionContext(db: Db, runId: string): Promise<WorkflowExecutionContext> {
  const runResult = await db
    .select({
      run: workflowRuns,
      definition: workflowDefinitions,
    })
    .from(workflowRuns)
    .innerJoin(workflowDefinitions, eq(workflowRuns.workflowId, workflowDefinitions.id))
    .where(eq(workflowRuns.id, runId))
    .limit(1);

  if (!runResult[0]) {
    throw new Error(`Workflow run ${runId} not found`);
  }

  const { run, definition } = runResult[0] as {
    run: typeof workflowRuns.$inferSelect;
    definition: typeof workflowDefinitions.$inferSelect;
  };
  const steps = normalizeWorkflowStepsForExecution(definition.stepsJson);
  const stepRuns = await db
    .select()
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, runId));

  return { run, definition, steps, stepRuns };
}

async function ensureStepRunRecords(
  db: Db,
  runId: string,
  steps: WorkflowStep[],
): Promise<(typeof workflowStepRuns.$inferSelect)[]> {
  const existing = await db
    .select()
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, runId));

  const existingStepIds = new Set(existing.map((stepRun) => stepRun.stepId));
  const missingSteps = steps.filter((step) => !existingStepIds.has(step.id));

  if (missingSteps.length > 0) {
    await db.insert(workflowStepRuns).values(
      missingSteps.map((step) => ({
        id: crypto.randomUUID(),
        workflowRunId: runId,
        stepId: step.id,
        status: "pending",
      })),
    );
  }

  if (missingSteps.length === 0) return existing;
  return db
    .select()
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, runId));
}

function desiredStepRunStatusFromIssueStatus(issueStatus: string): "pending" | "running" | "completed" | "failed" {
  if (issueStatus === "done") return "completed";
  if (issueStatus === "blocked" || issueStatus === "cancelled") return "failed";
  if (issueStatus === "in_progress" || issueStatus === "in_review") return "running";
  return "pending";
}

async function syncStepRunsFromIssueState(
  db: Db,
  stepRuns: (typeof workflowStepRuns.$inferSelect)[],
): Promise<(typeof workflowStepRuns.$inferSelect)[]> {
  const issueIds = stepRuns
    .map((stepRun) => stepRun.issueId)
    .filter((issueId): issueId is string => Boolean(issueId));
  if (issueIds.length === 0) return stepRuns;

  const issueRows = await db
    .select({
      id: issues.id,
      status: issues.status,
      startedAt: issues.startedAt,
      completedAt: issues.completedAt,
      cancelledAt: issues.cancelledAt,
    })
    .from(issues)
    .where(inArray(issues.id, issueIds));
  const issueById = new Map(issueRows.map((issue) => [issue.id, issue]));

  for (const stepRun of stepRuns) {
    if (!stepRun.issueId) continue;
    const issue = issueById.get(stepRun.issueId);
    if (!issue) continue;

    const desiredStatus = desiredStepRunStatusFromIssueStatus(issue.status);
    const patch: Partial<typeof workflowStepRuns.$inferInsert> = {};
    const now = new Date();

    if (desiredStatus !== stepRun.status) {
      patch.status = desiredStatus;
    }

    if (desiredStatus === "running") {
      patch.startedAt = stepRun.startedAt ?? issue.startedAt ?? now;
      patch.completedAt = null;
    } else if (desiredStatus === "completed") {
      patch.startedAt = stepRun.startedAt ?? issue.startedAt ?? now;
      patch.completedAt = issue.completedAt ?? now;
    } else if (desiredStatus === "failed") {
      patch.startedAt = stepRun.startedAt ?? issue.startedAt ?? now;
      patch.completedAt = issue.cancelledAt ?? issue.completedAt ?? now;
    } else {
      patch.startedAt = null;
      patch.completedAt = null;
    }

    if (Object.keys(patch).length === 0) continue;
    await db
      .update(workflowStepRuns)
      .set(patch)
      .where(eq(workflowStepRuns.id, stepRun.id));
  }

  return db
    .select()
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, stepRuns[0]!.workflowRunId));
}

async function resetSkippedUnlaunchedStepRuns(
  db: Db,
  stepRuns: (typeof workflowStepRuns.$inferSelect)[],
): Promise<(typeof workflowStepRuns.$inferSelect)[]> {
  const skipped = stepRuns.filter((stepRun) => stepRun.status === "skipped" && stepRun.issueId == null);
  if (skipped.length === 0) return stepRuns;

  await db
    .update(workflowStepRuns)
    .set({
      status: "pending",
      startedAt: null,
      completedAt: null,
    })
    .where(inArray(workflowStepRuns.id, skipped.map((stepRun) => stepRun.id)));

  return db
    .select()
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, stepRuns[0]!.workflowRunId));
}

async function createWorkflowStepIssue(input: {
  db: Db;
  run: typeof workflowRuns.$inferSelect;
  definition: typeof workflowDefinitions.$inferSelect;
  step: WorkflowStep;
}): Promise<string> {
  const issueSvc = issueService(input.db);
  const heartbeat = heartbeatService(input.db);

  const assigneeAgentId = await resolveWorkflowStepAssigneeAgentId(input.db, input.run.companyId, input.step);
  const dependencyIssueRows = input.step.dependencies.length > 0
    ? await input.db
      .select({
        stepId: workflowStepRuns.stepId,
        issueId: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
      })
      .from(workflowStepRuns)
      .innerJoin(issues, eq(workflowStepRuns.issueId, issues.id))
      .where(and(
        eq(workflowStepRuns.workflowRunId, input.run.id),
        inArray(workflowStepRuns.stepId, input.step.dependencies),
      ))
    : [];
  const dependencyWorkProductRows = dependencyIssueRows.length > 0
    ? await input.db
      .select({
        issueId: issueWorkProducts.issueId,
        title: issueWorkProducts.title,
        type: issueWorkProducts.type,
        provider: issueWorkProducts.provider,
        url: issueWorkProducts.url,
        externalId: issueWorkProducts.externalId,
        metadata: issueWorkProducts.metadata,
        status: issueWorkProducts.status,
      })
      .from(issueWorkProducts)
      .where(inArray(issueWorkProducts.issueId, dependencyIssueRows.map((row) => row.issueId)))
    : [];
  const dependencyWorkProductsByIssueId = new Map<string, typeof dependencyWorkProductRows>();
  for (const product of dependencyWorkProductRows) {
    const products = dependencyWorkProductsByIssueId.get(product.issueId) ?? [];
    products.push(product);
    dependencyWorkProductsByIssueId.set(product.issueId, products);
  }
  const dependencyIssueLines = dependencyIssueRows.flatMap((row) => {
    const label = row.identifier ?? row.issueId;
    const products = dependencyWorkProductsByIssueId.get(row.issueId) ?? [];
    return [
      `- ${row.stepId}: ${label} (${row.status}) — ${row.title}`,
      products.length > 0
        ? `  workProducts: ${products.map((product) => {
          const artifactRef = product.url ?? product.externalId ?? (
            product.metadata ? JSON.stringify(product.metadata) : "no artifact ref"
          );
          return `${product.title} [${product.type}/${product.status}] ${artifactRef}`;
        }).join("; ")}`
        : "  workProducts: none registered",
    ];
  });

  const stepName = input.step.name.trim();
  const hasIssueGroupPrefix = /^\s*\[(?:plan|action|qa|oversight)\]/iu.test(stepName);
  const title = hasIssueGroupPrefix
    ? `${stepName} — ${input.definition.name}`
    : `${input.definition.name}: ${stepName}`;
  const description = [
    input.step.description?.trim() || null,
    "",
    "Workflow execution boundary:",
    `- workflowRunId: ${input.run.id}`,
    `- workflowDefinitionId: ${input.definition.id}`,
    `- missionId: ${input.run.missionId ?? "none"}`,
    `- stepId: ${input.step.id}`,
    `- dependencyStepIds: ${JSON.stringify(input.step.dependencies)}`,
    dependencyIssueLines.length > 0 ? "Dependency issue inputs:" : null,
    ...dependencyIssueLines,
    "- Treat issue ids from other missions or workflow runs as out of scope, even when their titles are similar.",
    "",
    "Official workProduct contract:",
    "- If this step creates or updates a file/report/HTML/PDF/dataset/deliverable, register it on this assigned issue with `POST /api/issues/{issueId}/work-products` before marking done.",
    "- For local file artifacts, include `provider: \"local\"`, an appropriate `type`, a title, and `metadata.path` with the absolute file path; set `isPrimary: true` for the main deliverable.",
    "- For QA/validator steps, validate dependency issue workProducts above; do not require a QA issue to have its own workProduct unless QA creates a separate deliverable.",
  ].filter((line) => line !== null).join("\n");

  const createdIssue = await issueSvc.create(input.run.companyId, {
    title,
    description,
    status: "todo",
    assigneeAgentId,
    missionId: input.run.missionId ?? null,
    originKind: "workflow_execution",
    originId: input.run.id,
    originRunId: input.run.id,
  });

  await applyIssueCreatedSideEffects({
    db: input.db,
    heartbeat,
    issue: createdIssue,
    actor: {
      actorType: "system",
      actorId: `workflow:${input.definition.id}`,
    },
    contextSource: "workflow.dispatch",
    waitForWakeCompletion: true,
  });

  return createdIssue.id;
}

async function wakeExistingWorkflowStepIssue(input: {
  db: Db;
  run: typeof workflowRuns.$inferSelect;
  definition: typeof workflowDefinitions.$inferSelect;
  step: WorkflowStep;
  issueId: string;
}) {
  const [issue] = await input.db
    .select({
      id: issues.id,
      assigneeAgentId: issues.assigneeAgentId,
      status: issues.status,
    })
    .from(issues)
    .where(eq(issues.id, input.issueId))
    .limit(1);
  if (!issue || issue.status !== "todo") return;

  await queueIssueAssignmentWakeup({
    heartbeat: heartbeatService(input.db),
    issue,
    reason: "workflow_step_runnable",
    mutation: "workflow_resume",
    contextSource: "workflow.resume",
    payload: {
      ...(input.run.missionId ? { missionId: input.run.missionId } : {}),
      workflowRunId: input.run.id,
      workflowDefinitionId: input.definition.id,
      stepId: input.step.id,
    },
    contextSnapshot: {
      issueId: issue.id,
      taskId: issue.id,
      ...(input.run.missionId ? { missionId: input.run.missionId } : {}),
      workflowRunId: input.run.id,
      workflowDefinitionId: input.definition.id,
      workflowStepId: input.step.id,
      stepId: input.step.id,
      source: "workflow.resume",
      wakeReason: "workflow_step_runnable",
    },
    requestedByActorType: "system",
    requestedByActorId: `workflow:${input.definition.id}`,
  });
}

async function resolveWorkflowStepAssigneeAgentId(
  db: Db,
  companyId: string,
  step: WorkflowStep,
): Promise<string | undefined> {
  if (typeof step.agentId === "string" && step.agentId.trim()) {
    return step.agentId.trim();
  }

  const rawAgentName = (step as PersistedWorkflowStep).agentName;
  const agentName = typeof rawAgentName === "string"
    ? rawAgentName.trim()
    : "";
  if (!agentName) return undefined;

  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(
      eq(agents.companyId, companyId),
      eq(agents.name, agentName),
      ne(agents.status, "terminated"),
      ne(agents.status, "pending_approval"),
    ))
    .orderBy(asc(agents.createdAt))
    .limit(1);
  return agent?.id;
}

function buildStepRunMap(
  stepRuns: (typeof workflowStepRuns.$inferSelect)[],
): Map<string, typeof workflowStepRuns.$inferSelect> {
  return new Map(stepRuns.map((stepRun) => [stepRun.stepId, stepRun]));
}

function findRunnableSteps(
  steps: WorkflowStep[],
  stepRunMap: Map<string, typeof workflowStepRuns.$inferSelect>,
  options: { launchedStepIds?: Set<string> } = {},
): WorkflowStep[] {
  return steps.filter((step) => {
    if (options.launchedStepIds && !options.launchedStepIds.has(step.id)) return false;
    if (step.triggerOn === "escalation") return false;
    const stepRun = stepRunMap.get(step.id);
    if (!stepRun || stepRun.status !== "pending") return false;
    return step.dependencies.every((dependencyId) => {
      const dependencyRun = stepRunMap.get(dependencyId);
      return dependencyRun ? WORKFLOW_STEP_SUCCESS_STATUSES.has(dependencyRun.status) : false;
    });
  });
}

function isIssueLessToolStep(step: WorkflowStep): boolean {
  const hasToolNames = Array.isArray(step.toolNames)
    && step.toolNames.some((toolName) => typeof toolName === "string" && toolName.trim().length > 0);
  const agentId = typeof step.agentId === "string" ? step.agentId.trim() : "";
  const persistedStep = step as PersistedWorkflowStep;
  const stepType = typeof persistedStep.type === "string" ? persistedStep.type.trim().toLowerCase() : "";
  const agentName = typeof persistedStep.agentName === "string" ? persistedStep.agentName.trim() : "";
  if (stepType === "agent" || agentName.length > 0) return false;
  return hasToolNames && agentId.length === 0;
}

function getSingleToolStepName(step: WorkflowStep): string {
  const toolNames = Array.isArray(step.toolNames)
    ? step.toolNames.map((toolName) => toolName.trim()).filter(Boolean)
    : [];
  if (toolNames.length !== 1) {
    throw new Error(`Workflow tool step "${step.id}" requires exactly one toolName; received ${toolNames.length}.`);
  }
  return toolNames[0]!;
}

async function failToolStepRun(
  db: Db,
  stepRun: typeof workflowStepRuns.$inferSelect,
  now: Date,
): Promise<void> {
  await db
    .update(workflowStepRuns)
    .set({
      status: "failed",
      startedAt: stepRun.startedAt ?? now,
      completedAt: now,
    })
    .where(eq(workflowStepRuns.id, stepRun.id));
}

async function startIssueLessToolStepRun(input: {
  db: Db;
  run: typeof workflowRuns.$inferSelect;
  definition: typeof workflowDefinitions.$inferSelect;
  step: WorkflowStep;
  stepRun: typeof workflowStepRuns.$inferSelect;
  now: Date;
}): Promise<boolean> {
  const { db, run, definition, step, stepRun, now } = input;

  const toolName = getSingleToolStepName(step);
  if (toolName === "delegate_to_company") {
    const { startDelegatedWorkflowStep } = await import("../workflow-delegations.js");
    const delegated = await startDelegatedWorkflowStep({
      db,
      run,
      definition,
      step,
      stepRun,
      args: (step as PersistedWorkflowStep).toolArgs ?? {},
      now,
    });
    if (!delegated) {
      await failToolStepRun(db, stepRun, now);
    }
    return delegated;
  }

  if (!workflowToolStepExecutor) {
    await failToolStepRun(db, stepRun, now);
    return false;
  }

  const requestId = `${run.id}:${step.id}:${Date.now()}`;

  await db
    .update(workflowStepRuns)
    .set({
      status: "running",
      startedAt: stepRun.startedAt ?? now,
      completedAt: null,
    })
    .where(eq(workflowStepRuns.id, stepRun.id));

  try {
    await workflowToolStepExecutor({
      companyId: run.companyId,
      workflowRunId: run.id,
      workflowId: definition.id,
      stepId: step.id,
      stepRunId: stepRun.id,
      toolName,
      args: (step as PersistedWorkflowStep).toolArgs ?? {},
      requestId,
    });
    return true;
  } catch {
    await failToolStepRun(db, stepRun, now);
    return false;
  }
}

export async function completeWorkflowToolStepFromResult(
  db: Db,
  input: {
    companyId: string;
    stepRunId: string;
    success: boolean;
  },
): Promise<WorkflowExecutionResult | null> {
  const row = await db
    .select({ stepRun: workflowStepRuns, run: workflowRuns })
    .from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id))
    .where(eq(workflowStepRuns.id, input.stepRunId))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!row || row.run.companyId !== input.companyId) return null;

  if (!WORKFLOW_STEP_TERMINAL_STATUSES.has(row.stepRun.status)) {
    const now = new Date();
    await db
      .update(workflowStepRuns)
      .set({
        status: input.success ? "completed" : "failed",
        startedAt: row.stepRun.startedAt ?? now,
        completedAt: now,
      })
      .where(eq(workflowStepRuns.id, row.stepRun.id));
  }

  return syncWorkflowRunState(db, row.run.id);
}

export async function retryIssueLessToolWorkflowStep(
  db: Db,
  input: {
    companyId: string;
    runId: string;
    stepId: string;
  },
): Promise<{ stepRunId: string; result: WorkflowExecutionResult } | null> {
  const context = await loadWorkflowExecutionContext(db, input.runId);
  if (context.run.companyId !== input.companyId) return null;

  const step = context.steps.find((candidate) => candidate.id === input.stepId);
  const stepRun = context.stepRuns.find((candidate) => candidate.stepId === input.stepId);
  if (!step || !stepRun) return null;
  if (!isIssueLessToolStep(step) || stepRun.issueId) return null;
  if (stepRun.status !== "failed") return null;

  await db
    .update(workflowStepRuns)
    .set({
      status: "pending",
      startedAt: null,
      completedAt: null,
    })
    .where(eq(workflowStepRuns.id, stepRun.id));

  const refreshedStepRuns = await db
    .select()
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, input.runId));
  await resetSkippedUnlaunchedStepRuns(db, refreshedStepRuns);

  await db
    .update(workflowRuns)
    .set({
      status: "running",
      startedAt: context.run.startedAt ?? new Date(),
      completedAt: null,
    })
    .where(and(eq(workflowRuns.id, input.runId), eq(workflowRuns.companyId, input.companyId)));

  return {
    stepRunId: stepRun.id,
    result: await syncWorkflowRunState(db, input.runId),
  };
}

async function finalizeWorkflowRunState(
  db: Db,
  context: WorkflowExecutionContext,
  stepRuns: (typeof workflowStepRuns.$inferSelect)[],
): Promise<typeof workflowRuns.$inferSelect> {
  const hasFailedStep = stepRuns.some((stepRun) => stepRun.status === "failed");
  const hasActiveStep = stepRuns.some((stepRun) => !WORKFLOW_STEP_TERMINAL_STATUSES.has(stepRun.status));
  const dynamicLaunchStepIds = getDynamicLaunchStepIds(context);
  const executableStepRuns = dynamicLaunchStepIds
    ? stepRuns.filter((stepRun) => dynamicLaunchStepIds.has(stepRun.stepId))
    : stepRuns;
  const executableHasActiveStep = executableStepRuns.some((stepRun) => !WORKFLOW_STEP_TERMINAL_STATUSES.has(stepRun.status));
  const allStepsTerminal = dynamicLaunchStepIds
    ? executableStepRuns.length === dynamicLaunchStepIds.size && !executableHasActiveStep
    : stepRuns.length === context.steps.length && !hasActiveStep;
  const nextStatus =
    context.run.status === "cancelled"
      ? "cancelled"
      : hasFailedStep && allStepsTerminal
        ? "failed"
        : !hasFailedStep && allStepsTerminal
          ? "completed"
          : "running";
  const patch: Partial<typeof workflowRuns.$inferInsert> = {
    status: nextStatus,
    startedAt: context.run.startedAt ?? new Date(),
    completedAt: nextStatus === "completed" || nextStatus === "failed" || nextStatus === "cancelled" ? new Date() : null,
  };

  const [updatedRun] = await db
    .update(workflowRuns)
    .set(patch)
    .where(eq(workflowRuns.id, context.run.id))
    .returning();

  const finalRun = updatedRun ?? { ...context.run, ...patch } as typeof workflowRuns.$inferSelect;
  const dynamicOwnerPlan = isDynamicOwnerPlanWorkflowDefinition(buildWorkflowDefinitionExecutionShape(context));
  const missionId = finalRun.missionId;
  const shouldStopMissionRuntimes = missionId !== null
    && TERMINAL_WORKFLOW_STATUSES.has(finalRun.status)
    && !(dynamicOwnerPlan && finalRun.status === "completed");
  if (shouldStopMissionRuntimes) {
    await stopMissionRuntimesForMission(db, {
      companyId: finalRun.companyId,
      missionId,
      reason: `workflow ${finalRun.id} ${finalRun.status}`,
    });
  }

  return finalRun;
}

async function cancelOutstandingWorkflowIssues(
  db: Db,
  runId: string,
): Promise<void> {
  const now = new Date();
  await db
    .update(issues)
    .set({
      status: "cancelled",
      cancelledAt: now,
      updatedAt: now,
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    })
    .where(and(
      eq(issues.originKind, "workflow_execution"),
      eq(issues.originRunId, runId),
      sql`${issues.status} not in ('done', 'cancelled')`,
    ));
}

async function syncCancelledWorkflowRunState(
  db: Db,
  runId: string,
): Promise<void> {
  await cancelOutstandingWorkflowIssues(db, runId);

  let stepRuns = await db
    .select()
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, runId));

  if (stepRuns.length === 0) {
    return;
  }

  stepRuns = await syncStepRunsFromIssueState(db, stepRuns);

  const now = new Date();
  for (const stepRun of stepRuns) {
    if (WORKFLOW_STEP_TERMINAL_STATUSES.has(stepRun.status)) continue;

    const patch: Partial<typeof workflowStepRuns.$inferInsert> = {
      completedAt: stepRun.completedAt ?? now,
    };

    if (stepRun.issueId) {
      patch.status = "failed";
      patch.startedAt = stepRun.startedAt ?? now;
    } else {
      patch.status = "skipped";
    }

    await db
      .update(workflowStepRuns)
      .set(patch)
      .where(eq(workflowStepRuns.id, stepRun.id));
  }
}

export async function cancelWorkflowRunWithCleanup(
  db: Db,
  runId: string,
): Promise<boolean> {
  const updatedRows = await db
    .update(workflowRuns)
    .set({
      status: "cancelled",
      completedAt: new Date(),
    })
    .where(eq(workflowRuns.id, runId))
    .returning({ id: workflowRuns.id, companyId: workflowRuns.companyId, missionId: workflowRuns.missionId });

  const updatedRun = updatedRows[0];
  if (!updatedRun) {
    return false;
  }

  await syncCancelledWorkflowRunState(db, runId);
  if (updatedRun.missionId) {
    await stopMissionRuntimesForMission(db, {
      companyId: updatedRun.companyId,
      missionId: updatedRun.missionId,
      reason: `workflow ${runId} cancelled`,
    });
  }
  return true;
}

async function commentOnMainExecutorOversightForFailures(
  db: Db,
  context: WorkflowExecutionContext,
  stepRuns: (typeof workflowStepRuns.$inferSelect)[],
): Promise<void> {
  const missionId = context.run.missionId;
  if (!missionId) return;

  const failedStepRuns = stepRuns.filter((stepRun) => stepRun.status === "failed");
  if (failedStepRuns.length === 0) return;

  const oversightIssue = await db
    .select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId })
    .from(issues)
    .where(and(
      eq(issues.missionId, missionId),
      eq(issues.originKind, "mission_main_executor_oversight"),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!oversightIssue) return;

  const existingComments = await db
    .select({ body: issueComments.body })
    .from(issueComments)
    .where(eq(issueComments.issueId, oversightIssue.id));
  const existingBodies = existingComments.map((comment) => comment.body).join("\n");

  for (const stepRun of failedStepRuns) {
    const marker = `workflow-failure:${context.run.id}:${stepRun.stepId}`;
    if (existingBodies.includes(marker)) continue;
    const step = context.steps.find((candidate) => candidate.id === stepRun.stepId);
    await db.insert(issueComments).values({
      authorAgentId: oversightIssue.assigneeAgentId,
      body: [
        "### Workflow step failed",
        `<!-- ${marker} -->`,
        `- Workflow: ${context.definition.name}`,
        `- Run: ${context.run.id}`,
        `- Step: ${stepRun.stepId}${step?.name ? ` (${step.name})` : ""}`,
        `- Observed at: ${new Date().toISOString()}`,
        "",
        "Main executor action:",
        "- Review the failed step output and decide whether a retry is safe.",
        "- Retry failed steps only within the retry limit; otherwise escalate with context.",
      ].join("\n"),
      companyId: context.run.companyId,
      issueId: oversightIssue.id,
    });
  }
}

export async function syncWorkflowRunState(
  db: Db,
  runId: string,
): Promise<WorkflowExecutionResult> {
  const context = await loadWorkflowExecutionContext(db, runId);
  let stepRuns = await ensureStepRunRecords(db, runId, context.steps);
  stepRuns = await syncStepRunsFromIssueState(db, stepRuns);

  const hasFailure = stepRuns.some((stepRun) => stepRun.status === "failed");
  const dynamicLaunchStepIds = getDynamicLaunchStepIds(context);
  if (!hasFailure && !dynamicLaunchStepIds && context.run.status !== "cancelled") {
    stepRuns = await resetSkippedUnlaunchedStepRuns(db, stepRuns);
  }
  if (hasFailure) {
    const unlaunchedPendingSteps = stepRuns.filter((stepRun) => stepRun.status === "pending" && stepRun.issueId == null);
    if (unlaunchedPendingSteps.length > 0) {
      const now = new Date();
      for (const stepRun of unlaunchedPendingSteps) {
        await db
          .update(workflowStepRuns)
          .set({ status: "skipped", completedAt: now })
          .where(eq(workflowStepRuns.id, stepRun.id));
      }
      stepRuns = await db
        .select()
        .from(workflowStepRuns)
        .where(eq(workflowStepRuns.workflowRunId, runId));
    }
    await commentOnMainExecutorOversightForFailures(db, context, stepRuns);
  } else {
    let shouldContinue = true;
    while (shouldContinue) {
      shouldContinue = false;
      const stepRunMap = buildStepRunMap(stepRuns);
      const runnableSteps = findRunnableSteps(context.steps, stepRunMap, {
        launchedStepIds: dynamicLaunchStepIds,
      });
      if (runnableSteps.length === 0) break;

      let failedIssueLessToolStep = false;
      for (const step of runnableSteps) {
        const stepRun = stepRunMap.get(step.id);
        if (!stepRun) continue;

        if (isIssueLessToolStep(step)) {
          const started = await startIssueLessToolStepRun({
            db,
            run: context.run,
            definition: context.definition,
            step,
            stepRun,
            now: new Date(),
          });
          failedIssueLessToolStep = failedIssueLessToolStep || !started;
          continue;
        }

        if (stepRun.issueId) {
          await wakeExistingWorkflowStepIssue({
            db,
            run: context.run,
            definition: context.definition,
            step,
            issueId: stepRun.issueId,
          });
          continue;
        }

        const issueId = await createWorkflowStepIssue({
          db,
          run: context.run,
          definition: context.definition,
          step,
        });
        await db
          .update(workflowStepRuns)
          .set({ issueId })
          .where(eq(workflowStepRuns.id, stepRun.id));
      }

      stepRuns = await db
        .select()
        .from(workflowStepRuns)
        .where(eq(workflowStepRuns.workflowRunId, runId));

      shouldContinue = failedIssueLessToolStep;
    }
  }

  const hasFailureAfterLaunch = stepRuns.some((stepRun) => stepRun.status === "failed");
  if (!hasFailure && hasFailureAfterLaunch) {
    const unlaunchedPendingSteps = stepRuns.filter((stepRun) => stepRun.status === "pending" && stepRun.issueId == null);
    if (unlaunchedPendingSteps.length > 0) {
      const now = new Date();
      for (const stepRun of unlaunchedPendingSteps) {
        await db
          .update(workflowStepRuns)
          .set({ status: "skipped", completedAt: now })
          .where(eq(workflowStepRuns.id, stepRun.id));
      }
      stepRuns = await db
        .select()
        .from(workflowStepRuns)
        .where(eq(workflowStepRuns.workflowRunId, runId));
    }
    await commentOnMainExecutorOversightForFailures(db, context, stepRuns);
  }

  if (dynamicLaunchStepIds && !hasFailure) {
    const launchedStepRuns = stepRuns.filter((stepRun) => dynamicLaunchStepIds.has(stepRun.stepId));
    const launchedStepsTerminal = launchedStepRuns.length === dynamicLaunchStepIds.size
      && launchedStepRuns.every((stepRun) => WORKFLOW_STEP_TERMINAL_STATUSES.has(stepRun.status));
    const unlaunchedPendingSteps = stepRuns.filter((stepRun) =>
      !dynamicLaunchStepIds.has(stepRun.stepId) && stepRun.status === "pending" && stepRun.issueId == null
    );
    if (launchedStepsTerminal && unlaunchedPendingSteps.length > 0) {
      const now = new Date();
      for (const stepRun of unlaunchedPendingSteps) {
        await db
          .update(workflowStepRuns)
          .set({ status: "skipped", completedAt: now })
          .where(eq(workflowStepRuns.id, stepRun.id));
      }
      stepRuns = await db
        .select()
        .from(workflowStepRuns)
        .where(eq(workflowStepRuns.workflowRunId, runId));
    }
  }

  const updatedRun = await finalizeWorkflowRunState(db, context, stepRuns);

  return {
    runId,
    workflowId: updatedRun.workflowId,
    missionId: updatedRun.missionId,
    status: updatedRun.status as "running" | "completed" | "failed" | "cancelled",
    completedAt: updatedRun.completedAt,
    error: updatedRun.status === "failed" ? "One or more workflow steps failed" : undefined,
    stepRuns: stepRuns.map((stepRun) => ({
      id: stepRun.id,
      workflowRunId: stepRun.workflowRunId,
      stepId: stepRun.stepId,
      issueId: stepRun.issueId,
      status: stepRun.status as "pending" | "running" | "completed" | "failed" | "skipped",
      startedAt: stepRun.startedAt,
      completedAt: stepRun.completedAt,
    })),
  };
}

export async function syncWorkflowRunForIssue(
  db: Db,
  issueId: string,
): Promise<WorkflowExecutionResult | null> {
  const issue = await db
    .select({
      originKind: issues.originKind,
      originRunId: issues.originRunId,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (issue?.originKind === "workflow_execution" && issue.originRunId) {
    return syncWorkflowRunState(db, issue.originRunId);
  }

  const linkedStepRun = await db
    .select({ workflowRunId: workflowStepRuns.workflowRunId })
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.issueId, issueId))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!linkedStepRun?.workflowRunId) {
    return null;
  }

  return syncWorkflowRunState(db, linkedStepRun.workflowRunId);
}

/**
 * Executes a workflow run.
 *
 * @param db - Database instance.
 * @param runId - The workflow run ID to execute.
 * @param tx - Optional transaction for atomic execution.
 * @returns Execution result.
 */
export async function executeWorkflowRun(
  db: Db,
  runId: string,
): Promise<WorkflowExecutionResult> {
  await db
    .update(workflowRuns)
    .set({
      status: "running",
      startedAt: new Date(),
      completedAt: null,
    })
    .where(eq(workflowRuns.id, runId));
  return syncWorkflowRunState(db, runId);
}

/**
 * Reconciles workflow state - checks for stuck runs and recovers them.
 *
 * @param db - Database instance.
 * @param timeoutMinutes - Consider runs stuck if older than this.
 */
export async function reconcileWorkflowRuns(
  db: Db,
  timeoutMinutes: number = 60,
): Promise<{ recovered: number; failed: number }> {
  const timeout = new Date(Date.now() - timeoutMinutes * 60 * 1000);

  const stuckRuns = await db
    .select()
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.status, "running"),
        lt(workflowRuns.startedAt, timeout),
      ),
    );

  let recovered = 0;
  let failed = 0;

  for (const run of stuckRuns) {
    try {
      await db
        .update(workflowRuns)
        .set({
          status: "failed",
          completedAt: new Date(),
        })
        .where(eq(workflowRuns.id, run.id));
      failed++;
    } catch (error) {
      recovered++;
    }
  }

  return { recovered, failed };
}
