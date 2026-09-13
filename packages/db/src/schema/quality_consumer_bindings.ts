import { sql } from "drizzle-orm";
import { check, foreignKey, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { missionPlanTemplates } from "./mission_plan_templates.js";
import { evaluatorVersions } from "./evaluator_versions.js";
import { qualityEvidenceRefs } from "./quality_evidence_refs.js";

export const qualityConsumerBindings = pgTable("quality_consumer_bindings", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  templateId: uuid("template_id").notNull(),
  baseHash: text("base_hash").notNull(),
  activeVersionId: uuid("active_version_id"),
  previousVerifiedVersionId: uuid("previous_verified_version_id"),
  revision: integer("revision").notNull().default(1),
  adoptionEvidenceRefId: uuid("adoption_evidence_ref_id"),
  withdrawalEvidenceRefId: uuid("withdrawal_evidence_ref_id"),
}, (table) => ({
  targetUq: uniqueIndex("quality_consumer_bindings_target_uq").on(table.companyId, table.templateId, table.baseHash),
  templateFk: foreignKey({ columns: [table.companyId, table.templateId], foreignColumns: [missionPlanTemplates.companyId, missionPlanTemplates.id] }),
  activeFk: foreignKey({ columns: [table.companyId, table.activeVersionId], foreignColumns: [evaluatorVersions.companyId, evaluatorVersions.id] }),
  previousFk: foreignKey({ columns: [table.companyId, table.previousVerifiedVersionId], foreignColumns: [evaluatorVersions.companyId, evaluatorVersions.id] }),
  adoptionFk: foreignKey({ columns: [table.companyId, table.adoptionEvidenceRefId], foreignColumns: [qualityEvidenceRefs.companyId, qualityEvidenceRefs.id] }),
  withdrawalFk: foreignKey({ columns: [table.companyId, table.withdrawalEvidenceRefId], foreignColumns: [qualityEvidenceRefs.companyId, qualityEvidenceRefs.id] }),
  hashCheck: check("quality_consumer_bindings_hash_check", sql`${table.baseHash} ~ '^[0-9a-f]{64}$'`),
  revisionCheck: check("quality_consumer_bindings_revision_check", sql`${table.revision} >= 1`),
}));
