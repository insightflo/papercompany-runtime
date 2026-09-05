import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
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
import { applyMissionDecisionReports } from "../services/missions/mission-decision-reports.js";
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
        source: "handoff",
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

  it("carries defensively-filtered evidenceRefs onto a newly created decision", () => {
    const merged = mergeDecisionRecords(undefined, [
      {
        id: "D-1",
        summary: "Use PGlite for dev",
        evidenceRefs: [
          { type: "issue", id: "issue-70d8f2a1", note: "  spike results  " },
          { type: "pr", id: "pr-42", sha256: "ab".repeat(32) },
        ],
      },
    ], { handoffId: "handoff-1", now: T0 });

    expect(merged[0].evidenceRefs).toEqual([
      { type: "issue", id: "issue-70d8f2a1", note: "spike results" },
      { type: "pr", id: "pr-42", sha256: "ab".repeat(32) },
    ]);
  });

  it("overwrites evidenceRefs when an update carries them and preserves them when absent", () => {
    const previous: MissionRollingDecisionRecord[] = [
      {
        id: "D-1",
        summary: "Draft approach",
        status: "under_review",
        supersedes: null,
        handoffId: "h0",
        updatedAt: T0.toISOString(),
        evidenceRefs: [{ type: "run_log", id: "run-log-old" }],
      },
    ];

    const overwritten = mergeDecisionRecords(previous, [
      { id: "D-1", status: "confirmed", evidenceRefs: [{ type: "issue", id: "issue-new" }] },
    ], { handoffId: "h1", now: T1 });
    expect(overwritten[0].evidenceRefs).toEqual([{ type: "issue", id: "issue-new" }]);

    const preserved = mergeDecisionRecords(overwritten, [
      { id: "D-1", summary: "Clarified wording" },
    ], { handoffId: "h2", now: T1 });
    expect(preserved[0].evidenceRefs).toEqual([{ type: "issue", id: "issue-new" }]);
  });

  it("drops invalid evidence entries deterministically and caps evidenceRefs at 10", () => {
    const updates = [
      {
        id: "D-1",
        summary: "Filter evidence",
        evidenceRefs: [
          "not-an-object",
          null,
          { type: "warp_drive", id: "bad-type" },
          { type: "issue", id: "   " },
          { type: "issue", id: "x".repeat(201) },
          { type: "issue", id: "ok-note", note: "n".repeat(301) },
          { type: "issue", id: "ok-sha", sha256: "zz".repeat(32) },
          { type: "issue", id: "issue-keep", note: "  trimmed  " },
          ...Array.from({ length: 12 }, (_, i) => ({ type: "mission" as const, id: `m-${i + 1}` })),
        ],
      },
    ] as unknown as MissionIssueHandoffDecisionUpdate[];

    const merged = mergeDecisionRecords(undefined, updates, { handoffId: "h1", now: T0 });
    expect(merged[0].evidenceRefs).toEqual([
      { type: "issue", id: "issue-keep", note: "trimmed" },
      ...Array.from({ length: 9 }, (_, i) => ({ type: "mission", id: `m-${i + 1}` })),
    ]);
  });

  it("stamps the batch source onto newly created records", () => {
    const merged = mergeDecisionRecords(undefined, [
      { id: "D-1", summary: "Agent claim" },
    ], { handoffId: null, now: T0, source: "agent" });

    expect(merged[0]).toMatchObject({ id: "D-1", source: "agent", handoffId: null });
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

const boardRecord: MissionRollingDecisionRecord = {
  id: "D-B",
  summary: "Board decision",
  status: "confirmed",
  supersedes: null,
  handoffId: null,
  updatedAt: T0.toISOString(),
  source: "board",
};

describe("mergeDecisionRecords (board-source protection)", () => {
  it("agent batch cannot modify a board record and records the conflicting proposal instead", () => {
    const merged = mergeDecisionRecords([boardRecord], [
      {
        id: "D-B",
        summary: "Agent override",
        status: "retired",
        supersedes: null,
        evidenceRefs: [{ type: "issue", id: "issue-agent" }],
      },
    ], { handoffId: "handoff-1", now: T1, source: "agent" });

    // board 필드는 그대로고, 배치가 실은 필드만 단일 슬롯 제안으로 기록된다.
    expect(merged).toEqual([
      {
        id: "D-B",
        summary: "Board decision",
        status: "confirmed",
        supersedes: null,
        handoffId: null,
        updatedAt: T0.toISOString(),
        source: "board",
        lastConflictingProposal: {
          from: "agent",
          summary: "Agent override",
          status: "retired",
          supersedes: null,
          at: T1.toISOString(),
        },
      },
    ]);
  });

  it("keeps only the latest conflicting proposal in a single slot (latest wins)", () => {
    const merged = mergeDecisionRecords([boardRecord], [
      { id: "D-B", summary: "First agent attempt" },
      { id: "D-B", summary: "Second agent attempt", status: "under_review" },
    ], { handoffId: "handoff-1", now: T1, source: "agent" });

    expect(merged[0]).toMatchObject({ summary: "Board decision", status: "confirmed" });
    expect(merged[0].lastConflictingProposal).toEqual({
      from: "agent",
      summary: "Second agent attempt",
      status: "under_review",
      at: T1.toISOString(),
    });
  });

  it("handoff batch cannot modify a board record either and records a handoff proposal", () => {
    const merged = mergeDecisionRecords([boardRecord], [
      { id: "D-B", summary: "Handoff rewrite", status: "under_review" },
    ], { handoffId: "handoff-9", now: T1, source: "handoff" });

    expect(merged[0]).toMatchObject({
      summary: "Board decision",
      status: "confirmed",
      handoffId: null,
      updatedAt: T0.toISOString(),
      source: "board",
    });
    expect(merged[0].lastConflictingProposal).toEqual({
      from: "handoff",
      summary: "Handoff rewrite",
      status: "under_review",
      at: T1.toISOString(),
    });
  });

  it("a non-board batch cannot retire a board record via another update's supersedes", () => {
    const merged = mergeDecisionRecords([boardRecord], [
      { id: "D-2", summary: "New approach", status: "confirmed", supersedes: "D-B" },
    ], { handoffId: "handoff-1", now: T1, source: "agent" });

    expect(merged.find((d) => d.id === "D-B")).toMatchObject({ status: "confirmed" });
    expect(merged.find((d) => d.id === "D-B")?.lastConflictingProposal).toBeUndefined();
    expect(merged.find((d) => d.id === "D-2")).toMatchObject({
      status: "confirmed",
      supersedes: "D-B",
      source: "agent",
    });
  });

  it("board batch CAN update a board record and clears any pending proposal", () => {
    const challenged: MissionRollingDecisionRecord = {
      ...boardRecord,
      lastConflictingProposal: { from: "agent", summary: "Agent counter", at: T1.toISOString() },
    };
    const merged = mergeDecisionRecords([challenged], [
      { id: "D-B", summary: "Board revised", status: "under_review" },
    ], { handoffId: null, now: T1, source: "board" });

    expect(merged).toEqual([
      {
        id: "D-B",
        summary: "Board revised",
        status: "under_review",
        supersedes: null,
        handoffId: null,
        updatedAt: T1.toISOString(),
        source: "board",
      },
    ]);
  });

  it("board batch restamps a non-board record's source to board", () => {
    const agentRecord: MissionRollingDecisionRecord = {
      id: "D-A",
      summary: "Agent claim",
      status: "under_review",
      supersedes: null,
      handoffId: "handoff-0",
      updatedAt: T0.toISOString(),
      source: "agent",
    };
    const merged = mergeDecisionRecords([agentRecord], [
      { id: "D-A", summary: "Board confirmed", status: "confirmed" },
    ], { handoffId: null, now: T1, source: "board" });

    expect(merged[0]).toMatchObject({
      summary: "Board confirmed",
      status: "confirmed",
      source: "board",
      handoffId: null,
      updatedAt: T1.toISOString(),
    });
  });

  it("non-board records keep today's overwrite behavior for agent and handoff batches", () => {
    const agentRecord: MissionRollingDecisionRecord = {
      ...boardRecord,
      id: "D-A",
      summary: "Agent claim",
      status: "under_review",
      handoffId: "handoff-0",
      source: "agent",
    };
    const merged = mergeDecisionRecords([agentRecord], [
      { id: "D-A", status: "confirmed" },
    ], { handoffId: "handoff-1", now: T1, source: "handoff" });

    expect(merged[0]).toMatchObject({
      status: "confirmed",
      summary: "Agent claim",
      source: "handoff",
      handoffId: "handoff-1",
    });
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

  it("appends evidence refs with short ids and a +N more suffix when more than 3 remain", () => {
    const markdown = buildMissionStateMarkdown({
      missionId: "mission-1",
      state: {
        decisions: [
          {
            id: "D-2",
            summary: "PGlite everywhere",
            status: "confirmed",
            supersedes: "D-1",
            handoffId: "h1",
            updatedAt: T1.toISOString(),
            evidenceRefs: [
              { type: "heartbeat_run", id: "0cf4a1b2c3d4e5f6" },
              { type: "issue", id: "70d8f2a1-1234" },
            ],
          },
          {
            id: "D-3",
            summary: "Wide evidence",
            status: "under_review",
            supersedes: null,
            handoffId: "h1",
            updatedAt: T1.toISOString(),
            evidenceRefs: [
              { type: "heartbeat_run", id: "aaaaaaaa-1" },
              { type: "issue", id: "bbbbbbbb-2" },
              { type: "issue_comment", id: "cccccccc-3" },
              { type: "pr", id: "dddddddd-4" },
              { type: "mission", id: "eeeeeeee-5" },
            ],
          },
        ],
      },
    });

    expect(markdown).toContain(
      "- [confirmed] D-2: PGlite everywhere (supersedes D-1) (evidence: heartbeat_run 0cf4a1b2, issue 70d8f2a1)",
    );
    expect(markdown).toContain(
      "- [under_review] D-3: Wide evidence (evidence: heartbeat_run aaaaaaaa, issue bbbbbbbb, issue_comment cccccccc +2 more)",
    );
  });

  it("marks board-authored records and pending proposals in decision log lines", () => {
    const markdown = buildMissionStateMarkdown({
      missionId: "mission-1",
      state: {
        decisions: [
          {
            id: "D-1",
            summary: "Board choice",
            status: "confirmed",
            supersedes: null,
            handoffId: null,
            updatedAt: T0.toISOString(),
            source: "board",
            lastConflictingProposal: { from: "agent", summary: "Agent counter", at: T1.toISOString() },
          },
          { id: "D-2", summary: "Agent claim", status: "under_review", supersedes: null, handoffId: null, updatedAt: T1.toISOString(), source: "agent" },
          { id: "D-3", summary: "Legacy record", status: "confirmed", supersedes: null, handoffId: "h0", updatedAt: T0.toISOString() },
        ],
      },
    });

    expect(markdown).toContain("- [confirmed] D-1: Board choice · board · proposal pending");
    // board 출처가 아닌 기록에는 마커가 붙지 않는다(행 끝까지 확인).
    expect(markdown).toContain("- [under_review] D-2: Agent claim\n");
    expect(markdown).toContain("- [confirmed] D-3: Legacy record\n");
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

describeEmbeddedPostgres("evidence staleness sweep wiring (rolling-state merge paths)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mission-decision-log-evidence-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(missionRollingState);
    await db.delete(heartbeatRuns);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedMission(prefix: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `${prefix} Evidence Company`,
      issuePrefix: `${prefix}${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `${prefix} Evidence Agent`,
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
      title: `${prefix} evidence mission`,
      status: "active",
    });
    return { companyId, agentId, missionId };
  }

  async function seedRun(companyId: string, agentId: string) {
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded", invocationSource: "test" });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)).limit(1);
    return run;
  }

  function confirmedDecision(id: string, refId: string, recordedSha256: string): MissionRollingDecisionRecord {
    return {
      id,
      summary: "Spike says PGlite",
      status: "confirmed",
      supersedes: null,
      handoffId: "handoff-0",
      updatedAt: T0.toISOString(),
      evidenceRefs: [{ type: "work_product", id: refId, sha256: recordedSha256 }],
    };
  }

  it("demotes a confirmed decision with changed work_product evidence through updateMissionRollingStateFromHandoff and writes the evidence_stale activity row", async () => {
    const { companyId, agentId, missionId } = await seedMission("EV1");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "evidence-wiring-"));
    try {
      const wpPath = path.join(root, "wp.txt");
      await fs.writeFile(wpPath, "original contents");
      const recordedSha256 = createHash("sha256").update("original contents").digest("hex");
      await db.insert(missionRollingState).values({
        companyId,
        missionId,
        stateJson: { decisions: [confirmedDecision("D-1", wpPath, recordedSha256)] },
        stateMarkdown: "seed",
      });
      await fs.writeFile(wpPath, "rewritten contents");
      const run = await seedRun(companyId, agentId);

      const row = await updateMissionRollingStateFromHandoff(db, {
        companyId,
        missionId,
        runId: run.id,
        issueId: null,
        handoffId: "handoff-1",
        status: "succeeded",
        summaryText: "run summary",
        evidenceVerifyRoots: [root],
      });

      const demoted = row.stateJson.decisions?.find((d) => d.id === "D-1");
      expect(demoted).toMatchObject({ status: "under_review" });
      expect(demoted?.demotedByEvidence?.previousStatus).toBe("confirmed");
      expect(demoted?.demotedByEvidence?.mismatches).toEqual([
        { id: wpPath, type: "work_product", recordedSha256, current: "changed" },
      ]);
      expect(row.stateMarkdown).toContain("- [under_review] D-1: Spike says PGlite (evidence: work_product");
      expect(row.stateMarkdown).toContain("· evidence stale");

      const activities = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
      expect(activities).toHaveLength(1);
      expect(activities[0]).toMatchObject({
        actorType: "system",
        action: "mission.decisions.evidence_stale",
        entityType: "mission",
        entityId: missionId,
      });
      expect(activities[0].details).toMatchObject({
        demoted: [{ id: "D-1", mismatches: 1 }],
        verifiedCount: 0,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not demote or log when evidenceVerifyRoots is absent (fail-open no-op)", async () => {
    const { companyId, agentId, missionId } = await seedMission("EV2");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "evidence-wiring-"));
    try {
      const wpPath = path.join(root, "wp.txt");
      await fs.writeFile(wpPath, "original contents");
      const recordedSha256 = createHash("sha256").update("original contents").digest("hex");
      await db.insert(missionRollingState).values({
        companyId,
        missionId,
        stateJson: { decisions: [confirmedDecision("D-1", wpPath, recordedSha256)] },
        stateMarkdown: "seed",
      });
      await fs.writeFile(wpPath, "rewritten contents");
      const run = await seedRun(companyId, agentId);

      const row = await updateMissionRollingStateFromHandoff(db, {
        companyId,
        missionId,
        runId: run.id,
        issueId: null,
        handoffId: "handoff-1",
        status: "succeeded",
        summaryText: "run summary",
      });

      expect(row.stateJson.decisions?.find((d) => d.id === "D-1")).toMatchObject({ status: "confirmed" });
      expect(row.stateMarkdown).not.toContain("evidence stale");
      const activities = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
      expect(activities).toHaveLength(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("sweeps through applyMissionDecisionReports when roots are supplied, demoting a board-sourced record without touching provenance", async () => {
    const { companyId, agentId, missionId } = await seedMission("EV3");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "evidence-wiring-"));
    try {
      const wpPath = path.join(root, "wp.txt");
      await fs.writeFile(wpPath, "original contents");
      const recordedSha256 = createHash("sha256").update("original contents").digest("hex");
      await db.insert(missionRollingState).values({
        companyId,
        missionId,
        stateJson: {
          decisions: [
            {
              ...confirmedDecision("D-B", wpPath, recordedSha256),
              source: "board" as const,
              lastConflictingProposal: { from: "agent" as const, summary: "agent disagrees", at: T1.toISOString() },
            },
          ],
        },
        stateMarkdown: "seed",
      });
      await fs.writeFile(wpPath, "rewritten contents");

      const result = await applyMissionDecisionReports(db, {
        companyId,
        missionId,
        updates: [{ id: "D-NEW", summary: "Fresh board decision", status: "confirmed" }],
        source: "board",
        evidenceVerifyRoots: [root],
      });

      const demoted = result.decisions.find((d) => d.id === "D-B");
      expect(demoted).toMatchObject({ status: "under_review", source: "board" });
      expect(demoted?.demotedByEvidence?.mismatches).toEqual([
        { id: wpPath, type: "work_product", recordedSha256, current: "changed" },
      ]);
      expect(demoted?.lastConflictingProposal).toEqual({ from: "agent", summary: "agent disagrees", at: T1.toISOString() });
      expect(result.stateMarkdown).toContain("- [under_review] D-B: Spike says PGlite (evidence: work_product");
      expect(result.stateMarkdown).toContain("· board · proposal pending · evidence stale");

      const activities = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
      expect(activities).toHaveLength(1);
      expect(activities[0]).toMatchObject({ action: "mission.decisions.evidence_stale", actorType: "system" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
