import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueComments, issues, missions, pluginEntities, workflowDefinitions } from "@paperclipai/db";
import { logActivity } from "./activity-log.js";
import { mergeMissionPlanRefs, missionPlanArtifactService, type MissionPlanArtifact } from "./mission-plan-artifacts.js";

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
  if (activeOwnerDecision?.decisionHash === decisionHash) {
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
  const actor = requestedBy ?? { actorType: "system" as const, actorId: DEFAULT_OWNER_PLAN_MATERIALIZER_ACTOR_ID };
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
  const pluginEntityIdsByType = new Map<string, Set<string>>();

  for (const [index, unit] of selectedExecutionUnits.entries()) {
    const sourceRef = isPlainObject(unit.sourceRef) ? unit.sourceRef : null;
    const sourceType = typeof sourceRef?.type === "string" ? sourceRef.type.trim() : "";
    const sourceId = typeof sourceRef?.id === "string" ? sourceRef.id.trim() : "";
    if (!sourceType || !sourceId) {
      diagnostics.push({
        code: "missing_source_ref",
        message: `selectedExecutionUnits[${index}] must include sourceRef.type and sourceRef.id`,
      });
      continue;
    }

    if (NATIVE_WORKFLOW_DEFINITION_SOURCE_TYPES.has(sourceType)) {
      nativeWorkflowDefinitionIds.add(sourceId);
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
