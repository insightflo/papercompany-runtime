import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { agents, agentWakeupRequests, heartbeatRuns, issueWorkProducts, missions, workflowRuns,
  workflowStepOutputBindings, workflowTransitionEvents } from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import { missionService } from "../services/missions.js";
import { readWorkflowAttemptProof } from "../services/heartbeat-finalization/workflow-attempt-proof.js";
import { drainReplacementRootNotifications } from "../services/workflow/replacement-agent-delivery.js";
import { hashQaCorrectionPayload } from "../services/workflow/control-flow/qa-correction-contract.js";
import { readQaCorrectionWakeRef } from "../services/work-products/qa-correction-producer-attempt.js";
import type { QaFileOwnerRuntime } from "../services/workflow/control-flow/qa-remediation-runtime.js";
import { createHeartbeatC5PublicFixture, deferred, within, type HeartbeatC5PublicFixture } from "./helpers/heartbeat-c5-public-fixture.js";
import { createHeartbeatC5PublicLifecycle } from "./helpers/heartbeat-c5-public-lifecycle.js";

const adapter = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute: adapter }),
  runningProcesses: new Map(),
}));

let fixture: HeartbeatC5PublicFixture;
let fixtureOwnerRuntime: QaFileOwnerRuntime | null = null;
let onFixtureOwnerLockWait: () => void = () => {};
const lifecycles: Array<Awaited<ReturnType<typeof createHeartbeatC5PublicLifecycle>>> = [];

beforeAll(async () => { fixture = await createHeartbeatC5PublicFixture(); }, 60_000);
afterAll(async () => {
  for (const lifecycle of lifecycles) {
    lifecycle.releaseProducerActual();
    lifecycle.releaseQaActual();
  }
  await fixture.cleanup();
});
beforeEach(() => { adapter.mockReset(); });

it("S1: typed claim hold preserves C while same-agent U and separate U progress", async () => {
  const lifecycle = await createHeartbeatC5PublicLifecycle(fixture);
  lifecycles.push(lifecycle);
  adapter.mockImplementation(lifecycle.executeActual);
  const ownerRuntime = lifecycle.ownerRuntime(() => onFixtureOwnerLockWait());
  fixtureOwnerRuntime = ownerRuntime;
  const optedService = heartbeatService(fixture.db, { qaCorrectionExecution: { ownerRuntime } });
  let heldArtifact: Awaited<ReturnType<typeof lifecycle.holdArtifact>> | null = null;
  try {
    const producer = await lifecycle.startProducer();
    if (!producer?.id || !producer.wakeupRequestId) throw new Error("S1 public producer wake lacks its durable run binding");
    const producerRunId = await within(lifecycle.producerEntered, "S1 producer adapter entry");
    await within(lifecycle.producerWorkCompleted, "S1 official producer artifact and issue completion");
    const qaRunId = await within(lifecycle.qaVerdictSubmitted, "S1 official QA request-changes verdict");
    expect(producer.id).toBe(producerRunId);

    const producerBefore = await lifecycle.readIdentity(producerRunId);
    const qaBefore = await lifecycle.readIdentity(qaRunId);
    expect(producerBefore.heartbeat).toMatchObject({ id: producerRunId, status: "running", issueId: lifecycle.producerIssueId });
    expect(producerBefore.wake).toMatchObject({ id: producer.wakeupRequestId, runId: producerRunId,
      workflowRunId: lifecycle.runId, workflowStepRunId: lifecycle.producerStep.id });
    expect(qaBefore.heartbeat).toMatchObject({ id: qaRunId, status: "running", issueId: lifecycle.qaIssueId });
    const verdicts = await fixture.peer.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, lifecycle.companyId),
      eq(workflowTransitionEvents.workflowRunId, lifecycle.runId),
      eq(workflowTransitionEvents.workflowStepRunId, lifecycle.qaStep.id),
      eq(workflowTransitionEvents.issueId, lifecycle.qaIssueId),
      eq(workflowTransitionEvents.heartbeatRunId, qaRunId),
      eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
      eq(workflowTransitionEvents.verdict, "request_changes")));
    expect(verdicts).toHaveLength(1);

    lifecycle.releaseProducerActual();
    await vi.waitFor(async () => {
      const settled = await lifecycle.readIdentity(producerRunId);
      expect(settled.heartbeat).toMatchObject({ id: producerRunId, status: "succeeded",
        resultJson: { stdout: "c5-public-producer", stderr: "" },
        executorOwnerId: producerBefore.heartbeat!.executorOwnerId,
        executorOwnerLeaseEpoch: producerBefore.heartbeat!.executorOwnerLeaseEpoch,
        executorOwnerLeaseToken: producerBefore.heartbeat!.executorOwnerLeaseToken,
        executionEpoch: producerBefore.heartbeat!.executionEpoch,
        executionToken: producerBefore.heartbeat!.executionToken });
      expect(settled.wake).toMatchObject({ id: producerBefore.wake!.id, runId: producerRunId,
        workflowStepRunId: lifecycle.producerStep.id });
      expect(settled.step).toMatchObject({ id: lifecycle.producerStep.id,
        executionGeneration: producerBefore.step!.executionGeneration,
        retryCount: producerBefore.step!.retryCount, iterationIndex: producerBefore.step!.iterationIndex });
      const drains = await fixture.peer.select().from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.companyId, lifecycle.companyId),
        eq(workflowTransitionEvents.workflowRunId, lifecycle.runId),
        eq(workflowTransitionEvents.workflowStepRunId, lifecycle.producerStep.id),
        eq(workflowTransitionEvents.heartbeatRunId, producerRunId),
        eq(workflowTransitionEvents.eventType, "heartbeat_actual_drained_v1")));
      expect(drains).toHaveLength(1);
    }, { timeout: 30_000, interval: 20 });

    const prepared = await lifecycle.prepare();
    if (prepared.outcome !== "prepared") throw new Error(`S1 official preparation did not commit: ${JSON.stringify(prepared)}`);
    expect(prepared.preparationEventId).toBeTruthy();
    expect((await lifecycle.readIdentity(qaRunId)).heartbeat).toMatchObject({ id: qaRunId, status: "running" });

    const nativeLockWait = deferred<void>();
    onFixtureOwnerLockWait = () => nativeLockWait.resolve();
    const blocker = await lifecycle.startSlotBlocker(optedService);
    const blockerRunId = await within(lifecycle.slotBlockerEntered, "S1 same-agent slot blocker adapter entry");
    expect(blockerRunId).toBe(blocker.id);

    const consumer = await lifecycle.startClaimConsumer();
    const consumerBefore = await lifecycle.readIdentity(consumer.id);
    expect(consumerBefore.heartbeat).toMatchObject({ id: consumer.id, status: "queued", issueId: lifecycle.claimConsumerIssueId });
    expect(consumerBefore.wake).toMatchObject({ id: consumer.wakeupRequestId, runId: consumer.id,
      status: "queued", requestKind: "workflow_resume", workflowRunId: lifecycle.runId,
      workflowStepRunId: lifecycle.claimConsumerStep.id });
    expect(consumerBefore.issue).toMatchObject({ id: lifecycle.claimConsumerIssueId, status: "in_progress" });
    expect(consumerBefore.step).toMatchObject({ id: lifecycle.claimConsumerStep.id, status: "pending" });
    // C3-β(§6-b/§9-2 승인): 무관 claim 은 승격되고, pre-invocation hold 는 adapter_start 에서
    // typed 실패(c5_held_not_invoked)로 종결된다. 어댑터 미호출·행/웨이크 단일성·드레인 0·재시도 비재현은 그대로 검증한다.
    const assertConsumerInventory = async () => {
      const [consumerRows, consumerWakes] = await Promise.all([
        fixture.peer.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.companyId, lifecycle.companyId),
          eq(heartbeatRuns.agentId, lifecycle.downstreamAgentId),
          eq(heartbeatRuns.issueId, lifecycle.claimConsumerIssueId))),
        fixture.peer.select().from(agentWakeupRequests).where(and(
          eq(agentWakeupRequests.companyId, lifecycle.companyId),
          eq(agentWakeupRequests.agentId, lifecycle.downstreamAgentId),
          eq(agentWakeupRequests.issueId, lifecycle.claimConsumerIssueId),
          eq(agentWakeupRequests.workflowStepRunId, lifecycle.claimConsumerStep.id))),
      ]);
      expect(consumerRows).toHaveLength(1);
      expect(consumerWakes).toHaveLength(1);
      const heartbeat = consumerRows[0]!;
      const wake = consumerWakes[0]!;
      expect(heartbeat).toMatchObject({
        id: consumer.id,
        companyId: lifecycle.companyId,
        agentId: lifecycle.downstreamAgentId,
        issueId: lifecycle.claimConsumerIssueId,
        status: "failed",
        errorCode: "c5_held_not_invoked",
        terminalOutcome: "failed",
        finalizationVersion: 1,
        wakeupRequestId: consumer.wakeupRequestId,
        // C3-β: 승격된 claim 이 wake 의 step identity 를 run 행에 확정한다(기존 null 관측은 claim-hold 시절 것).
        workflowStepRunId: lifecycle.claimConsumerStep.id,
        workflowExecutionGeneration: consumerBefore.step!.executionGeneration,
      });
      expect(heartbeat.wakeupRequestId).toBe(wake.id);
      expect(wake).toMatchObject({
        id: consumer.wakeupRequestId,
        runId: consumer.id,
        companyId: lifecycle.companyId,
        agentId: lifecycle.downstreamAgentId,
        issueId: lifecycle.claimConsumerIssueId,
        missionId: lifecycle.missionId,
        requestKind: "workflow_resume",
        workflowRunId: lifecycle.runId,
        workflowStepRunId: lifecycle.claimConsumerStep.id,
        workflowExecutionGeneration: consumerBefore.step!.executionGeneration,
      });
      const drains = await fixture.peer.select().from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.companyId, lifecycle.companyId),
        eq(workflowTransitionEvents.workflowRunId, lifecycle.runId),
        eq(workflowTransitionEvents.workflowStepRunId, lifecycle.claimConsumerStep.id),
        eq(workflowTransitionEvents.heartbeatRunId, consumer.id),
        eq(workflowTransitionEvents.eventType, "heartbeat_actual_drained_v1")));
      expect(drains).toHaveLength(0);
      expect(adapter.mock.calls.some(([context]) => context.runId === consumer.id)).toBe(false);
    };

    await new Promise(resolve => setTimeout(resolve, 3));
    const sameAgentU = await lifecycle.startSameAgentU(optedService);
    const sameAgentBefore = await lifecycle.readIdentity(sameAgentU.id);
    expect(sameAgentBefore.heartbeat).toMatchObject({ id: sameAgentU.id, status: "queued", agentId: lifecycle.downstreamAgentId });
    expect(sameAgentBefore.heartbeat!.createdAt.getTime()).toBeGreaterThan(consumerBefore.heartbeat!.createdAt.getTime());

    heldArtifact = await lifecycle.holdArtifact();
    lifecycle.releaseSlotBlocker();
    // C3-β(§6-b): 무관 소비자 run 의 claim 은 승격되고, 오너 대기는 adapter_start 루트에서 관측된다.
    await within(nativeLockWait.promise, "S1 consumer adapter start waits on the exact native artifact owner");

    const mutation = await fixture.peer.transaction(async tx => {
      const [updated] = await tx.update(missions).set({ updatedAt: new Date() })
        .where(eq(missions.id, lifecycle.missionId)).returning({ id: missions.id, updatedAt: missions.updatedAt });
      return updated;
    });
    expect(mutation).toMatchObject({ id: lifecycle.missionId, updatedAt: expect.any(Date) });

    const separateAgentU = await lifecycle.startSeparateAgentU(optedService);
    const separateAgentRunId = await within(lifecycle.separateAgentUEntered, "S1 unrelated-agent U adapter entry");
    expect(separateAgentRunId).toBe(separateAgentU.id);
    await vi.waitFor(async () => {
      expect((await lifecycle.readIdentity(separateAgentU.id)).heartbeat).toMatchObject({ id: separateAgentU.id,
        status: "succeeded", resultJson: { stdout: "c5-public-separate-agent-u", stderr: "" } });
    }, { timeout: 30_000, interval: 20 });

    await heldArtifact.release();
    heldArtifact = null;
    // C3-β(§6-b): 해제 후 소비자 run 은 adapter_start 에서 typed 실패로 종결된다(어댑터 미호출).
    await within(vi.waitFor(async () => {
      expect((await lifecycle.readIdentity(consumer.id)).heartbeat).toMatchObject({ id: consumer.id,
        status: "failed", errorCode: "c5_held_not_invoked" });
    }, { timeout: 30_000, interval: 20 }), "S1 consumer typed failure after the artifact hold");
    // 실패로 끝난 소비자 run 뒤 큐는 표준 resume 레인으로 진행된다 — same-agent U 가 슬롯을 이어받는다.
    await optedService.resumeQueuedRuns(lifecycle.downstreamAgentId);
    const sameAgentRunId = await within(lifecycle.sameAgentUEntered, "S1 queued same-agent U after the typed consumer failure");
    expect(sameAgentRunId).toBe(sameAgentU.id);
    await vi.waitFor(async () => {
      expect((await lifecycle.readIdentity(sameAgentU.id)).heartbeat).toMatchObject({ id: sameAgentU.id,
        status: "succeeded", resultJson: { stdout: "c5-public-same-agent-u", stderr: "" } });
      expect((await lifecycle.readIdentity(blocker.id)).heartbeat).toMatchObject({ id: blocker.id,
        status: "succeeded", resultJson: { stdout: "c5-public-slot-blocker", stderr: "" } });
    }, { timeout: 30_000, interval: 20 });
    await assertConsumerInventory();

    await optedService.resumeQueuedRuns(lifecycle.downstreamAgentId);
    await optedService.resumeQueuedRuns(lifecycle.downstreamAgentId);
    await assertConsumerInventory();
    const consumerDrains = await fixture.peer.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, lifecycle.companyId),
      eq(workflowTransitionEvents.workflowRunId, lifecycle.runId),
      eq(workflowTransitionEvents.workflowStepRunId, lifecycle.claimConsumerStep.id),
      eq(workflowTransitionEvents.heartbeatRunId, consumer.id),
      eq(workflowTransitionEvents.eventType, "heartbeat_actual_drained_v1")));
    expect(consumerDrains).toHaveLength(0);
  } finally {
    onFixtureOwnerLockWait = () => undefined;
    lifecycle.releaseSlotBlocker();
    await heldArtifact?.release();
    lifecycle.releaseProducerActual();
    lifecycle.releaseQaActual();
    await lifecycle.drain();
  }
});

