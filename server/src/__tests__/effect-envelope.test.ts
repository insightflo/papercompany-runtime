// server/src/__tests__/effect-envelope.test.ts
//
// [effect envelope] 비용·불가역 효과 이중 실행 방지 헬퍼의 단위 계약 검증.
//   (a) intent 기록 후 실행 중단 → 재시도(다른 시도)는 동일 효과 스킵
//   (b) 정상 1회 실행 → applied 기록
//   (c) 파라미터가 다른 효과 → 별도 실행
//   (d) 동시 중복 시도 → 하나만 실행
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb, effectIntents } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { executeFencedEffect, recordEffectIntent } from "../services/effect-envelope.js";
import { logger } from "../middleware/logger.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;

describeEP("effect envelope (executeFencedEffect)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let warnSpy: ReturnType<typeof vi.spyOn> | null = null;

  const baseInput = () => ({
    companyId,
    effectKind: "test.effect",
    anchor: { agentId: "agent-1", taskKey: "task-a" },
    generation: { processLossRetryCount: 0, fallbackAttempt: 0 },
    params: { adapterType: "stub", command: "run.sh", model: null, provider: null },
  });

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("effect-envelope-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "EffectEnvelopeCo", status: "active" });
  });
  afterAll(() => {
    warnSpy?.mockRestore();
    tempDb = null;
  });

  it("(b) executes once and records applied for a normal single execution", async () => {
    const execute = vi.fn(async () => ({ marker: randomUUID() }));
    const result = await executeFencedEffect(db, {
      ...baseInput(),
      attemptRunId: "run-b",
      execute,
    });
    expect(result.outcome).toBe("executed");
    if (result.outcome !== "executed") return;
    expect(result.value).toEqual({ marker: expect.any(String) });
    expect(execute).toHaveBeenCalledTimes(1);

    const [row] = await db.select().from(effectIntents).where(eq(effectIntents.effectId, result.effectId));
    expect(row?.status).toBe("applied");
    expect(row?.effectKind).toBe("test.effect");
    expect(row?.attemptRunId).toBe("run-b");
    expect(row?.appliedAt).toBeInstanceOf(Date);
  });

  it("(a) skips the same effect on retry after intent was recorded but execution aborted", async () => {
    // 1회차: intent 만 기록하고 실행 중단(시뮬레이션 — executor 사망)
    const intent = await recordEffectIntent(db, {
      ...baseInput(),
      effectKind: "test.effect.a",
      attemptRunId: "run-a1",
    });
    expect(intent.inserted).toBe(true);

    // 2회차(재시도, 다른 시도 신원): 동일 효과 스킵
    const execute = vi.fn(async () => "should-not-run");
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const result = await executeFencedEffect(db, {
      ...baseInput(),
      effectKind: "test.effect.a",
      attemptRunId: "run-a2",
      execute,
    });
    expect(result.outcome).toBe("skipped_replay");
    if (result.outcome !== "skipped_replay") return;
    expect(result.status).toBe("intent");
    expect(result.attemptRunId).toBe("run-a1");
    expect(execute).not.toHaveBeenCalled();
    expect(
      warnSpy.mock.calls.some((args) =>
        args.some((arg) => typeof arg === "string" && arg.includes("fenced effect replay skipped"))),
    ).toBe(true);
    warnSpy.mockRestore();
    warnSpy = null;
  });

  it("skips replay when the same effect_id is already applied", async () => {
    const first = await executeFencedEffect(db, {
      ...baseInput(),
      effectKind: "test.effect.applied",
      attemptRunId: "run-c1",
      execute: async () => "done",
    });
    expect(first.outcome).toBe("executed");

    const execute = vi.fn(async () => "should-not-run");
    const second = await executeFencedEffect(db, {
      ...baseInput(),
      effectKind: "test.effect.applied",
      attemptRunId: "run-c2",
      execute,
    });
    expect(second.outcome).toBe("skipped_replay");
    if (second.outcome !== "skipped_replay") return;
    expect(second.status).toBe("applied");
    expect(execute).not.toHaveBeenCalled();
  });

  it("(c) executes a different-params effect separately", async () => {
    const first = await executeFencedEffect(db, {
      ...baseInput(),
      effectKind: "test.effect.params",
      attemptRunId: "run-d1",
      execute: async () => 1,
    });
    const second = await executeFencedEffect(db, {
      ...baseInput(),
      effectKind: "test.effect.params",
      attemptRunId: "run-d2",
      params: { adapterType: "other", command: "fallback.sh", model: "m2", provider: null },
      execute: async () => 2,
    });
    expect(first.outcome).toBe("executed");
    expect(second.outcome).toBe("executed");
    if (second.outcome !== "executed") return;
    if (first.outcome !== "executed") return;
    expect(second.effectId).not.toBe(first.effectId);
    expect(second.value).toBe(2);
  });

  it("executes a sanctioned new generation (process-loss retry) as a separate effect", async () => {
    // 세대 갱신(공인 재시도)은 별도 효과로 실행된다 — 펜스가 회복 경로를 막지 않음
    const first = await executeFencedEffect(db, {
      ...baseInput(),
      effectKind: "test.effect.generation",
      attemptRunId: "run-e1",
      execute: async () => 1,
    });
    expect(first.outcome).toBe("executed");
    const retry = await executeFencedEffect(db, {
      ...baseInput(),
      effectKind: "test.effect.generation",
      generation: { processLossRetryCount: 1, fallbackAttempt: 0 },
      attemptRunId: "run-e2",
      execute: async () => 2,
    });
    expect(retry.outcome).toBe("executed");
  });

  it("(d) concurrent duplicate attempts — only the intent owner executes", async () => {
    // 두 동시 시도가 같은 effect_id 를 겨냥하면 먼저 intent 를 삽입한 쪽만 실행한다.
    const execute = vi.fn(async () => "winner");
    const [r1, r2] = await Promise.all([
      executeFencedEffect(db, {
        ...baseInput(),
        effectKind: "test.effect.concurrent",
        attemptRunId: "run-f1",
        execute,
      }),
      executeFencedEffect(db, {
        ...baseInput(),
        effectKind: "test.effect.concurrent",
        attemptRunId: "run-f2",
        execute,
      }),
    ]);
    const outcomes = [r1.outcome, r2.outcome].sort();
    expect(outcomes).toEqual(["executed", "skipped_replay"]);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
