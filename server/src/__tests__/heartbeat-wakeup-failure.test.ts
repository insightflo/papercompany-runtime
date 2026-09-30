import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { agents, agentWakeupRequests, heartbeatRuns } from "@paperclipai/db";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { seedQualityFixture } from "./helpers/quality-fixture.js";
import { deliverQualityIntent } from "../services/quality/native-delivery.js";
import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute }), runningProcesses: new Map(),
}));

describeQualityDb("adapter exception wake finalization", () => {
  let owned: QualityTestDb;
  let home: string;
  const originalHome = process.env.PAPERCLIP_HOME;
  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "wake-failure-"));
    process.env.PAPERCLIP_HOME = home;
    owned = await createQualityTestDb();
  }, 180_000);
  afterAll(async () => {
    if (owned) await waitForHeartbeatExecutionsToDrain(owned.db, 20_000);
    await owned?.close();
    if (originalHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalHome;
    if (home) await rm(home, { recursive: true, force: true });
  });

  it.each([false, true])("preserves genuine adapter failure with late wake cancellation=%s", async (lateCancel) => {
    const db = owned.db;
    const seeded = await seedQualityFixture(db);
    await db.update(agents).set({ adapterType: "codex_local", adapterConfig: { promptTemplate: "Test." }, runtimeConfig: {}, permissions: {} })
      .where(eq(agents.companyId, seeded.companyId));
    execute.mockReset().mockRejectedValue(new Error("test adapter failure"));
    // DB trigger deterministically places a cancellation after the successful run
    // failure transition, but before the catch handler's wake-failure update.
    if (lateCancel) await db.execute(sql.raw(`
      create function test_cancel_wake_after_run_failure() returns trigger language plpgsql as $$ begin
        if NEW.company_id='${seeded.companyId}' and OLD.status='running' and NEW.status='failed' then
          update agent_wakeup_requests set status='cancelled', error='late cancellation', finished_at=now()
            where id=NEW.wakeup_request_id and run_id=NEW.id and company_id=NEW.company_id;
        end if; return NEW; end $$;
      create trigger test_cancel_wake_after_run_failure after update on heartbeat_runs
        for each row execute function test_cancel_wake_after_run_failure();`));
    try {
      const delivered = await deliverQualityIntent(db, { companyId: seeded.companyId, actionId: seeded.actionId });
      expect(delivered.status).toBe("accepted");
      await waitForHeartbeatExecutionsToDrain(db, 20_000);
      const [wake] = await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, seeded.companyId), eq(agentWakeupRequests.id, delivered.receiptId!),
      ));
      const [run] = await db.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, seeded.companyId), eq(heartbeatRuns.id, wake!.runId!),
      ));
      expect(execute).toHaveBeenCalledTimes(1);
      expect(run).toMatchObject({ status: "failed", errorCode: "adapter_failed", error: "test adapter failure" });
      expect(wake).toMatchObject(lateCancel
        ? { status: "cancelled", error: "late cancellation" }
        : { status: "failed", error: "test adapter failure" });
      expect(wake!.finishedAt).not.toBeNull();
    } finally {
      if (lateCancel) await db.execute(sql.raw("drop trigger test_cancel_wake_after_run_failure on heartbeat_runs; drop function test_cancel_wake_after_run_failure();"));
    }
  });
});
