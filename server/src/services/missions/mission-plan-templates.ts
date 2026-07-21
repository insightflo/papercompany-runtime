import { randomUUID } from "node:crypto";
import { and, asc, count, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { missionPlanTemplates } from "@paperclipai/db";
import type { CreateMissionPlanTemplate, DuplicateMissionPlanTemplate, UpdateMissionPlanTemplate } from "@paperclipai/shared";
import { notFound, unprocessable } from "../../errors.js";
import { DEFAULT_MISSION_PLAN_TEMPLATES } from "./mission-plan-template-defaults.js";

const MAX_TEMPLATES_PER_COMPANY = 50;

export function missionPlanTemplateService(db: Db) {
  async function ensureDefaults(companyId: string, database: Pick<Db, "insert"> = db) {
    for (const template of DEFAULT_MISSION_PLAN_TEMPLATES) {
      await database.insert(missionPlanTemplates).values({
        companyId,
        ...template,
        origin: "system_default",
        enabled: true,
      }).onConflictDoUpdate({
        target: [missionPlanTemplates.companyId, missionPlanTemplates.key],
        set: {
          name: template.name,
          selectionDescription: template.selectionDescription,
          instructions: template.instructions,
          origin: "system_default",
        },
      });
    }
  }

  async function list(companyId: string, options: { includeDisabled: boolean }) {
    return db.select().from(missionPlanTemplates).where(
      options.includeDisabled
        ? eq(missionPlanTemplates.companyId, companyId)
        : and(eq(missionPlanTemplates.companyId, companyId), eq(missionPlanTemplates.enabled, true)),
    ).orderBy(asc(missionPlanTemplates.origin), asc(missionPlanTemplates.name));
  }

  async function get(companyId: string, templateId: string, options: { includeDisabled: boolean }) {
    return db.select().from(missionPlanTemplates).where(and(
      eq(missionPlanTemplates.companyId, companyId),
      eq(missionPlanTemplates.id, templateId),
      ...(options.includeDisabled ? [] : [eq(missionPlanTemplates.enabled, true)]),
    )).then((rows) => rows[0] ?? null);
  }

  async function assertCapacity(companyId: string) {
    const total = await db.select({ value: count() }).from(missionPlanTemplates)
      .where(eq(missionPlanTemplates.companyId, companyId))
      .then((rows) => Number(rows[0]?.value ?? 0));
    if (total >= MAX_TEMPLATES_PER_COMPANY) {
      throw unprocessable(`A company may have at most ${MAX_TEMPLATES_PER_COMPANY} mission plan templates`);
    }
  }

  async function createCustom(companyId: string, input: CreateMissionPlanTemplate) {
    await assertCapacity(companyId);
    return db.insert(missionPlanTemplates).values({
      companyId,
      key: `custom-${randomUUID()}`,
      name: input.name,
      selectionDescription: input.selectionDescription,
      instructions: input.instructions,
      origin: "custom",
      enabled: true,
    }).returning().then((rows) => rows[0]!);
  }

  async function update(companyId: string, templateId: string, input: UpdateMissionPlanTemplate) {
    const existing = await get(companyId, templateId, { includeDisabled: true });
    if (!existing) throw notFound("Mission plan template not found");
    if (existing.origin === "system_default" && Object.keys(input).some((key) => key !== "enabled")) {
      throw unprocessable("System default mission plan templates only allow enabled state changes");
    }
    return db.update(missionPlanTemplates).set({ ...input, updatedAt: new Date() }).where(and(
      eq(missionPlanTemplates.companyId, companyId),
      eq(missionPlanTemplates.id, templateId),
    )).returning().then((rows) => rows[0]!);
  }

  async function removeCustom(companyId: string, templateId: string) {
    const existing = await get(companyId, templateId, { includeDisabled: true });
    if (!existing) throw notFound("Mission plan template not found");
    if (existing.origin === "system_default") {
      throw unprocessable("System default mission plan templates cannot be deleted");
    }
    await db.delete(missionPlanTemplates).where(and(
      eq(missionPlanTemplates.companyId, companyId),
      eq(missionPlanTemplates.id, templateId),
    ));
  }

  async function duplicate(companyId: string, templateId: string, input: DuplicateMissionPlanTemplate = {}) {
    const existing = await get(companyId, templateId, { includeDisabled: true });
    if (!existing) throw notFound("Mission plan template not found");
    return createCustom(companyId, {
      name: input.name ?? `${existing.name} copy`,
      selectionDescription: existing.selectionDescription,
      instructions: existing.instructions,
    });
  }

  async function resolveEnabled(companyId: string, templateIds: string[]) {
    if (templateIds.length === 0) return [];
    const uniqueIds = [...new Set(templateIds)];
    const rows = await db.select().from(missionPlanTemplates).where(and(
      eq(missionPlanTemplates.companyId, companyId),
      eq(missionPlanTemplates.enabled, true),
      inArray(missionPlanTemplates.id, uniqueIds),
    ));
    if (rows.length !== uniqueIds.length) {
      throw unprocessable("One or more selected mission plan templates are not available in this company");
    }
    const byId = new Map(rows.map((row) => [row.id, row]));
    return uniqueIds.map((id) => byId.get(id)!);
  }

  return { ensureDefaults, list, get, createCustom, update, removeCustom, duplicate, resolveEnabled };
}
