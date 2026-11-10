// engine-contract S25–S29 — 런타임 펜스 계약: plugin-job 상태 전이(#492·#493·#496) +
// 예산 하드스톱/재개(#687). 클레임 토큰 소유권·슬롯 입장·예산 scope 일시정지는
// 최종 DB 행으로만 판정한다. seed: 순수 DB 행 → entry: pluginJobRunStore / costService /
// budgetService 공개 함수 → assert: plugin_job_runs / plugin_jobs / agents /
// budget_incidents / approvals 최종 행만.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents,
  approvals,
  budgetIncidents,
  budgetPolicies,
  pluginJobRuns,
  pluginJobs,
  plugins,
  type Db,
} from "@paperclipai/db";
import { pluginJobRunStore } from "../../services/plugin-job-run-store.js";
import { budgetService } from "../../services/budgets.js";
import { costService } from "../../services/costs.js";
import { MIN, describeEP, seedHeartbeatRun, startContractDb, type ContractDb } from "./helpers.js";

let w: ContractDb;

beforeAll(async () => {
  w = await startContractDb("contract-fences-", { finalizationV1: true });
}, 120_000);

afterAll(async () => {
  await w.temp.cleanup();
});

async function seedPluginJob(db: Db, nextRunAt: Date | null = null) {
  const [plugin] = await db.insert(plugins).values({
    pluginKey: `contract-plugin-${randomUUID().slice(0, 8)}`,
    packageName: "@contract/plugin", version: "1.0.0",
    manifestJson: { name: "contract-plugin", version: "1.0.0" } as never,
    status: "installed",
  }).returning();
  const [job] = await db.insert(pluginJobs).values({
    pluginId: plugin.id, jobKey: `job-${randomUUID().slice(0, 8)}`,
    schedule: "0 * * * *", status: "active", nextRunAt,
  }).returning();
  return { plugin, job };
}

async function seedAgent(db: Db, status: string, pauseReason: string | null = null) {
  const [agent] = await db.insert(agents).values({
    id: randomUUID(), companyId: w.companyId, name: `Fence agent ${status}`,
    status, pauseReason, pausedAt: status === "paused" ? new Date() : null,
    adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
  }).returning();
  return agent;
}

