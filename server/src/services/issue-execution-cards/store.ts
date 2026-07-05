import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueExecutionCards, type IssueExecutionCardJson, type issues } from "@paperclipai/db";
import { hashStructuredValue, sha256Text } from "./hash.js";

type IssueExecutionCardDb = Pick<Db, "select" | "insert" | "update">;
type IssueRow = Pick<typeof issues.$inferSelect, "companyId" | "id" | "missionId" | "description">;

export type IssueExecutionCardRow = typeof issueExecutionCards.$inferSelect;

export async function upsertIssueExecutionCard(input: {
  db: IssueExecutionCardDb;
  companyId: string;
  issueId: string;
  missionId?: string | null;
  workflowRunId?: string | null;
  workflowStepRunId?: string | null;
  card: IssueExecutionCardJson;
}): Promise<IssueExecutionCardRow> {
  const now = new Date();
  const contentHash = hashStructuredValue(input.card);
  const [row] = await input.db
    .insert(issueExecutionCards)
    .values({
      companyId: input.companyId,
      issueId: input.issueId,
      missionId: input.missionId ?? null,
      workflowRunId: input.workflowRunId ?? null,
      workflowStepRunId: input.workflowStepRunId ?? null,
      cardVersion: input.card.version,
      contentHash,
      cardJson: input.card,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [issueExecutionCards.companyId, issueExecutionCards.issueId],
      set: {
        missionId: input.missionId ?? null,
        workflowRunId: input.workflowRunId ?? null,
        workflowStepRunId: input.workflowStepRunId ?? null,
        cardVersion: input.card.version,
        contentHash,
        cardJson: input.card,
        updatedAt: now,
      },
    })
    .returning();
  if (!row) throw new Error("issue execution card upsert returned no row");
  return row;
}

export async function getIssueExecutionCard(input: {
  db: IssueExecutionCardDb;
  companyId: string;
  issueId: string;
}): Promise<IssueExecutionCardRow | null> {
  return input.db
    .select()
    .from(issueExecutionCards)
    .where(and(
      eq(issueExecutionCards.companyId, input.companyId),
      eq(issueExecutionCards.issueId, input.issueId),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

export function cardDescriptionDrift(input: {
  issue: IssueRow;
  card: IssueExecutionCardRow | null;
}): boolean {
  if (!input.card) return false;
  return input.card.cardJson.source.descriptionHash !== sha256Text(input.issue.description ?? "");
}
