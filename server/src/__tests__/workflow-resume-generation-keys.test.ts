import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import {
  loadMutationCoreStepRun,
  seedMutationCoreGraph,
  seedMutationCoreStepRun,
  startMutationCoreFixture,
  type MutationCoreFixture,
} from "./helpers/workflow-resume-mutation-core-fixture.js";
import { withResumeSerialization } from "../services/workflow/resume/serialization.js";
import { resetForResume } from "../services/workflow/resume/reset.js";

/**
 * [목적] Task6a resetForResume 반환 map 의 prototype-key 회귀 검증 (실DB).
 *   stepId 는 임의 TEXT shared contract 이므로 "__proto__"/"constructor" 도 유효하며,
 *   반환 map 은 두 key 를 own property 로 정확히 가져야 한다. 이전 구현({})
 *   의 indexed assignment 는 "__proto__" 를 prototype setter 로 유실해 불완전한 map 을
 *   반환했다(실제 row 는 리셋됨). JSON round-trip 보존과 persisted generation 증가도 함께 검증.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("workflow resume reset generation map keys", () => {
  let fixture: MutationCoreFixture;
  let db: Db;

  beforeAll(async () => {
    fixture = await startMutationCoreFixture("resume-generation-keys-");
    if (!fixture.supported) throw new Error(fixture.reason);
    db = fixture.db;
  }, 60_000);
  afterAll(async () => {
    if (fixture?.supported) await fixture.cleanup();
  });

  const resetAllSteps = async (graph: Awaited<ReturnType<typeof seedMutationCoreGraph>>) =>
    withResumeSerialization(db, graph, ({ tx, steps }) => resetForResume(tx, {
      companyId: graph.companyId,
      workflowRunId: graph.runId,
      requestId: randomUUID(),
      steps,
      now: new Date("2026-09-08T03:00:00.000Z"),
    }));

  it("returns own exact entries for __proto__ and constructor step ids with exact persisted generations", async () => {
    const graph = await seedMutationCoreGraph(fixture.sql, "KEYS");
    const proto = await seedMutationCoreStepRun(db, {
      runId: graph.runId,
      stepId: "__proto__",
      values: { status: "failed", executionGeneration: 1 },
    });
    const ctor = await seedMutationCoreStepRun(db, {
      runId: graph.runId,
      stepId: "constructor",
      values: { status: "failed", executionGeneration: 7 },
    });
    const applied = await resetAllSteps(graph);
    // 반환 map 은 두 key 모두 own property 여야 하고 값은 정확히 old+1 이다.
    expect(Object.hasOwn(applied, "__proto__")).toBe(true);
    expect(Object.hasOwn(applied, "constructor")).toBe(true);
    expect(Object.entries(applied).sort(([a], [b]) => (a < b ? -1 : 1))).toEqual([
      ["__proto__", 2],
      ["constructor", 8],
    ]);
    // JSON round-trip 에도 두 key 가 모두 보존된다 (JSON.parse 는 "__proto__" 를 own key 로 정의).
    const roundTripped = JSON.parse(JSON.stringify(applied)) as Record<string, number>;
    expect(Object.hasOwn(roundTripped, "__proto__")).toBe(true);
    expect(Object.hasOwn(roundTripped, "constructor")).toBe(true);
    expect(Object.entries(roundTripped).sort(([a], [b]) => (a < b ? -1 : 1))).toEqual([
      ["__proto__", 2],
      ["constructor", 8],
    ]);
    // persisted row 도 실제로 각각 정확히 +1 증가한다(row reset 이 map 유실로 사라지지 않음).
    expect(await loadMutationCoreStepRun(fixture.sql, proto.id)).toMatchObject({
      step_id: "__proto__",
      status: "pending",
      execution_generation: 2,
    });
    expect(await loadMutationCoreStepRun(fixture.sql, ctor.id)).toMatchObject({
      step_id: "constructor",
      status: "pending",
      execution_generation: 8,
    });
  });

  it("returns a lone __proto__ entry without losing it when constructor is absent", async () => {
    const graph = await seedMutationCoreGraph(fixture.sql, "KEYS-ONE");
    const proto = await seedMutationCoreStepRun(db, {
      runId: graph.runId,
      stepId: "__proto__",
      values: { status: "failed", executionGeneration: 0 },
    });
    const applied = await resetAllSteps(graph);
    expect(Object.hasOwn(applied, "__proto__")).toBe(true);
    expect(Object.entries(applied)).toEqual([["__proto__", 1]]);
    const roundTripped = JSON.parse(JSON.stringify(applied)) as Record<string, number>;
    expect(Object.entries(roundTripped)).toEqual([["__proto__", 1]]);
    expect(await loadMutationCoreStepRun(fixture.sql, proto.id)).toMatchObject({
      step_id: "__proto__",
      execution_generation: 1,
    });
  });
});
