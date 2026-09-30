import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { heartbeatRuns, issues, missions, workflowRuns, workflowTerminalDecisions, type Db } from "@paperclipai/db";
import { seedToolRecoveryScenario } from "./tool-recovery-scenario.js";
import { recordMissionOwnerDecision } from "../../services/missions/mission-owner-recovery-ledger.js";
import { proposeReplacement, approveReplacement } from "../../services/workflow/replacement-approval.js";

export async function seedReplacement(db: Db, approve = true) {
  const s = await seedToolRecoveryScenario({ db, artifactExists: false });
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, s.workflowRunId));
  const [mission] = await db.select().from(missions).where(eq(missions.id, run.missionId!));
  const heartbeatId = randomUUID();
  await db.insert(heartbeatRuns).values({ id: heartbeatId, companyId: s.companyId, agentId: mission.ownerAgentId,
    issueId: s.recoveryIssueId, invocationSource: "manual", status: "succeeded", finishedAt: new Date() });
  await db.insert(workflowTerminalDecisions).values({ companyId: s.companyId, workflowRunId: run.id,
    decidedAuthorityVersion: 0, decision: "failed", policyCause: "recovery_deadline_hard", discoveryPath: "stuck_diagnostic", origin: "reconciler", reason: "test", recoveryGate: {} });
  const owner = await recordMissionOwnerDecision({ db, issue: { id: s.recoveryIssueId, companyId: s.companyId, missionId: mission.id },
    heartbeatRunId: heartbeatId, submission: { decision: "restart_from_start", recoveryTarget: { kind: "tool_step", workflowRunId: run.id,
      stepRunId: s.stepRunId, expectedAuthorityVersion: 0, expectedExecutionGeneration: 0, failedDispatchRequestId: null } } });
  const board = { type: "board", source: "local_implicit", userId: "local-board", isInstanceAdmin: true } as const;
  const proposal = await proposeReplacement(db, s.companyId, board, { sourceRunId: run.id, decisionEventId: owner.eventId,
    idempotencyKey: "replace-once", metadata: {}, externalEffects: "operator_reconciled" });
  if (approve) await approveReplacement(db, s.companyId, proposal.id, board);
  const actor = { type: "agent", agentId: mission.ownerAgentId, companyId: s.companyId } as const;
  const input = { workflowId: run.workflowId, companyId: s.companyId, missionId: mission.id, triggeredBy: "agent", metadata: {},
    replacementIntent: { schemaVersion: 1 as const, sourceRunId: run.id, expectedSourceAuthorityVersion: 0,
      decisionEventId: owner.eventId, approvalId: proposal.id, idempotencyKey: "replace-once" } };
  return { ...s, run, mission, actor, input, proposal, board };
}
