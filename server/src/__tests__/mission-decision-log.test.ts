import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  missionRollingState,
  missions,
} from "@paperclipai/db";
import {
  buildMissionIssueHandoffMarkdown,
  buildMissionStateMarkdown,
  mergeDecisionRecords,
  mergeRollingState,
  resolveMissionDecisionLogPointer,
  updateMissionRollingStateFromHandoff,
} from "../services/missions/mission-runtime-manager.js";
import type {
  MissionIssueHandoffDecisionUpdate,
  MissionRollingDecisionRecord,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres decision log tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const T0 = new Date("2026-09-05T00:00:00.000Z");
const T1 = new Date("2026-09-05T01:00:00.000Z");

describe("mergeDecisionRecords (deterministic decision-log merge)", () => {
  it("appends a new decision with under_review default status and handoff provenance", () => {
    const merged = mergeDecisionRecords(undefined, [
      { id: "D-1", summary: "Use PGlite for dev by default" },
    ], { handoffId: "handoff-1", now: T0 });

    expect(merged).toEqual([
      {
        id: "D-1",
        summary: "Use PGlite for dev by default",
        status: "under_review",
        supersedes: null,
        handoffId: "handoff-1",
        updatedAt: T0.toISOString(),
      },
    ]);
  });

  it("returns previous log unchanged when no updates are provided", () => {
    const previous: MissionRollingDecisionRecord[] = [
      { id: "D-1", summary: "Keep it", status: "confirmed", supersedes: null, handoffId: "h0", updatedAt: T0.toISOString() },
    ];
    expect(mergeDecisionRecords(previous, undefined, { handoffId: "h1", now: T1 })).toBe(previous);
    expect(mergeDecisionRecords(previous, [], { handoffId: "h1", now: T1 })).toBe(previous);
  });

  it("updates status and summary of an existing decision by id without duplicating it", () => {
    const previous: MissionRollingDecisionRecord[] = [
      { id: "D-1", summary: "Draft approach", status: "under_review", supersedes: null, handoffId: "h0", updatedAt: T0.toISOString() },
    ];
    const merged = mergeDecisionRecords(previous, [
      { id: "D-1", status: "confirmed", summary: "Final approach" },
    ], { handoffId: "h1", now: T1 });

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: "D-1",
      summary: "Final approach",
      status: "confirmed",
      handoffId: "h1",
      updatedAt: T1.toISOString(),
    });
  });

  it("retires the superseded decision and keeps it in the log when a newer decision supersedes it", () => {
    const previous: MissionRollingDecisionRecord[] = [
      { id: "D-1", summary: "Docker postgres for dev", status: "confirmed", supersedes: null, handoffId: "h0", updatedAt: T0.toISOString() },
    ];
    const merged = mergeDecisionRecords(previous, [
      { id: "D-2", summary: "Switch to PGlite", status: "confirmed", supersedes: "D-1" },
    ], { handoffId: "h1", now: T1 });

    expect(merged).toHaveLength(2);
    expect(merged.find((d) => d.id === "D-1")).toMatchObject({ status: "retired", handoffId: "h1" });
    expect(merged.find((d) => d.id === "D-2")).toMatchObject({
      status: "confirmed",
      supersedes: "D-1",
    });
  });

  it("applies updates sequentially so a later update can confirm what an earlier one created", () => {
    const merged = mergeDecisionRecords(undefined, [
      { id: "D-1", summary: "Approach A" },
      { id: "D-1", status: "confirmed" },
    ], { handoffId: "h1", now: T1 });

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: "D-1", status: "confirmed", summary: "Approach A" });
  });

  it("drops updates with empty ids and creations without a summary deterministically", () => {
    const previous: MissionRollingDecisionRecord[] = [
      { id: "D-1", summary: "Existing", status: "under_review", supersedes: null, handoffId: "h0", updatedAt: T0.toISOString() },
    ];
    const merged = mergeDecisionRecords(previous, [
      { id: "   ", summary: "invalid empty id" },
      { id: "D-9" },
      { id: "D-1", status: "confirmed" },
    ], { handoffId: "h1", now: T1 });

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: "D-1", status: "confirmed" });
  });

  it("caps the log at the last 50 records", () => {
    const previous: MissionRollingDecisionRecord[] = Array.from({ length: 50 }, (_, i) => ({
      id: `D-${i + 1}`,
      summary: `Decision ${i + 1}`,
      status: "under_review" as const,
      supersedes: null,
      handoffId: "h0",
      updatedAt: T0.toISOString(),
    }));
    const merged = mergeDecisionRecords(previous, [
      { id: "D-51", summary: "Newest" },
    ], { handoffId: "h1", now: T1 });

    expect(merged).toHaveLength(50);
    expect(merged[0].id).toBe("D-2");
    expect(merged[49]).toMatchObject({ id: "D-51", summary: "Newest" });
  });
});

