// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSupervisionLifecycle } from "./helpers/mission-supervision-lifecycle.js";
import { startRuntimeReadinessMissionFixture } from "./helpers/runtime-readiness-mission-fixture.js";

describe("runtime readiness mission boundaries", () => {
  let fixture: Awaited<ReturnType<typeof startRuntimeReadinessMissionFixture>>;

  beforeAll(async () => { fixture = await startRuntimeReadinessMissionFixture(); }, 60_000);
  afterAll(async () => { await fixture?.cleanup(); });

  it("does not turn a recoverable failed run into completion or create duplicate retries", async () => {
    const seeded = await seedSupervisionLifecycle(fixture.db, "active", "failed");
    const originalRuns = await fixture.missionRuns(seeded.missionId);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await fixture.sweep(seeded.companyId, [seeded.missionId]);
      expect(await fixture.mission(seeded.missionId)).toMatchObject({ status: "active", completedAt: null });
      expect(await fixture.missionRuns(seeded.missionId)).toEqual(originalRuns);
    }

    const oversight = (await fixture.missionIssues(seeded.missionId)).filter(
      (row) => row.originKind === "mission_main_executor_oversight",
    );
    expect(oversight).toHaveLength(1);
  });

  it("settles a cancelled workflow as cancelled without starting replacement work", async () => {
    const seeded = await seedSupervisionLifecycle(fixture.db, "active", "cancelled");
    const originalRuns = await fixture.missionRuns(seeded.missionId);

    const settled = await fixture.sweep(seeded.companyId, [seeded.missionId]);
    expect(settled.missionIds).toEqual([seeded.missionId]);
    expect(await fixture.mission(seeded.missionId)).toMatchObject({ status: "cancelled" });
    expect(await fixture.missionRuns(seeded.missionId)).toEqual(originalRuns);

    const replay = await fixture.sweep(seeded.companyId, [seeded.missionId]);
    expect(replay).toMatchObject({ missionIds: [], missions: [] });
    expect(await fixture.missionRuns(seeded.missionId)).toEqual(originalRuns);
  });

  it("keeps company and explicit mission filters from touching a foreign mission", async () => {
    const target = await seedSupervisionLifecycle(fixture.db);
    const foreign = await seedSupervisionLifecycle(fixture.db);
    const foreignBefore = await fixture.mission(foreign.missionId);

    const result = await fixture.sweep(target.companyId, [target.missionId, foreign.missionId]);
    expect(result.missionIds).toEqual([target.missionId]);
    expect(await fixture.mission(target.missionId)).toMatchObject({ status: "completed" });
    expect(await fixture.mission(foreign.missionId)).toEqual(foreignBefore);
    expect(await fixture.missionIssues(foreign.missionId)).toEqual([]);
  });
});
