// server/src/services/missions/mission-knowledge-compile.ts
//
// [파일 목적] 생산층 방아쇠 — 회복 종결(언블록 자동 해소) 시점에 미션 오너에게
//   "사고 패턴 카드 등록" 유계 이슈를 만든다. 지식 위키 컴파일이 지침 줄 의존(오너
//   자발 등록 0건)으로 굶지 않게 하는 구조적 경로. 설계: artifacts
//   doc/plans/2026-08-28-incident-pattern-knowledge-wiki.md 변경 2의 트리거 지점.
// [불변식]
//   - 보수적 등록: 원인이 구조적(재발 가능)일 때만 카드 1장. 단순 실패는 이슈 종결로 끝.
//   - 미션이 종결 상태(completed/cancelled/paused)면 만들지 않는다 — 오너 하트비트가
//     멈춘 미션의 이슈는 썩는다(실행통제 의미 변화 없음, fail-open).
//   - 회사 스코프 + 중복 방지: 카드 존재(mission id 참조) 또는 기존 컴파일 이슈(모든 상태)
//     가 있으면 재생성하지 않는다.
//   - 이 이슈는 결정 API 대상이 아니다 — 카드 등록(POST) 또는 이슈 종결이 행동.

import { and, eq, sql } from "drizzle-orm";
import { activityLog, companyKnowledgePatterns, issues, missions, type Db } from "@paperclipai/db";
import { issueService } from "../issues.js";
import { logger } from "../../middleware/logger.js";
import { buildMissionExecutionDigest } from "./mission-execution-digest.js";

export const MISSION_KNOWLEDGE_COMPILE_ORIGIN_KIND = "mission_knowledge_compile";

const ACTIVE_MISSION_STATUSES = new Set(["planning", "active"]);

export type MissionKnowledgeCompileRefs = {
  unblockIssueId: string;
  sourceIssueId: string;
  workflowRunId: string;
};

export function buildMissionKnowledgeCompileDescription(input: {
  missionId: string;
  missionTitle: string;
  refs: MissionKnowledgeCompileRefs;
  missionExecutionDigest?: string[];
}): string {
  const { missionId, missionTitle, refs } = input;
  const digest = (input.missionExecutionDigest ?? [])
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return [
    "Mission incident knowledge compile — bounded: at most one pattern card, or close with no card.",
    "",
    `Mission id: ${missionId}`,
    `Mission title: ${missionTitle}`,
    `Recovered from: unblock issue ${refs.unblockIssueId} (source issue ${refs.sourceIssueId} reached done; workflow run ${refs.workflowRunId}).`,
    ...(digest.length > 0
      ? ["", "Failure context (mission execution digest at recovery):", ...digest.map((line) => `- ${line}`)]
      : []),
    "",
    "Conservative rule: submit a card ONLY if the verified root cause was structural (likely to recur beyond this mission). One-off or already-permanently-fixed failures → close this issue with a short comment instead; an empty wiki is better than a polluted one.",
    "",
    "To record a card:",
    "POST /api/companies/{companyId}/knowledge-patterns",
    'Body: { kind: "failure_mode", title, summary, symptoms, rootCause, whatWorked, evidence: [{ type: "mission", id: <mission id above> }, { type: "workflow_run", id: <workflow run id above> }], source: "mission_owner_compile" }',
    "Search before writing: GET /api/companies/{companyId}/knowledge-patterns?q=<keywords> — supersede (supersedeId) instead of duplicating.",
    "",
    "If a bounded company skill patch would prevent recurrence, adopt it through the self-improvement loop after recording the card:",
    "POST /api/companies/{companyId}/self-improvement-adoptions/dry-run with the candidate citing the card in evidenceSource, have the peer validator record its verdict on the returned candidateHash (POST /api/companies/{companyId}/self-improvement-adoptions/verdicts {gateOwner, candidateHash, verdict}), then POST .../self-improvement-adoptions/apply. Do not hand-edit skill markdown.",
    "",
    "After recording the card (or deciding there is no recurring pattern), close this issue (status done). Comments are display-only; the card record and the issue status are the authority.",
  ].join("\n");
}

