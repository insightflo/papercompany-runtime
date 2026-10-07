import { randomUUID } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import { activityLog, issueWorkProducts, missions, workflowRuns, workflowRunSeeds, workflowStepRuns, type Db } from "@paperclipai/db";
import { workflowSeedRequestSchema } from "@paperclipai/shared/validators/workflow-seed";
import { forbidden } from "../../errors.js";
import { classifyWorkflowStepRole } from "../workflow-step-role.js";
import { createWorkflowRun } from "./workflow-store.js";
import { loadExecutionDefinition } from "./execution-definition.js";
import { resolveEdges } from "./control-flow/edge-condition.js";
import { selectSameRunWorkProduct } from "./workproduct-same-run.js";
import { propagateProducerRebind, withAutomaticProducerRebind } from "./automatic-producer-rebind.js";
import { readSeededStepProducts, requireSeedSource, seedError, seedStepHash, verifySeedProductBytes } from "./workflow-seed-evidence.js";
import { bindSeedInterpretedInputs, hasSeedInterpretedInputTokens } from "./seed-interpreted-inputs.js";
import { isNativeToolStep, readToolStepSeedArtifact } from "./workflow-seed-tool-output.js";
import type { TriggerActor } from "./replacement-admission.js";
import type { CreateWorkflowRunInput } from "./types.js";
import type { WorkflowStep } from "./dag-engine.js";
import type { RevisionStep } from "./revision-step-config.js";

export function assertSeedActor(input: CreateWorkflowRunInput, actor?: TriggerActor) {
  if (!input.seedFromRun) return;
  if (actor?.type !== "board" || !actor.userId) throw forbidden("workflow_seed_board_required");
  if (!input.missionId) throw seedError("linked_mission_required");
  if (input.replacementIntent || input.parentRunId || input.parentStepRunId) throw seedError("unsupported_combination");
  const parsed = workflowSeedRequestSchema.safeParse(input.seedFromRun);
  if (!parsed.success) throw seedError("request_invalid");
}

/** Seed 스파인이 받아들이는 단계 역할/형태 게이트(회사·도구·증명 검사는 별도).
 *  [수정 재사용] 재사용 준비(closure 자격 판정)가 입장 POST 재검과 같은 조건을 쓴다 — 표시/준비/입장 불일치 방지. */
export function isSeedSupportedStep(step: WorkflowStep): boolean {
  const role = classifyWorkflowStepRole(step);
  // Native tool steps (issue-less tool execution) join the seed spine without an agent producer.
  const nativeTool = isNativeToolStep(step);
  return !((role !== "action" && (role !== "unknown" || (step.type && step.type !== "agent")) && !nativeTool)
    || (!step.agentId && !nativeTool) || step.qaType || step.dynamicChildren || step.ownerPlanBootstrapOnly
    || step.bootstrapOnly || step.triggerOn === "escalation" || step.executionMode === "dynamic_owner_plan"
    || resolveEdges(step).some(e => !e.isBackEdge && e.when !== "success"));
}

function assertSupported(step: WorkflowStep) {
  if (!isSeedSupportedStep(step)) throw seedError("unsupported_step", { stepId: step.id });
}

