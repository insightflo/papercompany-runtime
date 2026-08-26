import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import { logActivity } from "../activity-log.js";
import { issueService } from "../issues.js";
import { RECOVERY_UNBLOCK_ORIGIN_KIND } from "../missions/recovery-ownership-guard.js";

interface ResolvedUnblockCloseoutInput {
  db: Db;
  run: {
    id: string;
    status: string;
    companyId: string;
    missionId: string | null;
  };
  stepRuns: readonly {
    workflowRunId: string;
    issueId: string | null;
  }[];
}

export async function closeResolvedWorkflowUnblocks(input: ResolvedUnblockCloseoutInput): Promise<void> {
  const { db, run } = input;
  if (run.status !== "completed" || !run.missionId) return;

  const currentIssueIds = Array.from(new Set(input.stepRuns
    .filter((stepRun) => stepRun.workflowRunId === run.id)
    .map((stepRun) => stepRun.issueId)
    .filter((issueId): issueId is string => issueId !== null)));
  if (currentIssueIds.length === 0) return;

  const doneSources = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(
      eq(issues.companyId, run.companyId),
      eq(issues.missionId, run.missionId),
      eq(issues.status, "done"),
      inArray(issues.id, currentIssueIds),
    ));
  const doneSourceIds = doneSources.map((source) => source.id);
  if (doneSourceIds.length === 0) return;

  const openUnblocks = await db
    .select({ id: issues.id, originId: issues.originId, status: issues.status })
    .from(issues)
    .where(and(
      eq(issues.companyId, run.companyId),
      eq(issues.missionId, run.missionId),
      eq(issues.originKind, RECOVERY_UNBLOCK_ORIGIN_KIND),
      inArray(issues.originId, doneSourceIds),
      isNull(issues.hiddenAt),
      notInArray(issues.status, ["done", "cancelled"]),
    ));
  const service = issueService(db);

  for (const unblock of openUnblocks) {
    if (!unblock.originId) continue;
    const updated = await service.update(unblock.id, { status: "done" });
    if (updated?.status !== "done") continue;

    await service.addComment(
      unblock.id,
      `Resolved automatically: source issue ${unblock.originId} reached done; this unblock action no longer represents open mission work.`,
      {},
    );
    await logActivity(db, {
      companyId: run.companyId,
      actorType: "system",
      actorId: "workflow-unblock-closeout",
      action: "mission.owner_action_settled_from_source",
      entityType: "issue",
      entityId: unblock.id,
      details: {
        sourceIssueId: unblock.originId,
        sourceStatus: "done",
        previousStatus: unblock.status,
        nextStatus: "done",
        workflowRunId: run.id,
      },
    });
  }
}
