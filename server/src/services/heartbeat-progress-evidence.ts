import { z } from "zod";
import {
  activityLog, agentWakeupRequests, heartbeatRuns, issueWorkProducts,
  toolExecutionHeartbeats, workflowRuns, workflowStepRuns, type Db,
} from "@paperclipai/db";
import { and, eq, inArray } from "drizzle-orm";
import { workProductProducerSchema } from "@paperclipai/shared/validators/workflow-artifact";
import {
  readWorkflowAttemptProof, workflowAttemptProofSchema,
} from "./heartbeat-finalization/workflow-attempt-proof.js";

type Connection = Pick<Db, "select">;
type Audit = typeof activityLog.$inferSelect;
type Run = typeof heartbeatRuns.$inferSelect;
type Wake = typeof agentWakeupRequests.$inferSelect;
type Attempt = z.infer<typeof workflowAttemptProofSchema>;
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const toolEvidence = z.object({
  schemaVersion: z.literal(1), companyId: z.string().uuid(), agentId: z.string().uuid(),
  runId: z.string().uuid(), wakeupRequestId: z.string().uuid(),
  toolExecutionId: z.string().uuid(), sequence: counter.positive(), requestId: z.string().min(1),
  workflowAttempt: workflowAttemptProofSchema.extend({ stepId: z.string().min(1) }).nullable(),
}).strict();
const productEvidence = z.object({
  schemaVersion: z.literal(1), companyId: z.string().uuid(), issueId: z.string().uuid(),
  runId: z.string().uuid(), workProductId: z.string().uuid(),
  workflowAttempt: workProductProducerSchema,
  previousSha256: hash.nullable(), newSha256: hash, byteSize: counter,
  created: z.boolean(), contentChanged: z.boolean(),
}).strict();
const actions = ["tool_progress.advanced", "issue.work_product_progress_accepted"];

export type C07ProgressEvidence = {
  key: string; kind: "tool" | "work_product"; runId: string; wakeupRequestId: string;
  workflowAttempt: Attempt | null;
};
export type C07ProgressRead = {
  byRun: Map<string, C07ProgressEvidence[]>;
  rejected: Array<{ activityId: string; reason: string }>;
};
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function evidenceKey(row: Audit): string {
  if (row.action === actions[0]) return `tool:${row.entityId}:${String(row.details?.sequence)}`;
  const e = object(row.details?.progressEvidence);
  // The original producing run distinguishes repeated A→B edits in different attempts.
  return `work_product:${row.entityId}:${String(e.runId)}:${String(e.created)}:${String(e.previousSha256)}:${String(e.newSha256)}`;
}

/** Compare the frozen admission to its original heartbeat/wake, never today's generation. */
async function attemptFor(db: Connection, run: Run, wake: Wake, frozen: {
  companyId: string; missionId: string | null; workflowRunId: string; stepRunId: string; stepId: string;
  executionGeneration: number; retryCount: number; iterationIndex: number;
}): Promise<Attempt | null> {
  let proof: Attempt;
  try { proof = readWorkflowAttemptProof(wake); } catch { return null; }
  if (proof.companyId !== frozen.companyId || proof.missionId !== frozen.missionId
    || proof.workflowRunId !== frozen.workflowRunId || proof.stepRunId !== frozen.stepRunId
    || proof.executionGeneration !== frozen.executionGeneration || proof.retryCount !== frozen.retryCount
    || proof.iterationIndex !== frozen.iterationIndex || proof.parentHeartbeatRunId !== run.retryOfRunId
    || run.workflowStepRunId !== proof.stepRunId || run.workflowExecutionGeneration !== proof.executionGeneration) return null;
  const [binding] = await db.select({ step: workflowStepRuns, workflow: workflowRuns })
    .from(workflowStepRuns).innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId))
    .where(eq(workflowStepRuns.id, proof.stepRunId));
  if (!binding || binding.workflow.companyId !== run.companyId || binding.workflow.id !== proof.workflowRunId
    || binding.workflow.missionId !== proof.missionId || binding.step.stepId !== frozen.stepId) return null;
  return proof;
}

