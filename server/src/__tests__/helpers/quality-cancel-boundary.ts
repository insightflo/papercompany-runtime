import { and, eq } from "drizzle-orm";
import { agentWakeupRequests, effectIntents, heartbeatRuns, type Db } from "@paperclipai/db";
import { expect } from "vitest";
import { waitForHeartbeatExecutionsToDrain } from "../../services/heartbeat-execution-tracker.js";
import { HEARTBEAT_ADAPTER_EXECUTE_EFFECT_KIND } from "../../services/effect-envelope.js";

/** A cancelled runner must finish serialization, reach the guarded effect boundary,
 * and exit without starting the adapter. A deadlock/setup failure has no such receipt. */
export async function expectCancelledAdapterBoundary(db: Db, companyId: string, runId: string) {
  await waitForHeartbeatExecutionsToDrain(db, 20_000);
  const effects = await db.select().from(effectIntents).where(and(
    eq(effectIntents.companyId, companyId), eq(effectIntents.attemptRunId, runId),
    eq(effectIntents.effectKind, HEARTBEAT_ADAPTER_EXECUTE_EFFECT_KIND),
  ));
  expect(effects).toHaveLength(1);
  expect(effects[0]).toMatchObject({
    status: "intent", appliedAt: null,
    resultSummary: { error: "heartbeat_execution_cancelled_or_scope_changed" },
  });
  const [run] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId),
  ));
  expect(run).toMatchObject({ status: "cancelled", exitCode: null, processLossRetryCount: 0 });
  const [wake] = await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.id, run!.wakeupRequestId!),
    eq(agentWakeupRequests.runId, runId),
  ));
  expect(wake).toMatchObject({ status: "cancelled" });
  expect(await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.retryOfRunId, runId),
  ))).toHaveLength(0);
}
