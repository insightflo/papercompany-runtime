import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";
import { logger } from "../middleware/logger.js";

/**
 * Operator interrupt inbox (schema-free, file-based).
 *
 * When a board user comments on an issue that has a queued/running heartbeat
 * run, the server drops a small JSON file into the run's agent home:
 *   <agentHome>/interrupts/issue-<issueId>.json
 * The pi_local adapter polls that path mid-run and injects the body into the
 * live child stdin as a new RPC prompt command (see
 * packages/adapters/pi-local/src/server/operator-interrupt.ts).
 *
 * The file is a transport hint, not an execution authority: consumers must
 * treat the payload as an operator message to surface to the agent, nothing
 * more. Failures here must never affect comment creation itself.
 */
export const OPERATOR_INTERRUPT_RUN_STATUSES = ["queued", "running"] as const;

export function operatorInterruptFilePath(agentHome: string, issueId: string): string {
  return path.join(agentHome, "interrupts", `issue-${issueId}.json`);
}

export interface OperatorInterruptDeliveryInput {
  db: Db;
  companyId: string;
  issueId: string;
  commentId: string;
  body: string;
  createdAt?: Date | string | null;
}

/**
 * Write the interrupt inbox file for every agent with a queued/running run on
 * the issue. Best-effort: callers wrap in try/catch and log-only on failure.
 */
export async function deliverOperatorInterruptForIssueComment(
  input: OperatorInterruptDeliveryInput,
): Promise<void> {
  const rows = await input.db
    .select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.issueId, input.issueId),
        inArray(heartbeatRuns.status, [...OPERATOR_INTERRUPT_RUN_STATUSES]),
      ),
    );
  if (rows.length === 0) return;

  const createdAt =
    input.createdAt instanceof Date
      ? input.createdAt.toISOString()
      : (input.createdAt ?? new Date().toISOString());
  const agentIds = [...new Set(rows.map((row) => row.agentId))];

  for (const agentId of agentIds) {
    try {
      const agentHome = resolveDefaultAgentWorkspaceDir(agentId);
      const payload = {
        commentId: input.commentId,
        body: input.body,
        createdAt,
        issueId: input.issueId,
      };
      await fs.mkdir(path.join(agentHome, "interrupts"), { recursive: true });
      await fs.writeFile(operatorInterruptFilePath(agentHome, input.issueId), JSON.stringify(payload), "utf8");
    } catch (err) {
      logger.warn(
        { err, issueId: input.issueId, agentId, commentId: input.commentId },
        "failed to write operator interrupt inbox file",
      );
    }
  }
}
