import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  agents, agentWakeupRequests, companies, createDb, issues, missions,
  workflowDefinitions, workflowRuns, workflowStepRuns,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const control = vi.hoisted(() => ({
  runId: "",
  arrivals: 0,
  gate: Promise.resolve(),
  release: () => {},
  holdWake: false,
  wakeArrivals: 0,
  wakeGate: Promise.resolve(),
  releaseWake: () => {},
  failAfterCreate: false,
  bindingProbe: null as null | ((issueId: string) => Promise<boolean>),
  observedUncommittedWake: false,
  failInitialWake: false,
}));

vi.mock("../services/issues.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/issues.js")>();
  return {
    ...actual,
    issueService: (...args: Parameters<typeof actual.issueService>) => {
      const service = actual.issueService(...args);
      return {
        ...service,
        create: async (...createArgs: Parameters<typeof service.create>) => {
          const data = createArgs[1];
          if (data.originKind === "workflow_execution" && data.originRunId === control.runId) {
            control.arrivals += 1;
            await control.gate;
          }
          const created = await service.create(...createArgs);
          if (data.originRunId === control.runId && control.failAfterCreate) {
            control.failAfterCreate = false;
            throw new Error("t16e_injected_create_failure");
          }
          return created;
        },
      };
    },
  };
});

vi.mock("../services/issue-assignment-wakeup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/issue-assignment-wakeup.js")>();
  return {
    ...actual,
    queueIssueAssignmentWakeup: async (input: Parameters<typeof actual.queueIssueAssignmentWakeup>[0]) => {
      if (control.bindingProbe && input.mutation === "create" && input.payload?.workflowRunId === control.runId) {
        if (!await control.bindingProbe(input.issue.id)) control.observedUncommittedWake = true;
      }
      if (control.holdWake && input.mutation === "create" && input.payload?.workflowRunId === control.runId) {
        control.wakeArrivals += 1;
        await control.wakeGate;
      }
      if (control.failInitialWake && input.mutation === "create" && input.payload?.workflowRunId === control.runId) {
        control.failInitialWake = false;
        return actual.queueIssueAssignmentWakeup({ ...input, heartbeat: { wakeup: async () => { throw new Error("t16e_injected_wake_failure"); } } });
      }
      return actual.queueIssueAssignmentWakeup(input);
    },
  };
});

import { syncWorkflowRunState } from "../services/workflow/dag-engine.js";

let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let observer: ReturnType<typeof createDb>;
let left: ReturnType<typeof createDb>;
let right: ReturnType<typeof createDb>;
let rightApplication: string, leftApplication: string;

beforeAll(async () => {
  const support = await getEmbeddedPostgresTestSupport();
  if (!support.supported) throw new Error(`embedded Postgres unavailable: ${support.reason}`);
  tempDb = await startEmbeddedPostgresTestDatabase("t16e-sync-race-");
  observer = createDb(tempDb.connectionString);
  const connection = (name: string) => {
    const url = new URL(tempDb.connectionString);
    url.searchParams.set("application_name", name);
    return createDb(url.toString());
  };
  rightApplication = `t16e-right-${randomUUID()}`;
  leftApplication = `t16e-left-${randomUUID()}`;
  left = connection(leftApplication);
  right = connection(rightApplication);
}, 60_000);

afterAll(async () => {
  await Promise.all([left?.$client.end({ timeout: 5 }), right?.$client.end({ timeout: 5 }), observer?.$client.end({ timeout: 5 })]);
  await tempDb?.cleanup();
});

