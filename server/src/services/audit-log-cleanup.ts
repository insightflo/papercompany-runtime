/**
 * Audit Log TTL Cleanup Job
 *
 * Deletes old audit log records according to retention policies:
 * - worktree_audit_log: 90 days
 * - tool_audit_log: 90 days
 * - srb_delivery_log: 30 days
 * - srb_nonces: 10 minutes (handled separately by nonce-cleanup.ts)
 *
 * Runs once per hour.
 */

import type { Db } from "@paperclipai/db";
import { worktreeAuditLog, toolAuditLog, srbDeliveryLog } from "@paperclipai/db";
import { lt } from "drizzle-orm";
import { logger } from "../middleware/logger.js";

const WORKTREE_AUDIT_LOG_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const TOOL_AUDIT_LOG_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const SRB_DELIVERY_LOG_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Run a single cleanup cycle.
 */
export async function runAuditLogCleanup(db: Db): Promise<{
  worktreeAuditLogDeleted: number;
  toolAuditLogDeleted: number;
  srbDeliveryLogDeleted: number;
}> {
  const now = Date.now();

  const [wt, tool, srb] = await Promise.all([
    db
      .delete(worktreeAuditLog)
      .where(lt(worktreeAuditLog.createdAt, new Date(now - WORKTREE_AUDIT_LOG_TTL_MS)))
      .returning({ id: worktreeAuditLog.id }),
    db
      .delete(toolAuditLog)
      .where(lt(toolAuditLog.createdAt, new Date(now - TOOL_AUDIT_LOG_TTL_MS)))
      .returning({ id: toolAuditLog.id }),
    db
      .delete(srbDeliveryLog)
      .where(lt(srbDeliveryLog.createdAt, new Date(now - SRB_DELIVERY_LOG_TTL_MS)))
      .returning({ id: srbDeliveryLog.id }),
  ]);

  return {
    worktreeAuditLogDeleted: wt.length,
    toolAuditLogDeleted: tool.length,
    srbDeliveryLogDeleted: srb.length,
  };
}

/**
 * Create the audit log cleanup background job.
 */
export function createAuditLogCleanupJob(db: Db) {
  let timer: ReturnType<typeof setInterval> | null = null;

  async function run(): Promise<void> {
    try {
      const result = await runAuditLogCleanup(db);
      const total = result.worktreeAuditLogDeleted + result.toolAuditLogDeleted + result.srbDeliveryLogDeleted;
      if (total > 0) {
        logger.info(result, "Audit log cleanup: deleted expired records");
      }
    } catch (err) {
      logger.error({ err }, "Audit log cleanup: failed");
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => void run(), CLEANUP_INTERVAL_MS);
      void run();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
