// server/src/services/missions/mission-plan-qa-verdicts.ts
//
// [파일 목적] structured Plan-QA verdict ingestion (Task 4).
//   reviewer 가 run completion 에 structured verdict 를 mission_plan_qa_verdicts 표에 저장.
//   사람용 comment 도 dual-write(audit/display). 기존 readPlanQaVerdict 가 structured-first 로 읽음.
// [주요 흐름] recordMissionPlanQaVerdict → mission_plan_qa_verdicts INSERT + issueComment dual-write.
//   verdict 적용(materialize/block)은 다음 supervision tick 의 readPlanQaVerdict(structured-first) 가 처리.
// [외부 연결] mission-owner-plan-decisions.ts readPlanQaVerdict 가 이 표를 읽음.
// [수정시 주의] unique index (companyId, planQaIssueId, decisionHash) 로 같은 hash 재제출 멱등.
import { missionPlanQaVerdicts } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueService } from "../issues.js";
import type { ValidationVerdict } from "../validation-verdict.js";

export type PlanQaVerdictActor =
  | { actorType: "agent"; actorId: string }
  | { actorType: "user"; actorId: string }
  | { actorType: "system"; actorId: string };

export async function recordMissionPlanQaVerdict(input: {
  db: Db;
  companyId: string;
  missionId: string;
  planQaIssueId: string;
  decisionHash: string;
  verdict: ValidationVerdict;
  diagnostics?: Array<Record<string, unknown>>;
  reviewedBy: PlanQaVerdictActor;
  sourceRunId?: string | null;
  sourceCommentId?: string | null;
}): Promise<{ status: "recorded"; planQaIssueId: string; verdict: ValidationVerdict }> {
  // structured verdict 저장(unique index 로 같은 hash 재제출 멱등 — onConflictDoNothing).
  await input.db
    .insert(missionPlanQaVerdicts)
    .values({
      companyId: input.companyId,
      missionId: input.missionId,
      planQaIssueId: input.planQaIssueId,
      reviewerAgentId: input.reviewedBy.actorType === "agent" ? input.reviewedBy.actorId : null,
      reviewerUserId: input.reviewedBy.actorType === "user" ? input.reviewedBy.actorId : null,
      sourceRunId: input.sourceRunId ?? null,
      sourceCommentId: input.sourceCommentId ?? null,
      decisionHash: input.decisionHash,
      verdict: input.verdict,
      diagnostics: input.diagnostics ?? [],
    })
    .onConflictDoNothing();

  // dual-write: 사람이 읽을 수 있는 comment 도 남김(audit/display + legacy parser fallback 호환).
  const body = input.verdict === "pass"
    ? "Plan is sound.\nPASS"
    : `Plan has gaps.\nREQUEST_CHANGES: ${input.diagnostics?.map((d) => d.message ?? d.code ?? "").filter(Boolean).join("; ") || "needs work"}`;
  try {
    await issueService(input.db).addComment(input.planQaIssueId, body, {
      ...(input.reviewedBy.actorType === "agent" ? { agentId: input.reviewedBy.actorId } : {}),
      ...(input.reviewedBy.actorType === "user" ? {} : {}),
    });
  } catch {
    // comment 실패는 structured verdict 저장을 방해하지 않음.
  }

  return { status: "recorded", planQaIssueId: input.planQaIssueId, verdict: input.verdict };
}
