import { and, eq } from "drizzle-orm";
import { workflowDefinitions, workflowStepRuns, type Db } from "@paperclipai/db";
import { loadExecutionDefinition } from "../workflow/execution-definition.js";
import { revisionStepHash, type RevisionStep } from "../workflow/revision-step-config.js";
import { buildCompanyWorkflowExecutionSteps } from "../workflow/company-execution-steps.js";
import { classifyWorkflowStepRole } from "../workflow-step-role.js";
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
  const candidates = steps.flatMap(step => {
    const sourceId = (step as RevisionStep).sourceStepId ?? step.id;
    const original = source.steps.find(s => s.id === sourceId);
    const role = classifyWorkflowStepRole(step);
    if (!original || !completed.some(s => s.stepId === sourceId) || !step.agentId
      || (role !== "action" && (role !== "unknown" || (step.type && step.type !== "agent"))) || step.qaType
      || revisionStepHash(step, steps) !== revisionStepHash(original, source.steps, "seed", "current")) return [];
    return [{ stepId: step.id, sourceStepId: sourceId, name: step.name, dependencies: step.dependencies }];
  });
  return { ...wait, candidates };
}