it("S2: exact-Db recreation and replacement notifications retain C5 authority", async () => {
  const lifecycle = await createHeartbeatC5PublicLifecycle(fixture, { c02NotificationInput: true });
  lifecycles.push(lifecycle);
  adapter.mockImplementation(lifecycle.executeActual);
  const ownerRuntime = fixtureOwnerRuntime ??= lifecycle.ownerRuntime(() => onFixtureOwnerLockWait());
  const configured = heartbeatService(fixture.db, { qaCorrectionExecution: { ownerRuntime } });
  let heldArtifact: Awaited<ReturnType<typeof lifecycle.holdArtifact>> | null = null;
  const nativeLockWait = deferred<void>();
  onFixtureOwnerLockWait = () => nativeLockWait.resolve();
  try {
    const producer = await lifecycle.startProducer();
    if (!producer?.id || !producer.wakeupRequestId) throw new Error("S2 producer wake lacks its durable heartbeat run binding");
    const producerRunId = await within(lifecycle.producerEntered, "S2 producer adapter entry");
    await within(lifecycle.producerWorkCompleted, "S2 registered producer artifact and official completion");
    const qaRunId = await within(lifecycle.qaVerdictSubmitted, "S2 official request-changes verdict");
    expect(producerRunId).toBe(producer.id);
    const producerBefore = await lifecycle.readIdentity(producerRunId);
    const qaBefore = await lifecycle.readIdentity(qaRunId);
    expect(producerBefore.heartbeat).toMatchObject({ id: producerRunId, status: "running", issueId: lifecycle.producerIssueId });
    expect(producerBefore.wake).toMatchObject({ id: producer.wakeupRequestId, runId: producerRunId,
      workflowRunId: lifecycle.runId, workflowStepRunId: lifecycle.producerStep.id });
    expect(qaBefore.heartbeat).toMatchObject({ id: qaRunId, status: "running", issueId: lifecycle.qaIssueId });
    lifecycle.releaseProducerActual();
    await vi.waitFor(async () => {
      const settled = await lifecycle.readIdentity(producerRunId);
      expect(settled.heartbeat).toMatchObject({ id: producerRunId, status: "succeeded",
        resultJson: { stdout: "c5-public-producer", stderr: "" },
        executorOwnerId: producerBefore.heartbeat!.executorOwnerId,
        executorOwnerLeaseEpoch: producerBefore.heartbeat!.executorOwnerLeaseEpoch,
        executorOwnerLeaseToken: producerBefore.heartbeat!.executorOwnerLeaseToken,
        executionEpoch: producerBefore.heartbeat!.executionEpoch,
        executionToken: producerBefore.heartbeat!.executionToken });
      expect(settled.wake).toMatchObject({ id: producerBefore.wake!.id, runId: producerRunId,
        workflowStepRunId: lifecycle.producerStep.id });
      expect(settled.step).toMatchObject({ id: lifecycle.producerStep.id,
        executionGeneration: producerBefore.step!.executionGeneration,
        retryCount: producerBefore.step!.retryCount, iterationIndex: producerBefore.step!.iterationIndex });
      const drains = await fixture.peer.select().from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.companyId, lifecycle.companyId),
        eq(workflowTransitionEvents.workflowRunId, lifecycle.runId),
        eq(workflowTransitionEvents.workflowStepRunId, lifecycle.producerStep.id),
        eq(workflowTransitionEvents.heartbeatRunId, producerRunId),
        eq(workflowTransitionEvents.eventType, "heartbeat_actual_drained_v1")));
      expect(drains).toHaveLength(1);
    }, { timeout: 30_000, interval: 20 });
    expect(await lifecycle.readIdentity(qaRunId)).toEqual(qaBefore);
    const prepared = await lifecycle.prepare();
    if (prepared.outcome !== "prepared") throw new Error(`S2 official preparation did not commit: ${JSON.stringify(prepared)}`);
    expect((await lifecycle.readIdentity(qaRunId)).heartbeat).toMatchObject({ id: qaRunId, status: "running" });

    const recreated = heartbeatService(fixture.db);
    expect(configured).not.toBe(recreated);

    // C3-β(§6-b/§9-2 승인): wakeup 이 claim 을 즉시 승격하므로 아티팩트 네이티브 홀더를 먼저 잡고,
    // 소비자 run 의 adapter_start 오너 대기가 같은 exact-Db ownerRuntime 바인딩에서 관측되는지를 확인한다.
    heldArtifact = await lifecycle.holdArtifact();
    const consumer = await lifecycle.startClaimConsumer();
    const consumerBefore = await lifecycle.readIdentity(consumer.id);
    expect(consumerBefore.heartbeat).toMatchObject({ id: consumer.id, status: "running",
      companyId: lifecycle.companyId, agentId: lifecycle.downstreamAgentId, issueId: lifecycle.claimConsumerIssueId });
    expect(consumerBefore.wake).toMatchObject({ id: consumer.wakeupRequestId, runId: consumer.id,
      companyId: lifecycle.companyId, agentId: lifecycle.downstreamAgentId, issueId: lifecycle.claimConsumerIssueId,
      workflowRunId: lifecycle.runId, workflowStepRunId: lifecycle.claimConsumerStep.id,
      workflowExecutionGeneration: lifecycle.claimConsumerStep.executionGeneration, status: "claimed" });
    const consumerProof = readWorkflowAttemptProof(consumerBefore.wake!);
    expect(consumerProof).toMatchObject({ companyId: lifecycle.companyId, agentId: lifecycle.downstreamAgentId,
      issueId: lifecycle.claimConsumerIssueId, missionId: lifecycle.missionId, workflowRunId: lifecycle.runId,
      stepRunId: lifecycle.claimConsumerStep.id,
      executionGeneration: lifecycle.claimConsumerStep.executionGeneration,
      retryCount: lifecycle.claimConsumerStep.retryCount, iterationIndex: lifecycle.claimConsumerStep.iterationIndex,
      wakeupRequestId: consumer.wakeupRequestId });

    // C3-β(§6-b/§9-2 승인): 무관 소비자 run 은 승격 후 adapter_start 에서 typed 실패로 종결된다.
    // 행/웨이크 단일성·어댑터 미호출·드레인 0·C02 원본 불변은 그대로 검증한다.
    const assertConsumerUnchanged = async () => {
      await within(vi.waitFor(async () => {
        expect((await lifecycle.readIdentity(consumer.id)).heartbeat).toMatchObject({ id: consumer.id,
          status: "failed", errorCode: "c5_held_not_invoked", terminalOutcome: "failed" });
      }, { timeout: 30_000, interval: 20 }), "S2 consumer typed failure after the artifact hold");
      const [rows, wakes] = await Promise.all([
        fixture.peer.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.companyId, lifecycle.companyId), eq(heartbeatRuns.agentId, lifecycle.downstreamAgentId),
          eq(heartbeatRuns.issueId, lifecycle.claimConsumerIssueId))),
        fixture.peer.select().from(agentWakeupRequests).where(and(
          eq(agentWakeupRequests.companyId, lifecycle.companyId), eq(agentWakeupRequests.agentId, lifecycle.downstreamAgentId),
          eq(agentWakeupRequests.issueId, lifecycle.claimConsumerIssueId))),
      ]);
      expect(rows).toHaveLength(1);
      expect(wakes).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: consumer.id, status: "failed", errorCode: "c5_held_not_invoked",
        terminalOutcome: "failed", finalizationVersion: 1, wakeupRequestId: consumer.wakeupRequestId,
        // C3-β: 승격된 claim 이 wake 의 step identity 를 run 행에 확정한다.
        workflowStepRunId: lifecycle.claimConsumerStep.id,
        workflowExecutionGeneration: lifecycle.claimConsumerStep.executionGeneration });
      expect(wakes[0]?.id).toBe(consumerBefore.heartbeat?.wakeupRequestId);
      expect(wakes[0]).toMatchObject({ id: consumer.wakeupRequestId, runId: consumer.id,
        requestKind: "workflow_resume", workflowRunId: lifecycle.runId,
        workflowStepRunId: lifecycle.claimConsumerStep.id });
      const drains = await fixture.peer.select().from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.companyId, lifecycle.companyId),
        eq(workflowTransitionEvents.workflowRunId, lifecycle.runId),
        eq(workflowTransitionEvents.workflowStepRunId, lifecycle.claimConsumerStep.id),
        eq(workflowTransitionEvents.heartbeatRunId, consumer.id),
        eq(workflowTransitionEvents.eventType, "heartbeat_actual_drained_v1")));
      expect(drains).toHaveLength(0);
      expect(adapter.mock.calls.some(([context]) => context.runId === consumer.id)).toBe(false);
    };

    // The bare exact-Db factory must reuse the explicit owner runtime and hold this authentic C.
    const bareSweep = recreated.resumeQueuedRuns(lifecycle.downstreamAgentId);
    // C3-β(§6-b): 승격된 소비자 run 의 오너 대기는 adapter-start 루트에서 관측된다(exact-Db 바인딩 재사용).
    await within(nativeLockWait.promise, "S2 recreated bare service enters the native C5 adapter-start root");
    await heldArtifact.release();
    heldArtifact = null;
    await bareSweep;
    await assertConsumerUnchanged();

    const producerAtC02Input = await lifecycle.readIdentity(producerRunId);
    const qaAtC02Input = await lifecycle.readIdentity(qaRunId);
    const sourceBytesBeforeC02 = await readFile(lifecycle.artifactPath);
    expect(sourceBytesBeforeC02.toString("utf8")).toBe("before\n");
    const sourceProductsBeforeC02 = await fixture.peer.select().from(issueWorkProducts)
      .where(and(eq(issueWorkProducts.companyId, lifecycle.companyId), eq(issueWorkProducts.issueId, lifecycle.producerIssueId)));
    const sourceBindingsBeforeC02 = await fixture.peer.select().from(workflowStepOutputBindings).where(and(
      eq(workflowStepOutputBindings.companyId, lifecycle.companyId),
      eq(workflowStepOutputBindings.workflowRunId, lifecycle.runId),
      eq(workflowStepOutputBindings.consumerStepRunId, lifecycle.qaStep.id),
      eq(workflowStepOutputBindings.referencedStepId, lifecycle.producerStep.stepId)));
    const sourceVerdictsBeforeC02 = await fixture.peer.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, lifecycle.companyId),
      eq(workflowTransitionEvents.workflowRunId, lifecycle.runId),
      eq(workflowTransitionEvents.workflowStepRunId, lifecycle.qaStep.id),
      eq(workflowTransitionEvents.issueId, lifecycle.qaIssueId),
      eq(workflowTransitionEvents.heartbeatRunId, qaRunId),
      eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
      eq(workflowTransitionEvents.verdict, "request_changes")));
    expect(sourceProductsBeforeC02).toHaveLength(1);
    expect(sourceBindingsBeforeC02).toHaveLength(1);
    expect(sourceVerdictsBeforeC02).toHaveLength(1);
    const sourceProductBeforeC02 = sourceProductsBeforeC02[0]!;
    const sourceBindingBeforeC02 = sourceBindingsBeforeC02[0]!;
    const sourceVerdictBeforeC02 = sourceVerdictsBeforeC02[0]!;
    const sourceRemediations = sourceVerdictBeforeC02.payload.remediations as { items: unknown[] };

    const issued = await lifecycle.issueC02NotificationInput();
    expect(issued.sourceProductId).toBe(sourceProductBeforeC02.id);
    expect(issued.bindingId).toBe(sourceBindingBeforeC02.id);
    expect(issued.producerProvenance).toEqual(sourceProductBeforeC02.metadata?.workflowProducer);
    expect(issued.preparation).toMatchObject({
      companyId: lifecycle.companyId,
      missionId: lifecycle.missionId,
      workflowRunId: lifecycle.runId,
      dispatchAuthorityVersion: 1,
      producer: { stepRunId: lifecycle.producerStep.id, stepId: lifecycle.producerStep.stepId,
        issueId: lifecycle.producerIssueId, executionGeneration: producerAtC02Input.step!.executionGeneration,
        retryCount: producerAtC02Input.step!.retryCount, iterationIndex: producerAtC02Input.step!.iterationIndex },
      authority: { kind: "workflow_qa", verdicts: [{ eventId: sourceVerdictBeforeC02.id, heartbeatRunId: qaRunId,
        qa: { stepRunId: lifecycle.qaStep.id, stepId: lifecycle.qaStep.stepId, issueId: lifecycle.qaIssueId,
          executionGeneration: qaAtC02Input.step!.executionGeneration, retryCount: qaAtC02Input.step!.retryCount,
          iterationIndex: qaAtC02Input.step!.iterationIndex },
        remediationsHash: hashQaCorrectionPayload(sourceRemediations.items) }] },
      sources: [{ productId: sourceProductBeforeC02.id,
        provenance: { kind: "workflow_producer", workflowProducer: issued.producerProvenance } }],
      bindings: [{ bindingId: sourceBindingBeforeC02.id, consumer: {
        stepRunId: lifecycle.qaStep.id, stepId: lifecycle.qaStep.stepId, issueId: lifecycle.qaIssueId,
        executionGeneration: qaAtC02Input.step!.executionGeneration, retryCount: qaAtC02Input.step!.retryCount,
        iterationIndex: qaAtC02Input.step!.iterationIndex }, referencedStepId: lifecycle.producerStep.stepId,
        expectedProductId: sourceProductBeforeC02.id }],
    });
    expect(issued.followup.target).toEqual({ stepRunId: lifecycle.qaStep.id, stepId: lifecycle.qaStep.stepId,
      issueId: lifecycle.qaIssueId, executionGeneration: qaAtC02Input.step!.executionGeneration,
      retryCount: qaAtC02Input.step!.retryCount, iterationIndex: qaAtC02Input.step!.iterationIndex });
    expect(issued.committed.proof.applied.bindingChanges).toEqual([{
      bindingId: sourceBindingBeforeC02.id, fromProductId: sourceProductBeforeC02.id,
      toProductId: issued.committed.proof.applied.revisions[0]!.workProductId,
    }]);
    const [revision] = issued.committed.proof.applied.revisions;
    expect(issued.committed.proof.applied.revisions).toHaveLength(1);
    expect(revision!.sourceProductId).toBe(sourceProductBeforeC02.id);
    const sourceProductsAfterC02 = (await fixture.peer.select().from(issueWorkProducts)
      .where(and(eq(issueWorkProducts.companyId, lifecycle.companyId), eq(issueWorkProducts.issueId, lifecycle.producerIssueId))))
      .sort((a, b) => a.id.localeCompare(b.id));
    expect(sourceProductsAfterC02).toHaveLength(sourceProductsBeforeC02.length + 1);
    const archivedSourceProduct = sourceProductsAfterC02.find(product => product.id === sourceProductBeforeC02.id);
    const revisedSourceProduct = sourceProductsAfterC02.filter(product => product.id !== sourceProductBeforeC02.id);
    expect(revisedSourceProduct).toHaveLength(1);
    if (!archivedSourceProduct) throw new Error("C5 C02 source product was not retained as archived history");
    expect(archivedSourceProduct).toEqual({ ...sourceProductBeforeC02, status: "archived", isPrimary: false,
      updatedAt: archivedSourceProduct.updatedAt });
    expect(revisedSourceProduct[0]).toMatchObject({ id: revision!.workProductId,
      companyId: lifecycle.companyId, issueId: lifecycle.producerIssueId, status: "active",
      metadata: { qaCorrection: { appliedEventId: issued.committed.appliedEventId, revisionId: revision!.revisionId } } });
    const sourceBindingsAfterC02 = await fixture.peer.select().from(workflowStepOutputBindings).where(and(
      eq(workflowStepOutputBindings.companyId, lifecycle.companyId),
      eq(workflowStepOutputBindings.workflowRunId, lifecycle.runId),
      eq(workflowStepOutputBindings.consumerStepRunId, lifecycle.qaStep.id),
      eq(workflowStepOutputBindings.referencedStepId, lifecycle.producerStep.stepId)));
    expect(sourceBindingsAfterC02).toHaveLength(1);
    expect(sourceBindingsAfterC02[0]).toEqual({ ...sourceBindingBeforeC02,
      workProductId: revision!.workProductId, resolvedAt: sourceBindingsAfterC02[0]!.resolvedAt });
    expect(sourceBindingsAfterC02[0]!.resolvedAt).not.toBeNull();
    const assertC02SourceDeltaStable = async () => {
      expect(await lifecycle.readIdentity(producerRunId)).toEqual(producerAtC02Input);
      expect(await lifecycle.readIdentity(qaRunId)).toEqual(qaAtC02Input);
      expect(await readFile(lifecycle.artifactPath)).toEqual(sourceBytesBeforeC02);
      expect((await fixture.peer.select().from(issueWorkProducts)
        .where(and(eq(issueWorkProducts.companyId, lifecycle.companyId), eq(issueWorkProducts.issueId, lifecycle.producerIssueId))))
        .sort((a, b) => a.id.localeCompare(b.id))).toEqual(sourceProductsAfterC02);
      expect(await fixture.peer.select().from(workflowStepOutputBindings).where(and(
        eq(workflowStepOutputBindings.companyId, lifecycle.companyId),
        eq(workflowStepOutputBindings.workflowRunId, lifecycle.runId),
        eq(workflowStepOutputBindings.consumerStepRunId, lifecycle.qaStep.id),
        eq(workflowStepOutputBindings.referencedStepId, lifecycle.producerStep.stepId))))
        .toEqual(sourceBindingsAfterC02);
    };
    await assertC02SourceDeltaStable();

    const correctionCandidates = await fixture.peer.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, lifecycle.companyId), eq(agentWakeupRequests.agentId, lifecycle.qaAgentId),
      eq(agentWakeupRequests.issueId, lifecycle.qaIssueId), eq(agentWakeupRequests.workflowRunId, lifecycle.runId),
      eq(agentWakeupRequests.workflowStepRunId, lifecycle.qaStep.id),
      eq(agentWakeupRequests.workflowExecutionGeneration, lifecycle.qaStep.executionGeneration)));
    const correctionWakes = correctionCandidates.filter(wake =>
      ["queued", "deferred_issue_execution"].includes(wake.status) && readQaCorrectionWakeRef(wake) !== null);
    expect(correctionWakes.map(wake => wake.id)).toEqual([issued.correctionWakeupRequestId]);
    const [correctionWake] = await fixture.peer.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, issued.correctionWakeupRequestId));
    if (!correctionWake) throw new Error("C5 S2 registered correction notification has no persisted wake row");
    expect(correctionWake).toEqual(issued.wake);
    expect(readQaCorrectionWakeRef(correctionWake)).toEqual(issued.ref);
    expect(correctionWake).toMatchObject({ companyId: lifecycle.companyId, agentId: lifecycle.qaAgentId,
      issueId: lifecycle.qaIssueId, missionId: lifecycle.missionId, workflowRunId: lifecycle.runId,
      workflowStepRunId: lifecycle.qaStep.id,
      workflowExecutionGeneration: lifecycle.qaStep.executionGeneration,
      requestKind: "workflow_resume", runId: null });
    expect(readWorkflowAttemptProof(correctionWake)).toMatchObject({ companyId: lifecycle.companyId,
      agentId: lifecycle.qaAgentId, issueId: lifecycle.qaIssueId, missionId: lifecycle.missionId,
      workflowRunId: lifecycle.runId, stepRunId: lifecycle.qaStep.id,
      executionGeneration: lifecycle.qaStep.executionGeneration, retryCount: lifecycle.qaStep.retryCount,
      iterationIndex: lifecycle.qaStep.iterationIndex, wakeupRequestId: correctionWake.id });

    const notifications = issued.notifications;
    expect([...notifications.correctionWakeupRequestIds]).toEqual([correctionWake!.id]);
    expect(notifications.agentIds.has(correctionWake!.agentId)).toBe(true);
    notifications.agentIds.add(consumerBefore.heartbeat!.agentId);
    const priorAdapterRunIds = adapter.mock.calls.map(([context]) => context.runId).sort();
    await drainReplacementRootNotifications(fixture.db, notifications);
    await assertConsumerUnchanged();
    await assertC02SourceDeltaStable();
    const afterFirstDrain = {
      correctionRuns: await fixture.peer.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, lifecycle.companyId), eq(heartbeatRuns.agentId, lifecycle.qaAgentId),
        eq(heartbeatRuns.issueId, lifecycle.qaIssueId))),
      correctionWakes: await fixture.peer.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, lifecycle.companyId), eq(agentWakeupRequests.agentId, lifecycle.qaAgentId),
        eq(agentWakeupRequests.issueId, lifecycle.qaIssueId), eq(agentWakeupRequests.workflowRunId, lifecycle.runId),
        eq(agentWakeupRequests.workflowStepRunId, lifecycle.qaStep.id),
        eq(agentWakeupRequests.workflowExecutionGeneration, lifecycle.qaStep.executionGeneration))),
    };
    expect(afterFirstDrain.correctionWakes.filter(wake => wake.id === correctionWake.id)).toHaveLength(1);
    // The official source QA actual is still running, so correction delivery must remain pending.
    expect(afterFirstDrain.correctionWakes.find(wake => wake.id === correctionWake.id)).toEqual(correctionWake);
    expect(afterFirstDrain.correctionRuns.filter(run => run.wakeupRequestId === correctionWake.id)).toHaveLength(0);
    expect(adapter.mock.calls.map(([context]) => context.runId).sort()).toEqual(priorAdapterRunIds);

    // Replaying both notification sets must not add a second run, wake, or actual.
    await drainReplacementRootNotifications(fixture.db, notifications);
    await assertConsumerUnchanged();
    await assertC02SourceDeltaStable();
    expect({
      correctionRuns: await fixture.peer.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, lifecycle.companyId), eq(heartbeatRuns.agentId, lifecycle.qaAgentId),
        eq(heartbeatRuns.issueId, lifecycle.qaIssueId))),
      correctionWakes: await fixture.peer.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, lifecycle.companyId), eq(agentWakeupRequests.agentId, lifecycle.qaAgentId),
        eq(agentWakeupRequests.issueId, lifecycle.qaIssueId), eq(agentWakeupRequests.workflowRunId, lifecycle.runId),
        eq(agentWakeupRequests.workflowStepRunId, lifecycle.qaStep.id),
        eq(agentWakeupRequests.workflowExecutionGeneration, lifecycle.qaStep.executionGeneration))),
    }).toEqual(afterFirstDrain);
    expect(adapter.mock.calls.map(([context]) => context.runId).sort()).toEqual(priorAdapterRunIds);

    const conflictingRuntime = lifecycle.ownerRuntime(() => undefined);
    expect(() => heartbeatService(fixture.db, { qaCorrectionExecution: { ownerRuntime: conflictingRuntime } }))
      .toThrow("heartbeat_c5_owner_runtime_binding_conflict");
    await heartbeatService(fixture.db).resumeQueuedRuns(lifecycle.downstreamAgentId);
    await assertConsumerUnchanged();

    expect(fixture.peer).not.toBe(fixture.db);
    const peerRuntime = lifecycle.ownerRuntime(() => undefined);
    expect(() => heartbeatService(fixture.peer, { qaCorrectionExecution: { ownerRuntime: peerRuntime } })).not.toThrow();
    expect(() => heartbeatService(fixture.db, { qaCorrectionExecution: { ownerRuntime: peerRuntime } }))
      .toThrow("heartbeat_c5_owner_runtime_binding_conflict");
  } finally {
    onFixtureOwnerLockWait = () => undefined;
    await heldArtifact?.release();
    lifecycle.releaseProducerActual();
    lifecycle.releaseQaActual();
    await lifecycle.drain();
    const registeredS2Actuals = new Set([
      `${lifecycle.producerAgentId}:${lifecycle.producerIssueId}`,
      `${lifecycle.qaAgentId}:${lifecycle.qaIssueId}`,
      `${lifecycle.downstreamAgentId}:${lifecycle.downstreamIssueId}`,
    ]);
    for (const [context] of adapter.mock.calls) {
      const issueId = typeof context.context.issueId === "string" ? context.context.issueId : null;
      if (issueId && registeredS2Actuals.has(`${context.agent.id}:${issueId}`)) continue;
      const identity = await lifecycle.readIdentity(context.runId);
      console.error("C5_P3_UNREGISTERED_ACTUAL_SCOPE_JOIN", JSON.stringify({
        fixtureScope: { companyId: lifecycle.companyId, missionId: lifecycle.missionId, workflowRunId: lifecycle.runId },
        actual: { runId: context.runId, agentId: context.agent.id, issueId },
        heartbeat: identity.heartbeat, wake: identity.wake, issue: identity.issue, step: identity.step,
        attemptProof: identity.wake ? readWorkflowAttemptProof(identity.wake) : null,
      }));
    }
  }
});