async function waitUntil<T>(read: () => Promise<T | null>, label: string): Promise<T> {
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

it.each([
  { source: "workflow_sync", sourceKind: "manual" },
  { source: "mission_supervision", sourceKind: "manual" },
  { source: "workflow_sync", sourceKind: "quality" },
] as const)(
  "serializes concurrent $source / $sourceKind issue dispatch and durable wake",
  async ({ source, sourceKind }) => {
    const { companyId, runId } = await seedRecoveryRun(sourceKind, true);
    control.gate = new Promise<void>((resolve) => { control.release = resolve; });

    const first = syncWorkflowRunState(left, runId, source);
    let second: ReturnType<typeof syncWorkflowRunState> | undefined;
    let overlap = "";
    try {
      await waitUntil(async () => control.arrivals >= 1 ? true : null, "first issue creation");
      second = syncWorkflowRunState(right, runId, source);
      overlap = await waitUntil(async () => {
        if (control.arrivals >= 2) return "both_reached_create";
        const rows = await observer.$client<{ pid: number }[]>`
          select pid from pg_stat_activity
          where application_name = ${rightApplication} and cardinality(pg_blocking_pids(pid)) > 0
        `;
        return rows.length ? "second_db_blocked" : null;
      }, "second creation or database lock");
    } finally {
      control.release();
    }
    const outcomes = await Promise.allSettled([first, ...(second ? [second] : [])]);
    const created = await observer.select({ id: issues.id }).from(issues).where(and(
      eq(issues.companyId, companyId), eq(issues.originRunId, runId), eq(issues.originKind, "workflow_execution"),
    ));
    const steps = await observer.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    const wakes = await observer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    console.log("T16E_SYNC_RACE", JSON.stringify({ source, sourceKind, overlap, arrivals: control.arrivals,
      issues: created.length, steps: steps.length, wakes: wakes.length, outcomes: outcomes.map((item) => item.status) }));
    expect(outcomes.map((item) => item.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(created).toHaveLength(1);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.issueId).toBe(created[0]?.id);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.issueId).toBe(created[0]?.id);
    expect(wakes[0]?.workflowRunId).toBe(runId);
    expect(wakes[0]?.workflowStepRunId).toBe(steps[0]?.id);
  }, 120_000,
);

it.each(["manual", "quality"] as const)("does not duplicate a %s wake while the first wake is delayed", async (sourceKind) => {
  const { companyId, runId } = await seedRecoveryRun(sourceKind);
  control.gate = Promise.resolve();
  control.holdWake = true;
  control.wakeArrivals = 0;
  control.wakeGate = new Promise<void>((resolve) => { control.releaseWake = resolve; });

  const first = syncWorkflowRunState(left, runId);
  let second: ReturnType<typeof syncWorkflowRunState> | undefined;
  let secondFinished = false;
  try {
    await waitUntil(async () => control.wakeArrivals === 1 ? true : null, "first wake boundary");
    second = syncWorkflowRunState(right, runId);
    void second.then(() => { secondFinished = true; }, () => { secondFinished = true; });
    await waitUntil(async () => {
      const blocked = await observer.$client<{ pid: number }[]>`select pid from pg_stat_activity
        where application_name = ${rightApplication} and cardinality(pg_blocking_pids(pid)) > 0`;
      return secondFinished || blocked.length ? true : null;
    }, "second wake or lock");
  } finally {
    control.releaseWake();
    control.holdWake = false;
  }
  await Promise.all([first, second!]);
  const wakes = await observer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
  console.log("T16E_WAKE_GAP", JSON.stringify({ sourceKind, wakeRows: wakes.length, coalesced: wakes[0]?.coalescedCount ?? null }));
  expect(wakes).toHaveLength(1);
  expect(wakes[0]?.coalescedCount).toBe(0);
}, 120_000);

it("recovers an initial wake failure when a competing sync was already waiting", async () => {
  const { companyId, runId } = await seedRecoveryRun();
  control.gate = Promise.resolve();
  control.failInitialWake = true;
  control.holdWake = true;
  control.wakeArrivals = 0;
  control.wakeGate = new Promise<void>((resolve) => { control.releaseWake = resolve; });
  const first = syncWorkflowRunState(left, runId);
  let second: ReturnType<typeof syncWorkflowRunState> | undefined;
  try {
    await waitUntil(async () => control.wakeArrivals ? true : null, "failing first wake");
    second = syncWorkflowRunState(right, runId);
    await waitUntil(async () => {
      const blocked = await observer.$client<{ pid: number }[]>`select pid from pg_stat_activity
        where application_name = ${rightApplication} and cardinality(pg_blocking_pids(pid)) > 0`;
      return blocked.length ? true : null;
    }, "waiting recovery wake");
  } finally { control.releaseWake(); control.holdWake = false; }
  await Promise.all([first, second!]);
  const wakes = await observer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
  console.log("T16E_WAKE_RECOVERY", JSON.stringify({ wakes: wakes.length, reason: wakes[0]?.reason }));
  expect(wakes).toHaveLength(1);
  expect(wakes[0]?.reason).toBe("workflow_step_runnable");
}, 120_000);

async function seedRecoveryRun(sourceKind = "manual", withMission = false) {
  const companyId = randomUUID(), agentId = randomUUID(), workflowId = randomUUID(), runId = randomUUID();
  const missionId = withMission ? randomUUID() : null;
  control.runId = runId;
  control.arrivals = 0;
  control.holdWake = false;
  control.bindingProbe = null;
  await observer.insert(companies).values({ id: companyId, name: "T16e recovery",
    issuePrefix: `TR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}` });
  await observer.insert(agents).values({ id: agentId, companyId, name: "T16e worker", role: "engineer",
    status: "paused", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
  if (missionId) await observer.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId,
    title: "T16e isolated mission", status: "active" });
  await observer.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "T16e recovery", sourceKind,
    stepsJson: [{ id: "work", name: "Work", type: "agent", agentId, dependencies: [] }] });
  await observer.insert(workflowRuns).values({ id: runId, companyId, workflowId, missionId,
    status: "running", triggeredBy: "system", startedAt: new Date() });
  await observer.insert(workflowStepRuns).values({ workflowRunId: runId, stepId: "work", status: "pending" });
  return { companyId, runId };
}

