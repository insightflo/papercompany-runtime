// Owner unblock anchors preserve existing reuse, descriptions, creation and notification behavior.
// The caller supplies the owner-action creator so parent-placement fallback stays shared.
import { issues, type Db } from "@paperclipai/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import { logger } from "../../middleware/logger.js";
import type { MissionRow, MissionServiceDeps } from "../missions.js";
import { buildMissionExecutionDigest } from "./mission-execution-digest.js";
import { buildMissionOwnerUnblockDescription, isTerminalIssueStatus } from "./mission-owner-recovery-comments.js";
import { loadLatestMissionOwnerDecision } from "./mission-owner-recovery-ledger.js";
import { findRelatedKnowledgePatterns } from "./mission-owner-related-patterns.js";
import type { IssueCreateInput, IssueRow } from "./shared-types.js";
import { loadCompanySystemLanguage } from "./system-language.js";

type OwnerUnblockAnchorDependencies = {
  db: Db;
  deps: Pick<MissionServiceDeps, "onOwnerActionCreated">;
  createMissionOwnerActionIssue: (companyId: string, data: IssueCreateInput) => Promise<IssueRow>;
};

export function createOwnerUnblockAnchor({
  db,
  deps,
  createMissionOwnerActionIssue,
}: OwnerUnblockAnchorDependencies) {
  async function ensureMainExecutorUnblockIssue(
    mission: MissionRow,
    blockedIssue: typeof issues.$inferSelect,
    options: { renewAfterNoActionWaiting?: boolean; governanceEvidence?: string[]; notifyOwner?: boolean } = {},
  ): Promise<typeof issues.$inferSelect> {
    const existingRows = await db
      .select()
      .from(issues)
      .where(and(
        eq(issues.companyId, mission.companyId),
        eq(issues.missionId, mission.id),
        eq(issues.originKind, "mission_main_executor_unblock"),
        eq(issues.originId, blockedIssue.id),
        isNull(issues.hiddenAt),
      ))
      .orderBy(asc(issues.createdAt), asc(issues.id));
    for (const existing of existingRows) {
      if (options.renewAfterNoActionWaiting && isTerminalIssueStatus(existing.status)) {
        const latestDecision = await loadLatestMissionOwnerDecision({
          db,
          companyId: mission.companyId,
          ownerActionIssueId: existing.id,
        });
        if (latestDecision?.decision.decision === "no_action_waiting") continue;
      }
      return existing;
    }

    const blockedLabel = blockedIssue.identifier ?? blockedIssue.id;
    let missionExecutionDigest: string[] = [];
    try {
      missionExecutionDigest = await buildMissionExecutionDigest(db, { mission, blockedIssue });
    } catch (error) {
      logger.warn({ err: error, missionId: mission.id, blockedIssueId: blockedIssue.id }, "Failed to build mission execution digest for owner unblock issue");
      missionExecutionDigest = ["Mission execution digest could not be built; inspect workflow runs, step runs, work products, and source issue comments manually."];
    }
    let relatedKnowledgePatterns: Array<{ id: string; title: string }> = [];
    try {
      // [관련 사고 패턴 방아쇠] 이번 미션 제목·막힌 이슈 제목으로 회사 위키 카드를 골라
      //   오너 결정 표면에 요약 라인으로 띄운다. 실패해도 언블록 생성은 계속된다.
      relatedKnowledgePatterns = await findRelatedKnowledgePatterns(db, mission.companyId, [
        mission.title,
        blockedIssue.title,
        ...missionExecutionDigest,
      ]);
    } catch (error) {
      logger.warn({ err: error, missionId: mission.id, blockedIssueId: blockedIssue.id }, "Failed to find related knowledge patterns for owner unblock issue");
    }
    const ownerActionLanguage = await loadCompanySystemLanguage(db, mission.companyId);
    const unblockParentId = blockedIssue.parentId ? undefined : blockedIssue.id;
    const unblockIssue = await createMissionOwnerActionIssue(mission.companyId, {
      assigneeAgentId: mission.ownerAgentId,
      description: buildMissionOwnerUnblockDescription(mission, blockedIssue, {
        governanceEvidence: options.governanceEvidence,
        missionExecutionDigest,
        relatedKnowledgePatterns,
        language: ownerActionLanguage,
      }),
      missionId: mission.id,
      originKind: "mission_main_executor_unblock",
      originId: blockedIssue.id,
      parentId: unblockParentId,
      priority: "high",
      status: "todo",
      title: `[Unblock] ${blockedLabel}: ${blockedIssue.title}`,
    });
    if (options.notifyOwner !== false && deps.onOwnerActionCreated) {
      void Promise.resolve(deps.onOwnerActionCreated({
        mission,
        issue: unblockIssue,
        sourceIssue: blockedIssue,
        reason: "mission_unblock_action_created",
      })).catch((err) => {
        logger.warn({ err, missionId: mission.id, issueId: unblockIssue.id }, "failed to notify owner about mission unblock action");
      });
    }
    return unblockIssue;
  }

  return ensureMainExecutorUnblockIssue;
}
