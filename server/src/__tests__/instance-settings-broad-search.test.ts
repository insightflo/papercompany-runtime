import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, instanceSettings, type Db } from "@paperclipai/db";
import { instanceSettingsService } from "../services/instance-settings.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const missionId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const emptyAllowlists = {
  broadSearchAllowedCompanyIdsV1: [],
  broadSearchAllowedMissionIdsV1: [],
  broadSearchAllowedAgentIdsV1: [],
};
const allowedScopes = {
  broadSearchAllowedCompanyIdsV1: [companyId],
  broadSearchAllowedMissionIdsV1: [missionId],
  broadSearchAllowedAgentIdsV1: [agentId],
};

describe("instance settings broad search allowlists — real database", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("instance-broad-search-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    if (db) await db.$client.end({ timeout: 5 });
    if (tempDb) await tempDb.cleanup();
  }, 30_000);

  beforeEach(async () => {
    await db.delete(instanceSettings);
  });

  it("creates missing settings with deny defaults", async () => {
    expect(await instanceSettingsService(db).getExperimental()).toMatchObject(emptyAllowlists);
    expect((await instanceSettingsService(db).get()).experimental).toMatchObject(emptyAllowlists);
  });

  it("normalizes legacy stored settings without resetting existing flags", async () => {
    await db.insert(instanceSettings).values({ experimental: { enableKnowledgePatternInjection: true } });
    expect(await instanceSettingsService(db).getExperimental()).toMatchObject({
      ...emptyAllowlists,
      enableKnowledgePatternInjection: true,
    });
  });

  it("returns stored lists and preserves other experimental flags", async () => {
    await db.insert(instanceSettings).values({ experimental: {
      ...allowedScopes,
      enableKnowledgePatternInjection: true,
      enableQaRebindRecoveryCompanyIdsV1: [companyId],
    } });
    expect(await instanceSettingsService(db).getExperimental()).toMatchObject({
      ...allowedScopes,
      enableKnowledgePatternInjection: true,
      enableQaRebindRecoveryCompanyIdsV1: [companyId],
    });
  });

  it("persists lists and keeps omitted scopes while clearing a selected scope", async () => {
    const service = instanceSettingsService(db);
    const updated = await service.updateExperimental(allowedScopes);
    expect(updated.experimental).toMatchObject(allowedScopes);
    await service.updateExperimental({ enableHeartbeatFinalizationV1: true });
    await service.updateExperimental({ broadSearchAllowedMissionIdsV1: [] });
    const expected = { ...allowedScopes, broadSearchAllowedMissionIdsV1: [], enableHeartbeatFinalizationV1: true };
    expect(await service.getExperimental()).toMatchObject(expected);
    const [stored] = await db.select().from(instanceSettings);
    expect(stored?.experimental).toMatchObject(expected);
  });

  it.each([
    { ...allowedScopes, broadSearchAllowedCompanyIdsV1: ["invalid"] },
    { ...allowedScopes, broadSearchAllowedMissionIdsV1: null },
    { ...allowedScopes, broadSearchAllowedAgentIdsV1: [123] },
    { ...allowedScopes, enableHeartbeatFinalizationV1: "invalid" },
  ])("falls back to empty lists for malformed persisted settings %j", async (experimental) => {
    await db.insert(instanceSettings).values({ experimental });
    expect(await instanceSettingsService(db).getExperimental()).toMatchObject(emptyAllowlists);
  });
});
