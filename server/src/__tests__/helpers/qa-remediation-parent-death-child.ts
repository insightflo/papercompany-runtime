import { createDb } from "@paperclipai/db";
import { QaRemediationFileOwner } from "../../services/workflow/control-flow/qa-remediation-file-owner.js";
import type { QaFileOwnerRuntime } from "../../services/workflow/control-flow/qa-remediation-runtime.js";
import { reconcileQaRemediationReservation } from "../../services/workflow/control-flow/qa-remediation-reconcile.js";
import {
  createReplacementRootNotifications, withReplacementRootNotificationDb,
} from "../../services/issue-assignment-wakeup.js";

interface Context {
  readonly databaseUrl: string;
  readonly appName: string;
  readonly lockRoot: string;
  readonly pythonCommand: string;
  readonly helperPath: string;
  readonly request: Parameters<typeof reconcileQaRemediationReservation>[1];
}

function emit(kind: string, values: Record<string, unknown> = {}) {
  process.stdout.write(`${JSON.stringify({ kind, ...values })}\n`);
}

const rawContext = process.env.C5_PARENT_DEATH_CONTEXT;
if (!rawContext) throw new Error("C5_PARENT_DEATH_CONTEXT is required");
const context = JSON.parse(rawContext) as Context;
const db = createDb(context.databaseUrl);
const runtime: QaFileOwnerRuntime = {
  capability: Promise.resolve({ status: "configured", scope: "configuration-only", lockRoot: context.lockRoot,
    pythonCommand: context.pythonCommand, helperPath: context.helperPath }),
  begin(targets, options) {
    return QaRemediationFileOwner.begin({ lockRoot: context.lockRoot, targets, pythonCommand: context.pythonCommand,
      helperPath: context.helperPath, onEvent: options?.onEvent, signal: options?.signal });
  },
};
const notifications = createReplacementRootNotifications();
process.on("unhandledRejection", (reason) => emit("unhandled", { message: reason instanceof Error ? reason.message : String(reason) }));
emit("root_started", { pid: process.pid, argv: process.argv, cwd: process.cwd(), appName: context.appName,
  companyId: context.request.companyId, missionId: context.request.missionId,
  workflowRunId: context.request.workflowRunId, producerStepRunId: context.request.producerStepRunId });
try {
  const result = await withReplacementRootNotificationDb(db, notifications,
    () => reconcileQaRemediationReservation(db, context.request, runtime));
  emit("root_result", { outcome: result.outcome, reason: "reason" in result ? result.reason : null,
    notificationAgents: [...notifications.agentIds], correctionWakes: [...notifications.correctionWakeupRequestIds] });
} catch (error) {
  emit("root_error", { name: error instanceof Error ? error.name : "unknown", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  await db.$client.end({ timeout: 5 });
}
