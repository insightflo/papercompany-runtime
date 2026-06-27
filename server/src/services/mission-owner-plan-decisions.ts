import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies, issueComments, issues, missionPlanArtifacts, missionPlanQaVerdicts, missions, pluginEntities, workflowDefinitions, workflowRuns } from "@paperclipai/db";
import { logActivity } from "./activity-log.js";
import { mergeMissionPlanRefs, missionPlanArtifactService, type MissionPlanArtifact } from "./mission-plan-artifacts.js";
import { missionDelegationService } from "./mission-delegations.js";
import { workflowService } from "./workflow/engine.js";
import { executeWorkflowRun, type WorkflowStep } from "./workflow/dag-engine.js";
import { synthesizeQaReworkBackEdge } from "./missions/supervision-helpers.js";
import { createWorkflowRun } from "./workflow/workflow-store.js";
import { extractMissionIntent } from "./missions/mission-intent.js";
import { buildClarificationRequest, getMissionPlanQaCritiqueHook, reviewPlanAgainstIntent } from "./missions/mission-plan-qa.js";
import { issueService } from "./issues.js";
import { readExplicitValidationVerdict, type ValidationVerdict } from "./validation-verdict.js";

export type MissionOwnerPlanAssessment = {
  objectiveRestatement?: string;
  availableAssetsReviewed?: unknown[];
  assetEvaluation?: unknown[];
  gaps?: unknown[];
  researchPerformed?: unknown[];
};

export type MissionOwnerPlanDecisionPayload = {
  missionId?: unknown;
  goal?: unknown;
  missionGoal?: unknown;
  assessment?: unknown;
  selectedExecutionUnits?: unknown;
  ruleRefs?: unknown;
  kbRefs?: unknown;
  requiredInputs?: unknown;
  successCriteria?: unknown;
  steps?: unknown;
  [key: string]: unknown;
};

export type MissionOwnerPlanDecisionParseSuccess = {
  ok: true;
  decision: MissionOwnerPlanDecisionPayload;
};

export type MissionOwnerPlanDecisionParseDiagnostic = {
  ok: false;
  error: {
    code: "invalid_json" | "missing_json_object";
    message: string;
  };
};

export type MissionOwnerPlanDecisionParseResult =
  | MissionOwnerPlanDecisionParseSuccess
  | MissionOwnerPlanDecisionParseDiagnostic
  | null;

export type MissionOwnerPlanDecisionAuthor =
  | { kind: "agent"; id: string }
  | { kind: "user"; id: string };

export type MissionOwnerPlanDecisionCollectorDiagnostic = {
  commentId: string;
  code: "unauthorized_author" | "invalid_decision" | "no_decision_block";
  message: string;
};

export type LatestAuthorizedMissionOwnerPlanDecisionResult =
  | {
      ok: true;
      decision: MissionOwnerPlanDecisionPayload;
      planningIssueId: string;
      commentId: string;
      author: MissionOwnerPlanDecisionAuthor;
      diagnostics: MissionOwnerPlanDecisionCollectorDiagnostic[];
    }
  | {
      ok: false;
      reason: "mission_not_found" | "planning_issue_not_found" | "no_authorized_decision";
      planningIssueId: string | null;
      diagnostics: MissionOwnerPlanDecisionCollectorDiagnostic[];
    };

export type FindLatestAuthorizedMissionOwnerPlanDecisionInput = {
  db: Pick<Db, "select">;
  companyId: string;
  missionId: string;
  maxDiagnostics?: number;
};

const DECISION_HEADING = "### Mission owner plan decision";
const DECISION_HEADING_PATTERN = /^### Mission owner plan decision(?:\s+\([^)\n]+\))?\s*$/gm;
const DEFAULT_MAX_COLLECTOR_DIAGNOSTICS = 20;

