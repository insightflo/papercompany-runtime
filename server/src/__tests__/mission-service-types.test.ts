import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issues, missions } from "@paperclipai/db";
import { pluginManifestV1Schema } from "@paperclipai/shared";
import { missionService } from "../services/missions.js";
import { missionPluginManifest } from "./helpers/mission-service-fixtures.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("mission plugin manifest fixtures", () => {
  it.each([
    ["test-plugin-123", "Test Plugin", "0.0.1"],
    ["stale-plugin-123", "Stale Plugin", "0.0.1"],
    ["insightflo.workflow-engine", "Workflow Engine", "1.0.0"],
  ])("provides a valid persisted manifest for %s", (id, displayName, version) => {
    const manifest = pluginManifestV1Schema.parse(missionPluginManifest(id, displayName, version));
    expect(manifest).toMatchObject({ id, displayName, version, apiVersion: 1 });
  });
});

// Keep the original creation regression and its actual query together: a foreign
// oversight row must not satisfy (or inflate) this company's two-mission proof.
describe("mission service company-scoped fixture queries", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mission-service-types-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end();
    await tempDb?.cleanup();
  });

  it("creates a separate active mission for every workflow trigger (no same-title active-mission reuse)", async () => {
    // [GAZ 2026-08-28 bce2fa1f] Legacy April-era dedupe used to glue a second
    // same-day trigger onto the day's still-ACTIVE mission (title = runDate +
    // workflow name, inputs invisible), interleaving multiple runs' issues in
    // one mission. Duplicate SCHEDULED runs are prevented upstream (slot claim
    // + active-run/mission guards), so mission create must not reuse — every
    // trigger gets its own mission.
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Workflow Mission Dedup Company",
      issuePrefix: `WD${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Main Executor",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const input = {
      companyId,
      ownerAgentId,
      title: "2026-04-30 gazua-watchlist-refresh",
      description: "Created automatically for workflow run: gazua-watchlist-refresh",
      status: "active" as const,
      source: "workflow" as const,
    };

    const first = await missionService(db).create(input);
    const second = await missionService(db).create(input);
    const missionRows = await db
      .select({ id: missions.id })
      .from(missions)
      .where(eq(missions.companyId, companyId));

    expect(second.id).not.toBe(first.id);
    expect(missionRows).toHaveLength(2);

    const foreignCompanyId = randomUUID();
    const foreignOwnerAgentId = randomUUID();
    await db.insert(companies).values({
      id: foreignCompanyId,
      name: "Foreign Workflow Company",
      issuePrefix: `FOREIGN${foreignCompanyId.replace(/-/g, "")}`,
    });
    await db.insert(agents).values({
      id: foreignOwnerAgentId, companyId: foreignCompanyId,
      name: "Foreign Main Executor", role: "operator", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    const foreign = await missionService(db).create({
      ...input, companyId: foreignCompanyId, ownerAgentId: foreignOwnerAgentId,
    });
    await db.insert(issues).values({
      companyId, missionId: first.id, title: "Non-oversight sentinel",
      originKind: "mission_action", status: "todo",
    });

    // Each mission keeps exactly one main-executor oversight issue of its own.
    const oversightRows = await db
      .select({ missionId: issues.missionId })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "mission_main_executor_oversight")));
    expect(oversightRows).toHaveLength(2);
    expect(new Set(oversightRows.map((row) => row.missionId)).size).toBe(2);
    expect(oversightRows.map((row) => row.missionId).sort()).toEqual([first.id, second.id].sort());
    expect(oversightRows.map((row) => row.missionId)).not.toContain(foreign.id);
  });
});
