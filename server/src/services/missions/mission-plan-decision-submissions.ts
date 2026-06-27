// [파일 목적] structured owner plan decision submission 서비스.
//   agent/user 가 run completion(또는 API) 에 structured plan decision 제출 →
//   mission_plan_decision_submissions 표에 저장 + recordLatestAuthorizedMissionOwnerPlanDecision
//   를 preParsedDecision 경로로 호출(동일 validation+materialization chain).
// [주요 흐름] recordMissionOwnerPlanDecisionSubmission → record(preParsed) → store submission.
// [외부 연결] mission-owner-plan-decisions.ts recordLatestAuthorizedMissionOwnerPlanDecision.
// [수정시 주의] hashOwnerPlanDecision 은 record 내부에서 계산 → 결과 decisionHash 로 submission 저장.
import { and, eq } from "drizzle-orm";
import { missionPlanDecisionSubmissions, type Db } from "@paperclipai/db";
import { recordLatestAuthorizedMissionOwnerPlanDecision, type PlanQaWakeupHandler } from "../mission-owner-plan-decisions.js";

// [목적] structured owner plan decision 제출 → 표 저장 + materialization.
// [입력] db/companyId/missionId/planningIssueId/decision(객체)/requestedBy/sourceRunId?/enqueuePlanQaWakeup?
// [출력] RecordLatestAuthorizedMissionOwnerPlanDecisionResult.
// [연결] mission-owner-plan-decisions.ts recordLatestAuthorizedMissionOwnerPlanDecision.
// [주의] decisionHash 는 record 내부에서 계산 → 결과에서 추출해 submission 저장(idempotent).
export async function recordMissionOwnerPlanDecisionSubmission(input: {
  db: Db;
  companyId: string;
  missionId: string;
  planningIssueId: string;
  decision: Record<string, unknown>;
  requestedBy: { actorType: "system" | "agent"; actorId: string };
  sourceRunId?: string | null;
  enqueuePlanQaWakeup?: PlanQaWakeupHandler;
}) {
  // [1] preParsedDecision 경로로 record 호출 — 동일 validation + materialization chain.
  //   comment-parse 를 건너뛰고 decision 객체로 직행. hash 는 내부 계산.
  const result = await recordLatestAuthorizedMissionOwnerPlanDecision({
    db: input.db,
    companyId: input.companyId,
    missionId: input.missionId,
    requestedBy: input.requestedBy,
    enqueuePlanQaWakeup: input.enqueuePlanQaWakeup,
    preParsedDecision: {
      decision: input.decision,
      planningIssueId: input.planningIssueId,
      commentId: null,
    },
  });

  // [2] structured submission 저장(audit/readback 용). idempotent by decisionHash.
  //   record 결과에서 decisionHash 추출(recorded/pending/changes_requested/invalid 모두 포함).
  const decisionHash = "decisionHash" in result ? result.decisionHash : undefined;
  if (decisionHash) {
    const existing = await input.db
      .select({ id: missionPlanDecisionSubmissions.id })
      .from(missionPlanDecisionSubmissions)
      .where(and(
        eq(missionPlanDecisionSubmissions.companyId, input.companyId),
        eq(missionPlanDecisionSubmissions.missionId, input.missionId),
        eq(missionPlanDecisionSubmissions.decisionHash, decisionHash),
      ))
      .limit(1);
    if (existing.length === 0) {
      await input.db.insert(missionPlanDecisionSubmissions).values({
        companyId: input.companyId,
        missionId: input.missionId,
        planningIssueId: input.planningIssueId,
        authorAgentId: input.requestedBy.actorType === "agent" ? input.requestedBy.actorId : null,
        authorUserId: null,
        sourceRunId: input.sourceRunId ?? null,
        decisionHash,
        decision: input.decision,
        status: "accepted",
      });
    }
  }

  return result;
}
