/**
 * DAG Engine
 *
 * Validates and executes Directed Acyclic Graph (DAG) workflows.
 * A workflow is a DAG where each step has dependencies on other steps.
 */

import { and, asc, desc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, issues, issueComments, issueWorkProducts, workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import type { DagValidationResult, WorkflowExecutionResult } from "./types.js";
import { issueService } from "../issues.js";
import { heartbeatService } from "../heartbeat.js";
import { applyIssueCreatedSideEffects } from "../issue-create-side-effects.js";
import { queueIssueAssignmentWakeup } from "../issue-assignment-wakeup.js";
import { stopMissionRuntimesForMission, TERMINAL_WORKFLOW_STATUSES } from "../missions/mission-runtime-manager.js";
import { logActivity } from "../activity-log.js";

/**
 * Workflow step definition.
 */
export interface WorkflowStep {
  id: string;
  name: string;
  title?: string;
  agentId: string;
  agentName?: string;
  assigneeAgentId?: string;
  dependencies: string[]; // step IDs this step depends on
  dependsOn?: string[];
  description?: string;
  type?: string;
  toolName?: string;
  toolArgs?: unknown;
  tools?: string[];
  toolNames?: string[];
  sessionMode?: string;
  onFailure?: string;
  escalateTo?: string;
  maxRetries?: number;
  timeoutSeconds?: number;
  knowledgeBaseIds?: string[];
  triggerOn?: "normal" | "escalation" | string;
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
  executionControls?: WorkflowStepExecutionControls;
}

export type WorkflowExecutionMode = "static_dag" | "dynamic_owner_plan";

export interface WorkflowStepExecutionControls {
  concurrencyKey?: string;
  concurrencyLimit?: number;
  priority?: string;
  cacheEnabled?: boolean;
  cacheTtlSeconds?: number;
  deleteAfterUse?: boolean;
}

type PersistedWorkflowStep = WorkflowStep & {
  title?: unknown;
  dependsOn?: unknown;
  tools?: unknown;
  toolName?: unknown;
  toolArgs?: unknown;
  type?: unknown;
  agentName?: unknown;
  executionControls?: unknown;
  graphConcurrencyKey?: unknown;
  graphConcurrencyLimit?: unknown;
  graphPriority?: unknown;
  graphCacheEnabled?: unknown;
  graphCacheTtlSeconds?: unknown;
  graphDeleteAfterUse?: unknown;
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

export type WorkflowToolStepReadiness = {
  available: boolean;
  reason?: string;
};

export type WorkflowToolStepReadinessChecker = (input: {
  companyId: string;
  toolNames: string[];
}) => Promise<WorkflowToolStepReadiness>;

let workflowToolStepExecutor: WorkflowToolStepExecutor | null = null;
let workflowToolStepReadinessChecker: WorkflowToolStepReadinessChecker | null = null;

export function setWorkflowToolStepExecutor(executor: WorkflowToolStepExecutor | null): void {
  workflowToolStepExecutor = executor;
}

export function setWorkflowToolStepReadinessChecker(checker: WorkflowToolStepReadinessChecker | null): void {
  workflowToolStepReadinessChecker = checker;
}

export function getWorkflowToolReferenceNames(steps: WorkflowStep[]): string[] {
  return Array.from(new Set(
    steps.flatMap((step) => Array.isArray(step.toolNames)
      ? step.toolNames.map((toolName) => toolName.trim()).filter(Boolean)
      : []),
  ))
    .filter((toolName) => toolName !== "delegate_to_company")
    .sort((a, b) => a.localeCompare(b));
}

export async function assertWorkflowToolStepsReady(input: {
  companyId: string;
  steps: WorkflowStep[];
}): Promise<void> {
  const toolNames = getWorkflowToolReferenceNames(input.steps);
  if (toolNames.length === 0) return;

  const readiness = workflowToolStepReadinessChecker
    ? await workflowToolStepReadinessChecker({ companyId: input.companyId, toolNames })
    : { available: true };
  if (!readiness.available) {
    throw new Error(`Workflow tools are unavailable: ${readiness.reason ?? "tool execution is not available."}`);
  }

  if (!workflowToolStepExecutor) {
    throw new Error("Workflow tools are unavailable: Workflow tool step executor is not configured.");
  }
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

function normalizeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeBooleanMarker(value: unknown): boolean | undefined {
  if (value === true) return true;
  if (value === false) return false;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") return true;
    if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off" || normalized === "") return false;
  }
  return undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  const numberValue = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value.trim())
      : NaN;
  if (!Number.isFinite(numberValue)) return undefined;
  const integer = Math.trunc(numberValue);
  return integer > 0 ? integer : undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeWorkflowStepExecutionControls(step: PersistedWorkflowStep): WorkflowStepExecutionControls | undefined {
  const rawControls = normalizeRecord(step.executionControls);
  const concurrencyKey = normalizeOptionalString(rawControls.concurrencyKey) ?? normalizeOptionalString(step.graphConcurrencyKey);
  const concurrencyLimit = normalizePositiveInteger(rawControls.concurrencyLimit) ?? normalizePositiveInteger(step.graphConcurrencyLimit);
  const priority = (normalizeOptionalString(rawControls.priority) ?? normalizeOptionalString(step.graphPriority))?.toLowerCase();
  const explicitCacheEnabled = normalizeBooleanMarker(rawControls.cacheEnabled) ?? normalizeBooleanMarker(step.graphCacheEnabled);
  const cacheTtlSeconds = normalizePositiveInteger(rawControls.cacheTtlSeconds) ?? normalizePositiveInteger(step.graphCacheTtlSeconds);
  const deleteAfterUse = normalizeBooleanMarker(rawControls.deleteAfterUse) ?? normalizeBooleanMarker(step.graphDeleteAfterUse);
  const controls: WorkflowStepExecutionControls = {};

  if (concurrencyKey) controls.concurrencyKey = concurrencyKey;
  if (concurrencyLimit) controls.concurrencyLimit = concurrencyLimit;
  if (priority) controls.priority = priority;
  if (explicitCacheEnabled === true || cacheTtlSeconds) {
    controls.cacheEnabled = true;
  }
  if (controls.cacheEnabled && cacheTtlSeconds) {
    controls.cacheTtlSeconds = cacheTtlSeconds;
  }
  if (deleteAfterUse === true) controls.deleteAfterUse = true;

  return Object.keys(controls).length > 0 ? controls : undefined;
}

export function normalizeWorkflowStepsForExecution(rawSteps: unknown): WorkflowStep[] {
  if (!Array.isArray(rawSteps)) return [];
  return rawSteps.map((rawStep) => {
    const step = (rawStep && typeof rawStep === "object" ? rawStep : {}) as PersistedWorkflowStep;
    const dependencies = normalizeStringArray(step.dependencies) ?? normalizeStringArray(step.dependsOn) ?? [];
    const toolNames = normalizeStringArray(step.toolNames)
      ?? normalizeStringArray(step.tools)
      ?? normalizeStringArray(step.toolName);
    const executionControls = normalizeWorkflowStepExecutionControls(step);
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
      ...(executionControls ? { executionControls } : {}),
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
        metadata: buildWorkflowStepRunMetadata(step),
      })),
    );
  }

  const stepRuns = missingSteps.length === 0
    ? existing
    : await db
    .select()
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, runId));
  return syncStepRunExecutionControlMetadata(db, stepRuns, steps);
}

