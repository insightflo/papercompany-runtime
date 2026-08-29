import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, missions } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentWikiService, formatWikiLessons } from "../services/agent-wiki.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping agent wiki injection gate tests: ${support.reason ?? "unsupported"}`);
}

// [컨텍스트 비대 방어 G8 + WikiSkill 주입 원칙] adapter 프롬프트에 주입되는 과거 실패 교훈은
//   (1) 에이전트가 행동으로 실천 가능한 것(audience='agent')만,
//   (2) 최근에 실제로 재발한 것만(신선도 게이트),
//   (3) 길이 상한 내에서만 들어가야 한다. 인프라 실패 카운터(process_lost 등)는
//   ops 대시보드용으로 계속 수집되되 주입되지 않는다.
describeEP("agent wiki injection gate (audience + freshness + length caps)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("agent-wiki-gate-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Wiki Gate Co", status: "active" });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Wiki Agent", role: "researcher",
      status: "active", adapterType: "claude_local", adapterConfig: {},
      runtimeConfig: {}, permissions: {},
    });
  }, 60_000);

  afterEach(async () => {
    await db.delete(missions);
    await db.delete(agents).where((await import("drizzle-orm")).eq(agents.id, agentId)).catch(() => undefined);
    // entries cascade on agent delete; re-seed the agent for the next test
    await db.delete(agents);
    agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId, companyId, name: `Wiki Agent ${agentId.slice(0, 6)}`, role: "researcher",
      status: "active", adapterType: "claude_local", adapterConfig: {},
      runtimeConfig: {}, permissions: {},
    });
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  it("records audience 'agent' explicitly and defaults unknown lessons to 'ops' (fail-closed)", async () => {
    const wiki = agentWikiService(db);
    await wiki.recordFailure({
      companyId, agentId,
      pattern: "workProduct 미등록",
      cause: "산출물 미등록",
      solution: "Workflow API로 등록한다",
      errorCode: "workproduct_registration_missing",
      audience: "agent",
    });
    await wiki.recordFailure({
      companyId, agentId,
      pattern: "process_lost (adapter 자식 프로세스 상실)",
      cause: "프로세스 상실",
      solution: "detached 30min cap + graceful shutdown",
      errorCode: "process_lost",
    });
    const all = await wiki.list(companyId);
    expect(all).toHaveLength(2);
    expect(all.find((e) => e.errorCode === "workproduct_registration_missing")?.audience).toBe("agent");
    expect(all.find((e) => e.errorCode === "process_lost")?.audience).toBe("ops");
  });

  it("searchRelevant injects only agent-actionable lessons — infra counters stay out of prompts", async () => {
    const wiki = agentWikiService(db);
    await wiki.recordFailure({
      companyId, agentId,
      pattern: "adapter_failed (adapter 실행 실패)",
      cause: "인프라",
      solution: "ops 런북 텍스트",
      errorCode: "adapter_failed",
    });
    await wiki.recordFailure({
      companyId, agentId,
      pattern: "Step Input Manifest 광범위 검색 차단",
      cause: "광범위 검색",
      solution: "등록된 정확한 경로만 검색한다",
      errorCode: "step_input_manifest_guardrail",
      audience: "agent",
    });
    const relevant = await wiki.searchRelevant({ companyId, agentId });
    expect(relevant).toHaveLength(1);
    expect(relevant[0]?.errorCode).toBe("step_input_manifest_guardrail");
  });

  it("searchRelevant drops lessons not seen within the freshness window", async () => {
    const wiki = agentWikiService(db);
    await wiki.recordFailure({
      companyId, agentId,
      pattern: "오래된 교훈",
      cause: "c",
      solution: "s",
      errorCode: "stale_lesson",
      audience: "agent",
    });
    // 15일 전으로 lastSeenAt 되돌리기 — 재발 없으면 주입도 멈춘다(markResolved 의존 제거)
    const { eq } = await import("drizzle-orm");
    const { agentWikiEntries } = await import("@paperclipai/db");
    await db.update(agentWikiEntries)
      .set({ lastSeenAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000) })
      .where(eq(agentWikiEntries.errorCode, "stale_lesson"));
    const relevant = await wiki.searchRelevant({ companyId, agentId });
    expect(relevant.find((e) => e.errorCode === "stale_lesson")).toBeUndefined();
  });

  it("formatWikiLessons truncates long pattern/solution lines (bounded prompt section)", () => {
    const longPattern = "패턴".repeat(120);
    const longSolution = "해결".repeat(400);
    const section = formatWikiLessons([{
      id: randomUUID(),
      companyId, agentId,
      missionId: null,
      pattern: longPattern,
      cause: "c",
      solution: longSolution,
      errorCode: null,
      stepId: null,
      frequency: 9,
      status: "active",
      audience: "agent",
      lastSeenAt: new Date(),
      resolvedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never]);
    expect(section).not.toBeNull();
    expect(section!.length).toBeLessThan(1200);
    expect(section).not.toContain(longPattern.slice(0, 200));
  });
});
