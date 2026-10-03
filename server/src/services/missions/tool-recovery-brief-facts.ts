import { and, eq, inArray } from "drizzle-orm";
import { toolDefinitions, type Db, type missions, type issues, type workflowRuns, type workflowStepRuns } from "@paperclipai/db";
import type { WorkflowStep } from "../workflow/dag-engine.js";
import { getWorkflowStepToolNames } from "./tool-step-failure.js";
import { findRelatedKnowledgePatterns } from "./mission-owner-related-patterns.js";
import { loadCompanySystemLanguage } from "./system-language.js";
import { loadToolRecoveryProducerFacts } from "./tool-recovery-producer-facts.js";
import { displayRecord, toolRecoveryHiddenValues, toolRecoveryPathFacts, toolRecoverySafeText } from "./tool-recovery-safe-display.js";
import { MISSION_OWNER_DECISION_OPTIONS } from "./mission-owner-recovery-events.js";
import { evaluateOwnerToolRecoverySnapshot, ownerDecisionRequestsHuman, toolRecoveryDecisionEffect } from "./owner-tool-recovery-eligibility.js";
import { ownerRecoveryActorFailure, ownerRecoveryIssueFailure, ownerRecoveryOwnerMatches, ownerRecoverySourceMatches, ownerRecoveryRunMatches, ownerRecoveryStepMatches } from "./owner-recovery-submission-guards.js";
import { isIssueLessToolStep } from "../workflow/issue-less-tool-shape.js";
import { isWorkflowChildStep } from "../workflow/workflow-child-guards.js";
import { isWorkflowApiIssue } from "../workflow/issue-api-guards.js";
import { replacementOperatorEligible, replacementRequesterEligible, replacementDecisionSelected, replacementSourceEligible } from "../workflow/replacement-snapshot-guards.js";
import { toolRecoveryOwnsStepFailure } from "./tool-step-recovery-authority.js";

