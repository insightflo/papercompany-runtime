import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueComments, issues, missions } from "@paperclipai/db";

export type MissionOwnerPlanDecisionPayload = {
  missionId?: unknown;
  goal?: unknown;
  missionGoal?: unknown;
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
