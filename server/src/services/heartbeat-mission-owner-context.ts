import { HttpError } from "../errors.js";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues, missions } from "@paperclipai/db";
import { MISSION_OWNER_DECISION_OPTIONS, parseMissionOwnerActionMarker, type ExtractedMissionOwnerDecision } from "./missions/mission-owner-recovery-events.js";
import { loadLatestMissionOwnerDecision } from "./missions/mission-owner-recovery-ledger.js";
import { isMissionExecutionLiaisonAgent } from "./missions/agent-role-boundaries.js";

export function isHermesOperationsLiaisonAgent(agent: Pick<typeof agents.$inferSelect, "name" | "adapterType" | "runtimeConfig" | "metadata">) {
  return isMissionExecutionLiaisonAgent(agent);
}

export function isMissionOwnerControlIssue(issue: Pick<typeof issues.$inferSelect, "originKind" | "description">) {
  return isMissionOwnerTaskIssue(issue);
}

function truncateContextText(value: string | null | undefined, max = 220) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 3)}...` : trimmed;
}

function isMissionOwnerTaskIssue(issue: {
  originKind: string | null;
  description: string | null;
}) {
  return (
    issue.originKind === "mission_main_executor_oversight" ||
    issue.originKind === "mission_main_executor_unblock" ||
    parseMissionOwnerActionMarker(issue.description) !== null
  );
}

function canApplyRequestChangesValidationGate(issue: {
  originKind: string | null;
  title?: string | null;
}) {
  if (issue.originKind === "mission_main_executor_plan") return false;
  if (issue.originKind === "mission_main_executor_oversight") return false;
  if (issue.originKind === "mission_main_executor_unblock") return false;

  const title = issue.title?.trim() ?? "";
  return (
    /^\s*\[QA\]/iu.test(title) ||
    /\b(QA|audit|auditor|validator|validation|validate|verify|review|check)\b/iu.test(title) ||
    title.includes("검증")
  );
}

export function canCreateMissionOwnerUnblockForRequestChanges(issue: {
  originKind: string | null;
  title?: string | null;
}) {
  return canApplyRequestChangesValidationGate(issue);
}

export type MissionOwnerTaskContext = {
  available: true;
  gating: "originKind" | "mission-owner-action-marker";
  mission: {
    id: string;
    title: string;
    status: string;
  };
  ownerTaskIssue: {
    id: string;
    identifier: string | null;
    title: string;
    originKind: string | null;
    status: string;
  };
  sourceIssue: {
    id: string;
    identifier: string | null;
    title: string;
    status: string;
    assigneeAgentId: string | null;
  } | null;
  latestOwnerActionDecision: ExtractedMissionOwnerDecision | null;
  governanceEvidence: string;
  allowedDecisionOptions: string[];
  requiredDecisionFormat: string[];
};

export async function resolveMissionOwnerTaskContext(input: {
  db: Db;
  companyId: string;
  issue: {
    id: string;
    identifier: string | null;
    title: string;
    description: string | null;
    status: string;
    missionId: string | null;
    originKind: string | null;
    originId: string | null;
  } | null;
}): Promise<MissionOwnerTaskContext | null> {
  const { db, companyId, issue } = input;
  if (!issue || !isMissionOwnerTaskIssue(issue)) return null;

  const marker = parseMissionOwnerActionMarker(issue.description);
  const missionId = issue.missionId ?? marker?.missionId ?? null;
  if (!missionId) return null;

  const mission = await db
    .select({ id: missions.id, title: missions.title, status: missions.status })
    .from(missions)
    .where(and(eq(missions.id, missionId), eq(missions.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!mission) return null;

  const sourceIssueId = issue.originKind === "mission_main_executor_unblock"
    ? issue.originId
    : marker?.sourceIssueId ?? null;
  const sourceIssue = sourceIssueId
    ? await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
        })
        .from(issues)
        .where(and(eq(issues.id, sourceIssueId), eq(issues.companyId, companyId)))
        .then((rows) => rows[0] ?? null)
    : null;

  // Structured recovery ledger only — comment/description decision prose is display-only.
  const structuredDecision = await loadLatestMissionOwnerDecision({
    db,
    companyId,
    ownerActionIssueId: issue.id,
  });
  const latestOwnerActionDecision = structuredDecision?.decision ?? null;

  return {
    available: true,
    gating: issue.originKind === "mission_main_executor_oversight" || issue.originKind === "mission_main_executor_unblock"
      ? "originKind"
      : "mission-owner-action-marker",
    mission: {
      id: mission.id,
      title: truncateContextText(mission.title, 160) ?? "Untitled mission",
      status: mission.status,
    },
    ownerTaskIssue: {
      id: issue.id,
      identifier: issue.identifier,
      title: truncateContextText(issue.title, 160) ?? "Untitled issue",
      originKind: issue.originKind,
      status: issue.status,
    },
    sourceIssue: sourceIssue
      ? {
          id: sourceIssue.id,
          identifier: sourceIssue.identifier,
          title: truncateContextText(sourceIssue.title, 160) ?? "Untitled source issue",
          status: sourceIssue.status,
          assigneeAgentId: sourceIssue.assigneeAgentId,
        }
      : null,
    latestOwnerActionDecision,
    governanceEvidence: "Governance evidence: unavailable in this context builder",
    allowedDecisionOptions: [...MISSION_OWNER_DECISION_OPTIONS],
    requiredDecisionFormat: [
      "Submit structured Mission owner decision via the dedicated recovery API / ledger (owner_recovery_api).",
      "Comments and Markdown decision blocks are display-only and are not control-plane authority.",
      "Decision options:",
      ...MISSION_OWNER_DECISION_OPTIONS.map((option) => `- ${option}`),
    ],
  };
}

export function isMissionOwnerActionParentPlacementRejected(error: unknown) {
    return error instanceof HttpError &&
      error.status === 422 &&
      (
        error.message.includes("Mission downstream issue creation is not allowed") ||
        error.message.includes("Mission nested child issue creation is not allowed") ||
        error.message.includes("Mission child issue burst limit exceeded")
      );
  }