function buildWorkflowStepRunMetadata(
  step: WorkflowStep,
  existingMetadata: unknown = {},
): Record<string, unknown> {
  const metadata = { ...normalizeRecord(existingMetadata) };
  if (step.executionControls && Object.keys(step.executionControls).length > 0) {
    metadata.executionControls = step.executionControls;
  } else {
    delete metadata.executionControls;
  }
  return metadata;
}

function metadataJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

async function syncStepRunExecutionControlMetadata(
  db: Db,
  stepRuns: (typeof workflowStepRuns.$inferSelect)[],
  steps: WorkflowStep[],
): Promise<(typeof workflowStepRuns.$inferSelect)[]> {
  if (stepRuns.length === 0) return stepRuns;

  const stepById = new Map(steps.map((step) => [step.id, step]));
  let changed = false;
  for (const stepRun of stepRuns) {
    const step = stepById.get(stepRun.stepId);
    if (!step) continue;
    const nextMetadata = buildWorkflowStepRunMetadata(step, stepRun.metadata);
    if (metadataJson(stepRun.metadata) === metadataJson(nextMetadata)) continue;
    changed = true;
    await db
      .update(workflowStepRuns)
      .set({ metadata: nextMetadata })
      .where(eq(workflowStepRuns.id, stepRun.id));
  }

  if (!changed) return stepRuns;
  return db
    .select()
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, stepRuns[0]!.workflowRunId));
}

