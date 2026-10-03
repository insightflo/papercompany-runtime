import { and, eq } from "drizzle-orm";
import { issues, missions, workflowRuns, workflowStepRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import type { MissionRow, MissionServiceDeps } from "../missions.js";
import type { WorkflowStep } from "../workflow/dag-engine.js";
import type { IssueCreateInput, IssueRow } from "./shared-types.js";
import { classifyToolStepFailure, getWorkflowStepToolNames } from "./tool-step-failure.js";
import { buildToolStepRecoveryDescription } from "./tool-step-recovery-description.js";
import { logger } from "../../middleware/logger.js";
import { loadToolRecoveryBriefFacts } from "./tool-recovery-brief-facts.js";

/** Identity link only, not permission to execute. Creation and link commit together. */
export async function ensureToolRecoveryCard(db: Db, deps: MissionServiceDeps, input: {
  mission: MissionRow; oversightIssue: IssueRow; run: typeof workflowRuns.$inferSelect;
  stepRun: typeof workflowStepRuns.$inferSelect; step: WorkflowStep | null; workflowName: string;
}, createIssue: (tx: Db, companyId: string, data: IssueCreateInput) => Promise<IssueRow>) {
  const classification = classifyToolStepFailure(input.step, input.stepRun);
  const toolNames = getWorkflowStepToolNames(input.step);
  const result = await db.transaction(async (tx) => {
    await tx.select({ id: missions.id }).from(missions).where(eq(missions.id, input.mission.id)).for("update");
    const [linked] = await tx.select({ issue: issues }).from(workflowTransitionEvents)
      .innerJoin(issues, eq(issues.id, workflowTransitionEvents.issueId)).where(and(
        eq(workflowTransitionEvents.companyId, input.mission.companyId),
        eq(workflowTransitionEvents.missionId, input.mission.id),
        eq(workflowTransitionEvents.workflowStepRunId, input.stepRun.id),
        eq(workflowTransitionEvents.eventType, "owner_tool_recovery_target_v1"))).limit(1);
    if (linked) return { issue: linked.issue, created: false };
    // All optional context reads use nested SAVEPOINTs in this creation transaction.
    const facts = await loadToolRecoveryBriefFacts(tx as unknown as Db, input);
    // Legacy cards are not parsed or silently migrated. Explicit v2 submission can still target them.
    const issue = await createIssue(tx as unknown as Db, input.mission.companyId, {
      assigneeAgentId: input.mission.ownerAgentId,
      description: buildToolStepRecoveryDescription({ marker: `tool-step-recovery:${input.run.id}:${input.stepRun.stepId}`,
        missionTitle: input.mission.title, workflowName: input.workflowName, workflowRunId: input.run.id,
        stepId: input.stepRun.stepId, displayStepName: input.step?.name?.trim() || input.stepRun.stepId, toolNames, classification, facts }),
      missionId: input.mission.id, originKind: "mission_main_executor_unblock", originId: input.oversightIssue.id,
      parentId: input.oversightIssue.parentId ? undefined : input.oversightIssue.id,
      priority: "high", status: "todo", title: `[Owner Action] Tool step failed: ${input.stepRun.stepId}`,
    });
    await tx.insert(workflowTransitionEvents).values({ companyId: input.mission.companyId, missionId: input.mission.id,
      issueId: issue.id, workflowRunId: input.run.id, workflowStepRunId: input.stepRun.id,
      layer: "mission_owner_recovery", eventType: "owner_tool_recovery_target_v1",
      idempotencyKey: `owner-tool-card:${input.stepRun.id}`, payload: { schemaVersion: 1, kind: "tool_step",
        workflowRunId: input.run.id, stepRunId: input.stepRun.id } });
    return { issue, created: true };
  });
  if (result.created && deps.onOwnerActionCreated) {
    void Promise.resolve(deps.onOwnerActionCreated({ mission: input.mission, issue: result.issue,
      sourceIssue: input.oversightIssue, reason: "tool_step_failure_recovery_created" }))
      .catch((err) => logger.warn({ err, issueId: result.issue.id }, "failed to notify owner about tool recovery"));
  }
  return { ...result, classification, toolNames };
}
