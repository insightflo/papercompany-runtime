import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  AGENT_FIT_MIN_RUNS,
  recommendModelTier,
  recommendSessionThreshold,
  refreshAgentFitProfiles,
} from "../services/agent-fit-evaluator.js";

/**
 * [agent fit observation] 코어 자동 누계·제안 — 런 종료 훅(정산 최심부)이 아닌
 * 스케줄러 틱에서 metadata 를 관찰 전용으로 갱신한다. 여기서 검증하는 것:
 * 1) 규칙 판정(임계 상향/모델 계층)이 의도대로
 * 2) refresh 가 metadata.fitProfile 을 병합 저장 (형제 키 보존)
 * 3) 6h 스로틀 — 신선한 프로필은 다시 쓰지 않음
 * 4) 런 부족(미달) 에이전트는 건드리지 않음 (기존 프로필/형제 키 유지)
 */

describe("agent fit evaluator rules", () => {
  it("recommends raise when fresh-session floor approaches the threshold (per-run rotation thrash)", () => {
    const verdict = recommendSessionThreshold({
      adapterType: "commandcode_local", threshold: 300_000,
      floorTok: 296_000, p50Tok: 400_000, p90Tok: 450_000,
      runs: 20, sessions: 20,
    });
    expect(verdict.verdict).toBe("raise");
    expect(verdict.suggestedTokens).toBeGreaterThanOrEqual(296_000 * 1.5);
  });

  it("keeps healthy thresholds and flags intra-run growth separately", () => {
    const healthy = recommendSessionThreshold({
      adapterType: "pi_local", threshold: 2_000_000,
      floorTok: 20_000, p50Tok: 100_000, p90Tok: 300_000,
      runs: 100, sessions: 90,
    });
    expect(healthy.verdict).toBe("keep");

    const intraRun = recommendSessionThreshold({
      adapterType: "commandcode_local", threshold: 300_000,
      floorTok: 100_000, p50Tok: 300_000, p90Tok: 1_000_000,
      runs: 20, sessions: 4,
    });
    expect(intraRun.verdict).toBe("keep_info");
    expect(intraRun.suggestedTokens).toBeNull();
  });

  it("marks adapter-managed session types as not applicable", () => {
    const verdict = recommendSessionThreshold({
      adapterType: "claude_local", threshold: 2_000_000,
      floorTok: 500_000, p50Tok: 900_000, p90Tok: 1_800_000,
      runs: 50, sessions: 50,
    });
    expect(verdict.verdict).toBe("na");
  });

  it("model tier: simple repetitive profile → down; low success + normal context → up", () => {
    expect(recommendModelTier({ runs: 733, okPct: 99, avgTok: 34_000, avgMin: 0.3, costSharePct: 2 }).verdict).toBe("down");
    expect(recommendModelTier({ runs: 24, okPct: 62, avgTok: 200_000, avgMin: 16.6, costSharePct: 0 }).verdict).toBe("up");
    expect(recommendModelTier({ runs: 24, okPct: 62, avgTok: 600_000, avgMin: 16.6, costSharePct: 0 }).verdict).toBe("keep_flag");
    expect(recommendModelTier({ runs: 213, okPct: 84, avgTok: 85_000, avgMin: 2.5, costSharePct: 10 }).verdict).toBe("keep");
  });
});

describe("agent fit profile refresh (metadata observation lane)", () => {
  let db: Awaited<ReturnType<typeof createDb>>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-fit-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgentWithRuns(input: {
    threshold?: number;
    okRuns?: number;
    failedRuns?: number;
    rawTokens?: number;
    extraMetadata?: Record<string, unknown>;
  }): Promise<string> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Fit Co ${companyId.slice(0, 8)}`,
      issuePrefix: `FC${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const heartbeat: Record<string, unknown> = { maxConcurrentRuns: 2 };
    if (typeof input.threshold === "number") {
      heartbeat.sessionCompaction = { maxRawInputTokens: input.threshold };
    }
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Fit Agent ${agentId.slice(0, 8)}`,
      role: "worker",
      status: "idle",
      adapterType: "commandcode_local",
      adapterConfig: { model: "meta/muse-spark-1.2-contributor" },
      runtimeConfig: { heartbeat },
      metadata: { defaultParentIssueId: "keep-me", ...(input.extraMetadata ?? {}) },
    });
    const ok = input.okRuns ?? AGENT_FIT_MIN_RUNS;
    const failed = input.failedRuns ?? 0;
    const base = Date.now() - 3 * 24 * 60 * 60_000;
    const rows = [];
    for (let i = 0; i < ok; i += 1) {
      rows.push({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "timer",
        status: "succeeded",
        startedAt: new Date(base + i * 60_000),
        finishedAt: new Date(base + i * 60_000 + 120_000),
        usageJson: { rawInputTokens: input.rawTokens ?? 350_000, inputTokens: 100, outputTokens: 200 },
        sessionIdAfter: `sess-${Math.floor(i / 2)}`,
      });
    }
    for (let i = 0; i < failed; i += 1) {
      rows.push({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "timer",
        status: "failed",
        startedAt: new Date(base + (ok + i) * 60_000),
        finishedAt: new Date(base + (ok + i) * 60_000 + 60_000),
        usageJson: { rawInputTokens: input.rawTokens ?? 350_000, inputTokens: 100, outputTokens: 50 },
        sessionIdAfter: `sess-${Math.floor((ok + i) / 2)}`,
      });
    }
    await db.insert(heartbeatRuns).values(rows);
    return agentId;
  }

  it("writes fitProfile into metadata while preserving sibling keys, then throttles fresh profiles", async () => {
    const now = new Date("2026-08-31T12:00:00.000Z");
    const agentId = await seedAgentWithRuns({ threshold: 300_000, okRuns: 10, failedRuns: 2, rawTokens: 100_000 });

    const first = await refreshAgentFitProfiles(db, { now });
    expect(first.updatedCount).toBe(1);

    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    const metadata = row.metadata as Record<string, unknown>;
    expect(metadata.defaultParentIssueId).toBe("keep-me");
    const fit = metadata.fitProfile as Record<string, unknown>;
    expect(fit.version).toBe(1);
    expect(fit.runs).toBe(12);
    expect(fit.sessionThresholdTokens).toBe(300_000);
    expect((fit.thresholdVerdict as { verdict: string }).verdict).toBe("keep");
    expect((fit.modelVerdict as { verdict: string; reasons: string[] }).reasons.length).toBeGreaterThan(0);

    // 6h 스로틀: computedAt 직후 재실행 → skip
    const second = await refreshAgentFitProfiles(db, { now: new Date(now.getTime() + 60_000) });
    expect(second.updatedCount).toBe(0);
    expect(second.skippedFreshCount).toBe(1);

    // 7h 후 → 재계산
    const third = await refreshAgentFitProfiles(db, { now: new Date(now.getTime() + 7 * 60 * 60_000) });
    expect(third.updatedCount).toBe(1);
  });

  it("does not touch agents below the minimum run count (metadata untouched)", async () => {
    const agentId = await seedAgentWithRuns({ okRuns: AGENT_FIT_MIN_RUNS - 1 });
    const result = await refreshAgentFitProfiles(db, {});
    expect(result.updatedCount).toBe(0);
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    const metadata = row.metadata as Record<string, unknown>;
    expect(metadata.defaultParentIssueId).toBe("keep-me");
    expect(metadata.fitProfile).toBeUndefined();
  });
});
