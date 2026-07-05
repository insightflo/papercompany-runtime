import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  missionIssueHandoffs,
  missions,
  type MissionIssueHandoffEvidenceRef,
  type issues,
} from "@paperclipai/db";
import { sha256Text } from "../issue-execution-cards/hash.js";

type TerminalIssueRow = Pick<
  typeof issues.$inferSelect,
  "id" | "companyId" | "missionId" | "identifier" | "title" | "description" | "status" |
  "assigneeAgentId" | "checkoutRunId" | "executionRunId"
>;

function renderTerminalIssueHandoff(input: {
  issue: TerminalIssueRow;
  previousStatus: string;
  runId: string | null;
}): string {
  const label = input.issue.identifier ?? input.issue.id;
  return [
    "# Issue Terminal Handoff",
    "",
    `Issue: ${label}`,
    `Status: ${input.previousStatus} -> ${input.issue.status}`,
    `Title: ${input.issue.title}`,
    `Run ID: ${input.runId ?? "none"}`,
    "",
    "## Issue Goal",
    input.issue.description ?? input.issue.title,
    "",
    "## What This Proves",
    "- The issue entered a terminal status in the official issues table.",
    "- Treat this as a DB closeout marker, not proof that all claimed side effects happened.",
    "",
    "## Next Reader Checklist",
    "- Check issue comments and structured ledgers before trusting transcript claims.",
    "- Check workProducts, verdict rows, delivery readback, and activity log when this issue gates downstream work.",
  ].join("\n");
}

export async function persistTerminalIssueHandoff(input: {
  db: Db;
  issue: TerminalIssueRow;
  previousIssue: TerminalIssueRow;
}) {
  if (!input.issue.missionId) return null;
  const [mission] = await input.db
    .select({ ownerAgentId: missions.ownerAgentId })
    .from(missions)
    .where(eq(missions.id, input.issue.missionId))
    .limit(1);
  const agentId = input.issue.assigneeAgentId ?? input.previousIssue.assigneeAgentId ?? mission?.ownerAgentId ?? null;
  if (!agentId) return null;

  const linkedRunId = input.previousIssue.executionRunId ?? input.previousIssue.checkoutRunId ?? null;
  const handoffMarkdown = renderTerminalIssueHandoff({
    issue: input.issue,
    previousStatus: input.previousIssue.status,
    runId: linkedRunId,
  });
  const contentHash = sha256Text(handoffMarkdown);
  const evidenceRefsJson: MissionIssueHandoffEvidenceRef[] = [
    { type: "issue", id: input.issue.id, description: `Issue entered ${input.issue.status}` },
    ...(linkedRunId ? [{ type: "heartbeat_run", id: linkedRunId, description: "Run linked before terminal status update" }] : []),
  ];
  const [handoff] = await input.db
    .insert(missionIssueHandoffs)
    .values({
      companyId: input.issue.companyId,
      missionId: input.issue.missionId,
      issueId: input.issue.id,
      agentId,
      runId: null,
      status: input.issue.status,
      contentHash,
      handoffMarkdown,
      handoffJson: {
        issueGoal: input.issue.description ?? input.issue.title,
        actionsTaken: [`Issue status changed from ${input.previousIssue.status} to ${input.issue.status}.`],
        evidence: evidenceRefsJson,
        importantCaveats: ["This closeout is generated from issue status state; verify comments, ledgers, and workProducts separately."],
        stateDelta: { status: input.issue.status, previousStatus: input.previousIssue.status, linkedRunId },
        recommendedNextPrompt: `Continue mission ${input.issue.missionId}; use terminal handoff for issue ${input.issue.id} as context only after checking ledgers.`,
      },
      evidenceRefsJson,
    })
    .onConflictDoUpdate({
      target: [
        missionIssueHandoffs.companyId,
        missionIssueHandoffs.issueId,
        missionIssueHandoffs.status,
        missionIssueHandoffs.contentHash,
      ],
      set: { updatedAt: new Date() },
    })
    .returning();
  return handoff ?? null;
}