async function validate(db: Connection, row: Audit, key: string, input: {
  companyId: string; issueId: string; agentId: string;
}): Promise<C07ProgressEvidence | null> {
  if (!row.runId || row.companyId !== input.companyId || row.actorType !== "system") return null;
  const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, row.runId));
  if (!run || run.companyId !== input.companyId || run.agentId !== input.agentId
    || run.issueId !== input.issueId || !run.startedAt || !run.wakeupRequestId
    || row.createdAt < run.startedAt) return null;
  const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, run.wakeupRequestId));
  if (!wake || wake.companyId !== run.companyId || wake.agentId !== run.agentId || wake.issueId !== run.issueId
    || wake.runId !== run.id || ["coalesced", "skipped"].includes(wake.status)
    || run.startedAt < wake.requestedAt) return null;
  if (row.action === actions[0]) {
    const parsed = toolEvidence.safeParse(row.details?.progressEvidence);
    if (!parsed.success || row.actorId !== "tool-progress" || row.entityType !== "tool_execution_heartbeat") return null;
    const e = parsed.data;
    if (e.companyId !== run.companyId || e.agentId !== run.agentId || e.runId !== run.id
      || e.wakeupRequestId !== wake.id || e.toolExecutionId !== row.entityId
      || row.details?.sequence !== e.sequence || row.details?.state !== "active" || row.details?.reason !== null
      || !counter.positive().safeParse(row.details?.current).success
      || !counter.safeParse(row.details?.stageIndex).success) return null;
    const [tool] = await db.select().from(toolExecutionHeartbeats).where(eq(toolExecutionHeartbeats.id, e.toolExecutionId));
    if (!tool || tool.companyId !== run.companyId || tool.adapterType !== "builtin" || tool.tokenHash !== null
      || tool.requestId !== e.requestId || tool.toolId !== row.details?.toolId || tool.sequence < e.sequence
      || !tool.policy.stages[Number(row.details?.stageIndex)]) return null;
    let proof: Attempt | null = null;
    if (e.workflowAttempt) {
      proof = await attemptFor(db, run, wake, e.workflowAttempt);
      if (!proof || Object.entries(proof).some(([name, value]) =>
        object(e.workflowAttempt)[name] !== value)
        || tool.workflowRunId !== proof.workflowRunId || tool.stepRunId !== proof.stepRunId
        || tool.stepId !== e.workflowAttempt.stepId || tool.executionGeneration !== proof.executionGeneration
        || tool.retryCount !== proof.retryCount || tool.iterationIndex !== proof.iterationIndex) return null;
    } else if ([run.workflowStepRunId, run.workflowExecutionGeneration, wake.workflowRunId,
      wake.workflowStepRunId, wake.workflowExecutionGeneration, tool.workflowRunId, tool.stepRunId,
      tool.stepId, tool.executionGeneration, tool.retryCount, tool.iterationIndex].some(value => value !== null)) return null;
    return { key, kind: "tool", runId: run.id, wakeupRequestId: wake.id, workflowAttempt: proof };
  }
  const parsed = productEvidence.safeParse(row.details?.progressEvidence);
  if (!parsed.success || row.actorId !== "work-product-progress" || row.entityType !== "issue_work_product") return null;
  const e = parsed.data, p = e.workflowAttempt;
  if (e.companyId !== run.companyId || e.issueId !== run.issueId || e.runId !== run.id
    || e.workProductId !== row.entityId || p.companyId !== run.companyId || p.heartbeatRunId !== run.id
    || !e.contentChanged || (e.created ? e.previousSha256 !== null
      : e.previousSha256 === null || e.previousSha256 === e.newSha256)) return null;
  const proof = await attemptFor(db, run, wake, p);
  if (!proof) return null;
  // Product ownership may have been restamped; only its stable scope is compared here.
  const [product] = await db.select({ companyId: issueWorkProducts.companyId, issueId: issueWorkProducts.issueId })
    .from(issueWorkProducts).where(eq(issueWorkProducts.id, e.workProductId));
  if (!product || product.companyId !== run.companyId || product.issueId !== run.issueId) return null;
  return { key, kind: "work_product", runId: run.id, wakeupRequestId: wake.id, workflowAttempt: proof };
}

/** Read only the two official writers. Invalid attribution cannot reset the no-progress chain.
 * The second query also sees competing attributions outside the selected twenty-run window.
 * No current-generation admission is rerun: late submissions remain fenced by the existing writers.
 */
export async function readC07ProgressEvidence(db: Connection, input: {
  companyId: string; issueId: string; agentId: string; runIds: readonly string[];
}): Promise<C07ProgressRead> {
  const result: C07ProgressRead = { byRun: new Map(), rejected: [] };
  if (!input.runIds.length) return result;
  const selected = await db.select().from(activityLog).where(and(eq(activityLog.companyId, input.companyId),
    inArray(activityLog.action, actions), inArray(activityLog.runId, [...input.runIds])));
  if (!selected.length) return result;
  const selectedKeys = new Set(selected.map(evidenceKey));
  const rows = await db.select().from(activityLog).where(and(eq(activityLog.companyId, input.companyId),
    inArray(activityLog.action, actions), inArray(activityLog.entityId, [...new Set(selected.map(row => row.entityId))])));
  const groups = new Map<string, Audit[]>();
  for (const row of rows) {
    const key = evidenceKey(row);
    if (selectedKeys.has(key)) groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  for (const [key, group] of groups) {
    const signatures = new Set(group.map(row => JSON.stringify({
      runId: row.runId, evidence: row.details?.progressEvidence,
    })));
    if (signatures.size !== 1) {
      result.rejected.push(...group.map(row => ({ activityId: row.id, reason: "conflicting_attribution" })));
      continue;
    }
    let evidence: C07ProgressEvidence | null = null;
    for (const row of group) {
      evidence = await validate(db, row, key, input);
      if (!evidence) break;
    }
    if (!evidence) {
      result.rejected.push(...group.map(row => ({ activityId: row.id, reason: "invalid_progress_evidence" })));
      continue;
    }
    if (input.runIds.includes(evidence.runId)) {
      result.byRun.set(evidence.runId, [...(result.byRun.get(evidence.runId) ?? []), evidence]);
    }
  }
  return result;
}