it("lets the competing sync finish dispatch after the first create rolls back", async () => {
  const { companyId, runId } = await seedRecoveryRun();
  control.failAfterCreate = true;
  control.gate = new Promise<void>((resolve) => { control.release = resolve; });
  const first = syncWorkflowRunState(left, runId);
  void first.catch(() => {});
  let second: ReturnType<typeof syncWorkflowRunState> | undefined;
  let secondFinished = false;
  try {
    await waitUntil(async () => control.arrivals === 1 ? true : null, "first failing creation");
    second = syncWorkflowRunState(right, runId);
    void second.then(() => { secondFinished = true; }, () => { secondFinished = true; });
    await waitUntil(async () => {
      const blocked = await observer.$client<{ pid: number }[]>`select pid from pg_stat_activity
        where application_name = ${rightApplication} and cardinality(pg_blocking_pids(pid)) > 0`;
      return secondFinished || blocked.length ? true : null;
    }, "competing sync");
  } finally { control.release(); }
  const results = await Promise.allSettled([first, second!]);
  const created = await observer.select().from(issues).where(eq(issues.originRunId, runId));
  const wakes = await observer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
  console.log("T16E_ROLLBACK_RECOVERY", JSON.stringify({ outcomes: results.map((r) => r.status), issues: created.length, wakes: wakes.length }));
  expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled"]);
  expect(created).toHaveLength(1);
  expect(wakes).toHaveLength(1);
}, 120_000);

it("finishes independent runs while several calls wait on one dispatch", async () => {
  const fixtures = await Promise.all(Array.from({ length: 12 }, () => seedRecoveryRun()));
  const held = await seedRecoveryRun();
  control.gate = new Promise<void>((resolve) => { control.release = resolve; });
  const runIds = fixtures.map((f) => f.runId), companyIds = fixtures.map((f) => f.companyId);
  const first = syncWorkflowRunState(left, held.runId); void first.catch(() => {});
  await waitUntil(async () => control.arrivals ? true : null, "held pool dispatch");
  const waiters = Array.from({ length: 4 }, () => syncWorkflowRunState(left, held.runId));
  for (const waiter of waiters) void waiter.catch(() => {});
  let competing: Promise<unknown[]> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // 같은 프로세스 대기자는 풀 연결을 쥐지 않고 게이트 순번만 기다리므로 pg_stat_activity에
    // 나타나지 않는다. 선행 읽기를 지나 순번에 도달할 시간을 준 뒤, 아무도 바쁜 dispatch를
    // 넘어 creation에 끼어들지 않았는지(중복 방지 계약) 확인하고 독립 실행 경합을 건다.
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(control.arrivals).toBe(1);
    competing = Promise.all(runIds.map((id) => syncWorkflowRunState(left, id)));
    await Promise.race([competing, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("pool_starved")), 10_000); })]);
  } finally {
    clearTimeout(timer); control.release();
    await Promise.allSettled([first, ...waiters, ...(competing ? [competing] : [])]);
  }
  const heldSettled = await Promise.allSettled([first, ...waiters]);
  const heldIssues = await observer.select().from(issues).where(eq(issues.originRunId, held.runId));
  const heldWakes = await observer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, held.companyId));
  const created = await observer.select().from(issues).where(inArray(issues.originRunId, runIds));
  const wakes = await observer.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.companyId, companyIds));
  console.log("T16E_POOL_FAIRNESS", JSON.stringify({ heldOutcomes: heldSettled.map((r) => r.status),
    heldIssues: heldIssues.length, heldWakes: heldWakes.length, created: created.length, wakes: wakes.length }));
  expect(heldSettled.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "fulfilled", "fulfilled", "fulfilled"]);
  expect(heldIssues).toHaveLength(1);
  expect(heldWakes).toHaveLength(1);
  expect(created).toHaveLength(12); expect(wakes).toHaveLength(12);
}, 120_000);
// [기존 결함 기록 — E/existing-defects.md 'T16e #551' 행] 외부 소유 transaction 안에서 step issue를
// 만들면 root commit 전에 assignment wake가 호출된다. #551 순수 기준 5b6f72bd에서 동일하게 재현했고
// (E/t16e-root-transaction-baseline.log) 이 중복 방지 변경의 범위 밖으로 기록됐다. 결함 행을 고칠 때
// 이 기대를 false로 되돌려야 한다.
it("records that the assignment wake still fires before an owning transaction commits", async () => {
  const { runId } = await seedRecoveryRun();
  control.gate = Promise.resolve();
  control.observedUncommittedWake = false;
  control.bindingProbe = async (issueId) => (await observer.select({ id: workflowStepRuns.id }).from(workflowStepRuns)
    .where(eq(workflowStepRuns.issueId, issueId))).length > 0;
  try {
    await expect(left.transaction(async (tx) => {
      await syncWorkflowRunState(tx as unknown as typeof left, runId);
      throw new Error("t16e_rollback_owner");
    })).rejects.toThrow("t16e_rollback_owner");
  } finally { control.bindingProbe = null; }
  console.log("T16E_ROOT_COMMIT", JSON.stringify({ uncommittedWake: control.observedUncommittedWake }));
  expect(control.observedUncommittedWake).toBe(true);
}, 120_000);
