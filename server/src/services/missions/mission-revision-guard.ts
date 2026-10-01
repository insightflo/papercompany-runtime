import { and, eq, inArray } from "drizzle-orm";
import { heartbeatRuns, missions, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { missionRevisionUnitSchema } from "@paperclipai/shared/validators/mission-revision";
import { unprocessable } from "../../errors.js";
import { loadExecutionDefinition } from "../workflow/execution-definition.js";
import { revisionStepHash, type RevisionStep } from "../workflow/revision-step-config.js";

const error = (reason: string, details: Record<string, unknown> = {}) =>
  unprocessable(`mission_revision_${reason}`, { code: `mission_revision_${reason}`, ...details });

export async function checkMissionRevisionSteps(db: Db, input: { companyId: string; missionId?: string | null;
  steps: RevisionStep[]; units?: Record<string, unknown>[] }) {
  if (!input.missionId) return;
  const [mission] = await db.select().from(missions).where(and(eq(missions.id, input.missionId), eq(missions.companyId, input.companyId)));
  if (!mission?.sourceWorkflowRunId) return;
  if (!mission.sourceMissionId) throw error("source_scope_mismatch");
  const [source] = await db.select().from(workflowRuns).where(and(eq(workflowRuns.id, mission.sourceWorkflowRunId),
    eq(workflowRuns.companyId, input.companyId), eq(workflowRuns.missionId, mission.sourceMissionId)));
  if (!source) throw error("source_scope_mismatch");
  const historical = await loadExecutionDefinition(db, source.id, { requireHistorical: true });
  const sourceIds = new Set(historical.steps.map(s => s.id));
  const seen = new Set<string>();
  // All revision plan units must identify an existing source explicitly. No name/position matching.
  for (const unit of input.units ?? []) {
    const parsed = missionRevisionUnitSchema.safeParse(unit);
    if (!parsed.success || !parsed.data.sourceStepId || !sourceIds.has(parsed.data.sourceStepId)) throw error("source_mapping_required");
  }
  for (const step of input.steps) {
    const parsed = missionRevisionUnitSchema.safeParse(step);
    const id = parsed.success ? parsed.data.sourceStepId ?? (sourceIds.has(step.id) ? step.id : null) : null;
    if ((!parsed.success || step.sourceStepId) && (!id || !sourceIds.has(id))) throw error("source_mapping_invalid", { stepId: step.id });
    if (id && seen.has(id)) throw error("source_mapping_invalid", { stepId: step.id, sourceStepId: id });
    if (id) seen.add(id);
  }
  const failures = await db.select({ step: workflowStepRuns, heartbeat: heartbeatRuns }).from(workflowStepRuns)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.workflowStepRunId, workflowStepRuns.id),
      eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.issueId, workflowStepRuns.issueId),
      eq(heartbeatRuns.workflowExecutionGeneration, workflowStepRuns.executionGeneration)))
    .where(and(eq(workflowStepRuns.workflowRunId, source.id), eq(workflowStepRuns.status, "failed"),
      inArray(heartbeatRuns.status, ["failed", "timed_out"])));
  for (const { step, heartbeat } of failures) {
    if (!seen.has(step.stepId)) throw error("source_mapping_required", { sourceStepId: step.stepId });
    if (!heartbeat.errorCode) throw error("failure_evidence_missing", { sourceStepId: step.stepId });
    const original = historical.steps.find(s => s.id === step.stepId);
    if (!original) throw error("failure_evidence_missing", { sourceStepId: step.stepId });
    const hash = revisionStepHash(original, historical.steps, "failure", "current");
    for (const target of input.steps) {
      // Compare all configs, not just the declared mapping: mapping to a successful source or a new ID is no bypass.
      if (revisionStepHash(target, input.steps, "failure") === hash) throw error("repeat_failure", {
        stepId: target.id, sourceStepId: step.stepId, sourceWorkflowRunId: source.id,
        errorCode: heartbeat.errorCode, configHash: hash, configHashVersion: 2,
      });
    }
  }
  const failed = await db.select().from(workflowStepRuns).where(and(eq(workflowStepRuns.workflowRunId, source.id), eq(workflowStepRuns.status, "failed")));
  if (failed.some(s => !failures.some(f => f.step.id === s.id))) throw error("failure_evidence_missing");
}

