import { heartbeatRuns, type createDb } from "@paperclipai/db";
import { recordMissionOwnerDecision, type MissionOwnerDecisionSubmission } from "../../services/missions/mission-owner-recovery-ledger.js";

export function createMissionOwnerDecisionFixture(getDb: () => ReturnType<typeof createDb>) {
  async function recordOwnerDecision(input: {
    companyId: string;
    missionId: string;
    ownerActionIssueId: string;
    ownerAgentId: string;
    sourceIssueId: string;
    submission: MissionOwnerDecisionSubmission;
  }) {
    const db = getDb();
    const now = new Date();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: input.companyId,
      agentId: input.ownerAgentId,
      issueId: input.ownerActionIssueId,
      status: "succeeded",
      startedAt: now,
      finishedAt: now,
    }).returning({ id: heartbeatRuns.id });
    return recordMissionOwnerDecision({
      db,
      issue: {
        id: input.ownerActionIssueId,
        companyId: input.companyId,
        missionId: input.missionId,
      },
      submission: input.submission,
      sourceIssueId: input.sourceIssueId,
      heartbeatRunId: run!.id,
    });
  }
  return recordOwnerDecision;
}
