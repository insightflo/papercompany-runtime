import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { missionPlanArtifacts, type issues } from "@paperclipai/db";
import type { MissionPlanQaVerdictSubmit } from "@paperclipai/shared/validators/workflow-agent-api";
import { conflict, unprocessable } from "../../errors.js";
import {
  recordLatestAuthorizedMissionOwnerPlanDecision,
  type PlanQaWakeupHandler,
  type PlanningIssueWakeupHandler,
} from "../mission-owner-plan-decisions.js";
import { recordMissionPlanQaVerdict } from "./mission-plan-qa-verdicts.js";

type IssueRow = typeof issues.$inferSelect;

export type MissionPlanQaApiIssue = Pick<IssueRow, "id" | "companyId" | "missionId" | "originKind">;

export type MissionPlanQaApiActor = {
  readonly actorType: "agent" | "user";
  readonly actorId: string;
  readonly agentId: string | null;
  readonly runId: string | null;
};

function stringProperty(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const property = Reflect.get(value, key);
  return typeof property === "string" && property.trim().length > 0 ? property.trim() : null;
}

async function loadActivePlanQaDecision(input: {
  readonly db: Db;
  readonly issue: MissionPlanQaApiIssue;
}): Promise<string> {
  if (!input.issue.missionId) throw unprocessable("Mission PLAN-QA verdict API requires a mission-scoped issue");
  const [activePlan] = await input.db
    .select({ refs: missionPlanArtifacts.refs })
    .from(missionPlanArtifacts)
    .where(and(
      eq(missionPlanArtifacts.companyId, input.issue.companyId),
      eq(missionPlanArtifacts.missionId, input.issue.missionId),
      eq(missionPlanArtifacts.status, "active"),
    ))
    .orderBy(desc(missionPlanArtifacts.revision), desc(missionPlanArtifacts.createdAt))
    .limit(1);
  const planQa = activePlan ? Reflect.get(activePlan.refs ?? {}, "planQa") : null;
  if (stringProperty(planQa, "issueId") !== input.issue.id) {
    throw unprocessable("Mission PLAN-QA verdict API requires the active planQa issue");
  }
  const decisionHash = stringProperty(planQa, "decisionHash");
  if (!decisionHash) throw unprocessable("Mission PLAN-QA verdict API requires an active planQa decisionHash");
  return decisionHash;
}

export async function submitMissionPlanQaVerdict(input: {
  readonly db: Db;
  readonly issue: MissionPlanQaApiIssue;
  readonly actor: MissionPlanQaApiActor;
  readonly data: MissionPlanQaVerdictSubmit;
  readonly enqueuePlanQaWakeup?: PlanQaWakeupHandler;
  readonly enqueuePlanningIssueWakeup?: PlanningIssueWakeupHandler;
}) {
  if (input.issue.originKind !== "mission_plan_qa") {
    throw conflict("Mission PLAN-QA verdict API can only be used for mission_plan_qa issues");
  }
  const missionId = input.issue.missionId;
  if (!missionId) throw unprocessable("Mission PLAN-QA verdict API requires a mission-scoped issue");
  const decisionHash = await loadActivePlanQaDecision({ db: input.db, issue: input.issue });
  const recorded = await recordMissionPlanQaVerdict({
    db: input.db,
    companyId: input.issue.companyId,
    missionId,
    planQaIssueId: input.issue.id,
    decisionHash,
    verdict: input.data.verdict,
    diagnostics: input.data.diagnostics,
    reviewedBy: { actorType: input.actor.actorType, actorId: input.actor.actorId },
    sourceRunId: input.actor.runId,
  });
  const planDecision = await recordLatestAuthorizedMissionOwnerPlanDecision({
    db: input.db,
    companyId: input.issue.companyId,
    missionId,
    requestedBy: { actorType: input.actor.actorType, actorId: input.actor.actorId },
    enqueuePlanQaWakeup: input.enqueuePlanQaWakeup,
    enqueuePlanningIssueWakeup: input.enqueuePlanningIssueWakeup,
  });
  return { ...recorded, decisionHash, planDecisionStatus: planDecision.status };
}
