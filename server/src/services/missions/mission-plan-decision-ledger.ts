import { missionPlanDecisionSubmissions, type Db } from "@paperclipai/db";

export type MissionPlanDecisionLedgerStatus = "submitted" | "plan_qa_pending" | "rejected" | "recorded";

export type MissionPlanDecisionLedgerDiagnostic = {
  readonly code?: string;
  readonly message?: string;
  readonly commentId?: string;
  readonly [key: string]: unknown;
};

export function isRejectedMissionPlanDecisionSubmissionStatus(status: string): boolean {
  return status === "rejected" || status === "invalid";
}

export function formatMissionPlanDecisionSubmissionDiagnostics(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return "";
      const code = "code" in entry ? entry.code : undefined;
      const message = "message" in entry ? entry.message : undefined;
      return [code, message].filter((part): part is string => typeof part === "string" && part.length > 0).join(": ");
    })
    .filter((line) => line.length > 0)
    .join("; ");
}

export async function upsertMissionPlanDecisionSubmission(input: {
  readonly db: Db;
  readonly companyId: string;
  readonly missionId: string;
  readonly planningIssueId: string | null;
  readonly authorAgentId?: string | null;
  readonly authorUserId?: string | null;
  readonly sourceRunId?: string | null;
  readonly sourceCommentId?: string | null;
  readonly decisionHash: string;
  readonly decision: Record<string, unknown>;
  readonly status: MissionPlanDecisionLedgerStatus;
  readonly rejectionReason?: string | null;
  readonly diagnostics?: readonly MissionPlanDecisionLedgerDiagnostic[];
}): Promise<void> {
  const now = new Date();
  const diagnostics = [...(input.diagnostics ?? [])];
  const rejectionReason = input.status === "rejected" ? input.rejectionReason ?? null : null;
  const storedDiagnostics = input.status === "rejected" ? diagnostics : [];

  await input.db
    .insert(missionPlanDecisionSubmissions)
    .values({
      companyId: input.companyId,
      missionId: input.missionId,
      planningIssueId: input.planningIssueId,
      authorAgentId: input.authorAgentId ?? null,
      authorUserId: input.authorUserId ?? null,
      sourceRunId: input.sourceRunId ?? null,
      sourceCommentId: input.sourceCommentId ?? null,
      decisionHash: input.decisionHash,
      decision: input.decision,
      status: input.status,
      rejectionReason,
      diagnostics: storedDiagnostics,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        missionPlanDecisionSubmissions.companyId,
        missionPlanDecisionSubmissions.missionId,
        missionPlanDecisionSubmissions.decisionHash,
      ],
      set: {
        planningIssueId: input.planningIssueId,
        authorAgentId: input.authorAgentId ?? null,
        authorUserId: input.authorUserId ?? null,
        sourceRunId: input.sourceRunId ?? null,
        sourceCommentId: input.sourceCommentId ?? null,
        decision: input.decision,
        status: input.status,
        rejectionReason,
        diagnostics: storedDiagnostics,
        updatedAt: now,
      },
    });
}
