import { and, eq } from "drizzle-orm";
import { approvals, missions, workflowStepRuns, workflowRecoveryAuthorities, workflowRunDefinitions, workflowRuns, type Db } from "@paperclipai/db";
import { replacementApprovalPayloadSchema } from "@paperclipai/shared/validators/workflow-replacement";
import { replacementBudgetBlocked, replacementExecutionInFlight } from "./replacement-execution-safety.js";
import { hashStructuredValue } from "../issue-execution-cards/hash.js";

export async function validReplacementStart(db: Pick<Db, "select">, run: typeof workflowRuns.$inferSelect) {
  const marker = run.metadata?.replacementAuthorityId;
  const [authority] = await db.select().from(workflowRecoveryAuthorities).where(and(
    eq(workflowRecoveryAuthorities.companyId, run.companyId), eq(workflowRecoveryAuthorities.replacementRunId, run.id))).limit(1);
  if (!authority) return marker === undefined;
  if (marker !== authority.id || authority.recoveryKind !== "replacement_from_start_v1" || authority.status !== "consumed"
    || !authority.operatorApprovalId || run.dispatchAuthorityVersion !== 0) return false;
  const parsed = replacementApprovalPayloadSchema.safeParse(Object.fromEntries(Object.entries(authority.replacementContract ?? {}).filter(([k]) => k !== "approver")));
  if (!parsed.success) return false;
  const p = parsed.data;
  const steps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, authority.workflowRunId)).for("update");
  const [approval] = await db.select().from(approvals).where(eq(approvals.id, authority.operatorApprovalId)).for("share");
  const [definition] = await db.select().from(workflowRunDefinitions).where(eq(workflowRunDefinitions.workflowRunId, run.id)).for("share");
  const [mission] = await db.select().from(missions).where(eq(missions.id, p.missionId));
  if (!mission || await replacementBudgetBlocked(db as Db, run.companyId, mission.ownerAgentId)
    || await replacementExecutionInFlight(db, run.companyId, authority.workflowRunId, steps)) return false;
  const [source] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, authority.workflowRunId));
  const { replacementAuthorityId: _, executionDefinitionVersion: __, replacementStart: ___, ...metadata } = run.metadata ?? {};
  return !!approval && approval.status === "approved" && approval.decidedByUserId === authority.replacementContract?.approver
    && hashStructuredValue(approval.payload) === hashStructuredValue(p) && p.targetRunId === run.id && p.companyId === run.companyId
    && p.missionId === run.missionId && p.workflowId === run.workflowId && hashStructuredValue(metadata) === p.inputHash
    && definition?.definitionHash === p.definitionHash && source?.status === "failed"
    && source.dispatchAuthorityVersion === p.sourceAuthorityVersion;
}
