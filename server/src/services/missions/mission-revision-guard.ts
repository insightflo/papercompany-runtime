import { and, eq } from "drizzle-orm";
import { missions, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { missionRevisionUnitSchema } from "@paperclipai/shared/validators/mission-revision";
import { unprocessable } from "../../errors.js";
import { loadExecutionDefinition } from "../workflow/execution-definition.js";
import { revisionStepHash, type RevisionStep } from "../workflow/revision-step-config.js";
import { revisionGraphHashes } from "../workflow/revision-graph-config.js";
import { revisionCurrentHeartbeats } from "./revision-current-heartbeats.js";
import { hasRevisionResultFailure } from "./revision-failure-evidence.js";

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
  // Explicit mappings must be valid; new units and removal of old approaches are allowed.
  for (const items of [input.units ?? [], input.steps]) {
    const seen = new Set<string>();
    for (const item of items) {
      const parsed = missionRevisionUnitSchema.safeParse(item);
      if (!parsed.success) throw error("source_mapping_invalid");
      const id = parsed.data.sourceStepId;
      if (id && (!sourceIds.has(id) || seen.has(id))) throw error("source_mapping_invalid", { sourceStepId: id });
      if (id) seen.add(id);
    }
  }
  const sourceGraph = revisionGraphHashes(historical.steps), targetGraph = revisionGraphHashes(input.steps);
  const failed = await db.select().from(workflowStepRuns).where(and(eq(workflowStepRuns.workflowRunId, source.id), eq(workflowStepRuns.status, "failed")));
  for (const step of failed) {
    const original = historical.steps.find(s => s.id === step.stepId);
    if (!original) throw error("failure_evidence_missing", { sourceStepId: step.stepId });
    const heartbeats = await revisionCurrentHeartbeats(db, input.companyId, step);
    const executionFailures = heartbeats.filter(h => h.status === "failed" || h.status === "timed_out");
    const resultFailure = await hasRevisionResultFailure(db, input.companyId, step, original, heartbeats);
    if (!executionFailures.length && !resultFailure) throw error("failure_evidence_missing", { sourceStepId: step.stepId });
    for (const heartbeat of executionFailures) {
      if (!heartbeat.errorCode) throw error("failure_evidence_missing", { sourceStepId: step.stepId });
      const hash = revisionStepHash(original, historical.steps, "failure", "current");
      for (const target of input.steps) {
        // Explicit coordinates preserve correspondence when upstream config changes. Graph
        // fingerprints also catch unlinked equivalent generated nodes without guessing identity.
        if (revisionStepHash(target, input.steps, "failure") === hash
          || targetGraph.get(target.id) === sourceGraph.get(step.stepId)) throw error("repeat_failure", {
          stepId: target.id, sourceStepId: step.stepId, sourceWorkflowRunId: source.id,
          errorCode: heartbeat.errorCode, configHash: hash, configHashVersion: 2,
        });
      }
    }
  }
}
