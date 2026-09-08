import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues, workflowResumeRequests } from "@paperclipai/db";
import { ensureMissionAgentRuntime } from "../../missions/mission-runtime-manager.js";
import { readOwnResumeRequestId } from "../resume-scope-fence.js";
import { withResumeSerialization } from "./serialization.js";

/** Default-workspace preparation only. The actual heartbeat compiler independently selects
 * its physical workspace and validates persisted producer identity under the same lock order.
 * Run stamp, mission activity, request, affected agents and ensures share one transaction;
 * no stale lifecycle call can ensure after supersession/cancellation wins serialization.
 * Sessions/plans are never reactivated here; only mission_agent_runtimes is written.
 */
export interface ResumeMissionLifecycleResult {
  runStampMatched: boolean;
  missionActive: boolean;
  ensuredAgentIds: string[];
  affectedStepIds: string[];
}

export async function ensureResumeMissionRuntimes(
  db: Db,
  input: {
    companyId: string;
    missionId: string;
    workflowRunId: string;
    resumeRequestId: string;
  },
): Promise<ResumeMissionLifecycleResult> {
  return withResumeSerialization(db, {
    companyId: input.companyId, missionId: input.missionId, runId: input.workflowRunId,
  }, async ({ tx, mission, run, steps }) => {
    if (readOwnResumeRequestId(run.metadata) !== input.resumeRequestId) {
      return { runStampMatched: false, missionActive: false, ensuredAgentIds: [], affectedStepIds: [] };
    }
    if (mission.status !== "active") {
      return { runStampMatched: true, missionActive: false, ensuredAgentIds: [], affectedStepIds: [] };
    }
    const [request] = await tx.select().from(workflowResumeRequests).where(and(
      eq(workflowResumeRequests.id, input.resumeRequestId),
      eq(workflowResumeRequests.companyId, input.companyId),
      eq(workflowResumeRequests.missionId, input.missionId),
      eq(workflowResumeRequests.workflowRunId, input.workflowRunId),
    )).for("update");
    if (!request || !["pending_delivery", "accepted"].includes(request.state)) {
      return { runStampMatched: true, missionActive: true, ensuredAgentIds: [], affectedStepIds: [] };
    }
    const affectedStepIds = Object.keys(request.appliedGenerations ?? {}).filter((stepId) => stepId.length > 0);
    const affectedIssueIds = [...new Set(steps
      .filter((step) => affectedStepIds.includes(step.stepId))
      .map((step) => step.issueId).filter((id): id is string => id !== null))];
    const assignees = affectedIssueIds.length > 0
      ? await tx.select({ assigneeAgentId: issues.assigneeAgentId }).from(issues).where(and(
        inArray(issues.id, affectedIssueIds), eq(issues.companyId, input.companyId), eq(issues.missionId, input.missionId),
      )) : [];
    const agentIds = [...new Set([
      ...assignees.map((row) => row.assigneeAgentId), mission.ownerAgentId,
    ].filter((id): id is string => Boolean(id)))];
    const ensuredAgentIds: string[] = [];
    for (const agentId of agentIds) {
      const [agent] = await tx.select({ adapterType: agents.adapterType }).from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.companyId, input.companyId))).limit(1);
      if (!agent) continue;
      await ensureMissionAgentRuntime(tx as unknown as Db, {
        companyId: input.companyId, missionId: input.missionId, agentId, adapterType: agent.adapterType,
        workspaceKey: "default", resumeContext: { resumeRequestId: input.resumeRequestId },
      });
      ensuredAgentIds.push(agentId);
    }
    return { runStampMatched: true, missionActive: true, ensuredAgentIds, affectedStepIds };
  });
}
