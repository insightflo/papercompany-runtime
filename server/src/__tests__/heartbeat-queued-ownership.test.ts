import { calls, database, peerDatabase, drainOwner, drainPeer, evidence, finish,
  queuedWorld, readIssue, readRun, readWake, started, startQa } from "./heartbeat-queued-ownership-fixture.js";
import { eq, sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, heartbeatRuns, issues } from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";

// Independent oracle: document O1/O2, SPEC-implementation.md task ownership,
// and the observed QA -> queued_wakeup_promoted overwrite. The same tests and
// assertions run on the input head and candidate; no baseline-specific branch.
it.each([false, true])("O1 preserves reassigned QA ownership after owner release (finalization=%s)", async enabled => {
  const w = await queuedWorld(enabled);
  await evidence("O1_queued_without_run", w);
  const qaRunId = await startQa(w, true), before = await readIssue(w.issueId);
  await evidence("O1_qa_adapter_pending", w);
  finish(w.ownerRunId);
  try {
    await vi.waitFor(async () => {
      const wake = await readWake(w.request.id);
      // Baseline may start an unwanted held adapter; capture that counterexample
      // before asserting the contract, instead of hanging while draining it.
      expect(wake.status === "completed" || calls.some(c => c.runId === wake.runId)).toBe(true);
    }, { timeout: 10_000 });
  } finally { await evidence("O1_after_owner_release", w); }
  expect(await readIssue(w.issueId)).toEqual(before);
  expect(await readRun(qaRunId)).toMatchObject({ status: "running" });
  expect(calls.filter(c => c.agentId === w.owner.id).map(c => c.runId)).toEqual([w.ownerRunId]);
  expect(await readWake(w.request.id)).toMatchObject({ status: "completed", runId: null, error: null });
  expect((await readWake(w.request.id)).finishedAt).not.toBeNull();
  expect(await peerDatabase().select().from(heartbeatRuns)
    .where(eq(heartbeatRuns.wakeupRequestId, w.request.id))).toHaveLength(0);
  await drainOwner();
}, 30_000);

it.each(["both", "checkout", "legacy"] as const)(
  "O2 retains a valid queued request during %s ownership and delivers it once after release", async linkage => {
    const w = await queuedWorld();
    const qaRunId = await startQa(w, false);
    // Exercise legacy shapes with a REAL pending adapter, never fake a running status.
    if (linkage !== "both") await database().update(issues).set({
      executionRunId: null, ...(linkage === "legacy" ? { checkoutRunId: null } : {}),
    }).where(eq(issues.id, w.issueId));
    if (linkage === "legacy") await database().update(heartbeatRuns).set({ issueId: null })
      .where(eq(heartbeatRuns.id, qaRunId));
    const before = await readIssue(w.issueId);
    await evidence("O2_" + linkage + "_adapter_pending", w);
    finish(w.ownerRunId);
    try { await drainOwner(5_000); }
    finally { await evidence("O2_" + linkage + "_after_owner_release", w); }
    await w.service.resumeQueuedRuns(w.owner.id);
    await heartbeatService(peerDatabase()).resumeQueuedRuns(w.owner.id);
    expect(await readIssue(w.issueId)).toEqual(before);
    expect(await readWake(w.request.id)).toMatchObject({
      status: "queued", runId: null, error: null, finishedAt: null,
    });
    expect(calls.filter(c => c.agentId === w.owner.id).map(c => c.runId)).toEqual([w.ownerRunId]);
    finish(qaRunId);
    await drainPeer();
    expect(await readRun(qaRunId)).toMatchObject({ status: "succeeded" });
    expect(await readIssue(w.issueId)).toMatchObject({ executionRunId: null, checkoutRunId: null });
    // These are the existing public entry points used by recovery at
    // heartbeat.ts:5753 / heartbeat-scheduler.ts:172, including fresh discovery.
    await Promise.all([w.service.resumeQueuedRuns(), heartbeatService(peerDatabase()).resumeQueuedRuns()]);
    const followupRunId = await started(w.owner.id, 2);
    await evidence("O2_" + linkage + "_delivered", w);
    expect(await readWake(w.request.id)).toMatchObject({ status: "claimed", runId: followupRunId, error: null });
    expect(await readIssue(w.issueId)).toMatchObject({
      assigneeAgentId: w.owner.id, executionRunId: followupRunId, checkoutRunId: followupRunId,
    });
    await Promise.all([w.service.resumeQueuedRuns(), heartbeatService(peerDatabase()).resumeQueuedRuns()]);
    expect(calls.filter(c => c.agentId === w.owner.id).map(c => c.runId))
      .toEqual([w.ownerRunId, followupRunId]);
    expect(await peerDatabase().select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.wakeupRequestId, w.request.id))).toHaveLength(1);
  }, 30_000);

it("O1/O2 skips a locked issue without holding up issue -> wake release, then retries normally", async () => {
  const w = await queuedWorld();
  await peerDatabase().transaction(async tx => {
    await tx.execute(sql`set local lock_timeout = '2s'`);
    await tx.select().from(issues).where(eq(issues.id, w.issueId)).for("update");
    finish(w.ownerRunId);
    // Finishing the real owner invokes queue promotion while this transaction
    // owns the issue. A blocking wake -> issue acquisition cannot finish here.
    try { await drainOwner(5_000); }
    finally { await evidence("O1_O2_issue_lock_contended", w); }
    await tx.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, w.request.id)).for("update");
    expect(await readWake(w.request.id)).toMatchObject({ status: "queued", runId: null, error: null });
  });
  await w.service.resumeQueuedRuns();
  const followupRunId = await started(w.owner.id, 2);
  expect(await readWake(w.request.id)).toMatchObject({ status: "claimed", runId: followupRunId });
  await evidence("O1_O2_issue_lock_retried", w);
}, 30_000);

it("O2 completes an assignment that was withdrawn without creating a failed run", async () => {
  const w = await queuedWorld();
  await database().update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, w.issueId));
  const before = await readIssue(w.issueId);
  finish(w.ownerRunId);
  try {
    await vi.waitFor(async () => {
      const wake = await readWake(w.request.id);
      expect(wake.status === "completed" || calls.some(c => c.runId === wake.runId)).toBe(true);
    }, { timeout: 10_000 });
  } finally { await evidence("O2_assignment_withdrawn", w); }
  expect(await readIssue(w.issueId)).toEqual(before);
  expect(await readWake(w.request.id)).toMatchObject({ status: "completed", runId: null, error: null });
  expect(calls.filter(c => c.agentId === w.owner.id).map(c => c.runId)).toEqual([w.ownerRunId]);
}, 30_000);

it("preserves initial mention admission while another agent owns the issue", async () => {
  const w = await queuedWorld(), qaRunId = await startQa(w, true);
  await database().update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 2 } } })
    .where(eq(agents.id, w.owner.id));
  const mention = await w.service.wakeup(w.owner.id, { source: "on_demand", reason: "issue_comment_mentioned",
    payload: { issueId: w.issueId, missionId: w.missionId },
    contextSnapshot: { issueId: w.issueId, missionId: w.missionId } });
  expect(mention).not.toBeNull();
  expect(await started(w.owner.id, 2)).toBe(mention!.id);
  expect(await readIssue(w.issueId)).toMatchObject({
    assigneeAgentId: w.qa.id, executionRunId: qaRunId, checkoutRunId: qaRunId,
  });
  await evidence("initial_mention_exception", w);
}, 30_000);
