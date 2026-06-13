import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies, issueComments, issues, missionPlanArtifacts, missions, pluginEntities, workflowDefinitions, workflowRuns } from "@paperclipai/db";
import { logActivity } from "./activity-log.js";
import { mergeMissionPlanRefs, missionPlanArtifactService, type MissionPlanArtifact } from "./mission-plan-artifacts.js";
import { missionDelegationService } from "./mission-delegations.js";
import { workflowService } from "./workflow/engine.js";
import { executeWorkflowRun, type WorkflowStep } from "./workflow/dag-engine.js";
import { createWorkflowRun } from "./workflow/workflow-store.js";

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
const DECISION_HEADING_PATTERN = /^### Mission owner plan decision\s*$/gm;
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
      const blockStart = (match.index ?? 0) + DECISION_HEADING.length;
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
};

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

  const service = missionPlanArtifactService(db);
  const activePlan = await service.getActiveMissionPlan({ companyId, missionId });
  const activeOwnerDecision = readOwnerPlanDecisionRef(activePlan?.refs);
  const actor = requestedBy ?? { actorType: "system" as const, actorId: DEFAULT_OWNER_PLAN_MATERIALIZER_ACTOR_ID };
  if (activeOwnerDecision?.decisionHash === decisionHash) {
    if (activePlan) {
      await ensureCrossCompanyDelegationsForMissionOwnerPlan({
        db,
        companyId,
        missionId,
        draft: draftResult.draft,
        missionPlanArtifactId: activePlan.id,
        decisionHash,
      });
      await ensurePaqoWorkflowForMissionOwnerPlan({
        db,
        companyId,
        missionId,
        draft: draftResult.draft,
        missionPlanArtifactId: activePlan.id,
        decisionHash,
        triggeredBy: actor.actorId,
      });
    }
    return {
      status: "noop",
      reason: "already_recorded",
      planningIssueId: collected.planningIssueId,
      commentId: collected.commentId,
      decisionHash,
      diagnostics: [],
    };
  }

  const refs = mergeMissionPlanRefs(activePlan?.refs, {
    ...draftResult.draft.refs,
    ownerPlanDecision: {
      ...draftResult.draft.refs.ownerPlanDecision,
      decisionHash,
    },
  });
  const missionPlanArtifact = await service.createMissionPlanRevision({
    companyId,
    missionId,
    ...(draftResult.draft.missionGoal ? { missionGoal: draftResult.draft.missionGoal } : {}),
    refs,
    requiredInputs: draftResult.draft.requiredInputs,
    successCriteria: draftResult.draft.successCriteria,
    steps: draftResult.draft.steps,
  });
  await ensureCrossCompanyDelegationsForMissionOwnerPlan({
    db,
    companyId,
    missionId,
    draft: draftResult.draft,
    missionPlanArtifactId: missionPlanArtifact.id,
    decisionHash,
  });
  await ensurePaqoWorkflowForMissionOwnerPlan({
    db,
    companyId,
    missionId,
    draft: draftResult.draft,
    missionPlanArtifactId: missionPlanArtifact.id,
    decisionHash,
    triggeredBy: actor.actorId,
  });
  await logActivity(db, {
    companyId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    action: "mission.owner_plan.recorded",
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
      idempotencyKey: `${collected.commentId}:${decisionHash}`,
    },
  });

  return {
    status: "recorded",
    missionPlanArtifact,
    revision: missionPlanArtifact.revision,
    planningIssueId: collected.planningIssueId,
    commentId: collected.commentId,
    decisionHash,
    diagnostics: [],
  };
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
  const selectedSteps = selectedUnits.map((unit, index) => {
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
    return {
      id: `${group}-${index + 1}-${shortStableHash({ missionId: mission.id, index, sourceRef, title, group })}`,
      name: `[${groupLabel}] ${title}`,
      agentId: assigneeAgentId,
      dependencies: [],
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
  const plannedSteps = applyPlanStepDependencies(selectedUnits, selectedSteps, draft.steps);

  const qaStep: WorkflowStep = {
    id: `qa-${shortStableHash({ missionId: mission.id, actions: plannedSteps.map((step) => step.id), goal: draft.missionGoal })}`,
    name: "[QA] Verify mission result",
    agentId: mission.ownerAgentId,
    dependencies: plannedSteps.map((step) => step.id),
    description: [
      "Mission-level PAQO QA issue. Run independent verification after all ACTION workflow steps complete successfully.",
      "",
      draft.successCriteria.length > 0 ? `Success criteria: ${JSON.stringify(draft.successCriteria)}` : null,
      draft.steps.length > 0 ? `Planned steps: ${JSON.stringify(draft.steps)}` : null,
    ].filter(Boolean).join("\n"),
  };

  return [...plannedSteps, qaStep];
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
