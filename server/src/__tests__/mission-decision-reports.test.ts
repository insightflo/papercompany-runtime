import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, missions } from "@paperclipai/db";
import { missionRollingState } from "@paperclipai/db";
import {
  applyMissionDecisionReports,
  getMissionDecisionLog,
  missionDecisionReportSchema,
} from "../services/missions/mission-decision-reports.js";
import { updateMissionRollingStateFromHandoff } from "../services/missions/mission-runtime-manager.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres decision report tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("missionDecisionReportSchema (input contract)", () => {
  it("accepts a valid report with status and supersedes", () => {
    const parsed = missionDecisionReportSchema.parse({
      updates: [
        { id: "D-1", summary: "Use PGlite", status: "confirmed", supersedes: null },
        { id: "D-2", status: "retired" },
      ],
    });
    expect(parsed.updates).toHaveLength(2);
  });

  it("rejects unknown statuses, empty ids, and empty update lists", () => {
    expect(() => missionDecisionReportSchema.parse({ updates: [{ id: "D-1", status: "draft" }] })).toThrow();
    expect(() => missionDecisionReportSchema.parse({ updates: [{ id: "   ", summary: "x" }] })).toThrow();
    expect(() => missionDecisionReportSchema.parse({ updates: [] })).toThrow();
  });

  it("rejects more than 20 updates in one report", () => {
    const updates = Array.from({ length: 21 }, (_, i) => ({ id: `D-${i}` }));
    expect(() => missionDecisionReportSchema.parse({ updates })).toThrow();
  });
});

describeEmbeddedPostgres("applyMissionDecisionReports (direct agent/board producer)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mission-decision-report-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(missionRollingState);
    await db.delete(heartbeatRuns);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedMission() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Decision Report Company",
      issuePrefix: `DR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Decision Reporter",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Decision report mission",
      status: "active",
    });
    return { companyId, missionId, agentId };
  }

  it("creates the rolling state decision log from a direct report without handoff provenance", async () => {
    const { companyId, missionId, agentId } = await seedMission();

    const result = await applyMissionDecisionReports(db, {
      companyId,
      missionId,
      updates: [{ id: "D-1", summary: "Use PGlite for dev" }],
    });

    expect(result.revision).toBe(1);
    expect(result.appliedUpdates).toBe(1);
    expect(result.decisions).toEqual([
      expect.objectContaining({
        id: "D-1",
        status: "under_review",
        handoffId: null,
      }),
    ]);
    expect(result.stateMarkdown).toContain("- [under_review] D-1: Use PGlite for dev");
  });

  it("merges follow-up reports, retires superseded decisions, and bumps revision without touching run accounting", async () => {
    const { companyId, missionId, agentId } = await seedMission();

    await applyMissionDecisionReports(db, {
      companyId,
      missionId,
      updates: [{ id: "D-1", summary: "Docker postgres", status: "confirmed" }],
    });
    const second = await applyMissionDecisionReports(db, {
      companyId,
      missionId,
      updates: [
        { id: "D-2", summary: "PGlite everywhere", status: "confirmed", supersedes: "D-1" },
        { id: "D-1", status: "retired" },
      ],
    });

    expect(second.revision).toBe(2);
    expect(second.appliedUpdates).toBe(2);
    expect(second.decisions?.find((d) => d.id === "D-1")).toMatchObject({ status: "retired" });
    expect(second.decisions?.find((d) => d.id === "D-2")).toMatchObject({
      status: "confirmed",
      supersedes: "D-1",
      handoffId: null,
    });
    // [계정 보존] 직접 보고는 실행 통계를 건드리지 않는다(런이 아니라 결정 기록이다).
    const [row] = await db.select().from(missionRollingState).limit(1);
    expect(row.totalRuns).toBe(0);
    expect(row.lastRunId).toBeNull();
  });

  it("interoperates with heartbeat handoff writes: both producers feed the same decision log", async () => {
    const { companyId, missionId, agentId } = await seedMission();

    await applyMissionDecisionReports(db, {
      companyId,
      missionId,
      updates: [{ id: "D-1", summary: "Docker postgres", status: "confirmed" }],
    });
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "succeeded",
      invocationSource: "test",
    });
    const [run] = await db.select().from(heartbeatRuns).limit(1);
    const afterHandoff = await updateMissionRollingStateFromHandoff(db, {
      companyId,
      missionId,
      runId: run.id,
      issueId: null,
      handoffId: "handoff-1",
      status: "succeeded",
      summaryText: "run summary",
      decisionUpdates: [{ id: "D-2", summary: "PGlite everywhere", supersedes: "D-1" }],
    });
    expect(afterHandoff.revision).toBe(2);
    expect(afterHandoff.stateJson.decisions?.find((d) => d.id === "D-1")).toMatchObject({ status: "retired" });
    expect(afterHandoff.stateJson.decisions?.find((d) => d.id === "D-2")?.handoffId).toBe("handoff-1");
    // 핸드오프 경유 갱신은 마지막 작성자 출처(handoff-1)로 찍힌다 — 직접 보고 기록도 핸드오프가 대체 갱신하면 출처가 핸드오프로 바뀐다(마지막 작성자 규칙).
    expect(afterHandoff.stateJson.decisions?.find((d) => d.id === "D-1")?.handoffId).toBe("handoff-1");
  });

  it("rejects invalid payloads with 422 before touching the database", async () => {
    const { companyId, missionId, agentId } = await seedMission();

    await expect(
      applyMissionDecisionReports(db, {
        companyId,
        missionId,
        updates: [{ id: "D-1", status: "draft" }],
      }),
    ).rejects.toMatchObject({ status: 422 });

    const log = await getMissionDecisionLog(db, { missionId });
    expect(log).toBeNull();
  });

  it("reads the decision log back with revision and markdown", async () => {
    const { companyId, missionId, agentId } = await seedMission();

    await applyMissionDecisionReports(db, {
      companyId,
      missionId,
      updates: [{ id: "D-1", summary: "Keep it simple", status: "confirmed" }],
    });
    const log = await getMissionDecisionLog(db, { missionId });

    expect(log).toMatchObject({ missionId, revision: 1 });
    expect(log?.decisions).toHaveLength(1);
    expect(log?.stateMarkdown).toContain("## Decision Log");
  });
});
