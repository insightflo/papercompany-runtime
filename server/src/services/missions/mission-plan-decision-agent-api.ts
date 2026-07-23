// [파일 목적] structured Mission owner plan decision submission agent API.
//   owner agent 가 run completion(또는 API) 에 structured plan decision 제출 →
//   recordMissionOwnerPlanDecisionSubmission → record(preParsed) → validation +
//   materialization + submission ledger. 자연어 comment 는 display 전용이며
//   runtime 결정 권한으로 읽히지 않는다.
// [외부 연결] routes/workflow-agent-api.ts POST /issues/:id/mission-plan-decision.
// [수정시 주의] decisionHash 는 record 내부에서 계산 → 결과에서 추출해 submission 저장.
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { conflict, unprocessable } from "../../errors.js";
import { recordMissionOwnerPlanDecisionSubmission } from "./mission-plan-decision-submissions.js";
import type { PlanQaWakeupHandler } from "../mission-owner-plan-decisions.js";

type IssueRow = typeof issues.$inferSelect;

export type MissionOwnerPlanDecisionApiIssue = Pick<IssueRow, "id" | "companyId" | "missionId" | "originKind">;

export type MissionOwnerPlanDecisionApiActor = {
  actorType: "agent";
  actorId: string;
  runId?: string | null;
};

// [목적] structured owner plan decision 제출 → materialization + ledger.
// [입력] db/issue/actor/decision/enqueuePlanQaWakeup?
// [출력] RecordLatestAuthorizedMissionOwnerPlanDecisionResult.
// [연결] mission-plan-decision-submissions.ts recordMissionOwnerPlanDecisionSubmission.
export async function submitMissionOwnerPlanDecision(input: {
  readonly db: Db;
  readonly issue: MissionOwnerPlanDecisionApiIssue;
  readonly actor: MissionOwnerPlanDecisionApiActor;
  readonly decision: Record<string, unknown>;
  readonly enqueuePlanQaWakeup?: PlanQaWakeupHandler;
}) {
  if (input.issue.originKind !== "mission_main_executor_plan") {
    throw conflict("Mission owner plan decision API can only be used for mission_main_executor_plan issues");
  }
  const missionId = input.issue.missionId;
  if (!missionId) throw unprocessable("Mission owner plan decision API requires a mission-scoped issue");
  return recordMissionOwnerPlanDecisionSubmission({
    db: input.db,
    companyId: input.issue.companyId,
    missionId,
    planningIssueId: input.issue.id,
    decision: input.decision,
    requestedBy: { actorType: "agent", actorId: input.actor.actorId },
    sourceRunId: input.actor.runId ?? null,
    enqueuePlanQaWakeup: input.enqueuePlanQaWakeup,
  });
}
