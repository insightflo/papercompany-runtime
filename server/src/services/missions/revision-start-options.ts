import { and, desc, eq, inArray } from "drizzle-orm";
import { missionPlanArtifacts, toolDefinitions, workflowDefinitions, workflowStepRuns, type Db } from "@paperclipai/db";
import { loadExecutionDefinition } from "../workflow/execution-definition.js";
import { revisionStepHash, type RevisionStep } from "../workflow/revision-step-config.js";
import { buildCompanyWorkflowExecutionSteps } from "../workflow/company-execution-steps.js";
import { classifyWorkflowStepRole } from "../workflow-step-role.js";
import { resolveEdges } from "../workflow/control-flow/edge-condition.js";
import { isNativeToolStep } from "../workflow/workflow-seed-tool-output.js";
import { loadRevisionBoardWait } from "./revision-board-wait.js";

/** [Q4 표시 전용] 활성 계획 refs 의 차단 단위 구조화 결과(revisionBlockedUnits)를 시작 화면 표시 행으로만 읽는다. */
function revisionBlockedUnitDisplayRows(refs: unknown): { unitId: string; label: string; toolName: string | null; code: string; message: string }[] {
  const stored = refs && typeof refs === "object" && !Array.isArray(refs)
    ? (refs as Record<string, unknown>).revisionBlockedUnits : undefined;
  if (!Array.isArray(stored)) return [];
  return stored.flatMap(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    const unitId = typeof row.unitId === "string" && row.unitId.trim() !== "" ? row.unitId : null;
    const code = typeof row.code === "string" && row.code.trim() !== "" ? row.code : null;
    if (!unitId || !code) return [];
    return [{
      unitId,
      label: typeof row.label === "string" && row.label.trim() !== "" ? row.label : unitId,
      toolName: typeof row.toolName === "string" && row.toolName.trim() !== "" ? row.toolName : null,
      code,
      message: typeof row.message === "string" ? row.message : "",
    }];
  });
}

/** Candidate display only. POST admission rechecks actual original attempts, files and hashes. */
export async function revisionStartOptions(db: Db, companyId: string, missionId: string) {
  const wait = await loadRevisionBoardWait(db, companyId, missionId);
  if (!wait) return null;
  const [blockedPlan] = await db.select({ refs: missionPlanArtifacts.refs }).from(missionPlanArtifacts)
    .where(and(eq(missionPlanArtifacts.companyId, companyId), eq(missionPlanArtifacts.missionId, missionId),
      eq(missionPlanArtifacts.status, "active")))
    .orderBy(desc(missionPlanArtifacts.revision)).limit(1);
  const blockedUnits = revisionBlockedUnitDisplayRows(blockedPlan?.refs);
  const blockedDisplay = blockedUnits.length > 0 ? { blockedUnits } : {};
  const [definition] = await db.select().from(workflowDefinitions).where(and(eq(workflowDefinitions.id, wait.workflowDefinitionId), eq(workflowDefinitions.companyId, companyId)));
  if (!definition) return null;
  if (!wait.sourceWorkflowRunId) return { ...wait, candidates: [], ...blockedDisplay };
  const source = await loadExecutionDefinition(db, wait.sourceWorkflowRunId, { requireHistorical: true });
  const completed = await db.select().from(workflowStepRuns).where(and(eq(workflowStepRuns.workflowRunId, wait.sourceWorkflowRunId),
    eq(workflowStepRuns.status, "completed")));
  const steps = await buildCompanyWorkflowExecutionSteps(db, definition);
  // Native tool units execute company-declared tools; candidates require the current company
  // declarations admission would run against (Q4/Q5 semantics — no undeclared-tool candidate).
  const nativeToolNames = [...new Set(steps.filter(isNativeToolStep).flatMap(step => step.toolNames ?? []))];
  const declaredToolNames = nativeToolNames.length
    ? new Set((await db.select({ name: toolDefinitions.name }).from(toolDefinitions)
      .where(and(eq(toolDefinitions.companyId, companyId), inArray(toolDefinitions.name, nativeToolNames)))).map(row => row.name))
    : new Set<string>();
  const candidates = steps.flatMap(step => {
    const sourceId = (step as RevisionStep).sourceStepId ?? step.id;
    const original = source.steps.find(s => s.id === sourceId);
    const role = classifyWorkflowStepRole(step);
    // Native tool steps (issue-less tool execution, seed-spine tool-output evidence) join
    // candidates with the admission spine's own gating plus current company tool declarations.
    const nativeTool = isNativeToolStep(step);
    const names = nativeTool ? step.toolNames ?? [] : [];
    const nativeSupported = !nativeTool || (names.length > 0 && names.every(name => declaredToolNames.has(name))
      && !step.dynamicChildren && !step.ownerPlanBootstrapOnly && !step.bootstrapOnly
      && step.triggerOn !== "escalation" && step.executionMode !== "dynamic_owner_plan"
      && !resolveEdges(step).some(edge => !edge.isBackEdge && edge.when !== "success"));
    if (!original || !completed.some(s => s.stepId === sourceId) || (!step.agentId && !nativeTool)
      || (role !== "action" && (role !== "unknown" || (step.type && step.type !== "agent")) && !nativeTool) || step.qaType
      || !nativeSupported
      || revisionStepHash(step, steps) !== revisionStepHash(original, source.steps, "seed", "current")) return [];
    return [{ stepId: step.id, sourceStepId: sourceId, name: step.name, dependencies: step.dependencies }];
  });
  return { ...wait, candidates, ...blockedDisplay };
}