describe("mergeRollingState (decisionUpdates flow)", () => {
  it("merges decisionUpdates into the rolling state decisions log", () => {
    const state = mergeRollingState({}, {
      issueId: "issue-1",
      handoffId: "handoff-1",
      status: "succeeded",
      summaryText: "Did the thing",
      createdAt: T0,
      decisionUpdates: [{ id: "D-1", summary: "Use option B" }],
    });

    expect(state.decisions).toEqual([
      expect.objectContaining({ id: "D-1", status: "under_review", handoffId: "handoff-1" }),
    ]);
    expect(state.completedIssues).toEqual([
      { issueId: "issue-1", summary: "Did the thing", handoffId: "handoff-1" },
    ]);
  });

  it("keeps existing rolling state untouched when no decisionUpdates are passed", () => {
    const previous = {
      missionGoal: "Ship V1",
      activeDecisions: ["legacy free-text decision"],
      decisions: [
        { id: "D-1", summary: "Existing", status: "confirmed" as const, supersedes: null, handoffId: "h0", updatedAt: T0.toISOString() },
      ],
    };
    const state = mergeRollingState(previous, {
      issueId: null,
      handoffId: "handoff-2",
      status: "failed",
      summaryText: "nope",
      createdAt: T1,
    });

    expect(state.decisions).toBe(previous.decisions);
    expect(state.activeDecisions).toEqual(["legacy free-text decision"]);
    expect(state.blockers).toEqual([`Run handoff handoff-2 ended with failed`]);
  });
});

describe("buildMissionStateMarkdown (decision log rendering)", () => {
  it("renders decision log with status labels and supersedes chains, keeping retired decisions visible", () => {
    const markdown = buildMissionStateMarkdown({
      missionId: "mission-1",
      state: {
        decisions: [
          { id: "D-1", summary: "Docker postgres", status: "retired", supersedes: null, handoffId: "h0", updatedAt: T0.toISOString() },
          { id: "D-2", summary: "PGlite everywhere", status: "confirmed", supersedes: "D-1", handoffId: "h1", updatedAt: T1.toISOString() },
          { id: "D-3", summary: "Try neon fork", status: "under_review", supersedes: null, handoffId: "h1", updatedAt: T1.toISOString() },
        ],
      },
    });

    expect(markdown).toContain("## Decision Log");
    expect(markdown).toContain("- [retired] D-1: Docker postgres");
    expect(markdown).toContain("- [confirmed] D-2: PGlite everywhere (supersedes D-1)");
    expect(markdown).toContain("- [under_review] D-3: Try neon fork");
  });

  it("shows none-captured when the state has no decisions", () => {
    const markdown = buildMissionStateMarkdown({ missionId: "mission-1", state: {} });
    expect(markdown).toContain("## Decision Log");
    expect(markdown).toContain("- None captured.");
  });
});

describe("buildMissionIssueHandoffMarkdown (structured decisions)", () => {
  it("renders structured decision updates with status labels in the decisions section", () => {
    const handoff = buildMissionIssueHandoffMarkdown({
      missionId: "mission-1",
      issueId: "issue-1",
      agentId: "agent-1",
      runId: "run-1",
      status: "succeeded",
      decisionUpdates: [
        { id: "D-2", summary: "PGlite everywhere", status: "confirmed", supersedes: "D-1" },
      ],
    });

    expect(handoff).toContain("## Decisions Made");
    expect(handoff).toContain("- [confirmed] D-2: PGlite everywhere (supersedes D-1)");
    expect(handoff).not.toContain("No explicit decisions captured.");
  });

  it("keeps rendering legacy string decisions when no structured updates are provided", () => {
    const handoff = buildMissionIssueHandoffMarkdown({
      missionId: "mission-1",
      issueId: "issue-1",
      agentId: "agent-1",
      runId: "run-1",
      status: "succeeded",
      decisions: ["chose the simple parser"],
    });

    expect(handoff).toContain("- chose the simple parser");
  });
});

describeEmbeddedPostgres("updateMissionRollingStateFromHandoff decision updates", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mission-decision-log-");
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

  it("persists decisionUpdates into the rolling state across two handoffs", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Decision Log Company",
      issuePrefix: `DL${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Decision Logger",
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
      title: "Decision log mission",
      status: "active",
    });
    await db.insert(heartbeatRuns).values({
      id: undefined,
      companyId,
      agentId,
      status: "succeeded",
      invocationSource: "test",
    });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)).limit(1);

    await updateMissionRollingStateFromHandoff(db, {
      companyId,
      missionId,
      runId: run.id,
      issueId: null,
      handoffId: "handoff-1",
      status: "succeeded",
      summaryText: "first run",
      decisionUpdates: [{ id: "D-1", summary: "Docker postgres" }],
    });
    const second = await updateMissionRollingStateFromHandoff(db, {
      companyId,
      missionId,
      runId: run.id,
      issueId: null,
      handoffId: "handoff-2",
      status: "succeeded",
      summaryText: "second run",
      decisionUpdates: [
        { id: "D-2", summary: "PGlite everywhere", status: "confirmed", supersedes: "D-1" },
      ],
    });

    expect(second.revision).toBe(2);
    expect(second.stateJson.decisions).toHaveLength(2);
    expect(second.stateJson.decisions?.find((d) => d.id === "D-1")).toMatchObject({ status: "retired" });
    expect(second.stateJson.decisions?.find((d) => d.id === "D-2")).toMatchObject({
      status: "confirmed",
      supersedes: "D-1",
      handoffId: "handoff-2",
    });
    expect(second.stateMarkdown).toContain("- [confirmed] D-2: PGlite everywhere (supersedes D-1)");
    expect(second.stateMarkdown).toContain("- [retired] D-1: Docker postgres");

    const pointer = await resolveMissionDecisionLogPointer(db, missionId);
    expect(pointer).toEqual({ missionId, revision: 2 });
  });

  it("resolves no decision log pointer for a mission without rolling state", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Pointer Company",
      issuePrefix: `PT${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Pointer Agent",
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
      title: "Pointer mission",
      status: "active",
    });

    expect(await resolveMissionDecisionLogPointer(db, missionId)).toBeNull();
  });
});
