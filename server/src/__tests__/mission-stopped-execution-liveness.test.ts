import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, agents, companies, createDb, heartbeatRuns, issues, missions } from "@paperclipai/db";
import { eq } from "drizzle-orm";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { missionService } from "../services/missions.js";

// [목적] Phase D stopped-execution 판정 red-green. in_progress source 가 failed run 만 있고
//   live heartbeat run 도 live wakeup(queued/claimed/deferred_issue_execution/coalesced) 도 없으면
//   stopped 로 판정하고, live wakeup 이 하나라도 있으면 stopped recovery 를 만들지 않는다.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stopped-execution liveness tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("stopped-execution liveness excludes live run/wake states", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stopped-liveness-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await db.$client.end({ timeout: 5 }); await tempDb?.cleanup();
  });

  // active mission + in_progress workflow source + failed(terminal) heartbeat run 을 세팅하고
  // issue/run 의 createdAt 을 stale 기준보다 오래전으로 밀어낸다. 반환된 issue 에 대해
  // live wakeup 을 선택적으로 seed 한다.
  async function seedStaleInProgressMission(withFailedRun = true) {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Stopped Liveness Co",
      issuePrefix: `SL${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Stopped liveness mission", status: "active" });

    const [source] = await db
      .insert(issues)
      .values({
        companyId,
        missionId,
        assigneeAgentId: workerAgentId,
        originKind: "workflow_execution",
        status: "in_progress",
        title: "In-progress source that stalled",
      })
      .returning({ id: issues.id });
    // oversight issue 가 없으면 supervision 이 early-return 하므로 직접 seed.
    await db.insert(issues).values({
      companyId,
      missionId,
      assigneeAgentId: ownerAgentId,
      originKind: "mission_main_executor_oversight",
      status: "todo",
      title: "[OVERSIGHT] Stopped liveness mission",
    });
    if (withFailedRun) {
      await db.insert(heartbeatRuns).values({
        companyId,
        agentId: workerAgentId,
        issueId: source.id,
        status: "failed",
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        finishedAt: new Date("2026-06-01T00:00:05.000Z"),
      });
    }
    // issue createdAt 밀어내기(ageMs >= staleAfterMinutes).
    await db.update(issues)
      .set({ createdAt: new Date("2026-06-01T00:00:00.000Z"), updatedAt: new Date("2026-06-01T00:00:00.000Z") })
      .where(eq(issues.id, source.id));
    return { companyId, missionId, workerAgentId, sourceId: source.id };
  }

  async function runSupervision(companyId: string) {
    return missionService(db).runActiveMissionOwnerSupervision({
      companyId,
      staleAfterMinutes: 1,
      now: new Date("2026-06-02T00:10:00.000Z"),
    });
  }

  it("declares stopped when an in-progress source has only a terminal run and no live run/wake", async () => {
    const { companyId, sourceId } = await seedStaleInProgressMission();
    const result = await runSupervision(companyId);
    const findings = result.missions[0]?.findings ?? [];
    expect(findings).toEqual(expect.arrayContaining([
      expect.stringContaining("stale_in_progress_after_failed_run"),
    ]));
    expect(findings.some((f) => f.includes(sourceId) || f.includes("in_progress has terminal heartbeat"))).toBe(true);
  });

  it("declares stopped and creates an Oversight handoff when an in-progress source has no run or live wake", async () => {
    const { companyId, missionId, sourceId } = await seedStaleInProgressMission(false);
    const result = await runSupervision(companyId);
    const findings = result.missions[0]?.findings ?? [];
    expect(findings).toEqual(expect.arrayContaining([
      expect.stringContaining("stale_in_progress_no_execution"),
    ]));
    const ownerActions = await db
      .select({ originId: issues.originId, originKind: issues.originKind })
      .from(issues)
      .where(eq(issues.missionId, missionId));
    expect(ownerActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ originKind: "mission_main_executor_unblock", originId: sourceId }),
    ]));
  });

  // live 인 소스에 stopped recovery/applied action/duplicate owner action 이 만들어지지 않아야 한다.
  //   단순 finding 부재뿐 아니라 recommendations/appliedActions 도 source 를 참조하면 안 된다.
  function assertNoStoppedRecoveryForSource(result: Awaited<ReturnType<typeof runSupervision>>, sourceId: string) {
    const missionResult = result.missions[0];
    const findings = missionResult?.findings ?? [];
    expect(findings.some((f) => f.includes("stale_in_progress_after_failed_run"))).toBe(false);
    const recommendations = missionResult?.recommendations ?? [];
    expect(recommendations.some((r) => r.issueId === sourceId)).toBe(false);
    const appliedActions = missionResult?.appliedActions ?? [];
    expect(appliedActions.some((a) => typeof a === "object" && a !== null && "sourceIssueId" in a && a.sourceIssueId === sourceId)).toBe(false);
  }

  it.each([
    ["queued"],
    ["claimed"],
    ["deferred_issue_execution"],
    ["coalesced"],
  ])("does NOT declare stopped or produce recovery when a live wakeup in status %s covers the in-progress source", async (status) => {
    const { companyId, workerAgentId, sourceId } = await seedStaleInProgressMission();
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: workerAgentId,
      source: "automation",
      status,
      issueId: sourceId,
      requestedAt: new Date("2026-06-01T00:00:00.000Z"),
    });
    const result = await runSupervision(companyId);
    assertNoStoppedRecoveryForSource(result, sourceId);
  });

  it.each([
    ["queued"],
    ["running"],
  ])("does NOT declare stopped or produce recovery when the in-progress source has a %s heartbeat run", async (status) => {
    const { companyId, workerAgentId, sourceId } = await seedStaleInProgressMission();
    // live heartbeat run 추가 — issueLive 가 heartbeat run 만으로도 true(queued/running 모두).
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: workerAgentId,
      issueId: sourceId,
      status,
      createdAt: new Date("2026-06-02T00:09:00.000Z"),
    });
    const result = await runSupervision(companyId);
    assertNoStoppedRecoveryForSource(result, sourceId);
  });
});
