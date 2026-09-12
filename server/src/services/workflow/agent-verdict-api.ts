import { issues, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import type { WorkflowVerdictSubmit } from "@paperclipai/shared/validators/workflow-agent-api";
import { conflict, notFound, unprocessable } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { reconcileRecoveredWorkflowStep } from "../missions/recovery-closeout.js";
import type { WorkflowApiActor, WorkflowApiIssue } from "./agent-api.js";
import { workflowService } from "./engine.js";
import { recordWorkflowValidationVerdict } from "./validation-verdict-ledger.js";

/** Check the durable row, not a caller-supplied origin/marker projection. */
export async function assertNotPlanQaWorkflowVerdict(db: Db, issue: Pick<WorkflowApiIssue, "id" | "companyId">) {
  const [row] = await db.select({ originKind: issues.originKind, marker: issues.qualityPlanQaBinding }).from(issues)
    .where(and(eq(issues.companyId, issue.companyId), eq(issues.id, issue.id))).limit(1);
  if (!row) throw notFound("Issue not found");
  if (row.originKind === "mission_plan_qa" || row.marker !== null) {
    throw conflict("quality_plan_qa_dedicated_submission_required");
  }
}

export async function submitWorkflowVerdict(input: {
  readonly db: Db;
  readonly issue: WorkflowApiIssue;
  readonly actor: WorkflowApiActor;
  readonly data: WorkflowVerdictSubmit;
}) {
  await assertNotPlanQaWorkflowVerdict(input.db, input.issue);
  const result = await recordWorkflowValidationVerdict({
    db: input.db,
    issue: input.issue,
    verdict: input.data.verdict,
    source: "workflow_api",
    actorAgentId: input.actor.agentId,
    heartbeatRunId: input.actor.runId,
    sourceText: input.data.reason ?? input.data.verdict,
    // Only the structured submission carries acceptance, findings and remediations.
    nonblockingAcceptance: input.data.nonblockingAcceptance ?? null,
    findings: input.data.findings ?? null,
    remediations: input.data.remediations ?? null,
  });
  if (!result.isCandidate) {
    throw unprocessable("Workflow verdict API can only be used on workflow execution issues linked to a workflow step run");
  }
  if (!result.satisfied) {
    throw unprocessable("Workflow verdict ledger was not recorded");
  }
  // Recovery reads the durable current-generation workflow_validation_verdict event, never prose.
  if (result.verdict === "pass" && input.issue.missionId) {
    try {
      const closeout = await reconcileRecoveredWorkflowStep(input.db, {
        companyId: input.issue.companyId,
        missionId: input.issue.missionId,
        qaGateIssueId: input.issue.id,
        source: "workflow_api_qa_pass",
      });
      if ("reconciled" in closeout && closeout.reconciled) {
        await workflowService.syncRunStatusForIssue(input.db, input.issue.id, "workflow_agent_api");
      }
    } catch (err) {
      logger.warn({ err, issueId: input.issue.id }, "recovery closeout failed after workflow verdict");
    }
  }
  await workflowService.syncRunStatusForIssue(input.db, input.issue.id, "workflow_agent_api");
  return result;
}
