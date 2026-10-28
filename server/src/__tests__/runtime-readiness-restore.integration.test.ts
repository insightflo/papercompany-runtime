// @vitest-environment node
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, issueWorkProducts, issues, missions, runDatabaseRestore, workflowRuns } from "@paperclipai/db";
import { missionService } from "../services/missions.js";
import { startRuntimeReadinessRestoreFixture } from "./helpers/runtime-readiness-restore-fixture.js";

describe("runtime readiness backup restore", () => {
  let fixture: Awaited<ReturnType<typeof startRuntimeReadinessRestoreFixture>>;
  beforeAll(async () => { fixture = await startRuntimeReadinessRestoreFixture(); }, 60_000);
  afterAll(async () => { await fixture?.cleanup(); });

  it("restores mission rows and exact external artifact bytes, then finishes through the canonical consumer", async () => {
    const seeded = await fixture.seedMission();
    const backup = await fixture.snapshot();
    const targetUrl = await fixture.createEmptyDatabase("complete");

    await fixture.restoreFilesToOriginalMount();
    await runDatabaseRestore({ connectionString: targetUrl, backupFile: backup.backupFile });
    const restored = createDb(targetUrl);
    try {
      const [mission] = await restored.select().from(missions).where(eq(missions.id, seeded.missionId));
      const [issue] = await restored.select().from(issues).where(eq(issues.id, seeded.issueId));
      const [run] = await restored.select().from(workflowRuns).where(eq(workflowRuns.missionId, seeded.missionId));
      const [product] = await restored.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, seeded.productId));
      expect(mission).toMatchObject({ companyId: seeded.companyId, status: "active" });
      expect(issue).toMatchObject({ missionId: seeded.missionId, status: "done" });
      expect(run).toMatchObject({ missionId: seeded.missionId, status: "completed" });
      expect(product).toMatchObject({ issueId: seeded.issueId, createdByRunId: seeded.heartbeatRunId,
        metadata: { path: seeded.artifactPath, sha256: seeded.sha256 } });

      const restoredBytes = await fixture.readArtifact(seeded.artifactPath);
      expect(restoredBytes).toEqual(seeded.bytes);
      expect(createHash("sha256").update(restoredBytes).digest("hex")).toBe(seeded.sha256);

      const result = await missionService(restored).runActiveMissionOwnerSupervision({
        companyId: seeded.companyId, missionIds: [seeded.missionId], applySafeActions: true,
      });
      expect(result.missionIds).toEqual([seeded.missionId]);
      expect((await restored.select().from(missions).where(eq(missions.id, seeded.missionId)))[0])
        .toMatchObject({ status: "completed", completedAt: expect.any(Date) });
      expect((await restored.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, seeded.productId)))[0])
        .toEqual(product);
    } finally {
      await restored.$client.end({ timeout: 5 });
    }
  }, 120_000);
});