export async function ensureMissionKnowledgeCompileIssue(
  db: Db,
  input: { companyId: string; missionId: string; refs: MissionKnowledgeCompileRefs },
): Promise<{ created: boolean; reason: string; issueId: string | null }> {
  const [mission] = await db
    .select({ id: missions.id, companyId: missions.companyId, title: missions.title, description: missions.description, status: missions.status, ownerAgentId: missions.ownerAgentId })
    .from(missions)
    .where(and(eq(missions.id, input.missionId), eq(missions.companyId, input.companyId)))
    .limit(1);
  if (!mission) return { created: false, reason: "mission_not_found", issueId: null };
  if (!ACTIVE_MISSION_STATUSES.has(mission.status)) {
    return { created: false, reason: `mission_${mission.status}`, issueId: null };
  }

  // 이미 이 미션을 참조하는 카드가 있으면 컴파일 완료로 간주(superseded 포함 — 역사도 원장).
  const [existingCard] = await db
    .select({ id: companyKnowledgePatterns.id })
    .from(companyKnowledgePatterns)
    .where(and(
      eq(companyKnowledgePatterns.companyId, input.companyId),
      sql`${companyKnowledgePatterns.evidence} @> ${JSON.stringify([{ type: "mission", id: input.missionId }])}::jsonb`,
    ))
    .limit(1);
  if (existingCard) return { created: false, reason: "card_exists", issueId: null };

  // 미션당 컴파일 이슈 1회(모든 상태 포함) — 종결 거부로 재발행해 재촉하지 않는다.
  const [existingIssue] = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(
      eq(issues.companyId, input.companyId),
      eq(issues.missionId, input.missionId),
      eq(issues.originKind, MISSION_KNOWLEDGE_COMPILE_ORIGIN_KIND),
    ))
    .limit(1);
  if (existingIssue) return { created: false, reason: "issue_exists", issueId: existingIssue.id };

  // [Digester 유사] 회복 시점 실패 문맥을 다이제스트로 실어준다(실패 시 생략 — 이슈 생성은 계속).
  let missionExecutionDigest: string[] = [];
  try {
    const [sourceIssue] = await db
      .select({ id: issues.id, identifier: issues.identifier, status: issues.status, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(and(eq(issues.id, input.refs.sourceIssueId), eq(issues.companyId, input.companyId)))
      .limit(1);
    if (sourceIssue) {
      missionExecutionDigest = await buildMissionExecutionDigest(db, { mission, blockedIssue: sourceIssue });
    }
  } catch (error) {
    logger.warn({ err: error, missionId: input.missionId }, "failed to build execution digest for knowledge compile issue");
  }

  const issue = await issueService(db).create(input.companyId, {
    assigneeAgentId: mission.ownerAgentId,
    description: buildMissionKnowledgeCompileDescription({
      missionId: mission.id,
      missionTitle: mission.title,
      refs: input.refs,
      missionExecutionDigest,
    }),
    missionId: mission.id,
    originKind: MISSION_KNOWLEDGE_COMPILE_ORIGIN_KIND,
    originId: mission.id,
    priority: "normal",
    status: "todo",
    title: `[Knowledge] Compile incident pattern — ${mission.title}`,
  });

  await db.insert(activityLog).values({
    companyId: input.companyId,
    actorType: "system",
    actorId: "workflow-unblock-closeout",
    action: "mission.knowledge_compile_issue_created",
    entityType: "issue",
    entityId: issue.id,
    details: {
      missionId: mission.id,
      unblockIssueId: input.refs.unblockIssueId,
      sourceIssueId: input.refs.sourceIssueId,
      workflowRunId: input.refs.workflowRunId,
    },
  });

  return { created: true, reason: "created", issueId: issue.id };
}

/** fail-open 래퍼 — 회복 종결 흐름은 컴파일 이슈 실패로 멈추지 않는다. */
export async function ensureMissionKnowledgeCompileIssueSafe(
  db: Db,
  input: { companyId: string; missionId: string; refs: MissionKnowledgeCompileRefs },
): Promise<void> {
  try {
    await ensureMissionKnowledgeCompileIssue(db, input);
  } catch (error) {
    logger.warn(
      { err: error, missionId: input.missionId, companyId: input.companyId },
      "failed to ensure mission knowledge compile issue",
    );
  }
}
