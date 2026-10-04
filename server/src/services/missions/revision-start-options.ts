import { and, eq, inArray } from "drizzle-orm";
import { toolDefinitions, workflowDefinitions, workflowStepRuns, type Db } from "@paperclipai/db";
import { loadExecutionDefinition } from "../workflow/execution-definition.js";
import { revisionStepHash, type RevisionStep } from "../workflow/revision-step-config.js";
import { buildCompanyWorkflowExecutionSteps } from "../workflow/company-execution-steps.js";
import { classifyWorkflowStepRole } from "../workflow-step-role.js";
import { resolveEdges } from "../workflow/control-flow/edge-condition.js";
import { isNativeToolStep } from "../workflow/workflow-seed-tool-output.js";
import { loadRevisionBoardWait } from "./revision-board-wait.js";

/** Candidate display only. POST admission rechecks actual original attempts, files and hashes. */
export async function revisionStartOptions(db: Db, companyId: string, missionId: string) {
  const wait = await loadRevisionBoardWait(db, companyId, missionId);
  if (!wait) return null;
  const [definition] = await db.select().from(workflowDefinitions).where(and(eq(workflowDefinitions.id, wait.workflowDefinitionId), eq(workflowDefinitions.companyId, companyId)));
  if (!definition) return null;
  if (!wait.sourceWorkflowRunId) return { ...wait, candidates: [] };
  const source = await loadExecutionDefinition(db, wait.sourceWorkflowRunId, { requireHistorical: true });
  const completed = await db.select().from(workflowStepRuns).where(and(eq(workflowStepRuns.workflowRunId, wait.sourceWorkflowRunId),
    eq(workflowStepRuns.status, "completed")));
  const steps = await buildCompanyWorkflowExecutionSteps(db, definition);
  // Native tool units execute company-declared tools; candidates require the current company
  // declarations admission would run against (Q4/Q5 semantics — no undeclared-tool candidate).
  const nativeToolNames = [...new Set(steps.filter(isNativeToolStep).flatMap(step => step.toolNames ?? []))];
  const declaredToolNames = nativeToolNames.length
    ? new Set((await db.select({ name: toolDefinitions.name }).from(toolDefinitions)
      .where(and(eq(toolDefinitions.companyId, companyId), inArray(toolDefinitions.name, nativeToolNames)))).map(row => row.name))
    : new Set<string>();
  const candidates = steps.flatMap(step => {
    const sourceId = (step as RevisionStep).sourceStepId ?? step.id;
    const original = source.steps.find(s => s.id === sourceId);
    const role = classifyWorkflowStepRole(step);
    // Native tool steps (issue-less tool execution, seed-spine tool-output evidence) join
    // candidates with the admission spine's own gating plus current company tool declarations.
    const nativeTool = isNativeToolStep(step);
    const names = nativeTool ? step.toolNames ?? [] : [];
    const nativeSupported = !nativeTool || (names.length > 0 && names.every(name => declaredToolNames.has(name))
      && !step.dynamicChildren && !step.ownerPlanBootstrapOnly && !step.bootstrapOnly
      && step.triggerOn !== "escalation" && step.executionMode !== "dynamic_owner_plan"
      && !resolveEdges(step).some(edge => !edge.isBackEdge && edge.when !== "success"));
    if (!original || !completed.some(s => s.stepId === sourceId) || (!step.agentId && !nativeTool)
      || (role !== "action" && (role !== "unknown" || (step.type && step.type !== "agent")) && !nativeTool) || step.qaType
      || !nativeSupported
      || revisionStepHash(step, steps) !== revisionStepHash(original, source.steps, "seed", "current")) return [];
    return [{ stepId: step.id, sourceStepId: sourceId, name: step.name, dependencies: step.dependencies }];
  });
  return { ...wait, candidates };
}
