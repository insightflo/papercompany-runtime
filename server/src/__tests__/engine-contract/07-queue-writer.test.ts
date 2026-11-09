// engine-contract S03·S16 — 큐 생명주기 중앙 작성자 계약.
// S03: setHeartbeatRunStatus CAS/fence + 종결 이벤트 + finalization shadow (#679 부정·#686 작성자 계약).
// S16: 종결 run 의 coalesced 운영자 결정 웨이크 재큐.
// seed: 순수 DB 행 → entry: setHeartbeatRunStatus / requeueCoalescedWakeupsForFinishedRun → assert: 최종 행만.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  heartbeatRunFinalizations,
  workflowTransitionEvents,
} from "@paperclipai/db";
import {
  requeueCoalescedWakeupsForFinishedRun,
  setHeartbeatRunStatus,
} from "../../services/heartbeat-queue-lifecycle.js";
import {
  MIN,
  describeEP,
  fetchHeartbeatRun,
  seedHeartbeatRun,
  startContractDb,
  type ContractDb,
} from "./helpers.js";

let w: ContractDb;

beforeAll(async () => {
  w = await startContractDb("contract-writer-", { finalizationV1: true });
}, 120_000);

afterAll(async () => {
  await w.temp.cleanup();
});

describeEP("engine-contract S03/S16 — queue lifecycle writer contract", () => {
  it("S03: 수용된 종결 쓰기는 이벤트·shadow 를 남기고 fence 된 늦은 쓰기는 폐기된다", async () => {
    const run = await seedHeartbeatRun(w.db, {
      companyId: w.companyId,
      agentId: w.agentId,
      status: "running",
      finalizationVersion: 1,
    });
    const now = new Date();
    const updated = await setHeartbeatRunStatus(w.db, run.id, "failed", {
      error: "boom",
      errorCode: "unexpected",
      terminalOutcome: "failed",
      finishedAt: now,
    }, { expectedStatuses: ["queued", "running"] });
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("failed");

    const row = await fetchHeartbeatRun(w.db, run.id);
    expect(row.status).toBe("failed");
    expect(row.errorCode).toBe("unexpected");
    expect(row.terminalOutcome).toBe("failed");
    expect(row.finishedAt).not.toBeNull();

    // 종결 전이 이벤트 — queue_run_completed 가 멱등키와 함께 장부에 남는다.
    const events = await w.db
      .select()
      .from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.heartbeatRunId, run.id));
    expect(events.some((e) => e.eventType === "queue_run_completed")).toBe(true);

    // flag ON + v1 run — finalization shadow 행이 생성된다.
    const fin = await w.db
      .select()
      .from(heartbeatRunFinalizations)
      .where(eq(heartbeatRunFinalizations.heartbeatRunId, run.id));
    expect(fin.length).toBeGreaterThanOrEqual(1);

    // fence: 기대 상태 목록에 없는 행(이미 terminal)에 대한 늦은 쓰기는 폐기 — 좀비쓰기 방지.
    const fenced = await setHeartbeatRunStatus(w.db, run.id, "succeeded", {
      resultJson: { ok: true },
    }, { expectedStatuses: ["queued", "running"] });
    expect(fenced).toBeNull();
    const after = await fetchHeartbeatRun(w.db, run.id);
    expect(after.status).toBe("failed");
    expect(after.resultJson).toBeNull();
    // fence 된 쓰기는 파생 기록도 만들지 않는다 — 이벤트 수 불변.
    const eventsAfter = await w.db
      .select()
      .from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.heartbeatRunId, run.id));
    expect(eventsAfter.length).toBe(events.length);
  });

  it("S16: 종결된 run 에 흡수된 운영자 결정 웨이크만 재큐되고 나머지는 그대로다", async () => {
    const run = await seedHeartbeatRun(w.db, {
      companyId: w.companyId,
      agentId: w.agentId,
      status: "failed",
      terminalOutcome: "failed",
      finishedAt: new Date(Date.now() - 5 * MIN),
    });
    const decisionWakeId = randomUUID();
    await w.db.insert(agentWakeupRequests).values({
      id: decisionWakeId,
      companyId: w.companyId,
      agentId: w.agentId,
      runId: run.id,
      source: "operator_decision",
      reason: "operator_decision",
      idempotencyKey: `operator-decision-wake:${randomUUID()}:g1:a1`,
      status: "coalesced",
      payload: { issueId: null },
    });
    const otherWakeId = randomUUID();
    await w.db.insert(agentWakeupRequests).values({
      id: otherWakeId,
      companyId: w.companyId,
      agentId: w.agentId,
      runId: run.id,
      source: "issue_assigned",
      reason: "issue_assigned",
      idempotencyKey: `issue-wake-${randomUUID()}`,
      status: "coalesced",
      payload: {},
    });

    const requeued = await requeueCoalescedWakeupsForFinishedRun(w.db, {
      companyId: w.companyId,
      runId: run.id,
    });
    expect(requeued).toBe(1);

    const [w1] = await w.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, decisionWakeId));
    expect(w1.status).toBe("queued");
    expect(w1.runId).toBeNull();
    expect(w1.coalescedCount).toBe(1);
    expect(w1.finishedAt).toBeNull();

    const [w2] = await w.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, otherWakeId));
    expect(w2.status).toBe("coalesced");
    expect(w2.runId).toBe(run.id);

    const audit = await w.db.select().from(activityLog).where(and(
      eq(activityLog.companyId, w.companyId),
      eq(activityLog.action, "agent_wakeup.coalesced_requeued"),
    ));
    expect(audit.length).toBe(1);

    // 멱등 — 같은 run 에 대한 재호출은 0건.
    const again = await requeueCoalescedWakeupsForFinishedRun(w.db, {
      companyId: w.companyId,
      runId: run.id,
    });
    expect(again).toBe(0);
  });
});