it("S3: bare exact-Db defaults carry public recovery through same-mission completion", async () => {
  const startedAt = Date.now();
  const phases: Array<Record<string, unknown>> = [];
  let activePhase = "fixture_generation";
  let lifecycle: Awaited<ReturnType<typeof createHeartbeatC5PublicLifecycle>> | null = null;
  let publicFixture: HeartbeatC5PublicFixture | null = null;
  let heldArtifact: Awaited<ReturnType<Awaited<ReturnType<typeof createHeartbeatC5PublicLifecycle>>["holdArtifact"]>> | null = null;
  let activeReconciliation: ReturnType<Awaited<ReturnType<typeof createHeartbeatC5PublicLifecycle>>["reconcileReservation"]> | null = null;
  let preDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let diagnosticOutcome = "failed";
  let v2Reconciliation: Record<string, unknown> | null = null;
  let notificationDelivery = "not_started";
  let qaPassRunId: string | null = null;
  let earlyActualCheckpoint: unknown = null;
  const recoverySweepReadbacks: Array<Record<string, unknown>> = [];

  const phase = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
    const phaseStartedAt = Date.now();
    activePhase = name;
    phases.push({ phase: name, event: "enter", atUtc: new Date().toISOString(), elapsedMs: 0,
      sinceStartMs: phaseStartedAt - startedAt, ids: lifecycle?.phaseIds() ?? null });
    try {
      const result = await action();
      const endedAt = Date.now();
      phases.push({ phase: name, event: "exit", atUtc: new Date(endedAt).toISOString(),
        elapsedMs: endedAt - phaseStartedAt, sinceStartMs: endedAt - startedAt,
        ids: lifecycle?.phaseIds() ?? null });
      return result;
    } catch (error) {
      const endedAt = Date.now();
      phases.push({ phase: name, event: "exit", atUtc: new Date(endedAt).toISOString(),
        elapsedMs: endedAt - phaseStartedAt, sinceStartMs: endedAt - startedAt,
        errorName: error instanceof Error ? error.name : "unknown", ids: lifecycle?.phaseIds() ?? null });
      throw error;
    }
  };

  const emitPhaseDiagnostic = async (reason: string) => {
    let snapshot: unknown = null;
    let snapshotErrorName: string | null = null;
    try { snapshot = lifecycle ? await lifecycle.readS3PhaseSnapshot() : null; }
    catch (error) { snapshotErrorName = error instanceof Error ? error.name : "unknown"; }
    console.info("C5_P3_S3_WAIT_V2 " + JSON.stringify({
      schemaVersion: "c5.p3.s3.wait.v2", reason, activePhase,
      elapsedMs: Date.now() - startedAt, ids: lifecycle?.phaseIds() ?? null,
      v2Reconciliation, notificationDelivery, phases, earlyActualCheckpoint, recoverySweepReadbacks, snapshot, snapshotErrorName,
    }));
  };

  try {
    publicFixture = await phase("fixture_generation", () => createHeartbeatC5PublicFixture());
    lifecycle = await phase("official_v2_lifecycle_generation", () => createHeartbeatC5PublicLifecycle(publicFixture!));
    adapter.mockImplementation(lifecycle.executeActual);
    const service = heartbeatService(publicFixture.db);
    expect(heartbeatService(publicFixture.db)).not.toBe(service);
    const initialBindings = await publicFixture.peer.select().from(workflowStepOutputBindings).where(and(
      eq(workflowStepOutputBindings.companyId, lifecycle.companyId),
      eq(workflowStepOutputBindings.workflowRunId, lifecycle.runId)));
    expect(initialBindings).toHaveLength(0);

    preDeadlineTimer = setTimeout(() => { void emitPhaseDiagnostic("pre_deadline_snapshot"); }, 45_000);
    const { producer, producerRunId } = await phase("producer_entry", async () => {
      const producer = await lifecycle!.startProducer();
      if (!producer?.id || !producer.wakeupRequestId) throw new Error("S3 producer wake lacks its durable run binding");
      const producerRunId = await within(lifecycle!.producerEntered, "S3 producer adapter entry");
      if (producerRunId !== producer.id) throw new Error("S3 producer actual differs from its exact wake binding");
      return { producer, producerRunId };
    });
    await phase("producer_official_completion", () => within(lifecycle.producerWorkCompleted,
      "S3 producer official artifact and issue completion"));
    const qaRunId = await phase("original_qa_request_changes", () => within(lifecycle!.qaVerdictSubmitted,
      "S3 official request-changes verdict"));
    const { producerBefore, qaBefore } = await phase("started_actual_identity_readback", async () => {
      const producerBefore = await lifecycle!.readIdentity(producerRunId);
      const qaBefore = await lifecycle!.readIdentity(qaRunId);
      expect(producerBefore.heartbeat).toMatchObject({ id: producerRunId, status: "running", issueId: lifecycle!.producerIssueId });
      expect(qaBefore.heartbeat).toMatchObject({ id: qaRunId, status: "running", issueId: lifecycle!.qaIssueId });
      expect(producerBefore.wake).toMatchObject({ id: producer.wakeupRequestId, runId: producerRunId,
        workflowRunId: lifecycle!.runId, workflowStepRunId: lifecycle!.producerStep.id });
      return { producerBefore, qaBefore };
    });
    const assertStartedActualIdentityPreserved = (before: typeof producerBefore, after: typeof producerBefore) => {
      if (!before.heartbeat || !after.heartbeat || !before.wake || !after.wake) {
        throw new Error("S3 started actual lost its exact heartbeat or wake binding");
      }
      expect(after.heartbeat.wakeupRequestId).toBe(before.heartbeat.wakeupRequestId);
      expect(after.heartbeat.executorOwnerLeaseToken === before.heartbeat.executorOwnerLeaseToken).toBe(true);
      expect(after.heartbeat.executionToken === before.heartbeat.executionToken).toBe(true);
      expect(after.wake.id).toBe(before.wake.id);
      expect(readWorkflowAttemptProof(after.wake)).toEqual(readWorkflowAttemptProof(before.wake));
    };

    await phase("producer_actual_release_and_drain", async () => {
      lifecycle!.releaseProducerActual();
      await vi.waitFor(async () => {
        const after = await lifecycle!.readIdentity(producerRunId);
        expect(after.heartbeat).toMatchObject({ id: producerRunId, status: "succeeded",
          resultJson: { stdout: "c5-public-producer", stderr: "" },
          executorOwnerId: producerBefore.heartbeat!.executorOwnerId,
          executorOwnerLeaseEpoch: producerBefore.heartbeat!.executorOwnerLeaseEpoch,
          executionEpoch: producerBefore.heartbeat!.executionEpoch });
        assertStartedActualIdentityPreserved(producerBefore, after);
        const drains = await publicFixture!.peer.select().from(workflowTransitionEvents).where(and(
          eq(workflowTransitionEvents.companyId, lifecycle!.companyId),
          eq(workflowTransitionEvents.workflowRunId, lifecycle!.runId),
          eq(workflowTransitionEvents.workflowStepRunId, lifecycle!.producerStep.id),
          eq(workflowTransitionEvents.heartbeatRunId, producerRunId),
          eq(workflowTransitionEvents.eventType, "heartbeat_actual_drained_v1")));
        expect(drains).toHaveLength(1);
      }, { timeout: 30_000, interval: 20 });
      expect((await lifecycle!.readIdentity(qaRunId)).heartbeat).toMatchObject({ id: qaRunId, status: "running" });
    });

    const prepared = await phase("official_v2_reservation", () => lifecycle!.prepare());
    if (prepared.outcome !== "prepared") {
      throw new Error(`S3 official V2 reservation did not commit: ${prepared.outcome}`);
    }

    const nativeLockWait = deferred<void>();
    heldArtifact = await lifecycle.holdArtifact();
    activeReconciliation = lifecycle.reconcileReservation(() => nativeLockWait.resolve());
    const reconciliation = await phase("native_v2_reconciliation", async () => {
      const first = await within(Promise.race([
        nativeLockWait.promise.then(() => "native_lock_wait" as const),
        activeReconciliation!.then(() => "settled_before_native_lock_wait" as const),
      ]), "S3 exact native file-owner lock wait");
      if (first !== "native_lock_wait") {
        throw new Error("S3 native V2 reconciler settled without observing the held native file owner");
      }
      await heldArtifact!.release();
      heldArtifact = null;
      return activeReconciliation!;
    });
    activeReconciliation = null;
    v2Reconciliation = { outcome: reconciliation.result.outcome,
      heldReason: "reason" in reconciliation.result ? reconciliation.result.reason : null,
      completionEventId: "completionEventId" in reconciliation.result ? reconciliation.result.completionEventId : null,
      created: reconciliation.result.outcome === "completed" ? reconciliation.result.created : null,
      notificationAgentIds: [...reconciliation.notifications.agentIds],
      correctionWakeupRequestIds: [...reconciliation.notifications.correctionWakeupRequestIds] };
    if (reconciliation.result.outcome !== "completed") {
      const result = reconciliation.result;
      throw new Error(`S3 official V2 native reconciliation held: ${result.outcome}`
        + ("reason" in result ? `:${result.reason}` : ""));
    }
    expect(reconciliation.result.completion.preparationId).toBe(prepared.preparationEventId);
    expect(reconciliation.result.completionEventId).toBe(reconciliation.result.completion.completionId);
    expect(reconciliation.result.completion.verdicts).toHaveLength(1);
    expect(reconciliation.result.completion.verdicts[0]).toMatchObject({
      eventId: lifecycle.phaseIds().sourceVerdictEventId,
      heartbeatRunId: qaRunId,
      qa: { stepRunId: lifecycle.qaStep.id, stepId: lifecycle.qaStep.stepId, issueId: lifecycle.qaIssueId,
        executionGeneration: lifecycle.qaStep.executionGeneration, retryCount: lifecycle.qaStep.retryCount,
        iterationIndex: lifecycle.qaStep.iterationIndex },
    });
    expect(reconciliation.result.completion.wakes).toHaveLength(1);
    expect(reconciliation.result.completion.wakes[0]).toMatchObject({ kind: "v2_refire",
      agentId: lifecycle.qaAgentId, issueId: lifecycle.qaIssueId, stepRunId: lifecycle.qaStep.id,
      stepId: lifecycle.qaStep.stepId, executionGeneration: lifecycle.qaStep.executionGeneration,
      statusAtCommit: "queued" });
    expect(reconciliation.result.completion.wakes[0]!.wakeupRequestId)
      .toBe(lifecycle.phaseIds().reservation.v2RefireWakeupRequestIds[0]);
    expect(reconciliation.result.publication).toEqual([
      expect.objectContaining({ file: lifecycle.artifactPath, status: "applied" }),
    ]);
    expect(await readFile(lifecycle.artifactPath, "utf8")).toBe("after\n");
    expect([...reconciliation.notifications.agentIds]).toEqual([lifecycle.qaAgentId]);
    expect([...reconciliation.notifications.correctionWakeupRequestIds]).toEqual([]);

    await phase("original_qa_actual_release_and_global_drain", async () => {
      lifecycle!.releaseQaActual();
      await vi.waitFor(async () => {
        const after = await lifecycle!.readIdentity(qaRunId);
        expect(after.heartbeat).toMatchObject({ id: qaRunId, status: "succeeded",
          resultJson: { stdout: "c5-public-qa-request-changes", stderr: "" },
          executorOwnerId: qaBefore.heartbeat!.executorOwnerId,
          executorOwnerLeaseEpoch: qaBefore.heartbeat!.executorOwnerLeaseEpoch,
          executionEpoch: qaBefore.heartbeat!.executionEpoch });
        assertStartedActualIdentityPreserved(qaBefore, after);
        const drains = await publicFixture!.peer.select().from(workflowTransitionEvents).where(and(
          eq(workflowTransitionEvents.companyId, lifecycle!.companyId),
          eq(workflowTransitionEvents.workflowRunId, lifecycle!.runId),
          eq(workflowTransitionEvents.workflowStepRunId, lifecycle!.qaStep.id),
          eq(workflowTransitionEvents.heartbeatRunId, qaRunId),
          eq(workflowTransitionEvents.eventType, "heartbeat_actual_drained_v1")));
        expect(drains).toHaveLength(1);
      }, { timeout: 30_000, interval: 20 });
      await lifecycle!.drain();
      const snapshot = await lifecycle!.readS3PhaseSnapshot();
      earlyActualCheckpoint = snapshot;
      expect(snapshot.actualDrain).toMatchObject({ kind: "proven", heartbeatIds: [producerRunId] });
      for (const heartbeatRunId of [producerRunId, qaRunId]) {
        const terminal = snapshot.terminalReleases.find((item: any) => item.heartbeatRunId === heartbeatRunId);
        expect(terminal?.kind).toBe("ready");
        expect(terminal?.actualOutcome).toBe("fulfilled");
        expect(terminal?.acknowledgments.length).toBeGreaterThan(0);
        expect(terminal?.acknowledgments).toHaveLength(terminal?.requiredObligationCount);
        expect(terminal?.authorityAssociation.frozen.heartbeatRunId).toBe(heartbeatRunId);
        expect(terminal?.acknowledgments.every((ack: any) => typeof ack.stage === "string"
          && typeof ack.action?.kind === "string" && typeof ack.effectKey === "string"
          && ["acknowledged", "pending", "held"].includes(ack.kind))).toBe(true);
      }
    });

    await phase("v2_notification_delivery_and_qa_refire", async () => {
      const existingRefireRunId = lifecycle!.currentQaRuns().passRunId;
      if (existingRefireRunId) notificationDelivery = "existing_exact_v2_wake_already_running";
      else {
        notificationDelivery = "draining_existing_exact_v2_wake";
        await drainReplacementRootNotifications(publicFixture!.db, reconciliation.notifications);
        notificationDelivery = "existing_exact_v2_wake_drained";
      }
      const refireRunId = existingRefireRunId ?? await vi.waitFor(() => {
        const runId = lifecycle!.currentQaRuns().passRunId;
        if (!runId) throw new Error("S3 exact V2 QA refire has not entered yet");
        return runId;
      }, { timeout: 30_000, interval: 20 });
      qaPassRunId = refireRunId;
      expect(refireRunId).not.toBe(qaRunId);
      expect(lifecycle!.currentQaRuns().entries).toBe(2);
      await lifecycle!.drain();
      const originalAfter = await lifecycle!.readIdentity(qaRunId);
      expect(originalAfter.heartbeat).toMatchObject({ id: qaRunId, status: "succeeded",
        resultJson: { stdout: "c5-public-qa-request-changes", stderr: "" },
        executorOwnerId: qaBefore.heartbeat!.executorOwnerId,
        executorOwnerLeaseEpoch: qaBefore.heartbeat!.executorOwnerLeaseEpoch,
        executionEpoch: qaBefore.heartbeat!.executionEpoch });
      assertStartedActualIdentityPreserved(qaBefore, originalAfter);
      const qaRuns = await publicFixture!.peer.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, lifecycle!.companyId), eq(heartbeatRuns.agentId, lifecycle!.qaAgentId),
        eq(heartbeatRuns.issueId, lifecycle!.qaIssueId)));
      expect(qaRuns.map(run => run.id).sort()).toEqual([qaRunId, refireRunId].sort());
      const qaPass = await lifecycle!.readIdentity(refireRunId);
      const exactRefireWake = reconciliation.result.completion.wakes[0]!;
      expect(qaPass.heartbeat).toMatchObject({ id: refireRunId, status: "succeeded",
        resultJson: { stdout: "c5-public-qa-pass", stderr: "" }, issueId: lifecycle!.qaIssueId });
      expect(qaPass.heartbeat?.wakeupRequestId).toBe(exactRefireWake.wakeupRequestId);
      expect(qaPass.wake).toMatchObject({ id: exactRefireWake.wakeupRequestId, runId: refireRunId,
        companyId: lifecycle!.companyId, agentId: lifecycle!.qaAgentId, issueId: lifecycle!.qaIssueId,
        missionId: lifecycle!.missionId, workflowRunId: lifecycle!.runId,
        workflowStepRunId: lifecycle!.qaStep.id,
        workflowExecutionGeneration: lifecycle!.qaStep.executionGeneration,
        requestKind: "workflow_resume", reason: "workflow_step_runnable" });
      expect(readWorkflowAttemptProof(qaPass.wake!)).toMatchObject({ companyId: lifecycle!.companyId,
        agentId: lifecycle!.qaAgentId, missionId: lifecycle!.missionId, workflowRunId: lifecycle!.runId,
        issueId: lifecycle!.qaIssueId, stepRunId: lifecycle!.qaStep.id,
        executionGeneration: lifecycle!.qaStep.executionGeneration,
        retryCount: lifecycle!.qaStep.retryCount, iterationIndex: lifecycle!.qaStep.iterationIndex,
        wakeupRequestId: exactRefireWake.wakeupRequestId });
      const passEvents = await publicFixture!.peer.select().from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.companyId, lifecycle!.companyId), eq(workflowTransitionEvents.missionId, lifecycle!.missionId),
        eq(workflowTransitionEvents.workflowRunId, lifecycle!.runId), eq(workflowTransitionEvents.workflowStepRunId, lifecycle!.qaStep.id),
        eq(workflowTransitionEvents.issueId, lifecycle!.qaIssueId), eq(workflowTransitionEvents.heartbeatRunId, refireRunId),
        eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"), eq(workflowTransitionEvents.verdict, "pass")));
      expect(passEvents).toHaveLength(1);
      const bindings = await publicFixture!.peer.select().from(workflowStepOutputBindings).where(and(
        eq(workflowStepOutputBindings.companyId, lifecycle!.companyId),
        eq(workflowStepOutputBindings.workflowRunId, lifecycle!.runId)));
      expect(bindings).toHaveLength(0);
      const correctionWakes = (await publicFixture!.peer.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, lifecycle!.companyId), eq(agentWakeupRequests.agentId, lifecycle!.qaAgentId),
        eq(agentWakeupRequests.issueId, lifecycle!.qaIssueId)))).filter(wake => readQaCorrectionWakeRef(wake) !== null);
      expect(correctionWakes).toHaveLength(0);
      expect(adapter.mock.calls.filter(([context]) => context.runId === refireRunId)).toHaveLength(1);
    });

    const downstream = await phase("same_mission_downstream", async () => {
      const downstream = await lifecycle!.ensureDownstream();
      const snapshot = await lifecycle!.readS3PhaseSnapshot();
      const stepRunId = lifecycle!.downstreamStep.id;
      const step = snapshot.steps.find((item: any) => item.id === stepRunId);
      const heartbeat = snapshot.heartbeats.find((item: any) => item.id === downstream.id);
      const expectedHeartbeatStepRunId = step?.status === "pending" && heartbeat?.status === "queued" ? null : stepRunId;
      const join = snapshot.wakeHeartbeatJoins
        .find((item: any) => item.wakeupRequestId === downstream.wakeupRequestId);
      expect(join).toMatchObject({ wakeupRequestId: downstream.wakeupRequestId,
        heartbeatRunIds: [downstream.id], cardinality: 1, heartbeatStepRunIds: [expectedHeartbeatStepRunId] });
      await service.resumeQueuedRuns(lifecycle!.downstreamAgentId);
      expect(await within(lifecycle!.downstreamEntered, "S3 same-mission downstream adapter entry")).toBe(downstream.id);
      await vi.waitFor(async () => expect((await lifecycle!.readIdentity(downstream.id)).heartbeat).toMatchObject({
        id: downstream.id, status: "succeeded", resultJson: { stdout: "c5-public-downstream", stderr: "" },
      }), { timeout: 30_000, interval: 20 });
      return downstream;
    });
    const claimConsumer = await phase("same_mission_claim_consumer", async () => {
      const claimConsumer = await lifecycle!.ensureClaimConsumer();
      const snapshot = await lifecycle!.readS3PhaseSnapshot();
      const stepRunId = lifecycle!.claimConsumerStep.id;
      const step = snapshot.steps.find((item: any) => item.id === stepRunId);
      const heartbeat = snapshot.heartbeats.find((item: any) => item.id === claimConsumer.id);
      const expectedHeartbeatStepRunId = step?.status === "pending" && heartbeat?.status === "queued" ? null : stepRunId;
      const join = snapshot.wakeHeartbeatJoins
        .find((item: any) => item.wakeupRequestId === claimConsumer.wakeupRequestId);
      expect(join).toMatchObject({ wakeupRequestId: claimConsumer.wakeupRequestId,
        heartbeatRunIds: [claimConsumer.id], cardinality: 1, heartbeatStepRunIds: [expectedHeartbeatStepRunId] });
      await service.resumeQueuedRuns(lifecycle!.downstreamAgentId);
      expect(await within(lifecycle!.claimConsumerEntered, "S3 remaining same-mission consumer adapter entry")).toBe(claimConsumer.id);
      await vi.waitFor(async () => expect((await lifecycle!.readIdentity(claimConsumer.id)).heartbeat).toMatchObject({
        id: claimConsumer.id, status: "succeeded", resultJson: { stdout: "c5-public-claim-consumer", stderr: "" },
      }), { timeout: 30_000, interval: 20 });
      return claimConsumer;
    });

    await phase("manual_and_timer_progress", async () => {
      const manual = await lifecycle!.startSeparateAgentU(service);
      expect(await within(lifecycle!.separateAgentUEntered, "S3 public manual invoke actual")).toBe(manual.id);
      // [ci-s1] status='succeeded' 관측 직후에는 C5 비동기 후처리(finalizationVersion 확정/정산)가
      //   아직 끝나지 않아 lifecycleInFlightClause 가 manual run 을 in-flight 로 본다. finalizationVersion=1
      //   확정까지 기다리고 실행 트래커까지 drain 한 뒤 lastHeartbeatAt 설정/.tickTimers 를 해야
      //   skipped 없이 enqueued:1 이 관측된다.
      await vi.waitFor(async () => expect((await lifecycle!.readIdentity(manual.id)).heartbeat).toMatchObject({
        id: manual.id, status: "succeeded", finalizationVersion: 1,
        resultJson: { stdout: "c5-public-separate-agent-u", stderr: "" },
      }), { timeout: 30_000, interval: 20 });
      await lifecycle!.drain();
      const tickNow = new Date();
      await publicFixture!.peer.update(agents).set({
        runtimeConfig: { heartbeat: { enabled: true, intervalSec: 1, wakeOnDemand: true, maxConcurrentRuns: 1 } },
        lastHeartbeatAt: new Date(tickNow.getTime() - 5_000),
      }).where(eq(agents.id, lifecycle!.unrelatedAgentId));
      const tickResult = await service.tickTimers(tickNow);
      expect(tickResult).toMatchObject({ checked: 1, enqueued: 1, skipped: 0 });
      const timerRunId = await within(lifecycle!.timerActualEntered, "S3 public timer actual");
      await vi.waitFor(async () => expect((await lifecycle!.readIdentity(timerRunId)).heartbeat).toMatchObject({
        id: timerRunId, status: "succeeded", invocationSource: "timer", resultJson: { stdout: "c5-public-timer", stderr: "" },
      }), { timeout: 30_000, interval: 20 });
    });

    await phase("public_recovery_progression", async () => {
      if (!qaPassRunId) throw new Error("S3 exact V2 QA refire heartbeat id was not retained before public recovery");
      const expectedHeartbeatIds = [producerRunId, qaRunId, qaPassRunId, downstream.id, claimConsumer.id].sort();
      const maximumRecoverySweeps = 3;
      let allTwentyAcknowledged = false;
      await lifecycle!.drain();
      // The bounded scan advances past the source/successor rows; an empty scan resets its cursor,
      // allowing the third sweep to revisit the original QA continuation under settled authority.
      for (let sweep = 1; sweep <= maximumRecoverySweeps; sweep += 1) {
        const reaperResult = await service.reapOrphanedRuns();
        await lifecycle!.drain();
        const snapshot = await lifecycle!.readS3PhaseSnapshot();
        const releases = snapshot.terminalReleases as Array<any>;
        const observedHeartbeatIds = releases.map(item => item.heartbeatRunId).sort();
        const acknowledgments = releases.flatMap(item => item.acknowledgments ?? []);
        const requiredAcknowledgments = releases.reduce((total, item) => total + (item.requiredObligationCount ?? 0), 0);
        allTwentyAcknowledged = releases.length === expectedHeartbeatIds.length
          && JSON.stringify(observedHeartbeatIds) === JSON.stringify(expectedHeartbeatIds)
          && requiredAcknowledgments === 20 && acknowledgments.length === 20
          && releases.every(item => item.kind === "ready" && item.actualOutcome === "fulfilled"
            && Array.isArray(item.acknowledgments) && item.acknowledgments.length === item.requiredObligationCount)
          && acknowledgments.every(ack => ack.kind === "acknowledged" && Boolean(ack.eventId));
        recoverySweepReadbacks.push({ sweep, maximumRecoverySweeps, reaperResult, expectedHeartbeatIds,
          observedHeartbeatIds, terminalReleaseCount: releases.length, requiredAcknowledgments,
          acknowledgmentCount: acknowledgments.length,
          acknowledgedCount: acknowledgments.filter(ack => ack.kind === "acknowledged" && ack.eventId).length,
          allTwentyAcknowledged,
          pending: releases.flatMap(item => (item.acknowledgments ?? [])
            .filter((ack: any) => ack.kind !== "acknowledged" || !ack.eventId)
            .map((ack: any) => ({ heartbeatRunId: item.heartbeatRunId, stage: ack.stage, action: ack.action,
              effectKey: ack.effectKey, kind: ack.kind, eventId: ack.eventId, reason: ack.reason }))) });
        if (allTwentyAcknowledged) break;
      }
      if (!allTwentyAcknowledged) {
        throw new Error("S3 public recovery did not acknowledge all 20 exact continuation obligations within three sweeps: "
          + JSON.stringify(recoverySweepReadbacks));
      }
    });

    await phase("idempotent_replay", async () => {
      await lifecycle!.drain();
      const beforeReplay = await lifecycle!.readS3PhaseSnapshot();
      await drainReplacementRootNotifications(publicFixture!.db, reconciliation.notifications);
      await heartbeatService(publicFixture!.db).resumeQueuedRuns(lifecycle!.qaAgentId);
      await heartbeatService(publicFixture!.db).resumeQueuedRuns(lifecycle!.downstreamAgentId);
      const afterReplay = await lifecycle!.readS3PhaseSnapshot();
      expect(afterReplay).toEqual(beforeReplay);
      expect(afterReplay.c02).toEqual({ bindingIds: [], correctionWakeIds: [] });
      expect(afterReplay.completionEventIds).toEqual([reconciliation.result.completionEventId]);
      expect(afterReplay.actualDrain).toMatchObject({ kind: "proven", heartbeatIds: [producerRunId] });
      expect(afterReplay.steps.some((step: any) => step.id === lifecycle!.downstreamStep.id && step.status === "completed")).toBe(true);
      expect(afterReplay.steps.some((step: any) => step.id === lifecycle!.claimConsumerStep.id && step.status === "completed")).toBe(true);
      expect(afterReplay.heartbeats.filter((run: any) => run.issueId === lifecycle!.producerIssueId).map((run: any) => run.id))
        .toEqual([producerRunId]);
      if (!qaPassRunId) throw new Error("S3 exact V2 QA refire heartbeat id was not retained");
      expect(afterReplay.heartbeats.filter((run: any) => run.issueId === lifecycle!.qaIssueId).map((run: any) => run.id).sort())
        .toEqual([qaRunId, qaPassRunId].sort());
      expect(afterReplay.heartbeats.filter((run: any) => run.issueId === lifecycle!.downstreamIssueId)
        .map((run: any) => ({ id: run.id, status: run.status, workflowStepRunId: run.workflowStepRunId,
          wakeupRequestId: run.wakeupRequestId })))
        .toEqual([{ id: downstream.id, status: "succeeded", workflowStepRunId: lifecycle!.downstreamStep.id,
          wakeupRequestId: downstream.wakeupRequestId }]);
      expect(afterReplay.heartbeats.filter((run: any) => run.issueId === lifecycle!.claimConsumerIssueId)
        .map((run: any) => ({ id: run.id, status: run.status, workflowStepRunId: run.workflowStepRunId,
          wakeupRequestId: run.wakeupRequestId })))
        .toEqual([{ id: claimConsumer.id, status: "succeeded", workflowStepRunId: lifecycle!.claimConsumerStep.id,
          wakeupRequestId: claimConsumer.wakeupRequestId }]);
    });

    await phase("same_workflow_and_mission_terminal", async () => {
      await vi.waitFor(async () => {
        const [run] = await publicFixture!.peer.select().from(workflowRuns).where(eq(workflowRuns.id, lifecycle!.runId));
        expect(run?.status).toBe("completed");
      }, { timeout: 30_000, interval: 20 });
      const reconciledMission = await missionService(publicFixture.db).reconcileById(lifecycle.missionId);
      expect(reconciledMission.status).toBe("completed");
      const [missionAfter] = await publicFixture.peer.select().from(missions).where(eq(missions.id, lifecycle.missionId));
      expect(missionAfter).toMatchObject({ id: lifecycle.missionId, status: "completed", completedAt: expect.any(Date) });
      if (!qaPassRunId) throw new Error("S3 exact V2 refire heartbeat id was not retained through terminal readback");
      const expectedIds = [producerRunId, qaRunId, qaPassRunId, downstream.id, claimConsumer.id].sort();
      const finalTerminal = (await lifecycle.readS3PhaseSnapshot()).terminalReleases;
      const observedIds = finalTerminal.map((item: any) => item.heartbeatRunId).sort();
      const residuals = finalTerminal.filter((item: any) => item.kind !== "ready" || item.actualOutcome !== "fulfilled"
        || !Array.isArray(item.acknowledgments) || item.acknowledgments.length !== item.requiredObligationCount
        || item.acknowledgments.length === 0
        || item.acknowledgments.some((ack: any) => ack.kind !== "acknowledged" || !ack.eventId));
      const unexpected = finalTerminal.filter((item: any) => !expectedIds.includes(item.heartbeatRunId));
      if (JSON.stringify(observedIds) !== JSON.stringify(expectedIds) || residuals.length) {
        throw new Error("S3 exact terminal ACK requirements remain incomplete: " + JSON.stringify({
          expectedIds, observedIds, residuals, unexpected,
        }));
      }
    });
    diagnosticOutcome = "passed";
  } finally {
    if (preDeadlineTimer) clearTimeout(preDeadlineTimer);
    await phase("cleanup", async () => {
      await heldArtifact?.release();
      lifecycle?.releaseProducerActual();
      lifecycle?.releaseQaActual();
      await activeReconciliation?.catch(() => undefined);
      if (lifecycle) await lifecycle.drain();
    });
    await emitPhaseDiagnostic(diagnosticOutcome);
    await publicFixture?.cleanup();
  }
}, 60_000);

