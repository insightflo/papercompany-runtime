import { randomUUID } from "node:crypto";
import { agents, companies, heartbeatRuns, issueComments, issues, missions, type createDb } from "@paperclipai/db";

export async function seedMissionOwnerTaskContextFixture(db: ReturnType<typeof createDb>, issueKind: string, description?: string) {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const missionId = randomUUID();
  const sourceIssueId = randomUUID();
  const ownerTaskIssueId = randomUUID();

  await db.insert(companies).values({
    id: companyId,
    name: "Paperclip",
    issuePrefix: "PAP",
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "Shared Worker",
    role: "engineer",
    status: "active",
    adapterType: "codex_local",
    adapterConfig: { promptTemplate: "Follow the issue." },
    runtimeConfig: {},
    permissions: {},
  });
  await db.insert(missions).values({
    id: missionId,
    companyId,
    ownerAgentId: agentId,
    title: "Mission owner context mission",
    status: "active",
  });
  await db.insert(issues).values({
    id: sourceIssueId,
    companyId,
    missionId,
    identifier: "PAP-SOURCE",
    title: "Blocked source issue",
    description: "source issue private detail should stay bounded",
    status: "blocked",
    assigneeAgentId: agentId,
    originKind: "workflow_execution",
  });
  await db.insert(issues).values({
    id: ownerTaskIssueId,
    companyId,
    missionId,
    identifier: `PAP-${issueKind.toUpperCase().slice(0, 8)}`,
    title: `${issueKind} current issue`,
    description: description ?? "Mission owner task description",
    status: "todo",
    assigneeAgentId: agentId,
    originKind: issueKind,
    originId: issueKind === "mission_main_executor_unblock" ? sourceIssueId : null,
  });
  // Display-only comment remains allowed for audit UI, but is never decision authority.
  await db.insert(issueComments).values({
    companyId,
    issueId: ownerTaskIssueId,
    authorAgentId: agentId,
    body: [
      "### Mission owner decision",
      "Decision: retry_source_issue",
      `Source issue: ${sourceIssueId}`,
      "Reason: source is now unblockable",
      "Next action: re-dispatch later after approval",
      "Evidence: bounded owner comment",
    ].join("\n"),
  });
  // Structured recovery ledger is the only authority for latestOwnerActionDecision in heartbeat context.
  if (issueKind === "mission_main_executor_unblock") {
    const { recordMissionOwnerDecision } = await import("../../services/missions/mission-owner-recovery-ledger.js");
    const heartbeatRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: heartbeatRunId,
      companyId,
      agentId,
      issueId: ownerTaskIssueId,
      status: "succeeded",
      invocationSource: "automation",
      startedAt: new Date("2026-07-01T00:00:00.000Z"),
      finishedAt: new Date("2026-07-01T00:01:00.000Z"),
      createdAt: new Date("2026-07-01T00:01:00.000Z"),
    });
    await recordMissionOwnerDecision({
      db,
      issue: { id: ownerTaskIssueId, companyId, missionId },
      sourceIssueId,
      heartbeatRunId,
      submission: {
        decision: "retry_source_issue",
        sourceIssueRef: sourceIssueId,
        reason: "source is now unblockable",
        nextAction: "re-dispatch later after approval",
        evidence: "structured owner recovery ledger",
      },
    });
  }

  return { companyId, agentId, missionId, sourceIssueId, ownerTaskIssueId };
}
