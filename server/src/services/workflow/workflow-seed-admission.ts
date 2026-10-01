import { randomUUID } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import { activityLog, issueWorkProducts, missions, workflowRuns, workflowRunSeeds, workflowStepRuns, type Db } from "@paperclipai/db";
import { workflowSeedRequestSchema } from "@paperclipai/shared/validators/workflow-seed";
import { forbidden } from "../../errors.js";
import { createWorkflowRun } from "./workflow-store.js";
import { loadExecutionDefinition } from "./execution-definition.js";
import { resolveEdges } from "./control-flow/edge-condition.js";
import { selectSameRunWorkProduct } from "./workproduct-same-run.js";
import { requireSeedSource, seedError, seedStepHash, verifySeedProductBytes } from "./workflow-seed-evidence.js";
import type { TriggerActor } from "./replacement-admission.js";
import type { CreateWorkflowRunInput } from "./types.js";
import type { WorkflowStep } from "./dag-engine.js";

export function assertSeedActor(input: CreateWorkflowRunInput, actor?: TriggerActor) {
  if (!input.seedFromRun) return;
  if (actor?.type !== "board" || !actor.userId) throw forbidden("workflow_seed_board_required");
  if (!input.missionId) throw seedError("linked_mission_required");
  if (input.replacementIntent || input.parentRunId || input.parentStepRunId) throw seedError("unsupported_combination");
  const parsed = workflowSeedRequestSchema.safeParse(input.seedFromRun);
  if (!parsed.success) throw seedError("request_invalid");
}

function assertSupported(step: WorkflowStep) {
  if ((step.type && step.type !== "agent") || !step.agentId || step.qaType || step.dynamicChildren || step.ownerPlanBootstrapOnly
    || step.bootstrapOnly || step.triggerOn === "escalation" || step.executionMode === "dynamic_owner_plan"
    || resolveEdges(step).some(e => e.isBackEdge || e.when !== "success")) throw seedError("unsupported_step", { stepId: step.id });
}

export async function createSeededWorkflowRun(db: Db, input: CreateWorkflowRunInput, actor?: TriggerActor) {
  assertSeedActor(input, actor);
  const request = workflowSeedRequestSchema.parse(input.seedFromRun);
  return db.transaction(async tx => {
    const t = tx as unknown as Db;
    if (!input.missionId) throw seedError("linked_mission_required");
    await tx.select().from(missions).where(and(eq(missions.id, input.missionId), eq(missions.companyId, input.companyId))).for("update");
    const { source } = await requireSeedSource(t, input.companyId, input.missionId, request.sourceWorkflowRunId);
    await tx.select().from(workflowRuns).where(eq(workflowRuns.id, source.id)).for("share");
    const sourceDef = await loadExecutionDefinition(t, source.id, { requireHistorical: true });
    const run = await createWorkflowRun(t, input);
    const targetDef = await loadExecutionDefinition(t, run.id, { requireHistorical: true });
    if (sourceDef.executionMode !== "static_dag" || targetDef.executionMode !== "static_dag") throw seedError("unsupported_definition");
    const ids = new Set(request.stepIds);
    // Check closure before product discovery: never silently fill a missing ancestor.
    for (const id of ids) {
      const step = targetDef.steps.find(s => s.id === id), original = sourceDef.steps.find(s => s.id === id);
      if (!step || !original || seedStepHash(step) !== seedStepHash(original)) throw seedError("incompatible_definition", { stepId: id });
      assertSupported(step);
      if (resolveEdges(step).some(edge => !ids.has(edge.stepId))) throw seedError("dag_gap", { stepId: id });
    }
    for (const id of ids) {
      const [step] = await tx.select().from(workflowStepRuns).where(and(eq(workflowStepRuns.workflowRunId, source.id), eq(workflowStepRuns.stepId, id))).for("share");
      if (!step || step.status !== "completed" || !step.issueId) throw seedError("source_incomplete", { stepId: id });
      const rows = await tx.select().from(issueWorkProducts).where(and(eq(issueWorkProducts.companyId, input.companyId),
        eq(issueWorkProducts.issueId, step.issueId), ne(issueWorkProducts.status, "archived"))).for("share");
      if (!rows.length) throw seedError("products_missing", { stepId: id });
      const products = [];
      for (const product of rows) {
        let selected;
        try {
          selected = await selectSameRunWorkProduct(t, { companyId: input.companyId, workflowRunId: source.id, stepId: id,
            selector: { type: product.type as "document", title: product.title }, pinnedId: product.id });
        } catch { throw seedError("source_provenance_invalid", { stepId: id }); }
        const { sha256 } = await verifySeedProductBytes(t, selected);
        products.push({ id: product.id, type: product.type, title: product.title, sha256, path: selected.file, producer: selected.producer });
      }
      await tx.insert(workflowRunSeeds).values({ companyId: input.companyId, targetRunId: run.id,
        targetStepId: id, targetStepRunId: randomUUID(), sourceRunId: source.id, sourceStepRunId: step.id, sourceStepId: id,
        approvedByUserId: actor!.userId!, evidence: { schemaVersion: "workflow.seed.v1", sourceDefinitionHash: sourceDef.definitionHash,
          targetDefinitionHash: targetDef.definitionHash, stepConfigHash: seedStepHash(targetDef.steps.find(s => s.id === id)!), products } });
    }
    await tx.insert(activityLog).values({ companyId: input.companyId, actorType: "user", actorId: actor!.userId!,
      action: "workflow_run.seed_approved", entityType: "workflow_run", entityId: run.id,
      details: { schemaVersion: 1, sourceWorkflowRunId: source.id, stepIds: request.stepIds } });
    return run;
  });
}