export async function createSeededWorkflowRun(db: Db, input: CreateWorkflowRunInput, actor?: TriggerActor) {
  assertSeedActor(input, actor);
  const request = workflowSeedRequestSchema.parse(input.seedFromRun);
  return withAutomaticProducerRebind(db, () => db.transaction(async tx => {
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
      const step = targetDef.steps.find(s => s.id === id) as RevisionStep | undefined;
      const original = sourceDef.steps.find(s => s.id === (step?.sourceStepId ?? id));
      if (!step || !original || seedStepHash(step, targetDef.steps) !== seedStepHash(original, sourceDef.steps, "seed", "current")) throw seedError("incompatible_definition", { stepId: id });
      assertSupported(step);
      if (resolveEdges(step).some(edge => !edge.isBackEdge && !ids.has(edge.stepId))) throw seedError("dag_gap", { stepId: id });
    }
    for (const id of ids) {
      const targetStep = targetDef.steps.find(s => s.id === id) as RevisionStep;
      const sourceId = targetStep.sourceStepId ?? id;
      const [step] = await tx.select().from(workflowStepRuns).where(and(eq(workflowStepRuns.workflowRunId, source.id), eq(workflowStepRuns.stepId, sourceId))).for("share");
      if (!step || step.status !== "completed") throw seedError("source_incomplete", { stepId: id });
      const toolArtifact = isNativeToolStep(sourceDef.steps.find(s => s.id === sourceId)!)
        ? await readToolStepSeedArtifact(t, { companyId: input.companyId, run: source, stepRun: step }) : null;
      const products = [];
      if (!toolArtifact && step.issueId === null) {
        // A materialized source (completed, issueId:null) can only be re-seeded through its own
        // validated seed chain: never a fabricated issue or a latest-output fallback.
        const seeded = await readSeededStepProducts(t, { companyId: input.companyId, workflowRunId: source.id, stepId: sourceId });
        if (!seeded) throw seedError("source_incomplete", { stepId: id });
        for (const s of seeded) {
          const sha256 = s.product.metadata?.sha256;
          if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) throw seedError("sha_missing", { stepId: id });
          products.push({ id: s.product.id, type: s.product.type as "document", title: s.product.title, sha256, path: s.file, producer: s.producer });
        }
      } else if (!toolArtifact) {
        const issueId = step.issueId;
        if (!issueId) throw seedError("source_incomplete", { stepId: id });
        const rows = await tx.select().from(issueWorkProducts).where(and(eq(issueWorkProducts.companyId, input.companyId),
          eq(issueWorkProducts.issueId, issueId), ne(issueWorkProducts.status, "archived"))).for("share");
        if (!rows.length) throw seedError("products_missing", { stepId: id });
        for (const product of rows) {
          let selected;
          try {
            selected = await selectSameRunWorkProduct(t, { companyId: input.companyId, workflowRunId: source.id, stepId: sourceId,
              selector: { type: product.type as "document", title: product.title }, pinnedId: product.id });
          } catch (error) { propagateProducerRebind(error); throw seedError("source_provenance_invalid", { stepId: id }); }
          const { sha256 } = await verifySeedProductBytes(t, selected);
          products.push({ id: product.id, type: product.type, title: product.title, sha256, path: selected.file, producer: selected.producer });
        }
      }
      // [Q11] 설정 해시가 같아도 실제 해석 인자(토큰 → 실제 산출물·metadata·run 좌표 값)가 다르면 재사용을
      // 거절하고 승인 당시의 실제 값을 증거에 바인딩해 물화 때 재대조한다. 해석은 원본 run 좌표(sourceDef)에서
      // 수행한다. native tool 스텝도 동일 게이트를 통과한다(!toolArtifact 예외 제거 — 토큰 없으면 바인딩 없이
      // 기존 동작 그대로).
      const original = sourceDef.steps.find(s => s.id === sourceId) as RevisionStep;
      const interpretedInputs = hasSeedInterpretedInputTokens(original)
        ? await bindSeedInterpretedInputs(t, { companyId: input.companyId, sourceRun: source, targetRun: run,
          sourceStep: original, sourceSteps: sourceDef.steps, sourceStepRunId: step.id, targetStepId: id,
          requestedStepIds: request.stepIds, targetSteps: targetDef.steps })
        : undefined;
      const evidence = toolArtifact
        ? { schemaVersion: "workflow.seed.tool-output.v1", sourceDefinitionHash: sourceDef.definitionHash,
          targetDefinitionHash: targetDef.definitionHash, stepConfigHashVersion: 2,
          stepConfigHash: seedStepHash(targetStep, targetDef.steps), artifact: toolArtifact,
          ...(interpretedInputs ? { interpretedInputs } : {}) }
        : { schemaVersion: "workflow.seed.v1", sourceDefinitionHash: sourceDef.definitionHash,
          targetDefinitionHash: targetDef.definitionHash, stepConfigHashVersion: 2,
          stepConfigHash: seedStepHash(targetStep, targetDef.steps), products,
          ...(interpretedInputs ? { interpretedInputs } : {}) };
      await tx.insert(workflowRunSeeds).values({ companyId: input.companyId, targetRunId: run.id,
        targetStepId: id, targetStepRunId: randomUUID(), sourceRunId: source.id, sourceStepRunId: step.id, sourceStepId: sourceId,
        approvedByUserId: actor!.userId!, evidence });
    }
    await tx.insert(activityLog).values({ companyId: input.companyId, actorType: "user", actorId: actor!.userId!,
      action: "workflow_run.seed_approved", entityType: "workflow_run", entityId: run.id,
      details: { schemaVersion: 1, sourceWorkflowRunId: source.id, stepIds: request.stepIds } });
    return run;
  }));
}
