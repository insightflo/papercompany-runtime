// server/src/__tests__/heartbeat-effect-envelope.test.ts
//
// [effect envelope] heartbeat adapter.execute 경계 펜스의 통합 계약:
//   1. 첫 디스패치는 adapter 를 1회 실행하고 applied 장부를 남긴다.
//   2. 순차적 의도적 재디스패치(같은 taskKey 재호출)는 새 디스패치 세대로 정상 실행된다
//      — 펜스가 기존 재실행 흐름(코멘트 재런, 회복 브리프 등)을 막지 않는 회귀 가드.
//   3. 동시 중복 디스패치 형태(동일 dispatchGeneration 을 가진 쌍둥이 런 — 생성 경쟁에서
//      커밋 전을 관측해 같은 서수를 받은 경우)는 두 번째 실행이 펜스된다.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, effectIntents, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";

const executeSpy = vi.fn();

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: vi.fn(() => ({
    supportsLocalAgentJwt: false,
    execute: executeSpy,
  })),
  runningProcesses: new Map(),
}));

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;

function successfulAdapterResult() {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    usage: null,
    provider: "test",
    model: "test-model",
    resultJson: null,
    runtimeServices: [],
  };
}

async function waitForRunTerminal(heartbeat: ReturnType<typeof heartbeatService>, runId: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && run.status !== "queued" && run.status !== "running") {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for run ${runId} to finish`);
}

async function seedQueuedRun(
  db: ReturnType<typeof createDb>,
  companyId: string,
  agentId: string,
  contextSnapshot: Record<string, unknown>,
) {
  const id = randomUUID();
  await db.insert(heartbeatRuns).values({
    id,
    companyId,
    agentId,
    invocationSource: "on_demand",
    triggerDetail: "manual",
    status: "queued",
    contextSnapshot,
  } as never);
  return id;
}

describeEP("heartbeat adapter.execute effect envelope", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-effect-envelope-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "EnvelopeCo", status: "active" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Envelope agent",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
  });

  it("first dispatch executes the adapter once and records an applied ledger row", async () => {
    executeSpy.mockReset();
    executeSpy.mockResolvedValue(successfulAdapterResult());

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { taskKey: "envelope-task-a" }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });
    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    expect(executeSpy).toHaveBeenCalledTimes(1);

    const [row] = await db
      .select()
      .from(effectIntents)
      .where(eq(effectIntents.attemptRunId, run!.id));
    expect(row?.status).toBe("applied");
    expect(row?.effectKind).toBe("heartbeat.adapter_execute");
    expect(row?.generationKey).toContain("\"dispatchGeneration\":1");
  });

  it("sequential deliberate re-dispatch of the same taskKey executes again (new generation)", async () => {
    executeSpy.mockReset();
    executeSpy.mockResolvedValue(successfulAdapterResult());

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { taskKey: "envelope-task-a" }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });
    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    expect(executeSpy).toHaveBeenCalledTimes(1);

    // 두 실행 모두 각자의 applied 장부 행을 가진다(디스패치 세대가 다른 별도 효과).
    const ledger = await db.select().from(effectIntents).where(eq(effectIntents.companyId, companyId));
    expect(ledger.length).toBe(2);
    expect(ledger.every((row) => row.status === "applied")).toBe(true);
  });

  it("concurrent duplicate dispatch shape (twin runs sharing one dispatchGeneration) fences the second", async () => {
    executeSpy.mockReset();
    executeSpy.mockResolvedValue(successfulAdapterResult());

    // 생성 경쟁 시뮬레이션: 두 런이 커밋 전 서수를 관측해 동일 dispatchGeneration 을 스탬프받음.
    const twinContext = { taskKey: "envelope-task-twin", dispatchGeneration: 7 };
    const runId1 = await seedQueuedRun(db, companyId, agentId, twinContext);
    const runId2 = await seedQueuedRun(db, companyId, agentId, twinContext);

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns(agentId);
    const finalized1 = await waitForRunTerminal(heartbeat, runId1);
    await heartbeat.resumeQueuedRuns(agentId);
    const finalized2 = await waitForRunTerminal(heartbeat, runId2);

    const statuses = [finalized1.status, finalized2.status].sort();
    expect(statuses).toEqual(["failed", "succeeded"]);
    const fenced = finalized1.errorCode === "fenced_effect_replay_skipped" ? finalized1 : finalized2;
    expect(fenced.errorCode).toBe("fenced_effect_replay_skipped");
    // 비용 있는 효과(adapter 실행)는 정확히 1회만 호출된다.
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  it("a different logical effect (distinct taskKey) executes normally", async () => {
    executeSpy.mockReset();
    executeSpy.mockResolvedValue(successfulAdapterResult());

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { taskKey: "envelope-task-b" }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });
    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });
});