export function parseMissionOwnerPlanDecision(text: string): MissionOwnerPlanDecisionParseResult {
  const blocks = extractDecisionBlocks(text);
  let latestDiagnostic: MissionOwnerPlanDecisionParseDiagnostic | null = null;

  for (const block of blocks) {
    const jsonText = extractDecisionJsonText(block);
    if (!jsonText) {
      latestDiagnostic = {
        ok: false,
        error: {
          code: "missing_json_object",
          message: "Mission owner plan decision block did not contain a JSON object",
        },
      };
      continue;
    }

    try {
      const parsed = JSON.parse(jsonText) as unknown;
      if (!isRecord(parsed)) {
        latestDiagnostic = {
          ok: false,
          error: {
            code: "invalid_json",
            message: "Mission owner plan decision JSON must be an object",
          },
        };
        continue;
      }

      return { ok: true, decision: parsed };
    } catch (error) {
      latestDiagnostic = {
        ok: false,
        error: {
          code: "invalid_json",
          message: `Invalid Mission owner plan decision JSON: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
  }

  return latestDiagnostic;
}

export async function findLatestAuthorizedMissionOwnerPlanDecision({
  db,
  companyId,
  missionId,
  maxDiagnostics = DEFAULT_MAX_COLLECTOR_DIAGNOSTICS,
}: FindLatestAuthorizedMissionOwnerPlanDecisionInput): Promise<LatestAuthorizedMissionOwnerPlanDecisionResult> {
  const diagnostics: MissionOwnerPlanDecisionCollectorDiagnostic[] = [];
  const pushDiagnostic = (diagnostic: MissionOwnerPlanDecisionCollectorDiagnostic) => {
    if (diagnostics.length < maxDiagnostics) {
      diagnostics.push(diagnostic);
    }
  };

  const [mission] = await db
    .select({ id: missions.id, ownerAgentId: missions.ownerAgentId })
    .from(missions)
    .where(and(eq(missions.companyId, companyId), eq(missions.id, missionId)))
    .limit(1);

  if (!mission) {
    return { ok: false, reason: "mission_not_found", planningIssueId: null, diagnostics };
  }

  const [planningIssue] = await db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.missionId, missionId),
        eq(issues.originKind, "mission_main_executor_plan"),
      ),
    )
    .orderBy(desc(issues.createdAt), desc(issues.id))
    .limit(1);

  if (!planningIssue) {
    return { ok: false, reason: "planning_issue_not_found", planningIssueId: null, diagnostics };
  }

  const comments = await db
    .select({
      id: issueComments.id,
      authorAgentId: issueComments.authorAgentId,
      authorUserId: issueComments.authorUserId,
      body: issueComments.body,
    })
    .from(issueComments)
    .where(and(eq(issueComments.companyId, companyId), eq(issueComments.issueId, planningIssue.id)))
    .orderBy(desc(issueComments.createdAt), desc(issueComments.id));

  for (const comment of comments) {
    const author = getAuthorizedDecisionAuthor({
      authorAgentId: comment.authorAgentId,
      authorUserId: comment.authorUserId,
      ownerAgentId: mission.ownerAgentId,
    });

    if (!author) {
      pushDiagnostic({
        commentId: comment.id,
        code: "unauthorized_author",
        message: "Mission owner plan decision comment was ignored because the author is not authorized",
      });
      continue;
    }

    const parsed = parseMissionOwnerPlanDecision(comment.body);
    if (!parsed) {
      pushDiagnostic({
        commentId: comment.id,
        code: "no_decision_block",
        message: "Mission owner plan decision comment was ignored because it did not contain a decision block",
      });
      continue;
    }

    if (!parsed.ok) {
      pushDiagnostic({
        commentId: comment.id,
        code: "invalid_decision",
        message: parsed.error.message,
      });
      continue;
    }

    return {
      ok: true,
      decision: parsed.decision,
      planningIssueId: planningIssue.id,
      commentId: comment.id,
      author,
      diagnostics,
    };
  }

  return {
    ok: false,
    reason: "no_authorized_decision",
    planningIssueId: planningIssue.id,
    diagnostics,
  };
}

function extractDecisionBlocks(text: string): string[] {
  const matches = [...text.matchAll(DECISION_HEADING_PATTERN)];
  return matches
    .map((match, index) => {
      const blockStart = (match.index ?? 0) + match[0].length;
      const nextMatch = matches[index + 1];
      const blockEnd = nextMatch?.index ?? text.length;
      return text.slice(blockStart, blockEnd);
    })
    .reverse();
}

function extractDecisionJsonText(block: string): string | null {
  const fencedJson = /```json\s*([\s\S]*?)```/i.exec(block);
  if (fencedJson?.[1]) {
    return fencedJson[1].trim();
  }

  const firstBrace = block.indexOf("{");
  if (firstBrace === -1) {
    return null;
  }

  return extractBalancedJsonObject(block.slice(firstBrace));
}

function extractBalancedJsonObject(text: string): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(0, index + 1).trim();
      }
    }
  }

  return text.trim();
}

function getAuthorizedDecisionAuthor({
  authorAgentId,
  authorUserId,
  ownerAgentId,
}: {
  authorAgentId: string | null;
  authorUserId: string | null;
  ownerAgentId: string;
}): MissionOwnerPlanDecisionAuthor | null {
  if (authorAgentId === ownerAgentId) {
    return { kind: "agent", id: authorAgentId };
  }

  const userId = authorUserId?.trim();
  if (userId) {
    return { kind: "user", id: userId };
  }

  return null;
}

function isRecord(value: unknown): value is MissionOwnerPlanDecisionPayload {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Slice 3C – buildMissionOwnerPlanRevisionDraft
// ---------------------------------------------------------------------------

const MAX_ARRAY_LENGTH = 1000;

export type BuildMissionOwnerPlanRevisionDraftInput = {
  decision: MissionOwnerPlanDecisionPayload;
  expectedMissionId: string;
  planningIssueId: string;
  commentId: string;
};

export type PlanRevisionDraft = {
  missionId: string;
  missionGoal?: string;
  refs: {
    schemaVersion: 3;
    selectedExecutionUnits: Record<string, unknown>[];
    ruleRefs: (string | Record<string, unknown>)[];
    kbRefs: (string | Record<string, unknown>)[];
    ownerPlanDecision: {
      planningIssueId: string;
      commentId: string;
      decisionHash?: string;
      assessment?: MissionOwnerPlanAssessment;
    };
    dynamicMissionPlanning?: Record<string, unknown>;
    selfImprovementCandidates?: Record<string, unknown>[];
  };
  requiredInputs: (string | Record<string, unknown>)[];
  successCriteria: (string | Record<string, unknown>)[];
  steps: (string | Record<string, unknown>)[];
};

export type BuildMissionOwnerPlanRevisionDraftSuccess = {
  ok: true;
  draft: PlanRevisionDraft;
};

export type BuildMissionOwnerPlanRevisionDraftDiagnostic = {
  code: string;
  message: string;
};

export type BuildMissionOwnerPlanRevisionDraftFailure = {
  ok: false;
  diagnostics: BuildMissionOwnerPlanRevisionDraftDiagnostic[];
};

export type BuildMissionOwnerPlanRevisionDraftResult =
  | BuildMissionOwnerPlanRevisionDraftSuccess
  | BuildMissionOwnerPlanRevisionDraftFailure;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringOrObject(entry: unknown): entry is string | Record<string, unknown> {
  if (typeof entry === "string") return true;
  return isPlainObject(entry);
}

function validateArrayOfStringsOrObjects(
  value: unknown,
  fieldName: string,
  diagnostics: BuildMissionOwnerPlanRevisionDraftDiagnostic[],
): (string | Record<string, unknown>)[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    diagnostics.push({ code: "invalid_field_shape", message: `${fieldName} must be an array` });
    return [];
  }
  if (value.length > MAX_ARRAY_LENGTH) {
    diagnostics.push({
      code: "array_too_large",
      message: `${fieldName} exceeds maximum length of ${MAX_ARRAY_LENGTH} (got ${value.length})`,
    });
    return [];
  }
  for (const entry of value) {
    if (!isStringOrObject(entry)) {
      diagnostics.push({
        code: "invalid_entry_type",
        message: `${fieldName} entries must be strings or objects, got ${typeof entry}`,
      });
      return [];
    }
  }
  return value as (string | Record<string, unknown>)[];
}

function validateAssessmentArray(value: unknown): unknown[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return undefined;
  if (value.length > MAX_ARRAY_LENGTH) return undefined;
  return value;
}

function validateMissionOwnerPlanAssessment(value: unknown): MissionOwnerPlanAssessment | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) return undefined;

  const assessment: MissionOwnerPlanAssessment = {};
  if (typeof value.objectiveRestatement === "string" && value.objectiveRestatement.trim() !== "") {
    assessment.objectiveRestatement = value.objectiveRestatement;
  }

  const availableAssetsReviewed = validateAssessmentArray(value.availableAssetsReviewed);
  const assetEvaluation = validateAssessmentArray(value.assetEvaluation);
  const gaps = validateAssessmentArray(value.gaps);
  const researchPerformed = validateAssessmentArray(value.researchPerformed);
  if (availableAssetsReviewed !== undefined) assessment.availableAssetsReviewed = availableAssetsReviewed;
  if (assetEvaluation !== undefined) assessment.assetEvaluation = assetEvaluation;
  if (gaps !== undefined) assessment.gaps = gaps;
  if (researchPerformed !== undefined) assessment.researchPerformed = researchPerformed;

  return Object.keys(assessment).length > 0 ? assessment : undefined;
}

function validateDynamicMissionArray(value: unknown): (string | Record<string, unknown>)[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > MAX_ARRAY_LENGTH) return undefined;
  return value.every(isStringOrObject) ? (value as (string | Record<string, unknown>)[]) : undefined;
}

function validateDynamicMissionSection(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null || !isPlainObject(value)) return undefined;
  const section: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalized = validateDynamicMissionArray(entry);
    if (normalized !== undefined) {
      section[key] = normalized;
    } else if (typeof entry === "string" && entry.trim() !== "") {
      section[key] = entry.trim();
    }
  }
  return Object.keys(section).length > 0 ? section : undefined;
}

function validateDynamicMissionPlanning(decision: MissionOwnerPlanDecisionPayload): Record<string, unknown> | undefined {
  const dynamicMissionPlanning: Record<string, unknown> = {};
  const missionInvariant = validateDynamicMissionArray(decision.missionInvariant);
  const evidenceRequired = validateDynamicMissionArray(decision.evidenceRequired);
  const executionSlice = validateDynamicMissionSection(decision.executionSlice);
  const gate = validateDynamicMissionSection(decision.gate);
  const promotion = validateDynamicMissionSection(decision.promotion);

  if (missionInvariant !== undefined) dynamicMissionPlanning.missionInvariant = missionInvariant;
  if (typeof decision.scopeHypothesis === "string" && decision.scopeHypothesis.trim() !== "") {
    dynamicMissionPlanning.scopeHypothesis = decision.scopeHypothesis.trim();
  }
  if (executionSlice !== undefined) dynamicMissionPlanning.executionSlice = executionSlice;
  if (evidenceRequired !== undefined) dynamicMissionPlanning.evidenceRequired = evidenceRequired;
  if (gate !== undefined) dynamicMissionPlanning.gate = gate;
  if (promotion !== undefined) dynamicMissionPlanning.promotion = promotion;

  return Object.keys(dynamicMissionPlanning).length > 0 ? dynamicMissionPlanning : undefined;
}

const SELF_IMPROVEMENT_ASSET_TYPES = new Set(["skill", "rule", "kb", "workflow", "role_harness"]);
const SELF_IMPROVEMENT_EDIT_OPERATIONS = new Set(["add", "delete", "replace"]);
const SELF_IMPROVEMENT_RESULTS = new Set(["accepted", "rejected", "queued_for_validation", "repair_needed"]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function validateSelfImprovementCandidateContract(
  candidate: Record<string, unknown>,
  index: number,
  diagnostics: BuildMissionOwnerPlanRevisionDraftDiagnostic[],
): void {
  const prefix = `selfImprovementCandidates[${index}]`;

  if (!isNonEmptyString(candidate.assetType) || !SELF_IMPROVEMENT_ASSET_TYPES.has(candidate.assetType)) {
    diagnostics.push({
      code: "invalid_candidate_contract",
      message: `${prefix}.assetType must be one of skill, rule, kb, workflow, role_harness`,
    });
  }
  if (!isNonEmptyString(candidate.assetRef)) {
    diagnostics.push({ code: "invalid_candidate_contract", message: `${prefix}.assetRef is required` });
  }
  if (!Array.isArray(candidate.evidenceSource) || candidate.evidenceSource.length === 0) {
    diagnostics.push({
      code: "invalid_candidate_contract",
      message: `${prefix}.evidenceSource must be a non-empty array`,
    });
  } else if (!candidate.evidenceSource.every(isStringOrObject)) {
    diagnostics.push({
      code: "invalid_candidate_contract",
      message: `${prefix}.evidenceSource entries must be strings or objects`,
    });
  }
  if (!isNonEmptyString(candidate.pattern)) {
    diagnostics.push({ code: "invalid_candidate_contract", message: `${prefix}.pattern is required` });
  }
  if (!isPlainObject(candidate.proposedEdit)) {
    diagnostics.push({ code: "invalid_candidate_contract", message: `${prefix}.proposedEdit must be an object` });
  } else {
    const operation = candidate.proposedEdit.operation;
    if (!isNonEmptyString(operation) || !SELF_IMPROVEMENT_EDIT_OPERATIONS.has(operation)) {
      diagnostics.push({
        code: "invalid_candidate_contract",
        message: `${prefix}.proposedEdit.operation must be one of add, delete, replace`,
      });
    }
    if (!isNonEmptyString(candidate.proposedEdit.section)) {
      diagnostics.push({ code: "invalid_candidate_contract", message: `${prefix}.proposedEdit.section is required` });
    }
  }
  if (!isNonEmptyString(candidate.validationPlan)) {
    diagnostics.push({ code: "invalid_candidate_contract", message: `${prefix}.validationPlan is required` });
  }
  if (!isNonEmptyString(candidate.gateOwner)) {
    diagnostics.push({ code: "invalid_candidate_contract", message: `${prefix}.gateOwner is required` });
  }
  if (!isNonEmptyString(candidate.autoAdoptionResult) || !SELF_IMPROVEMENT_RESULTS.has(candidate.autoAdoptionResult)) {
    diagnostics.push({
      code: "invalid_candidate_contract",
      message: `${prefix}.autoAdoptionResult must be one of accepted, rejected, queued_for_validation, repair_needed`,
    });
  } else if (candidate.autoAdoptionResult === "rejected" && !isNonEmptyString(candidate.rejectedEditNote)) {
    diagnostics.push({
      code: "invalid_candidate_contract",
      message: `${prefix}.rejectedEditNote is required when autoAdoptionResult is rejected`,
    });
  }
}

function validateSelfImprovementCandidates(
  value: unknown,
  diagnostics: BuildMissionOwnerPlanRevisionDraftDiagnostic[],
): Record<string, unknown>[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    diagnostics.push({ code: "invalid_field_shape", message: "selfImprovementCandidates must be an array" });
    return undefined;
  }
  if (value.length > MAX_ARRAY_LENGTH) {
    diagnostics.push({
      code: "array_too_large",
      message: `selfImprovementCandidates exceeds maximum length of ${MAX_ARRAY_LENGTH} (got ${value.length})`,
    });
    return undefined;
  }
  const candidates: Record<string, unknown>[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isPlainObject(entry)) {
      diagnostics.push({
        code: "invalid_entry_type",
        message: `selfImprovementCandidates entries must be objects, got ${typeof entry}`,
      });
      return undefined;
    }
    validateSelfImprovementCandidateContract(entry, index, diagnostics);
    candidates.push(entry);
  }
  return diagnostics.some((diagnostic) => diagnostic.message.includes("selfImprovementCandidates")) ? undefined : candidates;
}

export function buildMissionOwnerPlanRevisionDraft({
  decision,
  expectedMissionId,
  planningIssueId,
  commentId,
}: BuildMissionOwnerPlanRevisionDraftInput): BuildMissionOwnerPlanRevisionDraftResult {
  const diagnostics: BuildMissionOwnerPlanRevisionDraftDiagnostic[] = [];

  // Validate missionId
  if (decision.missionId !== undefined && decision.missionId !== null && decision.missionId !== expectedMissionId) {
    diagnostics.push({
      code: "mission_id_mismatch",
      message: `decision.missionId mismatch: expected ${expectedMissionId}, got ${String(decision.missionId)}`,
    });
  }

  let selectedExecutionUnits: Record<string, unknown>[] = [];

  // Validate selectedExecutionUnits when present: must be array of objects only
  if (decision.selectedExecutionUnits === undefined || decision.selectedExecutionUnits === null) {
    selectedExecutionUnits = [];
  } else if (!Array.isArray(decision.selectedExecutionUnits)) {
    diagnostics.push({
      code: "invalid_field_shape",
      message: "selectedExecutionUnits must be an array",
    });
  } else if (decision.selectedExecutionUnits.length > MAX_ARRAY_LENGTH) {
    diagnostics.push({
      code: "array_too_large",
      message: `selectedExecutionUnits exceeds maximum length of ${MAX_ARRAY_LENGTH} (got ${decision.selectedExecutionUnits.length})`,
    });
  } else {
    for (const entry of decision.selectedExecutionUnits) {
      if (!isPlainObject(entry)) {
        diagnostics.push({
          code: "invalid_entry_type",
          message: `selectedExecutionUnits entries must be objects, got ${typeof entry}`,
        });
        break;
      }
    }

    if (!diagnostics.some((diagnostic) => diagnostic.message.includes("selectedExecutionUnits"))) {
      selectedExecutionUnits = decision.selectedExecutionUnits as Record<string, unknown>[];
    }
  }

  // Validate flexible arrays (strings or objects)
  const ruleRefs = validateArrayOfStringsOrObjects(decision.ruleRefs, "ruleRefs", diagnostics);
  const kbRefs = validateArrayOfStringsOrObjects(decision.kbRefs, "kbRefs", diagnostics);
  const requiredInputs = validateArrayOfStringsOrObjects(decision.requiredInputs, "requiredInputs", diagnostics);
  const successCriteria = validateArrayOfStringsOrObjects(decision.successCriteria, "successCriteria", diagnostics);
  const steps = validateArrayOfStringsOrObjects(decision.steps, "steps", diagnostics);
  const assessment = validateMissionOwnerPlanAssessment(decision.assessment);
  const dynamicMissionPlanning = validateDynamicMissionPlanning(decision);
  const selfImprovementCandidates = validateSelfImprovementCandidates(decision.selfImprovementCandidates, diagnostics);

  // If any diagnostics accumulated, return failure
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  // Resolve missionGoal: prefer missionGoal, fallback to goal, omit if empty
  let missionGoal: string | undefined;
  if (typeof decision.missionGoal === "string" && decision.missionGoal.trim() !== "") {
    missionGoal = decision.missionGoal;
  } else if (typeof decision.goal === "string" && decision.goal.trim() !== "") {
    missionGoal = decision.goal;
  }

  const draft: PlanRevisionDraft = {
    missionId: expectedMissionId,
    ...(missionGoal !== undefined ? { missionGoal } : {}),
    refs: {
      schemaVersion: 3,
      selectedExecutionUnits,
      ruleRefs,
      kbRefs,
      ownerPlanDecision: {
        planningIssueId,
        commentId,
        ...(assessment !== undefined ? { assessment } : {}),
      },
      ...(dynamicMissionPlanning !== undefined ? { dynamicMissionPlanning } : {}),
      ...(selfImprovementCandidates !== undefined ? { selfImprovementCandidates } : {}),
    },
    requiredInputs,
    successCriteria,
    steps,
  };

  return { ok: true, draft };
}

// ---------------------------------------------------------------------------
// Slice 3D – service-level owner-plan materializer
// ---------------------------------------------------------------------------

const DEFAULT_OWNER_PLAN_MATERIALIZER_ACTOR_ID = "mission-owner-plan-materializer";
const NATIVE_WORKFLOW_DEFINITION_SOURCE_TYPES = new Set([
  "workflow_definition",
  "workflow_definition_step",
  "native_workflow_definition",
  "native_workflow_definition_step",
]);
const MISSION_PLAN_UNIT_SOURCE_TYPES = new Set([
  "mission_plan_unit",
  "mission_plan_step",
]);
const CROSS_COMPANY_MISSION_SOURCE_TYPES = new Set([
  "cross_company_mission",
  "cross_company_mission_request",
  "company_mission",
  "external_company_mission",
]);
const RUNNABLE_PLAN_ASSIGNEE_STATUSES = new Set(["active", "idle", "running"]);
const PLAN_QA_VERDICT_AGENT_ROLES = new Set(["qa", "reviewer", "validator"]);
const PLUGIN_WORKFLOW_ENTITY_SOURCE_TYPES = new Map<string, string[]>([
  ["plugin_workflow_definition", ["workflow-definition"]],
  ["plugin_workflow_definition_step", ["workflow-definition", "workflow-step-definition"]],
  ["plugin_workflow_run", ["workflow-run"]],
  ["plugin_workflow_step_run", ["workflow-step-run"]],
]);

type MaterializerActor = { actorType: "system" | "user" | "agent"; actorId: string };

export type RecordLatestAuthorizedMissionOwnerPlanDecisionInput = {
  db: Db;
  companyId: string;
  missionId: string;
  requestedBy?: MaterializerActor;
  enqueuePlanQaWakeup?: PlanQaWakeupHandler;
};

export type PlanQaWakeupHandler = (input: {
  companyId: string;
  agentId: string;
  issueId: string;
  issueStatus: string;
  missionId: string;
  planningIssueId: string | null;
}) => Promise<unknown> | unknown;

export type RecordLatestAuthorizedMissionOwnerPlanDecisionDiagnostic = {
  code: string;
  message: string;
  commentId?: string;
};

export type RecordLatestAuthorizedMissionOwnerPlanDecisionResult =
  | {
      status: "recorded";
      missionPlanArtifact: MissionPlanArtifact;
      revision: number;
      planningIssueId: string;
      commentId: string;
      decisionHash: string;
      diagnostics: RecordLatestAuthorizedMissionOwnerPlanDecisionDiagnostic[];
    }
  | {
      status: "plan_qa_pending";
      planningIssueId: string | null;
      commentId?: string;
      decisionHash: string;
      planQaIssueId: string;
      diagnostics: RecordLatestAuthorizedMissionOwnerPlanDecisionDiagnostic[];
    }
  | {
      status: "plan_qa_changes_requested";
      planningIssueId: string | null;
      commentId?: string;
      decisionHash: string;
      planQaIssueId: string;
      diagnostics: RecordLatestAuthorizedMissionOwnerPlanDecisionDiagnostic[];
    }
  | {
      status: "noop";
      reason: string;
      planningIssueId: string | null;
      commentId?: string;
      decisionHash?: string;
      diagnostics: RecordLatestAuthorizedMissionOwnerPlanDecisionDiagnostic[];
    }
  | {
      status: "invalid";
      reason: string;
      planningIssueId: string | null;
      commentId?: string;
      decisionHash?: string;
      diagnostics: RecordLatestAuthorizedMissionOwnerPlanDecisionDiagnostic[];
    };

export async function recordLatestAuthorizedMissionOwnerPlanDecision({
  db,
  companyId,
  missionId,
  requestedBy,
  enqueuePlanQaWakeup,
}: RecordLatestAuthorizedMissionOwnerPlanDecisionInput): Promise<RecordLatestAuthorizedMissionOwnerPlanDecisionResult> {
  const collected = await findLatestAuthorizedMissionOwnerPlanDecision({ db, companyId, missionId });
  if (!collected.ok) {
    const base = {
      reason: collected.reason,
      planningIssueId: collected.planningIssueId,
      diagnostics: collected.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    };
    if (collected.reason === "mission_not_found") {
      return { status: "invalid", ...base };
    }
    return { status: "noop", ...base };
  }

  const draftResult = buildMissionOwnerPlanRevisionDraft({
    decision: collected.decision,
    expectedMissionId: missionId,
    planningIssueId: collected.planningIssueId,
    commentId: collected.commentId,
  });
  const decisionHash = hashOwnerPlanDecision(collected.decision);

  if (!draftResult.ok) {
    return {
      status: "invalid",
      reason: "invalid_decision_shape",
      planningIssueId: collected.planningIssueId,
      commentId: collected.commentId,
      decisionHash,
      diagnostics: draftResult.diagnostics,
    };
  }

  const sourceValidationDiagnostics = await validateSelectedExecutionUnitSourceRefs({
    db,
    companyId,
    selectedExecutionUnits: draftResult.draft.refs.selectedExecutionUnits,
  });
  if (sourceValidationDiagnostics.length > 0) {
    return {
      status: "invalid",
      reason: "invalid_selected_execution_unit_source_ref",
      planningIssueId: collected.planningIssueId,
      commentId: collected.commentId,
      decisionHash,
      diagnostics: sourceValidationDiagnostics,
    };
  }

  // [ownership-drift invariant] planning issue(mission_main_executor_plan) assignee 가 mission.owner 와
  //   불일치하면 materialization 이 막히는 현상을 fail-fast 진단(content QA 와 분리된 code).
  //   owner-actions 가 planning issue 를 mission.owner 에 assign 하므로, 정상 조건에선 일치한다.
  //   drift(재할당) 감지 시 명확한 diagnostic 로 차단 — silent block 회피.
  const [ownershipRow] = await db
    .select({ ownerAgentId: missions.ownerAgentId, title: missions.title, description: missions.description })
    .from(missions)
    .where(and(eq(missions.companyId, companyId), eq(missions.id, missionId)))
    .limit(1);
  const [planningAssigneeRow] = await db
    .select({ assigneeAgentId: issues.assigneeAgentId })
    .from(issues)
    .where(eq(issues.id, collected.planningIssueId))
    .limit(1);
  const planningAssignee = planningAssigneeRow?.assigneeAgentId ?? null;
  const missionOwnerAgentId = ownershipRow?.ownerAgentId ?? null;
  if (planningAssignee && missionOwnerAgentId && planningAssignee !== missionOwnerAgentId) {
    const diagnostics = [{
      code: "ownership_drift",
      message: `Planning issue assignee (${planningAssignee}) 가 mission owner (${missionOwnerAgentId}) 와 불일치. planning issue 를 mission owner 에게 재할당하거나 의도된 변경이면 mission owner 를 갱신하세요.`,
      commentId: collected.commentId,
    }];
    // [P4] 거부 사유를 activity 로 노출(operator 가 governance-thread 에서 plan rejection 을 볼 수 있게).
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "mission-plan-qa",
      action: "mission.plan.rejected",
      entityType: "mission",
      entityId: missionId,
      details: { planningIssueId: collected.planningIssueId, reason: "ownership_drift", diagnostics },
    });
    return {
      status: "invalid",
      reason: "ownership_drift",
      planningIssueId: collected.planningIssueId,
      commentId: collected.commentId,
      decisionHash,
      diagnostics,
    };
  }

  // [plan-time QA] intent → required-units checklist (deterministic 1순회) + LLM critique(2순회, injectable).
  //   deterministic invalid 는 critique 가 완화 못 함(additive merge). critique unavailable 은 warn(차단 아님).
  //   needs_clarification 은 Hermes Ops clarification contract 로 surface(사용자 질문 전환).
  const missionIntent = extractMissionIntent(ownershipRow?.title ?? "", ownershipRow?.description ?? null);
  const deterministicDiagnostics = reviewPlanAgainstIntent({
    intent: missionIntent,
    selectedExecutionUnits: draftResult.draft.refs.selectedExecutionUnits,
    successCriteria: draftResult.draft.successCriteria,
  });
  let critiqueDiagnostics: typeof deterministicDiagnostics = [];
  const critiqueHook = getMissionPlanQaCritiqueHook();
  if (critiqueHook) {
    try {
      critiqueDiagnostics = await critiqueHook({
        intent: missionIntent,
        selectedExecutionUnits: draftResult.draft.refs.selectedExecutionUnits,
        priorDiagnostics: deterministicDiagnostics,
      });
    } catch (error) {
      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "mission-plan-qa",
        action: "mission.plan.critique_unavailable",
        entityType: "mission",
        entityId: missionId,
        details: { planningIssueId: collected.planningIssueId, error: error instanceof Error ? error.message : String(error) },
      });
    }
  }
  const planQaDiagnostics = [...deterministicDiagnostics, ...critiqueDiagnostics];
  const blockingPlanQa = planQaDiagnostics.filter((diagnostic) => diagnostic.severity === "invalid");
  if (blockingPlanQa.length > 0) {
    const blockingDiagnostics = blockingPlanQa.map((diagnostic) => ({
      code: diagnostic.code,
      message: diagnostic.message,
      commentId: collected.commentId,
    }));
    // [P4] 거부 사유(intent coverage 실패)를 activity 로 노출(operator 가 governance-thread 에서 확인).
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "mission-plan-qa",
      action: "mission.plan.rejected",
      entityType: "mission",
      entityId: missionId,
      details: { planningIssueId: collected.planningIssueId, reason: "plan_intent_coverage_failed", diagnostics: blockingDiagnostics },
    });
    return {
      status: "invalid",
      reason: "plan_intent_coverage_failed",
      planningIssueId: collected.planningIssueId,
      commentId: collected.commentId,
      decisionHash,
      diagnostics: blockingDiagnostics,
    };
  }
  const clarificationPlanQa = planQaDiagnostics.filter((diagnostic) => diagnostic.severity === "needs_clarification");
  if (clarificationPlanQa.length > 0) {
    // Hermes Ops 가 소비할 structured clarification contract. 직접 Telegram 발송은 Hermes 경로 확정 후.
    const clarificationRequest = buildClarificationRequest({ diagnostics: clarificationPlanQa, intent: missionIntent });
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "mission-plan-qa",
      action: "mission.plan.clarification_requested",
      entityType: "mission",
      entityId: missionId,
      details: { planningIssueId: collected.planningIssueId, clarificationRequest },
    });
  }

  const service = missionPlanArtifactService(db);
  const activePlan = await service.getActiveMissionPlan({ companyId, missionId });
  const activeOwnerDecision = readOwnerPlanDecisionRef(activePlan?.refs);
  const activePlanQa = readPlanQaRef(activePlan?.refs);
  const actor = requestedBy ?? { actorType: "system" as const, actorId: DEFAULT_OWNER_PLAN_MATERIALIZER_ACTOR_ID };
  const missionRow = await loadMissionRow(db, companyId, missionId);
  const missionTitle = missionRow?.title ?? missionId;

  // ── Plan-QA 게이트(항상 활성): 같은 decisionHash 가 이미 materialize 됐으면 통과, 아니면 QA verdict 대기 ──
  if (activeOwnerDecision?.decisionHash === decisionHash) {
    if (activePlan) {
      const activePlanRefs = isPlainObject(activePlan.refs) ? (activePlan.refs as Record<string, unknown>) : {};
      const paqoWorkflowRef = isPlainObject(activePlanRefs.paqoWorkflow) ? (activePlanRefs.paqoWorkflow as Record<string, unknown>) : null;
      // local workflow 가 materialize 됐거나(local unit 이 있는 경우), 또는 이미 PASS 한 plan(cross-company 위주 등
      // local workflow 가 없는 경우) 이면 재호출 시 멱등 noop.
      const alreadyMaterialized = activePlanQa?.verdict === "pass"
        || Boolean(paqoWorkflowRef && typeof paqoWorkflowRef.workflowRunId === "string" && paqoWorkflowRef.workflowRunId.length > 0);
      // (a) 이미 materialize → 게이트 통과 이력, 사이드이펙트 없이 noop
      if (alreadyMaterialized) {
        return { status: "noop", reason: "already_recorded", planningIssueId: collected.planningIssueId, commentId: collected.commentId, decisionHash, diagnostics: [] };
      }
      // (b) 같은 decisionHash 의 PLAN-QA 게이트 진행중 → verdict 로 분기
      if (activePlanQa && activePlanQa.decisionHash === decisionHash && activePlanQa.issueId) {
        const verdict = await readPlanQaVerdict({ db, companyId, planQaIssueId: activePlanQa.issueId });
        if (verdict === "pass") {
          await ensureCrossCompanyDelegationsForMissionOwnerPlan({ db, companyId, missionId, draft: draftResult.draft, missionPlanArtifactId: activePlan.id, decisionHash });
          await ensurePaqoWorkflowForMissionOwnerPlan({ db, companyId, missionId, draft: draftResult.draft, missionPlanArtifactId: activePlan.id, decisionHash, triggeredBy: actor.actorId });
          await closePlanQaIssue({ db, planQaIssueId: activePlanQa.issueId });
          await updatePlanQaRef({ db, companyId, missionId, missionPlanArtifactId: activePlan.id, patch: { status: "pass", verdict: "pass", reviewedAt: new Date().toISOString() } });
          await logActivity(db, { companyId, actorType: actor.actorType, actorId: actor.actorId, action: "mission.owner_plan.recorded", entityType: "mission", entityId: missionId, agentId: actor.actorType === "agent" ? actor.actorId : null, details: { missionPlanArtifactId: activePlan.id, revision: activePlan.revision, planningIssueId: collected.planningIssueId, commentId: collected.commentId, decisionMakerKind: collected.author.kind, decisionMakerId: collected.author.id, decisionHash, idempotencyKey: `${collected.commentId}:${decisionHash}`, planQaIssueId: activePlanQa.issueId } });
          const refreshedPlan = await service.getActiveMissionPlan({ companyId, missionId });
          const finalPlan = refreshedPlan ?? activePlan;
          return { status: "recorded", missionPlanArtifact: finalPlan, revision: finalPlan.revision, planningIssueId: collected.planningIssueId, commentId: collected.commentId, decisionHash, diagnostics: [] };
        }
        if (verdict === "request_changes") {
          await reopenPlanningIssueIfTerminal({ db, planningIssueId: collected.planningIssueId });
          await closePlanQaIssue({ db, planQaIssueId: activePlanQa.issueId });
          await updatePlanQaRef({ db, companyId, missionId, missionPlanArtifactId: activePlan.id, patch: { status: "request_changes", verdict: "request_changes", reviewedAt: new Date().toISOString() } });
          return { status: "plan_qa_changes_requested", planningIssueId: collected.planningIssueId, commentId: collected.commentId, decisionHash, planQaIssueId: activePlanQa.issueId, diagnostics: [] };
        }
        // pending / verdict 없음 → 대기 (어떤 경로에서도 materialize 금지)
        await ensurePlanQaWakeupForIssue({
          db,
          enqueuePlanQaWakeup,
          companyId,
          planQaIssueId: activePlanQa.issueId,
          missionId,
          planningIssueId: collected.planningIssueId,
        });
        return { status: "plan_qa_pending", planningIssueId: collected.planningIssueId, commentId: collected.commentId, decisionHash, planQaIssueId: activePlanQa.issueId, diagnostics: [] };
      }
      // (c) 같은 hash 인데 PLAN-QA 게이트 미생성(레거시 plan 진입) → 게이트 생성 후 대기
      const legacyPlanQaIssue = await ensurePlanQaReviewIssue({ db, companyId, missionId, missionTitle, planningIssueId: collected.planningIssueId, decisionHash, missionGoal: draftResult.draft.missionGoal, draft: draftResult.draft, enqueuePlanQaWakeup });
      await updatePlanQaRef({ db, companyId, missionId, missionPlanArtifactId: activePlan.id, patch: { issueId: legacyPlanQaIssue.id, status: "pending", decisionHash } });
      return { status: "plan_qa_pending", planningIssueId: collected.planningIssueId, commentId: collected.commentId, decisionHash, planQaIssueId: legacyPlanQaIssue.id, diagnostics: [] };
    }
    return { status: "noop", reason: "already_recorded", planningIssueId: collected.planningIssueId, commentId: collected.commentId, decisionHash, diagnostics: [] };
  }

  // ── 새 decision (decisionHash 불일치): revision 생성 + PLAN-QA 게이트 오픈. materialize/위임은 PASS 후 idempotent branch 로 지연 ──
  const planQaIssue = await ensurePlanQaReviewIssue({ db, companyId, missionId, missionTitle, planningIssueId: collected.planningIssueId, decisionHash, missionGoal: draftResult.draft.missionGoal, draft: draftResult.draft, enqueuePlanQaWakeup });
  const refs = mergeMissionPlanRefs(activePlan?.refs, {
    ...draftResult.draft.refs,
    ownerPlanDecision: { ...draftResult.draft.refs.ownerPlanDecision, decisionHash },
    planQa: { issueId: planQaIssue.id, status: "pending", decisionHash },
  });
  // 새 decision 는 이전 decision 의 materialization 결과(paqoWorkflow/crossCompanyDelegations)를 계승하지 않는다.
  // PASS 시 idempotent branch 에서 새 decision 기준으로 materialize 한다.
  delete (refs as Record<string, unknown>).paqoWorkflow;
  delete (refs as Record<string, unknown>).crossCompanyDelegations;
  const missionPlanArtifact = await service.createMissionPlanRevision({
    companyId,
    missionId,
    ...(draftResult.draft.missionGoal ? { missionGoal: draftResult.draft.missionGoal } : {}),
    refs,
    requiredInputs: draftResult.draft.requiredInputs,
    successCriteria: draftResult.draft.successCriteria,
    steps: draftResult.draft.steps,
  });
  // 주의: pending 중 ensureCrossCompanyDelegationsForMissionOwnerPlan / ensurePaqoWorkflowForMissionOwnerPlan 호출 금지 — PASS 시 idempotent branch 에서 실행.
  await logActivity(db, {
    companyId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    action: "mission.owner_plan.plan_qa_pending",
    entityType: "mission",
    entityId: missionId,
    agentId: actor.actorType === "agent" ? actor.actorId : null,
    details: {
      missionPlanArtifactId: missionPlanArtifact.id,
      revision: missionPlanArtifact.revision,
      planningIssueId: collected.planningIssueId,
      commentId: collected.commentId,
      decisionMakerKind: collected.author.kind,
      decisionMakerId: collected.author.id,
      decisionHash,
      planQaIssueId: planQaIssue.id,
      idempotencyKey: `${collected.commentId}:${decisionHash}`,
    },
  });

  return { status: "plan_qa_pending", planningIssueId: collected.planningIssueId, commentId: collected.commentId, decisionHash, planQaIssueId: planQaIssue.id, diagnostics: [] };
}

async function validateSelectedExecutionUnitSourceRefs({
  db,
  companyId,
  selectedExecutionUnits,
}: {
  db: Pick<Db, "select">;
  companyId: string;
  selectedExecutionUnits: Record<string, unknown>[];
}): Promise<RecordLatestAuthorizedMissionOwnerPlanDecisionDiagnostic[]> {
  const diagnostics: RecordLatestAuthorizedMissionOwnerPlanDecisionDiagnostic[] = [];
  const nativeWorkflowDefinitionIds = new Set<string>();
  const issueSourceIds = new Set<string>();
  const assigneeAgentIds = new Set<string>();
  const crossCompanyTargets: Array<{ index: number; targetCompanyId: string; targetOwnerAgentId: string }> = [];
  const pluginEntityIdsByType = new Map<string, Set<string>>();

  for (const [index, unit] of selectedExecutionUnits.entries()) {
    const sourceRef = isPlainObject(unit.sourceRef) ? unit.sourceRef : null;
    const sourceType = typeof sourceRef?.type === "string" ? sourceRef.type.trim() : "";
    const sourceId =
      typeof sourceRef?.id === "string"
        ? sourceRef.id.trim()
        : typeof sourceRef?.issueId === "string"
          ? sourceRef.issueId.trim()
          : "";
    if (!sourceType || !sourceId) {
      diagnostics.push({
        code: "missing_source_ref",
        message: `selectedExecutionUnits[${index}] must include sourceRef.type and sourceRef.id or sourceRef.issueId`,
      });
      continue;
    }

    if (CROSS_COMPANY_MISSION_SOURCE_TYPES.has(sourceType) || isCrossCompanyMissionUnit(unit)) {
      const targetCompanyId = readCrossCompanyTargetCompanyId(unit);
      const targetOwnerAgentId = readCrossCompanyTargetOwnerAgentId(unit);
      if (!targetCompanyId) {
        diagnostics.push({
          code: "missing_target_company_id",
          message: `selectedExecutionUnits[${index}] with sourceRef.type ${sourceType} must include targetCompanyId`,
        });
      }
      if (!targetOwnerAgentId) {
        diagnostics.push({
          code: "missing_target_owner_agent_id",
          message: `selectedExecutionUnits[${index}] with sourceRef.type ${sourceType} must include targetOwnerAgentId`,
        });
      }
      if (targetCompanyId === companyId) {
        diagnostics.push({
          code: "target_company_must_differ",
          message: `selectedExecutionUnits[${index}] cross-company targetCompanyId must differ from source company ${companyId}`,
        });
      }
      if (targetCompanyId && targetOwnerAgentId && targetCompanyId !== companyId) {
        crossCompanyTargets.push({ index, targetCompanyId, targetOwnerAgentId });
      }
      continue;
    }

    if (NATIVE_WORKFLOW_DEFINITION_SOURCE_TYPES.has(sourceType)) {
      nativeWorkflowDefinitionIds.add(sourceId);
      continue;
    }

    if (MISSION_PLAN_UNIT_SOURCE_TYPES.has(sourceType)) {
      const assigneeAgentId =
        typeof unit.assigneeAgentId === "string"
          ? unit.assigneeAgentId.trim()
          : typeof unit.agentId === "string"
            ? unit.agentId.trim()
            : "";
      if (assigneeAgentId) {
        assigneeAgentIds.add(assigneeAgentId);
      } else {
        diagnostics.push({
          code: "missing_assignee_agent_id",
          message: `selectedExecutionUnits[${index}] with sourceRef.type ${sourceType} must include assigneeAgentId from the company roster`,
        });
      }
      continue;
    }

    if (sourceType === "issue") {
      issueSourceIds.add(sourceId);
      continue;
    }

    const pluginEntityTypes = PLUGIN_WORKFLOW_ENTITY_SOURCE_TYPES.get(sourceType);
    if (pluginEntityTypes) {
      for (const entityType of pluginEntityTypes) {
        const ids = pluginEntityIdsByType.get(entityType) ?? new Set<string>();
        ids.add(sourceId);
        pluginEntityIdsByType.set(entityType, ids);
      }
      continue;
    }

    diagnostics.push({
      code: "unsupported_source_ref_type",
      message: `selectedExecutionUnits[${index}] has unsupported sourceRef.type ${sourceType}`,
    });
  }

  if (diagnostics.length > 0) return diagnostics;

  if (crossCompanyTargets.length > 0) {
    const targetCompanyIds = Array.from(new Set(crossCompanyTargets.map((target) => target.targetCompanyId)));
    const targetOwnerAgentIds = Array.from(new Set(crossCompanyTargets.map((target) => target.targetOwnerAgentId)));
    const companyRows = await db
      .select({ id: companies.id })
      .from(companies)
      .where(inArray(companies.id, targetCompanyIds));
    const foundCompanyIds = new Set(companyRows.map((row) => row.id));
    const agentRows = await db
      .select({ id: agents.id, companyId: agents.companyId, status: agents.status })
      .from(agents)
      .where(inArray(agents.id, targetOwnerAgentIds));
    const agentById = new Map(agentRows.map((row) => [row.id, row]));

    for (const target of crossCompanyTargets) {
      if (!foundCompanyIds.has(target.targetCompanyId)) {
        diagnostics.push({
          code: "target_company_not_found",
          message: `selectedExecutionUnits[${target.index}] targetCompanyId ${target.targetCompanyId} was not found`,
        });
      }
      const targetOwner = agentById.get(target.targetOwnerAgentId);
      if (!targetOwner || targetOwner.companyId !== target.targetCompanyId) {
        diagnostics.push({
          code: "target_owner_agent_not_found",
          message: `selectedExecutionUnits[${target.index}] targetOwnerAgentId ${target.targetOwnerAgentId} was not found in target company ${target.targetCompanyId}`,
        });
        continue;
      }
      if (!RUNNABLE_PLAN_ASSIGNEE_STATUSES.has(targetOwner.status)) {
        diagnostics.push({
          code: "target_owner_agent_not_runnable",
          message: `selectedExecutionUnits[${target.index}] targetOwnerAgentId ${target.targetOwnerAgentId} is not runnable (status=${targetOwner.status || "unknown"}); choose an active or idle target company agent`,
        });
      }
    }
  }

  if (assigneeAgentIds.size > 0) {
    const ids = Array.from(assigneeAgentIds);
    const rows = await db
      .select({ id: agents.id, status: agents.status })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), inArray(agents.id, ids)));
    const found = new Set(rows.map((row) => row.id));
    const rowById = new Map(rows.map((row) => [row.id, row]));
    for (const id of ids) {
      if (!found.has(id)) {
        diagnostics.push({
          code: "assignee_agent_not_found",
          message: `selectedExecutionUnits assigneeAgentId ${id} was not found in company ${companyId}`,
        });
        continue;
      }
      const status = rowById.get(id)?.status ?? "";
      if (!RUNNABLE_PLAN_ASSIGNEE_STATUSES.has(status)) {
        diagnostics.push({
          code: "assignee_agent_not_runnable",
          message: `selectedExecutionUnits assigneeAgentId ${id} is not runnable (status=${status || "unknown"}); choose an active or idle company agent`,
        });
      }
    }
  }

  if (diagnostics.length > 0) return diagnostics;

  if (nativeWorkflowDefinitionIds.size > 0) {
    const ids = Array.from(nativeWorkflowDefinitionIds);
    const rows = await db
      .select({ id: workflowDefinitions.id })
      .from(workflowDefinitions)
      .where(and(eq(workflowDefinitions.companyId, companyId), inArray(workflowDefinitions.id, ids)));
    const found = new Set(rows.map((row) => row.id));
    for (const id of ids) {
      if (!found.has(id)) {
        diagnostics.push({
          code: "workflow_definition_not_found",
          message: `Workflow definition ${id} was not found in company ${companyId}`,
        });
      }
    }
  }

  if (issueSourceIds.size > 0) {
    const ids = Array.from(issueSourceIds);
    const rows = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), inArray(issues.id, ids)));
    const found = new Set(rows.map((row) => row.id));
    for (const id of ids) {
      if (!found.has(id)) {
        diagnostics.push({
          code: "issue_source_ref_not_found",
          message: `Issue source ref ${id} was not found in company ${companyId}`,
        });
      }
    }
  }

  for (const [entityType, idsSet] of pluginEntityIdsByType) {
    const ids = Array.from(idsSet);
    const rows = await db
      .select({ id: pluginEntities.id })
      .from(pluginEntities)
      .where(
        and(
          eq(pluginEntities.entityType, entityType),
          eq(pluginEntities.scopeKind, "company"),
          eq(pluginEntities.scopeId, companyId),
          inArray(pluginEntities.id, ids),
        ),
      );
    const found = new Set(rows.map((row) => row.id));
    for (const id of ids) {
      if (!found.has(id)) {
        diagnostics.push({
          code: "plugin_entity_not_found",
          message: `Plugin entity ${id} (${entityType}) was not found in company ${companyId}`,
        });
      }
    }
  }

  return diagnostics;
}

function toNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function readOptionalBooleanMarker(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  return null;
}

function isCrossCompanyMissionUnit(unit: Record<string, unknown>): boolean {
  const sourceRef = isPlainObject(unit.sourceRef) ? unit.sourceRef : null;
  const sourceType = toNonEmptyString(sourceRef?.type)?.toLowerCase() ?? "";
  const kind = toNonEmptyString(unit.kind)?.toLowerCase() ?? "";
  return CROSS_COMPANY_MISSION_SOURCE_TYPES.has(sourceType) || CROSS_COMPANY_MISSION_SOURCE_TYPES.has(kind);
}

function localSelectedExecutionUnits(units: Record<string, unknown>[]): Record<string, unknown>[] {
  return units.filter((unit) => !isCrossCompanyMissionUnit(unit));
}

function draftWithSelectedExecutionUnits(draft: PlanRevisionDraft, selectedExecutionUnits: Record<string, unknown>[]): PlanRevisionDraft {
  return {
    ...draft,
    refs: {
      ...draft.refs,
      selectedExecutionUnits,
    },
  };
}

function readCrossCompanyTargetCompanyId(unit: Record<string, unknown>): string | null {
  const sourceRef = isPlainObject(unit.sourceRef) ? unit.sourceRef : null;
  return (
    toNonEmptyString(unit.targetCompanyId) ??
    toNonEmptyString(unit.companyId) ??
    toNonEmptyString(unit.remoteCompanyId) ??
    toNonEmptyString(sourceRef?.targetCompanyId) ??
    toNonEmptyString(sourceRef?.companyId) ??
    toNonEmptyString(sourceRef?.remoteCompanyId)
  );
}

function readCrossCompanyTargetOwnerAgentId(unit: Record<string, unknown>): string | null {
  const sourceRef = isPlainObject(unit.sourceRef) ? unit.sourceRef : null;
  return (
    toNonEmptyString(unit.targetOwnerAgentId) ??
    toNonEmptyString(unit.targetAgentId) ??
    toNonEmptyString(unit.ownerAgentId) ??
    toNonEmptyString(unit.agentId) ??
    toNonEmptyString(sourceRef?.targetOwnerAgentId) ??
    toNonEmptyString(sourceRef?.targetAgentId) ??
    toNonEmptyString(sourceRef?.ownerAgentId) ??
    toNonEmptyString(sourceRef?.agentId)
  );
}

function formatCrossCompanyDelegationTitle(unit: Record<string, unknown>, index: number): string {
  return (
    toNonEmptyString(unit.title) ??
    toNonEmptyString(unit.name) ??
    toNonEmptyString(unit.id) ??
    `Delegated mission ${index + 1}`
  );
}

function formatCrossCompanyDelegationDescription(unit: Record<string, unknown>, mission: typeof missions.$inferSelect): string {
  const sourceRef = isPlainObject(unit.sourceRef) ? unit.sourceRef : null;
  return [
    toNonEmptyString(unit.description),
    toNonEmptyString(unit.brief),
    toNonEmptyString(unit.reason) ? `Reason: ${toNonEmptyString(unit.reason)}` : null,
    "",
    `Source mission: ${mission.title}`,
    `Source mission id: ${mission.id}`,
    sourceRef ? `Source ref: ${JSON.stringify(sourceRef)}` : null,
  ].filter((line): line is string => line !== null).join("\n");
}

function crossCompanyDelegationExternalKey(input: {
  missionId: string;
  decisionHash: string;
  unit: Record<string, unknown>;
  index: number;
}): string {
  const sourceRef = isPlainObject(input.unit.sourceRef) ? input.unit.sourceRef : null;
  const unitKey =
    toNonEmptyString(input.unit.id) ??
    toNonEmptyString(input.unit.unitId) ??
    toNonEmptyString(input.unit.stepId) ??
    toNonEmptyString(sourceRef?.id) ??
    toNonEmptyString(sourceRef?.issueId) ??
    toNonEmptyString(sourceRef?.stepId) ??
    `index:${input.index}`;
  return `owner-plan:${input.missionId}:${input.decisionHash}:${unitKey}`;
}

function stripIssueGroupPrefix(title: string): string {
  return title.replace(/^\s*\[(?:plan|action|qa|oversight)\]\s*/iu, "").trim();
}

type PaqoIssueGroup = "action" | "qa" | "oversight";

function readIssueGroupPrefix(title: string): PaqoIssueGroup | null {
  const match = /^\s*\[(action|qa|oversight)\]/iu.exec(title);
  return match ? match[1]!.toLowerCase() as PaqoIssueGroup : null;
}

function inferPaqoIssueGroup(unit: Record<string, unknown>, title: string): PaqoIssueGroup {
  const prefixed = readIssueGroupPrefix(title);
  if (prefixed) return prefixed;

  const kind = toNonEmptyString(unit.kind)?.toLowerCase() ?? "";
  if (/\b(?:qa|quality|validation|validator|verify|verification)\b/u.test(kind)) return "qa";
  if (/\b(?:oversight|supervision|unblock|escalation)\b/u.test(kind)) return "oversight";
  return "action";
}

function readPaqoGraphWorkProductRequired(unit: Record<string, unknown>, group: PaqoIssueGroup): boolean {
  return readOptionalBooleanMarker(unit.graphWorkProductRequired)
    ?? readOptionalBooleanMarker(unit.workProductRequired)
    ?? readOptionalBooleanMarker(unit.requiresWorkProduct)
    ?? (group === "action");
}

function shortStableHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 10);
}

function formatPaqoWorkflowName(draft: PlanRevisionDraft, mission: typeof missions.$inferSelect): string {
  const goal = toNonEmptyString(draft.missionGoal) ?? toNonEmptyString(mission.title) ?? mission.id;
  return `PAQO WBS: ${goal}`;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => toNonEmptyString(entry)).filter((entry): entry is string => Boolean(entry));
}

function selectedUnitRefIds(unit: Record<string, unknown>): string[] {
  const ids = [
    toNonEmptyString(unit.id),
    toNonEmptyString(unit.unitId),
    toNonEmptyString(unit.stepId),
  ];
  const sourceRef = isPlainObject(unit.sourceRef) ? unit.sourceRef : null;
  ids.push(
    toNonEmptyString(sourceRef?.id),
    toNonEmptyString(sourceRef?.issueId),
    toNonEmptyString(sourceRef?.stepId),
  );
  return Array.from(new Set(ids.filter((id): id is string => Boolean(id))));
}

function buildUnitStepIdMap(
  selectedUnits: Record<string, unknown>[],
  steps: WorkflowStep[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const [index, unit] of selectedUnits.entries()) {
    for (const id of selectedUnitRefIds(unit)) {
      map.set(id, steps[index]!.id);
    }
  }
  return map;
}

function planStepDependenciesByUnitId(draftSteps: (string | Record<string, unknown>)[]): Map<string, string[]> {
  const dependenciesByUnitId = new Map<string, string[]>();
  for (const step of draftSteps) {
    if (!isPlainObject(step)) continue;

    const unitIds = readStringArray(step.units).length > 0
      ? readStringArray(step.units)
      : [
          toNonEmptyString(step.unitId),
          toNonEmptyString(step.executionUnitId),
          toNonEmptyString(step.selectedExecutionUnitId),
          toNonEmptyString(step.id),
        ].filter((id): id is string => Boolean(id));
    if (unitIds.length === 0) continue;

    const dependencies = Array.from(new Set([
      ...readStringArray(step.dependencies),
      ...readStringArray(step.dependsOn),
      ...readStringArray(step.after),
    ]));

    for (const unitId of unitIds) {
      dependenciesByUnitId.set(unitId, dependencies);
    }
  }
  return dependenciesByUnitId;
}

function selectedUnitDependenciesByUnitId(selectedUnits: Record<string, unknown>[]): Map<string, string[]> {
  const dependenciesByUnitId = new Map<string, string[]>();
  for (const unit of selectedUnits) {
    const dependencies = Array.from(new Set([
      ...readStringArray(unit.dependencies),
      ...readStringArray(unit.dependsOn),
      ...readStringArray(unit.after),
    ]));
    if (dependencies.length === 0) continue;

    for (const unitId of selectedUnitRefIds(unit)) {
      dependenciesByUnitId.set(unitId, dependencies);
    }
  }
  return dependenciesByUnitId;
}

function mergeDependencyMaps(...maps: Map<string, string[]>[]): Map<string, string[]> {
  const merged = new Map<string, string[]>();
  for (const map of maps) {
    for (const [unitId, dependencies] of map) {
      merged.set(unitId, Array.from(new Set([...(merged.get(unitId) ?? []), ...dependencies])));
    }
  }
  return merged;
}

function applyPlanStepDependencies(
  selectedUnits: Record<string, unknown>[],
  steps: WorkflowStep[],
  draftSteps: (string | Record<string, unknown>)[],
): WorkflowStep[] {
  const dependenciesByUnitId = mergeDependencyMaps(
    selectedUnitDependenciesByUnitId(selectedUnits),
    planStepDependenciesByUnitId(draftSteps),
  );
  if (dependenciesByUnitId.size === 0) return steps;

  const unitIdToStepId = buildUnitStepIdMap(selectedUnits, steps);
  return steps.map((step, index) => {
    const unit = selectedUnits[index]!;
    const unitDependencies = selectedUnitRefIds(unit).flatMap((unitId) => dependenciesByUnitId.get(unitId) ?? []);
    const dependencies = Array.from(new Set(unitDependencies.flatMap((unitId) => {
      const stepId = unitIdToStepId.get(unitId);
      return stepId && stepId !== step.id ? [stepId] : [];
    })));

    return dependencies.length > 0 ? { ...step, dependencies } : step;
  });
}

function buildPaqoWorkflowSteps(draft: PlanRevisionDraft, mission: typeof missions.$inferSelect): WorkflowStep[] {
  const selectedUnits = draft.refs.selectedExecutionUnits;
  const executableUnits = selectedUnits.filter((unit, index) => {
    const rawTitle =
      toNonEmptyString(unit.title)
        ?? toNonEmptyString(unit.name)
        ?? toNonEmptyString(unit.id)
        ?? `Execution unit ${index + 1}`;
    return inferPaqoIssueGroup(unit, rawTitle) !== "oversight";
  });
  const selectedSteps = executableUnits.map((unit, index) => {
    const sourceRef = isPlainObject(unit.sourceRef) ? unit.sourceRef : null;
    const assigneeAgentId =
      toNonEmptyString(unit.assigneeAgentId) ??
      toNonEmptyString(unit.agentId) ??
      mission.ownerAgentId;
    const rawTitle =
      toNonEmptyString(unit.title)
        ?? toNonEmptyString(unit.name)
        ?? toNonEmptyString(unit.id)
        ?? `Execution unit ${index + 1}`;
    const group = inferPaqoIssueGroup(unit, rawTitle);
    const title = stripIssueGroupPrefix(rawTitle);
    const groupLabel = group.toUpperCase();
    const graphWorkProductRequired = readPaqoGraphWorkProductRequired(unit, group);
    return {
      id: `${group}-${index + 1}-${shortStableHash({ missionId: mission.id, index, sourceRef, title, group })}`,
      name: `[${groupLabel}] ${title}`,
      agentId: assigneeAgentId,
      dependencies: [],
      graphWorkProductRequired,
      description: [
        `Mission-level PAQO ${groupLabel} issue materialized from an authorized PLAN decision.`,
        "",
        `Mission: ${mission.title}`,
        `Assigned by PLAN decision to agentId: ${assigneeAgentId}`,
        toNonEmptyString(unit.reason) ? `Reason: ${toNonEmptyString(unit.reason)}` : null,
        sourceRef ? `Source ref: ${JSON.stringify(sourceRef)}` : null,
      ].filter(Boolean).join("\n"),
    } satisfies WorkflowStep;
  });
  const plannedSteps = applyPlanStepDependencies(executableUnits, selectedSteps, draft.steps);
  if (plannedSteps.length === 0) return [];

  const qaStep: WorkflowStep = {
    id: `qa-${shortStableHash({ missionId: mission.id, actions: plannedSteps.map((step) => step.id), goal: draft.missionGoal })}`,
    name: "[QA] Verify mission result",
    agentId: mission.ownerAgentId,
    dependencies: plannedSteps.map((step) => step.id),
    graphWorkProductRequired: false,
    description: [
      "Mission-level PAQO QA issue. Run independent verification after all ACTION workflow steps complete successfully.",
      "",
      draft.successCriteria.length > 0 ? `Success criteria: ${JSON.stringify(draft.successCriteria)}` : null,
      draft.steps.length > 0 ? `Planned steps: ${JSON.stringify(draft.steps)}` : null,
    ].filter(Boolean).join("\n"),
  };

  // [P5 control-flow loop] 미션 QA step 이 산출물 생산자(producer) 로 보내는 bounded rework back-edge 자동 합성.
  //   QA 가 request_changes 하면 P4 loop-driver 가 producer 를 rework 한다(maxIterations cap). producer 식별은
  //   resolveProducerStepIdFromDag 에 위임(synthesizeQaReworkBackEdge 내부). forward dependencies[] 는 불변.
  //   합성 대상은 이 미션 최종 QA(qaStep) 단 하나 — 중간 단계 QA 회복은 runtime supervision 담당.
  return synthesizeQaReworkBackEdge([...plannedSteps, qaStep], qaStep.id);
}

async function ensureCrossCompanyDelegationsForMissionOwnerPlan(input: {
  db: Db;
  companyId: string;
  missionId: string;
  draft: PlanRevisionDraft;
  missionPlanArtifactId: string;
  decisionHash: string;
}): Promise<void> {
  const crossCompanyUnits = input.draft.refs.selectedExecutionUnits
    .map((unit, index) => ({ unit, index }))
    .filter(({ unit }) => isCrossCompanyMissionUnit(unit));
  if (crossCompanyUnits.length === 0) return;

  const mission = await input.db
    .select()
    .from(missions)
    .where(and(eq(missions.companyId, input.companyId), eq(missions.id, input.missionId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!mission) return;

  const materializedDelegations: Record<string, unknown>[] = [];
  for (const { unit, index } of crossCompanyUnits) {
    const targetCompanyId = readCrossCompanyTargetCompanyId(unit);
    const targetOwnerAgentId = readCrossCompanyTargetOwnerAgentId(unit);
    if (!targetCompanyId || !targetOwnerAgentId) continue;

    const title = formatCrossCompanyDelegationTitle(unit, index);
    const { delegation } = await missionDelegationService(input.db).create({
      sourceMissionId: input.missionId,
      externalKey: crossCompanyDelegationExternalKey({
        missionId: input.missionId,
        decisionHash: input.decisionHash,
        unit,
        index,
      }),
      targetCompanyId,
      targetOwnerAgentId,
      title,
      sourceIssueTitle: `[DELEGATED] ${title}`,
      description: formatCrossCompanyDelegationDescription(unit, mission),
      priority: toNonEmptyString(unit.priority) ?? "medium",
      metadata: {
        source: "mission_owner_plan_decision",
        missionPlanArtifactId: input.missionPlanArtifactId,
        decisionHash: input.decisionHash,
        selectedExecutionUnitIndex: index,
        selectedExecutionUnit: unit,
      },
    });
    materializedDelegations.push({
      delegationId: delegation.id,
      externalKey: delegation.externalKey,
      sourceIssueId: delegation.sourceIssueId,
      targetCompanyId: delegation.targetCompanyId,
      targetMissionId: delegation.targetMissionId,
      status: delegation.status,
      decisionHash: input.decisionHash,
      selectedExecutionUnitIndex: index,
    });
  }

  if (materializedDelegations.length === 0) return;
  const service = missionPlanArtifactService(input.db);
  const activePlan = await service.getActiveMissionPlan({ companyId: input.companyId, missionId: input.missionId });
  if (activePlan?.id !== input.missionPlanArtifactId) return;
  const refs = mergeMissionPlanRefs(activePlan.refs, {
    crossCompanyDelegations: materializedDelegations,
  });
  await input.db
    .update(missionPlanArtifacts)
    .set({ refs, updatedAt: new Date() })
    .where(eq(missionPlanArtifacts.id, activePlan.id));
}

function workflowStepsAreEqual(left: WorkflowStep[], right: WorkflowStep[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function ensurePaqoWorkflowForMissionOwnerPlan(input: {
  db: Db;
  companyId: string;
  missionId: string;
  draft: PlanRevisionDraft;
  missionPlanArtifactId: string;
  decisionHash: string;
  triggeredBy: string;
}): Promise<void> {
  const selectedExecutionUnits = localSelectedExecutionUnits(input.draft.refs.selectedExecutionUnits);
  if (selectedExecutionUnits.length === 0) return;

  const mission = await input.db
    .select()
    .from(missions)
    .where(and(eq(missions.companyId, input.companyId), eq(missions.id, input.missionId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!mission) return;

  const localDraft = draftWithSelectedExecutionUnits(input.draft, selectedExecutionUnits);
  const workflowName = formatPaqoWorkflowName(localDraft, mission);
  const steps = buildPaqoWorkflowSteps(localDraft, mission);
  if (steps.length === 0) return;
  const [existingDefinition] = await input.db
    .select()
    .from(workflowDefinitions)
    .where(and(eq(workflowDefinitions.companyId, input.companyId), eq(workflowDefinitions.name, workflowName)))
    .limit(1);
  const definition = existingDefinition
    ? workflowStepsAreEqual(existingDefinition.stepsJson as WorkflowStep[], steps)
      ? existingDefinition
      : await workflowService.updateDefinition(input.db, existingDefinition.id, { steps })
    : await workflowService.createDefinition(input.db, {
      companyId: input.companyId,
      name: workflowName,
      steps,
    });
  if (!definition) return;

  const [existingRun] = await input.db
    .select()
    .from(workflowRuns)
    .where(and(eq(workflowRuns.companyId, input.companyId), eq(workflowRuns.workflowId, definition.id), eq(workflowRuns.missionId, input.missionId)))
    .limit(1);
  const workflowRunId = existingRun?.id ?? (await (async () => {
    const run = await createWorkflowRun(input.db, {
      companyId: input.companyId,
      workflowId: definition.id,
      missionId: input.missionId,
      triggeredBy: input.triggeredBy,
    });
    await executeWorkflowRun(input.db, run.id);
    return run.id;
  })());

  const service = missionPlanArtifactService(input.db);
  const activePlan = await service.getActiveMissionPlan({ companyId: input.companyId, missionId: input.missionId });
  if (activePlan?.id !== input.missionPlanArtifactId) return;
  const refs = mergeMissionPlanRefs(activePlan.refs, {
    paqoWorkflow: {
      workflowDefinitionId: definition.id,
      workflowRunId,
      workflowName,
      stepIds: steps.map((step) => step.id),
      decisionHash: input.decisionHash,
      dependencyModel: "workflow_dag_intra_mission",
    },
  });
  await input.db
    .update(missionPlanArtifacts)
    .set({ refs, updatedAt: new Date() })
    .where(eq(missionPlanArtifacts.id, activePlan.id));
}

// ---------------------------------------------------------------------------
// Plan-QA gate helpers — [PLAN-QA] review issue 가 PASS verdict 를 낼 때까지
//   PAQO workflow materialization 을 지연시킨다. originKind=mission_plan_qa,
//   originId=plan-qa:{missionId}:{decisionHash} 로 query-before-create idempotency.
// [수정시 영향] verdict 는 같은 decisionHash issue 에서만 읽는다(stale PASS 차단).
// ---------------------------------------------------------------------------
type PlanQaStatus = "pending" | "pass" | "request_changes";

interface PlanQaRef {
  issueId: string;
  status: PlanQaStatus;
  verdict?: ValidationVerdict;
  decisionHash: string;
  reviewedAt?: string;
}

function readPlanQaRef(refs: unknown): PlanQaRef | null {
  if (!isPlainObject(refs) || !isPlainObject((refs as Record<string, unknown>).planQa)) return null;
  const planQa = (refs as Record<string, unknown>).planQa as Record<string, unknown>;
  const issueId = typeof planQa.issueId === "string" ? planQa.issueId : null;
  const decisionHash = typeof planQa.decisionHash === "string" ? planQa.decisionHash : null;
  if (!issueId || !decisionHash) return null;
  const status: PlanQaStatus = planQa.status === "pass" || planQa.status === "request_changes" ? planQa.status : "pending";
  const verdict: ValidationVerdict | undefined = planQa.verdict === "pass" || planQa.verdict === "request_changes" ? planQa.verdict : undefined;
  const reviewedAt = typeof planQa.reviewedAt === "string" ? planQa.reviewedAt : undefined;
  return { issueId, status, verdict, decisionHash, reviewedAt };
}

function buildPlanQaReviewDescription(input: { missionGoal?: string | null; draft: PlanRevisionDraft }): string {
  const lines: string[] = [
    "Plan QA review gate. The mission owner plan decision is on hold until this review passes.",
    "Verify the plan against the mission goal before releasing it for materialization.",
    "",
  ];
  if (input.missionGoal) lines.push(`Mission goal: ${input.missionGoal}`, "");
  lines.push(
    "Checklist (judge against the mission goal):",
    "- Are the mission goal's core verbs reflected in concrete steps?",
    "- Does the plan need a URL / input normalization step? Is it present?",
    "- Are parallel vs sequential dependencies appropriate (no over- or under-serialization)?",
    "- Are content QA and publish smoke QA separated into distinct steps (not collapsed into one)?",
    "- Is each step's assignee appropriate by role / capability / skill?",
    "- Does each ACTION step have a clear work-product contract?",
    "- Is QA not collapsed into a single terminal step?",
    "",
    "Verdict output format (required):",
    "Finish your run output with exactly one standalone final line:",
    "`PASS` (the plan is sound and may materialize) or `REQUEST_CHANGES: <specific gaps>` (the plan must be revised).",
    "Do not include any prose after that final line.",
  );
  return lines.join("\n");
}

async function loadMissionRow(db: Db, companyId: string, missionId: string) {
  const [row] = await db
    .select({ id: missions.id, title: missions.title })
    .from(missions)
    .where(and(eq(missions.companyId, companyId), eq(missions.id, missionId)))
    .limit(1);
  return row ?? null;
}

async function findMissionQaAssignee(db: Db, companyId: string): Promise<string | null> {
  const [candidate] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(
      eq(agents.companyId, companyId),
      inArray(agents.role, Array.from(PLAN_QA_VERDICT_AGENT_ROLES)),
      inArray(agents.status, Array.from(RUNNABLE_PLAN_ASSIGNEE_STATUSES)),
    ))
    .orderBy(sql`case ${agents.status} when 'idle' then 0 when 'active' then 1 when 'running' then 2 else 3 end`, agents.createdAt)
    .limit(1);
  return candidate?.id ?? null;
}

async function ensurePlanQaReviewIssue(input: {
  db: Db;
  companyId: string;
  missionId: string;
  missionTitle: string;
  planningIssueId: string | null;
  decisionHash: string;
  missionGoal?: string | null;
  draft: PlanRevisionDraft;
  enqueuePlanQaWakeup?: PlanQaWakeupHandler;
}): Promise<{ id: string }> {
  const originId = `plan-qa:${input.missionId}:${input.decisionHash}`;
  const existing = await input.db
    .select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId, status: issues.status })
    .from(issues)
    .where(and(
      eq(issues.companyId, input.companyId),
      eq(issues.originKind, "mission_plan_qa"),
      eq(issues.originId, originId),
      isNull(issues.hiddenAt),
    ))
    .limit(1);
  if (existing[0]) {
    const assigneeAgentId = existing[0].assigneeAgentId ?? (isPlanQaActionableStatus(existing[0].status)
      ? await assignPlanQaReviewerIfAvailable({
        db: input.db,
        companyId: input.companyId,
        planQaIssueId: existing[0].id,
      })
      : null);
    await ensurePlanQaWakeup({
      enqueuePlanQaWakeup: input.enqueuePlanQaWakeup,
      agentId: assigneeAgentId,
      companyId: input.companyId,
      issueId: existing[0].id,
      issueStatus: existing[0].status,
      missionId: input.missionId,
      planningIssueId: input.planningIssueId,
    });
    return { id: existing[0].id };
  }
  const assigneeAgentId = await findMissionQaAssignee(input.db, input.companyId);
  const description = buildPlanQaReviewDescription({ missionGoal: input.missionGoal, draft: input.draft });
  // reviewer 가 없어도 issue 는 만들고 materialize 는 금지. 할당 누락을 description 에 명시.
  const fullDescription = assigneeAgentId
    ? description
    : `${description}\n\nQA reviewer assignment required (no qa/reviewer/validator agent on this mission yet).`;
  const created = await issueService(input.db).create(input.companyId, {
    missionId: input.missionId,
    originKind: "mission_plan_qa",
    originId,
    title: `[PLAN-QA] ${input.missionTitle}`,
    description: fullDescription,
    status: "todo",
    priority: "high",
    ...(assigneeAgentId ? { assigneeAgentId } : {}),
  });
  await ensurePlanQaWakeup({
    enqueuePlanQaWakeup: input.enqueuePlanQaWakeup,
    agentId: created.assigneeAgentId,
    companyId: input.companyId,
    issueId: created.id,
    issueStatus: created.status,
    missionId: input.missionId,
    planningIssueId: input.planningIssueId,
  });
  return { id: created.id };
}

async function assignPlanQaReviewerIfAvailable(input: {
  db: Db;
  companyId: string;
  planQaIssueId: string;
}): Promise<string | null> {
  const assigneeAgentId = await findMissionQaAssignee(input.db, input.companyId);
  if (!assigneeAgentId) return null;
  await input.db
    .update(issues)
    .set({ assigneeAgentId, updatedAt: new Date() })
    .where(and(
      eq(issues.companyId, input.companyId),
      eq(issues.id, input.planQaIssueId),
      eq(issues.originKind, "mission_plan_qa"),
      isNull(issues.assigneeAgentId),
      isNull(issues.hiddenAt),
    ));
  return assigneeAgentId;
}

// [AREA: Plan QA / Task 0] terminal/unactionable 상태의 PLAN-QA issue는 재처리 시
// assignee 를 붙이지 않고 wakeup 도 만들지 않는다(이미 끝난 검토를 다시 살리지 않음).
function isPlanQaActionableStatus(status: string): boolean {
  return status !== "backlog" && status !== "blocked" && status !== "done" && status !== "cancelled";
}

async function ensurePlanQaWakeup(input: {
  enqueuePlanQaWakeup?: PlanQaWakeupHandler;
  companyId: string;
  agentId: string | null;
  issueId: string;
  issueStatus: string;
  missionId: string;
  planningIssueId: string | null;
}): Promise<void> {
  if (!input.enqueuePlanQaWakeup) return;
  if (!input.agentId) return;
  if (!isPlanQaActionableStatus(input.issueStatus)) return;

  await input.enqueuePlanQaWakeup({
    companyId: input.companyId,
    agentId: input.agentId,
    issueId: input.issueId,
    issueStatus: input.issueStatus,
    missionId: input.missionId,
    planningIssueId: input.planningIssueId,
  });
}

async function ensurePlanQaWakeupForIssue(input: {
  db: Db;
  enqueuePlanQaWakeup?: PlanQaWakeupHandler;
  companyId: string;
  planQaIssueId: string;
  missionId: string;
  planningIssueId: string | null;
}) {
  const [planQaIssue] = await input.db
    .select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId, status: issues.status })
    .from(issues)
    .where(and(
      eq(issues.companyId, input.companyId),
      eq(issues.id, input.planQaIssueId),
      eq(issues.originKind, "mission_plan_qa"),
      isNull(issues.hiddenAt),
    ))
    .limit(1);
  if (!planQaIssue) return;
  const assigneeAgentId = planQaIssue.assigneeAgentId ?? (isPlanQaActionableStatus(planQaIssue.status)
    ? await assignPlanQaReviewerIfAvailable({
      db: input.db,
      companyId: input.companyId,
      planQaIssueId: planQaIssue.id,
    })
    : null);

  await ensurePlanQaWakeup({
    enqueuePlanQaWakeup: input.enqueuePlanQaWakeup,
    companyId: input.companyId,
    agentId: assigneeAgentId,
    issueId: planQaIssue.id,
    issueStatus: planQaIssue.status,
    missionId: input.missionId,
    planningIssueId: input.planningIssueId,
  });
}

async function readPlanQaVerdict(input: { db: Db; companyId: string; planQaIssueId: string }): Promise<ValidationVerdict | null> {
  // [AREA: structured events / Task 4] structured-first: mission_plan_qa_verdicts 표에서 최신 verdict 읽기.
  // 없으면 comment-based fallback(기존 readExplicitValidationVerdict 경로 유지).
  const [structuredVerdict] = await input.db
    .select({ verdict: missionPlanQaVerdicts.verdict })
    .from(missionPlanQaVerdicts)
    .where(and(
      eq(missionPlanQaVerdicts.companyId, input.companyId),
      eq(missionPlanQaVerdicts.planQaIssueId, input.planQaIssueId),
    ))
    .orderBy(desc(missionPlanQaVerdicts.createdAt), desc(missionPlanQaVerdicts.id))
    .limit(1);
  if (structuredVerdict?.verdict === "pass" || structuredVerdict?.verdict === "request_changes") {
    return structuredVerdict.verdict as ValidationVerdict;
  }

  // fallback: comment-based read (기존 로직 유지 — legacy parser)
  const [planQaIssue] = await input.db
    .select({ assigneeAgentId: issues.assigneeAgentId })
    .from(issues)
    .where(and(
      eq(issues.companyId, input.companyId),
      eq(issues.id, input.planQaIssueId),
      eq(issues.originKind, "mission_plan_qa"),
      isNull(issues.hiddenAt),
    ))
    .limit(1);
  if (!planQaIssue) return null;

  const rows = await input.db
    .select({
      authorAgentId: issueComments.authorAgentId,
      authorUserId: issueComments.authorUserId,
      body: issueComments.body,
    })
    .from(issueComments)
    .where(and(eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.planQaIssueId)))
    .orderBy(desc(issueComments.createdAt), desc(issueComments.id));

  const verdictRows = rows
    .map((row) => ({ row, verdict: readExplicitValidationVerdict(row.body) }))
    .filter((entry): entry is { row: typeof rows[number]; verdict: ValidationVerdict } => entry.verdict !== null);
  const authorAgentIds = Array.from(new Set(verdictRows.map((entry) => entry.row.authorAgentId).filter((id): id is string => typeof id === "string" && id.length > 0)));
  const agentRows = authorAgentIds.length > 0
    ? await input.db
      .select({ id: agents.id, role: agents.role, status: agents.status })
      .from(agents)
      .where(and(eq(agents.companyId, input.companyId), inArray(agents.id, authorAgentIds)))
    : [];
  const agentById = new Map(agentRows.map((row) => [row.id, row]));

  for (const { row, verdict } of verdictRows) {
    if (typeof row.authorUserId === "string" && row.authorUserId.trim().length > 0) {
      return verdict;
    }

    const authorAgentId = row.authorAgentId;
    if (!authorAgentId) continue;
    if (planQaIssue.assigneeAgentId && authorAgentId === planQaIssue.assigneeAgentId) {
      return verdict;
    }

    const authorAgent = agentById.get(authorAgentId);
    if (
      authorAgent
      && PLAN_QA_VERDICT_AGENT_ROLES.has(authorAgent.role)
      && RUNNABLE_PLAN_ASSIGNEE_STATUSES.has(authorAgent.status)
    ) {
      return verdict;
    }
  }

  return null;
}

async function updatePlanQaRef(input: {
  db: Db;
  companyId: string;
  missionId: string;
  missionPlanArtifactId: string;
  patch: Partial<PlanQaRef>;
}): Promise<void> {
  const service = missionPlanArtifactService(input.db);
  const activePlan = await service.getActiveMissionPlan({ companyId: input.companyId, missionId: input.missionId });
  if (!activePlan || activePlan.id !== input.missionPlanArtifactId) return;
  const existing = readPlanQaRef(activePlan.refs);
  const merged: PlanQaRef = {
    issueId: input.patch.issueId ?? existing?.issueId ?? "",
    status: input.patch.status ?? existing?.status ?? "pending",
    verdict: input.patch.verdict ?? existing?.verdict,
    decisionHash: input.patch.decisionHash ?? existing?.decisionHash ?? "",
    reviewedAt: input.patch.reviewedAt ?? existing?.reviewedAt,
  };
  const refs = mergeMissionPlanRefs(activePlan.refs, { planQa: merged });
  await input.db
    .update(missionPlanArtifacts)
    .set({ refs, updatedAt: new Date() })
    .where(eq(missionPlanArtifacts.id, activePlan.id));
}

async function closePlanQaIssue(input: { db: Db; planQaIssueId: string }): Promise<void> {
  await input.db
    .update(issues)
    .set({ status: "done", updatedAt: new Date() })
    .where(and(eq(issues.id, input.planQaIssueId), eq(issues.originKind, "mission_plan_qa")));
}

async function reopenPlanningIssueIfTerminal(input: { db: Db; planningIssueId: string | null }): Promise<void> {
  if (!input.planningIssueId) return;
  const [row] = await input.db
    .select({ id: issues.id, status: issues.status })
    .from(issues)
    .where(eq(issues.id, input.planningIssueId))
    .limit(1);
  if (!row) return;
  if (row.status === "done" || row.status === "cancelled" || row.status === "completed") {
    await input.db
      .update(issues)
      .set({ status: "in_progress", updatedAt: new Date() })
      .where(eq(issues.id, row.id));
  }
}

function readOwnerPlanDecisionRef(refs: unknown): { commentId?: string; decisionHash?: string } | null {
  if (!isPlainObject(refs) || !isPlainObject(refs.ownerPlanDecision)) return null;
  return {
    commentId: typeof refs.ownerPlanDecision.commentId === "string" ? refs.ownerPlanDecision.commentId : undefined,
    decisionHash: typeof refs.ownerPlanDecision.decisionHash === "string" ? refs.ownerPlanDecision.decisionHash : undefined,
  };
}

function hashOwnerPlanDecision(decision: MissionOwnerPlanDecisionPayload): string {
  return createHash("sha256").update(stableStringify(decision)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}
