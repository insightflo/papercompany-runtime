import { and, asc, desc, eq, isNotNull, sql } from "drizzle-orm";
import { issueComments, issues, type Db } from "@paperclipai/db";
import { capWakeRecentCommentBody } from "./wake-context-hygiene.js";

export async function assembleIssueCommentContext(
  db: Db, companyId: string, issueId: string | null, context: Record<string, unknown>,
) {
  delete context.paperclipIssueRecentComments;
  delete context.paperclipOperatorInstructionsUnconsumed;
  if (!issueId) return null;
  const scope = and(eq(issueComments.issueId, issueId), eq(issueComments.companyId, companyId));
  const recent = await db.select().from(issueComments).where(scope)
    .orderBy(desc(issueComments.createdAt), desc(issueComments.id)).limit(5);
  if (recent.length) context.paperclipIssueRecentComments = recent.map((comment) => ({
    id: comment.id,
    authorType: comment.authorUserId ? "controller" : comment.authorAgentId ? "agent" : "unknown",
    authorAgentId: comment.authorAgentId, authorUserId: comment.authorUserId,
    body: capWakeRecentCommentBody(comment.body), createdAt: comment.createdAt.toISOString(),
  }));
  // Read the cursor in SQL to retain PostgreSQL timestamp precision. Take the oldest
  // batch so advancing to its maximum cannot skip a backlog larger than ten.
  const pending = await db.select({ id: issueComments.id, body: issueComments.body, createdAt: issueComments.createdAt })
    .from(issueComments).innerJoin(issues, and(eq(issues.id, issueComments.issueId), eq(issues.companyId, companyId)))
    .where(and(scope, isNotNull(issueComments.authorUserId), sql`(
      (${issues.lastOperatorInstructionAt} is null and ${issueComments.createdAt} >= now() - interval '24 hours')
      or (${issueComments.createdAt}, ${issueComments.id}) >
        (${issues.lastOperatorInstructionAt}, coalesce(${issues.lastOperatorInstructionCommentId}, '00000000-0000-0000-0000-000000000000'::uuid))
    )`))
    .orderBy(asc(issueComments.createdAt), asc(issueComments.id)).limit(10);
  pending.reverse();
  context.paperclipOperatorInstructionsUnconsumed = pending.map((comment) => ({
    id: comment.id, body: capWakeRecentCommentBody(comment.body), createdAt: comment.createdAt.toISOString(),
  }));
  return pending[0]?.id ?? null;
}

export async function advanceOperatorInstructionCursor(db: Db, companyId: string, issueId: string, commentId: string) {
  // Adapter-boundary consumption, not model-receipt proof. No locks/fencing here.
  // Select the persisted timestamp rather than round-tripping through JS milliseconds.
  await db.execute(sql`update ${issues} set
    last_operator_instruction_at = c.created_at,
    last_operator_instruction_comment_id = c.id
    from ${issueComments} c
    where ${issues.id} = ${issueId} and ${issues.companyId} = ${companyId}
      and c.id = ${commentId} and c.issue_id = ${issues.id} and c.company_id = ${companyId}
      and c.author_user_id is not null
      and (${issues.lastOperatorInstructionAt} is null or
        (${issues.lastOperatorInstructionAt}, coalesce(${issues.lastOperatorInstructionCommentId}, '00000000-0000-0000-0000-000000000000'::uuid))
          < (c.created_at, c.id))`);
}
