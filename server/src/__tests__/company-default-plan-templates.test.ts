import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, missionPlanTemplates } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { companyService } from "../services/companies.js";
import { DEFAULT_MISSION_PLAN_TEMPLATE_KEYS } from "../services/missions/mission-plan-template-defaults.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("company default mission plan templates", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("company-default-plan-templates-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 }); await tempDb?.cleanup();
  });

  it("creates every new company with exactly four enabled defaults", async () => {
    const company = await companyService(db).create({ name: "New Template Company" });
    const rows = await db.select().from(missionPlanTemplates)
      .where(eq(missionPlanTemplates.companyId, company.id));

    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.key).sort()).toEqual([...DEFAULT_MISSION_PLAN_TEMPLATE_KEYS].sort());
    expect(rows.every((row) => row.enabled && row.origin === "system_default")).toBe(true);
  });
});
