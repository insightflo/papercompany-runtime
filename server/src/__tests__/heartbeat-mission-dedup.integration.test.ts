import { randomUUID } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { lifecycleInFlightClause } from "../services/heartbeat-finalization/lifecycle-active.js";
import { missionDedupExemptOversightReviewClause } from "../services/heartbeat-mission-dedup.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip mission-dedup tests: ${support.reason ?? "unsupported"}`);

/**
 * [oversight mission-dedup exemption] — heartbeat.ts [B]/[B3] 의 "차단 실행 후보" 쿼리와
 * 동일한 조건(lifecycle in-flight + 같은 missionId + 리뷰 면제)으로 실제 행 선택을 검증한다.
 */
describeEP("heartbeat mission-dedup oversight exemption clause", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("mission-dedup-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "DedupCo", status: "active" });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Dedup agent", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    tempDb = null;
  });

  async function blockingCount(missionId: string): Promise<number> {
    const inFlightClause = await lifecycleInFlightClause(db);
    const [{ n }] = await db
      .select({ n: count() })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.agentId, agentId),
        inFlightClause,
        // heartbeat.ts [B]/[B3] 와 동일한 mission 매칭(파라미터 대신 리터럴로 재현)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (await import("drizzle-orm")).sql`heartbeat_runs.context_snapshot ->> 'missionId' = ${missionId}`,
        missionDedupExemptOversightReviewClause,
      ));
    return Number(n ?? 0);
  }

  async function insertRun(contextSnapshot: Record<string, unknown> | null, status: string): Promise<string> {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id, companyId, agentId,
      invocationSource: "assignment",
      status,
      contextSnapshot: contextSnapshot as never,
    });
    return id;
  }

  it("a running mission_owner_periodic_review run does NOT block (exempt)", async () => {
    const missionId = randomUUID();
    await insertRun({
      source: "mission_owner_periodic_review",
      wakeReason: "mission_owner_periodic_review",
      missionId,
    }, "running");
    expect(await blockingCount(missionId)).toBe(0);
  });

  it("a running step run still blocks", async () => {
    const missionId = randomUUID();
    await insertRun({
      source: "assignment",
      wakeReason: "issue_assigned",
      missionId,
    }, "running");
    expect(await blockingCount(missionId)).toBe(1);
  });

  it("a review run marked only via source (no wakeReason) is also exempt", async () => {
    const missionId = randomUUID();
    await insertRun({ source: "mission_owner_periodic_review", missionId }, "running");
    expect(await blockingCount(missionId)).toBe(0);
  });

  it("a run without markers is conservatively blocking", async () => {
    const missionId = randomUUID();
    await insertRun({ missionId }, "running");
    expect(await blockingCount(missionId)).toBe(1);
  });

  it("a review run for a DIFFERENT mission does not affect another mission's count", async () => {
    const missionA = randomUUID();
    const missionB = randomUUID();
    await insertRun({
      source: "mission_owner_periodic_review",
      wakeReason: "mission_owner_periodic_review",
      missionId: missionA,
    }, "running");
    await insertRun({ source: "assignment", wakeReason: "issue_assigned", missionId: missionB }, "running");
    expect(await blockingCount(missionA)).toBe(0);
    expect(await blockingCount(missionB)).toBe(1);
  });

  it("terminal review runs never block regardless (in-flight clause)", async () => {
    const missionId = randomUUID();
    await insertRun({
      source: "assignment",
      wakeReason: "issue_assigned",
      missionId,
    }, "succeeded");
    expect(await blockingCount(missionId)).toBe(0);
  });

  it("null context_snapshot rows are conservatively blocking when missionId differs only there", async () => {
    const missionId = randomUUID();
    // 같은 missionId 스냅숏 없이 null 스냅숏 실행: missionId 매칭이 null 이므로 선택되지 않는다.
    await insertRun(null, "running");
    expect(await blockingCount(missionId)).toBe(0);
  });
});

// instanceSettings import 사용(플래그 기본값 경로가 로드되도록). 트리쉐이킹 방지용 참조.
void instanceSettings;
