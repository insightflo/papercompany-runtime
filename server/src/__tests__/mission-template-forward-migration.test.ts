import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import { companies, missionPlanTemplates } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { createQualityTestDb, describeQualityDb } from "./helpers/quality-db.js";
import { DEFAULT_MISSION_PLAN_TEMPLATES } from "../services/missions/mission-plan-template-defaults.js";

const migrations = new URL("../../../packages/db/src/migrations/", import.meta.url);
describeQualityDb("forward generic publication template migration", () => {
  let fixture: Awaited<ReturnType<typeof createQualityTestDb>>;
  beforeAll(async () => { fixture = await createQualityTestDb(); }, 60_000);
  afterAll(async () => { await fixture?.close(); });

  it("disables only the historical system seed, preserves data and customizations, and replays idempotently", async () => {
    const [company, customCompany] = await fixture.db.insert(companies).values([
      { name: "Seed fixture", issuePrefix: randomUUID() }, { name: "Custom fixture", issuePrefix: randomUUID() },
    ]).returning();
    // Replay the immutable historical seed against fresh local fixture companies.
    await fixture.db.$client.unsafe(await readFile(new URL("0077_mission_plan_templates.sql", migrations), "utf8"));
    const before = await fixture.db.select().from(missionPlanTemplates).where(eq(missionPlanTemplates.companyId, company.id));
    const historical = before.find(row => !["research-report-qa", "durable-file-review", "structural-validation-semantic-review"].includes(row.key))!;
    await fixture.db.update(missionPlanTemplates).set({ origin: "custom" }).where(eq(missionPlanTemplates.companyId, customCompany.id));
    const [custom] = await fixture.db.insert(missionPlanTemplates).values({ companyId: customCompany.id,
      key: "publication-verify", name: "Custom publication", selectionDescription: "Operator guidance", instructions: "Preserve me", enabled: false,
    }).returning();
    const sql = await readFile(new URL("0122_generic_publication_template.sql", migrations), "utf8");
    await fixture.db.$client.unsafe(sql);
    const after = await fixture.db.select().from(missionPlanTemplates).where(eq(missionPlanTemplates.companyId, company.id));
    expect(after).toHaveLength(before.length + 1);
    expect(after.find(row => row.id === historical.id)).toMatchObject({ ...historical, enabled: false, updatedAt: expect.any(Date) });
    for (const row of before.filter(row => row.id !== historical.id)) expect(after.find(next => next.id === row.id)).toEqual(row);
    const generic = after.find(row => row.key === "publication-verify")!;
    expect(generic).toMatchObject({ ...DEFAULT_MISSION_PLAN_TEMPLATES.find(row => row.key === "publication-verify"),
      origin: "system_default", enabled: true });
    const customRows = await fixture.db.select().from(missionPlanTemplates).where(eq(missionPlanTemplates.companyId, customCompany.id));
    expect(customRows.find(row => row.key === historical.key)?.enabled).toBe(true);
    expect(customRows.find(row => row.id === custom.id)).toEqual(custom);
    await fixture.db.$client.unsafe(sql);
    expect(await fixture.db.select().from(missionPlanTemplates).where(eq(missionPlanTemplates.companyId, company.id))).toEqual(after);
  });
});
