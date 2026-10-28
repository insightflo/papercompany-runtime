// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issues } from "@paperclipai/db";
import { seedSupervisionLifecycle } from "./helpers/mission-supervision-lifecycle.js";
import { seedTerminalTransaction, terminalState } from "./helpers/mission-terminal-transaction.js";
import { startRuntimeReadinessMissionFixture } from "./helpers/runtime-readiness-mission-fixture.js";

describe("runtime readiness mission completion flow", () => {
  let fixture: Awaited<ReturnType<typeof startRuntimeReadinessMissionFixture>>;

  beforeAll(async () => { fixture = await startRuntimeReadinessMissionFixture(); }, 60_000);
  afterAll(async () => { await fixture?.cleanup(); });

  it("finishes a completed workflow through canonical mission and runtime cleanup exactly once", async () => {
    const seeded = await seedTerminalTransaction(fixture.db, true, true);

    const result = await fixture.sweep(seeded.companyId, [seeded.missionId]);
    expect(result.missionIds).toEqual([seeded.missionId]);
    expect(result.missions[0]?.appliedActions).toEqual([
      { type: "mission_settled_from_workflow_runs", missionId: seeded.missionId, resultStatus: "completed" },
    ]);

    const completed = await terminalState(fixture.db, seeded);
    expect(completed.missions[0]).toMatchObject({ status: "completed", completedAt: seeded.completedAt });
    expect(completed.issues.map((row) => row.status)).toEqual(["done", "done", "done"]);
    expect(completed.runs[0]).toMatchObject({ status: "cancelled", finishedAt: expect.any(Date) });
    expect(completed.runtimes[0]).toMatchObject({ status: "stopped", queueDepth: 0 });

    const writesBeforeReplay = await fixture.db.$client.unsafe("select * from terminal_test_writes order by sequence");
    const replay = await fixture.sweep(seeded.companyId, [seeded.missionId]);
    expect(replay).toMatchObject({ missionIds: [], missions: [] });
    expect(await terminalState(fixture.db, seeded)).toEqual(completed);
    expect(await fixture.db.$client.unsafe("select * from terminal_test_writes order by sequence"))
      .toEqual(writesBeforeReplay);
  });

  it("keeps an open producer from false completion, then closes the same mission after durable completion", async () => {
    const seeded = await seedSupervisionLifecycle(fixture.db);
    const producer = await seeded.addIssue("workflow_execution");
    const originalRuns = await fixture.missionRuns(seeded.missionId);
    const originalIssues = await fixture.missionIssues(seeded.missionId);

    await fixture.sweep(seeded.companyId, [seeded.missionId]);
    expect(await fixture.mission(seeded.missionId)).toMatchObject({ status: "active", completedAt: null });
    expect(await fixture.missionIssues(seeded.missionId)).toEqual(originalIssues);

    await fixture.sweep(seeded.companyId, [seeded.missionId]);
    expect(await fixture.missionIssues(seeded.missionId)).toEqual(originalIssues);
    expect(await fixture.missionRuns(seeded.missionId)).toEqual(originalRuns);

    await fixture.db.update(issues).set({ status: "done", completedAt: seeded.completedAt })
      .where(eq(issues.id, producer.id));
    const settled = await fixture.sweep(seeded.companyId, [seeded.missionId]);
    expect(settled.missionIds).toEqual([seeded.missionId]);
    expect(await fixture.mission(seeded.missionId)).toMatchObject({ status: "completed" });
    expect((await fixture.missionIssues(seeded.missionId)).every((row) => row.status === "done")).toBe(true);
    expect(await fixture.missionRuns(seeded.missionId)).toEqual(originalRuns);
  });
});
