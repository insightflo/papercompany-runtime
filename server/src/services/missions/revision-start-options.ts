import { and, eq } from "drizzle-orm";
import { workflowDefinitions, workflowStepRuns, type Db } from "@paperclipai/db";
import { loadExecutionDefinition } from "../workflow/execution-definition.js";
import { revisionStepHash, type RevisionStep } from "../workflow/revision-step-config.js";
import { buildWorkflowExecutionSteps } from "../workflow/execution-steps.js";
import { loadRevisionBoardWait } from "./revision-board-wait.js";

/** Candidate display only. POST admission rechecks actual original attempts, files and hashes. */
export async function revisionStartOptions(db: Db, companyId: string, missionId: string) {
  const wait = await loadRevisionBoardWait(db, companyId, missionId);
  if (!wait) return null;
  const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, wait.workflowDefinitionId));
  if (!definition) return null;
  if (!wait.sourceWorkflowRunId) return { ...wait, candidates: [] };
  const source = await loadExecutionDefinition(db, wait.sourceWorkflowRunId, { requireHistorical: true });
  const completed = await db.select().from(workflowStepRuns).where(and(eq(workflowStepRuns.workflowRunId, wait.sourceWorkflowRunId),
    eq(workflowStepRuns.status, "completed")));
  const steps = buildWorkflowExecutionSteps(definition);
  const candidates = steps.flatMap(step => {
    const sourceId = (step as RevisionStep).sourceStepId ?? step.id;
    const original = source.steps.find(s => s.id === sourceId);
    if (!original || !completed.some(s => s.stepId === sourceId) || (step.type && step.type !== "agent") || step.qaType
      || revisionStepHash(step, steps) !== revisionStepHash(original, source.steps)) return [];
    return [{ stepId: step.id, sourceStepId: sourceId, name: step.name, dependencies: step.dependencies }];
  });
  return { ...wait, candidates };
}