describeEP("engine-contract S25–S29 — runtime fences (plugin-job, budget)", () => {
  it("S25: claim 은 단일 실행 펜스·토큰 소유권·멱등 finalize 계약을 지킨다", async () => {
    const store = pluginJobRunStore(w.db);
    const { plugin, job } = await seedPluginJob(w.db);
    const runA = await store.createRun({ jobId: job.id, pluginId: plugin.id, trigger: "manual" });
    const runB = await store.createRun({ jobId: job.id, pluginId: plugin.id, trigger: "manual" });
    expect(runA.status).toBe("queued");

    const claimed = await store.claimQueuedRun(runA.id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.claimToken).not.toBeNull();
    expect(claimed?.startedAt).not.toBeNull();

    // FAIL: 같은 job 에 running run 이 있으면 다른 queued run 은 claim 되지 않는다(단일 실행 펜스).
    expect(await store.claimQueuedRun(runB.id)).toBeNull();
    // FAIL: stale claim token 은 finalize 를 기록할 수 없다.
    expect(await store.finalizeClaimedRun(runA.id, randomUUID(), { status: "succeeded" })).toBe("rejected");

    // PASS: 소유 토큰으로 finalize → 터미널 상태 + 멱등 재호출.
    expect(await store.finalizeClaimedRun(runA.id, claimed!.claimToken!, { status: "succeeded", durationMs: 5 }))
      .toBe("finalized");
    expect(await store.finalizeClaimedRun(runA.id, claimed!.claimToken!, { status: "failed" }))
      .toBe("already_finalized");
    const finalA = await store.getRunById(runA.id);
    expect(finalA?.status).toBe("succeeded");
    expect(finalA?.finishedAt).not.toBeNull();

    // PASS: running 점유가 해제되면 다음 queued run 이 claim 된다.
    const claimedB = await store.claimQueuedRun(runB.id);
    expect(claimedB?.status).toBe("running");
  });

  it("S26: 미시작 claim 만 반납되고 completion 불확실 run 은 replay 불가·토큰 finalize 로만 닫힌다", async () => {
    const store = pluginJobRunStore(w.db);
    const { plugin, job } = await seedPluginJob(w.db);
    const run = await store.createRun({ jobId: job.id, pluginId: plugin.id, trigger: "manual" });
    const claimed = await store.claimQueuedRun(run.id);
    expect(claimed).not.toBeNull();

    // PASS: 미시작·무결론 claim 반납 → queued 복귀 + 재claim 가능.
    expect(await store.releaseUnstartedClaim(run.id, claimed!.claimToken!)).toBe(true);
    const released = await store.getRunById(run.id);
    expect(released?.status).toBe("queued");
    expect(released?.claimToken).toBeNull();
    expect(released?.startedAt).toBeNull();
    const reclaimed = await store.claimQueuedRun(run.id);
    expect(reclaimed?.status).toBe("running");

    // PASS: completion 불확실 표시 → replay 불가 + 미시작 반납 거부 + 소유 토큰 finalize 만 허용.
    expect(await store.markCompletionUncertain(run.id, reclaimed!.claimToken!)).toBe(true);
    const uncertain = await store.getRunById(run.id);
    expect(uncertain?.completionUncertainty).toBe("external_execution_sent_or_unknown");
    expect(await store.releaseUnstartedClaim(run.id, reclaimed!.claimToken!)).toBe(false);
    const queued = await store.listQueuedRunsByPlugin(plugin.id);
    expect(queued.some((row) => row.id === run.id)).toBe(false);
    expect(await store.finalizeClaimedRun(run.id, randomUUID(), { status: "failed" })).toBe("rejected");
    expect(await store.finalizeClaimedRun(run.id, reclaimed!.claimToken!, { status: "failed", error: "lost" }))
      .toBe("finalized");
    const closed = await store.getRunById(run.id);
    expect(closed?.status).toBe("failed");
    expect(closed?.completionUncertainty).toBeNull();
  });

  it("S27: 스케줄 슬롯 입장은 due 판정·멱등 재사용·포인터 전진 계약을 지킨다", async () => {
    const store = pluginJobRunStore(w.db);
    const due = new Date(Date.now() - 60 * MIN);
    const { plugin, job } = await seedPluginJob(w.db, due);
    const { plugin: plugin2, job: futureJob } = await seedPluginJob(w.db, new Date(Date.now() + 60 * MIN));

    // PASS: due 슬롯 → scheduled run 생성(트리거 schedule + 슬롯 스탬프).
    const first = await store.createOrReuseQueuedScheduledRun({ jobId: job.id, pluginId: plugin.id });
    expect(first.kind).toBe("available");
    if (first.kind !== "available") return;
    expect(first.created).toBe(true);
    expect(first.run.trigger).toBe("schedule");
    expect(first.run.status).toBe("queued");
    expect(first.run.scheduledAt?.getTime()).toBe(due.getTime());
    expect(first.run.scheduledCron).toBe("0 * * * *");

    // PASS: 재입장은 같은 슬롯을 재사용한다(중복 생성 없음).
    const second = await store.createOrReuseQueuedScheduledRun({ jobId: job.id, pluginId: plugin.id });
    expect(second.kind).toBe("available");
    if (second.kind !== "available") return;
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);

    // FAIL: nextRunAt 이 미래면 not_due 로 보류되고 run 은 생기지 않는다.
    const held = await store.createOrReuseQueuedScheduledRun({ jobId: futureJob.id, pluginId: plugin2.id });
    expect(held.kind).toBe("held");
    if (held.kind === "held") expect(held.reason).toBe("not_due");
    expect((await store.listRunsByJob(futureJob.id)).length).toBe(0);

    // PASS: scheduled run finalize → lastRunAt 기록 + nextRunAt 이 슬롯 이후로 전진한다.
    const claimed = await store.claimQueuedRun(first.run.id);
    expect(await store.finalizeClaimedRun(first.run.id, claimed!.claimToken!, { status: "succeeded" }))
      .toBe("finalized");
    const [jobAfter] = await w.db.select().from(pluginJobs).where(eq(pluginJobs.id, job.id));
    expect(jobAfter!.lastRunAt).not.toBeNull();
    expect(jobAfter!.nextRunAt!.getTime()).toBeGreaterThan(due.getTime());
  });

  it("S28: hard-stop 정책 초과 시 scope 가 일시정지되고 hard incident·승인이 남는다", async () => {
    const agentA = await seedAgent(w.db, "running");
    const agentB = await seedAgent(w.db, "running");
    await w.db.insert(budgetPolicies).values([
      { companyId: w.companyId, scopeType: "agent", scopeId: agentA.id, metric: "billed_cents",
        windowKind: "lifetime", amount: 100, warnPercent: 80, notifyEnabled: false,
        hardStopEnabled: true, isActive: true },
      { companyId: w.companyId, scopeType: "agent", scopeId: agentB.id, metric: "billed_cents",
        windowKind: "lifetime", amount: 100, warnPercent: 80, notifyEnabled: false,
        hardStopEnabled: false, isActive: true },
    ]);

    const costs = costService(w.db);
    await costs.createEvent(w.companyId, {
      agentId: agentA.id, provider: "contract", model: "m", costCents: 150, occurredAt: new Date(),
    });

    // PASS: 정책 초과 → 에이전트 budget 일시정지 + hard incident + override 승인.
    const [paused] = await w.db.select().from(agents).where(eq(agents.id, agentA.id));
    expect(paused!.status).toBe("paused");
    expect(paused!.pauseReason).toBe("budget");
    expect(paused!.pausedAt).not.toBeNull();
    expect(paused!.spentMonthlyCents).toBe(150);
    const incidents = await w.db.select().from(budgetIncidents).where(and(
      eq(budgetIncidents.scopeId, agentA.id), eq(budgetIncidents.thresholdType, "hard"),
    ));
    expect(incidents.length).toBe(1);
    expect(incidents[0]!.status).toBe("open");
    expect(incidents[0]!.amountObserved).toBe(150);
    expect(incidents[0]!.amountLimit).toBe(100);
    expect(incidents[0]!.approvalId).not.toBeNull();
    const [approval] = await w.db.select().from(approvals).where(eq(approvals.id, incidents[0]!.approvalId!));
    expect(approval!.type).toBe("budget_override_required");
    expect(approval!.status).toBe("pending");

    // FAIL: hardStopEnabled=false 스코프는 초과해도 일시정지·incident 가 없다.
    await costs.createEvent(w.companyId, {
      agentId: agentB.id, provider: "contract", model: "m", costCents: 150, occurredAt: new Date(),
    });
    const [unpaused] = await w.db.select().from(agents).where(eq(agents.id, agentB.id));
    expect(unpaused!.status).toBe("running");
    expect((await w.db.select().from(budgetIncidents).where(eq(budgetIncidents.scopeId, agentB.id))).length).toBe(0);
  });

  it("S29: 예산 상향은 budget 일시정지만 해제하고 lifecycle 점유 에이전트는 running 으로 복귀한다", async () => {
    const budgets = budgetService(w.db);
    const idleAgent = await seedAgent(w.db, "paused", "budget");
    const busyAgent = await seedAgent(w.db, "paused", "budget");
    const manualAgent = await seedAgent(w.db, "paused", "manual");
    // busyAgent: 미정산 terminal v1 run 이 lifecycle-active 점유(#687 계약의 resume 표시 규칙).
    await seedHeartbeatRun(w.db, {
      companyId: w.companyId, agentId: busyAgent.id, status: "cancelled",
      terminalOutcome: "cancelled", finalizationVersion: 1, finishedAt: new Date(), settledAt: null,
    });
    for (const agent of [idleAgent, busyAgent, manualAgent]) {
      await budgets.upsertPolicy(w.companyId, {
        scopeType: "agent", scopeId: agent.id, amount: 10_000, windowKind: "lifetime",
      }, null);
    }

    // PASS: budget 일시정지 + 무점유 → idle 복귀.
    const [idle] = await w.db.select().from(agents).where(eq(agents.id, idleAgent.id));
    expect(idle!.status).toBe("idle");
    expect(idle!.pauseReason).toBeNull();
    expect(idle!.pausedAt).toBeNull();
    // PASS: budget 일시정지 + lifecycle-active 점유 → running 복귀(#687).
    const [busy] = await w.db.select().from(agents).where(eq(agents.id, busyAgent.id));
    expect(busy!.status).toBe("running");
    expect(busy!.pauseReason).toBeNull();
    // FAIL: manual 일시정지는 예산 재개가 건드리지 않는다.
    const [manual] = await w.db.select().from(agents).where(eq(agents.id, manualAgent.id));
    expect(manual!.status).toBe("paused");
    expect(manual!.pauseReason).toBe("manual");
  });
});