function desiredStepRunStatusFromIssueStatus(issueStatus: string): "pending" | "running" | "completed" | "failed" {
  if (issueStatus === "done") return "completed";
  if (issueStatus === "blocked" || issueStatus === "cancelled") return "failed";
  if (issueStatus === "in_progress" || issueStatus === "in_review") return "running";
  return "pending";
}

function isValidationGateCandidate(input: {
  issueTitle?: string | null;
  issueOriginKind?: string | null;
  step?: WorkflowStep | null;
}): boolean {
  if (
    input.issueOriginKind === "mission_main_executor_plan" ||
    input.issueOriginKind === "mission_main_executor_oversight" ||
    input.issueOriginKind === "mission_main_executor_unblock"
  ) {
    return false;
  }

  const text = [
    input.issueTitle,
    input.step?.id,
    input.step?.name,
    input.step?.title,
    input.step?.type,
    input.step?.description,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");

  return (
    /^\s*\[QA\]/iu.test(text) ||
    /\b(QA|validator|validation|validate)\b/iu.test(text) ||
    text.includes("검증")
  );
}

function readExplicitValidationVerdict(value: string): "pass" | "request_changes" | null {
  const compact = value
    .replace(/[`*_#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return null;
  if (/^PASS\s+or\s+REQUEST[_\s-]?CHANGES\b/iu.test(compact)) return null;

  const explicitPatterns = [
    /^(REQUEST[_\s-]?CHANGES|PASS)(?:\b|[\s:：—–-])/iu,
    /\b(?:verdict|decision|outcome|status|QA\s+verdict)\s*[:：=-]\s*(REQUEST[_\s-]?CHANGES|PASS)\b/iu,
    /\bvalidation\s+complete\s*[:：=-]\s*(REQUEST[_\s-]?CHANGES|PASS)\b/iu,
    /\bmission\s+validation\s+gate\s*[:：=-]\s*(REQUEST[_\s-]?CHANGES)\b/iu,
  ];
  for (const pattern of explicitPatterns) {
    const match = pattern.exec(compact);
    const label = match?.[1];
    if (!label) continue;
    return /^PASS$/iu.test(label) ? "pass" : "request_changes";
  }
  return null;
}

function latestExplicitValidationVerdict(comments: string[]): "pass" | "request_changes" | null {
  for (const comment of comments) {
    const verdict = readExplicitValidationVerdict(comment);
    if (verdict) return verdict;
  }
  return null;
}

function readValidationVerdictFromHeartbeatResult(resultJson: unknown): "pass" | "request_changes" | null {
  const result = normalizeRecord(resultJson);
  const candidates = [
    result.verdict,
    result.decision,
    result.outcome,
    result.status,
    result.result,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const verdict = readExplicitValidationVerdict(candidate);
    if (verdict) return verdict;
  }
  return null;
}

async function syncStepRunsFromIssueState(
  db: Db,
  stepRuns: (typeof workflowStepRuns.$inferSelect)[],
  steps: WorkflowStep[] = [],
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
      title: issues.title,
      originKind: issues.originKind,
    })
    .from(issues)
    .where(inArray(issues.id, issueIds));
  const issueById = new Map(issueRows.map((issue) => [issue.id, issue]));
  const stepById = new Map(steps.map((step) => [step.id, step]));
  const validationCandidateIssueIds = stepRuns
    .filter((stepRun) => {
      if (!stepRun.issueId) return false;
      const issue = issueById.get(stepRun.issueId);
      if (!issue || issue.status !== "done") return false;
      return isValidationGateCandidate({
        issueTitle: issue.title,
        issueOriginKind: issue.originKind,
        step: stepById.get(stepRun.stepId) ?? null,
      });
    })
    .map((stepRun) => stepRun.issueId!)
    .filter((issueId, index, all) => all.indexOf(issueId) === index);
  const commentsByIssueId = new Map<string, string[]>();
  const heartbeatVerdictByIssueId = new Map<string, "pass" | "request_changes">();
  if (validationCandidateIssueIds.length > 0) {
    const runRows = await db
      .select({
        issueId: heartbeatRuns.issueId,
        resultJson: heartbeatRuns.resultJson,
      })
      .from(heartbeatRuns)
      .where(and(
        inArray(heartbeatRuns.issueId, validationCandidateIssueIds),
        eq(heartbeatRuns.status, "succeeded"),
      ))
      .orderBy(desc(heartbeatRuns.finishedAt), desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id));
    for (const run of runRows) {
      if (!run.issueId || heartbeatVerdictByIssueId.has(run.issueId)) continue;
      const verdict = readValidationVerdictFromHeartbeatResult(run.resultJson);
      if (verdict) heartbeatVerdictByIssueId.set(run.issueId, verdict);
    }

    const commentRows = await db
      .select({
        issueId: issueComments.issueId,
        body: issueComments.body,
      })
      .from(issueComments)
      .where(inArray(issueComments.issueId, validationCandidateIssueIds))
      .orderBy(desc(issueComments.createdAt), desc(issueComments.id));
    for (const comment of commentRows) {
      const comments = commentsByIssueId.get(comment.issueId) ?? [];
      comments.push(comment.body);
      commentsByIssueId.set(comment.issueId, comments);
    }
  }

  for (const stepRun of stepRuns) {
    if (!stepRun.issueId) continue;
    const issue = issueById.get(stepRun.issueId);
    if (!issue) continue;

    const validationVerdict = issue.status === "done"
      ? latestExplicitValidationVerdict(commentsByIssueId.get(issue.id) ?? []) ?? heartbeatVerdictByIssueId.get(issue.id)
      : null;
    const desiredStatus = validationVerdict === "request_changes"
      ? "failed"
      : desiredStepRunStatusFromIssueStatus(issue.status);
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

  const stepName = renderWorkflowRunTextTemplate(input.step.name.trim(), input.run);
  const title = stepName || renderWorkflowRunTextTemplate(input.definition.name, input.run);
  const description = [
    input.step.description?.trim()
      ? renderWorkflowRunTextTemplate(input.step.description.trim(), input.run)
      : null,
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
      companyId: issues.companyId,
      assigneeAgentId: issues.assigneeAgentId,
      status: issues.status,
    })
    .from(issues)
    .where(eq(issues.id, input.issueId))
    .limit(1);
  if (!issue || issue.status !== "todo") return;

  let wakeIssue = issue;
  if (!wakeIssue.assigneeAgentId) {
    const assigneeAgentId = await resolveWorkflowStepAssigneeAgentId(input.db, input.run.companyId, input.step);
    if (!assigneeAgentId) return;

    const [updatedIssue] = await input.db
      .update(issues)
      .set({
        assigneeAgentId,
        updatedAt: new Date(),
      })
      .where(eq(issues.id, wakeIssue.id))
      .returning({
        id: issues.id,
        companyId: issues.companyId,
        assigneeAgentId: issues.assigneeAgentId,
        status: issues.status,
      });
    if (!updatedIssue) return;

    await logActivity(input.db, {
      companyId: updatedIssue.companyId,
      actorType: "system",
      actorId: `workflow:${input.definition.id}`,
      action: "issue.assignee_restored",
      entityType: "issue",
      entityId: updatedIssue.id,
      details: {
        assigneeAgentId,
        reason: "workflow_step_runnable",
        workflowRunId: input.run.id,
        workflowDefinitionId: input.definition.id,
        stepId: input.step.id,
      },
    });

    wakeIssue = updatedIssue;
  }

  await queueIssueAssignmentWakeup({
    heartbeat: heartbeatService(input.db),
    issue: wakeIssue,
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

function buildWorkflowToolStepArgs(
  step: PersistedWorkflowStep,
  run: typeof workflowRuns.$inferSelect,
): unknown {
  const args = step.toolArgs ?? {};
  return renderWorkflowToolStepArgTemplates(args, run);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function getMetadataRecord(value: unknown, key: string): Record<string, unknown> {
  const metadata = normalizeRecord(value);
  return normalizeRecord(metadata[key]);
}

function isCacheEnabled(step: WorkflowStep): boolean {
  return step.executionControls?.cacheEnabled === true;
}

function workflowPriorityRank(priority: string | undefined): number {
  switch (priority) {
    case "critical":
      return 4;
    case "high":
      return 3;
    case "normal":
      return 2;
    case "low":
      return 1;
    default:
      return 0;
  }
}

function sortWorkflowStepsByPriority(steps: WorkflowStep[]): WorkflowStep[] {
  return [...steps].sort((left, right) =>
    workflowPriorityRank(right.executionControls?.priority) - workflowPriorityRank(left.executionControls?.priority)
  );
}

function getCacheTtlSeconds(step: WorkflowStep): number | undefined {
  return typeof step.executionControls?.cacheTtlSeconds === "number" && step.executionControls.cacheTtlSeconds > 0
    ? step.executionControls.cacheTtlSeconds
    : undefined;
}

async function findCachedToolStepRun(input: {
  db: Db;
  run: typeof workflowRuns.$inferSelect;
  definition: typeof workflowDefinitions.$inferSelect;
  step: WorkflowStep;
  toolName: string;
  args: unknown;
  now: Date;
}): Promise<typeof workflowStepRuns.$inferSelect | null> {
  if (!isCacheEnabled(input.step)) return null;

  const ttlSeconds = getCacheTtlSeconds(input.step);
  const cutoff = ttlSeconds ? new Date(input.now.getTime() - ttlSeconds * 1000) : null;
  const conditions = [
    eq(workflowRuns.companyId, input.run.companyId),
    eq(workflowRuns.workflowId, input.definition.id),
    ne(workflowRuns.id, input.run.id),
    eq(workflowStepRuns.stepId, input.step.id),
    eq(workflowStepRuns.status, "completed"),
    ...(cutoff ? [gte(workflowStepRuns.completedAt, cutoff)] : []),
  ];
  const rows = await input.db
    .select({ stepRun: workflowStepRuns })
    .from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id))
    .where(and(...conditions))
    .orderBy(desc(workflowStepRuns.completedAt))
    .limit(25);
  const argsKey = stableJson(input.args);

  for (const row of rows) {
    const invocation = getMetadataRecord(row.stepRun.metadata, "toolInvocation");
    const result = getMetadataRecord(row.stepRun.metadata, "toolResult");
    if (result.success !== true) continue;
    if (invocation.toolName !== input.toolName) continue;
    if (stableJson(invocation.args ?? {}) !== argsKey) continue;
    return row.stepRun;
  }

  return null;
}

async function getRunningConcurrencyCount(input: {
  db: Db;
  run: typeof workflowRuns.$inferSelect;
  stepRun: typeof workflowStepRuns.$inferSelect;
  concurrencyKey: string;
}): Promise<number> {
  const rows = await input.db
    .select({ stepRun: workflowStepRuns })
    .from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id))
    .where(and(
      eq(workflowRuns.companyId, input.run.companyId),
      eq(workflowStepRuns.status, "running"),
      ne(workflowStepRuns.id, input.stepRun.id),
    ));
  return rows.filter((row) => {
    const controls = getMetadataRecord(row.stepRun.metadata, "executionControls");
    return controls.concurrencyKey === input.concurrencyKey;
  }).length;
}

async function blockToolStepRunForConcurrency(input: {
  db: Db;
  step: WorkflowStep;
  stepRun: typeof workflowStepRuns.$inferSelect;
  concurrencyKey: string;
  concurrencyLimit: number;
  runningCount: number;
  now: Date;
}): Promise<void> {
  await input.db
    .update(workflowStepRuns)
    .set({
      status: "pending",
      metadata: {
        ...buildWorkflowStepRunMetadata(input.step, input.stepRun.metadata),
        concurrencyBlocked: {
          concurrencyKey: input.concurrencyKey,
          concurrencyLimit: input.concurrencyLimit,
          runningCount: input.runningCount,
          checkedAt: input.now.toISOString(),
        },
      },
    })
    .where(eq(workflowStepRuns.id, input.stepRun.id));
}

async function completeToolStepRunFromCache(input: {
  db: Db;
  stepRun: typeof workflowStepRuns.$inferSelect;
  sourceStepRun: typeof workflowStepRuns.$inferSelect;
  step: WorkflowStep;
  toolName: string;
  args: unknown;
  now: Date;
}): Promise<void> {
  const sourceMetadata = normalizeRecord(input.sourceStepRun.metadata);
  const sourceToolResult = normalizeRecord(sourceMetadata.toolResult);
  const metadata: Record<string, unknown> = {
    ...buildWorkflowStepRunMetadata(input.step, input.stepRun.metadata),
    toolInvocation: {
      toolName: input.toolName,
      args: input.args,
      cacheCheckedAt: input.now.toISOString(),
    },
    toolResult: sourceToolResult,
    cacheHit: {
      sourceStepRunId: input.sourceStepRun.id,
      toolName: input.toolName,
      completedAt: input.now.toISOString(),
    },
  };
  delete metadata.concurrencyBlocked;

  await input.db
    .update(workflowStepRuns)
    .set({
      status: "completed",
      startedAt: input.stepRun.startedAt ?? input.now,
      completedAt: input.now,
      metadata,
    })
    .where(eq(workflowStepRuns.id, input.stepRun.id));
}

function renderWorkflowRunTextTemplate(
  value: string,
  run: typeof workflowRuns.$inferSelect,
): string {
  const runDate = run.runDate ?? "";
  return value.replaceAll("{$runDate}", runDate).replaceAll("{$date}", runDate);
}

function renderWorkflowToolStepArgTemplates(
  value: unknown,
  run: typeof workflowRuns.$inferSelect,
): unknown {
  if (typeof value === "string") {
    return renderWorkflowRunTextTemplate(value, run);
  }
  if (Array.isArray(value)) {
    return value.map((item) => renderWorkflowToolStepArgTemplates(item, run));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, renderWorkflowToolStepArgTemplates(entry, run)]),
    );
  }
  return value;
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

async function failToolStepRunWithDispatchError(input: {
  db: Db;
  step: WorkflowStep;
  stepRun: typeof workflowStepRuns.$inferSelect;
  now: Date;
  requestId: string;
  toolName: string;
  args: unknown;
  error: string;
}): Promise<void> {
  const metadata: Record<string, unknown> = {
    ...buildWorkflowStepRunMetadata(input.step, input.stepRun.metadata),
    toolInvocation: {
      requestId: input.requestId,
      toolName: input.toolName,
      args: input.args,
      dispatchedAt: input.now.toISOString(),
      dispatchError: input.error,
    },
  };
  delete metadata.concurrencyBlocked;

  await input.db
    .update(workflowStepRuns)
    .set({
      status: "failed",
      startedAt: input.stepRun.startedAt ?? input.now,
      completedAt: input.now,
      lastDispatchAttemptAt: input.now,
      lastDispatchErrorAt: input.now,
      lastDispatchErrorSummary: input.error,
      lastDispatchRequestId: input.requestId,
      metadata,
    })
    .where(eq(workflowStepRuns.id, input.stepRun.id));
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
      args: buildWorkflowToolStepArgs(step as PersistedWorkflowStep, run),
      now,
    });
    if (!delegated) {
      await failToolStepRun(db, stepRun, now);
    }
    return delegated;
  }

  const requestId = `${run.id}:${step.id}:${Date.now()}`;
  const args = buildWorkflowToolStepArgs(step as PersistedWorkflowStep, run);
  const concurrencyKey = step.executionControls?.concurrencyKey;
  const concurrencyLimit = step.executionControls?.concurrencyLimit;
  if (concurrencyKey && typeof concurrencyLimit === "number" && concurrencyLimit > 0) {
    const runningCount = await getRunningConcurrencyCount({
      db,
      run,
      stepRun,
      concurrencyKey,
    });
    if (runningCount >= concurrencyLimit) {
      await blockToolStepRunForConcurrency({
        db,
        step,
        stepRun,
        concurrencyKey,
        concurrencyLimit,
        runningCount,
        now,
      });
      return true;
    }
  }
  const cachedStepRun = await findCachedToolStepRun({
    db,
    run,
    definition,
    step,
    toolName,
    args,
    now,
  });
  if (cachedStepRun) {
    await completeToolStepRunFromCache({
      db,
      stepRun,
      sourceStepRun: cachedStepRun,
      step,
      toolName,
      args,
      now,
    });
    return true;
  }

  if (!workflowToolStepExecutor) {
    await failToolStepRunWithDispatchError({
      db,
      step,
      stepRun,
      now,
      requestId,
      toolName,
      args,
      error: "Workflow tool step executor is not configured.",
    });
    return false;
  }

  const metadata: Record<string, unknown> = {
    ...buildWorkflowStepRunMetadata(step, stepRun.metadata),
    toolInvocation: {
      requestId,
      toolName,
      args,
      dispatchedAt: now.toISOString(),
    },
  };
  delete metadata.concurrencyBlocked;

  await db
    .update(workflowStepRuns)
    .set({
      status: "running",
      startedAt: stepRun.startedAt ?? now,
      completedAt: null,
      lastDispatchAttemptAt: now,
      lastDispatchRequestId: requestId,
      metadata,
    })
    .where(eq(workflowStepRuns.id, stepRun.id));

  try {
    const dispatchResult = await workflowToolStepExecutor({
      companyId: run.companyId,
      workflowRunId: run.id,
      workflowId: definition.id,
      stepId: step.id,
      stepRunId: stepRun.id,
      toolName,
      args,
      requestId,
    });
    if (dispatchResult?.accepted !== false) {
      await db
        .update(workflowStepRuns)
        .set({ lastDispatchAcceptedAt: new Date() })
        .where(eq(workflowStepRuns.id, stepRun.id));
    }
    return true;
  } catch (error) {
    await failToolStepRunWithDispatchError({
      db,
      step,
      stepRun,
      now,
      requestId,
      toolName,
      args,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function mapWorkflowExecutionResult(
  run: typeof workflowRuns.$inferSelect,
  stepRuns: (typeof workflowStepRuns.$inferSelect)[],
): WorkflowExecutionResult {
  return {
    runId: run.id,
    workflowId: run.workflowId,
    missionId: run.missionId,
    status: run.status as "running" | "completed" | "failed" | "cancelled",
    completedAt: run.completedAt,
    error: run.status === "failed" ? "One or more workflow steps failed" : undefined,
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

async function getWorkflowExecutionResultSnapshot(
  db: Db,
  runId: string,
): Promise<WorkflowExecutionResult | null> {
  const run = await db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.id, runId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!run) return null;

  const stepRuns = await db
    .select()
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, runId));

  return mapWorkflowExecutionResult(run, stepRuns);
}

export async function completeWorkflowToolStepFromResult(
  db: Db,
  input: {
    companyId: string;
    stepRunId: string;
    success: boolean;
    requestId?: string;
    workflowRunId?: string;
    stepId?: string;
    toolName?: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number | null;
    error?: string;
  },
): Promise<WorkflowExecutionResult | null> {
  const row = await db
    .select({ stepRun: workflowStepRuns, run: workflowRuns, definition: workflowDefinitions })
    .from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id))
    .innerJoin(workflowDefinitions, eq(workflowRuns.workflowId, workflowDefinitions.id))
    .where(eq(workflowStepRuns.id, input.stepRunId))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!row || row.run.companyId !== input.companyId) return null;
  if (input.workflowRunId && input.workflowRunId !== row.run.id) return null;
  if (input.stepId && input.stepId !== row.stepRun.stepId) return null;
  if (input.requestId && row.stepRun.lastDispatchRequestId && input.requestId !== row.stepRun.lastDispatchRequestId) {
    return null;
  }

  if (WORKFLOW_STEP_TERMINAL_STATUSES.has(row.stepRun.status)) {
    return getWorkflowExecutionResultSnapshot(db, row.run.id);
  }

  const now = new Date();
  const existingMetadata = row.stepRun.metadata && typeof row.stepRun.metadata === "object" && !Array.isArray(row.stepRun.metadata)
    ? row.stepRun.metadata
    : {};
  const steps = normalizeWorkflowStepsForExecution(row.definition.stepsJson);
  const step = steps.find((candidate) => candidate.id === row.stepRun.stepId);
  const deleteAfterUse = step?.executionControls?.deleteAfterUse === true
    || getMetadataRecord(existingMetadata, "executionControls").deleteAfterUse === true;
  const toolResult = {
    requestId: input.requestId ?? row.stepRun.lastDispatchRequestId ?? null,
    toolName: input.toolName ?? null,
    success: input.success,
    stdout: input.stdout ?? null,
    stderr: input.stderr ?? null,
    exitCode: input.exitCode ?? null,
    error: input.error ?? null,
    completedAt: now.toISOString(),
  };
  const resultMetadata: Record<string, unknown> = deleteAfterUse
    ? {
      ...(step ? buildWorkflowStepRunMetadata(step, existingMetadata) : normalizeRecord(existingMetadata)),
      retentionDeleted: {
        deleteAfterUse: true,
        toolName: input.toolName ?? null,
        success: input.success,
        exitCode: input.exitCode ?? null,
        deletedAt: now.toISOString(),
      },
    }
    : {
      ...existingMetadata,
      toolResult,
    };
  if (deleteAfterUse) {
    delete resultMetadata.toolInvocation;
    delete resultMetadata.toolResult;
    delete resultMetadata.cacheHit;
  }
  await db
    .update(workflowStepRuns)
    .set({
      status: input.success ? "completed" : "failed",
      startedAt: row.stepRun.startedAt ?? now,
      completedAt: now,
      lastDispatchErrorAt: input.success ? row.stepRun.lastDispatchErrorAt : now,
      lastDispatchErrorSummary: input.success ? row.stepRun.lastDispatchErrorSummary : input.error ?? input.stderr ?? null,
      metadata: resultMetadata,
    })
    .where(eq(workflowStepRuns.id, row.stepRun.id));

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
  companyId?: string,
): Promise<boolean> {
  const whereClause = companyId
    ? and(eq(workflowRuns.id, runId), eq(workflowRuns.companyId, companyId))
    : eq(workflowRuns.id, runId);
  const updatedRows = await db
    .update(workflowRuns)
    .set({
      status: "cancelled",
      completedAt: new Date(),
    })
    .where(whereClause)
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
  stepRuns = await syncStepRunsFromIssueState(db, stepRuns, context.steps);

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
      const runnableSteps = sortWorkflowStepsByPriority(findRunnableSteps(context.steps, stepRunMap, {
        launchedStepIds: dynamicLaunchStepIds,
      }));
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
  const context = await loadWorkflowExecutionContext(db, runId);
  await assertWorkflowToolStepsReady({
    companyId: context.run.companyId,
    steps: context.steps,
  });
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