export type ToolRecoveryBriefInput = {
  mission: typeof missions.$inferSelect; oversightIssue: typeof issues.$inferSelect;
  run: typeof workflowRuns.$inferSelect; stepRun: typeof workflowStepRuns.$inferSelect;
  step: WorkflowStep | null; workflowName: string;
};
/** Nested transactions are SAVEPOINTs. A failed optional SELECT cannot poison card creation. */
async function optionalRead<T>(db: Db, read: (tx: Db) => Promise<T>): Promise<T | null> {
  try { return await db.transaction(tx => read(tx as unknown as Db)); }
  catch { return null; } // Never publish SQL/config/error bodies into the issue.
}
export async function loadToolRecoveryBriefFacts(db: Db, input: ToolRecoveryBriefInput) {
  const { mission, run, stepRun, step } = input;
  const names = getWorkflowStepToolNames(step).slice(0, 12);
  const tools = await optionalRead(db, tx => names.length ? tx.select().from(toolDefinitions).where(and(
    eq(toolDefinitions.companyId, mission.companyId), inArray(toolDefinitions.name, names))).limit(12) : Promise.resolve([]));
  const secrets = [...(tools ?? []).flatMap(t => toolRecoveryHiddenValues(t.adapterConfig)), ...toolRecoveryHiddenValues(stepRun.metadata)];
  const safe = (v: unknown) => toolRecoverySafeText(v, secrets);
  const language = await optionalRead(db, tx => loadCompanySystemLanguage(tx, mission.companyId));
  const patterns = await optionalRead(db, tx => findRelatedKnowledgePatterns(tx, mission.companyId,
    [mission.title, input.workflowName, stepRun.stepId, ...names]));
  const producers = await optionalRead(db, tx => loadToolRecoveryProducerFacts(tx, run, stepRun.id, step));
  const recoveryTarget = { kind: "tool_step" as const, workflowRunId: run.id, stepRunId: stepRun.id,
    expectedAuthorityVersion: run.dispatchAuthorityVersion, expectedExecutionGeneration: stepRun.executionGeneration,
    failedDispatchRequestId: stepRun.lastDispatchRequestId };
  const cardScope = { originKind: "mission_main_executor_unblock", missionId: mission.id };
  const result = displayRecord(stepRun.metadata?.toolResult), invocation = displayRecord(stepRun.metadata?.toolInvocation);
  const submission = {
    issueScope: ownerRecoveryIssueFailure(cardScope) ?? "matches",
    assignedMissionOwner: ownerRecoveryOwnerMatches(mission, mission.ownerAgentId),
    sourceMission: ownerRecoverySourceMatches(input.oversightIssue, mission.id),
    sourceCompany: input.oversightIssue.companyId === mission.companyId,
    targetRunScope: run.companyId === mission.companyId && run.missionId === mission.id,
    targetStepScope: stepRun.workflowRunId === run.id,
    targetRun: ownerRecoveryRunMatches(run, recoveryTarget), targetStep: ownerRecoveryStepMatches(stepRun, recoveryTarget),
    actor: "conditional: authenticated current mission-owner agent only; board cannot submit as owner",
    ownerWithoutHeartbeat: ownerRecoveryActorFailure({ actorType: "agent", actorId: mission.ownerAgentId, agentId: mission.ownerAgentId, runId: null }),
    boardSubmission: ownerRecoveryActorFailure({ actorType: "user", actorId: "board", agentId: null, runId: null }),
    unchecked: ["issuing heartbeat company/agent/owner-action identity", "current issue identity", "checkout ownership/adoption", "HTTP schema"],
  };
  const ownership = toolRecoveryOwnsStepFailure(step, stepRun);
  const preflight = evaluateOwnerToolRecoverySnapshot({ mission, issue: { originId: input.oversightIssue.id },
    sourceIssue: input.oversightIssue, stepRows: [], decision: null, toolCard: true, qaCard: false, apply: true });
  return {
    language: language ?? "en", languageLookup: language === null ? "unavailable" : "available", recoveryTarget, submission,
    // This is a creation snapshot: there is no decision for the not-yet-created issue. No invented ledger event.
    execution: { decision: preflight.kind === "blocked" ? preflight.reason : preflight.kind, ownership,
      canonicalToolShape: step ? isIssueLessToolStep(step) : "unavailable",
      childStep: step ? isWorkflowChildStep(step) : "unavailable", status: "requires_decision",
      unchecked: ["latest scoped owner decision", "retry key consumption", "active mission under lock", "unreplaced run",
        "budget", "execution in flight", "current failed terminal decision", "authority consumption", "completedAt fence", "artifact contract/bytes"] },
    decisions: MISSION_OWNER_DECISION_OPTIONS.map(decision => ({ decision,
      submission: "conditional_owner_api", effect: toolRecoveryDecisionEffect(decision),
      humanRequest: ownerDecisionRequestsHuman(decision),
      replacement: replacementDecisionSelected(decision) ? { sourceEligible: replacementSourceEligible(mission, run),
        ownerMayApprove: replacementOperatorEligible({ type: "agent", agentId: mission.ownerAgentId, companyId: mission.companyId }, mission.companyId),
        ownerRequesterShape: replacementRequesterEligible({ type: "agent", agentId: mission.ownerAgentId, companyId: mission.companyId }, mission.companyId),
        authority: "separate owner decision + board approval + owner replacement admission; locked checks unevaluated" } : null,
      ...(decision === "reassign_source_issue" ? { requiredField: "targetAgentId", applicability: "no source execution assignee on this tool card" } : {}),
      ...(decision === "recover_artifact" ? { producerReference: {
        fields: ["reworkTargetRef", "sourceIssueRef"], precedence: "reworkTargetRef ?? sourceIssueRef",
        requirement: "must resolve by issue id or identifier to the same-company/same-mission issue owning an active officially registered workProduct",
        distinctFrom: "recoveryTarget identifies the failed tool attempt, not the producer issue",
      } } : {}),
    })),
    registration: { status: isWorkflowApiIssue(cardScope) ? "conditional" : "registration_not_applicable",
      oversightEligible: isWorkflowApiIssue(input.oversightIssue),
      delegation: "only exact workflow_execution source of a checked-out unblock issue; this card points to oversight, not an arbitrary producer",
      recovery: "existing active official same-company/same-mission producer workProduct plus registration activity may be recoverable; result completion revalidates contract and bytes" },
    registry: tools === null ? "unavailable" : names.map(name => {
      const tool = tools.find(t => t.name === name);
      if (!tool) return { name: safe(name), status: "unavailable" };
      const config = displayRecord(tool.adapterConfig);
      return { id: tool.id, name: safe(tool.name), enabled: tool.enabled, adapterType: safe(tool.adapterType),
        source: "current company tool registry; not a historical invocation snapshot",
        command: safe(config.command), cwd: safe(config.workingDirectory ?? config.cwd), url: safe(config.url),
        instructionRefs: { registry: `/api/companies/${mission.companyId}/tools`,
          paths: [config.instructionsFilePath, config.instructionsPath].filter(v => typeof v === "string").map(safe),
          excerpt: safe(config.instructions) },
        envKeys: Object.keys(displayRecord(config.env)).slice(0, 40).map(safe) };
    }),
    toolResult: Object.fromEntries(["requestId", "toolName", "success", "exitCode", "errorCode", "error", "artifactPath"].map(key => [key, safe(result[key])])),
    invocationPaths: toolRecoveryPathFacts(invocation, secrets),
    producers: producers ?? "unavailable",
    relatedPatterns: patterns === null ? "unavailable" : patterns.slice(0, 3).map(p => ({ id: p.id, title: safe(p.title) })),
    // Kept private to this renderer call, never serialized as facts.
    safe,
  };
}
export type ToolRecoveryBriefFacts = Awaited<ReturnType<typeof loadToolRecoveryBriefFacts>>;
