import { spawn, type ChildProcess } from "node:child_process";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agentWikiEntries,
  agents,
  approvals,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueApprovals,
  issues,
  operatorDecisions,
  workflowTransitionEvents,
} from "@paperclipai/db";
import { runningProcesses } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { approvalWaitFixtures } from "./helpers/approval-wait-fixtures.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// [approval-waiting marker] 로드맵 ④ 표면 (ii) — stale/reaper 스위프 면제.
// pending 운영자 결정/승인 대기 중인 런/웨이크업은 stuck 이 아니라 사람 대기다.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const SWEEP_OPTS = {
  staleThresholdMs: 60_000,
  activeExecutionTimeoutMs: 60_000,
  queuedStaleThresholdMs: 60_000,
} as const;

describeEmbeddedPostgres("operator approval wait sweep exemptions", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let fixtures: ReturnType<typeof approvalWaitFixtures>;
  const childProcesses = new Set<ChildProcess>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-approval-wait-sweeps-");
    db = createDb(tempDb.connectionString);
    fixtures = approvalWaitFixtures(db);
  }, 60_000);

  afterEach(async () => {
    // fire-and-forget wiki hook 이 settle 한 뒤 정리한다(기존 recovery 테스트 관례).
    await new Promise((resolve) => setTimeout(resolve, 50));
    runningProcesses.clear();
    for (const child of childProcesses) child.kill("SIGKILL");
    childProcesses.clear();
    await db.delete(workflowTransitionEvents);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueApprovals);
    await db.delete(operatorDecisions);
    await db.delete(approvals);
    await db.delete(issues);
    await db.delete(agentWikiEntries);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function runRow(runId: string) {
    const [row] = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    return row ?? null;
  }

  it("keeps a stale queued run queued while its issue waits on a pending decision", async () => {
    const { companyId, agentId, issueId } = await fixtures.seedBase();
    const decisionId = await fixtures.seedPendingDecision(companyId, issueId);
    const { runId } = await fixtures.seedRun({ companyId, agentId, issueId, status: "queued" });

    const exempted = await heartbeatService(db).reapOrphanedRuns(SWEEP_OPTS);
    expect(exempted.reaped).toBe(0);
    expect(await runRow(runId)).toEqual({ status: "queued", errorCode: null });

    await db
      .update(operatorDecisions)
      .set({ status: "cancelled", cancelledAt: new Date() })
      .where(eq(operatorDecisions.id, decisionId));
    const enforced = await heartbeatService(db).reapOrphanedRuns(SWEEP_OPTS);
    expect(enforced.reaped).toBe(1);
    const row = await runRow(runId);
    expect(row?.status).toBe("failed");
    expect(row?.errorCode).toBe("stale_queued");
  });

  it("still fails an unrelated stale queued run with no pending decision", async () => {
    const { companyId, agentId, issueId } = await fixtures.seedBase();
    const { runId } = await fixtures.seedRun({ companyId, agentId, issueId, status: "queued" });

    const result = await heartbeatService(db).reapOrphanedRuns(SWEEP_OPTS);
    expect(result.reaped).toBe(1);
    const row = await runRow(runId);
    expect(row?.status).toBe("failed");
    expect(row?.errorCode).toBe("stale_queued");
  });

  it("keeps an orphan queued wakeup while its issue waits on a pending decision", async () => {
    const { companyId, agentId, issueId } = await fixtures.seedBase();
    await fixtures.seedPendingDecision(companyId, issueId);
    const { wakeupId } = await fixtures.seedRun({ companyId, agentId, issueId, status: "queued", withRunRow: false });

    const result = await heartbeatService(db).reapOrphanedRuns(SWEEP_OPTS);
    expect(result.reaped).toBe(0);
    const [wakeup] = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupId));
    expect(wakeup?.status).toBe("queued");
  });

  it("defers the execution stale timeout for a live run waiting on a pending decision", async () => {
    const child = spawn("sleep", ["60"]);
    childProcesses.add(child);
    const { companyId, agentId, issueId } = await fixtures.seedBase();
    const decisionId = await fixtures.seedPendingDecision(companyId, issueId);
    const { runId } = await fixtures.seedRun({ companyId, agentId, issueId, status: "running" });
    runningProcesses.set(runId, { child, graceSec: 5 });

    const heartbeat = heartbeatService(db);
    const exempted = await heartbeat.reapOrphanedRuns({ ...SWEEP_OPTS, queuedStaleThresholdMs: 0 });
    expect(exempted.reaped).toBe(0);
    expect((await runRow(runId))?.status).toBe("running");

    await db
      .update(operatorDecisions)
      .set({ status: "cancelled", cancelledAt: new Date() })
      .where(eq(operatorDecisions.id, decisionId));
    const enforced = await heartbeat.reapOrphanedRuns({ ...SWEEP_OPTS, queuedStaleThresholdMs: 0 });
    expect(enforced.reaped).toBe(1);
    const row = await runRow(runId);
    expect(row?.status).toBe("timed_out");
    expect(row?.errorCode).toBe("execution_stale_timeout");
  });
});
