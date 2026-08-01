import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { DEFAULT_MISSION_PLAN_TEMPLATE_KEYS } from "../services/missions/mission-plan-template-defaults.js";
import { missionPlanTemplateService } from "../services/missions/mission-plan-templates.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("mission plan template service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("mission-plan-templates-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 }); await tempDb?.cleanup();
  });

  async function seedCompany(name: string) {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name,
      issuePrefix: randomUUID().slice(0, 6).toUpperCase(),
      requireBoardApprovalForNewAgents: false,
    });
    return id;
  }

  it("seeds exactly four defaults idempotently", async () => {
    const companyId = await seedCompany("Template Company");
    const service = missionPlanTemplateService(db);

    await service.ensureDefaults(companyId);
    await service.ensureDefaults(companyId);

    const rows = await service.list(companyId, { includeDisabled: true });
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.key).sort()).toEqual([...DEFAULT_MISSION_PLAN_TEMPLATE_KEYS].sort());
    expect(rows.every((row) => row.origin === "system_default" && row.enabled)).toBe(true);
  });

  it("allows defaults to be disabled but not edited or deleted", async () => {
    const companyId = await seedCompany("Default Rules Company");
    const service = missionPlanTemplateService(db);
    await service.ensureDefaults(companyId);
    const [template] = await service.list(companyId, { includeDisabled: true });

    expect((await service.update(companyId, template!.id, { enabled: false })).enabled).toBe(false);
    await expect(service.update(companyId, template!.id, { name: "Changed" })).rejects.toThrow(/default/i);
    await expect(service.removeCustom(companyId, template!.id)).rejects.toThrow(/default/i);
    expect(await service.get(companyId, template!.id, { includeDisabled: false })).toBeNull();
  });

  it("creates, updates, duplicates, and deletes custom templates", async () => {
    const companyId = await seedCompany("Custom Template Company");
    const service = missionPlanTemplateService(db);
    const created = await service.createCustom(companyId, {
      name: "Customer interview",
      selectionDescription: "Use for customer discovery missions.",
      instructions: "Collect evidence, synthesize themes, and run QA.",
    });

    expect(created.origin).toBe("custom");
    expect((await service.update(companyId, created.id, { name: "Interview synthesis" })).name).toBe("Interview synthesis");
    const duplicate = await service.duplicate(companyId, created.id, { name: "Interview copy" });
    expect(duplicate).toMatchObject({ name: "Interview copy", origin: "custom" });
    expect(duplicate.key).not.toBe(created.key);

    await service.removeCustom(companyId, created.id);
    expect(await service.get(companyId, created.id, { includeDisabled: true })).toBeNull();
  });

  it("never resolves another company's template", async () => {
    const companyA = await seedCompany("Company A");
    const companyB = await seedCompany("Company B");
    const service = missionPlanTemplateService(db);
    const created = await service.createCustom(companyA, {
      name: "Private template",
      selectionDescription: "Company A only.",
      instructions: "Private guidance.",
    });

    expect(await service.get(companyB, created.id, { includeDisabled: true })).toBeNull();
    await expect(service.resolveEnabled(companyB, [created.id])).rejects.toThrow(/not available/i);
  });
});
