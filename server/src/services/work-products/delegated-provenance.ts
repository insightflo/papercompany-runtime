import { and, eq } from "drizzle-orm";
import { heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { conflict } from "../../errors.js";

export type ProducerDelegation = { readonly kind: "mission_owner_unblock_source"; readonly issueId: string };

/** Separate authority supplied by the authorized workflow API, never by work-product metadata. */
export async function delegatedProducer(db: Pick<Db, "select">, companyId: string, issueId: string,
  heartbeat: typeof heartbeatRuns.$inferSelect, delegation: ProducerDelegation) {
  const [target] = await db.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId))).for("share");
  const [owner] = await db.select().from(issues).where(and(eq(issues.id, delegation.issueId), eq(issues.companyId, companyId))).for("share");
  if (delegation.kind !== "mission_owner_unblock_source" || heartbeat.companyId !== companyId
    || heartbeat.issueId !== delegation.issueId || !target?.missionId || target.originKind !== "workflow_execution"
    || !owner || owner.missionId !== target.missionId || owner.originKind !== "mission_main_executor_unblock"
    || owner.originId !== target.id || owner.status !== "in_progress" || owner.assigneeAgentId !== heartbeat.agentId
    || owner.checkoutRunId !== heartbeat.id) throw conflict("workproduct_producer_scope_mismatch");
  return { schemaVersion: "workflow.delegated-work-product-producer.v1" as const,
    kind: delegation.kind, companyId, missionId: target.missionId, sourceIssueId: target.id,
    delegatedFromIssueId: owner.id, heartbeatRunId: heartbeat.id, executionGeneration: null };
}
